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

  // Live API WebSocket endpoint (API key)
  // wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=...
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    key
  )}`;
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;
    this.meta = meta || {};

    this.ws = null;
    this.ready = false;
    this.closed = false;

    this._setupSent = false;
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

      // חשוב: systemInstruction הוא STRING (לא Content)
      // כדי שלא נקבל 1007 על type mismatch. :contentReference[oaicite:1]{index=1}
      const systemInstruction =
        "את/ה עוזר/ת קולי/ת לעסקים. ברירת מחדל: עברית. אם הלקוח מדבר בשפה אחרת, ענה באותה שפה. " +
        "ענה בקצרה, שאל שאלת הבהרה אחת בכל פעם. אל תמציא פרטים.";

      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          systemInstruction,
          generationConfig: {
            // הכי חשוב לקול:
            responseModalities: ["AUDIO"],
            // קיצור latency: מגביל אורך תגובה
            maxOutputTokens: 160,
            // אפשר לכוונן:
            temperature: 0.4,
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
        this._setupSent = true;
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

      // 1) AUDIO output
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
        logger.debug("Gemini audio parse error", { ...this.meta, error: e.message });
      }

      // 2) TEXT parts (sometimes model emits text parts too)
      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          msg?.serverContent?.parts ||
          [];

        for (const p of parts) {
          const t = p?.text;
          if (t && this.onGeminiText) this.onGeminiText(String(t));
        }
      } catch {}

      // 3) Transcription (best effort)
      // הדוקס מגדיר שהודעות/אירועים מגיעים מהשרת; בפועל יש כמה צורות.
      // אנחנו אוספים כל מה שנראה כמו תמלול קלט/פלט בלי לשנות setup (כדי לא לשבור קול). :contentReference[oaicite:2]{index=2}
      try {
        // user transcript candidates
        const inT =
          msg?.serverContent?.inputTranscription?.text ||
          msg?.serverContent?.transcription?.text ||
          msg?.inputTranscription?.text ||
          null;

        if (inT && this.onTranscript) this.onTranscript("user", String(inT));

        // bot transcript candidates
        const outT =
          msg?.serverContent?.outputTranscription?.text ||
          msg?.serverContent?.modelTranscription?.text ||
          msg?.outputTranscription?.text ||
          null;

        if (outT && this.onTranscript) this.onTranscript("bot", String(outT));
      } catch {}
    });

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;

      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });

      // אם נסגר מיד אחרי חיבור – זה בדרך כלל setup בעייתי.
      // אל תנסה “אוטומטית” לשנות setup כאן כדי לא להיכנס ללופ שמשבש קול.
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    // Live API realtimeInput audioStream
    // לפי הדוקס: realtimeInput.audio הוא Blob, וגם audioStreamEnd אפשרי. :contentReference[oaicite:3]{index=3}
    const msg = {
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: pcm16kB64
        }
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
