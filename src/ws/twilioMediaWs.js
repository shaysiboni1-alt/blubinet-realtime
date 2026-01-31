// src/ws/twilioMediaWs.js
"use strict";

const WebSocket = require("ws");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

function attachTwilioMediaWs(httpServer) {
  const wss = new WebSocket.Server({
    server: httpServer,
    path: "/twilio-media-stream"
  });

  wss.on("connection", (twilioWs) => {
    logger.info("Twilio media WS connected");

    let callSid = null;
    let streamSid = null;
    let geminiWs = null;
    let geminiReady = false;

    function connectGemini() {
      const url =
        "wss://generativelanguage.googleapis.com/v1beta/models/" +
        env.GEMINI_LIVE_MODEL +
        ":streamGenerateContent?key=" +
        env.GEMINI_API_KEY;

      geminiWs = new WebSocket(url, {
        headers: {
          "Content-Type": "application/json"
        }
      });

      geminiWs.on("open", () => {
        geminiReady = true;
        logger.info("Gemini Live WS connected");

        // Initial config message
        geminiWs.send(
          JSON.stringify({
            setup: {
              generation_config: {
                audio_config: {
                  audio_encoding: "MULAW",
                  sample_rate_hz: 8000
                }
              }
            }
          })
        );
      });

      geminiWs.on("message", (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString("utf8"));
        } catch {
          return;
        }

        const audio =
          msg?.candidates?.[0]?.content?.parts?.find(
            (p) => p.inlineData && p.inlineData.mimeType === "audio/mulaw"
          )?.inlineData?.data;

        if (audio) {
          // Send audio back to Twilio
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: {
                payload: audio
              }
            })
          );
        }
      });

      geminiWs.on("close", () => {
        geminiReady = false;
        logger.info("Gemini Live WS closed");
      });

      geminiWs.on("error", (err) => {
        logger.error("Gemini Live WS error", { error: err.message });
      });
    }

    connectGemini();

    twilioWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        logger.info("Twilio stream start", { streamSid, callSid });
        return;
      }

      if (msg.event === "media") {
        if (!geminiReady) return;

        geminiWs.send(
          JSON.stringify({
            input: {
              audio: {
                data: msg.media.payload,
                encoding: "MULAW",
                sample_rate_hz: 8000
              }
            }
          })
        );
        return;
      }

      if (msg.event === "stop") {
        logger.info("Twilio stream stop", { streamSid, callSid });
        return;
      }
    });

    twilioWs.on("close", () => {
      logger.info("Twilio media WS closed", { streamSid, callSid });
      try {
        geminiWs && geminiWs.close();
      } catch {}
    });

    twilioWs.on("error", (err) => {
      logger.error("Twilio WS error", { error: err.message });
    });
  });
}

module.exports = { attachTwilioMediaWs };
