// Handles POST /api/claim/submit — the "Claim Paycheck" / "Claim Paycheck
// + Reward" button on the dashboard's Rewards tab.
//
// Mirrors flightsubmit.js: validates the request, confirms who's
// submitting via the signed session cookie, then forwards to the
// Wispbyte-hosted bot's /claim endpoint (claimSubmission.js), which
// submits the existing Google Form. That form feeds the "Inputs" sheet,
// which the onFormSubmit Apps Script trigger reads to mark the G/H/I
// reward columns "claimed", zero the payment cell, and post the Discord
// claim ticket. This file does not talk to Discord or the roster sheet
// directly — the Apps Script + bot already own that.
//
// Set the base URL with:
//   wrangler secret put WISPBYTE_BASE_URL
// (same secret flightsubmit.js uses — no new secret needed.)

import { parseCookies, verifySessionCookie, jsonResponse, SESSION_COOKIE } from './index.js';

// Maps the dashboard's rankId values to the short reward-type keys the
// Apps Script's PROGRAM_COLUMNS understands (captain / firstofficer /
// secondofficer). Any rankId not in this map is dropped rather than sent
// as unrecognized text — the Apps Script would still show it in the
// ticket, but it wouldn't get matched to a Database column.
const REWARD_TYPE_BY_RANK_ID = {
  captain: 'captain',
  firstOfficer: 'firstofficer',
  secondOfficer: 'secondofficer',
};

export async function handleClaimSubmit(request, env) {
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

  const rewards = Array.isArray(payload.rewards) ? payload.rewards : [];

  // Builds "(rewardtype/aircraft)(rewardtype2/aircraft2)", or the literal
  // string "none" when the pilot is only claiming their paycheck — see
  // claimSubmission.js on the bot side for how "none" is handled.
  const claims = rewards
    .map((r) => ({
      rewardType: REWARD_TYPE_BY_RANK_ID[r.rankId] || null,
      aircraft: r.aircraft || '',
    }))
    .filter((c) => c.rewardType && c.aircraft);

  const aircraftsClaimed = claims.length > 0
    ? claims.map((c) => `(${c.rewardType}/${c.aircraft})`).join('')
    : 'none';

  const baseUrl = (env.WISPBYTE_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    console.error('WISPBYTE_BASE_URL is not configured — see claimsubmit.js');
    return jsonResponse({ status: 'error', message: 'Claim submission isn\'t configured yet.' }, 501);
  }

  const targetUrl = `${baseUrl}/claim`;

  try {
    const forwardRes = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        discord: session.discordUsername,
        roblox: session.robloxUsername,
        aircraftsClaimed,
      }),
    });

    if (!forwardRes.ok) {
      console.error('Claim submit request failed:', forwardRes.status, targetUrl);
      return jsonResponse({ status: 'error', message: `Claim request failed: HTTP ${forwardRes.status}` }, 502);
    }

    let result;
    try {
      result = await forwardRes.json();
    } catch {
      console.error('Claim submit response was not valid JSON');
      return jsonResponse({ status: 'error', message: 'Claim submission service returned an unexpected response.' }, 502);
    }

    if (result.status === 'completed') {
      return jsonResponse({ status: 'completed' }, 200);
    }

    return jsonResponse({ status: 'error', message: result.message || 'Claim submission failed' }, 502);
  } catch (err) {
    console.error('Claim submit webhook error:', err);
    return jsonResponse({ status: 'error', message: 'Could not reach the claim submission service.' }, 502);
  }
}
