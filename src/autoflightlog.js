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
//      fleet/hubs/24h window/already-logged filters, stashes the
//      resulting candidate flights in KV under a short-lived batchId,
//      and returns the client-safe flight list + a skip reason for
//      every row that didn't qualify.
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
import { extractFlightRowsFromImage, arrayBufferToBase64, scanForEditorSignature } from './imageocr.js';

// An authenticity verdict only blocks the image when the vision model
// is at least "medium" confident — "low" confidence is the model
// hedging on a normal screenshot (compression noise, a cropped edge,
// an unusual device font-rendering pass) and shouldn't cost a pilot a
// legitimate flight. Tighten this to only 'high' if false positives
// turn out to be more disruptive than missed fakes in practice.
const AUTHENTICITY_BLOCK_CONFIDENCE = new Set(['medium', 'high']);

const WINDOW_MS = 24 * 60 * 60 * 1000; // "within 24 hours" window
const NM_TO_KM = 1.852;
// How close a manual-log entry's timestamp has to be to a detected
// flight's flown-time to count as "the same flight already logged by
// hand" — wide enough to cover a pilot logging a bit late (or
// pre-logging right before taking off), narrow enough not to match an
// unrelated same-route flight from a different day.
const MANUAL_LOG_MATCH_WINDOW_MS = 60 * 60 * 1000;

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
  // independent, so one bad/unreadable/fake screenshot doesn't fail the
  // whole batch — it's just skipped with a clear reason and the rest
  // still get processed.
  const rawEntries = [];
  const imageErrors = [];

  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();

      // Cheap forensic pre-check, run before we spend an API call on
      // this image: does the file's own metadata show it was saved by
      // a graphics editor rather than a screen-capture tool? This is
      // independent of the vision model and independent of layout/crop
      // (see scanForEditorSignature in imageocr.js).
      const editorSignature = scanForEditorSignature(buffer);
      if (editorSignature) {
        imageErrors.push({
          file: file.name || 'image',
          message: `This image's metadata shows it was saved from "${editorSignature}" — edited screenshots aren't accepted for automatic logging. Upload the original, unedited screenshot (or use the manual logger).`,
        });
        continue;
      }

      const base64 = arrayBufferToBase64(buffer);
      const { rows, authenticity } = await extractFlightRowsFromImage(env, base64, file.type);

      // Second check: ask the same vision pass that read the rows
      // whether the FDR panel itself looks internally consistent. This
      // one's scoped to the panel's own rendering, never to where it
      // sits on screen, so it holds up across devices/crops.
      if (authenticity?.looksAltered && AUTHENTICITY_BLOCK_CONFIDENCE.has(authenticity.confidence)) {
        const reason = authenticity.evidence?.[0] || 'the panel looks digitally altered';
        console.warn('Flagged possibly-altered FDR screenshot from', session.discordUsername, '-', authenticity);
        imageErrors.push({
          file: file.name || 'image',
          message: `This screenshot wasn't processed because ${reason}. If this is a mistake, contact an admin to log it manually.`,
        });
        continue;
      }

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
      departure: flight.departureName,
      destination: flight.arrivalName,
      aircraft: flight.fleetAircraft,
      time: flight.timeMinutes,
      distance: flight.distanceValue,
      unit: flight.unit,
    });

    if (submitResult.ok) {
      await markUsageIdLogged(env, usageId, session);
      logged.push({ usageId, aircraft: flight.fleetAircraft, departure: flight.departureName, arrival: flight.arrivalName });
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
  const [opsData, settings, loggedFlights] = await Promise.all([
    fetchOperationsData(env),
    getStoredSettings(env, session.discordUsername),
    fetchLoggedFlights(env),
  ]);

  if (!opsData) {
    return { ok: false, message: 'Fleet/airport data is unavailable right now.', httpStatus: 502 };
  }

  if (!loggedFlights) {
    // Non-fatal — the manual-log cross-check below is just skipped for
    // this batch rather than blocking detection over it.
    console.error('Could not read the manual flight log sheet — skipping manual-log dedup for this batch.');
  }

  const fleetByLower = new Map(opsData.fleet.map(name => [name.trim().toLowerCase(), name]));
  const hubAirports = new Set(opsData.airports.filter(a => a.isHub).map(a => a.code));
  const knownAirports = new Set(opsData.airports.map(a => a.code));
  // Column A of the operations sheet, keyed by the ICAO code in column D
  // of that same row — lets a detected ICAO code be translated to its
  // airport name before it's shown to the pilot or submitted.
  const airportNameByCode = new Map(opsData.airports.map(a => [a.code, a.name || a.code]));
  const unit = settings.unit === 'km' ? 'km' : 'nm';

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const flights = [];
  const skipped = [];
  const seenUsageIds = new Set(); // within-batch dedup (e.g. an overlapping second screenshot)

  for (const raw of rawEntries) {
    const entry = normalizeEntry(raw);
    if (!entry) {
      skipped.push({ usageId: raw?.usageId ?? null, reason: 'Could not read that row clearly.', detail: summarizeRaw(raw) });
      continue;
    }

    if (seenUsageIds.has(entry.usageId)) {
      continue; // already captured this flight from an earlier/overlapping screenshot in this batch
    }
    seenUsageIds.add(entry.usageId);

    if (entry.crashed) {
      skipped.push({ usageId: entry.usageId, reason: 'Flight crashed.', detail: summarizeEntry(entry) });
      continue;
    }

    if (entry.timeMinutes === null) {
      skipped.push({ usageId: entry.usageId, reason: 'Could not read the flight duration.', detail: summarizeEntry(entry) });
      continue;
    }

    if (entry.timestampMs === null || entry.timestampMs < cutoff || entry.timestampMs > now) {
      skipped.push({ usageId: entry.usageId, reason: 'Outside the 24-hour detection window.', detail: summarizeEntry(entry) });
      continue;
    }

    const fleetAircraft = fleetByLower.get(entry.aircraft.trim().toLowerCase());
    if (!fleetAircraft) {
      skipped.push({ usageId: entry.usageId, reason: `"${entry.aircraft}" isn't in the registered fleet.`, detail: summarizeEntry(entry) });
      continue;
    }

    if (!entry.departure || !entry.arrival || entry.departure === entry.arrival) {
      skipped.push({ usageId: entry.usageId, reason: 'Missing or identical departure/arrival.', detail: summarizeEntry(entry) });
      continue;
    }

    if (knownAirports.size > 0 && (!knownAirports.has(entry.departure) || !knownAirports.has(entry.arrival))) {
      const unrecognized = [entry.departure, entry.arrival].filter(code => !knownAirports.has(code));
      skipped.push({
        usageId: entry.usageId,
        reason: `Departure/arrival airport not recognized: ${unrecognized.join(', ')} (read as ${entry.departure} \u2192 ${entry.arrival}) not in the registered airport list.`,
        detail: summarizeEntry(entry),
      });
      continue;
    }

    if (hubAirports.size > 0 && !hubAirports.has(entry.departure) && !hubAirports.has(entry.arrival)) {
      skipped.push({
        usageId: entry.usageId,
        reason: `Neither airport is a hub (read as ${entry.departure} \u2192 ${entry.arrival}).`,
        detail: summarizeEntry(entry),
      });
      continue;
    }

    if (await isUsageIdLogged(env, entry.usageId)) {
      skipped.push({ usageId: entry.usageId, reason: 'Already logged.', detail: summarizeEntry(entry) });
      continue;
    }

    const departureName = airportNameByCode.get(entry.departure) || entry.departure;
    const arrivalName = airportNameByCode.get(entry.arrival) || entry.arrival;

    // Cross-check against the manual flight log sheet (gid 560263512):
    // if this same pilot already logged a flight by hand with the same
    // aircraft/departure/destination close in time to when this one was
    // flown, treat it as already logged rather than double-counting it.
    if (loggedFlights && matchesManualLog(loggedFlights, {
      discordUsername: session.discordUsername,
      aircraft: fleetAircraft,
      departureName,
      arrivalName,
      flownAtMs: entry.timestampMs,
    })) {
      skipped.push({
        usageId: entry.usageId,
        reason: `Already logged manually (matches ${departureName} \u2192 ${arrivalName} in the flight log).`,
        detail: summarizeEntry(entry),
      });
      continue;
    }

    const distanceValue = unit === 'km'
      ? Math.round(entry.distanceNm * NM_TO_KM * 10) / 10
      : Math.round(entry.distanceNm * 10) / 10;

    flights.push({
      usageId: entry.usageId,
      fleetAircraft,
      departure: entry.departure,
      arrival: entry.arrival,
      // Translated airport names for the same ICAO codes above — used
      // for the pilot-facing review list and for what actually gets
      // submitted, while `departure`/`arrival` (the codes) stay around
      // for matching/dedup.
      departureName,
      arrivalName,
      distanceValue,
      unit,
      timeMinutes: entry.timeMinutes,
      timestampUtc: new Date(entry.timestampMs).toISOString(),
    });
  }

  return { ok: true, flights, skipped };
}

// Checks whether a detected flight was already logged by hand through
// the manual Flight Logger form, by looking for a row in the manual
// flight log sheet (gid 560263512 — see fetchLoggedFlights in
// src/index.js) from the same pilot, with the same aircraft and the
// same departure/destination airport names, logged within
// MANUAL_LOG_MATCH_WINDOW_MS of when this flight was actually flown.
// Airport names (not ICAO codes) are compared since that's what the
// manual logger submits — see the ICAO-to-name translation in
// dashboard.html and detectFlights() above.
function matchesManualLog(loggedFlights, { discordUsername, aircraft, departureName, arrivalName, flownAtMs }) {
  const targetDiscord = (discordUsername || '').toLowerCase();
  const targetAircraft = (aircraft || '').trim().toLowerCase();
  const targetDeparture = (departureName || '').trim().toLowerCase();
  const targetArrival = (arrivalName || '').trim().toLowerCase();

  return loggedFlights.some(logged => {
    if (logged.discordUsername !== targetDiscord) return false;
    if (logged.aircraft.trim().toLowerCase() !== targetAircraft) return false;
    if (logged.departure.trim().toLowerCase() !== targetDeparture) return false;
    if (logged.destination.trim().toLowerCase() !== targetArrival) return false;

    // Everything else matches — if either timestamp is unreadable,
    // don't let a missing/bad date sneak a duplicate through; treat it
    // as close enough rather than as a non-match.
    if (logged.timestampMs === null || flownAtMs === null) return true;

    return Math.abs(logged.timestampMs - flownAtMs) <= MANUAL_LOG_MATCH_WINDOW_MS;
  });
}

// Small client-safe snapshots of what was actually read off the
// screenshot for a skipped row, so the UI/pilot can see the raw OCR
// output behind a skip reason instead of just the reason label. Used
// for both a fully-normalized entry and a raw row that failed to
// normalize at all (so even "Could not read that row clearly." carries
// whatever fields the vision model *did* return).
function summarizeEntry(entry) {
  return {
    aircraft: entry.aircraft,
    departure: entry.departure,
    arrival: entry.arrival,
    crashed: entry.crashed,
    distanceNm: entry.distanceNm,
    timeMinutes: entry.timeMinutes,
    timestampUtc: entry.timestampMs !== null ? new Date(entry.timestampMs).toISOString() : null,
  };
}

function summarizeRaw(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    aircraft: raw.aircraft ?? raw.plane ?? raw.aircraftType ?? null,
    departure: raw.departure ?? raw.dep ?? raw.origin ?? null,
    arrival: raw.arrival ?? raw.dest ?? raw.destination ?? null,
    distanceNm: raw.distance ?? raw.distanceNm ?? raw.distance_nm ?? null,
    duration: raw.duration ?? raw.time ?? raw.flightTime ?? null,
    date: raw.date ?? null,
    time: raw.time ?? null,
  };
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
// Usage-id dedup and detection batches — both live in their own
// AUTO_LOG_KV namespace (see wrangler.toml), separate from the
// per-pilot SETTINGS_KV used by settingssave.js, under separate key
// prefixes within that namespace.
// ---------------------------------------------------------------------

function usageKey(usageId) {
  return `usageid:${usageId}`;
}

function batchKey(discordUsername, batchId) {
  return `autobatch:${discordUsername.toLowerCase()}:${batchId}`;
}

async function isUsageIdLogged(env, usageId) {
  if (!env.AUTO_LOG_KV) return false;
  try {
    const existing = await env.AUTO_LOG_KV.get(usageKey(usageId));
    return existing !== null;
  } catch (err) {
    console.error('Failed to read usage id from KV:', err);
    // Fail closed: if we can't tell whether it's logged, don't risk a
    // duplicate paycheck — treat it as already logged and skip it.
    return true;
  }
}

async function markUsageIdLogged(env, usageId, session) {
  if (!env.AUTO_LOG_KV) {
    console.error('AUTO_LOG_KV is not bound — cannot persist usage id dedup record');
    return;
  }
  try {
    await env.AUTO_LOG_KV.put(usageKey(usageId), JSON.stringify({
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
  if (!env.AUTO_LOG_KV) {
    console.error('AUTO_LOG_KV is not bound — cannot persist detection batch');
    return;
  }
  try {
    await env.AUTO_LOG_KV.put(batchKey(discordUsername, batchId), JSON.stringify(flights), {
      expirationTtl: BATCH_TTL_SECONDS,
    });
  } catch (err) {
    console.error('Failed to write detection batch to KV:', err);
  }
}

async function loadBatch(env, discordUsername, batchId) {
  if (!env.AUTO_LOG_KV) return null;
  try {
    const stored = await env.AUTO_LOG_KV.get(batchKey(discordUsername, batchId));
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
    // Airport names (translated from the read ICAO codes), not the raw
    // codes, since this is what the pilot sees in the review list.
    departure: flight.departureName,
    arrival: flight.arrivalName,
    distance: flight.distanceValue,
    unit: flight.unit,
    timeMinutes: flight.timeMinutes,
    timestampUtc: flight.timestampUtc,
  };
}
