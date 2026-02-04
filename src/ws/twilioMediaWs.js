// src/ws/twilioMediaWs.js

import WebSocket from "ws";
import { finalizePipeline } from "../stage4/finalizePipeline.js";
import { resolveRecordingForCall } from "../telephony/twilioRecordingV2.js";
import {
  sendCallLog,
  sendFinalWebhook,
  sendAbandonedWebhook,
} from "../webhooks/webhookSender.js";

export function installTwilioMediaWs(server, deps) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/twilio-media-stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    const state = {
      finalized: false,
      callSid: null,
      streamSid: null,
      caller: null,
      called: null,
      lead: {},
      startedAt: Date.now(),
    };

    const finalizeOnce = async (reason) => {
      if (state.finalized) return;
      state.finalized = true;

      const snapshot = {
        basePayload: {
          callSid: state.callSid,
          caller_id_e164: state.caller,
          called_e164: state.called,
          started_at: state.startedAt,
          ended_at: Date.now(),
        },
        lead: state.lead,
      };

      await finalizePipeline({
        snapshot,
        env: process.env,
        senders: {
          sendCallLog: (p) =>
            sendCallLog(process.env.CALL_LOG_WEBHOOK_URL, p),
          sendFinal: (p) =>
            sendFinalWebhook(process.env.FINAL_WEBHOOK_URL, p),
          sendAbandoned: (p) =>
            sendAbandonedWebhook(
              process.env.ABANDONED_WEBHOOK_URL,
              p
            ),
          resolveRecording: () =>
            resolveRecordingForCall(state.callSid),
        },
      });
    };

    ws.on("message", (msg) => {
      let data;
      try {
        data = JSON.parse(msg);
      } catch {
        return;
      }

      if (data.event === "start") {
        state.callSid = data.start.callSid;
        state.streamSid = data.start.streamSid;
        state.caller = data.start.customParameters?.caller;
        state.called = data.start.customParameters?.called;
      }

      if (data.event === "lead_update") {
        state.lead = { ...state.lead, ...data.payload };
      }

      // ⛔ לא נוגעים באודיו / Gemini / media
    });

    ws.on("close", () => finalizeOnce("ws_close"));
    ws.on("error", () => finalizeOnce("ws_error"));
  });
}
