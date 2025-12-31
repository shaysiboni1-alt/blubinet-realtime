/**
 * BluBinet Realtime – Twilio Media Streams <-> Gemini Live (WebSocket)
 *
 * Fixes:
 * - Correct Gemini Live endpoint (v1beta)
 * - Correct message casing: generationConfig / speechConfig / realtimeInput / audio / mimeType
 * - Audio transcoding:
 *   Twilio => 8k μ-law (base64) -> PCM16 8k -> upsample to PCM16 16k -> Gemini
 *   Gemini => PCM16 24k (base64) -> downsample to PCM16 8k -> μ-law 8k -> Twilio
 *
 * ENV:
 * - PORT (Render)
 * - GEMINI_API_KEY (required)
 * - MB_BOT_NAME (default: נטע)
 * - MB_BUSINESS_NAME (default: BluBinet)
 * - MAKE_WEBHOOK_URL or MB_WEBHOOK_URL (optional)
 * - MB_GEMINI_MODEL (optional, default below)
 * - MB_GEMINI_VOICE (optional, default: Aoede)
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY in environment");
  process.exit(1);
}

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const GEMINI_MODEL = process.env.MB_GEMINI_MODEL || "gemini-2.5-flash-native-audio-preview-12-2025";
const GEMINI_VOICE = process.env.MB_GEMINI_VOICE || "Aoede";

const SYSTEM_INSTRUCTIONS = `את נציגה בשם "${BOT_NAME}" עבור "${BUSINESS_NAME}". עני בעברית בלבד ובקצרה (1–2 משפטים). אל תברכי שוב.`;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => res.send("BluBinet Status: Online"));
app.get("/health", (req, res) => res.json({ ok: true }));

// Twilio Voice webhook -> returns TwiML that connects Media Stream to our WS
app.post("/twilio-voice", (req, res) => {
  const host = req.headers.host;
  res.type("text/xml").send(
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/twilio-media-stream" />
  </Connect>
</Response>`
  );
});

const server = http.createServer(app);

// =====================
// μ-law (G.711) helpers
// =====================
function mulawDecodeSample(muLawByte) {
  // muLawByte: 0..255
  let mu = (~muLawByte) & 0xff;
  let sign = (mu & 0x80) ? -1 : 1;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let magnitude = ((mantissa << 1) + 1) << (exponent + 2);
  // Bias 33 per μ-law
  let sample = sign * (magnitude - 33);
  // clamp 16-bit
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  return sample;
}

function mulawEncodeSample(pcm16) {
  // pcm16: signed 16-bit
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

  // Determine exponent and mantissa
  let exponent = 7;
  for (let exp = 0; exp < 8; exp++) {
    if (sample <= (0x1f << (exp + 3))) {
      exponent = exp;
      break;
    }
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mu;
}

function base64ToBuffer(b64) {
  return Buffer.from(b64, "base64");
}

function bufferToBase64(buf) {
  return Buffer.from(buf).toString("base64");
}

// Convert Twilio μ-law base64 (8k) -> PCM16 buffer @8k
function mulawB64ToPcm16_8k(mulawB64) {
  const muBuf = base64ToBuffer(mulawB64);
  const pcmBuf = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    const s = mulawDecodeSample(muBuf[i]);
    pcmBuf.writeInt16LE(s, i * 2);
  }
  return pcmBuf;
}

// Upsample PCM16 @8k -> PCM16 @16k (linear interpolation)
function upsamplePcm16_8k_to_16k(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  if (inSamples < 2) return pcm8kBuf;

  const outSamples = inSamples * 2;
  const outBuf = Buffer.alloc(outSamples * 2);

  let prev = pcm8kBuf.readInt16LE(0);
  for (let i = 0; i < inSamples; i++) {
    const curr = pcm8kBuf.readInt16LE(i * 2);
    const outIndex = i * 2;

    // sample at t = i
    outBuf.writeInt16LE(curr, outIndex * 2);

    // sample at t = i + 0.5 (between curr and next)
    if (i < inSamples - 1) {
      const next = pcm8kBuf.readInt16LE((i + 1) * 2);
      const mid = ((curr + next) / 2) | 0;
      outBuf.writeInt16LE(mid, (outIndex + 1) * 2);
    } else {
      outBuf.writeInt16LE(curr, (outIndex + 1) * 2);
    }

    prev = curr;
  }
  return outBuf;
}

// Downsample PCM16 @24k -> PCM16 @8k (factor 3, simple average)
function downsamplePcm16_24k_to_8k(pcm24kBuf) {
  const inSamples = pcm24kBuf.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  if (outSamples <= 0) return Buffer.alloc(0);

  const outBuf = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    const a = pcm24kBuf.readInt16LE((i * 3 + 0) * 2);
    const b = pcm24kBuf.readInt16LE((i * 3 + 1) * 2);
    const c = pcm24kBuf.readInt16LE((i * 3 + 2) * 2);
    const avg = ((a + b + c) / 3) | 0;
    outBuf.writeInt16LE(avg, i * 2);
  }
  return outBuf;
}

// PCM16 @8k -> μ-law base64 @8k
function pcm16_8k_to_mulawB64(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  const muBuf = Buffer.alloc(inSamples);
  for (let i = 0; i < inSamples; i++) {
    const s = pcm8kBuf.readInt16LE(i * 2);
    muBuf[i] = mulawEncodeSample(s);
  }
  return bufferToBase64(muBuf);
}

// =====================
// WebSocket: Twilio side
// =====================
const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio: Connected");

  let streamSid = null;
  let geminiWs = null;
  let callLog = [];

  function connectToGemini() {
    // Live API WebSocket endpoint (v1beta) per docs
    const url =
      `wss://generativelanguage.googleapis.com/ws/` +
      `google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
        GEMINI_API_KEY
      )}`;

    geminiWs = new WebSocket(url);

    geminiWs.on("open", () => {
      console.log("Gemini: Connection Opened");

      // Setup message must be first. Uses camelCase fields.
      const setupMsg = {
        setup: {
          model: GEMINI_MODEL,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: GEMINI_VOICE,
                },
              },
            },
          },
          systemInstruction: SYSTEM_INSTRUCTIONS,
        },
      };

      geminiWs.send(JSON.stringify(setupMsg));
    });

    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch (e) {
        return;
      }

      if (msg.setupComplete) {
        console.log("Gemini: Setup Complete");
        return;
      }

      // Model output: serverContent.modelTurn.parts[].inlineData (audio)
      const parts = msg?.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          // Audio chunk
          if (p?.inlineData?.data && typeof p.inlineData.data === "string") {
            const mime = p?.inlineData?.mimeType || "";
            // Expect PCM16 24k from Live API examples/docs
            // We'll handle PCM only; if the API changes you’ll see mime here.
            const pcmBuf = base64ToBuffer(p.inlineData.data);

            // If it's 24k PCM -> downsample to 8k -> μ-law -> send to Twilio
            // (Twilio Media Streams expects base64 μ-law 8k payload)
            let pcm8k = pcmBuf;
            if (mime.includes("rate=24000")) {
              pcm8k = downsamplePcm16_24k_to_8k(pcmBuf);
            }
            // If mime doesn't specify, we still try the 24k->8k path (common)
            if (!mime || mime.includes("audio/pcm")) {
              if (!mime.includes("rate=8000")) {
                pcm8k = downsamplePcm16_24k_to_8k(pcmBuf);
              }
            }

            const mulawB64 = pcm16_8k_to_mulawB64(pcm8k);

            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: mulawB64 },
                })
              );
            }
          }

          // Text chunk (log)
          if (typeof p?.text === "string" && p.text.trim()) {
            callLog.push({ bot: p.text.trim() });
          }
        }
      }

      // You can also log transcriptions if present
      const outT = msg?.serverContent?.outputTranscription?.text;
      if (outT) callLog.push({ bot_transcript: outT });
      const inT = msg?.serverContent?.inputTranscription?.text;
      if (inT) callLog.push({ user_transcript: inT });

      // Handle server errors if present
      if (msg?.error?.message) {
        console.error("Gemini Server Error:", msg.error.message);
      }
    });

    geminiWs.on("error", (e) => {
      console.error("Gemini Error:", e?.message || e);
    });

    geminiWs.on("close", (code, reason) => {
      console.log("Gemini Connection Closed", code, reason?.toString?.() || "");
      try {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      } catch (_) {}
    });
  }

  connectToGemini();

  twilioWs.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg?.start?.streamSid || null;
      console.log("Twilio Started:", streamSid);
      return;
    }

    if (msg.event === "media") {
      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) return;
      if (!msg?.media?.payload) return;

      // Twilio sends μ-law 8k base64 -> PCM16 8k -> upsample to PCM16 16k
      const pcm8k = mulawB64ToPcm16_8k(msg.media.payload);
      const pcm16k = upsamplePcm16_8k_to_16k(pcm8k);

      const geminiAudioMsg = {
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: bufferToBase64(pcm16k),
          },
        },
      };

      geminiWs.send(JSON.stringify(geminiAudioMsg));
      return;
    }

    if (msg.event === "stop") {
      // Twilio ended stream
      try {
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.close();
        }
      } catch (_) {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio Closed");

    try {
      if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
    } catch (_) {}

    if (MAKE_WEBHOOK_URL) {
      // send call summary
      fetch(MAKE_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "call_ended", sid: streamSid, log: callLog }),
      }).catch(() => {});
    }
  });

  twilioWs.on("error", (e) => {
    console.error("Twilio WS Error:", e?.message || e);
  });
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
