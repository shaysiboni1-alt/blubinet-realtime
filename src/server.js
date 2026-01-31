// src/server.js
"use strict";

const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const { healthRouter } = require("./routes/health");

const app = express();

app.use(express.json({ limit: "1mb" }));

app.use(healthRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(env.PORT, () => {
  logger.info("Service started", { port: env.PORT, provider_mode: env.PROVIDER_MODE });
});

