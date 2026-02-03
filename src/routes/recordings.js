// src/routes/recordings.js
"use strict";

const express = require("express");
const { proxyRecordingMp3 } = require("../utils/twilioRecording");
const { logger } = require("../utils/logger");

const recordingsRouter = express.Router();

// Public proxy for Twilio recording MP3.
// URL: /recordings/:recordingSid.mp3
recordingsRouter.get("/recordings/:recordingSid.mp3", async (req, res) => {
  const sid = req.params.recordingSid;
  if (!sid) return res.status(400).send("missing_recording_sid");
  await proxyRecordingMp3(sid, res, logger);
});

module.exports = { recordingsRouter };
