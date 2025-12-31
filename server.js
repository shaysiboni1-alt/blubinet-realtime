require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const BOT_NAME = process.env.MB_BOT_NAME || "נטע";
const BUSINESS_NAME = process.env.MB_BUSINESS_NAME || "BluBinet";
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL || process.env.MB_WEBHOOK_URL || "";

const FORCED_MODEL = (process.env.MB_GEMINI_MODEL || "models/gemini-2.0-flash-exp").trim();
const GEMINI_VOICE = process.env.MB_GEMINI_VOICE || "Aoede";

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

  console.log("==> /twilio-voice HIT", {
    from: req.body?.From,
    to: req.body?.To,
    wsUrl,
  });

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

const b64ToBuf = (b64) => Buffer.from(b64, "base64");
const bufToB64 = (buf) => Buffer.from(buf).toString("base64");

// Twilio μ-law b64 -> PCM16 8k
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

// --------- BETTER: Low-pass FIR then decimate 24k -> 8k ---------
// Small FIR lowpass tuned for decimation by 3 (cutoff ~3.2kHz @24k)
// Coeffs are symmetric; gain normalized.
const FIR = [
  -0.0042, -0.0101, -0.0146, -0.0107,
   0.0060,  0.0331,  0.0640,  0.0895,
   0.1010,
   0.0895,  0.0640,  0.0331,  0.0060,
  -0.0107, -0.0146, -0.0101, -0.0042
];
const FIR_HALF = Math.floor(FIR.length / 2);

function clamp16(x) {
  if (x > 32767) return 32767;
  if (x < -32768) return -32768;
  return x | 0;
}

function lowpassFIR24k(pcm24kBuf) {
  const n = pcm24kBuf.length / 2;
  const out = new Int16Array(n);

  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -FIR_HALF; k <= FIR_HALF; k++) {
      const idx = i + k;
      const s = idx < 0 || idx >= n ? 0 : pcm24kBuf.readInt16LE(idx * 2);
      acc += s * FIR[k + FIR_HALF];
    }
    out[i] = clamp16(acc);
  }
  return Buffer.from(out.buffer);
}

function downsamplePcm16_24k_to_8k_clean(pcm24kBuf) {
  if (!pcm24kBuf || pcm24kBuf.length < 6) return Buffer.alloc(0);

  const filtered = lowpassFIR24k(pcm24kBuf);
  const inSamples = filtered.length / 2;
  const outSamples = Math.floor(inSamples / 3);
  const outBuf = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i++) {
    // pick every 3rd sample after lowpass
    outBuf.writeInt16LE(filtered.readInt16LE((i * 3) * 2), i * 2);
  }
  return outBuf;
}

// PCM16 8k -> μ-law b64
function pcm16_8k_to_mulawB64(pcm8kBuf) {
  const inSamples = pcm8kBuf.length / 2;
  const muBuf = Buffer.alloc(inSamples);
  for (let i = 0; i < inSamples; i++) {
    muBuf[i] = mulawEncodeSample(pcm8kBuf.readInt16LE(i * 2));
  }
  return bufToB64(muBuf);
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

function makeSetupMsg(modelName) {
  return {
    setup: {
      model: modelName,
      generationConfig: {
        responseModalities: ["AUDIO"],
        maxOutputTokens: 160,
        temperature: 0.3,
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: GEMINI_VOICE },
          },
        },
      },
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTIONS }] },
      realtimeInputConfig: { activityHandling: "NO_INTERRUPTION" },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

const wss = new WebSocket.Server({ server, path: "/twilio-media-stream" });

wss.on("connection", (twilioWs, req) => {
  console.log("Twilio: WS Connected", {
    ip: req.socket?.remoteAddress,
    ua: req.headers["user-agent"],
  });

  let streamSid = null;
  let geminiWs = null;

  let openingSent = false;
  let callLog = [];

  // reconnect control
  let reconnecting = false;
  let closedByUs = false;

  function connectGemini() {
    geminiWs = new WebSocket(geminiWsUrl());

    geminiWs.on("open", () => {
      console.log("Gemini: Connection Opened. Using model:", FORCED_MODEL);
      geminiWs.send(JSON.stringify(makeSetupMsg(FORCED_MODEL)));
    });

    geminiWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      if (msg.setupComplete) {
        console.log("Gemini: Setup Complete (model ok)");

        // פתיח מיידי
        if (!openingSent) {
          openingSent = true;
          geminiWs.send(
            JSON.stringify({
              clientContent: {
                turns: [{ role: "user", parts: [{ text: OPENING_TEXT }] }],
                turnComplete: true,
              },
            })
          );
        }
        return;
      }

      // transcripts for logs (אם קיימים)
      if (msg?.serverContent?.inputTranscription?.text) {
        callLog.push({ user_transcript: msg.serverContent.inputTranscription.text });
      }
      if (msg?.serverContent?.outputTranscription?.text) {
        callLog.push({ bot_transcript: msg.serverContent.outputTranscription.text });
      }

      const parts = msg?.serverContent?.modelTurn?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          if (p?.inlineData?.data) {
            const mime = p.inlineData.mimeType || "";
            const pcmBuf = b64ToBuf(p.inlineData.data);

            // Most likely 24k PCM -> clean downsample to 8k -> μ-law
            let pcm8k = pcmBuf;

            if (!mime.includes("rate=8000")) {
              pcm8k = downsamplePcm16_24k_to_8k_clean(pcmBuf);
            }

            const mulawB64 = pcm16_8k_to_mulawB64(pcm8k);

            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: mulawB64 } }));
            }
          }

          if (typeof p?.text === "string" && p.text.trim()) {
            callLog.push({ bot_text: p.text.trim() });
          }
        }
      }

      if (msg?.error?.message) {
        console.error("Gemini Server Error:", msg.error.message);
      }
    });

    geminiWs.on("close", (code, reason) => {
      const reasonStr = reason?.toString?.() || "";
      console.log("Gemini Connection Closed", code, reasonStr);

      if (closedByUs) return;

      // אם סגירה "תקינה" (1000) — לא סוגרים את Twilio.
      // במקום זה נתחבר מחדש אוטומטית כדי שהשיחה תמשיך.
      if (code === 1000 && !reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          if (twilioWs.readyState === WebSocket.OPEN) {
            console.log("Gemini: Reconnecting after normal close (1000)...");
            connectGemini();
          }
        }, 250);
        return;
      }

      // אם שגיאה/סגירה אחרת — נסגור גם טוויליו
      try {
        if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      } catch {}
    });

    geminiWs.on("error", (e) => {
      console.error("Gemini Error:", e?.message || e);
    });
  }

  connectGemini();

  // Twilio -> Gemini audio
  twilioWs.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
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

      // μ-law 8k -> PCM16 8k -> upsample 16k -> send
      const pcm8k = mulawB64ToPcm16_8k(msg.media.payload);
      const pcm16k = upsamplePcm16_8k_to_16k(pcm8k);

      geminiWs.send(
        JSON.stringify({
          realtimeInput: {
            audio: { mimeType: "audio/pcm;rate=16000", data: bufToB64(pcm16k) },
          },
        })
      );
      return;
    }

    if (msg.event === "stop") {
      try {
        closedByUs = true;
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) geminiWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio Closed");
    try {
      closedByUs = true;
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

  twilioWs.on("error", (e) => console.error("Twilio WS Error:", e?.message || e));
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection", err));
process.on("uncaughtException", (err) => console.error("uncaughtException", err));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
  console.log("Forced model:", FORCED_MODEL);
});
