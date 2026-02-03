// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { logger } = require("../utils/logger");
const { loadSSOT } = require("../ssot/ssotClient");
const { deliverWebhook } = require("../utils/webhooks");
const {
  startCallRecording,
  hangupCall,
  publicRecordingUrl,
} = require("../utils/twilioRecording");

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function normalizeCallerId(caller) {
  const s = safeStr(caller);
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (
    low === "anonymous" ||
    low === "restricted" ||
    low === "unavailable" ||
    low === "unknown" ||
    low === "withheld" ||
    low === "private"
  ) {
    return { value: s, withheld: true };
  }
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = safeStr(text);
  if (!t) return "";
  const m = t.match(
    /(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/
  );
  if (m && m[1]) return m[1].trim();
  if (t.length <= 25 && !t.match(/[0-9]/)) {
    return t.replace(/^אה+[, ]*/g, "").trim();
  }
  return "";
}

function extractPhone(text) {
  const digits = safeStr(text).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) return "+" + digits;
    if (digits.startsWith("0") && digits.length === 10)
      return "+972" + digits.slice(1);
    return digits;
  }
  return "";
}

function shouldTriggerHangup(botText, ssot) {
  const t = safeStr(botText);
  if (!t) return false;

  // heuristic
  if (t.includes("להתראות")) return true;

  // SSOT closers: SETTINGS keys like CLOSING_*
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => safeStr(settings[k]))
    .filter(Boolean);

  // match if utterance contains a closer fragment
  return closers.some((c) => c.length >= 4 && t.includes(c.slice(0, 6)));
}

function createCallState({ callSid, streamSid, caller, called, source }) {
  const callerInfo = normalizeCallerId(caller);
  return {
    callSid,
    streamSid,
    source: source || "VoiceBot_Blank",
    caller_raw: callerInfo.value,
    caller_withheld: callerInfo.withheld,
    called: called || "",
    started_at: nowIso(),
    ended_at: null,
    duration_ms: 0,

    // LeadGate
    name: "",
    has_request: false,
    callback_number: callerInfo.withheld ? "" : callerInfo.value,

    // transcript
    transcript: [],

    // recording
    recordingSid: "",
    recording_url_public: "",
    recording_provider: "",
    // flags
    closing_initiated: false,
    final_sent: false,
  };
}

async function maybeStartRecording(state) {
  if (String(process.env.MB_ENABLE_RECORDING) !== "true") return;
  if (!state.callSid) return;

  const recSid = await startCallRecording(state.callSid, logger);
  if (recSid) {
    state.recordingSid = recSid;
    state.recording_provider = "twilio";
    state.recording_url_public = publicRecordingUrl(recSid);
  }
}

async function runLeadParser({ ssot, transcript, callMeta }) {
  // Stage 4: postcall parser (best-effort). If disabled/fails -> null.
  if (String(process.env.LEAD_PARSER_ENABLED) !== "true") return null;

  const prompt = safeStr(ssot?.prompts?.LEAD_PARSER_PROMPT);
  const system = prompt
    ? prompt
    : "Return JSON only. Summarize the call for CRM. No hallucinations.";

  const key = safeStr(process.env.GEMINI_API_KEY);
  if (!key) return null;

  // Keep model simple/fast; doesn’t affect live audio model.
  const model = "gemini-1.5-flash";

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      key
    )}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            {
              text:
                `SYSTEM:\n${system}\n\n` +
                `CALL_META:\n${JSON.stringify(callMeta)}\n\n` +
                `TRANSCRIPT:\n${transcript}`,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 512 },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const j = await resp.json().catch(() => null);
    const txt =
      j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const trimmed = safeStr(txt);

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }
  } catch (e) {
    logger.warn({
      msg: "LeadParser LLM failed",
      meta: { error: String(e) },
    });
  }

  return null;
}

async function finalizeAndWebhook({ state, ssot }) {
  if (!state || state.final_sent) return;
  state.final_sent = true;

  state.ended_at = nowIso();
  state.duration_ms =
    new Date(state.ended_at).getTime() - new Date(state.started_at).getTime();

  const transcriptText = state.transcript
    .map((x) => `${x.role.toUpperCase()}: ${x.text}`)
    .join("\n");

  const leadComplete =
    Boolean(state.name) &&
    Boolean(state.has_request) &&
    (Boolean(state.callback_number) || !state.caller_withheld);

  const eventType = leadComplete ? "FINAL" : "ABANDONED";

  const callMeta = {
    callSid: state.callSid,
    streamSid: state.streamSid,
    caller: state.caller_raw,
    called: state.called,
    source: state.source,
    started_at: state.started_at,
    ended_at: state.ended_at,
    duration_ms: state.duration_ms,
    caller_withheld: state.caller_withheld,
    recording_provider: state.recording_provider || "",
    recording_url_public: state.recording_url_public || "",
  };

  let leadParser = null;
  if (eventType === "FINAL") {
    leadParser = await runLeadParser({
      ssot,
      transcript: transcriptText,
      callMeta,
    });
  }

  const payload = {
    event: eventType,
    call: callMeta,
    lead: {
      name: state.name || "",
      phone: state.callback_number || "",
      notes: transcriptText,
      lead_parser: leadParser,
    },
  };

  await deliverWebhook(eventType, payload, logger);
}

function installTwilioMediaWs(server) {
  const wss = new WebSocket.Server({
    server,
    path: "/twilio-media-stream",
  });

  wss.on("connection", (ws) => {
    logger.info({ msg: "Twilio media WS connected" });

    let ssot = null;
    let session = null;
    let state = null;

    (async () => {
      ssot = await loadSSOT();
      logger.info({
        msg: "SSOT loaded (ws)",
        meta: {
          settings_keys: Object.keys(ssot?.settings || {}).length,
          prompts_keys: Object.keys(ssot?.prompts || {}).length,
          intents: (ssot?.intents || []).length,
        },
      });
    })().catch((e) => {
      logger.error({ msg: "SSOT load failed (ws)", meta: { error: String(e) } });
    });

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      const ev = msg?.event;

      if (ev === "start") {
        const streamSid = msg?.start?.streamSid;
        const callSid = msg?.start?.callSid;
        const custom = msg?.start?.customParameters || {};

        const caller = safeStr(custom.caller);
        const called = safeStr(custom.called);
        const source = safeStr(custom.source) || "VoiceBot_Blank";

        logger.info({
          msg: "Twilio stream start",
          meta: { streamSid, callSid, customParameters: custom },
        });

        state = createCallState({ callSid, streamSid, caller, called, source });

        // CALL_LOG early (start-of-stream)
        await deliverWebhook(
          "CALL_LOG",
          {
            event: "CALL_LOG",
            call: {
              callSid: state.callSid,
              streamSid: state.streamSid,
              caller: state.caller_raw,
              called: state.called,
              source: state.source,
              started_at: state.started_at,
              caller_withheld: state.caller_withheld,
            },
          },
          logger
        );

        await maybeStartRecording(state);

        session = new GeminiLiveSession({
          ssot,
          streamSid,
          callSid,
          customParameters: custom,
        });

        session.onAudio((mulaw8kBase64) => {
          // Gemini -> Twilio (mulaw8k base64)
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: mulaw8kBase64 },
            })
          );
        });

        session.onUtterance((u) => {
          if (!state) return;

          const role = u.role;
          const text = safeStr(u.text);
          const normalized = safeStr(u.normalized);
          const lang = safeStr(u.lang);

          // keep transcript for FINAL/ABANDONED
          state.transcript.push({
            role,
            text,
            normalized,
            lang,
            ts: nowIso(),
          });

          if (role === "user") {
            // Name gate
            if (!state.name) {
              const name = extractNameHe(normalized || text);
              if (name) state.name = name;
            } else {
              // once name exists -> mark request when user actually says something meaningful
              if ((normalized || text).length > 6) state.has_request = true;

              // if caller withheld -> capture callback phone from user speech
              if (state.caller_withheld && !state.callback_number) {
                const phone = extractPhone(normalized || text);
                if (phone) state.callback_number = phone;
              }
            }
          }

          if (role === "bot") {
            // Proactive hangup after closings (rule: after closing, bot hangs up)
            if (
              !state.closing_initiated &&
              shouldTriggerHangup(text, ssot)
            ) {
              state.closing_initiated = true;
              setTimeout(() => {
                hangupCall(state.callSid, logger).catch(() => {});
              }, 900);
            }
          }
        });

        session.onLog((entry) => {
          logger.debug({
            msg: "Gemini log",
            meta: { streamSid, callSid, entry },
          });
        });

        session.start();
        return;
      }

      if (ev === "media") {
        if (!session) return;
        const payload = msg?.media?.payload;
        if (!payload) return;
        session.sendAudio(payload);
        return;
      }

      if (ev === "stop") {
        const streamSid = msg?.stop?.streamSid;
        const callSid = msg?.stop?.callSid;

        logger.info({ msg: "Twilio stream stop", meta: { streamSid, callSid } });

        try {
          session?.stop();
        } catch {}

        try {
          await finalizeAndWebhook({ state, ssot });
        } catch (e) {
          logger.error({
            msg: "Finalize/webhook failed",
            meta: { error: String(e) },
          });
        }

        state = null;
        session = null;
        return;
      }
    });

    ws.on("close", async () => {
      logger.info({ msg: "Twilio media WS closed" });
      try {
        session?.stop();
      } catch {}

      // If connection closes without stop -> best-effort ABANDONED
      try {
        if (state) await finalizeAndWebhook({ state, ssot });
      } catch {}
    });

    ws.on("error", (err) => {
      logger.error({ msg: "Twilio media WS error", meta: { error: String(err) } });
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
