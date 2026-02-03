"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");

// ----------------------------
// Helpers
// ----------------------------

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  if (x === undefined || x === null) return "";
  return String(x);
}

function normalizeCallerId(raw) {
  const s = safeStr(raw).trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (low === "anonymous" || low === "restricted" || low === "unavailable" || low === "unknown") {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = safeStr(text).trim();
  if (!t) return "";
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();
  if (t.length <= 25 && !t.match(/[0-9]/)) return t.replace(/^אה+[, ]*/g, "").trim();
  return "";
}

function extractPhone(text) {
  const digits = safeStr(text).replace(/\D/g, "");
  if (!digits) return "";
  // IL heuristics
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return "+" + digits;
    if (digits.startsWith("0") && digits.length === 10) return "+972" + digits.slice(1);
    // fallback: already +972... or other
    return digits.startsWith("+") ? digits : digits;
  }
  return "";
}

function shouldTriggerHangup(botText, ssot) {
  const t = safeStr(botText).trim();
  if (!t) return false;
  if (t.includes("תודה") && t.includes("להתראות")) return true;

  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => safeStr(settings[k]).trim())
    .filter(Boolean);

  return closers.some((c) => {
    if (!c) return false;
    const head = c.slice(0, Math.min(18, c.length));
    return t.startsWith(head);
  });
}

async function twilioFetchJson({ method, url, form }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) return null;

  const headers = {
    authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
  };

  let body;
  if (form && (method === "POST" || method === "PUT")) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }

  try {
    const res = await fetch(url, { method, headers, body });
    const txt = await res.text();
    let json;
    try {
      json = JSON.parse(txt);
    } catch {
      json = null;
    }
    if (!res.ok) {
      logger.warn("Twilio API non-200", { url, status: res.status, body: txt.slice(0, 500) });
      return null;
    }
    return json;
  } catch (e) {
    logger.warn("Twilio API error", { url, error: e.message });
    return null;
  }
}

async function hangupCall(callSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !callSid) return;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    sid
  )}/Calls/${encodeURIComponent(callSid)}.json`;

  await twilioFetchJson({ method: "POST", url, form: { Status: "completed" } });
}

async function fetchRecordingForCall(callSid) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  if (!sid || !callSid) return { recordingSid: "", recording_url_public: "" };

  // List recordings filtered by CallSid
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    sid
  )}/Recordings.json?CallSid=${encodeURIComponent(callSid)}&PageSize=20`;

  const j = await twilioFetchJson({ method: "GET", url });
  const rec = j?.recordings?.[0];
  const recordingSid = rec?.sid ? String(rec.sid) : "";

  // Public-ish URL pattern (mp3). Access depends on Twilio auth,
  // but this is the canonical media endpoint to store.
  const recording_url_public = recordingSid
    ? `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
        sid
      )}/Recordings/${encodeURIComponent(recordingSid)}.mp3`
    : "";

  return { recordingSid, recording_url_public };
}

async function runLeadParserPostcall({ ssot, call, transcriptText }) {
  const enabled = String(process.env.LEAD_PARSER_ENABLED || "").toLowerCase() === "true";
  const mode = String(process.env.LEAD_PARSER_MODE || "").toLowerCase();
  if (!enabled) return null;
  if (mode && mode !== "postcall") return null;

  // If there is no API key, we still return deterministic summary
  const key = env.GEMINI_API_KEY;
  const model = String(process.env.LEAD_PARSER_MODEL || "gemini-1.5-flash").trim();
  const style = String(process.env.LEAD_SUMMARY_STYLE || "crm_short").trim();

  // Build a strict instruction (SSOT may add details if you later want)
  const instruction =
    (ssot?.prompts?.LEAD_PARSER_PROMPT && String(ssot.prompts.LEAD_PARSER_PROMPT).trim()) ||
    `Return JSON only. Style=${style}. No hallucinations.`;

  const userText =
    `SYSTEM:\n${instruction}\n\n` +
    `CALL:\n${JSON.stringify(call)}\n\n` +
    `TRANSCRIPT:\n${transcriptText}\n\n` +
    `Return JSON with keys: subject, request, details, summary, next_step.`;

  if (!key) {
    // deterministic fallback
    return {
      subject: "",
      request: "",
      details: "",
      summary: transcriptText.slice(0, 600),
      next_step: "",
      _fallback: true,
    };
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent?key=${encodeURIComponent(key)}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const j = await res.json().catch(() => null);
    const txt =
      j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    const trimmed = String(txt || "").trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }

    // fallback if model didn't obey JSON-only
    return {
      subject: "",
      request: "",
      details: "",
      summary: trimmed.slice(0, 800),
      next_step: "",
      _non_json: true,
    };
  } catch (e) {
    logger.warn("LeadParser failed", { error: e.message });
    return {
      subject: "",
      request: "",
      details: "",
      summary: transcriptText.slice(0, 600),
      next_step: "",
      _error: true,
    };
  }
}

// ----------------------------
// Main WS install
// ----------------------------

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/twilio-media-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });

  wss.on("connection", async (twilioWs) => {
    logger.info("Twilio media WS connected");

    const ssot = await loadSSOT(false).catch(() => null);

    let streamSid = null;
    let callSid = null;

    // Call state
    const state = {
      started_at: null,
      started_ms: null,
      ended_at: null,
      duration_ms: 0,

      caller_raw: "",
      caller_withheld: true,
      called: "",
      source: "VoiceBot_Blank",

      name: "",
      callback_number: "",
      has_request: false,

      transcript: [], // array of {role,text,normalized,lang,ts}
      closing_initiated: false,

      recording_sid: "",
      recording_url_public: "",
    };

    function sendToTwilioMedia(ulaw8kBase64) {
      // Gemini -> Twilio
      try {
        twilioWs.send(JSON.stringify({ event: "media", media: { payload: ulaw8kBase64 } }));
      } catch {}
    }

    function transcriptToText(list) {
      return list
        .map((x) => `${String(x.role || "").toUpperCase()}: ${safeStr(x.text)}`)
        .join("\n")
        .trim();
    }

    async function sendCallLogEnd({ finalize_reason }) {
      if (!callSid || !streamSid) return;

      const payload = {
        event: "CALL_LOG",
        phase: "end",
        call: {
          callSid,
          streamSid,
          caller: state.caller_raw,
          called: state.called,
          source: state.source,
          started_at: state.started_at,
          ended_at: state.ended_at,
          duration_ms: state.duration_ms,
          caller_withheld: state.caller_withheld,
          recording_provider: state.recording_sid ? "twilio" : "",
          recording_sid: state.recording_sid || "",
          recording_url_public: state.recording_url_public || "",
          finalize_reason: finalize_reason || "",
        },
      };

      await deliverWebhook("CALL_LOG", payload, logger);
    }

    async function finalizeCall({ finalize_reason }) {
      // idempotent
      if (!state.started_ms) return;

      state.ended_at = nowIso();
      state.duration_ms = Math.max(0, nowMs() - state.started_ms);

      // Try to fetch recording at end (it may appear after a short delay)
      if (String(process.env.MB_ENABLE_RECORDING || "").toLowerCase() === "true") {
        const rec = await fetchRecordingForCall(callSid);
        state.recording_sid = rec.recordingSid || "";
        state.recording_url_public = rec.recording_url_public || "";
      }

      await sendCallLogEnd({ finalize_reason });

      const transcriptText = transcriptToText(state.transcript);

      const leadComplete = Boolean(state.name && state.has_request);
      const eventType = leadComplete ? "FINAL" : "ABANDONED";

      const callPayload = {
        callSid,
        streamSid,
        caller: state.caller_raw,
        called: state.called,
        source: state.source,
        started_at: state.started_at,
        ended_at: state.ended_at,
        duration_ms: state.duration_ms,
        caller_withheld: state.caller_withheld,
        recording_provider: state.recording_sid ? "twilio" : "",
        recording_sid: state.recording_sid || "",
        recording_url_public: state.recording_url_public || "",
        finalize_reason: finalize_reason || "",
        // keep full transcript for debugging/auditing, not for CRM notes
        transcript: transcriptText,
      };

      let lead_parser = null;
      if (leadComplete) {
        lead_parser = await runLeadParserPostcall({
          ssot,
          call: callPayload,
          transcriptText,
        });
      }

      // CRM-friendly notes
      const notesParts = [];
      if (lead_parser?.subject) notesParts.push(`נושא: ${lead_parser.subject}`);
      if (lead_parser?.request) notesParts.push(`מה הלקוח צריך: ${lead_parser.request}`);
      if (lead_parser?.details) notesParts.push(`פרטים: ${lead_parser.details}`);
      if (lead_parser?.summary) notesParts.push(`סיכום: ${lead_parser.summary}`);
      if (lead_parser?.next_step) notesParts.push(`המשך טיפול: ${lead_parser.next_step}`);

      const notes = notesParts.filter(Boolean).join("\n").trim();

      const leadPayload = {
        name: state.name || "",
        phone: state.callback_number || "",
        notes: notes || "",
        lead_parser: lead_parser || null,
      };

      await deliverWebhook(eventType, { event: eventType, call: callPayload, lead: leadPayload }, logger);
    }

    let gemini = null;

    twilioWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }

      const ev = msg?.event;

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;

        const customParameters = msg?.start?.customParameters || {};
        const callerRaw = customParameters?.caller || "";
        const called = customParameters?.called || "";
        const source = customParameters?.source || "VoiceBot_Blank";

        const callerInfo = normalizeCallerId(callerRaw);

        state.started_at = nowIso();
        state.started_ms = nowMs();

        state.caller_raw = callerInfo.value || callerRaw || "";
        state.caller_withheld = callerInfo.withheld;
        state.called = called || "";
        state.source = source || "VoiceBot_Blank";
        state.callback_number = state.caller_withheld ? "" : (state.caller_raw || "");

        logger.info("Twilio stream start", { streamSid, callSid, customParameters });

        // Start Gemini
        gemini = new GeminiLiveSession({
          meta: {
            streamSid,
            callSid,
            caller: state.caller_raw,
            called: state.called,
            source: state.source,
          },
          ssot,
          onGeminiAudioUlaw8kBase64: (ulawB64) => sendToTwilioMedia(ulawB64),
          onGeminiText: (t) => logger.debug("Gemini text", { streamSid, callSid, t }),
          onTranscript: ({ who, text, normalized, lang }) => {
            const role = who === "bot" ? "bot" : "user";
            const entry = {
              role,
              text: safeStr(text),
              normalized: safeStr(normalized || ""),
              lang: safeStr(lang || ""),
              ts: nowIso(),
            };

            state.transcript.push(entry);

            // keep your existing readable transcript logs
            logger.info(`TRANSCRIPT ${who}`, { streamSid, callSid, text: safeStr(text) });

            if (role === "user") {
              // name gate
              if (!state.name) {
                const name = extractNameHe(entry.normalized || entry.text);
                if (name) state.name = name;
              } else {
                // once we have a name, any meaningful user input marks "has_request"
                if ((entry.normalized || entry.text).trim().length >= 4) {
                  state.has_request = true;
                }
              }

              // callback number if caller withheld
              if (state.caller_withheld && !state.callback_number) {
                const p = extractPhone(entry.normalized || entry.text);
                if (p) state.callback_number = p;
              }
            }

            if (role === "bot") {
              // proactive hangup after closing (non-negotiable rule)
              if (!state.closing_initiated && shouldTriggerHangup(entry.text, ssot)) {
                state.closing_initiated = true;
                setTimeout(() => {
                  hangupCall(callSid).catch(() => {});
                }, 900);
              }
            }
          },
        });

        gemini.start();
        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (b64 && gemini) gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });

        try {
          if (gemini) {
            gemini.endInput();
            gemini.stop();
          }
        } catch {}

        // FINAL/ABANDONED + CALL_LOG(end) are decided strictly here.
        await finalizeCall({ finalize_reason: "stop_called" }).catch((e) => {
          logger.error("Finalize failed", { error: e.message });
        });

        return;
      }

      if (ev === "connected") {
        logger.info("Twilio WS event", { event: "connected", streamSid: null, callSid: null });
      }
    });

    twilioWs.on("close", async () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      try {
        if (gemini) gemini.stop();
      } catch {}

      // If WS closes without stop, treat as finalize too (best-effort)
      await finalizeCall({ finalize_reason: "ws_closed" }).catch(() => {});
    });

    twilioWs.on("error", async (err) => {
      logger.error("Twilio media WS error", { streamSid, callSid, error: err.message });
      try {
        if (gemini) gemini.stop();
      } catch {}
      await finalizeCall({ finalize_reason: "ws_error" }).catch(() => {});
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
