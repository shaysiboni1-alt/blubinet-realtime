"use strict";

const express = require("express");
const { loadSSOT, getSSOTSnapshot } = require("../ssot/ssotClient");
const { env } = require("../config/env");

const router = express.Router();

router.post("/admin/reload-sheets", async (req, res) => {
  // Auth: use x-admin-token == TWILIO_AUTH_TOKEN (כי אין MB_ADMIN_TOKEN אצלך)
  const token = req.headers["x-admin-token"];
  if (!env.TWILIO_AUTH_TOKEN || !token || token !== env.TWILIO_AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const ssot = await loadSSOT(true);
    return res.status(200).json({
      ok: true,
      reloaded_at: ssot.loaded_at,
      settings_keys: ssot.settings_keys,
      prompt_ids: ssot.prompt_ids,
      intents: ssot.intents_count
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "reload_failed",
      message: err.message
    });
  }
});

// Optional: debug read (still protected)
router.get("/admin/ssot", async (req, res) => {
  const token = req.headers["x-admin-token"];
  if (!env.TWILIO_AUTH_TOKEN || !token || token !== env.TWILIO_AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const snap = getSSOTSnapshot();
  return res.status(200).json({ ok: true, ssot: snap || null });
});

module.exports = { adminReloadRouter: router };
