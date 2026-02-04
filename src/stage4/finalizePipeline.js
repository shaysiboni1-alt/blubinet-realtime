"use strict";

/**
 * Stage 4 – Canonical Call Finalization
 * FINAL / ABANDONED decision is deterministic and transcript-independent
 */

function nowIso() {
  return new Date().toISOString();
}

function wordsCount(s) {
  return String(s || "").trim().split(/\s+/).filter(Boolean).length;
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v);
}

function computeLeadGate(lead) {
  const name = safeStr(lead.full_name);
  const subject = safeStr(lead.subject);
  const phone = safeStr(lead.callback_to_number);

  if (!name || name.length < 2) {
    return { ok: false, reason: "missing_name" };
  }

  const minWords = Number(lead.subject_min_words || 3);
  if (!subject || wordsCount(subject) < minWords) {
    return { ok: false, reason: "missing_subject" };
  }

  if (!phone) {
    return { ok: false, reason: "missing_phone" };
  }

  return { ok: true, reason: "lead_complete" };
}

/**
 * finalizeCall – SINGLE SOURCE OF TRUTH
 */
async function finalizeCall({
  reason,
  callState,
  env,
  logger,
  senders
}) {
  // ------------------------------------------------------------
  // 0. Guard – run exactly once
  // ------------------------------------------------------------
  if (callState.finalized) {
    logger?.debug?.("finalizeCall: already finalized");
    return;
  }
  callState.finalized = true;

  // ------------------------------------------------------------
  // 1. Close timing
  // ------------------------------------------------------------
  const endedAt = nowIso();
  callState.ended_at = endedAt;

  const durationMs =
    Date.now() - new Date(callState.started_at).getTime();

  // ------------------------------------------------------------
  // 2. Resolve recording (best-effort, blocking)
  // ------------------------------------------------------------
  let recording = {
    recording_provider: "",
    recording_sid: "",
    recording_url_public: ""
  };

  if (env.MB_ENABLE_RECORDING && senders?.resolveRecording) {
    try {
      const r = await senders.resolveRecording();
      if (r && typeof r === "object") {
        recording = {
          recording_provider: safeStr(r.recording_provider),
          recording_sid: safeStr(r.recording_sid),
          recording_url_public: safeStr(r.recording_url_public)
        };
      }
    } catch (e) {
      logger?.warn?.("Recording resolve failed", { error: String(e) });
    }
  }

  // ------------------------------------------------------------
  // 3. LeadGate – deterministic decision
  // ------------------------------------------------------------
  const gate = computeLeadGate(callState.lead);

  // ------------------------------------------------------------
  // 4. Build base payload
  // ------------------------------------------------------------
  const basePayload = {
    event: null,

    call: {
      callSid: callState.callSid,
      streamSid: callState.streamSid,
      caller: callState.caller,
      called: callState.called,
      source: callState.source,

      caller_withheld: !!callState.caller_withheld,

      started_at: callState.started_at,
      ended_at: endedAt,
      duration_ms: durationMs,

      finalize_reason: safeStr(reason)
    },

    lead: {
      ...callState.lead,
      decision_reason: gate.reason
    },

    recording_provider: recording.recording_provider,
    recording_sid: recording.recording_sid,
    recording_url_public: recording.recording_url_public
  };

  // ------------------------------------------------------------
  // 5. CALL_LOG – always
  // ------------------------------------------------------------
  try {
    if (senders?.sendCallLog) {
      await senders.sendCallLog({
        ...basePayload,
        event: "CALL_LOG"
      });
    }
  } catch (e) {
    logger?.warn?.("CALL_LOG webhook failed", { error: String(e) });
  }

  // ------------------------------------------------------------
  // 6. FINAL xor ABANDONED
  // ------------------------------------------------------------
  if (gate.ok) {
    // FINAL
    try {
      if (senders?.sendFinal) {
        await senders.sendFinal({
          ...basePayload,
          event: "FINAL"
        });
      }
    } catch (e) {
      logger?.warn?.("FINAL webhook failed", { error: String(e) });
    }
  } else {
    // ABANDONED
    try {
      if (senders?.sendAbandoned) {
        await senders.sendAbandoned({
          ...basePayload,
          event: "ABANDONED"
        });
      }
    } catch (e) {
      logger?.warn?.("ABANDONED webhook failed", { error: String(e) });
    }
  }
}

module.exports = { finalizeCall };
