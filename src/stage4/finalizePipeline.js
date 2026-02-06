"use strict";

/**
 * Stage4 Finalize Pipeline (GilSport-style, adapted to VoiceBot_Blank baseline)
 *
 * Input (from vendor/geminiLiveSession.js):
 *   finalizePipeline({
 *     snapshot: {
 *       call: { callSid, streamSid, caller, called, source, started_at, ended_at, duration_ms, caller_withheld, finalize_reason, ... },
 *       lead: { full_name, subject, callback_to_number, subject_min_words, notes }
 *     },
 *     env,
 *     logger,
 *     senders: {
 *       sendCallLog(payload),
 *       sendFinal(payload),
 *       sendAbandoned(payload),
 *       resolveRecording(): { recording_provider, recording_sid, recording_url_public } (best-effort)
 *     }
 *   })
 *
 * Requirements (Locked):
 * - Only 3 webhooks: CALL_LOG / FINAL / ABANDONED
 * - FINAL lead means: name + subject + phone (identified or provided)
 * - caller (identified) must ALWAYS be included even if callback_to_number is different
 * - FINAL and ABANDONED are mutually exclusive (XOR)
 * - Recording metadata included in FINAL/ABANDONED whenever available
 * - Never throws outward (must not break voice)
 */

function safeStr(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || "";
}

function toBool(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function normalizePhoneLike(v) {
  const s = safeStr(v);
  if (!s) return "";
  if (s.startsWith("+")) return s;
  // allow raw digits (rare) but keep as-is
  return s;
}

function subjectMinWordsFrom(lead) {
  const n = Number(lead?.subject_min_words ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function subjectIsValid(subject, minWords) {
  const s = safeStr(subject);
  if (!s) return false;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= minWords) return true;

  // Allow certain short “call back” intents as a subject to avoid empty leads.
  // (matches what you already do in the vendor capture logic)
  if (/לחזור\s+אל(י|יי)|תחזור\s+אל(י|יי)|שיחזרו\s+אל(י|יי)|תתקשר(ו)?\s+אל(י|יי)/.test(s)) {
    return true;
  }
  return false;
}

function leadGate({ lead, call }) {
  // Locked definition:
  // FINAL = full_name + subject + phone (identified caller OR provided callback number).
  const name = safeStr(lead?.full_name);
  const subject = safeStr(lead?.subject);
  const caller = normalizePhoneLike(call?.caller);
  const callback = normalizePhoneLike(lead?.callback_to_number);

  if (!name) return { ok: false, reason: "missing_name" };

  const minWords = subjectMinWordsFrom(lead);
  if (!subjectIsValid(subject, minWords)) return { ok: false, reason: "missing_subject" };

  // "phone" requirement:
  // - caller (identified) always included when present
  // - callback_to_number must exist for FINAL (even if equals caller)
  // - if caller is withheld, callback must be provided
  if (!callback) return { ok: false, reason: "missing_callback_number" };

  // If caller exists (identified), we still require it to be included in payload,
  // but for gating we don't fail if caller is withheld/empty as long as callback exists.
  return { ok: true };
}

function buildCallPayload(call) {
  const c = call || {};
  return {
    callSid: safeStr(c.callSid) || "",
    streamSid: safeStr(c.streamSid) || "",
    caller_id_e164: normalizePhoneLike(c.caller) || "", // always include when present
    caller_withheld: !!c.caller_withheld,
    called: safeStr(c.called) || "",
    source: safeStr(c.source) || "",
    started_at: safeStr(c.started_at) || "",
    ended_at: safeStr(c.ended_at) || "",
    duration_ms: typeof c.duration_ms === "number" ? c.duration_ms : null,
    finalize_reason: safeStr(c.finalize_reason) || ""
  };
}

function mergeRecordingInto(payload, rec, fallback) {
  const p = payload || {};
  const r = rec || {};
  const f = fallback || {};

  const provider = safeStr(r.recording_provider) || safeStr(f.recording_provider) || "twilio";
  const sid = safeStr(r.recording_sid) || safeStr(f.recording_sid) || "";
  const pub = safeStr(r.recording_url_public) || safeStr(f.recording_url_public) || "";

  // Include only if we have at least sid or public url; otherwise keep nulls.
  p.recording_provider = sid || pub ? provider : null;
  p.recording_sid = sid || null;
  p.recording_url_public = pub || null;
  return p;
}

async function safeResolveRecording(senders) {
  try {
    if (!senders?.resolveRecording) return null;
    const rec = await senders.resolveRecording();
    return rec || null;
  } catch {
    return null;
  }
}

async function safeSend(fn, payload) {
  try {
    if (typeof fn !== "function") return;
    await fn(payload);
  } catch {
    // swallow: never break voice
  }
}

async function finalizePipeline({ snapshot, env, logger, senders }) {
  const log = logger || console;
  const s = snapshot || {};
  const call = s.call || {};
  const lead = s.lead || {};

  // ---- Idempotency guard (XOR) - vendor already guards, but keep safe
  // We intentionally do NOT maintain global state here (stateless finalize).
  // The vendor ensures single call via this._call.finalized.

  // ---- Build base payload
  const callPayload = buildCallPayload(call);

  // Optional notes/transcript: do NOT push full transcript into CRM payload by default.
  // Keep it as a debug field only if required (currently NOT requested).
  // We'll keep "notes" out of FINAL/ABANDONED payload to match GilSport CRM-short intent.
  const leadPayload = {
    full_name: safeStr(lead.full_name) || "",
    subject: safeStr(lead.subject) || "",
    callback_to_number: normalizePhoneLike(lead.callback_to_number) || ""
  };

  // ---- Decide FINAL vs ABANDONED (GilSport XOR)
  const gate = leadGate({ lead, call: callPayload });

  // ---- CALL_LOG semantics
  // Your baseline currently triggers CALL_LOG via senders.sendCallLog in vendor.
  // Here we honor env flags but keep it safe: if both start/end enabled in env,
  // vendor should have already done start; we do end only when CALL_LOG_AT_END=true.
  const callLogAtEnd = toBool(env?.CALL_LOG_AT_END);
  if (callLogAtEnd) {
    await safeSend(senders?.sendCallLog, {
      event_type: "CALL_LOG",
      ...callPayload
    });
  }

  // ---- Recording: best effort resolve and attach to FINAL/ABANDONED payload
  const recResolved = await safeResolveRecording(senders);
  // Fallback from snapshot if present (some implementations may include it later)
  const recFallback = {
    recording_provider: "twilio",
    recording_sid: safeStr(s?.call?.recording_sid) || safeStr(s?.lead?.recording_sid) || "",
    recording_url_public: safeStr(s?.call?.recording_url_public) || safeStr(s?.lead?.recording_url_public) || ""
  };

  if (gate.ok) {
    // FINAL payload (GilSport structure)
    const payload = {
      event_type: "FINAL",
      lead_decision: "FINAL",
      ...callPayload,
      ...leadPayload,

      // Locked rule: identified caller must ALWAYS be included even if callback differs
      // (already included as caller_id_e164)
      // callback_to_number is the requested callback target (may be same/different)
    };

    mergeRecordingInto(payload, recResolved, recFallback);

    // Safety: if caller is present, ensure it is not lost even if callback differs
    if (!payload.caller_id_e164) payload.caller_id_e164 = normalizePhoneLike(call?.caller) || "";

    await safeSend(senders?.sendFinal, payload);
    return { ok: true, event: "FINAL" };
  }

  // ABANDONED payload
  const payload = {
    event_type: "ABANDONED",
    lead_decision: "ABANDONED",
    ...callPayload,
    decision_reason: gate.reason || "abandoned"
  };

  mergeRecordingInto(payload, recResolved, recFallback);

  // Always keep caller_id_e164 if exists
  if (!payload.caller_id_e164) payload.caller_id_e164 = normalizePhoneLike(call?.caller) || "";

  await safeSend(senders?.sendAbandoned, payload);

  // Do not throw; log minimal
  try {
    log.info?.("Finalize complete", { callSid: callPayload.callSid, event: "ABANDONED", reason: payload.decision_reason });
  } catch {}

  return { ok: true, event: "ABANDONED" };
}

module.exports = { finalizePipeline };
