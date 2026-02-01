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

function safeText(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function buildSystemInstructionContent({ ssot }) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const intents = Array.isArray(ssot?.intents) ? ssot.intents : [];

  const lines = [];

  lines.push("אתה בוט קולי טלפוני. דבר עברית כברירת מחדל, אלא אם המשתמש מבקש שפה אחרת.");
  lines.push("ענה בקצרה, טבעי, שירותי, בלי חפירות. שאל שאלת הבהרה אחת בכל פעם אם צריך.");
  lines.push("אם המשתמש מבקש 'עברית' – עברית. אם מבקש 'English' – אנגלית.");

  const businessName = settings.BUSINESS_NAME || settings.BRAND_NAME || "";
  if (businessName) lines.push(`המותג/עסק: ${businessName}`);

  if (intents.length) lines.push(`קיימים ${intents.length} אינטנטים מוגדרים ב-SSOT. עבוד לפיהם כאשר הם זמינים.`);

  if (prompts.TONE) lines.push(`הנחיית טון: ${safeText(prompts.TONE)}`);

  const text = lines.filter(Boolean).join("\n");
  return {
    role: "system",
    parts: [{ text }]
  };
}

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta, ssot }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;
    this.meta = meta || {};
    this.ssot = ssot || null;

    this.ws = null;
    this.ready = false;
    this.closed = false;
    this._setupSent = false;
    this._openingSent = false;
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("Gemini Live WS connected", this.meta);

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
          },

          ...(env.MB_LOG_TRANSCRIPTS
            ? {
                inputAudioTranscription: {},
                outputAudioTranscription: {}
              }
            : {}),

          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: Number(env.MB_VAD_PREFIX_MS || 200),
              silenceDurationMs: Number(env.MB_VAD_SILENCE_MS || 900)
            },
            ...(env.MB_BARGEIN_ENABLED ? { activityHandling: "START_OF_ACTIVITY_INTERRUPTS" } : {})
          },

          systemInstruction: buildSystemInstructionContent({ ssot: this.ssot })
        }
      };

      try {
        this.ws.send(JSON.stringify(setup));
        this._setupSent = true;
        this.ready = true;
      } catch (e) {
        logger.error("Failed to send Gemini setup", { ...this.meta, error: e.message });
        return;
      }

      // ✅ קריטי לדיליי: שולחים OPENING מיד אחרי setup, לא מחכים להודעה מהשרת.
      try {
        const opening = safeText(this.ssot?.prompts?.OPENING).trim();
        if (opening) {
          const openTurn = {
            clientContent: {
              turns: [
                {
                  role: "user",
                  parts: [{ text: opening }]
                }
              ],
              turnComplete: true
            }
          };
          this.ws.send(JSON.stringify(openTurn));
        }
        this._openingSent = true;
      } catch (e) {
        logger.debug("Failed to send OPENING", { ...this.meta, error: e.message });
        this._openingSent = true;
      }
    });

    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      // AUDIO
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

      // TEXT (optional)
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

      // TRANSCRIPTS
      try {
        const userT = msg?.serverContent?.inputTranscription?.text;
        if (userT && this.onTranscript) this.onTranscript({ who: "user", text: String(userT) });

        const botT = msg?.serverContent?.outputTranscription?.text;
        if (botT && this.onTranscript) this.onTranscript({ who: "bot", text: String(botT) });
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

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

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
