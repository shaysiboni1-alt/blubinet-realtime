// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (TEXT output) + ElevenLabs TTS (ulaw_8000 streaming)
//
// FIXES:
// 1) Greeting is played immediately via Eleven (not dependent on OpenAI) -> no more silent calls.
// 2) When OpenAI VAD signals speech_stopped -> commit buffer + response.create (forces replies).
// 3) Always-on logs + optional raw OpenAI event logging.
//
// Requirements:
//   npm install express ws dotenv
//
// Twilio Voice Webhook -> POST /twilio-voice
// Browser test -> GET /twilio-voice
// Health -> GET /health
// Media Stream -> wss://<domain>/twilio-media-stream
//

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase().trim();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function envStr(name, def = '') {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  return String(raw);
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'שלום, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);
const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תודה שדיברתם עם BluBinet. יום נעים!'
);

const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');
const MB_DYNAMIC_KB_URL = envStr('MB_DYNAMIC_KB_URL', '');
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber('MB_DYNAMIC_KB_MIN_INTERVAL_MS', 5 * 60 * 1000);

const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// VAD
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_TOKENS = n;
  else if (MAX_OUTPUT_TOKENS_ENV === 'inf') MAX_OUTPUT_TOKENS = 'inf';
}

// Twilio API creds (hangup + caller fetch)
const TWILIO_ACCOUNT_SID = envStr('TWILIO_ACCOUNT_SID', '');
const TWILIO_AUTH_TOKEN = envStr('TWILIO_AUTH_TOKEN', '');

// Debug
const MB_DEBUG = envBool('MB_DEBUG', true);
const MB_LOG_OPENAI_EVENTS = envBool('MB_LOG_OPENAI_EVENTS', true); // 👈 חשוב כדי להבין למה אין Bot events
const MB_ASR_LANGUAGE = envStr('MB_ASR_LANGUAGE', 'he').trim().toLowerCase();

// -----------------------------
// ElevenLabs ENV (תומך בשמות שלך)
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase().trim();
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));

// אצלך יש VOICE_ID (לא ELEVEN_VOICE_ID)
const ELEVEN_VOICE_ID = envStr('VOICE_ID', envStr('ELEVEN_VOICE_ID', ''));

// מודל
let ELEVEN_MODEL_ID_RAW = envStr('ELEVENLABS_MODEL_ID', envStr('ELEVEN_TTS_MODEL', 'eleven_v3')).trim();
let ELEVEN_MODEL_ID = 'eleven_v3';
if (ELEVEN_MODEL_ID_RAW) {
  const x = ELEVEN_MODEL_ID_RAW.toLowerCase().replace(/\s+/g, '_');
  if (x.includes('eleven') && x.includes('v3')) ELEVEN_MODEL_ID = 'eleven_v3';
  else ELEVEN_MODEL_ID = x;
}

const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', envStr('ELEVENLABS_OUTPUT_FORMAT', 'ulaw_8000')).trim();
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he')).trim().toLowerCase();

// Stability חייב: 0.0 / 0.5 / 1.0
function normalizeStability(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  const allowed = [0.0, 0.5, 1.0];
  let best = 0.5;
  let bestDist = Infinity;
  for (const a of allowed) {
    const d = Math.abs(a - n);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}

const ELEVEN_STABILITY = normalizeStability(envStr('ELEVENLABS_STABILITY', '0.5'));
const ELEVEN_STYLE = Math.max(0, Math.min(1, envNumber('ELEVENLABS_STYLE', 0.15)));
const ELEVEN_USE_BOOST = envBool('ELEVENLABS_USE_BOOST', true);
const ELEVEN_OPTIMIZE_STREAMING_LATENCY = Math.max(0, Math.min(4, envNumber('ELEVENLABS_OPTIMIZE_STREAMING_LATENCY', 3)));

// שים לב: 2200ms יכול להיות קצר מדי. ברירת מחדל כאן יותר בטוחה.
const ELEVEN_TIMEOUT_MS = envNumber('ELEVENLABS_TIMEOUT_MS', 12000);

// -----------------------------
// Logging helpers
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}

function rid() {
  return crypto.randomBytes(4).toString('hex');
}

function log(tag, level, msg, extra) {
  const base = `[${nowIso()}][${level}][${tag}] ${msg}`;
  if (extra !== undefined) console.log(base, extra);
  else console.log(base);
}

function logErr(tag, msg, extra) {
  const base = `[${nowIso()}][ERROR][${tag}] ${msg}`;
  if (extra !== undefined) console.error(base, extra);
  else console.error(base);
}

process.on('uncaughtException', (e) => logErr('Process', 'uncaughtException', e));
process.on('unhandledRejection', (e) => logErr('Process', 'unhandledRejection', e));

// -----------------------------
// Dynamic KB
// -----------------------------
let dynamicBusinessPrompt = '';
let lastDynamicKbRefreshAt = 0;

async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
    if (MB_DEBUG) log('DynamicKB', 'INFO', 'MB_DYNAMIC_KB_URL empty – skip.');
    return;
  }
  const now = Date.now();
  if (tag !== 'Startup' && now - lastDynamicKbRefreshAt < MB_DYNAMIC_KB_MIN_INTERVAL_MS) {
    log('DynamicKB', 'INFO', `Skip refresh – refreshed ${now - lastDynamicKbRefreshAt}ms ago.`);
    return;
  }

  try {
    const res = await fetch(MB_DYNAMIC_KB_URL);
    if (!res.ok) {
      logErr('DynamicKB', `Failed to fetch. HTTP ${res.status}`);
      return;
    }
    const text = (await res.text()).trim();
    dynamicBusinessPrompt = text;
    lastDynamicKbRefreshAt = Date.now();
    log('DynamicKB', 'INFO', `Loaded. length=${text.length}`);
  } catch (err) {
    logErr('DynamicKB', 'Error fetching dynamic KB', err);
  }
}

// -----------------------------
// Prompt builder
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) אל תתייחסי לרעשי רקע/איכות קו. אם לא הבנת – "לא שמעתי טוב, אפשר לחזור על זה?"
2) תשובות קצרות (2–3 משפטים) וסיימי בשאלה שמבררת מה חשוב ללקוח.
3) אל תייצרי שפה זרה. עברית כברירת מחדל.
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const staticKb = (MB_BUSINESS_PROMPT || '').trim();
  const dynamicKb = (dynamicBusinessPrompt || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (staticKb) instructions += (instructions ? '\n\n' : '') + staticKb;
  if (dynamicKb) instructions += (instructions ? '\n\n' : '') + dynamicKb;

  if (!instructions) {
    instructions = `
אתם עוזר קולי בזמן אמת בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
ברירת מחדל: עברית, לשון רבים, טון חם וקצר.
`.trim();
  }

  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Twilio helpers (hangup)
// -----------------------------
async function hangupTwilioCall(callSid, tag = 'Call') {
  if (!callSid) return;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const body = new URLSearchParams({ Status: 'completed' });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logErr(tag, `Twilio hangup HTTP ${res.status}`, txt);
    } else {
      log(tag, 'INFO', 'Twilio call hangup requested successfully.');
    }
  } catch (e) {
    logErr(tag, 'Twilio hangup error', e);
  }
}

// -----------------------------
// ElevenLabs TTS (STREAMING ulaw_8000)
// -----------------------------
async function elevenTtsStreamToTwilio({ text, streamSid, wsSend, callRid }) {
  if (!ELEVEN_API_KEY) throw new Error('Missing ELEVEN_API_KEY');
  if (!ELEVEN_VOICE_ID) throw new Error('Missing VOICE_ID / ELEVEN_VOICE_ID');
  if (!text || !text.trim()) return;

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream` +
    `?output_format=${encodeURIComponent(ELEVEN_OUTPUT_FORMAT || 'ulaw_8000')}` +
    `&optimize_streaming_latency=${encodeURIComponent(String(ELEVEN_OPTIMIZE_STREAMING_LATENCY))}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ELEVEN_TIMEOUT_MS);

  const payload = {
    text,
    model_id: ELEVEN_MODEL_ID || 'eleven_v3',
    language: ELEVEN_LANGUAGE || 'he',
    voice_settings: {
      stability: ELEVEN_STABILITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: !!ELEVEN_USE_BOOST
    }
  };

  log('ElevenTTS', 'INFO', 'Sending text to ElevenLabs TTS.', {
    rid: callRid,
    length: text.length,
    model: payload.model_id,
    language: payload.language,
    format: ELEVEN_OUTPUT_FORMAT || 'ulaw_8000',
    stability: payload.voice_settings.stability
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!res.ok) {
      const errTxt = await res.text().catch(() => '');
      throw new Error(`ElevenLabs HTTP ${res.status} ${errTxt}`);
    }

    const reader = res.body.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      total += value.length;
      const b64 = Buffer.from(value).toString('base64');
      wsSend(
        JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: b64 }
        })
      );
    }

    log('ElevenTTS', 'INFO', 'ElevenLabs TTS stream finished.', { rid: callRid, bytes: total });
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------
// Express app
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  req._rid = req.headers['x-request-id'] || rid();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  log('HTTP', 'INFO', `--> [${req._rid}] ${req.method} ${req.path} ip=${ip}`);
  res.on('finish', () => log('HTTP', 'INFO', `<-- [${req._rid}] ${req.method} ${req.path} status=${res.statusCode}`));
  next();
});

app.get('/', (req, res) => res.type('text/plain').send('OK. BluBinet Realtime is up. Try GET /health or /twilio-voice'));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'blubinet-realtime',
    tts_provider: TTS_PROVIDER,
    eleven: {
      has_key: !!ELEVEN_API_KEY,
      voice_id_set: !!ELEVEN_VOICE_ID,
      model_id: ELEVEN_MODEL_ID,
      output_format: ELEVEN_OUTPUT_FORMAT,
      language: ELEVEN_LANGUAGE,
      stability: ELEVEN_STABILITY,
      style: ELEVEN_STYLE,
      use_boost: ELEVEN_USE_BOOST,
      optimize_streaming_latency: ELEVEN_OPTIMIZE_STREAMING_LATENCY,
      timeout_ms: ELEVEN_TIMEOUT_MS
    },
    time: nowIso()
  });
});

// GET test endpoint (no "Cannot GET")
app.get('/twilio-voice', (req, res) => {
  log('Twilio-Voice', 'INFO', `GET /twilio-voice (browser test). rid=${req._rid}`);
  res.type('text/plain').send(
    `OK. This endpoint is meant for Twilio (HTTP POST).\n` +
      `Use POST /twilio-voice from Twilio Voice Webhook.\n` +
      `Check GET /health.\n`
  );
});

// POST TwiML
app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${String(host).replace(/^https?:\/\//, '')}/twilio-media-stream`;

  const caller = req.body.From || '';
  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  log('Twilio-Voice', 'INFO', `POST /twilio-voice -> Stream=${wsUrl}, From=${caller}`);
  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);

// -----------------------------
// WebSocket server for Twilio Media Streams
// -----------------------------
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Realtime WS call handler
// -----------------------------
wss.on('connection', (twilioWs) => {
  const callRid = rid();
  log('Call', 'INFO', 'New Twilio Media Stream connection established.', { rid: callRid });

  if (!OPENAI_API_KEY) {
    logErr('Call', 'OPENAI_API_KEY missing – closing.', { rid: callRid });
    try { twilioWs.close(); } catch {}
    return;
  }

  let streamSid = null;
  let callSid = null;
  let caller = null;

  let callEnded = false;
  let openAiReady = false;

  let botSpeaking = false;
  let botTurnActive = false;
  let hasActiveResponse = false;
  let noListenUntilTs = 0;

  let pendingText = '';
  let conversationLog = [];

  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;
    log('Call', 'INFO', `endCall called with reason="${reason}"`, { rid: callRid });
    log('Call', 'INFO', 'Final conversation log:', conversationLog);
    if (callSid) hangupTwilioCall(callSid, 'Call').catch(() => {});
    try { twilioWs.close(); } catch {}
    try { openAiWs.close(); } catch {}
  }

  async function speak(text) {
    if (!streamSid) return;
    if (!text || !text.trim()) return;

    botSpeaking = true;
    botTurnActive = true;
    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

    conversationLog.push({ from: 'bot', text });
    log('Bot', 'INFO', text);

    if (TTS_PROVIDER !== 'eleven') {
      logErr('ElevenTTS', 'TTS_PROVIDER is not eleven -> no audio will be produced.');
      botSpeaking = false;
      botTurnActive = false;
      return;
    }

    try {
      await elevenTtsStreamToTwilio({
        text,
        streamSid,
        wsSend: (s) => {
          if (twilioWs.readyState === WebSocket.OPEN) {
            try { twilioWs.send(s); } catch {}
          }
        },
        callRid
      });
    } catch (e) {
      logErr('ElevenTTS', 'Failed to produce audio', String(e));
    } finally {
      botSpeaking = false;
      botTurnActive = false;
    }
  }

  // -----------------------------
  // OpenAI Realtime WS
  // -----------------------------
  const instructions = buildSystemInstructions();

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  function sendToOpenAI(obj) {
    if (openAiWs.readyState !== WebSocket.OPEN) return;
    openAiWs.send(JSON.stringify(obj));
  }

  function createResponse() {
    // forcing TEXT response
    sendToOpenAI({
      type: 'response.create',
      response: { modalities: ['text'] }
    });
    hasActiveResponse = true;
    botTurnActive = true;
  }

  openAiWs.on('open', () => {
    openAiReady = true;
    log('Call', 'INFO', 'Connected to OpenAI Realtime API.', { rid: callRid });

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;

    // TEXT ONLY output (no Alloy)
    sendToOpenAI({
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['text'],
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1', language: MB_ASR_LANGUAGE || 'he' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: effectiveSilenceMs,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: MAX_OUTPUT_TOKENS,
        instructions
      }
    });

    log('Call', 'INFO', 'session.update sent (text-only).', { rid: callRid });
  });

  openAiWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logErr('OpenAI', 'Failed to parse message', e);
      return;
    }

    if (MB_LOG_OPENAI_EVENTS) {
      // לא מציף תוכן רגיש, רק סוג אירוע
      log('OpenAI', 'INFO', `event=${msg.type}`, { rid: callRid });
    }

    // VAD events – trigger response when speech stops
    if (msg.type === 'input_audio_buffer.speech_stopped') {
      if (!hasActiveResponse && !callEnded) {
        // commit + response.create ensures the model replies
        sendToOpenAI({ type: 'input_audio_buffer.commit' });
        createResponse();
      }
      return;
    }

    // Transcription event(s)
    if (
      msg.type === 'conversation.item.input_audio_transcription.completed' ||
      msg.type === 'input_audio_transcription.completed'
    ) {
      const t = String(msg.transcript || '').trim();
      if (t) {
        conversationLog.push({ from: 'user', text: t });
        log('User', 'INFO', t);
      }
      return;
    }

    // Response lifecycle
    if (msg.type === 'response.created') {
      pendingText = '';
      hasActiveResponse = true;
      botTurnActive = true;
      return;
    }

    // Collect text deltas (support multiple schemas)
    if (
      msg.type === 'response.output_text.delta' ||
      msg.type === 'response.text.delta' ||
      (typeof msg.type === 'string' && msg.type.includes('text') && msg.type.endsWith('.delta'))
    ) {
      const d = typeof msg.delta === 'string' ? msg.delta : '';
      if (d) pendingText += d;
      return;
    }

    // Some schemas send final text in "done"
    if (
      msg.type === 'response.output_text.done' ||
      msg.type === 'response.text.done' ||
      (typeof msg.type === 'string' && msg.type.includes('text') && msg.type.endsWith('.done'))
    ) {
      const final = (msg.text || msg.output_text || '').trim();
      if (final) pendingText = final;
      return;
    }

    if (msg.type === 'response.completed') {
      const text = (pendingText || '').trim();
      pendingText = '';
      hasActiveResponse = false;
      botTurnActive = false;

      if (text) {
        await speak(text);
      } else {
        // אם המודל החזיר כלום – לפחות נבקש לחזור
        await speak('לא שמעתי טוב, אפשר לחזור על זה?');
      }
      return;
    }

    if (msg.type === 'error') {
      logErr('OpenAI', 'Realtime error', msg);
      hasActiveResponse = false;
      botTurnActive = false;
      return;
    }
  });

  openAiWs.on('close', () => {
    log('Call', 'INFO', 'OpenAI WS closed.', { rid: callRid });
  });

  openAiWs.on('error', (err) => {
    logErr('OpenAI', 'OpenAI WS error', err);
  });

  // -----------------------------
  // Twilio WS
  // -----------------------------
  twilioWs.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      logErr('Call', 'Failed to parse Twilio message', e);
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      caller = msg.start?.customParameters?.caller || null;

      log('Call', 'INFO', `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}, caller=${caller}`, {
        rid: callRid
      });

      // 👇 הכי חשוב: פתיח מיידי דרך Eleven (לא תלוי ב-OpenAI)
      // אם לא תשמעו כאן קול – הבעיה 100% ב-Eleven/ENV/format.
      await speak(MB_OPENING_SCRIPT);

      return;
    }

    if (event === 'media') {
      const payload = msg.media?.payload;
      if (!payload) return;

      // אם אין barge-in, נחסום קלט בזמן שהבוט מדבר/בתור
      if (!MB_ALLOW_BARGE_IN) {
        const now = Date.now();
        if (botTurnActive || botSpeaking || now < noListenUntilTs) return;
      }

      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      // Forward audio to OpenAI
      sendToOpenAI({ type: 'input_audio_buffer.append', audio: payload });
      return;
    }

    if (event === 'stop') {
      log('Call', 'INFO', 'Twilio stream stopped.', { rid: callRid });
      endCall('twilio_stop');
      return;
    }
  });

  twilioWs.on('close', () => {
    log('Call', 'INFO', 'Twilio WS closed.', { rid: callRid });
  });

  twilioWs.on('error', (err) => {
    logErr('Call', 'Twilio WS error', err);
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  console.log(`✅ BluBinet Realtime Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}ms`);
  console.log(
    `[CONFIG] Eleven: key=${ELEVEN_API_KEY ? 'SET' : 'MISSING'}, voice_id=${ELEVEN_VOICE_ID ? 'SET' : 'MISSING'}, model=${ELEVEN_MODEL_ID}, format=${ELEVEN_OUTPUT_FORMAT}, lang=${ELEVEN_LANGUAGE}, stability=${ELEVEN_STABILITY}, timeout=${ELEVEN_TIMEOUT_MS}ms`
  );
  refreshDynamicBusinessPrompt('Startup').catch(() => {});
});
