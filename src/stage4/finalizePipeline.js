"use strict";

/**
 * Stage 4 – Finalize Pipeline (GilSport-style)
 * - Post-call LLM parsing (CRM-ready)
 * - Deterministic FINAL / ABANDONED
 * - Recording resolved AFTER call end
 * - Does NOT touch media / voice / realtime
 */

const fetch = global.fetch || require("node-fetch");

function nowIso() {
  return new Date().toISOString();
}

function safeStr(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function wordsCount(s) {
  return safeStr(s).split(/\s+/).filter(Boolean).length;
}

/**
 * Deterministic LeadGate (same philosophy as GilSport)
 */
function computeLeadGate(lead) {
  if (!lead) return { ok: false, reason: "missing_lead" };

  const name = safeStr(lead.full_name);
  const reason = safeStr(lead.reason);
  const notes = safeStr(lead.notes);

  if (!name || name.length < 2) {
    return { ok: false, reason: "missing_name" };
  }

  if (!reason && !notes) {
    return { ok: false, reason: "missing_reason" };
  }

  return { ok: true, reason: "lead_complete" };
}

/**
 * Run LLM Lead Parser (GilSport-style, post-call)
 */
async function runLeadParser({ env, prompt, transcriptText }) {
  if (!env.LEAD_PARSER_ENABLED) return null;
  if (!prompt) return null;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const model = env.LEAD_PARSER_MODEL || "gemini-1.5-flash";

  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text:
              prompt +
              "\n\nTRANSCRIPT:\n" +
              transcriptText
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 600
    }
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    const json = await resp.json();
    const text =
      json?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text)
        .join("") || "";

    const trimmed = text.trim();

    // Direct JSON
    if (trimmed.startsWith("{")) {
      return JSON.parse(trimmed);
    }

    // Fenced JSON
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m && m[1]) {
      return JSON.parse(m[1].trim());
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * FINALIZE PIPELINE – SINGLE ENTRY POINT
 */
async function finalizePipeline({
  snapshot,
  env,
  logger,
  senders,
  state
}) {
  if (state?.finalized) return;
  if (state) state.finalized = true;

  const call = snapshot.call || {};
  const transcriptArr = snapshot.transcript || [];

  const transcriptText = transcriptArr
    .map((t) => `${String(t.who || "").toUpperCase()}: ${t.text}`)
    .join("\n");

  // ------------------------------------------------------------
  // 1. Resolve Recording (AFTER call end, best-effort)
  // ------------------------------------------------------------
  let recording = {
    recording_provider: "",
    recording_sid: "",
    recording_url_public: ""
  };

  if (env.MB_ENABLE_RECORDING && senders?.resolveRecording) {
    try {
      const r = await senders.resolveRecording();
      if (r) {
        recording = {
          recording_provider: safeStr(r.recording_provider),
          recording_sid: safeStr(r.recording_sid),
          recording_url_public: safeStr(r.recording_url_public)
        };
      }
    } catch {}
  }

  // ------------------------------------------------------------
  // 2. LLM Parsing (GilSport style)
  // ------------------------------------------------------------
  let parsed = null;
  try {
    parsed = await runLeadParser({
      env,
      prompt: snapshot.ssot?.prompts?.LEAD_PARSER_PROMPT,
      transcriptText
    });
  } catch {}

  const lead = {
    full_name: parsed?.full_name ?? null,
    phone_number: parsed?.phone_number ?? null,
    prefers_caller_id: parsed?.prefers_caller_id ?? null,
    intent: parsed?.intent ?? "unknown",
    reason: parsed?.reason ?? "",
    notes: parsed?.notes ?? ""
  };

  // ------------------------------------------------------------
  // 3. LeadGate
  // ------------------------------------------------------------
  const gate = computeLeadGate(lead);

  // ------------------------------------------------------------
  // 4. Base Payload
  // ------------------------------------------------------------
  const basePayload = {
    call: {
      callSid: call.callSid,
      streamSid: call.streamSid,
      caller: call.caller,
      called: call.called,
      source: call.source,
      started_at: call.started_at,
      ended_at: call.ended_at,
      duration_ms: call.duration_ms,
      finalize_reason: call.finalize_reason || ""
    },
    lead: {
      ...lead,
      decision_reason: gate.reason
    },
    recording_provider: recording.recording_provider,
    recording_sid: recording.recording_sid,
    recording_url_public: recording.recording_url_public
  };

  // ------------------------------------------------------------
  // 5. CALL_LOG (always)
  // ------------------------------------------------------------
  try {
    if (senders?.sendCallLog) {
      await senders.sendCallLog({
        event: "CALL_LOG",
        ...basePayload
      });
    }
  } catch {}

  // ------------------------------------------------------------
  // 6. FINAL xor ABANDONED
  // ------------------------------------------------------------
  if (gate.ok) {
    try {
      if (senders?.sendFinal) {
        await senders.sendFinal({
          event: "FINAL",
          ...basePayload
        });
      }
    } catch {}
  } else {
    try {
      if (senders?.sendAbandoned) {
        await senders.sendAbandoned({
          event: "ABANDONED",
          ...basePayload
        });
      }
    } catch {}
  }
}

module.exports = { finalizePipeline };
