// Handles POST /api/flight/submit — the flight logger's "submit system".
//
// Kept in its own file rather than folded into index.js so this can grow
// (extra validation, retries, a different backend, etc.) without turning
// index.js into a dumping ground.
//
// This does NOT know how to write to your roster sheet itself — it just
// validates the request, confirms who's submitting via the same signed
// session cookie the rest of the site uses, and forwards the flight entry
// to whatever service actually records it (your wispbyte-hosted app, an
// Apps Script webhook, etc). Point it there by setting FLIGHT_SUBMIT_WEBHOOK_URL,
// e.g.:
//   wrangler secret put FLIGHT_SUBMIT_WEBHOOK_URL
//
// That service is expected to respond 2xx on success. If it needs a
// different request shape than the one built below, that's the only
// place you need to change.

import { parseCookies, verifySessionCookie, jsonResponse, SESSION_COOKIE } from './index.js';

const REQUIRED_FIELDS = ['departure', 'destination', 'aircraft', 'time', 'distance', 'unit'];

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

  const webhookUrl = env.FLIGHT_SUBMIT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('FLIGHT_SUBMIT_WEBHOOK_URL is not configured — see flightSubmit.js');
    return jsonResponse({ status: 'error', message: 'Flight submission isn\'t configured yet.' }, 501);
  }

  try {
    const forwardRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discord: session.discordUsername,
        roblox: session.robloxUsername,
        departure: payload.departure,
        destination: payload.destination,
        aircraft: payload.aircraft,
        time: payload.time,
        distance: payload.distance,
        unit: payload.unit,
      }),
    });

    if (!forwardRes.ok) {
      const text = await forwardRes.text().catch(() => '');
      console.error('Flight submit webhook rejected the request:', forwardRes.status, text);
      return jsonResponse({ status: 'error', message: 'Flight submission was rejected. Please try again.' }, 502);
    }

    return jsonResponse({ status: 'completed' }, 200);
  } catch (err) {
    console.error('Flight submit webhook error:', err);
    return jsonResponse({ status: 'error', message: 'Could not reach the flight submission service.' }, 502);
  }
}
