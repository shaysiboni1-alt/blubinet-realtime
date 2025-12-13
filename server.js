// server.js
//
// BluBinet Voice Bot – "נטע"
// Twilio Media Streams -> OpenAI Realtime (TRANSCRIPTION ONLY)
// LLM via HTTP (OpenAI Responses) OR IVRIT endpoint (fallback by ENV)
// TTS via ElevenLabs (ulaw_8000 streamed in 20ms frames)
//
// Improvements for "10s silence":
// - Immediate ACK (short phrase) as soon as we have transcript, before LLM starts
// - Prefer Eleven /stream endpoint to reduce time-to-first-byte (TTFB)
// - Better timing logs: LLM_ms, TTS_first_byte_ms, TTS_total_ms
// - Pad frames + tail silence to prevent cut-offs
//

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

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
// ENV
// -----------------------------
const PORT = envNumber('PORT', 3000);
const DOMAIN = envStr('DOMAIN', '');
const MB_TWILIO_STREAM_URL = envStr('MB_TWILIO_STREAM_URL', '');

const OPENAI_API_KEY = envStr('OPENAI_API_KEY', '');
const OPENAI_REALTIME_MODEL = envStr('OPENAI_REALTIME_MODEL', 'gpt-4o-realtime-preview-2024-12-17');

const MB_LLM_PROVIDER = envStr('MB_LLM_PROVIDER', '').toLowerCase(); // "ivrit"|"openai"|"" (auto)
const MB_LLM_MODEL = envStr('MB_LLM_MODEL', 'gpt-4o-mini');
const MB_LLM_MAX_OUTPUT_TOKENS = envNumber('MB_LLM_MAX_OUTPUT_TOKENS', 120);
const MB_LLM_TIMEOUT_MS = envNumber('MB_LLM_TIMEOUT_MS', 6500);

const IVRIT_LLM_URL = envStr('IVRIT_LLM_URL', '');

const BOT_NAME = envStr('MB_BOT_NAME', 'נטע');
const BUSINESS_NAME = envStr('MB_BUSINESS_NAME', 'BluBinet');

const MB_OPENING_SCRIPT = envStr(
  'MB_OPENING_SCRIPT',
  'צהריים טובים, הגעתם ל־BluBinet. שמי נטע, איך אפשר לעזור לכם היום?'
);
const MB_GENERAL_PROMPT = envStr('MB_GENERAL_PROMPT', '');
const MB_BUSINESS_PROMPT = envStr('MB_BUSINESS_PROMPT', '');

const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.75);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 700);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 150);

const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', false);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 120000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 10 * 60 * 1000);

const MB_TTS_TAIL_SILENCE_MS = envNumber('MB_TTS_TAIL_SILENCE_MS', 260);
const MB_CACHE_OPENING_AUDIO = envBool('MB_CACHE_OPENING_AUDIO', true);

// ACK (the key for perceived speed)
const MB_ACK_ENABLED = envBool('MB_ACK_ENABLED', true);
const MB_ACK_TEXT = envStr('MB_ACK_TEXT', 'מעולה, רגע...');

// Logging
const MB_LOG_LEVEL = envStr('MB_LOG_LEVEL', 'info').toLowerCase();

// -----------------------------
// ElevenLabs
// -----------------------------
const TTS_PROVIDER = envStr('TTS_PROVIDER', 'eleven').toLowerCase();
const ELEVEN_API_KEY = envStr('ELEVEN_API_KEY', envStr('ELEVENLABS_API_KEY', ''));
const ELEVEN_VOICE_ID = envStr('ELEVEN_VOICE_ID', envStr('VOICE_ID', ''));
const ELEVEN_MODEL = envStr('ELEVEN_TTS_MODEL', 'eleven_v3');
const ELEVEN_LANGUAGE = envStr('ELEVENLABS_LANGUAGE', envStr('ELEVEN_LANGUAGE', 'he'));
const ELEVEN_OUTPUT_FORMAT = envStr('ELEVEN_OUTPUT_FORMAT', 'ulaw_8000');
const ELEVEN_ENABLE_STREAM_ENDPOINT = envBool('ELEVEN_ENABLE_STREAM_ENDPOINT', true); // <--- NEW
const ELEVEN_OPTIMIZE_STREAMING_LATENCY = envNumber('ELEVEN_OPTIMIZE_STREAMING_LATENCY', 3);
const ELEVEN_ENABLE_OPT_LATENCY = envBool('ELEVEN_ENABLE_OPT_LATENCY', true);

const ELEVEN_STABILITY = envNumber('ELEVEN_STABILITY', 0.5);
const ELEVEN_SIMILARITY = envNumber('ELEVEN_SIMILARITY', 0.75);
const ELEVEN_STYLE = envNumber('ELEVEN_STYLE', 0.0);
const ELEVEN_SPEAKER_BOOST = envBool('ELEVEN_SPEAKER_BOOST', true);

// -----------------------------
// Logging helpers
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
  const ridPart = meta?.rid ? ` { rid: '${meta.rid}' }` : '';
  if (extra !== undefined) console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`, extra);
  else console.log(`[${ts}][${lvl.toUpperCase()}][${tag}] ${msg}${ridPart}`);
}
const logDebug = (tag, msg, extra, meta) => log('debug', tag, msg, extra, meta);
const logInfo  = (tag, msg, extra, meta) => log('info',  tag, msg, extra, meta);
const logWarn  = (tag, msg, extra, meta) => log('warn',  tag, msg, extra, meta);
const logError = (tag, msg, extra, meta) => log('error', tag, msg, extra, meta);

// -----------------------------
// Audio utils
// -----------------------------
const FRAME_BYTES = 160;
const ULAW_SILENCE_BYTE = 0xff;

function padToFrame(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) return buf;
  const mod = buf.length % FRAME_BYTES;
  if (mod === 0) return buf;
  const pad = FRAME_BYTES - mod;
  return Buffer.concat([buf, Buffer.alloc(pad, ULAW_SILENCE_BYTE)]);
}
function makeTailSilence(ms) {
  const frames = Math.max(1, Math.round(ms / 20));
  return Buffer.alloc(frames * FRAME_BYTES, ULAW_SILENCE_BYTE);
}
function estAudioSeconds(bytes) {
  return Math.round((bytes / 8000) * 100) / 100;
}

// -----------------------------
// Instructions
// -----------------------------
const EXTRA_RULES = `
חוקי מערכת:
1) עברית כברירת מחדל, לשון רבים, קצר ומהיר.
2) תשובה קצרה מאוד (משפט 1–2), ואז שאלה אחת קצרה.
3) אם לא הבנת: "לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?"
`.trim();

function buildSystemInstructions() {
  const base = (MB_GENERAL_PROMPT || '').trim();
  const kb = (MB_BUSINESS_PROMPT || '').trim();
  let s = '';
  if (base) s += base;
  if (kb) s += (s ? '\n\n' : '') + kb;
  if (!s) {
    s = `אתם עוזר קולי בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".`;
  }
  return s + '\n\n' + EXTRA_RULES;
}

// -----------------------------
// Twilio audio sender
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

      const cur = state.queue[0];
      if (cur.length <= FRAME_BYTES) {
        state.queue.shift();
        sendFrame(cur);
      } else {
        const frame = cur.subarray(0, FRAME_BYTES);
        state.queue[0] = cur.subarray(FRAME_BYTES);
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
      connection.send(JSON.stringify({
        event: 'media',
        streamSid: state.streamSid,
        media: { payload: payloadB64 }
      }));
    } catch (e) {
      logError('AudioSender', 'Failed sending frame', e, meta);
    }
  }

  return { bindStreamSid, enqueue, stop };
}

// -----------------------------
// Eleven URL builder (prefer /stream)
// -----------------------------
function buildElevenUrl() {
  const isV3 = String(ELEVEN_MODEL).toLowerCase() === 'eleven_v3';
  const path = ELEVEN_ENABLE_STREAM_ENDPOINT ? 'stream' : ''; // /stream reduces TTFB in many cases
  const baseUrl = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}${path ? `/${path}` : ''}`;

  const qs = new URLSearchParams({
    output_format: ELEVEN_OUTPUT_FORMAT,
    language: ELEVEN_LANGUAGE,
  });

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
  if (!cleaned) return { ok: false, bytes: 0 };

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

  logInfo('ElevenTTS', 'TTS request', {
    reason,
    length: cleaned.length,
    model: ELEVEN_MODEL,
    lang: ELEVEN_LANGUAGE,
    fmt: ELEVEN_OUTPUT_FORMAT,
    url
  }, meta);

  const t0 = Date.now();
  let firstByteMs = null;

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
      return { ok: false, bytes: 0 };
    }

    let total = 0;

    if (!res.body) {
      const arr = await res.arrayBuffer();
      let buf = Buffer.from(arr);
      buf = padToFrame(buf);
      total = buf.length;
      sender.enqueue(buf);
      firstByteMs = Date.now() - t0;
    } else {
      const reader = res.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          if (firstByteMs === null) firstByteMs = Date.now() - t0;
          const buf = Buffer.from(value);
          total += buf.length;
          sender.enqueue(buf);
        }
      }
    }

    // Tail silence prevents last-syllable cutoffs
    sender.enqueue(makeTailSilence(MB_TTS_TAIL_SILENCE_MS));

    const totalMs = Date.now() - t0;
    logInfo('ElevenTTS', 'TTS done', {
      firstByteMs,
      totalMs,
      bytes: total,
      approxSeconds: estAudioSeconds(total)
    }, meta);

    return { ok: true, bytes: total, firstByteMs, totalMs };
  } catch (e) {
    logError('ElevenTTS', 'TTS error', e?.message || e, meta);
    return { ok: false, bytes: 0 };
  }
}

// -----------------------------
// Opening cache
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

    logInfo('Startup', 'Warming opening cache', { url, len: (MB_OPENING_SCRIPT || '').length });

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
      logWarn('Startup', `Opening cache warmup failed HTTP ${res.status}`, txt);
      return;
    }

    const arr = await res.arrayBuffer();
    let buf = Buffer.from(arr);
    buf = padToFrame(buf);
    buf = Buffer.concat([buf, makeTailSilence(MB_TTS_TAIL_SILENCE_MS)]);
    OPENING_AUDIO_CACHE = buf;

    logInfo('Startup', 'Opening cached', {
      bytes: OPENING_AUDIO_CACHE.length,
      approxSeconds: estAudioSeconds(OPENING_AUDIO_CACHE.length)
    });
  } catch (e) {
    logWarn('Startup', 'Opening cache warmup error', e?.message || e);
  }
}

// -----------------------------
// LLM
// -----------------------------
function withTimeout(ms) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return { controller, done: () => clearTimeout(t) };
}
function pickProvider() {
  const forced = (MB_LLM_PROVIDER || '').toLowerCase();
  if (forced === 'ivrit') return IVRIT_LLM_URL ? 'ivrit' : 'openai';
  if (forced === 'openai') return 'openai';
  if (IVRIT_LLM_URL) return 'ivrit';
  return 'openai';
}

async function llmGenerateReply({ userText, conversationLog, meta }) {
  const provider = pickProvider();
  const system = buildSystemInstructions();
  const history = (conversationLog || []).slice(-8).map(x => ({
    role: x.from === 'user' ? 'user' : 'assistant',
    text: x.text
  }));

  if (provider === 'ivrit') {
    const { controller, done } = withTimeout(MB_LLM_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      logInfo('LLM', 'Calling IVRIT', { url: IVRIT_LLM_URL }, meta);
      const res = await fetch(IVRIT_LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ text: userText, system, history, business_name: BUSINESS_NAME, bot_name: BOT_NAME })
      });
      done();
      const ms = Date.now() - t0;

      if (res.ok) {
        const j = await res.json().catch(() => null);
        const out = String(j?.text || j?.output || j?.answer || '').trim();
        logInfo('LLM', `IVRIT ok ms=${ms}`, { len: out.length }, meta);
        if (out) return out;
      } else {
        logWarn('LLM', `IVRIT HTTP ${res.status} ms=${ms}`, await res.text().catch(() => ''), meta);
      }
    } catch (e) {
      done();
      logWarn('LLM', 'IVRIT failed -> fallback OpenAI', e?.message || e, meta);
    }
  }

  const { controller, done } = withTimeout(MB_LLM_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    logInfo('LLM', 'Calling OpenAI Responses', { model: MB_LLM_MODEL }, meta);
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MB_LLM_MODEL,
        input: [
          { role: 'system', content: system },
          ...history.map(h => ({ role: h.role, content: h.text })),
          { role: 'user', content: userText }
        ],
        max_output_tokens: MB_LLM_MAX_OUTPUT_TOKENS,
      }),
    });
    done();
    const ms = Date.now() - t0;

    if (!res.ok) {
      logError('LLM', `OpenAI HTTP ${res.status} ms=${ms}`, await res.text().catch(() => ''), meta);
      return 'לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
    }

    const j = await res.json().catch(() => null);

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
    logInfo('LLM', `OpenAI ok ms=${ms}`, { len: out.length }, meta);

    return out || 'לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
  } catch (e) {
    done();
    logError('LLM', 'OpenAI failed', e?.message || e, meta);
    return 'לֹא שָׁמַעְתִּי טוֹב, אֶפְשָׁר לַחֲזוֹר עַל זֶה?';
  }
}

// -----------------------------
// Express + Twilio webhook
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

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
// Call handling
// -----------------------------
wss.on('connection', (connection) => {
  const meta = { rid: rid() };
  logInfo('Call', 'New Twilio Media Stream connection established.', undefined, meta);

  const sender = createAudioSender(connection, meta);
  const conversationLog = [];
  const pendingUserTexts = [];
  let llmBusy = false;
  let botSpeaking = false;
  let noListenUntilTs = 0;

  let streamSid = null;
  let callEnded = false;
  let lastMediaTs = Date.now();
  let idleInterval = null;
  let maxCallTimeout = null;

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
    try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
    try { if (connection.readyState === WebSocket.OPEN) connection.close(); } catch {}
  }

  async function speak(text, reason) {
    const t = String(text || '').trim();
    if (!t) return;

    conversationLog.push({ from: 'bot', text: t });
    logInfo('Bot', t, undefined, meta);

    botSpeaking = true;
    await elevenTtsStreamToSender(t, reason, sender, meta);
    botSpeaking = false;
    noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
  }

  async function processQueue(trigger) {
    if (callEnded) return;
    if (llmBusy) return;
    const next = pendingUserTexts.shift();
    if (!next) return;

    llmBusy = true;

    // Immediate ACK to eliminate silence
    if (MB_ACK_ENABLED) {
      logInfo('ACK', 'Speaking immediate ack', { text: MB_ACK_TEXT }, meta);
      await speak(MB_ACK_TEXT, 'ack');
    }

    try {
      const t0 = Date.now();
      const reply = await llmGenerateReply({ userText: next, conversationLog, meta });
      const llmMs = Date.now() - t0;
      logInfo('LLM', 'Reply ready', { llmMs }, meta);
      await speak(reply, 'llm_reply');
    } finally {
      llmBusy = false;
      if (pendingUserTexts.length) processQueue('drain');
    }
  }

  // ---- OpenAI Realtime (TRANSCRIPTION ONLY)
  const openAiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      }
    }
  );

  openAiWs.on('open', () => {
    logInfo('Call', 'Connected to OpenAI Realtime API.', undefined, meta);
    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        model: OPENAI_REALTIME_MODEL,
        modalities: ['text'],
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
    if (msg.type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(msg.transcript || '').trim();
      if (!t) return;
      conversationLog.push({ from: 'user', text: t });
      logInfo('User', t, undefined, meta);

      pendingUserTexts.push(t);
      processQueue('transcript_completed');
    }
  });

  // ---- Twilio Media Stream
  connection.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || null;
      sender.bindStreamSid(streamSid);
      lastMediaTs = Date.now();

      logInfo('Call', `Twilio stream started. streamSid=${streamSid}`, undefined, meta);

      // Opening immediately
      conversationLog.push({ from: 'bot', text: MB_OPENING_SCRIPT });
      if (OPENING_AUDIO_CACHE && OPENING_AUDIO_CACHE.length) {
        logInfo('Opening', 'Playing cached opening', { bytes: OPENING_AUDIO_CACHE.length, approxSeconds: estAudioSeconds(OPENING_AUDIO_CACHE.length) }, meta);
        sender.enqueue(Buffer.from(OPENING_AUDIO_CACHE));
      } else {
        await elevenTtsStreamToSender(MB_OPENING_SCRIPT, 'opening', sender, meta);
      }

      idleInterval = setInterval(() => {
        if (callEnded) return;
        const since = Date.now() - lastMediaTs;
        if (since > MB_IDLE_HANGUP_MS) {
          logInfo('Call', 'Idle hangup', { sinceMs: since }, meta);
          endCall('idle_timeout');
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
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
    }
  });

  connection.on('close', () => {
    logInfo('Call', 'Twilio WS closed.', undefined, meta);
    if (!callEnded) endCall('twilio_ws_closed');
  });
});

// -----------------------------
// Start
// -----------------------------
server.listen(PORT, async () => {
  console.log(`✅ BluBinet Voice Bot running on port ${PORT} (TTS_PROVIDER=${TTS_PROVIDER})`);
  await warmupOpeningCache();
});
