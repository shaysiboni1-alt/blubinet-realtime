// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { env } = require("../config/env");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

function nowIso() {
  return new Date().toISOString();
}

function createSessionState({ callSid, streamSid, caller, called }) {
  return {
    created_at: nowIso(),
    callSid,
    streamSid,
    caller: caller || "",
    called: called || "",
    transcripts_in: [],  // caller
    transcripts_out: [], // bot
    assistant_text: [],
    last_user_utterance: ""
  };
}

function attachTwilioMediaWs(server /* http server OR express app.listen server */) {
  const wss = new WebSocket.Server({ noServer: true });

  // If you already mount WS differently, keep your current mount.
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/twilio-media-stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    let state = createSessionState({ callSid: "", streamSid: "", caller: "", called: "" });
    let gemini = null;

    function sendTwilioAudio(mediaBase64) {
      // Twilio expects: {event:"media", streamSid, media:{payload:"base64"}}
      if (twilioWs.readyState !== WebSocket.OPEN) return;
      if (!state.streamSid) return;

      const msg = {
        event: "media",
        streamSid: state.streamSid,
        media: { payload: mediaBase64 }
      };
      twilioWs.send(JSON.stringify(msg));
    }

    function cleanup(reason) {
      logger.info("Session cleanup", {
        reason,
        streamSid: state.streamSid,
        callSid: state.callSid
      });
      try {
        if (gemini) gemini.stop();
      } catch (_) {}
      gemini = null;
    }

    twilioWs.on("message", async (data) => {
      const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let evt;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }

      if (evt.event === "connected") {
        logger.info("Twilio WS event", { event: "connected", streamSid: null, callSid: null });
        return;
      }

      if (evt.event === "start") {
        state.streamSid = evt.start && evt.start.streamSid ? evt.start.streamSid : "";
        state.callSid = evt.start && evt.start.callSid ? evt.start.callSid : "";

        const cp = (evt.start && evt.start.customParameters) || {};
        state.caller = cp.caller || "";
        state.called = cp.called || "";

        logger.info("Twilio stream start", {
          streamSid: state.streamSid,
          callSid: state.callSid,
          customParameters: cp
        });

        // Start Gemini session (system instruction can come later from SSOT; keep minimal now)
        gemini = new GeminiLiveSession({
          callSid: state.callSid,
          streamSid: state.streamSid,
          systemInstructionText:
            "ענה בעברית כברירת מחדל. אם המשתמש מבקש שפה אחרת, עבור בהתאם.",
          onGeminiAudioUlaw8kBase64: (audioB64, meta) => {
            // Forward back to Twilio
            sendTwilioAudio(audioB64);
          },
          onGeminiInputTranscript: (t) => {
            state.transcripts_in.push(t);
            state.last_user_utterance = t; // last chunk (good enough for now)
          },
          onGeminiOutputTranscript: (t) => {
            state.transcripts_out.push(t);
          },
          onGeminiText: (t) => {
            if (env.MB_LOG_ASSISTANT_TEXT) {
              logger.info("Assistant text", { callSid: state.callSid, streamSid: state.streamSid, text: t });
            }
            state.assistant_text.push(t);
          }
        });

        try {
          await gemini.start();
        } catch (err) {
          logger.error("Failed to start Gemini session", {
            callSid: state.callSid,
            streamSid: state.streamSid,
            error: err && err.message ? err.message : String(err)
          });
        }

        return;
      }

      if (evt.event === "media") {
        // Incoming audio from Twilio -> Gemini
        if (!gemini) return;
        const payload = evt.media && evt.media.payload ? evt.media.payload : "";
        if (!payload) return;

        // Send as-is (your bridge currently works; do not change formats here)
        gemini.sendAudioUlaw8kBase64(payload);
        return;
      }

      if (evt.event === "stop") {
        logger.info("Twilio stream stop", {
          streamSid: state.streamSid,
          callSid: state.callSid
        });
        cleanup("twilio_stop");
        return;
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", {
        streamSid: state.streamSid,
        callSid: state.callSid
      });
      cleanup("twilio_ws_closed");
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio WS error", {
        streamSid: state.streamSid,
        callSid: state.callSid,
        error: err && err.message ? err.message : String(err)
      });
      cleanup("twilio_ws_error");
    });
  });

  return wss;
}

module.exports = { attachTwilioMediaWs };
