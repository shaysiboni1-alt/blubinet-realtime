// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (gpt-4o-realtime-preview-2024-12-17)
//
// מטרות בקובץ הזה:
// 1) לעבוד בדיוק עם Twilio Media Streams כרגיל (POST /twilio-voice -> <Connect><Stream>)
// 2) להוסיף ALWAYS-LOGGING: לוג לכל בקשה, לוג ל-404, לוג לכל חריגה, כדי שלא יהיה "אין לוגים".
// 3) להוסיף GET /health + GET /twilio-voice כדי שתוכל לבדוק בדפדפן ולקבל לוגים.

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

// -----------------------------
// HARD LOGGING (always)
// -----------------------------
function nowIso() {
  return new Date().toISOString();
}
function rid() {
  return crypto.randomBytes(6).toString('hex');
}
function safeJson(x) {
  try { return JSON.stringify(x); } catch { return String(x); }
}

const LOG_LEVEL = (process.env.MB_LOG_LEVEL || 'info').toLowerCase(); // debug|info|warn|error
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function lvlOk(l) {
  return (LEVELS[l] || 20) >= (LEVELS[LOG_LEVEL] || 20);
}

function log(level, tag, msg, extra) {
  const base = `[${nowIso()}][${level.toUpperCase()}][${tag}] ${msg}`;
  if (extra !== undefined) {
    console.log(base, extra);
  } else {
    console.log(base);
  }
}
const logDebug = (tag, msg, extra) => { if (!lvlOk('debug')) return; log('debug', tag, msg, extra); };
const logInfo  = (tag, msg, extra) => { if (!lvlOk('info')) return;  log('info',  tag, msg, extra); };
const logWarn  = (tag, msg, extra) => { if (!lvlOk('warn')) return;  log('warn',  tag, msg, extra); };
const logError = (tag, msg, extra) => { log('error', tag, msg, extra); };

// Catch-all crashes
process.on('uncaughtException', (err) => {
  logError('FATAL', 'uncaughtException', err?.stack || err);
});
process.on('unhandledRejection', (reason) => {
  logError('FATAL', 'unhandledRejection', reason);
});

// -----------------------------
// ENV helpers
// -----------------------------
function envNumber(name, def) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def = false) {
  const raw = (process.env[name] || '').toLowerCase();
  if (!raw) return def;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// -----------------------------
// Core ENV config
// -----------------------------
const PORT = envNumber('PORT', 3000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) logError('CONFIG', '❌ Missing OPENAI_API_KEY in ENV.');

const BOT_NAME = process.env.MB_BOT_NAME || 'נטע';
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || 'BluBinet';

const MB_OPENING_SCRIPT =
  process.env.MB_OPENING_SCRIPT ||
  'שלום, הגעתם ל-BluBinet – פתרונות טלפוניה חכמים בענן לעסקים. שמי נטע, איך אפשר לעזור לכם היום?';

const MB_CLOSING_SCRIPT =
  process.env.MB_CLOSING_SCRIPT ||
  'תודה שדיברתם עם BluBinet. נציג יחזור אליכם בהקדם. יום נעים!';

const MB_GENERAL_PROMPT = process.env.MB_GENERAL_PROMPT || '';
const MB_BUSINESS_PROMPT = process.env.MB_BUSINESS_PROMPT || '';

const MB_LANGUAGES = (process.env.MB_LANGUAGES || 'he,en,ru,ar')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const OPENAI_VOICE = process.env.OPENAI_VOICE || 'alloy';

// Max output tokens (number or "inf")
const MAX_OUTPUT_TOKENS_ENV = process.env.MAX_OUTPUT_TOKENS;
let MAX_OUTPUT_TOKENS = 'inf';
if (MAX_OUTPUT_TOKENS_ENV) {
  const n = Number(MAX_OUTPUT_TOKENS_ENV);
  if (Number.isFinite(n) && n > 0) MAX_OUTPUT_TOKENS = n;
  else if (MAX_OUTPUT_TOKENS_ENV === 'inf') MAX_OUTPUT_TOKENS = 'inf';
}

// VAD
const MB_VAD_THRESHOLD = envNumber('MB_VAD_THRESHOLD', 0.65);
const MB_VAD_SILENCE_MS = envNumber('MB_VAD_SILENCE_MS', 900);
const MB_VAD_PREFIX_MS = envNumber('MB_VAD_PREFIX_MS', 200);
const MB_VAD_SUFFIX_MS = envNumber('MB_VAD_SUFFIX_MS', 200);

// Idle / Duration
const MB_IDLE_WARNING_MS = envNumber('MB_IDLE_WARNING_MS', 40000);
const MB_IDLE_HANGUP_MS = envNumber('MB_IDLE_HANGUP_MS', 90000);
const MB_MAX_CALL_MS = envNumber('MB_MAX_CALL_MS', 5 * 60 * 1000);
const MB_MAX_WARN_BEFORE_MS = envNumber('MB_MAX_WARN_BEFORE_MS', 45000);
const MB_HANGUP_GRACE_MS = envNumber('MB_HANGUP_GRACE_MS', 3000);

const MB_ALLOW_BARGE_IN = envBool('MB_ALLOW_BARGE_IN', true);
const MB_NO_BARGE_TAIL_MS = envNumber('MB_NO_BARGE_TAIL_MS', 900);

// Lead webhook
const MB_ENABLE_LEAD_CAPTURE = envBool('MB_ENABLE_LEAD_CAPTURE', false);
const MB_WEBHOOK_URL = process.env.MB_WEBHOOK_URL || '';
const MB_ENABLE_SMART_LEAD_PARSING = envBool('MB_ENABLE_SMART_LEAD_PARSING', true);
const MB_LEAD_PARSING_MODEL = process.env.MB_LEAD_PARSING_MODEL || 'gpt-4.1-mini';

// Twilio creds
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Dynamic KB
const MB_DYNAMIC_KB_URL = process.env.MB_DYNAMIC_KB_URL || '';
let dynamicBusinessPrompt = '';
let lastDynamicKbRefreshAt = 0;
const MB_DYNAMIC_KB_MIN_INTERVAL_MS = envNumber('MB_DYNAMIC_KB_MIN_INTERVAL_MS', 5 * 60 * 1000);

logInfo('CONFIG', `PORT=${PORT}`);
logInfo('CONFIG', `MB_ALLOW_BARGE_IN=${MB_ALLOW_BARGE_IN}, MB_NO_BARGE_TAIL_MS=${MB_NO_BARGE_TAIL_MS}ms, MB_LANGUAGES=${MB_LANGUAGES.join(',')}`);
logInfo('CONFIG', `OPENAI_VOICE=${OPENAI_VOICE}, MAX_OUTPUT_TOKENS=${MAX_OUTPUT_TOKENS}`);
logInfo('CONFIG', `VAD threshold=${MB_VAD_THRESHOLD}, silence=${MB_VAD_SILENCE_MS}+${MB_VAD_SUFFIX_MS}, prefix=${MB_VAD_PREFIX_MS}`);
logInfo('CONFIG', `DynamicKB url=${MB_DYNAMIC_KB_URL ? 'SET' : 'EMPTY'}, minInterval=${MB_DYNAMIC_KB_MIN_INTERVAL_MS}ms`);

// -----------------------------
// Dynamic KB refresh
// -----------------------------
async function refreshDynamicBusinessPrompt(tag = 'DynamicKB') {
  if (!MB_DYNAMIC_KB_URL) {
    logDebug(tag, 'MB_DYNAMIC_KB_URL empty – skip.');
    return;
  }
  const now = Date.now();
  if (tag !== 'Startup' && now - lastDynamicKbRefreshAt < MB_DYNAMIC_KB_MIN_INTERVAL_MS) {
    logInfo(tag, `Skip refresh – refreshed ${now - lastDynamicKbRefreshAt}ms ago (min ${MB_DYNAMIC_KB_MIN_INTERVAL_MS}ms).`);
    return;
  }
  try {
    const res = await fetch(MB_DYNAMIC_KB_URL);
    if (!res.ok) {
      logError(tag, `Failed to fetch dynamic KB. HTTP ${res.status}`);
      return;
    }
    const text = (await res.text()).trim();
    dynamicBusinessPrompt = text;
    lastDynamicKbRefreshAt = Date.now();
    logInfo(tag, `Dynamic KB loaded. length=${text.length}`);
  } catch (err) {
    logError(tag, 'Error fetching dynamic KB', err?.stack || err);
  }
}

// -----------------------------
// Closing normalize
// -----------------------------
function normalizeForClosing(text) {
  return (text || '')
    .toLowerCase()
    .replace(/["'״׳]/g, '')
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const NORMALIZED_CLOSING_SCRIPT = normalizeForClosing(MB_CLOSING_SCRIPT);

// -----------------------------
// System instructions builder
// -----------------------------
const EXTRA_BEHAVIOR_RULES = `
חוקי מערכת קבועים (גבוהים מהפרומפט העסקי):
1. אל תתייחסי למוזיקה, רעשים או איכות הקו. אם לא הבנת – בקשי לחזור בקצרה.
2. אל תסיימי שיחה לבד בגלל מילים כמו "תודה" / "זהו". סיום רק לפי ההנחיות הטכניות.
3. כשמתבקשת לסיים – אמרי את משפט הסיום המדויק בלבד.
4. תשובות קצרות (2–3 משפטים) אלא אם ביקשו פירוט.
5. לפני סיום טבעי – שאלי: "לפני שאני מסיימת, יש עוד משהו שתרצו או שהכול ברור?".
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
דברו בטון נעים, מקצועי וקצר. ברירת מחדל עברית, התאמה ללקוח.
`.trim();
  }

  instructions += '\n\n' + EXTRA_BEHAVIOR_RULES;
  return instructions;
}

// -----------------------------
// Phone normalize
// -----------------------------
function normalizePhoneNumber(rawPhone, callerNumber) {
  function toDigits(num) {
    if (!num) return null;
    return String(num).replace(/\D/g, '');
  }
  function normalize972(digits) {
    if (digits.startsWith('972') && (digits.length === 11 || digits.length === 12)) {
      return '0' + digits.slice(3);
    }
    return digits;
  }
  function isValidIsraeliPhone(digits) {
    if (!/^0\d{8,9}$/.test(digits)) return false;
    const p2 = digits.slice(0, 2);
    if (digits.length === 9) return ['02','03','04','07','08','09'].includes(p2);
    if (p2 === '05' || p2 === '07') return true;
    return ['02','03','04','07','08','09'].includes(p2);
  }
  function clean(num) {
    let digits = toDigits(num);
    if (!digits) return null;
    digits = normalize972(digits);
    if (!isValidIsraeliPhone(digits)) return null;
    return digits;
  }
  return clean(rawPhone) || clean(callerNumber) || null;
}

// -----------------------------
// Express
// -----------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: '1mb' }));

// Always log every HTTP request
app.use((req, res, next) => {
  const requestId = rid();
  req.__rid = requestId;

  const start = Date.now();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  logInfo('HTTP', `--> [${requestId}] ${req.method} ${req.originalUrl} ip=${ip}`);

  res.on('finish', () => {
    const ms = Date.now() - start;
    logInfo('HTTP', `<-- [${requestId}] ${req.method} ${req.originalUrl} status=${res.statusCode} ${ms}ms`);
  });

  next();
});

// Health endpoint (browser)
app.get('/health', (req, res) => {
  logInfo('HEALTH', `Health check OK. rid=${req.__rid}`);
  res.status(200).json({
    ok: true,
    service: 'blubinet-realtime',
    time: nowIso(),
    tts_provider: process.env.TTS_PROVIDER || 'openai',
    has_openai_key: !!OPENAI_API_KEY,
    has_dynamic_kb: !!MB_DYNAMIC_KB_URL
  });
});

// Browser-friendly Twilio endpoint (GET)
app.get('/twilio-voice', (req, res) => {
  logInfo('Twilio-Voice', `GET /twilio-voice (browser test). rid=${req.__rid}`);
  res
    .status(200)
    .type('text/plain')
    .send(
      [
        'OK. This endpoint is meant for Twilio (HTTP POST).',
        'If you see this in browser, the service is reachable.',
        '',
        'Use POST /twilio-voice from Twilio Voice Webhook.',
        'You can also check GET /health.'
      ].join('\n')
    );
});

// Twilio Voice webhook – POST returns TwiML that connects to Media Streams
app.post('/twilio-voice', (req, res) => {
  const host = process.env.DOMAIN || req.headers.host;
  const wsUrl =
    process.env.MB_TWILIO_STREAM_URL ||
    `wss://${String(host).replace(/^https?:\/\//, '')}/twilio-media-stream`;

  const caller = req.body.From || '';
  const callSid = req.body.CallSid || '';
  logInfo('Twilio-Voice', `POST /twilio-voice From=${caller} CallSid=${callSid} wsUrl=${wsUrl}`);

  const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="caller" value="${caller}"/>
      <Parameter name="callsid" value="${callSid}"/>
    </Stream>
  </Connect>
</Response>`.trim();

  res.type('text/xml').send(twiml);
});

// 404 logger (so "no logs" never happens on wrong path)
app.use((req, res) => {
  logWarn('HTTP', `404 Not Found: ${req.method} ${req.originalUrl} rid=${req.__rid}`);
  res.status(404).json({ ok: false, error: 'not_found', path: req.originalUrl });
});

// Express error handler
app.use((err, req, res, next) => {
  logError('HTTP', `Express error rid=${req?.__rid}`, err?.stack || err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

// -----------------------------
// HTTP server + WS
// -----------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/twilio-media-stream' });

// -----------------------------
// OpenAI lead parsing helper
// -----------------------------
async function extractLeadFromConversation(conversationLog) {
  const tag = 'LeadParse';

  if (!MB_ENABLE_SMART_LEAD_PARSING) return null;
  if (!OPENAI_API_KEY) return null;
  if (!Array.isArray(conversationLog) || conversationLog.length === 0) return null;

  try {
    const conversationText = conversationLog
      .map((m) => `${m.from === 'user' ? 'לקוח' : BOT_NAME}: ${m.text}`)
      .join('\n');

    const systemPrompt = `
החזר JSON אחד בלבד לפי הסכמה:
{
  "is_lead": boolean,
  "lead_type": "new" | "existing" | "unknown",
  "full_name": string | null,
  "business_name": string | null,
  "phone_number": string | null,
  "reason": string | null,
  "notes": string | null
}
החזר אך ורק JSON תקין, בלי טקסט נוסף.
`.trim();

    const userPrompt = `
תמלול:
${conversationText}
`.trim();

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MB_LEAD_PARSING_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logError(tag, `OpenAI lead parsing HTTP ${response.status}`, text);
      return null;
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return null;

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return null;

    logInfo(tag, 'Lead parsed successfully.', parsed);
    return parsed;
  } catch (err) {
    logError(tag, 'Error in extractLeadFromConversation', err?.stack || err);
    return null;
  }
}

// -----------------------------
// Twilio hangup + fetch caller
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
          'Basic ' +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      logError(tag, `Twilio hangup HTTP ${res.status}`, txt);
    } else {
      logInfo(tag, 'Twilio call hangup requested successfully.');
    }
  } catch (err) {
    logError(tag, 'Error calling Twilio hangup API', err?.stack || err);
  }
}

async function fetchCallerNumberFromTwilio(callSid, tag = 'Call') {
  if (!callSid) return null;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
      }
    });

    if (!res.ok) return null;
    const data = await res.json();
    const fromRaw = data.from || data.caller_name || null;
    logInfo(tag, `fetchCallerNumberFromTwilio: resolved caller="${fromRaw}"`);
    return fromRaw;
  } catch (err) {
    logError(tag, 'fetchCallerNumberFromTwilio error', err?.stack || err);
    return null;
  }
}

// -----------------------------
// Per-call handler (Twilio WS)
// -----------------------------
wss.on('connection', (connection, req) => {
  const tag = 'Call';
  const callRid = rid();
  logInfo(tag, `New Twilio Media Stream WS connected. rid=${callRid}`);

  if (!OPENAI_API_KEY) {
    logError(tag, `OPENAI_API_KEY missing – closing WS. rid=${callRid}`);
    connection.close();
    return;
  }

  // Keepalive ping to prevent idle proxies killing WS silently
  const keepAlive = setInterval(() => {
    try {
      if (connection.readyState === WebSocket.OPEN) connection.ping();
    } catch {}
  }, 15000);

  const instructions = buildSystemInstructions();
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  let conversationLog = [];
  let currentBotText = '';
  let callStartTs = Date.now();
  let lastMediaTs = Date.now();
  let idleCheckInterval = null;
  let idleWarningSent = false;
  let idleHangupScheduled = false;
  let maxCallTimeout = null;
  let maxCallWarningTimeout = null;
  let pendingHangup = null;
  let openAiReady = false;
  let twilioClosed = false;
  let openAiClosed = false;
  let callEnded = false;

  let botSpeaking = false;
  let hasActiveResponse = false;
  let botTurnActive = false;
  let noListenUntilTs = 0;

  let leadWebhookSent = false;

  function checkBotClosing(botText) {
    if (!botText || !NORMALIZED_CLOSING_SCRIPT) return;
    const norm = normalizeForClosing(botText);
    if (!norm) return;
    if (norm.includes(NORMALIZED_CLOSING_SCRIPT) || NORMALIZED_CLOSING_SCRIPT.includes(norm)) {
      logInfo(tag, `Detected configured bot closing phrase. rid=${callRid}`);
      scheduleHangupAfterBotClosing('bot_closing_config');
    }
  }

  function sendModelPrompt(text, purpose) {
    if (openAiWs.readyState !== WebSocket.OPEN) {
      logWarn(tag, `Cannot send model prompt (${purpose}) – OpenAI WS not open. rid=${callRid}`);
      return;
    }
    if (hasActiveResponse) {
      logDebug(tag, `Skip model prompt (${purpose}) – hasActiveResponse=true. rid=${callRid}`);
      return;
    }

    const item = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      }
    };

    openAiWs.send(JSON.stringify(item));
    openAiWs.send(JSON.stringify({ type: 'response.create' }));

    hasActiveResponse = true;
    botTurnActive = true;
    logInfo(tag, `Sending model prompt (${purpose}). rid=${callRid}`);
  }

  async function sendLeadWebhook(reason, closingMessage) {
    if (!MB_ENABLE_LEAD_CAPTURE || !MB_WEBHOOK_URL) return;
    if (leadWebhookSent) return;

    try {
      if (!callerNumber && callSid) {
        const resolved = await fetchCallerNumberFromTwilio(callSid, tag);
        if (resolved) callerNumber = resolved;
      }

      const parsedLead = await extractLeadFromConversation(conversationLog);
      if (!parsedLead || typeof parsedLead !== 'object') {
        logInfo(tag, 'No parsed lead object – skipping webhook (לא ליד מלא).');
        return;
      }

      // If missing phone -> try caller id
      if (!parsedLead.phone_number && callerNumber) parsedLead.phone_number = callerNumber;

      const normalizedPhone = normalizePhoneNumber(parsedLead.phone_number, callerNumber);
      parsedLead.phone_number = normalizedPhone;

      const callerDigits = normalizePhoneNumber(null, callerNumber);

      const isFullLead = parsedLead.is_lead === true && !!parsedLead.phone_number;
      if (!isFullLead) {
        logInfo(tag, 'Parsed lead is NOT full lead – webhook will NOT be sent.', {
          is_lead: parsedLead.is_lead,
          lead_type: parsedLead.lead_type,
          phone_number: parsedLead.phone_number || null
        });
        return;
      }

      const payload = {
        streamSid,
        callSid,
        phone_number: parsedLead.phone_number,
        CALLERID: callerDigits || parsedLead.phone_number,
        botName: BOT_NAME,
        businessName: BUSINESS_NAME,
        startedAt: new Date(callStartTs).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - callStartTs,
        reason,
        closingMessage,
        conversationLog,
        parsedLead
      };

      leadWebhookSent = true;
      logInfo(tag, `Sending lead webhook to ${MB_WEBHOOK_URL}`);
      const res = await fetch(MB_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) logError(tag, `Lead webhook HTTP ${res.status}`, await res.text());
      else logInfo(tag, `Lead webhook delivered successfully. status=${res.status}`);
    } catch (err) {
      logError(tag, 'Error sending lead webhook', err?.stack || err);
    }
  }

  function endCall(reason, closingMessage) {
    if (callEnded) return;
    callEnded = true;

    logInfo(tag, `endCall reason="${reason}" rid=${callRid}`);
    logInfo(tag, `Final conversation log rid=${callRid}:`, conversationLog);

    if (idleCheckInterval) clearInterval(idleCheckInterval);
    if (maxCallTimeout) clearTimeout(maxCallTimeout);
    if (maxCallWarningTimeout) clearTimeout(maxCallWarningTimeout);
    if (keepAlive) clearInterval(keepAlive);

    if (MB_ENABLE_LEAD_CAPTURE && MB_WEBHOOK_URL) {
      sendLeadWebhook(reason, closingMessage || MB_CLOSING_SCRIPT).catch(() => {});
    }

    if (MB_DYNAMIC_KB_URL) {
      refreshDynamicBusinessPrompt('PostCall').catch(() => {});
    }

    if (callSid) hangupTwilioCall(callSid, tag).catch(() => {});

    if (!openAiClosed && openAiWs.readyState === WebSocket.OPEN) {
      openAiClosed = true;
      openAiWs.close();
    }
    if (!twilioClosed && connection.readyState === WebSocket.OPEN) {
      twilioClosed = true;
      connection.close();
    }

    botSpeaking = false;
    hasActiveResponse = false;
    botTurnActive = false;
    noListenUntilTs = 0;
  }

  function scheduleEndCall(reason, closingMessage) {
    if (callEnded) return;
    const msg = closingMessage || MB_CLOSING_SCRIPT;
    if (pendingHangup) return;

    pendingHangup = { reason, closingMessage: msg };
    logInfo(tag, `scheduleEndCall reason="${reason}" rid=${callRid}`);

    if (openAiWs.readyState === WebSocket.OPEN) {
      sendModelPrompt(`סיימי את השיחה עם הלקוח במשפט הבא בלבד: "${msg}"`, 'closing');
    } else {
      const ph = pendingHangup;
      pendingHangup = null;
      endCall(ph.reason, ph.closingMessage);
      return;
    }

    const graceMs = Math.max(2000, Math.min(MB_HANGUP_GRACE_MS || 3000, 8000));
    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      logWarn(tag, `Hangup grace reached (${graceMs}ms), forcing endCall. rid=${callRid}`);
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);
  }

  function scheduleHangupAfterBotClosing(reason) {
    if (callEnded) return;
    if (pendingHangup) return;
    pendingHangup = { reason, closingMessage: MB_CLOSING_SCRIPT };

    const graceMs = Math.max(2000, Math.min(MB_HANGUP_GRACE_MS || 3000, 8000));
    setTimeout(() => {
      if (callEnded || !pendingHangup) return;
      const ph = pendingHangup;
      pendingHangup = null;
      logInfo(tag, `Hangup after bot closing. rid=${callRid}`);
      endCall(ph.reason, ph.closingMessage);
    }, graceMs);
  }

  function sendIdleWarningIfNeeded() {
    if (idleWarningSent || callEnded) return;
    idleWarningSent = true;
    const text = 'אני עדיין כאן על הקו, אתם איתי? אם תרצו להמשיך, אפשר פשוט לשאול או לבקש.';
    sendModelPrompt(`תגיבי במשפט קצר בסגנון: "${text}"`, 'idle_warning');
  }

  // -----------------------------
  // OpenAI WS
  // -----------------------------
  openAiWs.on('open', () => {
    openAiReady = true;
    logInfo(tag, `Connected to OpenAI Realtime API. rid=${callRid}`);

    const effectiveSilenceMs = MB_VAD_SILENCE_MS + MB_VAD_SUFFIX_MS;
    const sessionUpdate = {
      type: 'session.update',
      session: {
        model: 'gpt-4o-realtime-preview-2024-12-17',
        modalities: ['audio', 'text'],
        voice: OPENAI_VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: MB_VAD_THRESHOLD,
          silence_duration_ms: effectiveSilenceMs,
          prefix_padding_ms: MB_VAD_PREFIX_MS
        },
        max_response_output_tokens: MAX_OUTPUT_TOKENS,
        instructions
      }
    };

    logDebug(tag, `session.update rid=${callRid}`, sessionUpdate);
    openAiWs.send(JSON.stringify(sessionUpdate));

    sendModelPrompt(
      `פתחי את השיחה במשפט הבא (אפשר לשנות מעט אבל לא להאריך): "${MB_OPENING_SCRIPT}" ואז עצרי והמתיני לתשובה.`,
      'opening_greeting'
    );
  });

  openAiWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, `Failed to parse OpenAI WS message rid=${callRid}`, err);
      return;
    }

    const type = msg.type;

    switch (type) {
      case 'response.created':
        currentBotText = '';
        hasActiveResponse = true;
        botTurnActive = true;
        botSpeaking = false;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;
        break;

      case 'response.output_text.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.audio_transcript.delta': {
        const delta = msg.delta || '';
        if (delta) currentBotText += delta;
        break;
      }

      case 'response.output_text.done':
      case 'response.audio_transcript.done': {
        if (!currentBotText) break;
        const text = currentBotText.trim();
        if (text) {
          conversationLog.push({ from: 'bot', text });
          logInfo('Bot', text);
          checkBotClosing(text);
        }
        currentBotText = '';
        break;
      }

      // Audio delta -> Twilio
      case 'response.audio.delta': {
        const b64 = msg.delta;
        if (!b64 || !streamSid) break;
        botSpeaking = true;
        noListenUntilTs = Date.now() + MB_NO_BARGE_TAIL_MS;

        if (connection.readyState === WebSocket.OPEN) {
          connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
        }
        break;
      }

      case 'response.audio.done': {
        botSpeaking = false;
        botTurnActive = false;
        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          endCall(ph.reason, ph.closingMessage);
        }
        break;
      }

      case 'response.completed': {
        botSpeaking = false;
        hasActiveResponse = false;
        botTurnActive = false;
        if (pendingHangup && !callEnded) {
          const ph = pendingHangup;
          pendingHangup = null;
          endCall(ph.reason, ph.closingMessage);
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const t = String(msg.transcript || '').trim();
        if (t) {
          conversationLog.push({ from: 'user', text: t });
          logInfo('User', t);
        }
        break;
      }

      case 'error':
        logError(tag, `OpenAI Realtime error rid=${callRid}`, msg);
        hasActiveResponse = false;
        botSpeaking = false;
        botTurnActive = false;
        noListenUntilTs = 0;
        break;

      default:
        break;
    }
  });

  openAiWs.on('close', () => {
    openAiClosed = true;
    logWarn(tag, `OpenAI WS closed rid=${callRid}`);
    if (!callEnded) endCall('openai_ws_closed', MB_CLOSING_SCRIPT);
  });

  openAiWs.on('error', (err) => {
    logError(tag, `OpenAI WS error rid=${callRid}`, err?.stack || err);
    if (!openAiClosed) {
      openAiClosed = true;
      try { openAiWs.close(); } catch {}
    }
    if (!callEnded) endCall('openai_ws_error', MB_CLOSING_SCRIPT);
  });

  // -----------------------------
  // Twilio WS
  // -----------------------------
  connection.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (err) {
      logError(tag, `Failed to parse Twilio WS message rid=${callRid}`, err);
      return;
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      callerNumber = msg.start?.customParameters?.caller || null;

      callStartTs = Date.now();
      lastMediaTs = Date.now();

      logInfo(tag, `Twilio stream started rid=${callRid} streamSid=${streamSid} callSid=${callSid} caller=${callerNumber}`);

      idleCheckInterval = setInterval(() => {
        const now = Date.now();
        const sinceMedia = now - lastMediaTs;

        if (!idleWarningSent && sinceMedia >= MB_IDLE_WARNING_MS && !callEnded) {
          sendIdleWarningIfNeeded();
        }
        if (!idleHangupScheduled && sinceMedia >= MB_IDLE_HANGUP_MS && !callEnded) {
          idleHangupScheduled = true;
          logInfo(tag, `Idle timeout reached rid=${callRid}, scheduling endCall.`);
          scheduleEndCall('idle_timeout', MB_CLOSING_SCRIPT);
        }
      }, 1000);

      if (MB_MAX_CALL_MS > 0) {
        if (MB_MAX_WARN_BEFORE_MS > 0 && MB_MAX_CALL_MS > MB_MAX_WARN_BEFORE_MS) {
          maxCallWarningTimeout = setTimeout(() => {
            const t = 'אנחנו מתקרבים לסיום הזמן לשיחה הזאת. אם תרצו להתקדם, אפשר עכשיו לסכם ולהשאיר פרטים.';
            sendModelPrompt(`משפט קצר בסגנון: "${t}"`, 'max_call_warning');
          }, MB_MAX_CALL_MS - MB_MAX_WARN_BEFORE_MS);
        }

        maxCallTimeout = setTimeout(() => {
          logInfo(tag, `Max call duration reached rid=${callRid}, scheduling endCall.`);
          scheduleEndCall('max_call_duration', MB_CLOSING_SCRIPT);
        }, MB_MAX_CALL_MS);
      }
    }

    else if (event === 'media') {
      lastMediaTs = Date.now();
      const payload = msg.media?.payload;
      if (!payload) return;
      if (!openAiReady || openAiWs.readyState !== WebSocket.OPEN) return;

      const now = Date.now();

      if (!MB_ALLOW_BARGE_IN) {
        if (botTurnActive || botSpeaking || now < noListenUntilTs) {
          logDebug('BargeIn', `Ignore media (no-barge) rid=${callRid}`, { botTurnActive, botSpeaking, now, noListenUntilTs });
          return;
        }
      }

      openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
    }

    else if (event === 'stop') {
      logWarn(tag, `Twilio stream stopped rid=${callRid}`);
      twilioClosed = true;
      if (!callEnded) endCall('twilio_stop', MB_CLOSING_SCRIPT);
    }
  });

  connection.on('close', () => {
    twilioClosed = true;
    logWarn(tag, `Twilio WS closed rid=${callRid}`);
    if (keepAlive) clearInterval(keepAlive);
    if (!callEnded) endCall('twilio_ws_closed', MB_CLOSING_SCRIPT);
  });

  connection.on('error', (err) => {
    twilioClosed = true;
    logError(tag, `Twilio WS error rid=${callRid}`, err?.stack || err);
    if (keepAlive) clearInterval(keepAlive);
    if (!callEnded) endCall('twilio_ws_error', MB_CLOSING_SCRIPT);
  });
});

// -----------------------------
// Start server
// -----------------------------
server.listen(PORT, () => {
  logInfo('BOOT', `✅ BluBinet Realtime Voice Bot running on port ${PORT}`);
  refreshDynamicBusinessPrompt('Startup').catch(() => {});
});
