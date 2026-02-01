"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { getLogger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");
const { ulaw8kToPcm16 } = require("../vendor/twilioGeminiAudio"); // אם אתה משתמש בזה בפועל
// הערה: אם אינך משתמש ב-ulaw8kToPcm16 בפועל – אפשר להסיר, אבל השארתי לפי המבנה שהיה אצלך.

const log = getLogger();

function installTwilioMediaWs(server, deps) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/twilio-media-stream") return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (twilioWs) => {
    log.info("Twilio media WS connected");

    let streamSid = null;
    let callSid = null;

    // Always keep a gemini object with the expected method shape to avoid crashes
    let gemini = {
      start: async () => {},
      sendUlaw8kFromTwilio: () => {},
      sendText: () => {},
      close: () => {},
      isOpen: () => false
    };

    const safeCloseGemini = () => {
      try {
        if (gemini && typeof gemini.close === "function") gemini.close(1000, "twilio closed");
      } catch (_) {}
    };

    twilioWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        log.warn("Twilio WS message parse failed", { err: String(e) });
        return;
      }

      const ev = msg.event;
      log.info("Twilio WS event", { event: ev, streamSid, callSid });

      if (ev === "start") {
        streamSid = msg?.start?.streamSid || null;
        callSid = msg?.start?.callSid || null;
        const customParameters = msg?.start?.customParameters || {};

        log.info("Twilio stream start", { streamSid, callSid, customParameters });

        // Create a real Gemini session (Vertex or API key) with stable interface
        gemini = new GeminiLiveSession({
          streamSid,
          callSid,
          responseModalities: ["AUDIO"], // reduce text spam and latency
          systemInstruction: deps?.getSystemPrompt ? deps.getSystemPrompt(customParameters) : "",
          generationConfig: deps?.getGenerationConfig ? deps.getGenerationConfig(customParameters) : {},
          onGeminiText: (t) => {
            // IMPORTANT: keep assistant-text logging optional to avoid huge logs
            if (env.MB_LOG_ASSISTANT_TEXT) {
              log.debug("Gemini text", { streamSid, callSid, t });
            }
          },
          onGeminiAudioUlaw8kB64: (b64) => {
            // If you already have a bridge that sends audio back to Twilio, call it here.
            // Many implementations send "media" events back. If deps has a helper, use it.
            if (deps?.sendAudioToTwilio) {
              deps.sendAudioToTwilio(twilioWs, streamSid, b64);
            }
          }
        });

        try {
          await gemini.start();
        } catch (e) {
          log.error("Gemini start failed", { streamSid, callSid, err: String(e) });
        }

        // Proactive opening (if you have it)
        if (deps?.sendOpening) {
          try {
            await deps.sendOpening(gemini, customParameters);
          } catch (e) {
            log.warn("Opening send failed", { err: String(e) });
          }
        }

        return;
      }

      if (ev === "media") {
        const b64 = msg?.media?.payload;
        if (!b64) return;

        // Never throw: if Gemini is down, just ignore until next call.
        gemini.sendUlaw8kFromTwilio(b64);
        return;
      }

      if (ev === "stop") {
        log.info("Twilio stream stop", { streamSid, callSid });
        safeCloseGemini();
        try {
          twilioWs.close();
        } catch (_) {}
        return;
      }
    });

    twilioWs.on("close", () => {
      log.info("Twilio media WS closed", { streamSid, callSid });
      safeCloseGemini();
    });

    twilioWs.on("error", (err) => {
      log.error("Twilio media WS error", { streamSid, callSid, err: String(err) });
      safeCloseGemini();
    });
  });

  return wss;
}

module.exports = { installTwilioMediaWs };
