"use strict";

const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");

const { installTwilioMediaWs } = require("./ws/twilioMediaWs");
const { proxyRecordingMp3 } = require("./utils/twilioRecording");

const healthRouter = require("./routes/health");
const twilioStatusRouter = require("./routes/twilioStatus");
const adminReloadRouter = require("./routes/adminReloadSheets");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.status(200).send("OK"));

app.use(healthRouter);
app.use(twilioStatusRouter);
app.use(adminReloadRouter);

// Public recording proxy (uses Twilio Basic Auth on the server side)
app.get("/recordings/:recordingSid.mp3", proxyRecordingMp3);

// WS endpoint for Twilio Media Streams
installTwilioMediaWs(app);

const port = Number(env.PORT || 3000);
app.listen(port, () => {
  logger.info(`Server listening on ${port}`, { port });
});
