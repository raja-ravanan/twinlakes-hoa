"use strict";
// Reads the resident eligibility list live from the "TL Directory" Google
// Sheet (RESIDENT_SHEET_ID) at login time, instead of a Netlify environment
// variable. The full ~140-household list runs ~7KB, which is over
// Netlify's per-value environment variable size limit (empirically
// confirmed: values above ~5KB silently fail to persist via `netlify
// env:set` even though the CLI reports success — there is no error to
// catch). A live Sheet read has no such ceiling, and lets the board
// add/remove residents by editing the Sheet directly, with no redeploy.
//
// Reuses the repo's existing Google-service-account-JWT + raw-HTTPS Sheets
// pattern (see lib/resident-audit.js, board-api.js). Read-only scope only.
//
// This is part of the authentication data path, NOT audit logging — unlike
// resident-audit.js, failures here fail CLOSED (the caller must treat a
// thrown error as "can't verify eligibility right now", not silently let
// anyone through).
const https = require("https");
const crypto = require("crypto");

const SHEET_ID = process.env.RESIDENT_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = process.env.GOOGLE_SA_KEY;
const TAB = (process.env.RESIDENT_DIRECTORY_SHEET_NAME || "Sheet1").trim();
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"];
const FETCH_TIMEOUT_MS = 4000;
const MAX_HOUSE_NUMBER_LEN = 10;
const MAX_LAST_NAME_LEN = 60;

const SURNAME_RE = /^[A-Za-z'-]+$/;

function getGoogleToken() {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: SA_EMAIL, scope: SCOPES.join(" "),
      aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now,
    })).toString("base64url");

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(String(SA_KEY).replace(/\\n/g, "\n"), "base64url");
    const jwt = `${header}.${payload}.${sig}`;

    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          j.access_token ? resolve(j.access_token) : reject(new Error("token_response_invalid"));
        } catch {
          reject(new Error("token_response_unparseable"));
        }
      });
    });
    req.on("error", () => reject(new Error("token_request_failed")));
    req.write(body);
    req.end();
  });
}

function sheetsGet(token, range) {
  return new Promise((resolve, reject) => {
    const path = `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
    const req = https.request({ hostname: "sheets.googleapis.com", path, method: "GET", headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { reject(new Error("sheets_response_unparseable")); }
      });
    });
    req.on("error", () => reject(new Error("sheets_request_failed")));
    req.end();
  });
}

function withTimeout(promise, ms, timeoutError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// House number: digits/letters/hyphen only, mirrors resident-auth.js's own
// normalizeHouseNumber allowlist (kept independent/duplicated rather than
// imported, so this module has no dependency on the auth module).
function validHouseNumber(s) {
  const t = (s || "").trim();
  return t && t.length <= MAX_HOUSE_NUMBER_LEN && /^[A-Za-z0-9-]+$/.test(t) ? t : null;
}

// Parses the sheet's "Name" column into one or more distinct last names.
// The source data mixes two shapes (confirmed by direct inspection):
//   (A) "Last, First [& First2 [Last2]]"   — dominant, ~83% of rows
//   (B) "First Last [& First2 [Last2]]"    — remainder, no comma
// A household with two owners of different surnames (e.g. "Smith, John &
// Jane Doe") produces TWO directory entries for that house number, so
// either spouse can log in with their own last name. Returns null
// (unclear) rather than guessing when neither shape confidently applies —
// e.g. a bare single word, or an unfamiliar multi-token layout — so those
// rows are excluded rather than silently mismatched.
function parseLastNames(rawName) {
  const name = (rawName || "").trim().replace(/\s+/g, " ");
  if (!name) return null;

  const commaIdx = name.indexOf(",");
  if (commaIdx !== -1) {
    const primaryLast = name.slice(0, commaIdx).trim();
    const rest = name.slice(commaIdx + 1).trim();
    if (!primaryLast || !SURNAME_RE.test(primaryLast) || primaryLast.length > MAX_LAST_NAME_LEN) return null;
    const lastNames = new Set([primaryLast]);
    const parts = rest.split(/\s*&\s*|\s+and\s+/i);
    if (parts.length === 2) {
      const secondTokens = parts[1].trim().split(/\s+/).filter(Boolean);
      if (secondTokens.length >= 2) {
        const candidate = secondTokens[secondTokens.length - 1];
        if (SURNAME_RE.test(candidate) && candidate.length > 1) lastNames.add(candidate);
      }
      // secondTokens.length === 1 ("Jane") -> shares primaryLast, nothing to add.
    } else if (parts.length > 2) {
      return null;
    }
    for (const ln of lastNames) if (ln.length > MAX_LAST_NAME_LEN) return null;
    return Array.from(lastNames);
  }

  // No comma: try "First Last [& First2 [Last2]]".
  const parts = name.split(/\s*&\s*|\s+and\s+/i);
  if (parts.length === 1) {
    const tokens = name.split(/\s+/).filter(Boolean);
    if (tokens.length !== 2) return null; // ambiguous shape — flag, don't guess
    const last = tokens[1];
    return SURNAME_RE.test(last) && last.length > 1 && last.length <= MAX_LAST_NAME_LEN ? [last] : null;
  }
  if (parts.length === 2) {
    const leftTokens = parts[0].trim().split(/\s+/).filter(Boolean);
    const rightTokens = parts[1].trim().split(/\s+/).filter(Boolean);
    if (leftTokens.length < 2) return null;
    const leftLast = leftTokens[leftTokens.length - 1];
    if (!SURNAME_RE.test(leftLast) || leftLast.length <= 1) return null;
    const lastNames = new Set([leftLast]);
    if (rightTokens.length >= 2) {
      const rightLast = rightTokens[rightTokens.length - 1];
      if (SURNAME_RE.test(rightLast) && rightLast.length > 1) lastNames.add(rightLast);
    }
    // rightTokens.length === 1 -> second owner shares leftLast (standard
    // joint-listing convention), nothing additional to add.
    for (const ln of lastNames) if (ln.length > MAX_LAST_NAME_LEN) return null;
    return Array.from(lastNames);
  }
  return null; // 3+ "&"/"and"-joined owners in an unfamiliar shape — flag, don't guess
}

// Fetches and parses the directory fresh on every call — no caching — so a
// resident added to the Sheet can log in immediately, and there's no TTL
// staleness to reason about. Login is not a hot path; the added latency of
// one OAuth exchange + one Sheets read (bounded to FETCH_TIMEOUT_MS) is an
// acceptable tradeoff for that immediacy and for removing the env-var size
// ceiling entirely. Throws on any failure — the caller (resident-login.js)
// must treat that as fail-closed, matching how a missing/invalid
// RESIDENT_PORTAL_PASSWORD or session secret already fails closed.
async function fetchResidentDirectory() {
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
    throw new Error("directory_config_missing");
  }
  return withTimeout((async () => {
    const token = await getGoogleToken();
    const range = `${TAB}!A2:B1000`;
    const result = await sheetsGet(token, range);
    const rows = result.values || [];
    const entries = [];
    rows.forEach((row) => {
      const houseNumber = validHouseNumber(row[1]);
      if (!houseNumber) return;
      const lastNames = parseLastNames(row[0]);
      if (!lastNames) return;
      lastNames.forEach((lastName) => entries.push({ houseNumber, lastName }));
    });
    return entries;
  })(), FETCH_TIMEOUT_MS, new Error("directory_fetch_timeout"));
}

module.exports = {
  fetchResidentDirectory,
  validHouseNumber,
  parseLastNames,
};
