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
  loggingMode: 'manual', // 'manual' | 'automatic' — which Flight Logger UI is shown
};

const ALLOWED_UNITS = ['nm', 'km'];
const ALLOWED_THEMES = ['light', 'dark'];
const ALLOWED_LOGGING_MODES = ['manual', 'automatic'];

function settingsKey(discordUsername) {
  return `settings:${discordUsername.toLowerCase()}`;
}

async function getSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;
  return verifySessionCookie(env, raw);
}

// Reads one pilot's stored settings straight from KV, merged with
// defaults. Shared by handleGetSettings below and the automatic
// flight logger (see src/autoflightlog.js), which needs the pilot's
// distance-unit preference without going through an HTTP request.
// Never throws — falls back to defaults on any KV/parse error.
export async function getStoredSettings(env, discordUsername) {
  if (!env.SETTINGS_KV) {
    console.error('SETTINGS_KV is not bound — see wrangler.toml');
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const stored = await env.SETTINGS_KV.get(settingsKey(discordUsername));
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : { ...DEFAULT_SETTINGS };
  } catch (err) {
    console.error('Failed to read dashboard settings from KV:', err);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function handleGetSettings(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return jsonResponse({ error: 'not_authenticated' }, 401);
  }

  const settings = await getStoredSettings(env, session.discordUsername);
  return jsonResponse(settings, 200);
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

  if (payload.loggingMode !== undefined) {
    if (!ALLOWED_LOGGING_MODES.includes(payload.loggingMode)) {
      return jsonResponse({ status: 'error', message: 'Invalid logging mode' }, 400);
    }
    next.loggingMode = payload.loggingMode;
  }

  try {
    await env.SETTINGS_KV.put(key, JSON.stringify(next));
  } catch (err) {
    console.error('Failed to write dashboard settings to KV:', err);
    return jsonResponse({ status: 'error', message: 'Could not save settings.' }, 502);
  }

  return jsonResponse({ status: 'ok', settings: next }, 200);
}
