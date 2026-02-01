"use strict";

// Logger קטן וללא תלות חיצונית (אין pino)
// תומך גם ב-logger וגם ב-getLogger() כדי לא לשבור קבצים.

function toLevel(envLevel) {
  const lvl = String(envLevel || "").toLowerCase().trim();
  if (["trace", "debug", "info", "warn", "error", "fatal"].includes(lvl)) return lvl;
  return "info";
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function makeLogger(baseMeta = {}) {
  const minLevel = toLevel(process.env.LOG_LEVEL);
  const minRank = LEVELS[minLevel] ?? 30;

  function emit(level, msg, meta) {
    const rank = LEVELS[level] ?? 30;
    if (rank < minRank) return;

    const payload = {
      time: new Date().toISOString(),
      level,
      msg,
      meta: {
        ...(baseMeta || {}),
        ...(meta || {})
      }
    };

    // JSON אחיד כדי ש-Render יציג יפה
    const line = JSON.stringify(payload);
    if (rank >= LEVELS.error) console.error(line);
    else console.log(line);
  }

  return {
    child(extraMeta = {}) {
      return makeLogger({ ...(baseMeta || {}), ...(extraMeta || {}) });
    },
    trace(msg, meta) { emit("trace", msg, meta); },
    debug(msg, meta) { emit("debug", msg, meta); },
    info(msg, meta) { emit("info", msg, meta); },
    warn(msg, meta) { emit("warn", msg, meta); },
    error(msg, meta) { emit("error", msg, meta); },
    fatal(msg, meta) { emit("fatal", msg, meta); }
  };
}

const logger = makeLogger();

// תאימות לאיפה שעשית:
// const log = getLogger();
// או getLogger(meta).child(...)
function getLogger(meta) {
  return meta ? logger.child(meta) : logger;
}

module.exports = { logger, getLogger };
