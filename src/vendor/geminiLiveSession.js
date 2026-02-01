const { createGeminiLiveClient } = require("../providers/geminiLiveWs");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { getSSOT } = require("../ssot/ssotClient");
const { logger } = require("../utils/logger");
const env = require("../config/env");

function isMostlyHebrew(text) {
  const s = String(text || "");
  if (!s) return false;
  const heb = (s.match(/[\u0590-\u05FF]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  // If there's a lot more Hebrew than Latin, treat as Hebrew.
  return heb >= 4 && heb >= latin;
}

function looksLikeMetaOrMarkdown(text) {
  const s = String(text || "").trim();
  if (!s) return false;
  // Common meta/markdown patterns we want to suppress from logs
  if (s.startsWith("**") || s.includes("```") || s.includes("#") || s.includes("**")) return true;
  // English narration patterns
  if (/[A-Za-z]{4,}/.test(s) && !isMostlyHebrew(s)) return true;
  if (s.includes("I've ") || s.includes("I have ") || s.includes("Now, I'm") || s.includes("I've processed")) return true;
  return false;
}

function truncateText(text, max = 500) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class GeminiLiveSession {
  constructor({ streamSid, callSid, systemPromptText, onAudioUlaw8kB64, onTranscript, onGeminiText }) {
    this.streamSid = streamSid;
    this.callSid = callSid;
    this.systemPromptText = systemPromptText || "";
    this.onAudioUlaw8kB64 = onAudioUlaw8kB64;
    this.onTranscript = onTranscript;
    this.onGeminiText = onGeminiText;
    this.client = null;
  }

  async start() {
    // Ensure SSOT is loaded (best-effort); prompt builder relies on it upstream.
    await getSSOT();

    this.client = createGeminiLiveClient({
      callSid: this.callSid,
      streamSid: this.streamSid,
      systemPromptText: this.systemPromptText,
    });

    this.client.ws.onGeminiEvent = (msg) => {
      // Audio output
      try {
        const parts = msg?.serverContent?.modelTurn?.parts || [];
        for (const p of parts) {
          const inline = p?.inlineData;
          if (!inline?.data) continue;

          // Gemini audio output is typically PCM 24k
          const ulaw8kB64 = pcm24kB64ToUlaw8kB64(String(inline.data));
          if (ulaw8kB64 && this.onAudioUlaw8kB64) this.onAudioUlaw8kB64(ulaw8kB64);
        }
      } catch {}

      // Optional text parts (avoid meta noise)
      try {
        const parts =
          msg?.serverContent?.modelTurn?.parts ||
          msg?.serverContent?.turn?.parts ||
          [];

        for (const p of parts) {
          const raw = p?.text;
          if (!raw) continue;

          const s = String(raw);

          // Only log assistant text when explicitly enabled, and only if it's likely
          // to be actual user-facing Hebrew speech (not English narration / markdown).
          if (!env.MB_LOG_ASSISTANT_TEXT) continue;
          if (looksLikeMetaOrMarkdown(s)) continue;
          if (!isMostlyHebrew(s)) continue;

          if (this.onGeminiText) this.onGeminiText(truncateText(s, 400));
        }
      } catch {}

      // Transcriptions (best-effort)
      try {
        const inTr =
          msg?.serverContent?.inputTranscription?.text ||
          msg?.serverContent?.inputTranscription?.transcript ||
          null;

        if (inTr) {
          const t = String(inTr);
          if (env.MB_LOG_TRANSCRIPTS) {
            logger.info(`TRANSCRIPT user: ${truncateText(t, 500)}`, {
              streamSid: this.streamSid,
              callSid: this.callSid,
            });
          }
          if (this.onTranscript) this.onTranscript({ who: "user", text: t });
        }

        const outTr =
          msg?.serverContent?.outputTranscription?.text ||
          msg?.serverContent?.outputTranscription?.transcript ||
          null;

        if (outTr) {
          const t = String(outTr);
          if (env.MB_LOG_TRANSCRIPTS) {
            logger.info(`TRANSCRIPT bot: ${truncateText(t, 500)}`, {
              streamSid: this.streamSid,
              callSid: this.callSid,
            });
          }
          if (this.onTranscript) this.onTranscript({ who: "bot", text: t });
        }
      } catch {}
    };
  }

  sendAudioUlaw8kB64(ulaw8kB64) {
    if (!this.client) return;
    this.client.sendAudioUlaw8kB64(ulaw8kB64);
  }

  close() {
    try {
      this.client?.close();
    } catch {}
  }
}

module.exports = { GeminiLiveSession };
