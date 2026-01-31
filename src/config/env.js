// src/config/env.js
"use strict";

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === "") {
    throw new Error(`Missing required ENV: ${name}`);
  }
  return String(v);
}

function optional(name, fallback = "") {
  const v = process.env[name];
  if (v === undefined || v === null) return fallback;
  return String(v);
}

function bool(name, fallback = "false") {
  const raw = optional(name, fallback).trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function num(name, fallback) {
  const raw = optional(name, fallback);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number ENV: ${name}`);
  return n;
}

function oneOf(name, allowed, fallback) {
  const v = optional(name, fallback).trim();
  if (!allowed.includes(v)) {
    throw new Error(`Invalid ENV ${name}="${v}". Allowed: ${allowed.join(", ")}`);
  }
  return v;
}

// ===== Canonical locked names (DO NOT CHANGE) =====

const env = Object.freeze({
  // Core
  PORT: num("PORT", "10000"),
  TIME_ZONE: required("TIME_ZONE"),
  PROVIDER_MODE: oneOf("PROVIDER_MODE", ["gemini", "openai"], "gemini"),
  PUBLIC_BASE_URL: optional("PUBLIC_BASE_URL", ""),

  // SSOT
  GSHEET_ID: required("GSHEET_ID"),
  GOOGLE_SERVICE_ACCOUNT_JSON_B64: required("GOOGLE_SERVICE_ACCOUNT_JSON_B64"),
  SSOT_TTL_MS: num("SSOT_TTL_MS", "60000"),

  // Webhooks
  CALL_LOG_WEBHOOK_URL: optional("CALL_LOG_WEBHOOK_URL", ""),
  FINAL_WEBHOOK_URL: optional("FINAL_WEBHOOK_URL", ""),
  ABANDONED_WEBHOOK_URL: optional("ABANDONED_WEBHOOK_URL", ""),

  // DB
  DATABASE_URL: required("DATABASE_URL"),

  // Gemini (provider)
  GEMINI_API_KEY: optional("GEMINI_API_KEY", ""),
  GEMINI_LIVE_MODEL: optional("GEMINI_LIVE_MODEL", ""),
  GEMINI_LOCATION: optional("GEMINI_LOCATION", ""),
  GEMINI_PROJECT_ID: optional("GEMINI_PROJECT_ID", ""),
  GEMINI_VERTEX_ENABLED: bool("GEMINI_VERTEX_ENABLED", "false"),
  GEMINI_AUDIO_IN_FORMAT: optional("GEMINI_AUDIO_IN_FORMAT", "ulaw8k"),
  GEMINI_AUDIO_OUT_FORMAT: optional("GEMINI_AUDIO_OUT_FORMAT", "ulaw8k"),

  // Twilio
  TWILIO_ACCOUNT_SID: required("TWILIO_ACCOUNT_SID"),
  TWILIO_AUTH_TOKEN: optional("TWILIO_AUTH_TOKEN", ""),

  // Voice / prompts
  VOICE_NAME_OVERRIDE: optional("VOICE_NAME_OVERRIDE", ""),

  // Lead parser / summary (locked names)
  LEAD_PARSER_ENABLED: bool("LEAD_PARSER_ENABLED", "true"),
  LEAD_PARSER_MODE: optional("LEAD_PARSER_MODE", "postcall"),
  LEAD_SUMMARY_STYLE: optional("LEAD_SUMMARY_STYLE", "crm_short"),

  // Silence prompts
  SILENCE_T1_MS: num("SILENCE_T1_MS", "5000"),
  SILENCE_T2_MS: num("SILENCE_T2_MS", "9000"),
  SILENCE_T3_MS: num("SILENCE_T3_MS", "14000"),
  SILENCE_PROMPT_1: optional("SILENCE_PROMPT_1", ""),
  SILENCE_PROMPT_2: optional("SILENCE_PROMPT_2", ""),
  SILENCE_PROMPT_3: optional("SILENCE_PROMPT_3", ""),

  // VAD / barge-in / logs (locked names)
  MB_DEBUG: bool("MB_DEBUG", "false"),
  MB_ENABLE_RECORDING: bool("MB_ENABLE_RECORDING", "true"),
  MB_LOG_ASSISTANT_TEXT: bool("MB_LOG_ASSISTANT_TEXT", "false"),
  MB_LOG_TRANSCRIPTS: bool("MB_LOG_TRANSCRIPTS", "true"),
  MB_LOG_TURNS: bool("MB_LOG_TURNS", "true"),
  MB_LOG_TURNS_MAX_CHARS: num("MB_LOG_TURNS_MAX_CHARS", "900"),

  MB_VAD_PREFIX_MS: num("MB_VAD_PREFIX_MS", "200"),
  MB_VAD_SILENCE_MS: num("MB_VAD_SILENCE_MS", "900"),
  MB_VAD_THRESHOLD: num("MB_VAD_THRESHOLD", "0.65"),

  MB_BARGEIN_ENABLED: bool("MB_BARGEIN_ENABLED", "true"),
  MB_BARGEIN_MIN_MS: num("MB_BARGEIN_MIN_MS", "250"),
  MB_BARGEIN_COOLDOWN_MS: num("MB_BARGEIN_COOLDOWN_MS", "600"),
  MB_BARGEIN_AUDIO_DROP_MS: num("MB_BARGEIN_AUDIO_DROP_MS", "0")
});

// Provider-specific strictness (רק בדיקות בסיסיות)
if (env.PROVIDER_MODE === "gemini") {
  // אם אתה עובד דרך Vertex: חייב GEMINI_PROJECT_ID + GEMINI_LOCATION
  if (env.GEMINI_VERTEX_ENABLED) {
    if (!env.GEMINI_PROJECT_ID) throw new Error("Missing required ENV for Vertex: GEMINI_PROJECT_ID");
    if (!env.GEMINI_LOCATION) throw new Error("Missing required ENV for Vertex: GEMINI_LOCATION");
  } else {
    // אם לא Vertex — לרוב תעבוד עם API Key
    if (!env.GEMINI_API_KEY) throw new Error("Missing required ENV for Gemini API: GEMINI_API_KEY");
  }
}

module.exports = { env };

