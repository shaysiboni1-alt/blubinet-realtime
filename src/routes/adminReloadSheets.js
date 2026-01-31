// src/routes/adminReloadSheets.js
"use strict";

const express = require("express");
const { loadSSOT } = require("../ssot/ssotClient");
const { env } = require("../config/env");

const router = express.Router();

router.post("/admin/reload-sheets", async (req, res) => {
  const token = req.headers["x-admin-token"];

  if (!token || token !== env.TWILIO_AUTH_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const ssot = await loadSSOT(true);
    return res.status(200).json({
      reloaded: true,
      loaded_at: ssot.loaded_at
    });
  } catch (err) {
    return res.status(500).json({
      error: "reload_failed",
      message: err.message
    });
  }
});

module.exports = { adminReloadRouter: router };

