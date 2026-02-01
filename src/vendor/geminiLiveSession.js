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
  // IMPORTANT:
  // Live API expects setup.systemInstruction as Content (not a raw string).
  // Content shape: { role: "system", parts: [{ text: "..." }] }
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const intents = Array.isArray(ssot?.intents) ? ssot.intents : [];

  // מינימום "לא לשבור קול": אנחנו נותנים System Instruction קצר/נקי,
  // עם מקום להרחבה בהמשך.
  const lines = [];

  // שפה/התנהגות בסיסית
  lines.push("אתה בוט קולי טלפוני. דבר עברית כברירת מחדל, אלא אם המשתמש מבקש שפה אחרת.");
  lines.push("ענה בקצרה, טבעי, שירותי, בלי חפירות. שאל שאלת הבהרה אחת בכל פעם אם צריך.");
  lines.push("אם המשתמש מבקש 'עברית' – עברית. אם מבקש 'English' – אנגלית.");

  // SSOT SETTINGS (רק מה שקיים)
  // אם יש לך מפתחות סטנדרטיים אצלך בשיטס (לדוגמה BUSINESS_NAME), זה ייכנס אוטומטית.
  const businessName = settings.BUSINESS_NAME || settings.BRAND_NAME || "";
  if (businessName) lines.push(`המותג/עסק: ${businessName}`);

  // אינטנטים – כרגע רק תזכורת לקיום (נחבר Router מלא בשלב הבא)
  if (intents.length) lines.push(`קיימים ${intents.length} אינטנטים מוגדרים ב-SSOT. עבוד לפיהם כאשר הם זמינים.`);

  // PROMPTS רלוונטיים (לא דוחפים את הכל)
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

          // תמלול (רק אם ביקשתם ב-ENV)
          ...(env.MB_LOG_TRANSCRIPTS
            ? {
                inputAudioTranscription: {},
                outputAudioTranscription: {}
              }
            : {}),

          // VAD/BARGE-IN (רק שדות "בטוחים" שתואמים לדוקומנטציה)
          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: Number(env.MB_VAD_PREFIX_MS || 200),
              silenceDurationMs: Number(env.MB_VAD_SILENCE_MS || 900)
            },
            ...(env.MB_BARGEIN_ENABLED
              ? { activityHandling: "START_OF_ACTIVITY_INTERRUPTS" }
              : {})
          },

          // SSOT → System Instruction בפורמט Content (לא מחרוזת)
          systemInstruction: buildSystemInstructionContent({ ssot: this.ssot })
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

      // אחרי setup מוצלח – שולחים OPENING מה-SSOT פעם אחת (אם קיים)
      // זה יגרום לבוט לדבר "פתיח" אמיתי.
      try {
        if (this.ready && this._setupSent && !this._openingSent) {
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
            this._openingSent = true;
          } else {
            this._openingSent = true; // אין opening בשיטס, לא ננסה שוב
          }
        }
      } catch {}

      // 1) AUDIO: מחפשים inlineData audio/pcm וממירים ל-ulaw8k לטוויליו
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

      // 2) TEXT (אופציונלי)
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

      // 3) TRANSCRIPTS (אם מופיעים)
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

    // Twilio μ-law 8k -> PCM16k base64
    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    // Live API realtimeInput audio (הפורמט החדש; לא mediaChunks)
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
