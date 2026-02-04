// src/stage4/twilioRecordings.js
"use strict";

// Best-effort Twilio Recording resolver (by CallSid).
// This mirrors the GilSport approach: resolve recording SID + build public URL.

const { env } = require("../config/env");
const { logger } = require("../utils/logger");

function basicAuthHeader(accountSid, authToken) {
  const token = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  return `Basic ${token}`;
}

async function fetchLatestRecordingByCallSid(callSid) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN missing");
  }
  if (!callSid) throw new Error("callSid missing");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}/Recordings.json?PageSize=1`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: basicAuthHeader(accountSid, authToken),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Twilio recordings HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  const rec = json?.recordings?.[0];
  if (!rec?.sid) return null;
  return {
    recording_provider: "twilio",
    recording_sid: rec.sid,
    recording_url: rec.uri
      ? `https://api.twilio.com${rec.uri.replace(".json", "")}`
      : null,
    recording_url_public: env.PUBLIC_BASE_URL
      ? `${env.PUBLIC_BASE_URL}/recordings/${rec.sid}.mp3`
      : null,
  };
}

async function resolveTwilioRecording(callSid) {
  if (!env.MB_ENABLE_RECORDING) return null;
  try {
    const rec = await fetchLatestRecordingByCallSid(callSid);
    if (!rec) {
      logger.info({ msg: "No Twilio recordings found", meta: { callSid } });
      return null;
    }
    logger.info({ msg: "Resolved Twilio recording", meta: { callSid, sid: rec.recording_sid } });
    return rec;
  } catch (e) {
    logger.warn({
      msg: "Resolve Twilio recording failed",
      meta: { callSid, err: e && (e.message || String(e)) },
    });
    return null;
  }
}

module.exports = {
  resolveTwilioRecording,
};
