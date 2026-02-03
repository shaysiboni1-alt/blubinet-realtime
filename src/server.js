// src/server.js
"use strict";

const express = require("express");
const { env } = require("./config/env");
const { logger } = require("./utils/logger");
const healthMod = require("./routes/health");
const adminReloadMod = require("./routes/adminReloadSheets");
const { loadSSOT } = require("./ssot/ssotClient");
const twilioWsMod = require("./ws/twilioMediaWs");

// Resolve router/middleware regardless of export shape:
// - module.exports = router
// - module.exports = { healthRouter }
// - module.exports = { router }
// - module.exports = { default: router }
function resolveMiddleware(mod, preferredKeys = []) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;

  for (const k of preferredKeys) {
    if (mod && typeof mod[k] === "function") return mod[k];
  }

  if (mod && typeof mod.router === "function") return mod.router;
  if (mod && typeof mod.default === "function") return mod.default;

  return null;
}

function resolveTwilioInstaller(mod) {
  if (!mod) return null;
  if (typeof mod.installTwilioMediaWs === "function") return mod.installTwilioMediaWs;
  if (typeof mod.createTwilioMediaWsServer === "function") {
    // Back-compat: if your WS module exports createTwilioMediaWsServer(server)
    return (server) => mod.createTwilioMediaWsServer(server);
  }
  if (typeof mod === "function") return mod;
  return null;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

const healthRouter = resolveMiddleware(healthMod, ["healthRouter"]);
if (!healthRouter) {
  throw new Error("health router export not found (routes/health)");
}
app.use(healthRouter);

const adminReloadRouter = resolveMiddleware(adminReloadMod, ["adminReloadRouter"]);
if (!adminReloadRouter) {
  throw new Error("admin reload router export not found (routes/adminReloadSheets)");
}
app.use(adminReloadRouter);

app.use((req, res) => {
  res.status(404).json({ error: "not_found" });
});

const server = app.listen(env.PORT, async () => {
  logger.info("Service started", {
    port: env.PORT,
    provider_mode: env.PROVIDER_MODE,
  });

  // Best-effort preload SSOT
  try {
    await loadSSOT(false);
  } catch (err) {
    logger.error("SSOT preload failed", { error: err?.message || String(err) });
  }
});

// Attach WS upgrade handler to the real HTTP server
const installTwilioMediaWs = resolveTwilioInstaller(twilioWsMod);
if (!installTwilioMediaWs) {
  throw new Error("Twilio WS installer not found (ws/twilioMediaWs)");
}
installTwilioMediaWs(server);
