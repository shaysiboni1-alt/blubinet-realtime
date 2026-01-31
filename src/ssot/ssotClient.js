"use strict";

const { env } = require("../config/env");
const { logger } = require("../utils/logger");

let cache = null; // { loaded_at, settings, prompts, intents }
let cacheAt = 0;

async function loadSSOT(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < env.SSOT_TTL_MS) return cache;

  // MVP: אם אין חיבור לשיטס עדיין/בפועל, לא מפילים שירות.
  // אם יש לך כבר מימוש שמביא מהשיטס — תשאיר אותו; כאן זה fallback בטוח.
  const ssot = {
    loaded_at: new Date().toISOString(),
    settings: {},
    prompts: {},
    intents: []
  };

  cache = ssot;
  cacheAt = now;

  logger.info("SSOT loaded", {
    settings_keys: Object.keys(ssot.settings).length,
    prompts_keys: Object.keys(ssot.prompts).length,
    intents: Array.isArray(ssot.intents) ? ssot.intents.length : 0
  });

  return ssot;
}

module.exports = { loadSSOT };
