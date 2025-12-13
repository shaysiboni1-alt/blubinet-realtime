// server.js
//
// BluBinet Voice Bot – "נטע"
// Twilio Media Streams -> OpenAI Realtime (TRANSCRIPTION ONLY)
// LLM via HTTP (OpenAI Responses) OR IVRIT endpoint (fallback by ENV)
// TTS via ElevenLabs (ulaw_8000 streamed in 20ms frames)
//
// Main fix:
// - Stop using OpenAI Realtime response.create (it gets stuck / no events)
// - Use Realtime ONLY for transcription
// - Generate replies via HTTP LLM => always get a reply => Eleven speaks
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
  const raw = String(process.env[name] || '').toLowerCase().trim();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}
function envStr(name, def = '') {
  const raw = process.env[name];
  return raw === undefined || raw === null || raw === '' ? def : String(raw);
}
function rid() {
  return crypto.randomBytes(4).toString('hex');
}

// -----------------------------
// Core ENV
// -----------------------------
const PORT = envNumber('PORT', 3000);
const DOMAIN = envStr('DOMAIN', '');
const MB_TWILIO_STREAM_URL = envStr('MB_TWILIO_STREAM_URL', '');

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_REALTIME_MODEL = envStr('OPENAI_REALTIME_MODEL', 'gpt-4o-realtime-preview-2024-12-17');

// HTTP LLM (OpenAI Responses)
const MB_LLM_PROVIDER = envStr('MB_LLM_PROVIDER', '').toLowerCase(); // optional: "ivrit" / "openai" / ""
const MB_LLM_MODEL = envStr('MB_LLM_MODEL', 'gpt-4o-mini'); // fast + cheap default
const MB_LLM_MAX_OUTPUT_TOKENS = envNumber('MB_LLM_MAX_OUTPUT_TOKENS', 220);

// IVRIT endpoint (your server/runpod behind it)
const IVRIT_LLM_URL = envStr('IVRIT_LLM_URL', ''); // POST -> {text:"..."} expected response {text:"..."}

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'צהריים טובים, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);
const MB_CLOSING_SCRIPT = envStr(
  'MB_CLOSING_SCRIPT',
  'תודה שדיברתם עם BluBinet. יום נעים!'
);

const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');

const MB_LANGUAGES = envStr('MB_LANGUAGES', 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// VAD (OpenAI server_vad)
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 700);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 150);

// Behavior / timing
const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 120000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 10 * 60 * 1000);

// LLM timeout
const MB_LLM_TIMEOUT_MS = envNumber('MB_LLM_TIMEOUT_MS', 6500);

// Logging
const MB_LOG_LEVEL = envStr('MB_LOG_LEVEL', 'info').toLowerCase(); // debug|info|warn|error

// -----------------------------
// ElevenLabs TTS
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase();
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));
const ELEVEN_VOICE_ID = envStr('ELEVEN_VOICE_ID', envStr('VOICE_ID', '')); // user has VOICE_ID
const ELEVEN_MODEL = envStr('ELEVEN_TTS_MODEL', 'eleven_v3');
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he'));
const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', 'ulaw_8000');
const ELEVEN_OPTIMIZE_STREAMING_LATENCY = envNumber('ELEVEN_OPTIMIZE_STREAMING_LATENCY', 3);
const ELEVEN_ENABLE_OPT_LATENCY = envBool('ELEVEN_ENABLE_OPT_LATENCY', true);

// voice settings
const ELEVEN_STABILITY = envNumber('ELEVEN_STABILITY', 0.5);
const ELEVEN_SIMILARITY = envNumber('ELEVEN_SIMILARITY', 0.75);
const ELEVEN_STYLE = envNumber('ELEVEN_STYLE', 0.0);
const ELEVEN_SPEAKER_BOOST = envBool('ELEVEN_SPEAKER_BOOST', true);

// Cached opening
const MB_CACHE_OPENING_AUDIO = envBool('MB_CACHE_OPENING_AUDIO', true);

if (!OPENAI_API_KEY) console.error('❌ Missing OPENAI_API_KEY in ENV.');
if (TTS_PROVIDER === 'eleven') {
  if (!ELEVEN_API_KEY) console.error('❌ Missing ELEVEN_API_KEY (or ELEVENLABS_API_KEY) in ENV.');
  if (!ELEVEN_VOICE_ID) console.error('❌ Missing VOICE_ID (or ELEVEN_VOICE_ID) in ENV.');
}

console.log(`[CONFIG] PORT=${PORT}`);
console.log(`[CONFIG] OPENAI_REALTIME_MODEL=${OPENAI_REALTIME_MODEL}`);
console.log(`[CONFIG] MB_LLM_MODEL=${MB_LLM_MODEL} providerHint=${MB_LLM_PROVIDER || 'auto'} IVRIT_LLM_URL=${IVRIT_LLM_URL ? 'SET' : 'NOT_SET'}`);
console.log(`[CONFIG] VAD threshold=${MB_VAD_THRESHOLD} silence_ms=${MB_VAD_SILENCE_MS} prefix_ms=${MB_VAD_PREFIX_MS}`);
console.log(`[CONFIG] MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}`);
console.log(`[CONFIG] TTS_PROVIDER=${TTS_PROVIDER}`);
console.log(`[CONFIG] ELEVEN voice_id=${ELEVEN_VOICE_ID ? 'SET' : 'NOT_SET'} model=${ELEVEN_MODEL} lang=${ELEVEN_LANGUAGE} fmt=${ELEVEN_OUTPUT_FORMAT}`);
console.log(`[CONFIG] MB_CACHE_OPENING_AUDIO=${MB_CACHE_OPENING_AUDIO}`);
console.log(`[CONFIG] MB_LOG_LEVEL=${MB_LOG_LEVEL}`);
console.log(`[CONFIG] MB_LLM_TIMEOUT_MS=${MB_LLM_TIMEOUT_MS}`);

// -----------------------------
// Logging
// -----------------------------
function rank(lvl) {
  if (lvl === 'debug') return 10;
  if (lvl === 'info') return 20;
  if (lvl === 'warn') return 30;
  if (lvl === 'error') return 40;
  return 20;
}
const CUR = rank(MB_LOG_LEVEL);

function log(lvl, tag, msg, extra, meta = {}) {
  if (rank(lvl) < CUR) return;
  const ts = new Date().toISOString();
  const ridPart = meta && meta.rid ? ` { rid: '${meta.rid}' }` : '';
  if (extra !== undefined) console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`, extra);
  else console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`);
}
const logDebug = (tag, msg, extra, meta) => log('debug', tag, msg, extra, meta);
const logInfo  = (tag, msg, extra, meta) => log('info',  tag, msg, extra, meta);
const logWarn  = (tag, msg, extra, meta) => log('warn',  tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log('error', tag, msg, extra, meta);

// -----------------------------
// System instructions
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים:
1) דברו בעברית כברירת מחדל, לשון רבים, טון חם וקצר.
2) אם לא הבנת: "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?"
3) תשובות קצרות 1–3 משפטים, וסיימי בשאלה שמקדמת הבנה/איסוף צורך.
4) אל תסיימי שיחה מיוזמתך.
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const kb = (MB_BUSINESS_PROMPT || '').trim();

  let instructions = '';
  if (base) instructions += base;
  if (kb) instructions += (instructions ? '\n\n' : '') + kb;

  if (!instructions) {
    instructions = `
אתם עוזר קולי בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
דברו בעברית כברירת מחדל, תשובות קצרות ומקצועיות.
`.trim();
  }

  return instructions + '\n\n' + EXTRA_BEHAVIOR_RULES;
}

// -----------------------------
// Audio sender (Twilio expects 20ms frames at 8k ulaw = 160 bytes)
// -----------------------------
function createAudioSender(connection, meta) {
  const state = { streamSid: null, timer: null, queue: [] };

  function bindStreamSid(streamSid) {
    state.streamSid = streamSid;
    logInfo('AudioSender', 'Bound sender.streamSid', { streamSid }, meta);
    start();
  }

  function enqueue(buf) {
    if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return;
    state.queue.push(buf);
  }

  function start() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (!state.streamSid) return;
      if (connection.readyState !== WebSocket.OPEN) return;
      if (state.queue.length === 0) return;

      const frameSize = 160; // 20ms @ 8k ulaw
      let cur = state.queue[0];

      if (cur.length <= frameSize) {
        state.queue.shift();
        sendFrame(cur);
      } else {
        const frame = cur.subarray(0, frameSize);
        state.queue[0] = cur.subarray(frameSize);
        sendFrame(frame);
      }
    }, 20);
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.queue = [];
  }

  function sendFrame(frameBuf) {
    try {
      const payloadB64 = frameBuf.toString('base64');
      const msg = { event: 'media', streamSid: state.streamSid, media: { payload: payloadB64 } };
      connection.send(JSON.stringify(msg));
    } catch (e) {
      logError('AudioSender', 'Failed sending frame', e, meta);
    }
  }

  return { bindStreamSid, enqueue, stop };
}

// -----------------------------
// ElevenLabs URL builder (handles v3 restriction)
// -----------------------------
function buildElevenUrl() {
  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}`;
  const qs = new URLSearchParams({
    output_format: ELEVEN_OUTPUT_FORMAT,
    language: ELEVEN_LANGUAGE,
  });

  const isV3 = String(ELEVEN_MODEL).toLowerCase() === 'eleven_v3';
  const shouldAddOpt =
    ELEVEN_ENABLE_OPT_LATENCY &&
    !isV3 &&
    Number.isFinite(ELEVEN_OPTIMIZE_STREAMING_LATENCY) &&
    ELEVEN_OPTIMIZE_STREAMING_LATENCY > 0;

  if (shouldAddOpt) qs.set('optimize_streaming_latency', String(ELEVEN_OPTIMIZE_STREAMING_LATENCY));
  return `${baseUrl}?${qs.toString()}`;
}

async function elevenTtsStreamToSender(text, reason, sender, meta) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return false;
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) {
    logError('ElevenTTS', 'Missing ELEVEN_API_KEY or VOICE_ID', undefined, meta);
    return false;
  }

  const url = buildElevenUrl();
  const body = {
    text: cleaned,
    model_id: ELEVEN_MODEL,
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_SPEAKER_BOOST,
    }
  };

  logInfo('ElevenTTS', 'Streaming text to ElevenLabs TTS.', {
    length: cleaned.length,
    model: ELEVEN_MODEL,
    language: ELEVEN_LANGUAGE,
    format: ELEVEN_OUTPUT_FORMAT,
    reason,
    url_has_opt_latency: url.includes('optimize_streaming_latency')
  }, meta);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError('ElevenTTS', `HTTP ${res.status}`, txt, meta);
      return false;
    }

    if (!res.body) {
      const arr = await res.arrayBuffer();
      const buf = Buffer.from(arr);
      sender.enqueue(buf);
      logWarn('ElevenTTS', 'No streaming body; buffered entire audio.', { bytes: buf.length }, meta);
      return true;
    }

    const reader = res.body.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) {
        const buf = Buffer.from(value);
        total += buf.length;
        sender.enqueue(buf);
      }
    }
    logInfo('ElevenTTS', `Stream done. total=${total} bytes`, undefined, meta);
    return true;
  } catch (e) {
    logError('ElevenTTS', 'Streaming error', e, meta);
    return false;
  }
}

// -----------------------------
// Cached opening audio
// -----------------------------
let OPENING_AUDIO_CACHE = null;

async function warmupOpeningCache() {
  if (!MB_CACHE_OPENING_AUDIO) return;
  if (TTS_PROVIDER !== 'eleven') return;
  if (!ELEVEN_API_KEY || !ELEVEN_VOICE_ID) return;

  try {
    const url = buildElevenUrl();
    const body = {
      text: String(MB_OPENING_SCRIPT || '').trim(),
      model_id: ELEVEN_MODEL,
      voice_settings: {
        stability: ELEVEN_STABILITY,
        similarity_boost: ELEVEN_SIMILARITY,
        style: ELEVEN_STYLE,
        use_speaker_boost: ELEVEN_SPEAKER_BOOST,
      }
    };

    logInfo('Startup', 'Warming opening audio cache with ElevenLabs...', {
      model: ELEVEN_MODEL,
      lang: ELEVEN_LANGUAGE,
      fmt: ELEVEN_OUTPUT_FORMAT,
      len: (MB_OPENING_SCRIPT || '').length,
      url_has_opt_latency: url.includes('optimize_streaming_latency')
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/*',
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logWarn('Startup', `Opening cache warmup failed HTTP ${res.status}`, txt);
      return;
    }

    const arr = await res.arrayBuffer();
    OPENING_AUDIO_CACHE = Buffer.from(arr);
    logInfo('Startup', `Opening audio cached. bytes=${OPENING_AUDIO_CACHE.length}`);
  } catch (e) {
    logWarn('Startup', 'Opening cache warmup error', e);
  }
}

// -----------------------------
// LLM via IVRIT or OpenAI HTTP
// -----------------------------
function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(t) };
}

function pickProvider() {
  // Priority:
  // 1) If MB_LLM_PROVIDER=ivrit and IVRIT_LLM_URL set -> ivrit
  // 2) If IVRIT_LLM_URL set (and provider not forced openai) -> ivrit
  // 3) else -> openai
  const forced = (MB_LLM_PROVIDER || '').toLowerCase();
  if (forced === 'ivrit') return IVRIT_LLM_URL ? 'ivrit' : 'openai';
  if (forced === 'openai') return 'openai';
  if (IVRIT_LLM_URL) return 'ivrit';
  return 'openai';
}

async function llmGenerateReply({ userText, conversationLog, meta }) {
  const provider = pickProvider();
  const system = buildSystemInstructions();

  // Keep a short history window for speed
  const history = (conversationLog || [])
    .slice(-10)
    .map(x => ({ role: x.from === 'user' ? 'user' : 'assistant', text: x.text }));

  if (provider === 'ivrit') {
    const { controller, done } = withTimeout(MB_LLM_TIMEOUT_MS);
    try {
      logInfo('LLM', 'Calling IVRIT LLM endpoint', { url: IVRIT_LLM_URL }, meta);
      const res = await fetch(IVRIT_LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          text: userText,
          system,
          history,
          business_name: BUSINESS_NAME,
          bot_name: BOT_NAME,
        })
      });
      done();

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        logWarn('LLM', `IVRIT HTTP ${res.status}`, t, meta);
        // fallback to openai
      } else {
        const j = await res.json().catch(() => null);
        const out = String(j?.text || j?.output || j?.answer || '').trim();
        if (out) return out;
        logWarn('LLM', 'IVRIT response missing text field', j, meta);
        // fallback to openai
      }
    } catch (e) {
      done();
      logWarn('LLM', 'IVRIT call failed (fallback to OpenAI)', e?.message || e, meta);
      // fallback to openai
    }
  }

  // OpenAI Responses API fallback
  const { controller, done } = withTimeout(MB_LLM_TIMEOUT_MS);
  try {
    const input = [
      { role: 'system', content: system },
      ...history.map(h => ({ role: h.role, content: h.text })),
      { role: 'user', content: userText }
    ];

    logInfo('LLM', 'Calling OpenAI Responses API', { model: MB_LLM_MODEL }, meta);

    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MB_LLM_MODEL,
        input,
        max_output_tokens: MB_LLM_MAX_OUTPUT_TOKENS,
      }),
    });
    done();

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logError('LLM', `OpenAI HTTP ${res.status}`, t, meta);
      return 'לֹא הִצְלַחְתִּי לְהָבִין בָּרֶגַע. אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
    }

    const j = await res.json().catch(() => null);

    // Extract text safely from Responses API
    let out = '';
    if (j?.output && Array.isArray(j.output)) {
      for (const item of j.output) {
        if (item?.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === 'output_text' && c?.text) out += c.text;
          }
        }
      }
    }
    out = String(out || '').trim();
    if (!out) {
      logWarn('LLM', 'OpenAI response had no output_text', j, meta);
      return 'לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
    }
    return out;
  } catch (e) {
    done();
    logError('LLM', 'OpenAI call failed', e?.message || e, meta);
    return 'לֹא הִצְלַחְתִּי לְהָבִין בָּרֶגַע. אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
  }
}

// -----------------------------
// Express
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// minimal http logger
app.use((req, res, next) => {
  const id = crypto.randomBytes(4).toString('hex');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  logInfo('HTTP', `--> [${id}] ${req.method} ${req.url} ip=${ip}`);
  res.on('finish', () => logInfo('HTTP', `<-- [${id}] ${req.method} ${req.url} status=${res.statusCode}`));
  next();
});

app.get('/', (req, res) => res.status(200).send('OK'));

app.post('/twilio-voice', (req, res) => {
  const host = (DOMAIN || req.headers.host || '').replace(/^https?:\/\//, '');
  const wsUrl = MB_TWILIO_STREAM_URL || `wss://${host}/twilio-media-stream`;
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

  res.type('text/xml').send(twiml);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// Call handler
// -----------------------------
wss.on('connection', (connection) => {
  const meta = { rid: rid() };
  logInfo('Call', 'New Twilio Media Stream connection established.', undefined, meta);

  if (!OPENAI_API_KEY) {
    logError('Call', 'OPENAI_API_KEY missing – closing.', undefined, meta);
    try { connection.close(); } catch {}
    return;
  }

  const sender = createAudioSender(connection, meta);

  let streamSid = null;
  let callSid = null;
  let callEnded = false;

  let lastMediaTs = Date.now();
  let noListenUntilTs = 0;
  let botSpeaking = false;

  let idleInterval = null;
  let maxCallTimeout = null;

  const conversationLog = [];
  const pendingUserTexts = [];
  let llmBusy = false;

  function cleanupTimers() {
    if (idleInterval) clearInterval(idleInterval);
    idleInterval = null;
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    maxCallTimeout = null;
  }

  function endCall(reason) {
    if (callEnded) return;
    callEnded = true;

    cleanupTimers();

    logInfo('Call', `endCall reason="${reason}"`, undefined, meta);
    logInfo('Call', 'Final conversation log:', conversationLog, meta);

    try { sender.stop(); } catch {}
    try { if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
    try { if (connection.readyState === WebSocket.OPEN) connection.close(); } catch {}
  }

  async function speak(text, reason) {
    const t = String(text || '').trim();
    if (!t) return;
    conversationLog.push({ from: 'bot', text: t });
    logInfo('Bot', t, undefined, meta);

    if (TTS_PROVIDER === 'eleven') {
      botSpeaking = true;
      await elevenTtsStreamToSender(t, reason, sender, meta);
      botSpeaking = false;
      noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
    }
  }

  async function processQueue(trigger) {
    if (callEnded) return;
    if (llmBusy) return;
    const next = pendingUserTexts.shift();
    if (!next) return;

    llmBusy = true;
    try {
      logInfo('LLM', 'Processing user text', { trigger, textLen: next.length }, meta);
      const reply = await llmGenerateReply({ userText: next, conversationLog, meta });
      await speak(reply, 'llm_reply');
    } finally {
      llmBusy = false;
      // continue
      if (pendingUserTexts.length) processQueue('drain');
    }
  }

  // ---- OpenAI Realtime WS (TRANSCRIPTION ONLY)
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  openAiWs.on('open', () => {
    logInfo('Call', 'Connected to OpenAI Realtime API.', undefined, meta);

    // transcription only
    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['text'], // we don't need audio output
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: MB_VAD_SILENCE_MS,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        }
      }
    }));
  });

  openAiWs.on('close', () => {
    logInfo('Call', 'OpenAI WS closed.', undefined, meta);
    if (!callEnded) endCall('openai_ws_closed');
  });

  openAiWs.on('error', (err) => {
    logError('Call', 'OpenAI WS error', err, meta);
    if (!callEnded) endCall('openai_ws_error');
  });

  openAiWs.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    const type = msg.type;
    logDebug('OpenAI', 'event', { type }, meta);

    if (type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(msg.transcript || '').trim();
      if (!t) return;

      conversationLog.push({ from: 'user', text: t });
      logInfo('User', t, undefined, meta);

      pendingUserTexts.push(t);
      processQueue('transcript_completed');
      return;
    }

    if (type === 'error') {
      logWarn('OpenAI', 'OpenAI error event', { code: msg?.error?.code, message: msg?.error?.message }, meta);
      return;
    }
  });

  // ---- Twilio Media Stream
  connection.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      sender.bindStreamSid(streamSid);
      lastMediaTs = Date.now();

      logInfo('Call', `Twilio stream started. streamSid=${streamSid}, callSid=${callSid}`, undefined, meta);

      // Opening immediately
      conversationLog.push({ from: 'bot', text: MB_OPENING_SCRIPT });

      if (TTS_PROVIDER === 'eleven') {
        if (OPENING_AUDIO_CACHE && OPENING_AUDIO_CACHE.length) {
          logInfo('Opening', 'Playing cached opening audio.', { bytes: OPENING_AUDIO_CACHE.length }, meta);
          sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
        } else {
          logInfo('Opening', 'No cache; streaming opening from Eleven now.', undefined, meta);
          await elevenTtsStreamToSender(MB_OPENING_SCRIPT, 'opening_greeting', sender, meta);
        }
      }

      // Idle hangup timer
      if (idleInterval) clearInterval(idleInterval);
      idleInterval = setInterval(() => {
        if (callEnded) return;
        const since = Date.now() - lastMediaTs;
        if (since > MB_IDLE_HANGUP_MS) {
          logInfo('Call', 'Idle hangup.', { sinceMs: since }, meta);
          endCall('idle_timeout');
        }
      }, 1000);

      // Max duration
      if (MB_MAX_CALL_MS > 0) {
        if (maxCallTimeout) clearTimeout(maxCallTimeout);
        maxCallTimeout = setTimeout(() => {
          if (!callEnded) endCall('max_call_duration');
        }, MB_MAX_CALL_MS);
      }

      return;
    }

    if (msg.event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;

      if (openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      if (!MB_ALLOW_BARGE_IN) {
        if (botSpeaking || now < noListenUntilTs) return;
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      return;
    }

    if (msg.event === 'stop') {
      logInfo('Call', 'Twilio stream stopped.', undefined, meta);
      if (!callEnded) endCall('twilio_stop');
      return;
    }
  });

  connection.on('close', () => {
    logInfo('Call', 'Twilio WS closed.', undefined, meta);
    if (!callEnded) endCall('twilio_ws_closed');
  });

  connection.on('error', (err) => {
    logError('Call', 'Twilio WS error', err, meta);
    if (!callEnded) endCall('twilio_ws_error');
  });
});

// -----------------------------
// Start
// -----------------------------
server.listen(PORT, async () => {
  console.log(`✅ BluBinet Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  await warmupOpeningCache();
});
