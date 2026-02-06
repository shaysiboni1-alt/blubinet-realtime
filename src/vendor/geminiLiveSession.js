"use strict";

/**
 * Post-call lead parser (GilSport-style enrichment)
 *
 * Contract:
 *   parseLeadPostcall({ transcriptText, ssot, known, env, logger }) -> {
 *     full_name?: string,
 *     subject?: string,
 *     reason?: string,
 *     phone_additional?: string,
 *     parsing_summary?: string
 *   }
 *
 * MUST:
 * - never throw
 * - return {} on failure
 *
 * Supports:
 * - Vertex AI (recommended when GEMINI_VERTEX_ENABLED=true)
 * - Gemini API key fallback
 */

const crypto = require("crypto");

function safeStr(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

function isTrue(v) {
  return v === true || String(v).toLowerCase() === "true";
}

function b64decodeJson(b64) {
  try {
    const raw = Buffer.from(String(b64).replace(/^"+|"+$/g, ""), "base64").toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractJsonObject(text) {
  if (!text) return null;
  // try to find first {...} JSON object
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // try to repair: remove trailing commas
    try {
      const repaired = slice.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function pickTextFromModelResponse(modelResponse) {
  // Supports both Vertex generateContent and Gemini API generateContent formats (best-effort)
  try {
    // Vertex / Gemini often: candidates[0].content.parts[].text
    const cand = modelResponse?.candidates?.[0];
    const parts = cand?.content?.parts;
    if (Array.isArray(parts)) {
      const txt = parts.map((p) => p?.text).filter(Boolean).join("\n");
      if (txt) return txt;
    }
    // Some formats: output_text
    if (typeof modelResponse?.output_text === "string") return modelResponse.output_text;
  } catch {}
  return "";
}

function normalizeResult(obj) {
  const full_name = safeStr(obj?.full_name);
  const subject = safeStr(obj?.subject);
  const reason = safeStr(obj?.reason);
  const phone_additional = safeStr(obj?.phone_additional);
  const parsing_summary = safeStr(obj?.parsing_summary);

  // return only known keys
  const out = {};
  if (full_name) out.full_name = full_name;
  if (subject) out.subject = subject;
  if (reason) out.reason = reason;
  if (phone_additional) out.phone_additional = phone_additional;
  if (parsing_summary) out.parsing_summary = parsing_summary;
  return out;
}

/** ---------------- Vertex Auth (Service Account) ---------------- */

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwtRS256({ client_email, private_key, token_uri }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encHeader = base64url(JSON.stringify(header));
  const encPayload = base64url(JSON.stringify(payload));
  const toSign = `${encHeader}.${encPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(toSign);
  signer.end();
  const sig = signer.sign(private_key);
  const encSig = base64url(sig);

  return `${toSign}.${encSig}`;
}

async function getVertexAccessTokenFromServiceAccountB64(saB64) {
  const sa = b64decodeJson(saB64);
  if (!sa?.client_email || !sa?.private_key) return null;

  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const assertion = signJwtRS256({
    client_email: sa.client_email,
    private_key: sa.private_key,
    token_uri: tokenUri,
  });

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return json?.access_token || null;
}

/** ---------------- Model Calls ---------------- */

async function callVertexGenerateContent({ projectId, location, model, accessToken, contents }) {
  const url =
    `https://${location}-aiplatform.googleapis.com/v1/` +
    `projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}` +
    `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ contents }),
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, raw: text };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: true, json: { raw_text: text } };
  }
}

async function callGeminiApiGenerateContent({ apiKey, model, contents }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=` +
    encodeURIComponent(apiKey);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents }),
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, raw: text };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: true, json: { raw_text: text } };
  }
}

/** ---------------- Main Parser ---------------- */

async function parseLeadPostcall({ transcriptText, ssot, known, env, logger }) {
  const log = logger || console;

  try {
    const transcript = safeStr(transcriptText) || "";
    if (!transcript) return {};

    const prompts = ssot?.prompts || ssot?.PROMPTS || {};
    const settings = ssot?.settings || ssot?.SETTINGS || {};

    const leadParserPrompt =
      safeStr(prompts?.LEAD_PARSER_PROMPT) ||
      // fallback (very strict output contract)
      "You are a post-call lead parser for a phone call. Return ONLY valid JSON with keys: full_name, subject, reason, phone_additional, parsing_summary. Do not include any other text.";

    const style = safeStr(env?.LEAD_SUMMARY_STYLE || process.env.LEAD_SUMMARY_STYLE) || "crm_short";
    const businessName = safeStr(settings?.BUSINESS_NAME) || safeStr(env?.BUSINESS_NAME) || "";

    const knownName = safeStr(known?.full_name) || "";
    const knownCaller = safeStr(known?.caller_id_e164) || "";

    // GilSport-style: hard JSON contract
    const instruction = [
      leadParserPrompt,
      "",
      "OUTPUT CONTRACT:",
      "- Return ONLY JSON (no markdown).",
      "- Keys: full_name, subject, reason, phone_additional, parsing_summary",
      "- parsing_summary must be short CRM style (" + style + "), 1-2 sentences, no transcript dump.",
      "- subject must be a short headline (>= 3 words if possible).",
      "- phone_additional: ONLY if caller asked for a different callback number; otherwise null/omit.",
      "- Never invent phone numbers. If uncertain, omit phone_additional.",
      "",
      businessName ? `BUSINESS: ${businessName}` : "",
      knownCaller ? `KNOWN caller_id_e164: ${knownCaller}` : "",
      knownName ? `KNOWN full_name: ${knownName}` : "",
      "",
      "TRANSCRIPT:",
      transcript,
    ]
      .filter(Boolean)
      .join("\n");

    const contents = [
      {
        role: "user",
        parts: [{ text: instruction }],
      },
    ];

    const useVertex =
      isTrue(env?.GEMINI_VERTEX_ENABLED || process.env.GEMINI_VERTEX_ENABLED) ||
      isTrue(process.env.GEMINI_VERTEX_ENABLED);

    let modelResp = null;

    if (useVertex) {
      const projectId = safeStr(env?.GEMINI_PROJECT_ID || process.env.GEMINI_PROJECT_ID);
      const location = safeStr(env?.GEMINI_LOCATION || process.env.GEMINI_LOCATION) || "us-central1";
      const model = safeStr(env?.LEAD_PARSER_MODEL || process.env.LEAD_PARSER_MODEL) || "gemini-1.5-flash";
      const saB64 = env?.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;

      if (projectId && saB64) {
        const token = await getVertexAccessTokenFromServiceAccountB64(saB64);
        if (token) {
          const r = await callVertexGenerateContent({
            projectId,
            location,
            model,
            accessToken: token,
            contents,
          });
          if (r.ok) modelResp = r.json;
          else log.warn?.("Vertex lead parser failed", { raw: r.raw?.slice?.(0, 300) });
        } else {
          log.warn?.("Vertex access token missing (service account issue)");
        }
      } else {
        log.warn?.("Vertex lead parser skipped (missing GEMINI_PROJECT_ID or GOOGLE_SERVICE_ACCOUNT_JSON_B64)");
      }
    }

    // Fallback: Gemini API key
    if (!modelResp) {
      const apiKey = safeStr(env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY);
      const model = safeStr(env?.LEAD_PARSER_MODEL || process.env.LEAD_PARSER_MODEL) || "gemini-1.5-flash";
      if (apiKey) {
        const r = await callGeminiApiGenerateContent({ apiKey, model, contents });
        if (r.ok) modelResp = r.json;
        else log.warn?.("Gemini API lead parser failed", { raw: r.raw?.slice?.(0, 300) });
      }
    }

    if (!modelResp) return {};

    const textOut = pickTextFromModelResponse(modelResp);
    const obj = extractJsonObject(textOut) || extractJsonObject(JSON.stringify(modelResp)) || null;
    if (!obj) return {};

    return normalizeResult(obj);
  } catch {
    // MUST NOT THROW
    return {};
  }
}

module.exports = { parseLeadPostcall };
