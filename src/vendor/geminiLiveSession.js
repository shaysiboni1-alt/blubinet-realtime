"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");

function normalizeModelName(m) {
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

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript; // (role, text)
    this.meta = meta || {};
    this.ws = null;
    this.ready = false;
    this.closed = false;
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();

    // IMPORTANT: Live WS may deliver frames that trigger UTF-8 validation failures.
    // We disable validation and handle binary frames safely.
    this.ws = new WebSocket(url, {
      perMessageDeflate: false,
      skipUTF8Validation: true
    });

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

      // Keep MVP stable: no system_instruction to avoid 1007.
      const setup = {
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

      try {
        this.ws.send(JSON.stringify(setup));
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", { ...this.meta, error: e.message });
      }
    });

    this.ws.on("message", (data, isBinary) => {
      // If Gemini sends binary frames, do NOT try to parse as UTF-8 JSON.
      if (isBinary) {
        // We ignore unknown binary frames to keep session alive.
        logger.debug("Gemini binary frame ignored", { ...this.meta, bytes: data?.length || 0 });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      // ---- 1) AUDIO ----
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
            // Gemini usually returns PCM base64 at 24k; convert to ulaw8k for Twilio
            const ulawB64 = pcm24kB64ToUlaw8kB64(inline.data);
            if (ulawB64 && this.onGeminiAudioUlaw8kBase64) {
              this.onGeminiAudioUlaw8kBase64(ulawB64);
            }
          }
        }
      } catch (e) {
        logger.debug("Gemini audio parse error", { ...this.meta, error: e.message });
      }

      // ---- 2) TEXT / TRANSCRIPTS ----
      // We keep it permissive: if text exists in parts, emit it.
      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          msg?.serverContent?.parts ||
          [];

        for (const p of parts) {
          const t = p?.text;
          if (!t) continue;

          if (this.onGeminiText) this.onGeminiText(String(t));

          // If caller wired transcript logger, treat model text as bot transcript
          if (this.onTranscript) this.onTranscript("bot", String(t));
        }
      } catch {}
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
