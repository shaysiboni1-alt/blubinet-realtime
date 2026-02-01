// src/telephony/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { logger } = require("../utils/logger");
const { GeminiLiveSession } = require("../vendor/geminiLiveSession");

function attachTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer, path: "/twilio-media-stream" });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    const session = new GeminiLiveSession({
      onGeminiAudioUlaw8kBase64: (b64Ulaw) => {
        // send audio back to Twilio
        if (!session.streamSid) return;
        if (twilioWs.readyState !== WebSocket.OPEN) return;

        const msg = {
          event: "media",
          streamSid: session.streamSid,
          media: { payload: b64Ulaw },
        };
        twilioWs.send(JSON.stringify(msg));
      },
      onGeminiText: (text) => {
        // optional: log model text
        logger.info("Gemini text", { callSid: session.callSid, text });
      },
    });

    twilioWs.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch (e) {
        logger.warn("Twilio WS non-JSON message", { error: String(e) });
        return;
      }

      const ev = msg.event;

      if (ev === "start") {
        session.streamSid = msg?.start?.streamSid || null;
        session.callSid = msg?.start?.callSid || null;
        session.customParameters = msg?.start?.customParameters || {};

        logger.info("Twilio stream start", {
          streamSid: session.streamSid,
          callSid: session.callSid,
          customParameters: session.customParameters,
        });

        // start Gemini Live session
        try {
          await session.start();
        } catch (err) {
          logger.error("Gemini session start failed", { error: err.message });
        }
        return;
      }

      if (ev === "media") {
        // Twilio sends ulaw8k base64
        const payload = msg?.media?.payload;
        if (!payload) return;

        try {
          session.pushTwilioUlaw8k(payload);
        } catch (err) {
          logger.error("pushTwilioUlaw8k failed", { error: err.message });
        }
        return;
      }

      if (ev === "stop") {
        logger.info("Twilio stream stop", {
          streamSid: session.streamSid,
          callSid: session.callSid,
        });
        await session.stop("twilio_stop");
        return;
      }

      // other events: connected / mark / dtmf etc.
    });

    twilioWs.on("close", async () => {
      logger.info("Twilio media WS closed", {
        streamSid: session.streamSid,
        callSid: session.callSid,
      });
      await session.stop("twilio_ws_closed");
    });

    twilioWs.on("error", async (err) => {
      logger.error("Twilio media WS error", { error: err.message });
      await session.stop("twilio_ws_error");
    });
  });
}

module.exports = { attachTwilioMediaWs };
