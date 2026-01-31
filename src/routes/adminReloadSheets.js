// src/routes/adminReloadSheets.js
"use strict";

const express = require("express");
const { loadSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

const router = express.Router();

router.post("/admin/reload-sheets", async (req, res) => {
  const token = req.headers["x-admin-token"];

  // NOTE: we use TWILIO_AUTH_TOKEN as the admin token because we must not add new ENV names.
  // Make sure TWILIO_AUTH_TOKEN is set in Render.
  if (!env.TWILIO_AUTH_TOKEN) {
    return res.status(500).json({
      error: "server_misconfigured",
      message: "TWILIO_AUTH_TOKEN is empty in ENV (used as admin token). Set it in Render."
    });
  }

  if (!token || token !== env.TWILIO_AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const ssot = await loadSSOT(true);
    return res.status(200).json({
      ok: true,
      reloaded_at: new Date().toISOString(),
      loaded_at: ssot.loaded_at,
      settings_keys: ssot.settings_keys || null,
      prompt_ids: ssot.prompt_ids || null,
      intents: ssot.intents_count || null
    });
  } catch (err) {
    return res.status(500).json({
      error: "reload_failed",
      message: err.message
    });
  }
});

module.exports = { adminReloadRouter: router };
