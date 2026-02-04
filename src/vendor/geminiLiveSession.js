"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { detectIntent } = require("../logic/intentRouter");
const { normalizeUtterance } = require("../logic/hebrewNlp");

// Optional (exists in your repo). We use it if present, but do not depend on it for core flow.
let passiveCallContext = null;
try {
  // eslint-disable-next-line global-require
  passiveCallContext = require("../logic/passiveCallContext");
} catch { /* ignore */ }

// -----------------------------------------------------------------------------
// Helpers (non-breaking, Stage4 additions are isolated)
// -----------------------------------------------------------------------------

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

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function applyTemplate(tpl, vars) {
  const s = safeStr(tpl);
  if (!s) return "";
  return s.replace(/\{([A-Z0-9_]+)\}/g, (_, key) => {
    const v = vars?.[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

function buildSettingsContext(settings) {
  const keys = Object.keys(settings || {}).sort();
  const lines = keys.map((k) => `${k}: ${safeStr(settings[k])}`);
  return lines.join("\n").trim();
}

function buildIntentsContext(intents) {
  const rows = Array.isArray(intents) ? intents.slice() : [];

  rows.sort((a, b) => {
    const pa = Number(a?.priority ?? 0);
    const pb = Number(b?.priority ?? 0);
    if (pb !== pa) return pb - pa;
    return String(a?.intent_id ?? "").localeCompare(String(b?.intent_id ?? ""));
  });

  const lines = rows.map((it) => {
    const id = safeStr(it.intent_id);
    const type = safeStr(it.intent_type);
    const pr = Number(it.priority ?? 0) || 0;
    const he = safeStr(it.triggers_he);
    const en = safeStr(it.triggers_en);
    const ru = safeStr(it.triggers_ru);
    return `- ${id} | type=${type} | priority=${pr} | triggers_he=${he} | triggers_en=${en} | triggers_ru=${ru}`;
  });

  return lines.join("\n").trim();
}

function buildSystemInstructionFromSSOT(ssot) {
  const settings = ssot?.settings || {};
  const prompts = ssot?.prompts || {};
  const intents = ssot?.intents || [];

  const defaultLang = safeStr(settings.DEFAULT_LANGUAGE) || "he";

  const sections = [];

  sections.push(
    [
      "IDENTITY (NON-NEGOTIABLE):",
      "- You are NOT a generic model and must NEVER describe yourself as an AI/LLM/model.",
      "- You are the business phone assistant defined by SETTINGS and PROMPTS.",
      "- Speak naturally and briefly.",
      "- Prefer Hebrew by default unless the caller requests otherwise."
    ].join("\n")
  );

  const master = safeStr(prompts.MASTER_PROMPT);
  const guardrails = safeStr(prompts.GUARDRAILS_PROMPT);
  const kb = safeStr(prompts.KB_PROMPT);
  const lead = safeStr(prompts.LEAD_CAPTURE_PROMPT);
  const intentRouter = safeStr(prompts.INTENT_ROUTER_PROMPT);

  if (master) sections.push(`MASTER_PROMPT:\n${master}`);
  if (guardrails) sections.push(`GUARDRAILS_PROMPT:\n${guardrails}`);
  if (kb) sections.push(`KB_PROMPT:\n${kb}`);
  if (lead) sections.push(`LEAD_CAPTURE_PROMPT:\n${lead}`);
  if (intentRouter) sections.push(`INTENT_ROUTER_PROMPT:\n${intentRouter}`);

  const settingsContext = buildSettingsContext(settings);
  if (settingsContext) sections.push(`SETTINGS_CONTEXT (SOURCE OF TRUTH):\n${settingsContext}`);

  const intentsContext = buildIntentsContext(intents);
  if (intentsContext) sections.push(`INTENTS_TABLE:\n${intentsContext}`);

  sections.push(
    [
      "LANGUAGE POLICY:",
      `- default_language=${defaultLang}`,
      "- If the caller speaks another supported language (he/en/ru), switch to it.",
      "- If the caller uses an unsupported language, apologize briefly and ask to continue in Hebrew/English/Russian."
    ].join("\n")
  );

  return sections.filter(Boolean).join("\n\n---\n\n").trim();
}

function computeGreetingHebrew(timeZone) {
  const tz = timeZone || "Asia/Jerusalem";

  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false
  }).format(new Date());

  const hour = Number(hourStr);
  if (Number.isNaN(hour)) return "שלום";

  if (hour >= 5 && hour < 11) return "בוקר טוב";
  if (hour >= 11 && hour < 17) return "צהריים טובים";
  if (hour >= 17 && hour < 22) return "ערב טוב";
  return "לילה טוב";
}

function getOpeningScriptFromSSOT(ssot, vars) {
  const settings = ssot?.settings || {};
  const tpl = safeStr(settings.OPENING_SCRIPT) || "שלום! איך נוכל לעזור?";

  const merged = {
    BUSINESS_NAME: safeStr(settings.BUSINESS_NAME),
    BOT_NAME: safeStr(settings.BOT_NAME),
    CALLER_NAME: safeStr(vars?.CALLER_NAME),
    MAIN_PHONE: safeStr(settings.MAIN_PHONE),
    BUSINESS_EMAIL: safeStr(settings.BUSINESS_EMAIL),
    BUSINESS_ADDRESS: safeStr(settings.BUSINESS_ADDRESS),
    WORKING_HOURS: safeStr(settings.WORKING_HOURS),
    BUSINESS_WEBSITE_URL: safeStr(settings.BUSINESS_WEBSITE_URL),
    VOICE_NAME: safeStr(settings.VOICE_NAME),
    GREETING: safeStr(vars?.GREETING),
    ...vars
  };

  const filled = applyTemplate(tpl, merged).trim();
  return filled || "שלום! איך נוכל לעזור?";
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (low === "anonymous" || low === "restricted" || low === "unavailable" || low === "unknown") {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t0 = (text || "").trim();
  if (!t0) return "";

  const t = t0.replace(/[\u200f\u200e]/g, "").replace(/\s+/g, " ").trim();

  // Avoid false positives: if it's clearly a request, not a name.
  const bad = /(אני\s*רוצה|צריך|מבקש|תשלח|דוחות|רווח|הפסד|מס\s*הכנסה|בעיה|תקלה|שירות|מחיר|הצעה)/;
  if (bad.test(t)) return "";

  const m1 = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  const candidate = (m1 && m1[1] ? m1[1] : t).trim();

  let c = candidate.replace(/["'“”‘’]/g, "").replace(/[()\[\]{}]/g, "").trim();
  c = c.replace(/^(אה+|אממ+|אז|טוב)[, ]*/g, "").trim();
  c = c.replace(/[,.!?]+$/g, "").trim();

  if (!/^[A-Za-z\u0590-\u05FF ]{2,40}$/.test(c)) return "";
  const parts = c.split(" ").filter(Boolean);
  if (parts.length > 3) return "";
  if (parts.some((p) => p.length < 2 || p.length > 20)) return "";

  return c;
}

function extractPhone(text) {
  const digits = (text || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return `+${digits}`;
    if (digits.startsWith("0") && digits.length === 10) return `+972${digits.slice(1)}`;
    return digits;
  }
  return "";
}

function isTruthyEnv(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Stage4: Webhooks + Recording + LeadGate + Post-call LeadParser
// (Implemented inside the session to avoid touching ws/twilioMediaWs.js)
// -----------------------------------------------------------------------------

async function deliverWebhookDirect(eventType, payload) {
  const map = {
    CALL_LOG: env.CALL_LOG_WEBHOOK_URL,
    FINAL: env.FINAL_WEBHOOK_URL,
    ABANDONED: env.ABANDONED_WEBHOOK_URL
  };
  const url = map[eventType];
  if (!url) return;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    logger.info("Webhook delivered", { eventType, status: resp.status, attempt: 1 });
  } catch (e) {
    logger.warn("Webhook delivery failed", { eventType, error: String(e) });
  }
}

async function twilioStartRecording(callSid) {
  if (!callSid) return "";
  if (!isTruthyEnv(env.MB_ENABLE_RECORDING)) return "";
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return "";

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

    const body = new URLSearchParams();
    body.set("RecordingStatusCallbackEvent", "completed");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization:
          "Basic " +
          Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    const j = await safeJson(resp);
    const sid = j?.sid ? String(j.sid) : "";
    return sid;
  } catch (e) {
    logger.warn("Twilio startRecording failed", { callSid, error: String(e) });
    return "";
  }
}

function twilioPublicRecordingUrl(recordingSid) {
  if (!recordingSid) return "";
  const baseUrl = safeStr(env.PUBLIC_BASE_URL) || "";
  if (!baseUrl) return "";
  // your server already can expose /recordings/:sid publicly (or you can add it later);
  // we keep the contract stable.
  return `${baseUrl.replace(/\/+$/, "")}/recordings/${recordingSid}`;
}

async function twilioHangup(callSid) {
  if (!callSid) return;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return;

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Calls/${encodeURIComponent(callSid)}.json`;

    const body = new URLSearchParams();
    body.set("Status", "completed");

    await fetch(url, {
      method: "POST",
      headers: {
        authorization:
          "Basic " +
          Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"),
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });
  } catch (e) {
    logger.warn("Twilio hangup failed", { callSid, error: String(e) });
  }
}

function shouldTriggerHangup(botText, ssot) {
  const t = (botText || "").trim();
  if (!t) return false;

  // Fast path
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  // Match explicit closers from SETTINGS
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => String(settings[k] || "").trim())
    .filter(Boolean);

  return closers.some((c) => t.startsWith(c.slice(0, Math.min(18, c.length))));
}

async function runLeadParserLLM({ ssot, transcriptText, callMeta }) {
  if (!isTruthyEnv(env.LEAD_PARSER_ENABLED)) return null;

  const prompt = safeStr(ssot?.prompts?.LEAD_PARSER_PROMPT);
  const system = prompt || "Return JSON only. Summarize the call for CRM. No hallucinations.";
  const key = env.GEMINI_API_KEY;
  if (!key) return null;

  // Default model for text parsing. You can override via ENV without breaking anything.
  const model = safeStr(env.LEAD_PARSER_MODEL) || "gemini-1.5-flash";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `SYSTEM:\n${system}\n\n` +
                `CALL_META:\n${JSON.stringify(callMeta)}\n\n` +
                `TRANSCRIPT:\n${transcriptText}`
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 512
      }
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    const j = await safeJson(resp);
    const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const trimmed = String(txt || "").trim();

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }

    // Some models wrap JSON in markdown; strip minimal fences.
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m && m[1]) {
      const inner = m[1].trim();
      if (inner.startsWith("{") || inner.startsWith("[")) return JSON.parse(inner);
    }
  } catch (e) {
    logger.warn("LeadParser LLM failed", { error: String(e) });
  }

  return null;
}
function buildDeterministicLeadSummary({ transcriptItems, callMeta, state }) {
  const items = Array.isArray(transcriptItems) ? transcriptItems : [];

  const userUtterances = items
    .filter((x) => (x.who || x.role) === "user")
    .map((x) => (x.normalized || x.text || "").trim())
    .filter(Boolean);

  // Remove the first utterance if it seems to be just the name
  const cleaned = userUtterances.filter((u, i) => {
    const s = u.replace(/[,.!?]+$/g, "").trim();
    if (i === 0 && state?.name && s.includes(state.name)) return false;
    if (s.length <= 2) return false;
    return true;
  });

  const request = cleaned.join(" ").replace(/\s+/g, " ").trim();

  return {
    summary: request.slice(0, 260),
    request: request.slice(0, 260),
    callback_number: safeStr(state?.callback_number) || "",
    caller_withheld: Boolean(state?.caller_withheld),
    intent_last: safeStr(state?.intent_last),
    meta: {
      callSid: safeStr(callMeta?.callSid),
      started_at: safeStr(callMeta?.started_at),
      ended_at: safeStr(callMeta?.ended_at)
    }
  };
}

function buildLeadNotes(summaryObj) {
  const parts = [];
  const req = safeStr(summaryObj?.request || summaryObj?.summary);
  if (req) parts.push(`פנייה: ${req}`);
  const cb = safeStr(summaryObj?.callback_number);
  if (cb) parts.push(`חזרה למספר: ${cb}`);
  return parts.join(" | ").trim();
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

class GeminiLiveSession {
  constructor({ onGeminiAudioUlaw8kBase64, onGeminiText, onTranscript, meta, ssot }) {
    this.onGeminiAudioUlaw8kBase64 = onGeminiAudioUlaw8kBase64;
    this.onGeminiText = onGeminiText;
    this.onTranscript = onTranscript;

    this.meta = meta || {};
    this.ssot = ssot || {};

    this.ws = null;
    this.ready = false;
    this.closed = false;

    this._greetingSent = false;

    // Transcript aggregation (so logs are readable)
    this._trBuf = { user: "", bot: "" };
    this._trLastChunk = { user: "", bot: "" };
    this._trTimer = { user: null, bot: null };

    // Stage4 call state
    const callerInfo = normalizeCallerId(this.meta?.caller || "");
    this._call = {
      callSid: safeStr(this.meta?.callSid),
      streamSid: safeStr(this.meta?.streamSid),
      source: safeStr(this.meta?.source) || "VoiceBot_Blank",
      caller_raw: callerInfo.value,
      caller_withheld: callerInfo.withheld,
      called: safeStr(this.meta?.called),
      started_at: nowIso(),
      ended_at: null,
      duration_ms: 0,
      name: "",
      has_request: false,
      callback_number: callerInfo.withheld ? "" : callerInfo.value,
      transcript: [],
      recordingSid: "",
      recording_url_public: "",
      closing_initiated: false,
      finalized: false
    };
  }

  start() {
    if (this.ws) return;

    const url = liveWsUrl();
    this.ws = new WebSocket(url);

    this.ws.on("open", async () => {
      logger.info("Gemini Live WS connected", this.meta);

      // Stage4: CALL_LOG at start (optional)
      if (isTruthyEnv(env.CALL_LOG_AT_START ?? true)) {
        await deliverWebhookDirect("CALL_LOG", {
          event: "CALL_LOG",
          phase: "start",
          call: {
            callSid: this._call.callSid,
            streamSid: this._call.streamSid,
            caller: this._call.caller_raw,
            called: this._call.called,
            source: this._call.source,
            started_at: this._call.started_at,
            caller_withheld: this._call.caller_withheld
          }
        });
      }

      // Stage4: start recording (best-effort)
      this._call.recordingSid = await twilioStartRecording(this._call.callSid);
      this._call.recording_url_public = twilioPublicRecordingUrl(this._call.recordingSid);

      const systemText = buildSystemInstructionFromSSOT(this.ssot);

      const setup = {
        setup: {
          model: normalizeModelName(env.GEMINI_LIVE_MODEL),
          systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,

          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: env.VOICE_NAME_OVERRIDE || safeStr(this.ssot?.settings?.VOICE_NAME) || "Kore"
                }
              }
            }
          },

          realtimeInputConfig: {
            automaticActivityDetection: {
              prefixPaddingMs: Number(env.MB_VAD_PREFIX_MS ?? 200),
              silenceDurationMs: Number(env.MB_VAD_SILENCE_MS ?? 900)
            }
          },

          ...(env.MB_LOG_TRANSCRIPTS ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {})
        }
      };

      try {
        this.ws.send(JSON.stringify(setup));
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

      if (msg?.setupComplete && !this._greetingSent) {
        this._greetingSent = true;
        this._sendProactiveOpening();
        return;
      }

      // AUDIO from Gemini -> Twilio
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
        logger.debug("Gemini message parse error", { ...this.meta, error: e.message });
      }

      // Optional text parts
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
      } catch { /* ignore */ }

      // Transcriptions (aggregated)
      try {
        const inTr = msg?.serverContent?.inputTranscription?.text;
        if (inTr) this._onTranscriptChunk("user", String(inTr));

        const outTr = msg?.serverContent?.outputTranscription?.text;
        if (outTr) this._onTranscriptChunk("bot", String(outTr));
      } catch { /* ignore */ }
    });

    this.ws.on("close", async (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf8") : "";
      this.closed = true;
      this.ready = false;

      // flush pending transcript buffers
      this._flushTranscript("user");
      this._flushTranscript("bot");

      logger.info("Gemini Live WS closed", { ...this.meta, code, reason });

      // Stage4: ensure finalize even if Twilio closes WS unexpectedly
      await this._finalizeOnce("ws_close");
    });

    this.ws.on("error", (err) => {
      logger.error("Gemini Live WS error", { ...this.meta, error: err.message });
    });
  }

  _onTranscriptChunk(who, chunk) {
    if (!env.MB_LOG_TRANSCRIPTS) return;

    const c = chunk || "";
    if (!c) return;

    // Ignore exact duplicates
    if (c === this._trLastChunk[who]) return;
    this._trLastChunk[who] = c;

    // Append chunk, cap size
    this._trBuf[who] = (this._trBuf[who] + c).slice(-800);

    // Debounce flush so you get one readable line per utterance-ish
    if (this._trTimer[who]) clearTimeout(this._trTimer[who]);
    this._trTimer[who] = setTimeout(() => this._flushTranscript(who), 450);
  }

  _flushTranscript(who) {
    if (!env.MB_LOG_TRANSCRIPTS) return;

    if (this._trTimer[who]) {
      clearTimeout(this._trTimer[who]);
      this._trTimer[who] = null;
    }

    const text = (this._trBuf[who] || "").trim();
    this._trBuf[who] = "";
    if (!text) return;

    // Hebrew Normalization + light NLP (deterministic)
    const nlp = normalizeUtterance(text);

    logger.info(`UTTERANCE ${who}`, {
      ...this.meta,
      text: nlp.raw,
      normalized: nlp.normalized,
      lang: nlp.lang
    });

    // Deterministic intent log (use normalized)
    if (who === "user") {
      const intent = detectIntent({
        text: nlp.normalized || nlp.raw,
        intents: this.ssot?.intents || []
      });

      logger.info("INTENT_DETECTED", {
        ...this.meta,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
        intent
      });
    }

    // Stage4: accumulate transcript + LeadGate
    try {
      this._call.transcript.push({
        who,
        text: nlp.raw,
        normalized: nlp.normalized,
        lang: nlp.lang,
        ts: nowIso()
      });

      if (who === "user") {
        // Capture name early
        if (!this._call.name) {
          const name = extractNameHe(nlp.normalized || nlp.raw);
          if (name) this._call.name = name;
        } else {
          // After name exists, mark that caller has a request
          const body = (nlp.normalized || nlp.raw || "").trim();
          if (body.length >= 6) this._call.has_request = true;

          // Capture callback number if caller withheld
          if (this._call.caller_withheld && !this._call.callback_number) {
            const phone = extractPhone(nlp.normalized || nlp.raw);
            if (phone) this._call.callback_number = phone;
          }
        }
      }

      if (who === "bot") {
        // Proactive hangup after closing
        if (!this._call.closing_initiated && shouldTriggerHangup(nlp.raw, this.ssot)) {
          this._call.closing_initiated = true;
          setTimeout(() => {
            twilioHangup(this._call.callSid).catch(() => {});
          }, 900);
        }
      }
    } catch (e) {
      logger.debug("Stage4 transcript accumulation failed", { error: String(e) });
    }

    // Backward-compatible callback
    if (this.onTranscript) this.onTranscript({ who, text: nlp.raw, normalized: nlp.normalized, lang: nlp.lang });
  }

  _sendProactiveOpening() {
    if (!this.ws || this.closed || !this.ready) return;

    const tz = env.TIME_ZONE || "Asia/Jerusalem";
    const greeting = computeGreetingHebrew(tz);

    const opening = getOpeningScriptFromSSOT(this.ssot, { GREETING: greeting });

    const userKickoff =
      `התחילי שיחה עכשיו. אמרי בדיוק את טקסט הפתיחה הבא בעברית (ללא תוספות וללא שינויים), ואז עצרי להקשבה:\n` +
      opening;

    const msg = {
      clientContent: {
        turns: [{ role: "user", parts: [{ text: userKickoff }] }],
        turnComplete: true
      }
    };

    try {
      this.ws.send(JSON.stringify(msg));
      logger.info("Proactive opening sent", { ...this.meta, greeting, opening_len: opening.length });
    } catch (e) {
      logger.debug("Failed sending proactive opening", { ...this.meta, error: e.message });
    }
  }

  sendUlaw8kFromTwilio(ulaw8kB64) {
    if (!this.ws || this.closed || !this.ready) return;

    const pcm16kB64 = ulaw8kB64ToPcm16kB64(ulaw8kB64);

    const msg = {
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: pcm16kB64 }]
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
    } catch { /* ignore */ }
  }

  async _finalizeOnce(reason) {
    if (this._call.finalized) return;
    this._call.finalized = true;

    try {
      this._call.ended_at = nowIso();
      this._call.duration_ms = Date.now() - new Date(this._call.started_at).getTime();

      const transcriptText = this._call.transcript
        .map((x) => `${String(x.who || "").toUpperCase()}: ${x.text}`)
        .join("\n");

      const leadComplete = Boolean(this._call.name && this._call.has_request);
      const eventType = leadComplete ? "FINAL" : "ABANDONED";

      const callMeta = {
        callSid: this._call.callSid,
        streamSid: this._call.streamSid,
        caller: this._call.caller_raw,
        called: this._call.called,
        source: this._call.source,
        started_at: this._call.started_at,
        ended_at: this._call.ended_at,
        duration_ms: this._call.duration_ms,
        caller_withheld: this._call.caller_withheld,
        recording_provider: this._call.recordingSid ? "twilio" : "",
        recording_sid: this._call.recordingSid || "",
        recording_url_public: this._call.recording_url_public || "",
        finalize_reason: reason || ""
      };

      // optional: use passiveCallContext if present (non-breaking)
      if (passiveCallContext?.buildPassiveContext) {
        try {
          callMeta.passive_context = passiveCallContext.buildPassiveContext({
            meta: this.meta,
            ssot: this.ssot
          });
        } catch { /* ignore */ }
      }

      // CALL_LOG at end (optional) so you get duration even if you keep start log
      if (isTruthyEnv(env.CALL_LOG_AT_END ?? false)) {
        await deliverWebhookDirect("CALL_LOG", { event: "CALL_LOG", phase: "end", call: callMeta });
      }

      let leadParser = null;
      if (leadComplete && safeStr(env.LEAD_PARSER_MODE || "postcall") === "postcall") {
        leadParser = await runLeadParserLLM({ ssot: this.ssot, transcriptText, callMeta });
        if (!leadParser) {
          leadParser = buildDeterministicLeadSummary({ transcriptItems: this.state.transcript, callMeta, state: this.state });
        }
      }

      const summaryObj =
  leadParser || buildDeterministicLeadSummary({ transcriptItems: this.state.transcript, callMeta, state: this.state });

const leadNotes = buildLeadNotes(summaryObj);

const payload = {
  event: eventType,
  call: {
    ...callMeta,
    ...(isTruthyEnv(env.MB_INCLUDE_TRANSCRIPT_IN_WEBHOOK ?? false) ? { transcript: transcriptText } : {})
  },
  lead: {
    name: this.state.name || "",
    phone: this.state.callback_number || "",
    notes: leadNotes,
    lead_parser: summaryObj
  }
};

await deliverWebhookDirect(eventType, payload);
    } catch (e) {
      logger.warn("Finalize failed", { error: String(e) });
    }
  }

  stop() {
    // Stage4: finalize first, then close Gemini WS.
    // This is intentionally "best effort" and must NOT block call teardown.
    this._finalizeOnce("stop_called").catch(() => {});

    if (!this.ws) return;
    try {
      this.ws.close();
    } catch { /* ignore */ }
  }
}

module.exports = { GeminiLiveSession };
