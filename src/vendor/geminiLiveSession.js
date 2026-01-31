// src/vendor/geminiLiveSession.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");

// Per docs: endpoint for Live API websocket sessions
// wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
// (v1beta) :contentReference[oaicite:2]{index=2}
const LIVE_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

function ensureModelsPrefix(model) {
  if (!model) return "";
  return model.startsWith("models/") ? model : `models/${model}`;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function createGeminiLiveSession({
  apiKey,
  model,
  voiceName,
  responseModalities,
  systemInstruction
}) {
  let ws = null;

  const handlers = {
    open: [],
    close: [],
    error: [],
    audio_pcm16le_24000: []
  };

  function on(evt, fn) {
    handlers[evt].push(fn);
  }

  function emit(evt, arg) {
    for (const fn of handlers[evt] || []) {
      try { fn(arg); } catch {}
    }
  }

  function send(obj) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  async function connect() {
    if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
    if (!model) throw new Error("Missing GEMINI_LIVE_MODEL");

    // Auth with API key: most implementations append ?key=... for WS.
    // (Endpoint itself is as in docs) :contentReference[oaicite:3]{index=3}
    const url = `${LIVE_WS_BASE}?key=${encodeURIComponent(apiKey)}`;

    ws = new WebSocket(url);

    ws.on("open", () => {
      // Required initial setup message after WS connect :contentReference[oaicite:4]{index=4}
      const setup = {
        setup: {
          model: ensureModelsPrefix(model),
          generationConfig: {
            responseModalities: responseModalities && responseModalities.length ? responseModalities : ["AUDIO"],
            // Ask for speech (voice). Exact knobs evolve; this is a safe minimal config.
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voiceName || "Kore"
                }
              }
            }
          },
          systemInstruction: systemInstruction || ""
        }
      };

      send(setup);
      emit("open");
    });

    ws.on("message", (data) => {
      const msg = safeJsonParse(data.toString("utf8"));
      if (!msg) return;

      // We handle audio in a tolerant way because message shapes may vary in preview.
      // Typical pattern: serverContent -> modelTurn -> parts -> inlineData (audio) base64.
      const parts =
        msg.serverContent &&
        msg.serverContent.modelTurn &&
        Array.isArray(msg.serverContent.modelTurn.parts)
          ? msg.serverContent.modelTurn.parts
          : null;

      if (parts) {
        for (const p of parts) {
          const inline = p.inlineData || p.inline_data || null;
          if (!inline) continue;

          const mime = inline.mimeType || inline.mime_type || "";
          const b64 = inline.data || null;
          if (!b64) continue;

          // Many live voices come back PCM; we expect PCM16LE 24k in the converter.
          // If it’s not PCM, we currently ignore (can be extended later).
          if (mime.includes("audio") && mime.includes("pcm")) {
            const buf = Buffer.from(b64, "base64");
            emit("audio_pcm16le_24000", buf);
          }
        }
      }
    });

    ws.on("close", (code, reason) => {
      emit("close", { code, reason: reason ? reason.toString() : "" });
    });

    ws.on("error", (err) => {
      emit("error", err);
    });
  }

  function sendAudioUlaw8k(payloadB64) {
    if (!payloadB64) return;

    // Send realtime input audio chunks
    // We declare the mimeType as μ-law 8k (Twilio format).
    send({
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/ulaw;rate=8000",
            data: payloadB64
          }
        ]
      }
    });
  }

  async function close() {
    try {
      if (ws && ws.readyState === ws.OPEN) ws.close();
    } catch {}
  }

  return {
    on,
    connect,
    close,
    sendAudioUlaw8k
  };
}

module.exports = { createGeminiLiveSession };
