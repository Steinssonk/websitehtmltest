// Handles GET/POST /api/settings — persists the pilot dashboard's
// per-user preferences (distance unit, swap-after-log, light/dark theme)
// in Cloudflare Workers KV, keyed off the signed-in pilot's Discord
// username, so settings follow them across devices/sessions instead of
// living only in localStorage on one browser.
//
// Requires a KV namespace bound as SETTINGS_KV — see wrangler.toml.

import { parseCookies, verifySessionCookie, jsonResponse, SESSION_COOKIE } from './index.js';

const DEFAULT_SETTINGS = {
  unit: 'nm',            // 'nm' | 'km' — flight logger distance unit
  swapAfterLog: false,   // swap departure/destination into the form after a successful log
  theme: 'light',        // 'light' | 'dark' — dashboard-only appearance
};

const ALLOWED_UNITS = ['nm', 'km'];
const ALLOWED_THEMES = ['light', 'dark'];

function settingsKey(discordUsername) {
  return `settings:${discordUsername.toLowerCase()}`;
}

async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifySessionCookie(env, raw);
}

export async function handleGetSettings(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ error: 'not_authenticated' }, 401);
  }

  if (!env.SETTINGS_KV) {
    console.error('SETTINGS_KV is not bound — see wrangler.toml');
    return jsonResponse({ ...DEFAULT_SETTINGS }, 200);
  }

  try {
    const stored = await env.SETTINGS_KV.get(settingsKey(session.discordUsername));
    const settings = stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : { ...DEFAULT_SETTINGS };
    return jsonResponse(settings, 200);
  } catch (err) {
    console.error('Failed to read dashboard settings from KV:', err);
    return jsonResponse({ ...DEFAULT_SETTINGS }, 200);
  }
}

export async function handleSaveSettings(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ status: 'error', message: 'Method not allowed' }, 405);
  }

  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ status: 'error', message: 'Not authenticated' }, 401);
  }

  if (!env.SETTINGS_KV) {
    console.error('SETTINGS_KV is not bound — see wrangler.toml');
    return jsonResponse({ status: 'error', message: "Settings storage isn't configured yet." }, 501);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ status: 'error', message: 'Invalid request body' }, 400);
  }

  const key = settingsKey(session.discordUsername);

  // Merge onto whatever's already stored so a partial update (e.g. just
  // flipping the theme) doesn't clobber the pilot's other preferences.
  let current = {};
  try {
    const stored = await env.SETTINGS_KV.get(key);
    if (stored) current = JSON.parse(stored);
  } catch (err) {
    console.error('Failed to read existing dashboard settings from KV:', err);
  }

  const next = { ...DEFAULT_SETTINGS, ...current };

  if (payload.unit !== undefined) {
    if (!ALLOWED_UNITS.includes(payload.unit)) {
      return jsonResponse({ status: 'error', message: 'Invalid unit' }, 400);
    }
    next.unit = payload.unit;
  }

  if (payload.swapAfterLog !== undefined) {
    next.swapAfterLog = !!payload.swapAfterLog;
  }

  if (payload.theme !== undefined) {
    if (!ALLOWED_THEMES.includes(payload.theme)) {
      return jsonResponse({ status: 'error', message: 'Invalid theme' }, 400);
    }
    next.theme = payload.theme;
  }

  try {
    await env.SETTINGS_KV.put(key, JSON.stringify(next));
  } catch (err) {
    console.error('Failed to write dashboard settings to KV:', err);
    return jsonResponse({ status: 'error', message: 'Could not save settings.' }, 502);
  }

  return jsonResponse({ status: 'ok', settings: next }, 200);
}
