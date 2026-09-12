// Handles POST /api/flight/submit — the flight logger's "submit system".
//
// Kept in its own file rather than folded into index.js so this can grow
// (extra validation, retries, etc.) without turning index.js into a
// dumping ground.
//
// This does NOT write to the roster sheet itself — it validates the
// request, confirms who's submitting via the same signed session cookie
// the rest of the site uses, then forwards the flight entry to the
// Wispbyte-hosted flightLog.js endpoint (mirrors the old Wix
// submitFlightData() backend function). Set the base URL with:
//   wrangler secret put WISPBYTE_BASE_URL
//
// flightLog.js on Wispbyte responds with { success: true/false, status:
// <Google's HTTP status> } rather than a plain 2xx, so that's what gets
// unpacked below.

import { parseCookies, verifySessionCookie, jsonResponse, SESSION_COOKIE } from './index.js';

const REQUIRED_FIELDS = ['departure', 'destination', 'aircraft', 'time', 'distance', 'unit'];

// Forwards one flight entry to the Wispbyte-hosted flightLog.js endpoint.
// Shared by both the manual flight logger (handleFlightSubmit below) and
// the automatic screenshot-based logger (see src/autoflightlog.js) so
// both modes write to the roster sheet in exactly the same way. Returns
// { ok: true } on success, or { ok: false, message } on failure — never
// throws, so callers can just check `.ok`.
export async function submitFlightToWispbyte(env, session, flightData) {
  const baseUrl = (env.WISPBYTE_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    console.error('WISPBYTE_BASE_URL is not configured — see flightsubmit.js');
    return { ok: false, message: "Flight submission isn't configured yet." };
  }

  const targetUrl = `${baseUrl}/flight-log`;

  try {
    const forwardRes = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discord: session.discordUsername,
        roblox: session.robloxUsername,
        departure: flightData.departure,
        destination: flightData.destination,
        aircraft: flightData.aircraft,
        time: flightData.time,
        distance: flightData.distance,
        unit: flightData.unit,
      }),
    });

    if (!forwardRes.ok) {
      // Logged (not returned to the client) so you can see exactly which
      // URL 404'd/500'd via `wrangler tail` without exposing internal
      // infrastructure details to pilots submitting flights.
      console.error('Flight log request failed:', forwardRes.status, targetUrl);
      return { ok: false, message: `Flight log request failed: HTTP ${forwardRes.status}` };
    }

    let result;
    try {
      result = await forwardRes.json();
    } catch {
      console.error('Flight log response was not valid JSON');
      return { ok: false, message: 'Flight submission service returned an unexpected response.' };
    }

    // flightLog.js on Wispbyte returns { success: true/false, status: <Google's HTTP status> }
    if (result.success && result.status === 200) {
      return { ok: true };
    }

    return { ok: false, message: result.error || 'Flight submission failed' };
  } catch (err) {
    console.error('Flight submit webhook error:', err);
    return { ok: false, message: 'Could not reach the flight submission service.' };
  }
}

export async function handleFlightSubmit(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
  }

  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const session = cookies[SESSION_COOKIE]
    ? await verifySessionCookie(env, cookies[SESSION_COOKIE])
    : null;

  if (!session) {
    return jsonResponse({ status: 'error', message: 'Not authenticated' }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid request body' }, 400);
  }

  const missing = REQUIRED_FIELDS.filter(
    field => payload[field] === undefined || payload[field] === null || payload[field] === ''
  );
  if (missing.length > 0) {
    return jsonResponse({ status: 'error', message: `Missing field(s): ${missing.join(', ')}` }, 400);
  }

  if (payload.departure === payload.destination) {
    return jsonResponse({ status: 'error', message: "Departure and destination can't be the same airport." }, 400);
  }

  const result = await submitFlightToWispbyte(env, session, {
    departure: payload.departure,
    destination: payload.destination,
    aircraft: payload.aircraft,
    time: payload.time,
    distance: payload.distance,
    unit: payload.unit,
  });

  if (result.ok) {
    return jsonResponse({ status: 'completed' }, 200);
  }

  const status = result.message === "Flight submission isn't configured yet." ? 501 : 502;
  return jsonResponse({ status: 'error', message: result.message }, status);
}
