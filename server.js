// server.js
//
// BluBinet Realtime Voice Bot – "נטע"
// Twilio Media Streams <-> OpenAI Realtime API (text-only) + ElevenLabs TTS
//
// FIXES (2025-12-13):
// 1) CRITICAL: send user transcript into OpenAI conversation via conversation.item.create
// 2) Stop "לא שמענו טוב" spam: cooldown + only when no pending response + transcript grace
// 3) Hard gate: never send response.create while one is active
// 4) Better logging + GET /twilio-voice browser test
// 5) Optional IVRIT LLM hook (ENV IVRIT_LLM_URL) to generate text response instead of OpenAI.
//
// Twilio Voice Webhook -> POST /twilio-voice
// Twilio Media Streams -> wss://<domain>/twilio-media-stream

require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");

// =========================
// Logging
// =========================
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level) {
  return (LEVELS[level] || 20) >= (LEVELS[LOG_LEVEL] || 20);
}
function log(level, tag, msg, extra) {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const base = `[${ts}][${level.toUpperCase()}][${tag}] ${msg}`;
  if (extra !== undefined) {
    try {
      console.log(base, extra);
    } catch {
      console.log(base);
    }
  } else {
    console.log(base);
  }
}
process.on("unhandledRejection", (err) => log("error", "Process", "unhandledRejection", err));
process.on("uncaughtException", (err) => log("error", "Process", "uncaughtException", err));

// =========================
// Express
// =========================
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  const rid = req.headers["x-request-id"] || crypto.randomBytes(4).toString("hex");
  req.rid = rid;
  log("info", "HTTP", `--> [${rid}] ${req.method} ${req.path} ip=${req.ip}`);
  res.on("finish", () => log("info", "HTTP", `<-- [${rid}] ${req.method} ${req.path} status=${res.statusCode}`));
  next();
});

app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true, ts: Date.now() }));

app.get("/twilio-voice", (req, res) => {
  log("info", "Twilio-Voice", `GET /twilio-voice (browser test). rid=${req.rid}`);
  res
    .status(200)
    .send(
      `OK. This endpoint is meant for Twilio (HTTP POST)\n` +
        `If you see this in browser, the service is reachable.\n\n` +
        `Use POST /twilio-voice from Twilio Voice Webhook.\n` +
        `You can also check GET /health.\n`
    );
});

app.post("/twilio-voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const wsProto = proto === "http" ? "ws" : "wss";
  const wsUrl = `${wsProto}://${host}/twilio-media-stream`;

  log("info", "Twilio-Voice", `POST /twilio-voice -> Stream to ${wsUrl}`, { rid: req.rid });

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${wsUrl}" />` +
    `</Connect>` +
    `</Response>`;

  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// =========================
// Config
// =========================
const PORT = Number(process.env.PORT || 1000);

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview-2024-12-17";

// Twilio REST lookup (optional)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";

// Business
const BUSINESS_NAME = process.env.BUSINESS_NAME || "BluBinet";
const OPENING_SUFFIX = process.env.OPENING_SUFFIX || "";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Jerusalem";

// TTS
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "eleven").toLowerCase();

const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY || process.env.ELEVENLABS_API_KEY || "";
const ELEVEN_VOICE_ID = process.env.ELEVEN_VOICE_ID || process.env.VOICE_ID || ""; // אתה אמרת שיש VOICE_ID בלבד
const ELEVEN_MODEL_ID = (process.env.ELEVENLABS_MODEL_ID || process.env.ELEVEN_TTS_MODEL || "eleven_v3").trim();
const ELEVEN_OUTPUT_FORMAT =
  (process.env.ELEVENLABS_OUTPUT_FORMAT || process.env.ELEVEN_OUTPUT_FORMAT || "ulaw_8000").trim();
const ELEVEN_LANGUAGE = (process.env.ELEVENLABS_LANGUAGE || process.env.ELEVEN_LANGUAGE || "he").trim();
const ELEVEN_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS || 6500);

const ELEVEN_STYLE = clamp01(Number(process.env.ELEVENLABS_STYLE || 0.15));
const ELEVEN_USE_BOOST = String(process.env.ELEVENLABS_USE_BOOST || "1") === "1";
const ELEVEN_STABILITY = snapStability(Number(process.env.ELEVENLABS_STABILITY || 0.5)); // חייב 0/0.5/1.0
const ELEVEN_SIMILARITY = clamp01(Number(process.env.ELEVENLABS_SIMILARITY || 0.8));
const ELEVEN_SPEED = clamp(0.85, 1.1, Number(process.env.ELEVENLABS_SPEED || process.env.MB_SPEECH_SPEED || 1.0));

// Realtime/VAD
const MB_VAD_THRESHOLD = clamp(0.1, 0.9, Number(process.env.MB_VAD_THRESHOLD || 0.55));
const MB_VAD_PREFIX_MS = Number(process.env.MB_VAD_PREFIX_MS || 150);
const MB_VAD_SILENCE_MS = Number(process.env.MB_VAD_SILENCE_MS || 280);

// Flow timing
const MB_RESPONSE_DEBOUNCE_MS = Number(process.env.MB_RESPONSE_DEBOUNCE_MS || 120);
const MB_TRANSCRIPT_GRACE_MS = Number(process.env.MB_TRANSCRIPT_GRACE_MS || 1200); // נותן זמן לתמלול להגיע
const MB_NO_USER_COOLDOWN_MS = Number(process.env.MB_NO_USER_COOLDOWN_MS || 9000); // לא לחפור
const MB_NO_USER_MIN_GAP_AFTER_TRANSCRIPT_MS = Number(process.env.MB_NO_USER_MIN_GAP_AFTER_TRANSCRIPT_MS || 3500);

const MB_NO_BARGE_TAIL_MS = Number(process.env.MB_NO_BARGE_TAIL_MS || 700);
const MB_SILENCE_HANGUP_MS = Number(process.env.MB_SILENCE_HANGUP_MS || 25000);
const MB_MAX_CALL_MS = Number(process.env.MB_MAX_CALL_MS || 10 * 60 * 1000);
const MB_HANGUP_GRACE_MS = Number(process.env.MB_HANGUP_GRACE_MS || 3000);

// Optional IVRIT LLM
const IVRIT_LLM_URL = (process.env.IVRIT_LLM_URL || "").trim(); // EXPECTS POST -> {text:"..."} (אתה תיתן URL אמיתי)
const IVRIT_TIMEOUT_MS = Number(process.env.IVRIT_TIMEOUT_MS || 2500);

// Webhook (optional)
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || "";

log("info", "CONFIG", `TTS_PROVIDER=${TTS_PROVIDER}, ELEVEN voice=${ELEVEN_VOICE_ID ? "SET" : "MISSING"}, model=${ELEVEN_MODEL_ID}, format=${ELEVEN_OUTPUT_FORMAT}`);
log("info", "CONFIG", `VAD threshold=${MB_VAD_THRESHOLD}, prefix=${MB_VAD_PREFIX_MS}, silence=${MB_VAD_SILENCE_MS}`);
log("info", "CONFIG", `Timing: debounce=${MB_RESPONSE_DEBOUNCE_MS}ms, transcript_grace=${MB_TRANSCRIPT_GRACE_MS}ms, no_user_cooldown=${MB_NO_USER_COOLDOWN_MS}ms`);
log("info", "CONFIG", `IVRIT_LLM_URL=${IVRIT_LLM_URL ? "SET" : "NOT_SET"}`);

// =========================
// HTTP + WS Server
// =========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (ws) => {
  const rid = crypto.randomBytes(4).toString("hex");
  log("info", "Call", "New Twilio Media Stream connection established.", { rid });

  const state = createCallState({ ws, rid });

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      log("warn", "Twilio", "Non-JSON message from Twilio", { rid });
      return;
    }

    try {
      await handleTwilioMessage(state, msg);
    } catch (err) {
      log("error", "Call", "handleTwilioMessage failed", { rid, err: String(err) });
    }
  });

  ws.on("close", () => {
    log("info", "Call", "Twilio WS closed.", { rid });
    safeEndCall(state, "twilio_ws_closed").catch(() => {});
  });

  ws.on("error", (err) => {
    log("error", "Call", "Twilio WS error", { rid, err: String(err) });
    safeEndCall(state, "twilio_ws_error").catch(() => {});
  });

  state.maxCallTimer = setTimeout(() => {
    safeEndCall(state, "max_call_timeout").catch(() => {});
  }, MB_MAX_CALL_MS);
});

server.listen(PORT, () => {
  log("info", "Startup", `✅ BluBinet Realtime Voice Bot running on port ${PORT}`);
});

// =========================
// Call State
// =========================
function createCallState({ ws, rid }) {
  return {
    rid,
    twilioWs: ws,
    streamSid: null,
    callSid: null,
    caller: null,

    sender: createUlawSender({ twilioWs: ws, rid }),

    openAiWs: null,
    openAiReady: false,

    // response gating
    responseInFlight: false,
    pendingResponseTimer: null,

    // "לא שמענו טוב"
    pendingNoUserTimer: null,
    lastNoUserAt: 0,

    // user transcript tracking
    lastTranscriptAt: 0,
    lastUserText: null,

    // logs
    conversationLog: [],
    _textBuf: "",

    // timers
    silenceTimer: null,
    maxCallTimer: null,
    graceTimer: null,

    ended: false,
    usedFallbackAlloy: false,
  };
}

// =========================
// Twilio inbound
// =========================
async function handleTwilioMessage(state, msg) {
  const { rid } = state;

  if (msg.event === "start") {
    state.streamSid = msg.start.streamSid;
    state.callSid = msg.start.callSid;
    state.caller = msg.start.customParameters?.caller || null;

    state.sender.streamSid = state.streamSid;
    log("info", "AudioSender", "Bound sender.streamSid", { rid, streamSid: state.streamSid });
    log("info", "Call", `Twilio stream started. streamSid=${state.streamSid}, callSid=${state.callSid}, caller=${state.caller}`, { rid });

    armSilenceTimer(state);

    // connect OpenAI in parallel (unless IVRIT-only mode and you want no OpenAI at all)
    connectOpenAiRealtime(state).catch((e) => log("error", "OpenAI", "connectOpenAiRealtime failed", { rid, err: String(e) }));

    // greeting immediately via Eleven (still depends on Eleven latency)
    const opening = buildOpeningGreeting();
    pushLog(state, "bot", opening);
    await speakNow(state, opening, { reason: "opening_greeting" });
    return;
  }

  if (msg.event === "media") {
    armSilenceTimer(state);

    // send audio to OpenAI for transcription/VAD only
    if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) {
      state.openAiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
    return;
  }

  if (msg.event === "stop") {
    log("info", "Call", "Twilio stream stopped.", { rid });
    await safeEndCall(state, "twilio_stop");
    return;
  }
}

// =========================
// OpenAI Realtime
// =========================
async function connectOpenAiRealtime(state) {
  const { rid } = state;
  if (!OPENAI_API_KEY) {
    log("error", "OpenAI", "OPENAI_API_KEY missing - cannot connect", { rid });
    return;
  }

  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" };

  const openAiWs = new WebSocket(url, { headers });
  state.openAiWs = openAiWs;

  openAiWs.on("open", () => {
    log("info", "Call", "Connected to OpenAI Realtime API.", { rid });

    // text-only outputs (we do Eleven TTS)
    openAiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text"],
          instructions: buildMasterPrompt(),
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: MB_VAD_THRESHOLD,
            prefix_padding_ms: MB_VAD_PREFIX_MS,
            silence_duration_ms: MB_VAD_SILENCE_MS,
          },
          input_audio_transcription: { model: "whisper-1" },
        },
      })
    );

    state.openAiReady = true;
  });

  openAiWs.on("message", async (data) => {
    let evt;
    try {
      evt = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (evt?.type && shouldLog("debug")) log("debug", "OpenAI", `event=${evt.type}`, { rid });

    if (evt.type === "response.created") {
      state.responseInFlight = true;
      return;
    }
    if (evt.type === "response.done") {
      state.responseInFlight = false;
      return;
    }

    // transcription completed -> THIS IS THE CRITICAL FIX:
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = (evt.transcript || "").trim();
      if (!text) return;

      state.lastUserText = text;
      state.lastTranscriptAt = Date.now();
      pushLog(state, "user", text);
      log("info", "User", text, { rid });

      // cancel pending "no_user_text"
      if (state.pendingNoUserTimer) {
        clearTimeout(state.pendingNoUserTimer);
        state.pendingNoUserTimer = null;
      }

      // put user text into the model conversation
      if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) {
        state.openAiWs.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          })
        );
      }

      // schedule a response (fast)
      scheduleResponse(state, "transcript_completed");
      return;
    }

    // VAD speech stopped -> only use it to possibly trigger "no_user_text" AFTER grace
    if (evt.type === "input_audio_buffer.speech_stopped") {
      scheduleNoUserIfNeeded(state, "speech_stopped");
      return;
    }

    // model text streaming
    if (evt.type === "response.output_text.delta") {
      state._textBuf = (state._textBuf || "") + (evt.delta || "");
      return;
    }

    if (evt.type === "response.output_text.done") {
      const finalText = (state._textBuf || "").trim();
      state._textBuf = "";

      if (finalText) {
        log("info", "Bot", finalText, { rid });
        pushLog(state, "bot", finalText);
        await speakNow(state, finalText, { reason: "model_response" });
      } else {
        log("warn", "Bot", "Model returned empty text", { rid });
      }
      return;
    }

    if (evt.type === "error") {
      log("error", "OpenAI", "OpenAI error event", { rid, evt });
      // do not crash; keep going
      return;
    }
  });

  openAiWs.on("close", () => log("info", "Call", "OpenAI WS closed.", { rid }));
  openAiWs.on("error", (err) => log("error", "OpenAI", "OpenAI WS error", { rid, err: String(err) }));
}

function scheduleResponse(state, reason) {
  if (state.pendingResponseTimer) clearTimeout(state.pendingResponseTimer);
  state.pendingResponseTimer = setTimeout(() => {
    state.pendingResponseTimer = null;
    createResponse(state, reason).catch(() => {});
  }, MB_RESPONSE_DEBOUNCE_MS);
}

async function createResponse(state, reason) {
  const { rid } = state;

  // if IVRIT is configured, use it to generate text immediately (skip OpenAI response.create)
  if (IVRIT_LLM_URL) {
    const userText = state.lastUserText;
    if (!userText) return;

    // avoid parallel calls
    if (state.responseInFlight) {
      log("warn", "Call", "Skip IVRIT response (response already in flight)", { rid, reason });
      return;
    }

    state.responseInFlight = true;
    try {
      const reply = await callIvritLLM(userText, state.conversationLog, rid);
      state.responseInFlight = false;

      if (reply && reply.trim()) {
        log("info", "Bot", reply, { rid, via: "IVRIT" });
        pushLog(state, "bot", reply);
        await speakNow(state, reply, { reason: "ivrit_response" });
      } else {
        log("warn", "IVRIT", "Empty reply from IVRIT", { rid });
      }
    } catch (e) {
      state.responseInFlight = false;
      log("error", "IVRIT", "IVRIT call failed, fallback to OpenAI", { rid, err: String(e) });
      // fallback to OpenAI if available
      if (state.openAiWs && state.openAiReady) {
        await createOpenAiResponse(state, reason + "_fallback_openai");
      }
    }
    return;
  }

  // else: OpenAI
  await createOpenAiResponse(state, reason);
}

async function createOpenAiResponse(state, reason) {
  const { rid } = state;
  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN || !state.openAiReady) {
    log("warn", "Call", "OpenAI not ready - cannot response.create", { rid, reason });
    return;
  }
  if (!state.lastUserText) {
    log("warn", "Call", "No lastUserText - skipping response.create", { rid, reason });
    return;
  }
  if (state.responseInFlight) {
    log("warn", "Call", "Skip response.create (response already in flight)", { rid, reason });
    return;
  }

  // set in-flight and send
  state.responseInFlight = true;
  state.openAiWs.send(JSON.stringify({ type: "response.create", response: { max_output_tokens: 140 } }));
  log("info", "Call", "response.create sent", { rid, reason });
}

// =========================
// "No user text" guard (anti-spam)
// =========================
function scheduleNoUserIfNeeded(state, reason) {
  const { rid } = state;

  if (state.pendingNoUserTimer) clearTimeout(state.pendingNoUserTimer);

  state.pendingNoUserTimer = setTimeout(async () => {
    state.pendingNoUserTimer = null;

    // If we recently got a transcript, do NOT say "לא שמענו טוב"
    const sinceTranscript = Date.now() - (state.lastTranscriptAt || 0);
    if (state.lastTranscriptAt && sinceTranscript < MB_NO_USER_MIN_GAP_AFTER_TRANSCRIPT_MS) {
      log("info", "Call", "Skip no_user_text (recent transcript)", { rid, reason, sinceTranscript });
      return;
    }

    // If a response is in flight, do NOT say it
    if (state.responseInFlight) {
      log("info", "Call", "Skip no_user_text (response in flight)", { rid, reason });
      return;
    }

    // Cooldown: don't spam
    const sinceNoUser = Date.now() - (state.lastNoUserAt || 0);
    if (state.lastNoUserAt && sinceNoUser < MB_NO_USER_COOLDOWN_MS) {
      log("info", "Call", "Skip no_user_text (cooldown)", { rid, reason, sinceNoUser });
      return;
    }

    state.lastNoUserAt = Date.now();
    const t = "לֹא שָׁמַעְנוּ טוֹב, אֶפְשָׁר לַחְזֹר עַל זֶה?";
    pushLog(state, "bot", "לא שמעתי טוב, אפשר לחזור על זה?");
    await speakNow(state, t, { reason: "no_user_text" });
  }, MB_TRANSCRIPT_GRACE_MS);
}

// =========================
// Speak (Eleven) + Fallback
// =========================
async function speakNow(state, text, meta = {}) {
  const { rid } = state;
  try {
    if (TTS_PROVIDER === "eleven") {
      await elevenSpeakStreamToTwilio(state, text, meta);
    } else {
      throw new Error("TTS_PROVIDER is not 'eleven'");
    }
  } catch (err) {
    log("error", "TTS", "Eleven speak failed", { rid, err: String(err), meta });
    if (!state.usedFallbackAlloy) {
      state.usedFallbackAlloy = true;
      log("warn", "TTS", "Fallback to OpenAI audio (Alloy) to avoid silence", { rid });
      await openAiFallbackSpeak(state, text);
    }
  }
}

async function elevenSpeakStreamToTwilio(state, text, meta = {}) {
  const { rid } = state;

  if (!ELEVEN_API_KEY) throw new Error("ELEVEN_API_KEY missing");
  if (!ELEVEN_VOICE_ID) throw new Error("VOICE_ID missing (set VOICE_ID in ENV)");
  if (!text || !text.trim()) return;

  const qs = new URLSearchParams();
  qs.set("output_format", ELEVEN_OUTPUT_FORMAT);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE_ID)}/stream?${qs.toString()}`;

  const body = {
    text,
    model_id: ELEVEN_MODEL_ID,
    language_code: ELEVEN_LANGUAGE,
    voice_settings: {
      stability: ELEVEN_STABILITY,
      similarity_boost: ELEVEN_SIMILARITY,
      style: ELEVEN_STYLE,
      use_speaker_boost: ELEVEN_USE_BOOST,
      speed: ELEVEN_SPEED,
    },
  };

  log("info", "ElevenTTS", "Sending text to ElevenLabs TTS.", {
    rid,
    length: text.length,
    model: ELEVEN_MODEL_ID,
    language: ELEVEN_LANGUAGE,
    format: ELEVEN_OUTPUT_FORMAT,
    stability: ELEVEN_STABILITY,
    ...meta,
  });

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), ELEVEN_TIMEOUT_MS);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/*",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).finally(() => clearTimeout(to));

  if (!res.ok) {
    const txt = await safeReadText(res);
    throw new Error(`ElevenLabs HTTP ${res.status} ${txt}`);
  }
  if (!res.body) throw new Error("ElevenLabs response body empty");

  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    state.sender.enqueue(buf);
  }

  log("info", "ElevenTTS", `ElevenLabs TTS audio received total=${total} bytes`, { rid });
}

// Fallback ONLY if Eleven failed
async function openAiFallbackSpeak(state, text) {
  const { rid } = state;
  if (!state.openAiWs || state.openAiWs.readyState !== WebSocket.OPEN) throw new Error("OpenAI WS not open");

  state.openAiWs.send(
    JSON.stringify({
      type: "session.update",
      session: { modalities: ["text", "audio"], voice: "alloy", output_audio_format: "g711_ulaw" },
    })
  );

  state.openAiWs.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `תקריאו בדיוק את הטקסט הבא: ${text}` }] },
    })
  );

  state.openAiWs.send(JSON.stringify({ type: "response.create", response: { max_output_tokens: 80 } }));
  log("warn", "OpenAI", "Fallback audio requested (Alloy)", { rid });
}

// =========================
// IVRIT hook (generic)
// =========================
async function callIvritLLM(userText, conversationLog, rid) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), IVRIT_TIMEOUT_MS);

  // Generic payload (you can change server side): expects {text:"..."}
  const payload = {
    user_text: userText,
    conversation: conversationLog.slice(-10),
    business_name: BUSINESS_NAME,
    rules: {
      language: "he",
      plural: true,
      short: true,
    },
  };

  log("info", "IVRIT", "Calling IVRIT LLM", { rid, url: IVRIT_LLM_URL });

  const res = await fetch(IVRIT_LLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).finally(() => clearTimeout(to));

  if (!res.ok) {
    const t = await safeReadText(res);
    throw new Error(`IVRIT HTTP ${res.status} ${t}`);
  }

  const j = await res.json().catch(() => ({}));
  return (j.text || j.reply || j.output || "").toString();
}

// =========================
// Audio sender (ulaw 8k) 20ms
// =========================
function createUlawSender({ twilioWs, rid }) {
  const FRAME_BYTES = 320; // 20ms @ 8k ulaw
  const SILENCE_BYTE = 0xff;

  const queue = [];
  let timer = null;

  const sender = {
    streamSid: null,
    enqueue(buf) {
      if (!buf || !buf.length) return;
      queue.push(buf);
      start();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) return;

      if (!sender.streamSid) {
        log("warn", "AudioSender", "Cannot send audio: streamSid not set", { rid });
        return;
      }

      if (queue.length === 0) {
        sender.stop();
        return;
      }

      let frame = Buffer.alloc(FRAME_BYTES, SILENCE_BYTE);
      let offset = 0;

      while (offset < FRAME_BYTES && queue.length > 0) {
        const head = queue[0];
        const need = FRAME_BYTES - offset;
        const take = Math.min(need, head.length);
        head.copy(frame, offset, 0, take);
        offset += take;

        if (take === head.length) queue.shift();
        else queue[0] = head.slice(take);
      }

      const payload = frame.toString("base64");
      try {
        twilioWs.send(JSON.stringify({ event: "media", streamSid: sender.streamSid, media: { payload } }));
      } catch (e) {
        log("error", "AudioSender", "Failed sending media frame", { rid, err: String(e) });
      }
    }, 20);
  }

  return sender;
}

// =========================
// Timers / End call
// =========================
function armSilenceTimer(state) {
  clearTimeout(state.silenceTimer);
  state.silenceTimer = setTimeout(() => {
    safeEndCall(state, "silence_timeout").catch(() => {});
  }, MB_SILENCE_HANGUP_MS);
}

async function safeEndCall(state, reason) {
  if (state.ended) return;
  state.ended = true;

  const { rid } = state;
  log("info", "Call", `endCall called with reason="${reason}"`, { rid });

  clearTimeout(state.silenceTimer);
  clearTimeout(state.maxCallTimer);
  if (state.pendingResponseTimer) clearTimeout(state.pendingResponseTimer);
  if (state.pendingNoUserTimer) clearTimeout(state.pendingNoUserTimer);

  try {
    if (state.openAiWs && state.openAiWs.readyState === WebSocket.OPEN) state.openAiWs.close();
  } catch {}

  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && state.callSid) {
    try {
      const caller = await fetchCallerNumberFromTwilio(state.callSid);
      if (caller) state.caller = caller;
      log("info", "Call", `fetchCallerNumberFromTwilio: resolved caller="${caller}" from Twilio Call resource.`, { rid });
    } catch (err) {
      log("warn", "Call", "fetchCallerNumberFromTwilio failed", { rid, err: String(err) });
    }
  }

  log("info", "Call", "Final conversation log:", state.conversationLog);

  if (!MAKE_WEBHOOK_URL) {
    log("info", "Call", "No parsed lead object – skipping webhook (לא ליד מלא).", { rid });
  }

  state.graceTimer = setTimeout(() => {
    try {
      if (state.twilioWs && state.twilioWs.readyState === WebSocket.OPEN) state.twilioWs.close();
    } catch {}
  }, MB_HANGUP_GRACE_MS);
}

// =========================
// Prompt / Greeting
// =========================
function buildOpeningGreeting() {
  const tod = getTimeOfDayGreeting(TIME_ZONE);
  const suffix = OPENING_SUFFIX ? ` ${OPENING_SUFFIX}` : "";
  return `${tod} הגעתם ל־${BUSINESS_NAME}.${suffix} שמי נטע, איך אפשר לעזור לכם היום?`.replace(/\s+/g, " ").trim();
}

function buildMasterPrompt() {
  return (
    `אתם נטע, נציגת שירות ומכירות וירטואלית של ${BUSINESS_NAME}. ` +
    `אתם מדברים בעברית כברירת מחדל, בלשון רבים, בקצב מהיר ונעים, ותשובות קצרות מאוד (משפט-שניים). ` +
    `אם שואלים "מי אתם" או "מה אתם עושים" – עונים: "אנחנו BluBinet, חברה שמספקת מרכזיות ענן ופתרונות טלפוניה חכמה לעסקים – עם ניתוב שיחות, IVR, מספרים וירטואליים והקלטות". ` +
    `אם אין פנייה ברורה – לשאול שאלה אחת ממוקדת כדי להבין צורך. ` +
    `לא לחזור על אותו משפט שוב ושוב.`
  );
}

function pushLog(state, from, text) {
  state.conversationLog.push({ from, text });
}

// =========================
// Utils
// =========================
function clamp01(x) {
  return clamp(0, 1, x);
}
function clamp(min, max, x) {
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function snapStability(x) {
  const candidates = [0.0, 0.5, 1.0];
  let best = candidates[0];
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - x);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}
function getTimeOfDayGreeting(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value || "12");
    if (hour >= 5 && hour < 12) return "בוקר טוב,";
    if (hour >= 12 && hour < 17) return "צהריים טובים,";
    if (hour >= 17 && hour < 22) return "ערב טוב,";
    return "שלום,";
  } catch {
    return "שלום,";
  }
}
async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// =========================
// Twilio REST caller lookup
// =========================
async function fetchCallerNumberFromTwilio(callSid) {
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(
    callSid
  )}.json`;

  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) return null;
  const j = await res.json();
  return j?.from || null;
}
