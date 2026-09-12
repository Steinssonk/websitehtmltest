// Handles POST /api/flight/auto/detect and POST /api/flight/auto/confirm —
// the "Automatic" flight logging mode selectable from the dashboard's
// Settings tab (as opposed to the existing manual Flight Logger form).
//
// The idea: the in-game server keeps an FDR (Flight Data Recorder) log
// of every flight (see the in-game "Server Info" panel — aircraft type,
// departure/arrival, distance, duration, and a per-flight "Usage" id).
// Rather than making the pilot type all of that into the manual form,
// the pilot uploads one or more screenshots of that panel; we read the
// image with a vision model (see src/imageocr.js), match each row
// against the airline's registered fleet, and let the pilot review +
// confirm a batch of detected flights in one click. Confirmed flights
// are then forwarded through the exact same Wispbyte /flight-log
// endpoint the manual logger already uses (see submitFlightToWispbyte
// in flightsubmit.js), so both logging modes end up writing to the
// roster sheet in exactly the same way.
//
// ---------------------------------------------------------------------
// Flow:
//
//   1. POST /api/flight/auto/detect  (multipart/form-data, one or more
//      "images" files) — reads each image, matches rows against the
//      fleet/hubs/24h window/already-logged filters (including a
//      best-effort check against the manual Flight Logger's own sheet,
//      since a pilot could have typed the same flight in by hand
//      before ever uploading a screenshot of it — see
//      matchesManualLog() below), stashes the resulting candidate
//      flights in KV under a short-lived batchId, and returns the
//      client-safe flight list + a skip reason for every row that
//      didn't qualify.
//
//   2. POST /api/flight/auto/confirm  { batchId, usageIds: [...] } —
//      re-reads the candidate flights from that same KV batch (never
//      trusting flight details sent back by the client — only which
//      usage ids to confirm), re-checks the usage-id dedup right
//      before writing, and submits each selected flight to Wispbyte.
//
// Splitting detect/confirm this way means the pilot can upload several
// screenshots covering many flights and log them all in one batch,
// while the backend still only ever sends flights to Wispbyte one at a
// time, and a flight can never get logged twice even if the pilot
// re-uploads the same screenshot later.
// ---------------------------------------------------------------------

import { parseCookies, verifySessionCookie, jsonResponse, SESSION_COOKIE, fetchOperationsData, fetchLoggedFlights } from './index.js';
import { submitFlightToWispbyte } from './flightsubmit.js';
import { getStoredSettings } from './settingssave.js';
import { extractFlightRowsFromImage, arrayBufferToBase64 } from './imageocr.js';

const WINDOW_MS = 24 * 60 * 60 * 1000; // "within 24 hours" window
const NM_TO_KM = 1.852;

// How loosely a manually-logged row is allowed to match a screenshot-
// detected flight before it's treated as "the same flight, logged
// twice". The manual form only accepts whole numbers, so a flight's
// true distance/time always gets rounded when it's typed in by hand —
// these tolerances just need to absorb that rounding (plus a little
// slack for unit-conversion rounding), not open the door to matching
// genuinely different flights.
const MANUAL_LOG_DISTANCE_TOLERANCE = 2;   // in whatever unit the manual row used
const MANUAL_LOG_TIME_TOLERANCE_MIN = 3;   // minutes
const MANUAL_LOG_TIME_WINDOW_MS = WINDOW_MS; // how close the manual entry's timestamp has to be

const MAX_IMAGES_PER_REQUEST = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB/image — plenty for a screenshot, keeps requests fast
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const BATCH_TTL_SECONDS = 15 * 60; // candidate flights only need to live long enough to confirm

async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifySessionCookie(env, raw);
}

// ---------------------------------------------------------------------
// POST /api/flight/auto/detect
// Body: multipart/form-data, one or more files under the "images" field
// ---------------------------------------------------------------------
export async function handleAutoFlightDetect(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
  }

  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ status: 'error', message: 'Not authenticated' }, 401);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return jsonResponse({ status: 'error', message: 'Expected multipart/form-data with one or more images.' }, 400);
  }

  const files = formData.getAll('images').filter(f => f && typeof f.arrayBuffer === 'function');
  if (files.length === 0) {
    return jsonResponse({ status: 'error', message: 'Upload at least one FDR screenshot.' }, 400);
  }
  if (files.length > MAX_IMAGES_PER_REQUEST) {
    return jsonResponse({ status: 'error', message: `Upload at most ${MAX_IMAGES_PER_REQUEST} screenshots at a time.` }, 400);
  }

  for (const file of files) {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return jsonResponse({ status: 'error', message: `Unsupported image type: ${file.type || 'unknown'}. Use PNG, JPEG, or WEBP.` }, 400);
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return jsonResponse({ status: 'error', message: `"${file.name || 'image'}" is too large (max ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MB).` }, 400);
    }
  }

  // Read every screenshot with the vision model. Each image is
  // independent, so one bad/unreadable screenshot doesn't fail the
  // whole batch — its rows are just skipped with a clear reason.
  const rawEntries = [];
  const imageErrors = [];

  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const rows = await extractFlightRowsFromImage(env, base64, file.type);
      for (const row of rows) rawEntries.push(row);
    } catch (err) {
      console.error('Image read failed for', file.name, err);
      imageErrors.push({ file: file.name || 'image', message: err.message || 'Could not read that screenshot.' });
    }
  }

  if (rawEntries.length === 0 && imageErrors.length > 0) {
    // Every single image failed to read — this is worth surfacing as a
    // hard error rather than "0 flights found", since it's very likely
    // a configuration problem (missing API key, etc) rather than an
    // empty FDR log.
    return jsonResponse({ status: 'error', message: imageErrors[0].message }, 502);
  }

  const result = await detectFlights(env, session, rawEntries);
  if (!result.ok) {
    return jsonResponse({ status: 'error', message: result.message }, result.httpStatus || 502);
  }

  const batchId = crypto.randomUUID();
  await storeBatch(env, session.discordUsername, batchId, result.flights);

  return jsonResponse({
    status: 'ok',
    batchId,
    flights: result.flights.map(toClientFlight),
    skipped: result.skipped,
    imageErrors,
  }, 200);
}

// ---------------------------------------------------------------------
// POST /api/flight/auto/confirm
// Body: { batchId: "...", usageIds: ["116515", "34556", ...] }
// ---------------------------------------------------------------------
export async function handleAutoFlightConfirm(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
  }

  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ status: 'error', message: 'Not authenticated' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid request body' }, 400);
  }

  const batchId = typeof payload.batchId === 'string' ? payload.batchId : null;
  const requestedIds = Array.isArray(payload.usageIds)
    ? payload.usageIds.map(id => String(id))
    : null;

  if (!batchId) {
    return jsonResponse({ status: 'error', message: 'Missing batchId — scan for flights again.' }, 400);
  }
  if (!requestedIds || requestedIds.length === 0) {
    return jsonResponse({ status: 'error', message: 'No flights selected to confirm.' }, 400);
  }

  // Re-derive the detected flights from the stored batch rather than
  // trusting whatever flight details the client sends back — the
  // client only gets to pick *which* usage ids to confirm, never their
  // distance/time/aircraft, so there's no way to log a bogus flight by
  // editing the confirm request. The batch was already produced by our
  // own detectFlights() pass at detect-time (fleet match, hub check,
  // crash filter, 24h window, dedup), so nothing here needs to be
  // re-validated against the image again.
  const batchFlights = await loadBatch(env, session.discordUsername, batchId);
  if (!batchFlights) {
    return jsonResponse({ status: 'error', message: 'That batch of detected flights has expired — scan for flights again.' }, 410);
  }

  const byUsageId = new Map(batchFlights.map(f => [f.usageId, f]));
  const requestedSet = new Set(requestedIds);

  const logged = [];
  const failed = [];

  for (const usageId of requestedIds) {
    const flight = byUsageId.get(usageId);
    if (!flight) {
      failed.push({ usageId, message: 'Not part of this detected batch.' });
      continue;
    }

    // Re-check KV right before writing, closing the (small) race window
    // between the detect call and this confirm call.
    const alreadyLogged = await isUsageIdLogged(env, usageId);
    if (alreadyLogged) {
      failed.push({ usageId, message: 'Already logged.' });
      continue;
    }

    const submitResult = await submitFlightToWispbyte(env, session, {
      departure: flight.departure,
      destination: flight.arrival,
      aircraft: flight.fleetAircraft,
      time: flight.timeMinutes,
      distance: flight.distanceValue,
      unit: flight.unit,
    });

    if (submitResult.ok) {
      await markUsageIdLogged(env, usageId, session);
      logged.push({ usageId, aircraft: flight.fleetAircraft, departure: flight.departure, arrival: flight.arrival });
    } else {
      failed.push({ usageId, message: submitResult.message });
    }
  }

  return jsonResponse({
    status: logged.length > 0 ? 'ok' : 'error',
    logged,
    failed,
    requestedCount: requestedSet.size,
  }, logged.length > 0 ? 200 : 502);
}

// ---------------------------------------------------------------------
// Shared detection logic — takes the raw rows read off the uploaded
// screenshot(s) and narrows them down to flights that are actually
// safe to log.
// ---------------------------------------------------------------------
async function detectFlights(env, session, rawEntries) {
  const [opsData, settings, manualLogs] = await Promise.all([
    fetchOperationsData(env),
    getStoredSettings(env, session.discordUsername),
    fetchLoggedFlights(env),
  ]);

  if (!opsData) {
    return { ok: false, message: 'Fleet/airport data is unavailable right now.', httpStatus: 502 };
  }

  // Match by both the sheet's regular airport code (column A) and its
  // ICAO code (column D) — the in-game FDR log doesn't always use the
  // same code format the sheet does, so a row is treated as known/hub
  // if either code matches what was read off the screenshot. The same
  // "airportGroups" map also lets us tell whether a departure/arrival
  // read off a screenshot is the *same airport* as one logged manually
  // under a different code format (see matchesManualLog() below).
  // "canonicalCode" goes the other way — whichever code the screenshot
  // actually used, it maps back to the sheet's own column A code, so
  // that's what ends up in the reviewed flight list and the submitted
  // flight, instead of a raw ICAO code the rest of the site doesn't
  // otherwise use.
  const hubAirports = new Set();
  const knownAirports = new Set();
  const airportGroups = new Map(); // any known code (either format, uppercased) -> shared group id
  const canonicalCode = new Map(); // any known code (either format, uppercased) -> column A code, in its original casing
  opsData.airports.forEach((airport, i) => {
    const originalCode = (airport.code || '').trim(); // keep the sheet's own casing for display/submission
    const code = originalCode.toUpperCase();
    const icao = (airport.icaoCode || '').trim().toUpperCase();
    if (code) { knownAirports.add(code); airportGroups.set(code, i); canonicalCode.set(code, originalCode); }
    if (icao) { knownAirports.add(icao); airportGroups.set(icao, i); if (code) canonicalCode.set(icao, originalCode); }
    if (airport.isHub) {
      if (code) hubAirports.add(code);
      if (icao) hubAirports.add(icao);
    }
  });
  const sameAirport = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const groupA = airportGroups.get(a);
    return groupA !== undefined && groupA === airportGroups.get(b);
  };

  const unit = settings.unit === 'km' ? 'km' : 'nm';

  // Only this pilot's manually-logged rows are relevant — matched
  // against either username, since the manual form's own two username
  // columns don't always both get filled in reliably.
  const discordLower = (session.discordUsername || '').toLowerCase();
  const robloxLower = (session.robloxUsername || '').toLowerCase();
  const pilotManualLogs = manualLogs.filter(log =>
    (log.discordUsername && log.discordUsername.toLowerCase() === discordLower) ||
    (log.robloxUsername && robloxLower && log.robloxUsername.toLowerCase() === robloxLower)
  );

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const flights = [];
  const skipped = [];
  const seenUsageIds = new Set(); // within-batch dedup (e.g. an overlapping second screenshot)

  for (const raw of rawEntries) {
    const entry = normalizeEntry(raw);
    if (!entry) {
      skipped.push({ usageId: raw?.usageId ?? null, reason: 'Could not read that row clearly.' });
      continue;
    }

    if (seenUsageIds.has(entry.usageId)) {
      continue; // already captured this flight from an earlier/overlapping screenshot in this batch
    }
    seenUsageIds.add(entry.usageId);

    if (entry.crashed) {
      skipped.push({ usageId: entry.usageId, reason: 'Flight crashed.' });
      continue;
    }

    if (entry.timeMinutes === null) {
      skipped.push({ usageId: entry.usageId, reason: 'Could not read the flight duration.' });
      continue;
    }

    if (entry.timestampMs === null || entry.timestampMs < cutoff || entry.timestampMs > now) {
      skipped.push({ usageId: entry.usageId, reason: 'Outside the 24-hour detection window.' });
      continue;
    }

    const fleetAircraft = matchFleetAircraft(entry.aircraft, opsData.fleet);
    if (!fleetAircraft) {
      skipped.push({ usageId: entry.usageId, reason: `"${entry.aircraft}" isn't in the registered fleet.` });
      continue;
    }

    if (!entry.departure || !entry.arrival || entry.departure === entry.arrival) {
      skipped.push({ usageId: entry.usageId, reason: 'Missing or identical departure/arrival.' });
      continue;
    }

    if (knownAirports.size > 0 && (!knownAirports.has(entry.departure) || !knownAirports.has(entry.arrival))) {
      skipped.push({ usageId: entry.usageId, reason: 'Departure/arrival airport not recognized.' });
      continue;
    }

    if (hubAirports.size > 0 && !hubAirports.has(entry.departure) && !hubAirports.has(entry.arrival)) {
      skipped.push({ usageId: entry.usageId, reason: 'Neither airport is a hub.' });
      continue;
    }

    if (await isUsageIdLogged(env, entry.usageId)) {
      skipped.push({ usageId: entry.usageId, reason: 'Already logged.' });
      continue;
    }

    if (matchesManualLog(entry, pilotManualLogs, sameAirport)) {
      // The website has no way to tell a manually-typed entry apart
      // from one the pilot later re-discovers in an FDR screenshot —
      // there's no shared flight id between the two logging paths. So
      // once we find a manual row that looks like the same flight,
      // treat it the same as an already-logged usage id (including
      // caching that verdict) rather than letting it get logged twice.
      await markUsageIdLogged(env, entry.usageId, session);
      skipped.push({ usageId: entry.usageId, reason: 'Already logged manually.' });
      continue;
    }

    const distanceValue = unit === 'km'
      ? Math.round(entry.distanceNm * NM_TO_KM * 10) / 10
      : Math.round(entry.distanceNm * 10) / 10;

    // Canonicalize whichever code format the screenshot actually used
    // (the sheet's own code, or its ICAO code from column D) back to
    // the sheet's own column A code/name, in its original casing —
    // that's the form pilots/staff recognize and the one used
    // everywhere else on the site, so it's what shows up in the review
    // list and what actually gets submitted, rather than a raw ICAO
    // code straight from the game. Done last (after every check that
    // needs the uppercase code form to match against the ops sheet's
    // and manual log's own uppercased sets) so it can't interfere with
    // any of the matching above.
    const displayDeparture = canonicalCode.get(entry.departure) || entry.departure;
    const displayArrival = canonicalCode.get(entry.arrival) || entry.arrival;

    flights.push({
      usageId: entry.usageId,
      fleetAircraft,
      departure: displayDeparture,
      arrival: displayArrival,
      distanceValue,
      unit,
      timeMinutes: entry.timeMinutes,
      timestampUtc: new Date(entry.timestampMs).toISOString(),
    });
  }

  return { ok: true, flights, skipped };
}

// ---------------------------------------------------------------------
// Fleet aircraft matching — deliberately lenient, since the in-game
// name for an aircraft frequently doesn't match the fleet sheet
// exactly: the game may prefix it with the manufacturer ("Airbus
// A350-900"), differ in capitalization ("747-8I" vs "747-8i"), or
// append a modification suffix the fleet sheet doesn't track ("A350-
// 900ULR" for a plane the sheet just lists as "A350-900"). Rather than
// requiring an exact (case-insensitive) string match, we strip all of
// that noise out and match on whichever side is "contained" in the
// other.
// ---------------------------------------------------------------------

// Common manufacturer names that show up as a prefix in-game but are
// never part of the fleet sheet's own naming — stripped before matching.
const MANUFACTURER_PREFIXES = [
  'mcdonnell douglas', 'mcdonnell-douglas', 'de havilland', 'de-havilland',
  'dehavilland', 'airbus', 'boeing', 'embraer', 'bombardier', 'canadair',
  'gulfstream', 'dassault', 'lockheed', 'douglas', 'convair', 'antonov',
  'ilyushin', 'tupolev', 'sukhoi', 'comac', 'fokker', 'saab', 'atr', 'bae',
];

// Lowercases, drops a leading manufacturer name if present, and strips
// every character that isn't a letter or digit — so spacing, hyphens,
// periods, and capitalization differences ("A350-900" vs "a350 900")
// never affect the comparison.
function normalizeAircraftName(name) {
  let s = String(name || '').trim().toLowerCase();

  for (const prefix of MANUFACTURER_PREFIXES) {
    if (s === prefix) continue;
    if (s.startsWith(prefix + ' ') || s.startsWith(prefix + '-')) {
      s = s.slice(prefix.length).trim();
      break;
    }
  }

  return s.replace(/[^a-z0-9]/g, '');
}

// The manual form's "Time Flown" column is always a plain whole number
// of minutes (e.g. "16") — no HH:MM:SS, no decimals. That's a different
// format from the FDR screenshot's own duration field (parsed by
// parseDurationToMinutes below, which expects hours or HH:MM:SS), so
// it gets its own tiny parser rather than overloading that one.
function parseManualLogTimeMinutes(timeCell) {
  const minutes = Number(String(timeCell ?? '').trim());
  return Number.isFinite(minutes) ? Math.round(minutes) : null;
}

// ---------------------------------------------------------------------
// Manual-log dedup — the manual Flight Logger form and the automatic
// screenshot logger both end up writing to the same roster sheet, but
// nothing ties a manually-typed entry to a "Usage" id, so a pilot could
// otherwise get paid twice for one flight: once by typing it in by
// hand, and again later after uploading an FDR screenshot that covers
// the same flight. This does a best-effort match against that pilot's
// own manually-logged rows (see fetchLoggedFlights() in src/index.js)
// on aircraft, route, rounded distance/time, and roughly when it was
// logged — good enough to catch the common case without needing an
// exact match the manual form was never designed to support.
function matchesManualLog(entry, pilotLogs, sameAirport) {
  for (const log of pilotLogs) {
    if (Math.abs(log.timestampMs - entry.timestampMs) > MANUAL_LOG_TIME_WINDOW_MS) continue;
    if (!sameAirport(entry.departure, log.departure) || !sameAirport(entry.arrival, log.arrival)) continue;

    const normEntryAircraft = normalizeAircraftName(entry.aircraft);
    const normLogAircraft = normalizeAircraftName(log.aircraft);
    const aircraftMatches = normEntryAircraft && normLogAircraft && (
      normEntryAircraft === normLogAircraft ||
      normEntryAircraft.includes(normLogAircraft) ||
      normLogAircraft.includes(normEntryAircraft)
    );
    if (!aircraftMatches) continue;

    const entryDistanceInLogUnit = log.unit === 'km' ? entry.distanceNm * NM_TO_KM : entry.distanceNm;
    if (Math.abs(entryDistanceInLogUnit - log.distance) > MANUAL_LOG_DISTANCE_TOLERANCE) continue;

    const logTimeMinutes = parseManualLogTimeMinutes(log.timeCell);
    if (logTimeMinutes === null || Math.abs(logTimeMinutes - entry.timeMinutes) > MANUAL_LOG_TIME_TOLERANCE_MIN) continue;

    return true;
  }

  return false;
}

// Finds the fleet entry that best matches a raw in-game aircraft name.
// Tries an exact normalized match first; failing that, falls back to a
// "contains" match in either direction (covers modification suffixes
// like "ULR"/"ER"/"NEO" the fleet sheet doesn't list separately). When
// several fleet entries could contain-match, the longest/most specific
// one wins, to cut down on accidental cross-matches between similarly
// named aircraft.
function matchFleetAircraft(rawName, fleet) {
  const normEntry = normalizeAircraftName(rawName);
  if (!normEntry || !Array.isArray(fleet)) return null;

  const candidates = [];
  for (const fleetName of fleet) {
    const normFleet = normalizeAircraftName(fleetName);
    if (!normFleet) continue;
    if (normFleet === normEntry) return fleetName; // exact match wins immediately
    if (normEntry.includes(normFleet) || normFleet.includes(normEntry)) {
      candidates.push({ fleetName, length: normFleet.length });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0].fleetName;
}

// Normalizes one raw FDR row (as read off a screenshot — see
// src/imageocr.js) into { usageId, aircraft, departure, arrival,
// crashed, distanceNm, timeMinutes, timestampMs } — or null if it's
// missing something essential.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const usageId = raw.usageId ?? raw.usage_id ?? raw.usage ?? null;
  const aircraft = raw.aircraft ?? raw.plane ?? raw.aircraftType ?? null;
  if (usageId === null || usageId === '' || !aircraft) return null;

  const departure = (raw.departure ?? raw.dep ?? raw.origin ?? '').toString().trim().toUpperCase() || null;
  const arrivalRaw = (raw.arrival ?? raw.dest ?? raw.destination ?? '').toString().trim().toUpperCase();
  const durationRaw = (raw.duration ?? raw.time ?? raw.flightTime ?? '').toString().trim().toUpperCase();

  // The game shows "CRASH" in place of either the duration or the
  // arrival code when a flight ends in a crash — treat either as the
  // crash signal rather than assuming which column it lands in.
  const crashed = raw.crashed === true || arrivalRaw === 'CRASH' || durationRaw === 'CRASH' || arrivalRaw === '';
  const arrival = crashed ? null : arrivalRaw;

  const distanceNm = Number(raw.distance ?? raw.distanceNm ?? raw.distance_nm);
  if (!Number.isFinite(distanceNm)) return null;

  const timeMinutes = crashed ? null : parseDurationToMinutes(raw.duration ?? raw.time ?? raw.flightTime);
  const timestampMs = parseTimestamp(raw);

  return {
    usageId: String(usageId),
    aircraft: String(aircraft),
    departure,
    arrival,
    crashed,
    distanceNm,
    timeMinutes,
    timestampMs,
  };
}

// Accepts "HH:MM:SS", "H:MM", or a plain number of hours (e.g. 0.27),
// and always returns whole minutes.
function parseDurationToMinutes(duration) {
  if (duration === undefined || duration === null || duration === '') return null;

  if (typeof duration === 'number') {
    return Math.round(duration * 60);
  }

  const str = String(duration).trim();
  const parts = str.split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;

  let hours = 0, minutes = 0, seconds = 0;
  if (parts.length === 3) [hours, minutes, seconds] = parts;
  else if (parts.length === 2) [hours, minutes] = parts;
  else return null;

  const totalMinutes = hours * 60 + minutes + seconds / 60;
  return Math.round(totalMinutes);
}

function parseTimestamp(raw) {
  if (raw.timestampUtc || raw.timestamp) {
    const parsed = Date.parse(raw.timestampUtc ?? raw.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }

  // Combine separate "date" ("08/29/2026" or "2026-08-29") and "time"
  // ("09:56") fields, both treated as UTC — this is what the
  // screenshot reader (src/imageocr.js) actually produces.
  if (raw.date) {
    const datePart = String(raw.date).trim();
    const timePart = String(raw.time || raw.utcTime || '00:00').trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(datePart)
      ? datePart
      : datePart.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, '$3-$1-$2');
    const parsed = Date.parse(`${iso}T${timePart}:00Z`);
    if (!Number.isNaN(parsed)) return parsed;
  }

  return null;
}

// ---------------------------------------------------------------------
// Usage-id dedup and detection batches — both reuse the SETTINGS_KV
// namespace (see wrangler.toml / settingssave.js) under separate key
// prefixes, so no extra KV namespace needs to be provisioned.
// ---------------------------------------------------------------------

function usageKey(usageId) {
  return `usageid:${usageId}`;
}

function batchKey(discordUsername, batchId) {
  return `autobatch:${discordUsername.toLowerCase()}:${batchId}`;
}

async function isUsageIdLogged(env, usageId) {
  if (!env.SETTINGS_KV) return false;
  try {
    const existing = await env.SETTINGS_KV.get(usageKey(usageId));
    return existing !== null;
  } catch (err) {
    console.error('Failed to read usage id from KV:', err);
    // Fail closed: if we can't tell whether it's logged, don't risk a
    // duplicate paycheck — treat it as already logged and skip it.
    return true;
  }
}

async function markUsageIdLogged(env, usageId, session) {
  if (!env.SETTINGS_KV) {
    console.error('SETTINGS_KV is not bound — cannot persist usage id dedup record');
    return;
  }
  try {
    await env.SETTINGS_KV.put(usageKey(usageId), JSON.stringify({
      discordUsername: session.discordUsername,
      robloxUsername: session.robloxUsername,
      loggedAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('Failed to write usage id to KV:', err);
  }
}

// Stashes the candidate flights produced by one detect() call so
// confirm() can act on them later without trusting the browser's copy.
// Short TTL — this is scratch space for one review-and-confirm pass,
// not a durable record (that's what the usage-id dedup keys above are
// for).
async function storeBatch(env, discordUsername, batchId, flights) {
  if (!env.SETTINGS_KV) {
    console.error('SETTINGS_KV is not bound — cannot persist detection batch');
    return;
  }
  try {
    await env.SETTINGS_KV.put(batchKey(discordUsername, batchId), JSON.stringify(flights), {
      expirationTtl: BATCH_TTL_SECONDS,
    });
  } catch (err) {
    console.error('Failed to write detection batch to KV:', err);
  }
}

async function loadBatch(env, discordUsername, batchId) {
  if (!env.SETTINGS_KV) return null;
  try {
    const stored = await env.SETTINGS_KV.get(batchKey(discordUsername, batchId));
    return stored ? JSON.parse(stored) : null;
  } catch (err) {
    console.error('Failed to read detection batch from KV:', err);
    return null;
  }
}

// Strips internal-only fields (nothing sensitive here, but keeps the
// detect response limited to what the UI actually needs) before
// sending detected flights to the browser.
function toClientFlight(flight) {
  return {
    usageId: flight.usageId,
    aircraft: flight.fleetAircraft,
    departure: flight.departure,
    arrival: flight.arrival,
    distance: flight.distanceValue,
    unit: flight.unit,
    timeMinutes: flight.timeMinutes,
    timestampUtc: flight.timestampUtc,
  };
}
