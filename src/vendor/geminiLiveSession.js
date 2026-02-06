"use strict";

/*
  Stage 4 – Finalize Pipeline (GilSport parity)

  FINAL Lead =:
  - full_name
  - subject (>= SUBJECT_MIN_WORDS)
  - caller_id_e164 ALWAYS
  - callback_to_number (caller or additional or both)

  Webhooks:
  - CALL_LOG
  - FINAL
  - ABANDONED
*/

const { parseLeadPostcall } = require("./postcallLeadParser");

function isTrue(v) {
  return v === true || String(v).toLowerCase() === "true";
}

function safeStr(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

function secondsFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n / 1000);
}

function subjectValid(subject, minWords) {
  if (!subject) return false;
  return subject.trim().split(/\s+/).length >= minWords;
}

function buildPayloadBase(call, recording) {
  const payload = {
    callSid: safeStr(call.callSid),
    caller_id_e164: safeStr(call.caller),
    recording_provider: recording?.recording_provider || null,
    recording_sid: recording?.recording_sid || null,
    recording_url_public: recording?.recording_url_public || null
  };
  return payload;
}

function leadGate(lead, call, subjectMinWords) {
  if (!safeStr(lead.full_name)) return "missing_name";
  if (!subjectValid(lead.subject, subjectMinWords)) return "missing_subject";
  if (!safeStr(call.caller)) return "missing_caller_id";
  if (!safeStr(lead.callback_to_number)) return "missing_callback_number";
  return "ok";
}

async function finalizePipeline({ snapshot, ssot, env, logger, senders }) {
  const log = logger || console;

  const call = {
    callSid: snapshot?.call?.callSid || null,
    streamSid: snapshot?.call?.streamSid || null,
    caller: snapshot?.call?.caller || null,
    called: snapshot?.call?.called || null,
    started_at: snapshot?.call?.started_at || null,
    ended_at: snapshot?.call?.ended_at || null,
    duration_ms: snapshot?.call?.duration_ms ?? null,
    duration_sec: secondsFromMs(snapshot?.call?.duration_ms),
    finalize_reason: snapshot?.call?.finalize_reason || null
  };

  /* --------------------------------------------------
     1) CALL_LOG (idempotent, per ENV)
  -------------------------------------------------- */
  try {
    if (isTrue(env.CALL_LOG_AT_END) && env.CALL_LOG_WEBHOOK_URL) {
      await senders.sendCallLog({
        event_type: "CALL_LOG",
        call: {
          callSid: call.callSid,
          streamSid: call.streamSid,
          caller: call.caller,
          called: call.called,
          started_at: call.started_at,
          ended_at: call.ended_at,
          duration_ms: call.duration_ms,
          duration_sec: call.duration_sec,
          finalize_reason: call.finalize_reason
        }
      });
    }
  } catch (e) {
    log.warn("CALL_LOG failed", e?.message || e);
  }

  /* --------------------------------------------------
     2) Post-call parsing (LLM = enrichment בלבד)
  -------------------------------------------------- */
  let parsed = {};
  try {
    if (isTrue(env.LEAD_PARSER_ENABLED)) {
      parsed = await parseLeadPostcall({
        transcriptText:
          snapshot?.lead?.transcriptText ||
          snapshot?.transcriptText ||
          "",
        ssot,
        known: {
          full_name: safeStr(snapshot?.lead?.full_name),
          caller_id_e164: safeStr(call.caller)
        },
        env,
        logger: log
      }) || {};
    }
  } catch (e) {
    log.warn("Postcall parsing failed", e?.message || e);
  }

  /* --------------------------------------------------
     3) Build lead (GilSport priority)
        Runtime > Parser
  -------------------------------------------------- */
  const lead = {
    full_name:
      safeStr(snapshot?.lead?.full_name) ||
      safeStr(parsed.full_name),

    subject:
      safeStr(snapshot?.lead?.subject) ||
      safeStr(parsed.subject),

    callback_to_number:
      safeStr(snapshot?.lead?.callback_to_number) ||
      safeStr(parsed.phone_additional) ||
      safeStr(call.caller),

    phone_additional: safeStr(parsed.phone_additional) || null,
    parsing_summary: safeStr(parsed.parsing_summary) || null
  };

  /* --------------------------------------------------
     4) Resolve recording (best effort)
  -------------------------------------------------- */
  let recording = {
    recording_provider: null,
    recording_sid: null,
    recording_url_public: null
  };

  try {
    if (isTrue(env.MB_ENABLE_RECORDING)) {
      recording = await senders.resolveRecording(call.callSid);
    }
  } catch (e) {
    log.warn("Recording resolve failed", e?.message || e);
  }

  /* --------------------------------------------------
     5) FINAL xor ABANDONED
  -------------------------------------------------- */
  const subjectMinWords = Number(env.SUBJECT_MIN_WORDS || 3);
  const gateResult = leadGate(lead, call, subjectMinWords);

  const basePayload = buildPayloadBase(call, recording);

  if (gateResult === "ok" && isTrue(env.FINAL_ON_STOP)) {
    const finalPayload = {
      event_type: "FINAL",
      lead_decision: "FINAL",
      ...basePayload,
      full_name: lead.full_name,
      subject: lead.subject,
      callback_to_number: lead.callback_to_number,
      phone_additional: lead.phone_additional,
      parsing_summary: lead.parsing_summary
    };

    try {
      await senders.sendFinal(finalPayload);
    } catch (e) {
      log.error("FINAL webhook failed", e?.message || e);
    }

    return { status: "ok", event: "FINAL" };
  }

  const abandonedPayload = {
    event_type: "ABANDONED",
    lead_decision: "ABANDONED",
    ...basePayload,
    decision_reason: gateResult
  };

  try {
    await senders.sendAbandoned(abandonedPayload);
  } catch (e) {
    log.error("ABANDONED webhook failed", e?.message || e);
  }

  return { status: "ok", event: "ABANDONED" };
}

module.exports = { finalizePipeline };
