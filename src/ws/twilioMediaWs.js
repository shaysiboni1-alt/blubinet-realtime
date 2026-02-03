// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { createGeminiLiveSession } = require("../vendor/geminiLiveSession");
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

function normalizeCallerId(caller) {
  const s = (caller || "").trim();
  const low = s.toLowerCase();
  if (!s) return { value: "", withheld: true };
  if (low === "anonymous" || low === "restricted" || low === "unavailable" || low === "unknown") {
    return { value: s, withheld: true };
  }
  // Twilio may send + or digits; treat anything with digits as not withheld.
  const digits = s.replace(/\D/g, "");
  return { value: s, withheld: digits.length < 5 };
}

function extractNameHe(text) {
  const t = (text || "").trim();
  if (!t) return "";
  // Common patterns: "קוראים לי X", "השם שלי X", "שמי X", "אני X"
  const m = t.match(/(?:קוראים לי|השם שלי(?: זה)?|שמי|אני)\s+([^\n,.!?]{2,40})/);
  if (m && m[1]) return m[1].trim();
  // Fallback: if user just says a short token
  if (t.length <= 25 && !t.match(/[0-9]/)) return t.replace(/^אה+[, ]*/g, "").trim();
  return "";
}

function extractPhone(text) {
  const digits = (text || "").replace(/\D/g, "");
  if (!digits) return "";
  // Simple heuristics: Israeli numbers 9-12 digits, maybe with 972
  if (digits.length >= 9 && digits.length <= 13) {
    if (digits.startsWith("972") && digits.length === 12) {
      return "+" + digits;
    }
    if (digits.startsWith("0") && digits.length === 10) {
      return "+972" + digits.slice(1);
    }
    return digits;
  }
  return "";
}

async function runLeadParser({ ssot, transcript, callMeta }) {
  if (!process.env.LEAD_PARSER_ENABLED || String(process.env.LEAD_PARSER_ENABLED) === "false") {
    return null;
  }

  // Best-effort: Gemini text generation via public API key.
  // If it fails, we fall back to a deterministic short summary.
  const prompt = (ssot?.prompts?.LEAD_PARSER_PROMPT || "").trim();
  const system = prompt
    ? prompt
    : "Return JSON only. Summarize the call for CRM. No hallucinations.";

  const model = "gemini-1.5-flash";
  const key = process.env.GEMINI_API_KEY;
  if (key) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        key
      )}`;
      const body = {
        contents: [
          { role: "user", parts: [{ text: `SYSTEM:\n${system}\n\nCALL_META:\n${JSON.stringify(callMeta)}\n\nTRANSCRIPT:\n${transcript}` }] },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 512,
        },
      };
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await resp.json().catch(() => null);
      const txt =
        j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
      const trimmed = (txt || "").trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        return JSON.parse(trimmed);
      }
    } catch (e) {
      logger.warn({ msg: "LeadParser LLM failed; falling back", meta: { error: String(e) } });
    }
  }

  // Fallback deterministic parser
  return {
    summary: transcript.slice(0, 6000),
  };
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
    name: "",
    callback_number: callerInfo.withheld ? "" : callerInfo.value,
    has_request: false,
    transcript: [],
    intents: [],
    recordingSid: "",
    recording_url_public: "",
    closing_initiated: false,
  };
}

async function maybeStartRecording(state) {
  if (String(process.env.MB_ENABLE_RECORDING) !== "true") return;
  if (!state.callSid) return;
  const recSid = await startCallRecording(state.callSid, logger);
  if (recSid) {
    state.recordingSid = recSid;
    state.recording_url_public = publicRecordingUrl(recSid);
  }
}

function shouldTriggerHangup(botText, ssot) {
  const t = (botText || "").trim();
  if (!t) return false;
  // Fast path by keyword
  if (t.includes("תודה") && t.includes("להתראות")) return true;
  // If SSOT has explicit closing texts, match any
  const settings = ssot?.settings || {};
  const closers = Object.keys(settings)
    .filter((k) => k.startsWith("CLOSING_"))
    .map((k) => String(settings[k] || "").trim())
    .filter(Boolean);
  return closers.some((c) => c && t.startsWith(c.slice(0, Math.min(18, c.length))));
}

async function finalizeAndWebhook({ state, ssot }) {
  state.ended_at = nowIso();

  const transcriptText = state.transcript
    .map((x) => `${x.role.toUpperCase()}: ${x.text}`)
    .join("\n");

  const leadComplete = Boolean(state.name && state.has_request);
  const eventType = leadComplete ? "FINAL" : "ABANDONED";

  const callMeta = {
    callSid: state.callSid,
    streamSid: state.streamSid,
    caller: state.caller_raw,
    called: state.called,
    source: state.source,
    started_at: state.started_at,
    ended_at: state.ended_at,
    caller_withheld: state.caller_withheld,
    recording_provider: state.recordingSid ? "twilio" : "",
    recording_url_public: state.recording_url_public || "",
  };

  let leadParser = null;
  if (leadComplete) {
    leadParser = await runLeadParser({ ssot, transcript: transcriptText, callMeta });
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

function createTwilioMediaWsServer(server) {
  const wss = new WebSocket.Server({ noServer: true });

  wss.on("connection", async (ws) => {
    logger.info({ msg: "Twilio media WS connected" });

    const ssot = await loadSSOT();

    let session = null;
    let state = null;

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.event === "start") {
        const streamSid = msg?.start?.streamSid;
        const callSid = msg?.start?.callSid;
        const custom = msg?.start?.customParameters || {};
        const caller = custom.caller || "";
        const called = custom.called || "";
        const source = custom.source || "VoiceBot_Blank";

        logger.info({ msg: "Twilio stream start", meta: { streamSid, callSid, customParameters: custom } });

        state = createCallState({ callSid, streamSid, caller, called, source });

        // Call log webhook as early as possible.
        await deliverWebhook("CALL_LOG", {
          event: "CALL_LOG",
          call: {
            callSid,
            streamSid,
            caller: state.caller_raw,
            called: state.called,
            source: state.source,
            started_at: state.started_at,
          },
        }, logger);

        await maybeStartRecording(state);

        session = createGeminiLiveSession({ ssot, meta: { streamSid, callSid, caller, called, source } });

        session.on("audio", (pcm16) => {
          // Gemini -> Twilio
          ws.send(JSON.stringify({ event: "media", media: { payload: pcm16.toString("base64") } }));
        });

        session.on("utterance", async (u) => {
          if (!state) return;
          const role = u.role;
          const text = u.text || "";
          state.transcript.push({ role, text, normalized: u.normalized, lang: u.lang, ts: nowIso() });

          if (role === "user") {
            // Capture name early if we don't have it yet.
            if (!state.name) {
              const name = extractNameHe(u.normalized || text);
              if (name) {
                state.name = name;
              }
            } else {
              // After name exists, consider the call non-abandoned.
              if ((u.normalized || text).length > 6) state.has_request = true;

              // Capture callback number if caller withheld and user says digits.
              if (state.caller_withheld && !state.callback_number) {
                const phone = extractPhone(u.normalized || text);
                if (phone) state.callback_number = phone;
              }
            }
          }

          if (role === "bot") {
            // If bot is closing, hang up proactively.
            if (!state.closing_initiated && shouldTriggerHangup(text, ssot)) {
              state.closing_initiated = true;
              // Give a brief moment for TTS to finish before hangup.
              setTimeout(() => {
                hangupCall(state.callSid, logger).catch(() => {});
              }, 900);
            }
          }
        });

        session.on("log", (entry) => {
          logger.debug({ msg: "Gemini log", meta: { streamSid, callSid, entry } });
        });

        session.start();
        return;
      }

      if (msg.event === "media") {
        if (session) {
          const b = Buffer.from(msg.media.payload, "base64");
          session.sendAudio(b);
        }
        return;
      }

      if (msg.event === "stop") {
        const streamSid = msg?.stop?.streamSid;
        const callSid = msg?.stop?.callSid;
        logger.info({ msg: "Twilio stream stop", meta: { streamSid, callSid } });

        try {
          session?.stop();
        } catch {}

        if (state) {
          await finalizeAndWebhook({ state, ssot });
        }

        state = null;
        session = null;
        return;
      }
    });

    ws.on("close", () => {
      logger.info({ msg: "Twilio media WS closed" });
      try {
        session?.stop();
      } catch {}
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/twilio-media-stream") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  return wss;
}

module.exports = { createTwilioMediaWsServer };
