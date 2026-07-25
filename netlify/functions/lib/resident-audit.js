"use strict";
// Durable server-side audit trail for the resident portal (Phase 2A follow-up).
// Not itself a Netlify function (lives in a subdirectory so the bundler
// won't register it as an endpoint) — required only by resident-login.js
// and resident-logout.js.
//
// Reuses the repo's existing Google-service-account-JWT + raw-HTTPS Sheets
// pattern (the same one board-api.js / submit-request.js / health-check.js
// each independently implement — there is no shared lib to import, so this
// follows that same established convention) against the SAME spreadsheet
// (GOOGLE_SHEET_ID), writing to a dedicated "Resident Portal Audit" tab.
//
// Fail-open by design: appendAuditEvent() never throws and never blocks the
// caller beyond its own bounded timeout. The authentication decision is
// always computed before this module is called; nothing here can change it.
const crypto = require("crypto");
const https = require("https");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = process.env.GOOGLE_SA_KEY;
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const AUDIT_TAB = (process.env.RESIDENT_AUDIT_SHEET_NAME || "Resident Portal Audit").trim();
const IP_SALT = process.env.RESIDENT_AUDIT_IP_SALT;

const AUDIT_HEADERS = [
  "Event ID", "Timestamp (UTC)", "Event Type", "House Number",
  "Last Name", "Household Match", "Failure Category",
  "Session Reference", "IP Hash", "User Agent", "Source", "App Version",
];

const WRITE_TIMEOUT_MS = 2500;
const MAX_USER_AGENT_LEN = 250;
const IP_HASH_HEX_LEN = 20; // ~80 bits, within the 16-24 hex char guidance

// ── Google Sheets transport (duplicated pattern — see file header) ───
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

function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname, path, method,
      headers: { ...headers, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", () => reject(new Error("sheets_request_failed")));
    if (data) req.write(data);
    req.end();
  });
}

async function sheetsGet(token, range) {
  const r = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { Authorization: `Bearer ${token}` });
  return JSON.parse(r.body);
}

async function sheetsUpdate(token, range, values) {
  await httpsReq("PUT", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { Authorization: `Bearer ${token}` }, { range, majorDimension: "ROWS", values });
}

// insertDataOption=INSERT_ROWS instructs Sheets to find the table's current
// end and insert new rows there — it structurally cannot overwrite existing
// rows, unlike a raw values.update() to a fixed range would.
async function sheetsAppend(token, range, values) {
  await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${token}` }, { values });
}

// Cached per warm container so every login/logout isn't preceded by an
// extra metadata + header round-trip. A cold start re-verifies once.
//
// Never blindly overwrites an existing header: a brand-new tab (or one
// whose row 1 is genuinely blank) gets the header written once; a tab that
// already has *some* header gets that header validated against the
// expected schema and left untouched either way. A mismatch is treated as
// a configuration problem for THIS write (throws audit_header_mismatch,
// which appendAuditEvent's fail-open handling absorbs) rather than being
// silently "fixed" by clobbering whatever is actually there.
let auditTabEnsured = false;

async function ensureAuditTab(token) {
  if (auditTabEnsured) return;
  const meta = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}`, { Authorization: `Bearer ${token}` });
  const spreadsheet = JSON.parse(meta.body);
  const existing = (spreadsheet.sheets || []).map((s) => s.properties.title);

  if (!existing.includes(AUDIT_TAB)) {
    await httpsReq("POST", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      { Authorization: `Bearer ${token}` },
      { requests: [{ addSheet: { properties: { title: AUDIT_TAB } } }] });
    await sheetsUpdate(token, `'${AUDIT_TAB}'!A1`, [AUDIT_HEADERS]);
    auditTabEnsured = true;
    return;
  }

  const headerRange = `'${AUDIT_TAB}'!A1:${String.fromCharCode(64 + AUDIT_HEADERS.length)}1`;
  const headerResult = await sheetsGet(token, headerRange);
  const existingHeader = (headerResult.values && headerResult.values[0]) || [];

  if (existingHeader.length === 0) {
    // Tab exists but row 1 is genuinely blank (e.g. pre-created by hand) —
    // safe to write the header once; there is no existing content to lose.
    await sheetsUpdate(token, `'${AUDIT_TAB}'!A1`, [AUDIT_HEADERS]);
    auditTabEnsured = true;
    return;
  }

  const headerMatches =
    existingHeader.length === AUDIT_HEADERS.length &&
    AUDIT_HEADERS.every((h, i) => existingHeader[i] === h);
  if (!headerMatches) {
    throw new Error("audit_header_mismatch");
  }
  auditTabEnsured = true;
}

// ── Sanitization ──────────────────────────────────────────────
function stripControlChars(value) {
  return String(value == null ? "" : value).replace(/[\x00-\x1F\x7F]/g, "");
}

function boundedText(value, maxLen) {
  const s = stripControlChars(value);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// Neutralizes spreadsheet-formula injection (=, +, -, @ leading characters)
// by prefixing a literal apostrophe — the same convention Sheets/Excel use
// themselves to force a cell to plain text. RAW-mode API writes already
// can't trigger a live formula, but this also protects any future CSV/Excel
// export of this sheet, which is the more realistic exposure.
function sanitizeForSpreadsheet(value) {
  const s = stripControlChars(value);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

function generateEventId() {
  return crypto.randomUUID();
}

function nowIsoUtc() {
  return new Date().toISOString();
}

function applicationVersion() {
  return process.env.COMMIT_REF || process.env.DEPLOY_ID || "";
}

// ── IP handling ───────────────────────────────────────────────
// Only Netlify's own trusted connecting-client-IP header is used — never an
// arbitrary client-suppliable header — so this can't be spoofed by a request
// header the resident's browser controls.
function trustedClientIp(headers) {
  const h = headers || {};
  const ip = h["x-nf-client-connection-ip"] || h["X-Nf-Client-Connection-Ip"];
  return typeof ip === "string" && ip.trim() ? ip.trim() : "";
}

// Non-reversible correlation hash for abuse detection only — NOT an
// identity. Requires a dedicated salt (RESIDENT_AUDIT_IP_SALT, distinct
// from the session-signing secret) so plain unsalted hashing is never used.
// No trustworthy IP or no salt configured → blank, never a guess.
function hashIp(rawIp) {
  if (!rawIp || !IP_SALT) return "";
  return crypto.createHmac("sha256", IP_SALT).update(rawIp).digest("hex").slice(0, IP_HASH_HEX_LEN);
}

function boundedUserAgent(headers) {
  const h = headers || {};
  const ua = h["user-agent"] || h["User-Agent"] || "";
  return sanitizeForSpreadsheet(boundedText(ua, MAX_USER_AGENT_LEN));
}

// Derives a one-way, non-authenticating reference from the session's random
// `sid` — knowing this value alone cannot recreate or authenticate a
// session (that still requires RESIDENT_SESSION_SECRET to forge a valid
// cookie signature). Domain-separated from cookie-signing via a fixed
// prefix so the same secret's two uses can't collide.
function deriveSessionReference(sid, secret) {
  if (!sid || !secret) return "";
  return crypto.createHmac("sha256", secret).update(`session-ref:${sid}`).digest("hex").slice(0, IP_HASH_HEX_LEN);
}

// ── Row construction (pure — no I/O, directly testable) ────────
function buildAuditRow(evt) {
  const householdMatch = evt.householdMatch === true ? "true" : evt.householdMatch === false ? "false" : "";
  return [
    generateEventId(),
    nowIsoUtc(),
    evt.eventType,
    sanitizeForSpreadsheet(boundedText(evt.houseNumber || "", 10)),
    sanitizeForSpreadsheet(boundedText(evt.lastName || "", 60)),
    householdMatch,
    evt.failureCategory || "",
    evt.sessionReference || "",
    evt.ipHash || "",
    evt.userAgent || "",
    evt.source || "resident-portal",
    applicationVersion(),
  ];
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

async function writeAuditRow(row) {
  if (!SHEET_ID || !SA_EMAIL || !SA_KEY) {
    throw new Error("audit_config_missing");
  }
  const token = await getGoogleToken();
  await ensureAuditTab(token);
  await sheetsAppend(token, `'${AUDIT_TAB}'!A:L`, [row]);
}

// Appends exactly one audit row. Always resolves — never throws, never
// rejects — so a caller can safely `await` it without a try/catch and
// without any risk of it turning a valid login into a failure or vice
// versa. Returns a structured result; the caller decides nothing based on
// it beyond optionally logging eventId for cross-referencing.
async function appendAuditEvent(evt) {
  const row = buildAuditRow(evt);
  const eventId = row[0];
  try {
    await withTimeout(writeAuditRow(row), WRITE_TIMEOUT_MS, new Error("audit_write_timeout"));
    return { ok: true, eventId };
  } catch (err) {
    const knownCategories = ["audit_config_missing", "audit_write_timeout", "audit_header_mismatch"];
    const category = err && knownCategories.includes(err.message) ? err.message : "audit_write_error";
    // Sanitized operational log only: event id/type/category. Never the
    // submitted body, credentials, raw IP, session token, or Google's
    // response body.
    console.error(JSON.stringify({ auditWriteFailed: true, eventId, eventType: evt.eventType, category }));
    return { ok: false, eventId, error: category };
  }
}

module.exports = {
  AUDIT_TAB,
  AUDIT_HEADERS,
  WRITE_TIMEOUT_MS,
  stripControlChars,
  boundedText,
  sanitizeForSpreadsheet,
  generateEventId,
  nowIsoUtc,
  applicationVersion,
  trustedClientIp,
  hashIp,
  boundedUserAgent,
  deriveSessionReference,
  buildAuditRow,
  appendAuditEvent,
};
