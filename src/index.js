import { handleFlightSubmit } from './flightsubmit.js';
import { handleClaimSubmit } from './claimsubmit.js';
import { handleGetSettings, handleSaveSettings } from './settingssave.js';
import { handleAutoFlightDetect, handleAutoFlightConfirm } from './autoflightlog.js';
import headerHtml from './header.html';
import footerHtml from './footer.html';
import metaTags from './meta.html';
import homeContent from './home.html';
import programsContent from './programs.html';
import fleetContent from './fleet.html';
import hubsContent from './hubs.html';
import dashboardContent from './dashboard.html';

// Each page here is a complete, self-contained HTML document (it has its
// own <!DOCTYPE>, <head>, and <body>, and fetches header.html/footer.html
// client-side to fill in the shared nav and footer). The worker's job is
// to serve the right file for the right path, plus handle the Discord
// OAuth + session routes below.
const pageRoutes = {
  '/': homeContent,
  '/index.html': homeContent,
  '/home.html': homeContent,

  '/programs': programsContent,
  '/programs.html': programsContent,

  '/fleet': fleetContent,
  '/fleet.html': fleetContent,

  '/hubs': hubsContent,
  '/hubs.html': hubsContent,

  // The pilot dashboard is a normal, publicly-fetchable page — it gates
  // itself client-side (blurred content + a sign-in popup) by checking
  // /api/me, rather than the server refusing to serve it. Nothing secret
  // lives in the HTML itself. The tab sub-paths all serve the exact same
  // document; the dashboard's own client-side JS reads the URL on load
  // to decide which tab to show, and updates the URL (without reloading)
  // whenever the pilot switches tabs.
  '/dashboard': dashboardContent,
  '/dashboard.html': dashboardContent,
  '/dashboard/flight-logger': dashboardContent,
  '/dashboard/settings': dashboardContent,

  '/header.html': headerHtml,
  '/footer.html': footerHtml,
};

export const SESSION_COOKIE = 'session';
const STATE_COOKIE = 'oauth_state';
const NEXT_COOKIE = 'oauth_next';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

// Only allow redirecting back to a same-site path after login (e.g.
// "/dashboard"), never to an absolute or protocol-relative URL — that
// would turn the login flow into an open redirect.
function isSafeNextPath(next) {
  return typeof next === 'string' && /^\/(?!\/)/.test(next) && !next.includes('://');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/auth-client.js') {
        return new Response(AUTH_CLIENT_JS, {
          headers: {
            'Content-Type': 'application/javascript;charset=UTF-8',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }

      if (pathname === '/auth/discord') {
        return handleDiscordRedirect(request, env);
      }

      if (pathname === '/auth/discord/callback') {
        return handleDiscordCallback(request, env, url);
      }

      if (pathname === '/auth/logout') {
        return handleLogout(url);
      }

      if (pathname === '/api/me') {
        return handleMe(request, env);
      }

      if (pathname === '/api/operations') {
        return handleOperations(env);
      }

      // Flight log submissions get their own file (flightsubmit.js) rather
      // than living here — see that file for what it actually does.
      if (pathname === '/api/flight/submit') {
        return handleFlightSubmit(request, env);
      }

      // Claim submissions get their own file (claimsubmit.js) — see that
      // file for what it actually does.
      if (pathname === '/api/claim/submit') {
        return handleClaimSubmit(request, env);
      }

      // Automatic flight logging (reads FDR data from uploaded
      // screenshots, matches it against the fleet, and lets the pilot
      // confirm/log everything in one go) gets its own file — see
      // src/autoflightlog.js. Both routes are POST: /detect takes
      // multipart/form-data image uploads, /confirm takes JSON.
      if (pathname === '/api/flight/auto/detect') {
        return handleAutoFlightDetect(request, env);
      }

      if (pathname === '/api/flight/auto/confirm') {
        return handleAutoFlightConfirm(request, env);
      }

      // Dashboard settings (unit, swap-after-log, theme) get their own
      // file (settingssave.js) — GET reads the pilot's saved settings
      // from KV, POST writes them.
      if (pathname === '/api/settings') {
        if (request.method === 'GET') return handleGetSettings(request, env);
        if (request.method === 'POST') return handleSaveSettings(request, env);
        return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
      }

      if (pathname in pageRoutes) {
        const isFragment = pathname === '/header.html' || pathname === '/footer.html';
        // Drop the shared Discord/Open Graph preview tags into every real
        // page's <head> (not the header/footer fragments, which aren't
        // full documents). Edit src/meta.html to change what shows up.
        const body = isFragment
          ? pageRoutes[pathname]
          : pageRoutes[pathname].replace('<head>', `<head>\n${metaTags}`);
        return new Response(body, {
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            // header.html/footer.html rarely change, so cache them longer.
            // Full pages get a shorter cache so edits still show up quickly.
            'Cache-Control': isFragment
              ? 'public, max-age=3600'
              : 'public, max-age=300',
          },
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

// ---------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------

async function handleDiscordRedirect(request, env) {
  const requestUrl = new URL(request.url);
  const redirectUri = new URL('/auth/discord/callback', request.url).toString();
  const state = crypto.randomUUID();
  const next = requestUrl.searchParams.get('next');

  const authorizeUrl = new URL('https://discord.com/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'identify');
  authorizeUrl.searchParams.set('state', state);

  const headers = new Headers({ Location: authorizeUrl.toString() });
  headers.append(
    'Set-Cookie',
    serializeCookie(STATE_COOKIE, state, { maxAge: 300 })
  );
  if (isSafeNextPath(next)) {
    headers.append(
      'Set-Cookie',
      serializeCookie(NEXT_COOKIE, next, { maxAge: 300 })
    );
  }

  return new Response(null, { status: 302, headers });
}

async function handleDiscordCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const expectedState = cookies[STATE_COOKIE];

  const clearState = serializeCookie(STATE_COOKIE, '', { maxAge: 0 });

  if (!code || !state || !expectedState || state !== expectedState) {
    return redirectWithError(url, 'oauth_failed', clearState);
  }

  const redirectUri = new URL('/auth/discord/callback', request.url).toString();

  // Exchange the code for an access token
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    return redirectWithError(url, 'oauth_failed', clearState);
  }

  const tokenData = await tokenRes.json();

  // Fetch the Discord user's profile
  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  if (!userRes.ok) {
    return redirectWithError(url, 'oauth_failed', clearState);
  }

  const discordUser = await userRes.json();
  const discordUsername = (discordUser.username || '').trim();

  // Look up the Discord username in the Google Sheet (column C), pull the
  // matching Roblox username (column B) from the same row
  const rosterRow = await lookupRosterRow(env, discordUsername);

  if (!rosterRow) {
    return redirectWithError(url, 'not_registered', clearState);
  }

  const robloxUsername = rosterRow.robloxUsername;

  const robloxAvatarUrl = await lookupRobloxAvatar(robloxUsername);

  const sessionValue = await createSessionCookie(env, {
    discordUsername,
    robloxUsername,
    robloxAvatarUrl,
  });

  const nextPath = cookies[NEXT_COOKIE];
  const destination = isSafeNextPath(nextPath) ? nextPath : '/';

  const headers = new Headers({ Location: destination });
  headers.append('Set-Cookie', clearState);
  headers.append('Set-Cookie', serializeCookie(NEXT_COOKIE, '', { maxAge: 0 }));
  headers.append(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, sessionValue, { maxAge: SESSION_MAX_AGE })
  );

  return new Response(null, { status: 302, headers });
}

function handleLogout(url) {
  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}



async function handleMe(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const raw = cookies[SESSION_COOKIE];

  if (!raw) {
    return jsonResponse({ error: 'not_authenticated' }, 401);
  }

  const session = await verifySessionCookie(env, raw);

  if (!session) {
    return jsonResponse({ error: 'not_authenticated' }, 401);
  }

  // Pull the pilot's current rank / payment owed / logged time straight
  // from the roster sheet on every /api/me call, rather than baking a
  // stale snapshot into the signed session cookie at login time — this
  // way the dashboard always reflects the sheet's current values.
  const rosterRow = await lookupRosterRow(env, session.discordUsername);

  return jsonResponse({
    ...session,
    rank: rosterRow?.rank ?? null,
    paymentOwed: rosterRow?.paymentOwed ?? null,
    loggedTime: rosterRow?.loggedTime ?? null,
    claimedRewards: rosterRow?.claimedRewards ?? [],
  }, 200);
}

// Serves the airport/hub list, fleet list, and paycheck status pulled
// from the operations sheet (a separate tab from the pilot roster).
// Public — same as the previously-hardcoded airport/aircraft lists it
// replaces, and the dashboard itself is already gated by /api/me.
async function handleOperations(env) {
  const data = await fetchOperationsData(env);

  if (!data) {
    return jsonResponse({ error: 'unavailable' }, 502);
  }

  return jsonResponse(data, 200);
}

function redirectWithError(url, code, extraCookie) {
  const dest = new URL('/', url);
  dest.searchParams.set('auth_error', code);
  const headers = new Headers({ Location: dest.toString() });
  if (extraCookie) headers.append('Set-Cookie', extraCookie);
  return new Response(null, { status: 302, headers });
}

export function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------
// Google Sheet lookup
// ---------------------------------------------------------------------

// Looks up a pilot's roster row by matching their Discord username against
// column C, and returns the columns the dashboard needs from that same
// row: rank (A), Roblox username (B), payment owed (D), logged time (E),
// plus reward-claimed status (G/H/I). The G/H/I columns are written by
// the roster spreadsheet's onFormSubmit Apps Script trigger, which sets
// the cell to "claimed" the first time each reward is claimed and treats
// any non-empty cell as already-claimed — matched here the same way.
async function lookupRosterRow(env, discordUsername) {
  const sheetId = env.SHEET_ID;
  const gid = env.SHEET_GID || '0';
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;

  const res = await fetch(csvUrl);
  if (!res.ok) return null;

  const csvText = await res.text();
  const rows = parseCsv(csvText);

  const target = discordUsername.toLowerCase();

  for (const row of rows) {
    const discordCell = (row[2] || '').trim().toLowerCase(); // Column C
    if (discordCell && discordCell === target) {
      const robloxUsername = (row[1] || '').trim(); // Column B
      if (!robloxUsername) return null;

      const claimedRewards = [];
      if ((row[6] || '').trim() !== '') claimedRewards.push('captain');       // Column G
      if ((row[7] || '').trim() !== '') claimedRewards.push('firstOfficer');  // Column H
      if ((row[8] || '').trim() !== '') claimedRewards.push('secondOfficer'); // Column I

      return {
        robloxUsername,
        rank: (row[0] || '').trim() || null,        // Column A
        paymentOwed: (row[3] || '').trim() || null,  // Column D
        loggedTime: (row[4] || '').trim() || null,   // Column E
        claimedRewards,                              // Columns G, H, I
      };
    }
  }

  return null;
}

// Reads the operations sheet — a different tab (GID) in the same
// spreadsheet as the roster — and returns the airport/hub list, the
// fleet list, and the site-wide paycheck status flag.
//
// Column layout per row:
//   A: location/airport name (looked up by ICAO code for display and
//      for translating a selected/detected ICAO into its airport name
//      before it's shown to a pilot or submitted to the roster sheet)
//   B: "hub" marks that airport as a hub
//   C: fleet/aircraft entry
//   D: airport code (ICAO code used for departure/arrival matching)
//   E: paycheck status ("yes" = enabled)
//
// Paycheck status is treated as a single site-wide switch rather than
// a per-row value: if ANY row has "yes" in column E, payroll is
// considered open and the Claim Reward button is enabled.
export async function fetchOperationsData(env) {
  const sheetId = env.SHEET_ID;
  const gid = env.OPERATIONS_SHEET_GID;
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;

  const res = await fetch(csvUrl);
  if (!res.ok) return null;

  const csvText = await res.text();
  const rows = parseCsv(csvText);

  const airports = [];
  const fleetSeen = new Set();
  const fleet = [];
  let paycheckEnabled = false;

  for (const row of rows) {
    const hubFlag = (row[1] || '').trim().toLowerCase();      // Column B
    const fleetEntry = (row[2] || '').trim();                 // Column C
    const airportCode = (row[3] || '').trim().toUpperCase();  // Column D
    const paycheckCell = (row[4] || '').trim().toLowerCase(); // Column E

    if (airportCode) {
      const airportName = (row[0] || '').trim(); // Column A — display/translated name for this ICAO code
      airports.push({ code: airportCode, name: airportName || airportCode, isHub: hubFlag === 'hub' });
    }

    if (fleetEntry && !fleetSeen.has(fleetEntry)) {
      fleetSeen.add(fleetEntry);
      fleet.push(fleetEntry);
    }

    if (paycheckCell === 'yes') {
      paycheckEnabled = true;
    }
  }

  return { airports, fleet, paycheckEnabled };
}

// Reads the manually-submitted flight log sheet — the tab every
// completed flight lands in (both the manual Flight Logger form and
// the automatic screenshot-based logger write here via the same
// Wispbyte /flight-log endpoint). Used by the automatic logger to spot
// a flight that a pilot already logged by hand before it ever gets to
// a screenshot, so it isn't logged a second time — see
// matchesManualLog() in src/autoflightlog.js.
//
// Column layout per row:
//   A: Timestamp (when the flight was logged/submitted)
//   B: Discord Username
//   C: Roblox Username
//   D: Aircraft Flown
//   E: Time Flown
//   F: Distance Flown
//   G: Departure (airport name — see fetchOperationsData's column A)
//   H: Destination (airport name)
//   I: Unit of Measurement
//
// Returns null (rather than throwing) on any fetch/parse failure, so a
// hiccup reading this sheet degrades to "skip the manual-log check"
// instead of blocking detection entirely.
export async function fetchLoggedFlights(env) {
  const sheetId = env.SHEET_ID;
  const gid = env.LOG_SHEET_GID;
  if (!sheetId || !gid) return null;

  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;

  let res;
  try {
    res = await fetch(csvUrl);
  } catch (err) {
    console.error('Failed to fetch manual flight log sheet:', err);
    return null;
  }
  if (!res.ok) return null;

  const csvText = await res.text();
  const rows = parseCsv(csvText);

  const flights = [];
  for (const row of rows) {
    const timestampRaw = (row[0] || '').trim();      // Column A
    const discordUsername = (row[1] || '').trim();   // Column B
    const aircraft = (row[3] || '').trim();          // Column D
    const timeMinutesRaw = (row[4] || '').trim();    // Column E
    const distanceRaw = (row[5] || '').trim();       // Column F
    const departure = (row[6] || '').trim();         // Column G
    const destination = (row[7] || '').trim();       // Column H
    const unit = (row[8] || '').trim().toLowerCase(); // Column I

    // Rows missing the fields we actually match on (a header row,
    // a blank trailing row, etc) are just skipped rather than pushed
    // as a bogus "logged flight" that could never match anything real.
    if (!discordUsername || !aircraft || !departure || !destination) continue;

    const parsedTimestamp = Date.parse(timestampRaw);
    const timeMinutes = parseFloat(timeMinutesRaw.replace(/[^0-9.-]/g, ''));
    const distance = parseFloat(distanceRaw.replace(/[^0-9.-]/g, ''));

    flights.push({
      timestampMs: Number.isNaN(parsedTimestamp) ? null : parsedTimestamp,
      discordUsername: discordUsername.toLowerCase(),
      aircraft,
      timeMinutes: Number.isNaN(timeMinutes) ? null : timeMinutes,
      distance: Number.isNaN(distance) ? null : distance,
      departure,
      destination,
      unit,
    });
  }

  return flights;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // skip
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------
// Roblox lookups
// ---------------------------------------------------------------------

async function lookupRobloxAvatar(robloxUsername) {
  try {
    const idRes = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [robloxUsername], excludeBannedUsers: true }),
    });

    if (!idRes.ok) return null;

    const idData = await idRes.json();
    const userId = idData?.data?.[0]?.id;
    if (!userId) return null;

    const avatarRes = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=true`
    );

    if (!avatarRes.ok) return null;

    const avatarData = await avatarRes.json();
    return avatarData?.data?.[0]?.imageUrl || null;
  } catch (err) {
    console.error('Roblox lookup failed', err);
    return null;
  }
}

// ---------------------------------------------------------------------
// Cookies + signed sessions
// ---------------------------------------------------------------------

function serializeCookie(name, value, { maxAge } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

export function parseCookies(cookieHeader) {
  const out = {};
  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}

async function createSessionCookie(env, payloadObj) {
  const payloadB64 = base64UrlEncode(JSON.stringify(payloadObj));
  const signature = await hmacSign(env.SESSION_SECRET, payloadB64);
  return `${payloadB64}.${signature}`;
}

export async function verifySessionCookie(env, cookieValue) {
  const dotIndex = cookieValue.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const payloadB64 = cookieValue.slice(0, dotIndex);
  const signature = cookieValue.slice(dotIndex + 1);

  const expectedSignature = await hmacSign(env.SESSION_SECRET, payloadB64);
  if (!timingSafeEqual(expectedSignature, signature)) return null;

  try {
    return JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return null;
  }
}

async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return arrayBufferToBase64Url(signature);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function arrayBufferToBase64Url(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return base64ToBase64Url(btoa(binary));
}

function base64UrlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64ToBase64Url(base64);
}

function base64UrlDecode(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + ((4 - (str.length % 4)) % 4), '=');
  return decodeURIComponent(escape(atob(base64)));
}

function base64ToBase64Url(base64) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------
// Client-side script served at /auth-client.js
// ---------------------------------------------------------------------

const AUTH_CLIENT_JS = `(function () {
  function qs(id) { return document.getElementById(id); }

  function showLoggedOut() {
    var btn = qs('auth-btn');
    var badge = qs('user-badge');
    if (btn) {
      btn.textContent = 'Get Started';
      btn.href = '/auth/discord';
    }
    if (badge) badge.style.display = 'none';
  }

  function showLoggedIn(user) {
    var btn = qs('auth-btn');
    var badge = qs('user-badge');
    var avatar = qs('user-avatar');
    var name = qs('user-name');

    if (avatar) {
      avatar.src = user.robloxAvatarUrl || '';
      avatar.alt = user.robloxUsername || '';
    }
    if (name) name.textContent = user.robloxUsername || '';
    if (badge) badge.style.display = 'flex';

    if (btn) {
      btn.textContent = 'Log out';
      btn.href = '/auth/logout';
    }
  }

  function init() {
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('not authenticated');
        return res.json();
      })
      .then(showLoggedIn)
      .catch(showLoggedOut);

    var params = new URLSearchParams(window.location.search);
    var authError = params.get('auth_error');
    if (authError) {
      var messages = {
        not_registered: "That Discord account isn't on our roster yet \u2014 reach out to staff to get added.",
        oauth_failed: 'Discord sign-in failed. Please try again.'
      };
      window.alert(messages[authError] || 'Sign-in failed. Please try again.');
      params.delete('auth_error');
      var newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
      window.history.replaceState({}, '', newUrl);
    }
  }

  window.AirlineAuth = { init: init };
})();
`;
