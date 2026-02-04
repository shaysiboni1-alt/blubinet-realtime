"use strict";

const https = require("https");
const querystring = require("querystring");
const { env } = require("../config/env");
const { logger } = require("../utils/logger");

/**
 * Start a Twilio Call Recording.
 * Returns: { recordingSid, recordingUrl } (Twilio API URL), or null if failed.
 */
async function startCallRecording(callSid) {
  if (!callSid) return null;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return null;

  // Twilio: POST /Calls/{CallSid}/Recordings.json
  // https://www.twilio.com/docs/voice/api/recording#record-a-call
  const body = querystring.stringify({
    RecordingStatusCallbackEvent: "completed",
    RecordingChannels: "dual",
    RecordingTrack: "both"
  });

  const path = `/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(
    callSid
  )}/Recordings.json`;

  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

  const opts = {
    hostname: "api.twilio.com",
    method: "POST",
    path,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body)
    }
  };

  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (d) => (raw += d.toString("utf8")));
      res.on("end", () => {
        try {
          const json = JSON.parse(raw || "{}");
          const recordingSid = json.sid || "";
          const recordingUrl = json.uri ? `https://api.twilio.com${json.uri}` : "";
          if (recordingSid) {
            resolve({ recordingSid, recordingUrl });
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    });

    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

/**
 * Build a "public" URL to the recording.
 *
 * Modes (ENV: MB_RECORDING_URL_MODE):
 * - "twilio_auth" (default): returns a Twilio media URL with embedded basic-auth credentials.
 *   ✅ Works immediately without changing server routes, but exposes credentials in the URL.
 * - "twilio": returns the Twilio media URL (requires auth to fetch).
 * - "proxy": returns PUBLIC_BASE_URL/recordings/{sid}.mp3 (requires you to implement a proxy route in your server).
 */
function publicRecordingUrl(recordingSid) {
  if (!recordingSid) return "";

  const mode = String(env.MB_RECORDING_URL_MODE || "twilio_auth").toLowerCase();
  const acct = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;

  const mediaPath = `/2010-04-01/Accounts/${encodeURIComponent(acct)}/Recordings/${encodeURIComponent(
    recordingSid
  )}.mp3`;

  if (mode === "proxy") {
    const base = (env.PUBLIC_BASE_URL || "").replace(/\/+$/g, "");
    if (!base) return "";
    return `${base}/recordings/${recordingSid}.mp3`;
  }

  if (mode === "twilio") {
    return `https://api.twilio.com${mediaPath}`;
  }

  // default: twilio_auth
  if (!acct || !token) return `https://api.twilio.com${mediaPath}`;
  return `https://${encodeURIComponent(acct)}:${encodeURIComponent(token)}@api.twilio.com${mediaPath}`;
}

/**
 * Optional: proxy endpoint helper (not used unless you add a route in server).
 * This fetches from Twilio with Basic Auth and streams the MP3.
 */
async function proxyRecordingMp3(recordingSid, res) {
  if (!recordingSid) return res.status(400).send("missing recordingSid");
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) return res.status(500).send("missing twilio creds");

  const path = `/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Recordings/${encodeURIComponent(
    recordingSid
  )}.mp3`;

  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");

  const opts = {
    hostname: "api.twilio.com",
    method: "GET",
    path,
    headers: {
      Authorization: `Basic ${auth}`
    }
  };

  const req = https.request(opts, (twRes) => {
    res.status(twRes.statusCode || 502);
    res.setHeader("Content-Type", "audio/mpeg");
    twRes.pipe(res);
  });

  req.on("error", (e) => {
    logger.error("proxyRecordingMp3 error", { error: e.message });
    res.status(502).send("upstream error");
  });

  req.end();
}

module.exports = {
  startCallRecording,
  publicRecordingUrl,
  proxyRecordingMp3
};
