// src/vendor/geminiLiveSession.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");

function normalizeModelName(m) {
  // Google expects: "models/<model>"
  if (!m) return "";
  if (m.startsWith("models/")) return m;
  return `models/${m}`;
}

function liveWsUrl() {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key
  )}`;
}

// ---- transcription extraction helpers (defensive) ----
function asText(v) {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    if (typeof v.text === "string") return v.text;
    if (typeof v.transcript === "string") return v.transcript;
    if (typeof v.value === "string") return v.value;
  }
  return "";
}

function pickTranscriptsFromMsg(msg) {
  // Live API server messages are union types; location can vary.
  // We'll defensively scan a few likely places.
  const out = { input: "", output: "" };

  // 1) Common in serverContent:
  // serverContent.inputTranscription / outputTranscription
  if (msg?.serverContent) {
    const sc = msg.serverContent;

    out.input =
      asText(sc?.inputTranscription) ||
      asText(sc?.inputTranscription?.text) ||
      asText(sc?.input_transcription) ||
      asText(sc?.input_transcription?.text) ||
      out.input;

    out.output =
      asText(sc?.outputTranscription) ||
      asText(sc?.outputTranscription?.text) ||
      asText(sc?.output_transcription) ||
      asText(sc?.output_transcription?.text) ||
      out.output;
  }

  // 2) Sometimes transcription appears top-level (SDK wrappers)
  out.input =
    out.input ||
    asText(msg?.inputTranscription) ||
    asText(msg?.inputTranscription?.text) ||
    asText(msg?.input_transcription) ||
    asText(msg?.input_transcription?.text);

  out.output =
    out.output ||
    asText(msg?.outputTranscription) ||
    asText(msg?.outputTranscription?.text) ||
    asText(msg?.output_transcription) ||
    asText(msg?.output_transcription?.text);

  // Trim
  out.input = (out.input || "").trim();
  out.output = (out.output || "").trim();
  return out;
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.meta = meta || {};
    this.ws = null;
    this.ready = false;
    this.closed = false;

    // prevent spam duplicates
    this._lastInputT = "";
    this._lastOutputT = "";
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

      // IMPORTANT:
      // - systemInstruction is a string in setup (not Content object). :contentReference[oaicite:2]{index=2}
      // - audio transcription configs exist in setup; config object has no fields. :contentReference[oaicite:3]{index=3}
      const setupMsg = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.VOICE_NAME_OVERRIDE || "Kore"
                }
              }
            }
          }
        }
      };

      // Enable transcription ONLY if requested (your env MB_LOG_TRANSCRIPTS=true)
      if (env.MB_LOG_TRANSCRIPTS) {
        setupMsg.setup.inputAudioTranscription = {};
        setupMsg.setup.outputAudioTranscription = {};
      }

      try {
        this.ws.send(JSON.stringify(setupMsg));
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", { ...this.meta, error: e.message });
      }
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      // (A) Transcriptions (logs)
      if (env.MB_LOG_TRANSCRIPTS) {
        const t = pickTranscriptsFromMsg(msg);

        if (t.input && t.input !== this._lastInputT) {
          this._lastInputT = t.input;
          logger.info("TRANSCRIPT user", { ...this.meta, text: t.input });
          if (this.onGeminiText) this.onGeminiText(`USER: ${t.input}`);
        }

        if (t.output && t.output !== this._lastOutputT) {
          this._lastOutputT = t.output;
          logger.info("TRANSCRIPT bot", { ...this.meta, text: t.output });
          if (this.onGeminiText) this.onGeminiText(`BOT: ${t.output}`);
        }
      }

      // (B) AUDIO: look for inlineData audio/pcm and convert to ulaw8k for Twilio
      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          msg?.serverContent?.parts ||
          [];

        for (const p of parts) {
          const inline = p?.inlineData;
          if (!inline || !inline?.data || !inline?.mimeType) continue;

          if (String(inline.mimeType).startsWith("audio/pcm")) {
            const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
            if (ulawB64 && this.onGeminiAudioUlaw8kBase64) {
              this.onGeminiAudioUlaw8kBase64(ulawB64);
            }
          }
        }
      } catch (e) {
        logger.debug("Gemini message audio parse error", { ...this.meta, error: e.message });
      }

      // (C) Optional text parts (debug only)
      if (env.MB_LOG_ASSISTANT_TEXT) {
        try {
          const parts =
            msg?.serverContent?.modelTurn?.parts ||
            msg?.serverContent?.turn?.parts ||
            msg?.serverContent?.parts ||
            [];

          for (const p of parts) {
            const txt = p?.text;
            if (txt) logger.info("ASSISTANT_TEXT", { ...this.meta, text: String(txt) });
          }
        } catch {}
      }
    });

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;
      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    // Twilio μ-law 8k -> PCM16k base64
    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    // Keep EXACTLY what already worked for your audio path:
    const msg = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: "audio/pcm;rate=16000",
            data: pcm16kB64
          }
        ]
      }
    };

    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      logger.debug("Failed sending audio to Gemini", { ...this.meta, error: e.message });
    }
  }

  endInput() {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    } catch {}
  }

  stop() {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {}
  }
}

module.exports = { GeminiLiveSession };
