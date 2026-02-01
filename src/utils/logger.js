"use strict";

const pino = require("pino");
const { env } = require("../config/env");

// רמת לוגים: MB_DEBUG=true => debug, אחרת info
const level = env.MB_DEBUG ? "debug" : "info";

const logger = pino({
  level,
  base: null,
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
});

// תאימות לאחור לקבצים שמצפים ל-getLogger()
function getLogger() {
  return logger;
}

module.exports = {
  logger,
  getLogger,
};
