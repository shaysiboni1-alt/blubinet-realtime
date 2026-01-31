// src/vendor/geminiLiveSession.js
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
  const out = { input: "", output: "" };

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

  out.input = (out.input || "").trim();
  out.output = (out.output || "").trim();
  return out;
}

function normalizeSpacing(s) {
  if (!s) return "";
  // fix common fragmentation: "של" "ום" -> "שלום" (best-effort, low risk for logs only)
  // We’ll just collapse multiple spaces and remove space before punctuation.
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:)\]])/g, "$1")
    .trim();
}

function endsSentence(s) {
  return /[.!?…]$/.test(s);
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.meta = meta || {};
    this.ws = null;
    this.ready = false;
    this.closed = false;

    // transcript buffers (logs-only)
    this._userBuf = "";
    this._botBuf = "";
    this._userFlushTimer = null;
    this._botFlushTimer = null;

    this._lastRawInput = "";
    this._lastRawOutput = "";
  }

  _flushUser() {
    if (!this._userBuf) return;
    const text = normalizeSpacing(this._userBuf);
    this._userBuf = "";
    if (!text) return;

    // Put the readable text in msg so Render logs UI shows it clearly
    logger.info(`TRANSCRIPT user: ${text}`, { ...this.meta });
    if (this.onGeminiText) this.onGeminiText(`USER: ${text}`);
  }

  _flushBot() {
    if (!this._botBuf) return;
    const text = normalizeSpacing(this._botBuf);
    this._botBuf = "";
    if (!text) return;

    logger.info(`TRANSCRIPT bot: ${text}`, { ...this.meta });
    if (this.onGeminiText) this.onGeminiText(`BOT: ${text}`);
  }

  _appendUserChunk(chunk) {
    const c = normalizeSpacing(chunk);
    if (!c) return;

    // If it’s a continuation fragment, add space unless it’s punctuation.
    if (this._userBuf && !/^[.,!?;:]/.test(c)) this._userBuf += " ";
    this._userBuf += c;

    if (this._userFlushTimer) clearTimeout(this._userFlushTimer);
    // flush quickly so you see near-realtime logs
    this._userFlushTimer = setTimeout(() => this._flushUser(), 350);
  }

  _appendBotChunk(chunk) {
    const c = normalizeSpacing(chunk);
    if (!c) return;

    if (this._botBuf && !/^[.,!?;:]/.test(c)) this._botBuf += " ";
    this._botBuf += c;

    if (endsSentence(c) || endsSentence(this._botBuf)) {
      if (this._botFlushTimer) clearTimeout(this._botFlushTimer);
      this._flushBot();
      return;
    }

    if (this._botFlushTimer) clearTimeout(this._botFlushTimer);
    this._botFlushTimer = setTimeout(() => this._flushBot(), 450);
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

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

      // Enable transcription only if requested
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

      // (A) Transcriptions (logs) — buffered and shown in msg
      if (env.MB_LOG_TRANSCRIPTS) {
        const t = pickTranscriptsFromMsg(msg);

        // De-dup raw repeats
        if (t.input && t.input !== this._lastRawInput) {
          this._lastRawInput = t.input;
          this._appendUserChunk(t.input);
        }

        if (t.output && t.output !== this._lastRawOutput) {
          this._lastRawOutput = t.output;
          this._appendBotChunk(t.output);
        }
      }

      // (B) AUDIO: inlineData audio/pcm -> ulaw8k back to Twilio
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

      // (C) Optional assistant text parts
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

      // flush any pending transcript buffers on close (logs-only)
      try {
        if (this._userFlushTimer) clearTimeout(this._userFlushTimer);
        if (this._botFlushTimer) clearTimeout(this._botFlushTimer);
        this._flushUser();
        this._flushBot();
      } catch {}

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
