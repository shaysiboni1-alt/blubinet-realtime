require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 1000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const MB_DEBUG = String(process.env.MB_DEBUG || "").toLowerCase() === "true";

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const GEMINI_MODEL = (process.env.MB_GEMINI_MODEL || "models/gemini-2.0-flash-exp").trim();
const GEMINI_VOICE = (process.env.MB_GEMINI_VOICE || "Aoede").trim();

const OPENING_TEXT =
  process.env.MB_OPENING_TEXT ||
  `שָׁלוֹם, הִגַּעְתֶּם לְ־${BUSINESS_NAME}. מְדַבֶּרֶת ${BOT_NAME}. אֵיךְ אֶפְשָׁר לַעֲזוֹר?`;

const SYSTEM_INSTRUCTIONS = `
את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}".
כללים:
- דברי בעברית בלבד.
- תשובות קצרות (1–2 משפטים).
- אל תברכי שוב אחרי הפתיח.
- אל תקטעי את הלקוח. המתיני שיסיים ואז עני.
- אם חסר מידע: שאלי שאלה אחת קצרה בלבד.
`.trim();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("BluBinet Status: Online"));
app.get("/health", (req, res) => res.json({ ok: true }));

function buildWsUrl(req) {
  if (PUBLIC_BASE_URL) {
    const u = new URL(PUBLIC_BASE_URL);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/twilio-media-stream`;
  }
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString();
  return `wss://${host}/twilio-media-stream`;
}

app.post("/twilio-voice", (req, res) => {
  const wsUrl = buildWsUrl(req);
  if (MB_DEBUG) console.log("==> /twilio-voice", { from: req.body?.From, to: req.body?.To, wsUrl });

  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
  <Pause length="600"/>
</Response>`
  );
});

const server = http.createServer(app);

// =====================
// Base64 helpers
// =====================
const b64ToBuf = (b64) => Buffer.from(b64, "base64");
const bufToB64 = (buf) => Buffer.from(buf).toString("base64");

// Detect if a buffer is mostly ASCII base64 text (heuristic)
function looksLikeBase64Text(buf) {
  if (!buf || buf.length < 64) return false;
  let good = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    const isB64 =
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a) || // a-z
      (c >= 0x30 && c <= 0x39) || // 0-9
      c === 0x2b || // +
      c === 0x2f || // /
      c === 0x3d || // =
      c === 0x0a || // \n
      c === 0x0d;   // \r
    if (isB64) good++;
  }
  return good / buf.length > 0.92;
}

// Sometimes audio payload is "double base64" – this fixes it automatically
function decodeMaybeDoubleBase64(b64) {
  const first = b64ToBuf(b64);
  if (looksLikeBase64Text(first)) {
    try {
      const asText = first.toString("utf8").replace(/\s+/g, "");
      // base64 strings usually multiple of 4
      if (asText.length % 4 === 0) {
        const second = b64ToBuf(asText);
        // sanity: pcm should be even length
        if (second.length >= 200 && second.length % 2 === 0) return second;
      }
    } catch {}
  }
  return first;
}

// =====================
// μ-law helpers (Twilio = μ-law 8k)
// =====================
function mulawDecodeSample(muLawByte) {
  let mu = (~muLawByte) & 0xff;
  let sign = mu & 0x80 ? -1 : 1;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let magnitude = ((mantissa << 1) + 1) << (exponent + 2);
  let sample = sign * (magnitude - 33);
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function mulawEncodeSample(pcm16) {
  const BIAS = 33;
  let sign = 0;
  let sample = pcm16;

  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
    if (sample > 32767) sample = 32767;
  }

  sample = sample + BIAS;
  if (sample > 0x7fff) sample = 0x7fff;

  let exponent = 7;
  for (let exp = 0; exp < 8; exp++) {
    if (sample <= (0x1f << (exp + 3))) {
      exponent = exp;
      break;
    }
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function mulawB64ToPcm16_8k(mulawB64) {
  const muBuf = b64ToBuf(mulawB64);
  const pcmBuf = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    pcmBuf.writeInt16LE(mulawDecodeSample(muBuf[i]), i * 2);
  }
  return pcmBuf;
}

// Upsample PCM16 8k -> 16k (linear interp)
function upsamplePcm16_8k_to_16k(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  if (inSamples < 2) return pcm8kBuf;

  const outSamples = inSamples * 2;
  const outBuf = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < inSamples; i++) {
    const curr = pcm8kBuf.readInt16LE(i * 2);
    const outIndex = i * 2;
    outBuf.writeInt16LE(curr, outIndex * 2);

    if (i < inSamples - 1) {
      const next = pcm8kBuf.readInt16LE((i + 1) * 2);
      const mid = ((curr + next) / 2) | 0;
      outBuf.writeInt16LE(mid, (outIndex + 1) * 2);
    } else {
      outBuf.writeInt16LE(curr, (outIndex + 1) * 2);
    }
  }
  return outBuf;
}

function clamp16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

// Mild DC removal + limiter to reduce harsh μ-law artifacts
function highpassInPlace(pcmBuf, a = 0.995) {
  const n = pcmBuf.length / 2;
  if (n < 2) return pcmBuf;
  let prevX = pcmBuf.readInt16LE(0);
  let prevY = 0;
  for (let i = 1; i < n; i++) {
    const x = pcmBuf.readInt16LE(i * 2);
    const y = (x - prevX) + (a * prevY);
    pcmBuf.writeInt16LE(clamp16(y), i * 2);
    prevX = x;
    prevY = y;
  }
  return pcmBuf;
}

function normalizeAndLimitInPlace(pcmBuf, targetPeak = 26000) {
  const n = pcmBuf.length / 2;
  if (!n) return pcmBuf;

  let peak = 1;
  for (let i = 0; i < n; i++) {
    const s = Math.abs(pcmBuf.readInt16LE(i * 2));
    if (s > peak) peak = s;
  }
  const gain = Math.min(1.6, targetPeak / peak);

  const hard = 29000;
  for (let i = 0; i < n; i++) {
    let x = pcmBuf.readInt16LE(i * 2) * gain;
    // soft clip
    if (x > hard) x = hard + (x - hard) * 0.12;
    if (x < -hard) x = -hard + (x + hard) * 0.12;
    pcmBuf.writeInt16LE(clamp16(x), i * 2);
  }
  return pcmBuf;
}

// FIR lowpass decimators (24k->8k, 16k->8k)
const FIR3 = [-0.0042,-0.0101,-0.0146,-0.0107,0.0060,0.0331,0.0640,0.0895,0.1010,0.0895,0.0640,0.0331,0.0060,-0.0107,-0.0146,-0.0101,-0.0042];
const FIR2 = [-0.0089,-0.0127,0.0000,0.0365,0.0903,0.1542,0.2000,0.1542,0.0903,0.0365,0.0000,-0.0127,-0.0089];

function lowpassFIR(pcmBuf, coeffs) {
  const half = Math.floor(coeffs.length / 2);
  const n = pcmBuf.length / 2;
  const out = new Int16Array(n);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -half; k <= half; k++) {
      const idx = i + k;
      const s = idx < 0 || idx >= n ? 0 : pcmBuf.readInt16LE(idx * 2);
      acc += s * coeffs[k + half];
    }
    out[i] = clamp16(acc);
  }
  return Buffer.from(out.buffer);
}

function downsampleTo8k(pcmBuf, inRate) {
  if (inRate === 8000) return pcmBuf;

  if (inRate === 24000) {
    const filtered = lowpassFIR(pcmBuf, FIR3);
    const inSamples = filtered.length / 2;
    const outSamples = Math.floor(inSamples / 3);
    const outBuf = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      outBuf.writeInt16LE(filtered.readInt16LE((i * 3) * 2), i * 2);
    }
    return outBuf;
  }

  if (inRate === 16000) {
    const filtered = lowpassFIR(pcmBuf, FIR2);
    const inSamples = filtered.length / 2;
    const outSamples = Math.floor(inSamples / 2);
    const outBuf = Buffer.alloc(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      outBuf.writeInt16LE(filtered.readInt16LE((i * 2) * 2), i * 2);
    }
    return outBuf;
  }

  // fallback linear
  const inSamples = pcmBuf.length / 2;
  const outSamples = Math.max(1, Math.floor((inSamples * 8000) / inRate));
  const outBuf = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const t = (i * (inSamples - 1)) / Math.max(1, (outSamples - 1));
    const i0 = Math.floor(t);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = t - i0;
    const s0 = pcmBuf.readInt16LE(i0 * 2);
    const s1 = pcmBuf.readInt16LE(i1 * 2);
    outBuf.writeInt16LE(clamp16(s0 + (s1 - s0) * frac), i * 2);
  }
  return outBuf;
}

function pcm16_8k_to_mulawB64(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  const muBuf = Buffer.alloc(inSamples);
  for (let i = 0; i < inSamples; i++) {
    muBuf[i] = mulawEncodeSample(pcm8kBuf.readInt16LE(i * 2));
  }
  return bufToB64(muBuf);
}

function parseRateFromMime(mimeType) {
  if (!mimeType) return null;
  const m = String(mimeType).match(/rate\s*=\s*(\d+)/i);
  if (m) return Number(m[1]);
  return null;
}

// =====================
// Gemini Live WS (v1beta bidiGenerateContent)
// =====================
function geminiWsUrl() {
  return (
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`
  );
}

// IMPORTANT: transcription flags are snake_case in setup :contentReference[oaicite:2]{index=2}
function makeSetupMsg() {
  const setup = {
    setup: {
      model: GEMINI_MODEL,
      generation_config: {
        response_modalities: ["AUDIO"],
        max_output_tokens: 160,
        temperature: 0.3,
        speech_config: {
          voice_config: {
            prebuilt_voice_config: { voice_name: GEMINI_VOICE },
          },
        },
      },
      system_instruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },

      realtime_input_config: { activity_handling: "NO_INTERRUPTION" },

      // enable transcriptions
      input_audio_transcription: {},
      output_audio_transcription: {},
    },
  };
  return setup;
}

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs, req) => {
  console.log("Twilio: WS Connected", { ip: req.socket?.remoteAddress, ua: req.headers["user-agent"] });

  let streamSid = null;
  let twilioReady = false;

  let geminiWs = null;
  let geminiReady = false;

  let openingSent = false;
  let closedByUs = false;
  let reconnectTimer = null;

  const callLog = [];
  const log = (obj) => {
    callLog.push({ ts: new Date().toISOString(), ...obj });
    if (MB_DEBUG) console.log("LOG+", obj);
  };

  function maybeSendOpening() {
    if (openingSent) return;
    if (!twilioReady || !geminiReady) return;

    openingSent = true;
    log({ type: "opening", text: OPENING_TEXT });

    geminiWs.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: "user", parts: [{ text: OPENING_TEXT }] }],
          turn_complete: true,
        },
      })
    );
  }

  function connectGemini() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    geminiReady = false;

    geminiWs = new WebSocket(geminiWsUrl());

    geminiWs.on("open", () => {
      console.log("Gemini: Connection Opened. Model:", GEMINI_MODEL, "Voice:", GEMINI_VOICE);
      geminiWs.send(JSON.stringify(makeSetupMsg()));
    });

    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.setupComplete || msg.setup_complete) {
        console.log("Gemini: Setup Complete");
        geminiReady = true;
        log({ type: "setup_complete", model: GEMINI_MODEL, voice: GEMINI_VOICE });
        maybeSendOpening();
        return;
      }

      // Transcriptions (if enabled)
      const sc = msg.serverContent || msg.server_content;
      if (sc?.inputTranscription?.text || sc?.input_transcription?.text) {
        log({ type: "user_transcript", text: (sc.inputTranscription?.text || sc.input_transcription?.text || "").trim() });
      }
      if (sc?.outputTranscription?.text || sc?.output_transcription?.text) {
        log({ type: "bot_transcript", text: (sc.outputTranscription?.text || sc.output_transcription?.text || "").trim() });
      }

      const modelTurn = sc?.modelTurn || sc?.model_turn;
      const parts = modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          // text parts
          if (typeof p?.text === "string" && p.text.trim()) {
            log({ type: "bot_text", text: p.text.trim() });
          }

          // audio parts
          const inline = p?.inlineData || p?.inline_data;
          if (inline?.data) {
            const mime = inline.mimeType || inline.mime_type || "";
            const inRate = parseRateFromMime(mime) || 24000;

            // Fix possible double-base64
            const pcmIn = decodeMaybeDoubleBase64(inline.data);

            if (MB_DEBUG) console.log("Gemini audio chunk", { mime, inRate, bytes: pcmIn.length });

            let pcm8k = downsampleTo8k(pcmIn, inRate);
            pcm8k = highpassInPlace(pcm8k);
            pcm8k = normalizeAndLimitInPlace(pcm8k);

            const mulawB64 = pcm16_8k_to_mulawB64(pcm8k);

            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: mulawB64 } }));
            }
          }
        }
      }

      const err = msg?.error?.message;
      if (err) {
        console.error("Gemini error:", err);
        log({ type: "gemini_error", message: err });
      }
    });

    geminiWs.on("close", (code, reason) => {
      const reasonStr = reason?.toString?.() || "";
      console.log("Gemini Connection Closed", code, reasonStr);
      log({ type: "gemini_close", code, reason: reasonStr });

      if (closedByUs) return;

      // Do NOT close Twilio because Gemini closed. Reconnect.
      reconnectTimer = setTimeout(() => {
        if (twilioWs.readyState === WebSocket.OPEN) {
          console.log("Gemini: Reconnecting...");
          connectGemini();
        }
      }, 250);
    });

    geminiWs.on("error", (e) => {
      console.error("Gemini WS error:", e?.message || e);
      log({ type: "gemini_ws_error", message: e?.message || String(e) });
    });
  }

  connectGemini();

  twilioWs.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || null;
      twilioReady = true;
      console.log("Twilio Started:", streamSid);
      log({ type: "twilio_start", streamSid });
      maybeSendOpening();
      return;
    }

    if (msg.event === "media") {
      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      if (!msg?.media?.payload) return;

      const pcm8k = mulawB64ToPcm16_8k(msg.media.payload);
      const pcm16k = upsamplePcm16_8k_to_16k(pcm8k);

      geminiWs.send(
        JSON.stringify({
          realtime_input: {
            audio: { mime_type: "audio/pcm;rate=16000", data: bufToB64(pcm16k) },
          },
        })
      );
      return;
    }

    if (msg.event === "stop") {
      log({ type: "twilio_stop" });
      try {
        closedByUs = true;
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio Closed");
    log({ type: "twilio_close" });

    try {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    } catch {}

    if (MAKE_WEBHOOK_URL) {
      fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "call_ended", sid: streamSid, log: callLog }),
      }).catch(() => {});
    }
  });

  twilioWs.on("error", (e) => console.error("Twilio WS error:", e?.message || e));
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Model:", GEMINI_MODEL, "Voice:", GEMINI_VOICE);
});
