// A tiny Durable Object whose only job is to make ONE outbound HTTP
// request and hand back whatever came back, byte for byte.
//
// Why this exists: src/imageocr.js calls out to Gemini/OpenAI/Anthropic
// to read FDR screenshots. Those providers reject requests based on the
// IP address that's actually making the call — and a Cloudflare Worker's
// own fetch() runs from whatever edge colo is handling the incoming
// request, not from wherever the pilot is sitting. For pilots near
// Southeast Asia, that's most often Cloudflare's Hong Kong colo (HKG),
// which Gemini (and some other providers) explicitly blocks with
// "User location is not supported for the API use." (see the Sept 2026
// incident where this exact thing happened).
//
// A Durable Object, unlike a plain Worker invocation, can be pinned to
// a specific broad region with a `locationHint` the FIRST time it's
// created (see relayFetch() in imageocr.js) — after that, Cloudflare
// keeps that same object (and therefore its outbound IP's rough
// geography) in that region for its lifetime. Pointing it at "wnam"
// (Western North America) sidesteps HKG entirely and lands somewhere
// solidly inside every provider's supported-country list.
//
// Protocol: the caller POSTs to this object with an
// `X-Relay-Target-Url` header carrying the real destination URL, and
// whatever method/headers/body it would have sent directly. This
// object strips that header, forwards everything else to the real
// target, and returns the upstream response completely unmodified —
// so callers can keep treating the result exactly like a normal
// fetch() Response (checking .ok, .status, .json(), .text(), etc).
export class OcrRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const targetUrl = request.headers.get('X-Relay-Target-Url');
    if (!targetUrl) {
      return new Response('Missing X-Relay-Target-Url header', { status: 400 });
    }

    let parsedTarget;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return new Response('Invalid X-Relay-Target-Url header', { status: 400 });
    }
    // Only ever relay to https destinations — this object should never
    // become an open proxy to arbitrary internal/plaintext endpoints.
    if (parsedTarget.protocol !== 'https:') {
      return new Response('X-Relay-Target-Url must be https', { status: 400 });
    }

    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete('X-Relay-Target-Url');
    forwardHeaders.delete('Host');
    forwardHeaders.delete('CF-Connecting-IP');
    forwardHeaders.delete('CF-Ray');
    forwardHeaders.delete('CF-Visitor');

    try {
      return await fetch(parsedTarget.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'relay_fetch_failed', message: err.message || String(err) }),
        { status: 502, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
}
