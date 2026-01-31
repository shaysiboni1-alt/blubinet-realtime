// src/vendor/geminiLiveSession.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;

    this.streamSid = null;
    this.callSid = null;
    this.customParameters = {};

    this._geminiWs = null;
    this._started = false;
    this._setupAck = false;
    this._stopping = false;

    // small buffer until setup completes
    this._pendingAudio = [];
  }

  async start() {
    if (this._started) return;
    this._started = true;

    if (!env.GEMINI_API_KEY) {
      throw new Error("Missing GEMINI_API_KEY");
    }
    if (!env.GEMINI_LIVE_MODEL) {
      throw new Error("Missing GEMINI_LIVE_MODEL");
    }

    // Live API WS endpoint (v1beta)
    // Docs: wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent :contentReference[oaicite:2]{index=2}
    const url =
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      `?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

    const ws = new WebSocket(url, {
      perMessageDeflate: false,
      handshakeTimeout: 15000,
      maxPayload: 16 * 1024 * 1024,
    });

    this._geminiWs = ws;

    ws.on("open", () => {
      logger.info("Gemini Live WS connected", { callSid: this.callSid, streamSid: this.streamSid });

      // IMPORTANT:
      // setup.systemInstruction is STRING (not Content object) and field name is camelCase. :contentReference[oaicite:3]{index=3}
      const systemInstruction = this._buildSystemInstruction();

      const setupMsg = {
        setup: {
          model: this._normalizeModel(env.GEMINI_LIVE_MODEL),
          systemInstruction,
          generationConfig: {
            responseModalities: ["AUDIO"],
            // low-latency defaults; you can tune later
            temperature: 0.4,
          },
        },
      };

      ws.send(JSON.stringify(setupMsg));
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        // sometimes servers can send non-json, ignore
        return;
      }

      // setupComplete ack
      if (msg?.setupComplete) {
        this._setupAck = true;

        // flush pending audio
        const pending = this._pendingAudio;
        this._pendingAudio = [];
        for (const b64 of pending) this._sendRealtimeAudio(b64);

        return;
      }

      // serverContent: can contain modelTurn parts incl audio inlineData
      const serverContent = msg?.serverContent;
      if (serverContent?.modelTurn?.parts?.length) {
        for (const part of serverContent.modelTurn.parts) {
          // audio chunk
          if (part?.inlineData?.data && part?.inlineData?.mimeType) {
            const mime = part.inlineData.mimeType;

            // We expect PCM back (often 24k). Convert -> ulaw8k for Twilio.
            // If mime includes rate=24000 => convert accordingly (this helper assumes 24k PCM16 LE).
            if (mime.startsWith("audio/pcm")) {
              const b64Pcm = part.inlineData.data;
              const b64Ulaw = pcm24kB64ToUlaw8kB64(b64Pcm);
              if (b64Ulaw) this.onGeminiAudioUlaw8kBase64(b64Ulaw);
            }
          }

          // sometimes text is returned as well
          if (typeof part?.text === "string" && part.text.trim()) {
            this.onGeminiText(part.text);
          }
        }
      }

      // toolCall / etc can come later; ignore for MVP
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      logger.info("Gemini Live WS closed", {
        callSid: this.callSid,
        streamSid: this.streamSid,
        code,
        reason,
      });
    });

    ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { error: err.message });
    });
  }

  pushTwilioUlaw8k(twilioUlawB64) {
    if (!this._geminiWs) return;
    if (this._stopping) return;

    // Twilio ulaw8k base64 -> PCM16k base64
    const pcm16kB64 = ulaw8kB64ToPcm16kB64(twilioUlawB64);
    if (!pcm16kB64) return;

    if (!this._setupAck) {
      // buffer until setupComplete
      this._pendingAudio.push(pcm16kB64);
      if (this._pendingAudio.length > 50) this._pendingAudio.shift(); // cap
      return;
    }

    this._sendRealtimeAudio(pcm16kB64);
  }

  _sendRealtimeAudio(pcm16kB64) {
    const ws = this._geminiWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // realtimeInput.audio is Blob (mimeType+data) :contentReference[oaicite:4]{index=4}
    const msg = {
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: pcm16kB64,
        },
      },
    };

    ws.send(JSON.stringify(msg));
  }

  async stop(reason) {
    if (this._stopping) return;
    this._stopping = true;

    logger.info("Session cleanup", {
      reason,
      streamSid: this.streamSid,
      callSid: this.callSid,
    });

    try {
      if (this._geminiWs && this._geminiWs.readyState === WebSocket.OPEN) {
        // tell server audio stream ended (optional)
        this._geminiWs.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    } catch {}

    try {
      if (this._geminiWs) this._geminiWs.close();
    } catch {}

    this._geminiWs = null;
  }

  _normalizeModel(modelEnv) {
    // Accept either "models/..." or raw name
    if (modelEnv.startsWith("models/")) return modelEnv;
    return `models/${modelEnv}`;
  }

  _buildSystemInstruction() {
    // MVP: keep it minimal. We’ll later inject SSOT prompts, languages, lead rules, closing hangup, etc.
    // NOTE: Live API expects STRING here. :contentReference[oaicite:5]{index=5}
    return [
      "You are a Hebrew phone voice assistant for a business.",
      "Be concise and natural.",
      "Ask one question at a time.",
    ].join(" ");
  }
}

module.exports = { GeminiLiveSession };
