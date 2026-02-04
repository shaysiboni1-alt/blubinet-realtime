"use strict";

/**
 * STAGE 4 – Post-call Finalization Pipeline (isolated)
 *
 * Guarantees:
 * - Never throws (all exceptions are caught)
 * - CALL_LOG sent at most once (centralized here)
 * - FINAL and ABANDONED are mutually exclusive
 * - FINAL decision does NOT depend on transcript (only on lead fields captured during the call)
 * - Recording is best-effort and must not block webhook delivery
 */

function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function safeSplitWords(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function decideLead(lead) {
  const fullName = String(lead?.full_name || "").trim();
  const subject = String(lead?.subject || "").trim();
  const cb = String(lead?.callback_to_number || "").trim();
  const minWords = Number(lead?.subject_min_words || 3);

  if (!fullName) return { type: "ABANDONED", reason: "missing_name" };
  if (!subject || safeSplitWords(subject).length < minWords) {
    return { type: "ABANDONED", reason: "subject_too_short" };
  }
  if (!cb) return { type: "ABANDONED", reason: "missing_callback" };

  return { type: "FINAL", reason: "lead_complete" };
}

async function finalizePipeline({ snapshot, env, senders, logger }) {
  const log = logger || console;

  const safe = async (fn, label) => {
    try {
      return await fn();
    } catch (err) {
      log?.warn?.(`[STAGE4:${label}] failed`, { error: err?.message || String(err) });
      return null;
    }
  };

  // We call finalizePipeline ONLY at end-of-call. Therefore CALL_LOG is centralized here to avoid duplicates.
  const callLogEnabled = truthy(env?.CALL_LOG_AT_START) || truthy(env?.CALL_LOG_AT_END);
  const callLogMode = String(env?.CALL_LOG_MODE || "start").trim().toLowerCase(); // start|end|both

  const shouldSendCallLogNow = (() => {
    if (!callLogEnabled) return false;
    if (callLogMode === "none") return false;
    // Centralize: send once here at end regardless of mode to avoid double-send.
    return true;
  })();

  if (shouldSendCallLogNow && senders?.sendCallLog) {
    await safe(() => senders.sendCallLog({ ...snapshot, phase: "end" }), "CALL_LOG");
  }

  const decision = decideLead(snapshot?.lead || {});

  // Recording – best effort
  const recording = senders?.resolveRecording
    ? await safe(() => senders.resolveRecording(snapshot), "RECORDING")
    : null;

  if (decision.type === "FINAL" && senders?.sendFinal) {
    const payload = {
      event: "FINAL",
      call: snapshot?.call || {},
      lead: snapshot?.lead || {},
      decision_reason: decision.reason,
      recording_provider: recording?.recording_provider || "",
      recording_sid: recording?.recording_sid || "",
      recording_url_public: recording?.recording_url_public || ""
    };
    await safe(() => senders.sendFinal(payload), "FINAL");
  } else if (decision.type === "ABANDONED" && senders?.sendAbandoned) {
    const payload = {
      event: "ABANDONED",
      call: snapshot?.call || {},
      lead: snapshot?.lead || {},
      decision_reason: decision.reason,
      recording_provider: recording?.recording_provider || "",
      recording_sid: recording?.recording_sid || "",
      recording_url_public: recording?.recording_url_public || ""
    };
    await safe(() => senders.sendAbandoned(payload), "ABANDONED");
  }

  return { finalized: true, decision: decision.type, reason: decision.reason };
}

module.exports = { finalizePipeline, decideLead };
