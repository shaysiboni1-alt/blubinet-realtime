"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { ulaw8kB64ToPcm16kB64, pcm24kB64ToUlaw8kB64 } = require("./twilioGeminiAudio");
const { detectIntent } = require("../logic/intentRouter");
const { normalizeUtterance } = require("../logic/hebrewNlp");
const { finalizePipeline } = require("../logic/finalizePipeline");

// Optional (exists in your repo). We use it if present, but do not depend on it for core flow.
let passiveCallContext = null;
try {
  // eslint-disable-next-line global-require
  passiveCallContext = require("../logic/passiveCallContext");
} catch { /* ignore */ }

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x).trim();
}

function nowIso() {
  return new Date().toISOString();
}

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

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (low === "anonymous" || low === "restricted" || low === "unavailable" || low === "unknown" || low === "private") {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = (text || "").trim();
  if (!t) return "";

  // If user says only the "prefix" without a name -> reject.
  const pseudo = new Set(["השם שלי", "שמי", "אני", "קוראים לי", "השם שלי זה"]);
  if (pseudo.has(t)) return "";

  // "קוראים לי X", "השם שלי (זה) X", "שמי X", "אני X"
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) {
    const cand = m[1].trim();
    if (pseudo.has(cand)) return "";
    if (cand.length >= 2 && cand.length <= 40 && !cand.match(/[0-9]/)) return cand;
  }

  // fallback: if it's short and looks like a name (Hebrew/letters, not just generic words)
  if (t.length <= 20 && !t.match(/[0-9]/)) {
    if (t.match(/^[\p{L}][\p{L}\s'’-]{1,19}$/u) && !pseudo.has(t)) return t;
  }

  return "";
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

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Webhooks (direct)
// -----------------------------------------------------------------------------

async function deliverWebhookDirect(label, url, payload) {
  if (!url) return;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    logger.info("Webhook delivered", { label, status: resp.status });
  } catch (e) {
    logger.warn("Webhook delivery failed", { label, error: String(e) });
  }
}

// -----------------------------------------------------------------------------
// Twilio Recording (best-effort + resolve)
// -----------------------------------------------------------------------------

function twilioAuthHeader() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return "";
  return (
    "Basic " +
    Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")
  );
}

async function twilioStartRecording(callSid) {
  if (!callSid) return "";
  if (!truthy(env.MB_ENABLE_RECORDING)) return "";
  const auth = twilioAuthHeader();
  if (!auth) return "";

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
      env.TWILIO_ACCOUNT_SID
    )}/Calls/${encodeURIComponent(callSid)}/Recordings.json`;

    const body = new URLSearchParams();
    // Minimal: start recording now
    body.set("RecordingChannels", "dual");

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: auth,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    });

    const j = await safeJson(resp);
    const sid = j?.sid ? String(j.sid) : "";
    logger.info("Twilio recording start", { callSid, status: resp.status, recordingSid: sid || "" });
    return sid;
  } catch (e) {
    logger.warn("Twilio startRecording failed", { callSid, error: String(e) });
    return "";
  }
}

async function twilioResolveRecordingByCallSid(callSid) {
  if (!callSid) return "";
  if (!truthy(env.MB_ENABLE_RECORDING)) re
