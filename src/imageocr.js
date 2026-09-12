// Reads one FDR-panel screenshot (see the in-game "Server Info" panel —
// the scrollable list of Aircraft / Date-Time-Usage / Departure /
// Distance-Duration / Arrival rows) and turns it into the same raw
// row shape src/autoflightlog.js already knows how to normalize.
//
// This is the ONLY file that talks to an outside AI provider — kept
// isolated so the extraction step can be swapped out without touching
// the detection/matching/logging pipeline at all. Three providers are
// wired up below; pick one with:
//
//   wrangler secret put IMAGE_OCR_PROVIDER   # "gemini", "openai", or "anthropic"
//
// Defaults to "gemini" if unset, since it's the only one of the three
// with a genuinely free tier (no card on file needed). Providers are
// asked to reply via a FORCED function/tool call against a strict
// schema, rather than free-form text we then hope parses cleanly —
// that matters here because a misread "Usage" id could let a flight
// get logged twice, and a misread distance/duration directly affects
// payout.
//
// --- Gemini (default, free) -----------------------------------------
//   wrangler secret put GEMINI_API_KEY
//   wrangler secret put GEMINI_MODEL   # optional, defaults to "gemini-3.5-flash"
//
// --- OpenAI (alternative) --------------------------------------------
//   wrangler secret put OPENAI_API_KEY
//   wrangler secret put OPENAI_MODEL   # optional, defaults to "gpt-5.5"
//
// --- Anthropic (alternative) ----------------------------------------
//   wrangler secret put ANTHROPIC_API_KEY
//   wrangler secret put ANTHROPIC_MODEL   # optional, defaults to "claude-sonnet-5"
//
// Google's free tier is quota-limited (requests/day and requests/min
// caps that vary by model and can change), so if you ever outgrow it
// or Google tightens the free-tier model list, switching to OpenAI or
// Anthropic is just changing IMAGE_OCR_PROVIDER; nothing else in the
// codebase needs to change.

const EXTRACTION_PROMPT = `This is a screenshot of an in-game "Server Info" FDR (Flight Data Recorder) log — a scrollable list of flights. Each row shows, top to bottom: the aircraft/vehicle type; a line with the date, a UTC time, and a "Usage: <id>" number; then three columns — a departure airport code next to a takeoff icon, a distance in nautical miles with a duration underneath it, and an arrival airport code next to a landing icon. A crashed flight shows the word "CRASH" (often in red) in place of either the duration or the arrival code.

Call record_flight_rows with one entry per visible flight row, reading every field exactly as printed. Do not include rows from any other part of the screenshot (menus, chat log, server stats, etc). If a row is partially cut off at the top/bottom edge such that you can't read all of its fields, leave it out rather than guessing.`;

const ROW_PROPERTIES = {
  aircraft: { type: 'string', description: 'The aircraft/vehicle type text, e.g. "Boeing 747-8I".' },
  date: { type: 'string', description: 'The date shown, exactly as printed, e.g. "08/29/2026".' },
  time: { type: 'string', description: 'The UTC time shown next to the date, e.g. "09:56" (24-hour, no seconds).' },
  usageId: { type: 'string', description: 'The number after "Usage:", exactly as printed.' },
  departure: { type: 'string', description: 'The ICAO/airport code next to the takeoff icon.' },
  distanceNm: { type: 'number', description: 'The distance number, in nautical miles (the "nm" figure).' },
  duration: { type: 'string', description: 'The HH:MM:SS duration text under the distance, OR the literal word "CRASH" if that is what is printed there.' },
  arrival: { type: 'string', description: 'The ICAO/airport code next to the landing icon, OR the literal word "CRASH" if that is what is printed there instead of a code.' },
};
const ROW_REQUIRED = ['aircraft', 'date', 'time', 'usageId', 'departure', 'distanceNm', 'duration', 'arrival'];

// Returns an array of raw row objects (possibly empty), or throws on a
// hard failure (bad API key, network error, etc) so the caller can
// surface a clear error instead of silently returning zero flights.
export async function extractFlightRowsFromImage(env, base64Data, mediaType) {
  const provider = (env.IMAGE_OCR_PROVIDER || 'gemini').toLowerCase();

  if (provider === 'gemini') {
    return extractWithGemini(env, base64Data, mediaType);
  }
  if (provider === 'anthropic') {
    return extractWithAnthropic(env, base64Data, mediaType);
  }
  if (provider === 'openai') {
    return extractWithOpenAI(env, base64Data, mediaType);
  }

  const err = new Error(`Unknown IMAGE_OCR_PROVIDER "${provider}" — use "gemini", "openai", or "anthropic".`);
  err.httpStatus = 501;
  throw err;
}

// ---------------------------------------------------------------------
// Gemini (generateContent API, forced function call)
// ---------------------------------------------------------------------
const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

async function extractWithGemini(env, base64Data, mediaType) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("Automatic flight logging isn't configured yet (missing GEMINI_API_KEY).");
    err.httpStatus = 501;
    throw err;
  }

  const model = env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const functionDeclaration = {
    name: 'record_flight_rows',
    description: 'Records every flight row visible in the FDR (Flight Data Recorder) panel screenshot, top to bottom.',
    parameters: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: 'One entry per visible row. Omit rows that are cut off or unreadable rather than guessing.',
          items: {
            type: 'object',
            properties: ROW_PROPERTIES,
            required: ROW_REQUIRED,
          },
        },
      },
      required: ['rows'],
    },
  };

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: EXTRACTION_PROMPT },
              { inline_data: { mime_type: mediaType, data: base64Data } },
            ],
          },
        ],
        tools: [{ functionDeclarations: [functionDeclaration] }],
        toolConfig: {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['record_flight_rows'] },
        },
        generationConfig: { maxOutputTokens: 4096 },
      }),
    });
  } catch (err) {
    console.error('Gemini API request failed:', err);
    const wrapped = new Error('Could not reach the image-reading service.');
    wrapped.httpStatus = 502;
    throw wrapped;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error('Gemini API returned an error:', res.status, bodyText);
    const err = new Error(
      res.status === 401 || res.status === 403
        ? 'The image-reading service rejected our credentials.'
        : res.status === 429
        ? 'The image-reading service is rate-limited right now (free-tier quota). Try again shortly.'
        : 'The image-reading service could not process that screenshot.'
    );
    err.httpStatus = 502;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('Gemini API response was not valid JSON:', err);
    const wrapped = new Error('The image-reading service returned an unexpected response.');
    wrapped.httpStatus = 502;
    throw wrapped;
  }

  const parts = data.candidates?.[0]?.content?.parts;
  const functionCall = Array.isArray(parts)
    ? parts.find(part => part.functionCall && part.functionCall.name === 'record_flight_rows')?.functionCall
    : null;

  if (!functionCall || !functionCall.args || !Array.isArray(functionCall.args.rows)) {
    console.error('Gemini API response did not include the expected function call:', JSON.stringify(data).slice(0, 500));
    return [];
  }

  return functionCall.args.rows;
}

// ---------------------------------------------------------------------
// OpenAI (Chat Completions API, forced function call)
// ---------------------------------------------------------------------
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_DEFAULT_MODEL = 'gpt-5.5';

async function extractWithOpenAI(env, base64Data, mediaType) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("Automatic flight logging isn't configured yet (missing OPENAI_API_KEY).");
    err.httpStatus = 501;
    throw err;
  }

  const model = env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL;

  // OpenAI's "strict" function calling requires every property to be
  // required and additionalProperties: false at every object level.
  const tool = {
    type: 'function',
    function: {
      name: 'record_flight_rows',
      description: 'Records every flight row visible in the FDR (Flight Data Recorder) panel screenshot, top to bottom.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            description: 'One entry per visible row. Omit rows that are cut off or unreadable rather than guessing.',
            items: {
              type: 'object',
              properties: ROW_PROPERTIES,
              required: ROW_REQUIRED,
              additionalProperties: false,
            },
          },
        },
        required: ['rows'],
        additionalProperties: false,
      },
    },
  };

  let res;
  try {
    res = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'record_flight_rows' } },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: EXTRACTION_PROMPT },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64Data}` } },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    console.error('OpenAI API request failed:', err);
    const wrapped = new Error('Could not reach the image-reading service.');
    wrapped.httpStatus = 502;
    throw wrapped;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error('OpenAI API returned an error:', res.status, bodyText);
    const err = new Error(
      res.status === 401 || res.status === 403
        ? 'The image-reading service rejected our credentials.'
        : 'The image-reading service could not process that screenshot.'
    );
    err.httpStatus = 502;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('OpenAI API response was not valid JSON:', err);
    const wrapped = new Error('The image-reading service returned an unexpected response.');
    wrapped.httpStatus = 502;
    throw wrapped;
  }

  const toolCall = data.choices?.[0]?.message?.tool_calls?.find(
    tc => tc.type === 'function' && tc.function?.name === 'record_flight_rows'
  );

  if (!toolCall) {
    console.error('OpenAI API response did not include the expected tool call:', JSON.stringify(data).slice(0, 500));
    return [];
  }

  let parsedArgs;
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments);
  } catch (err) {
    console.error('OpenAI tool call arguments were not valid JSON:', toolCall.function.arguments);
    return [];
  }

  return Array.isArray(parsedArgs.rows) ? parsedArgs.rows : [];
}

// ---------------------------------------------------------------------
// Anthropic (Messages API, forced tool use)
// ---------------------------------------------------------------------
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5';

async function extractWithAnthropic(env, base64Data, mediaType) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("Automatic flight logging isn't configured yet (missing ANTHROPIC_API_KEY).");
    err.httpStatus = 501;
    throw err;
  }

  const model = env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL;

  const tool = {
    name: 'record_flight_rows',
    description: 'Records every flight row visible in the FDR (Flight Data Recorder) panel screenshot, top to bottom.',
    input_schema: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: 'One entry per visible row. Omit rows that are cut off or unreadable rather than guessing.',
          items: {
            type: 'object',
            properties: ROW_PROPERTIES,
            required: ROW_REQUIRED,
          },
        },
      },
      required: ['rows'],
    },
  };

  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        tools: [tool],
        tool_choice: { type: 'tool', name: 'record_flight_rows' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
              { type: 'text', text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    console.error('Anthropic API request failed:', err);
    const wrapped = new Error('Could not reach the image-reading service.');
    wrapped.httpStatus = 502;
    throw wrapped;
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    console.error('Anthropic API returned an error:', res.status, bodyText);
    const err = new Error(
      res.status === 401 || res.status === 403
        ? 'The image-reading service rejected our credentials.'
        : 'The image-reading service could not process that screenshot.'
    );
    err.httpStatus = 502;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('Anthropic API response was not valid JSON:', err);
    const wrapped = new Error('The image-reading service returned an unexpected response.');
    wrapped.httpStatus = 502;
    throw wrapped;
  }

  const toolUse = Array.isArray(data.content)
    ? data.content.find(block => block.type === 'tool_use' && block.name === 'record_flight_rows')
    : null;

  if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.rows)) {
    console.error('Anthropic API response did not include the expected tool call:', JSON.stringify(data).slice(0, 500));
    return [];
  }

  return toolUse.input.rows;
}

// Converts an ArrayBuffer to a base64 string in fixed-size chunks so it
// doesn't blow the call stack on large screenshots (String.fromCharCode
// with a spread of a multi-megabyte array will).
export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
