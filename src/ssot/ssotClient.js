// src/ssot/ssotClient.js
"use strict";

const { env } = require("../config/env");
const { logger } = require("../utils/logger");
const { google } = require("googleapis");

let cache = null;
let cacheLoadedAt = 0;

function isCacheValid() {
  if (!cache) return false;
  return Date.now() - cacheLoadedAt < env.SSOT_TTL_MS;
}

function decodeServiceAccount() {
  try {
    const json = Buffer.from(
      env.GOOGLE_SERVICE_ACCOUNT_JSON_B64,
      "base64"
    ).toString("utf8");
    return JSON.parse(json);
  } catch (err) {
    throw new Error("Failed to decode GOOGLE_SERVICE_ACCOUNT_JSON_B64");
  }
}

async function getSheetsClient() {
  const creds = decodeServiceAccount();
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

async function loadSheetTab(sheets, tabName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GSHEET_ID,
    range: tabName
  });
  return res.data.values || [];
}

function rowsToKeyValue(rows) {
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const [key, value] = rows[i];
    if (key) map[String(key).trim()] = value ?? "";
  }
  return map;
}

function rowsToObjects(rows) {
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => String(h).trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] ?? "";
    });
    out.push(obj);
  }
  return out;
}

async function loadSSOT(force = false) {
  if (!force && isCacheValid()) {
    return cache;
  }

  logger.info("Loading SSOT from Google Sheets", { force });

  const sheets = await getSheetsClient();

  const [
    settingsRows,
    promptsRows,
    intentsRows,
    intentSuggestionsRows,
    scriptSuggestionsRows,
    kbSuggestionsRows
  ] = await Promise.all([
    loadSheetTab(sheets, "SETTINGS"),
    loadSheetTab(sheets, "PROMPTS"),
    loadSheetTab(sheets, "INTENTS"),
    loadSheetTab(sheets, "INTENT_SUGGESTIONS"),
    loadSheetTab(sheets, "SCRIPT_SUGGESTIONS"),
    loadSheetTab(sheets, "KB_SUGGESTIONS")
  ]);

  const ssot = {
    loaded_at: new Date().toISOString(),
    settings: rowsToKeyValue(settingsRows),
    prompts: rowsToKeyValue(promptsRows),
    intents: rowsToObjects(intentsRows),
    intent_suggestions: rowsToObjects(intentSuggestionsRows),
    script_suggestions: rowsToObjects(scriptSuggestionsRows),
    kb_suggestions: rowsToObjects(kbSuggestionsRows)
  };

  cache = ssot;
  cacheLoadedAt = Date.now();

  logger.info("SSOT loaded", {
    settings_keys: Object.keys(ssot.settings).length,
    prompts_keys: Object.keys(ssot.prompts).length,
    intents: ssot.intents.length
  });

  return ssot;
}

function getCachedSSOT() {
  if (!isCacheValid()) return null;
  return cache;
}

module.exports = {
  loadSSOT,
  getCachedSSOT
};

