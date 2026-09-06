import headerHtml from './header.html';
import footerHtml from './footer.html';
import homeContent from './home.html';
import programsContent from './programs.html';
import fleetContent from './fleet.html';
import hubsContent from './hubs.html';

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

  '/header.html': headerHtml,
  '/footer.html': footerHtml,
};

const SESSION_COOKIE = 'session';
const STATE_COOKIE = 'oauth_state';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/auth-client.js') {
        return new Response(AUTH_CLIENT_JS, {
          headers: { 'Content-Type': 'application/javascript;charset=UTF-8' },
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

      if (pathname in pageRoutes) {
        return new Response(pageRoutes[pathname], {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' },
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
  const redirectUri = new URL('/auth/discord/callback', request.url).toString();
  const state = crypto.randomUUID();

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
  const robloxUsername = await lookupRobloxUsername(env, discordUsername);

  if (!robloxUsername) {
    return redirectWithError(url, 'not_registered', clearState);
  }

  const robloxAvatarUrl = await lookupRobloxAvatar(robloxUsername);

  const sessionValue = await createSessionCookie(env, {
    discordUsername,
    robloxUsername,
    robloxAvatarUrl,
  });

  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', clearState);
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

  return jsonResponse(session, 200);
}

function redirectWithError(url, code, extraCookie) {
  const dest = new URL('/', url);
  dest.searchParams.set('auth_error', code);
  const headers = new Headers({ Location: dest.toString() });
  if (extraCookie) headers.append('Set-Cookie', extraCookie);
  return new Response(null, { status: 302, headers });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------
// Google Sheet lookup
// ---------------------------------------------------------------------

async function lookupRobloxUsername(env, discordUsername) {
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
      const robloxCell = (row[1] || '').trim(); // Column B
      return robloxCell || null;
    }
  }

  return null;
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

function parseCookies(cookieHeader) {
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

async function verifySessionCookie(env, cookieValue) {
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
