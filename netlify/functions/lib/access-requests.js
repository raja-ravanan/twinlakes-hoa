"use strict";
// Shared utility for the Resident Portal Access Request feature — the
// public submission function (resident-access-request.js) and the Board
// Portal review actions (board-api.js) both require this. Not itself a
// Netlify function (lives in a subdirectory so the bundler won't register
// it as an endpoint) — same convention as lib/resident-audit.js, which is
// already shared between resident-login.js and resident-logout.js.
//
// Reuses the repo's existing Google-service-account-JWT + raw-HTTPS Sheets
// pattern (see lib/resident-audit.js, board-api.js) against the SAME
// spreadsheet (GOOGLE_SHEET_ID), writing to a dedicated
// "Resident Portal Access Requests" tab.
const crypto = require("crypto");
const https = require("https");
const {
  stripControlChars,
  boundedText,
  sanitizeForSpreadsheet,
} = require("./resident-audit");

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = process.env.GOOGLE_SA_KEY;
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

const TAB_NAME = (process.env.RESIDENT_ACCESS_REQUESTS_SHEET_NAME || "Resident Portal Access Requests").trim();

// Column order is load-bearing — every read/write below assumes this exact
// A:O layout. Change it deliberately, together with the live sheet's row 1
// (see ensureAccessRequestsTab below), never independently.
const HEADERS = [
  "Request ID", "Submitted At UTC", "First Name", "Last Name",
  "Home Address", "Email Address", "Resident Comments", "Status",
  "Internal Board Notes", "Last Updated At UTC", "Last Updated By",
  "Response Sent At UTC", "Response Type", "Response Subject", "Delivery Status",
];

const STATUSES = ["New", "Under Review", "Approved", "Rejected", "Closed"];

// Keyed the same way the Board Portal UI refers to a template choice.
// Labels are exactly what's stored in the "Response Type" column and shown
// to the board — never abbreviated/coded there, so the sheet reads plainly.
const TEMPLATE_LABELS = {
  approved: "Access Approved",
  more_info: "More Information Needed",
  unable_to_verify: "Unable to Verify",
};
const TEMPLATE_TYPES = Object.keys(TEMPLATE_LABELS);

const DELIVERY_SENT = "Sent";
const DELIVERY_FAILED = "Failed";

// The literal string the Board Portal preview shows and the ONLY string
// insertPassword() ever looks for. Never derived from, or containing, the
// real password — this is placeholder text, not a template variable.
const PASSWORD_PLACEHOLDER = "[Current Community Access Password will be inserted securely when sent]";

const MAX_NAME_LEN = 80;
const MAX_ADDRESS_LEN = 200;
const MAX_EMAIL_LEN = 200;
const MAX_COMMENTS_LEN = 1000;
const MAX_BODY_BYTES = 4000;
const MAX_NOTE_LEN = 2000;

const WRITE_TIMEOUT_MS = 4000;

// Duplicate-send guard: this stack has no distributed lock or durable rate
// limiter (same documented limitation as the resident-login failure delay
// — see docs/resident-portal-setup.md's "Known security limitations").
// What it CAN do cheaply is refuse to re-send when the row it just read
// shows a successful send within this window — that reliably catches the
// two realistic causes of a duplicate click-through: a double-click that
// beat the button-disable, and a client-side network retry fired after the
// first attempt actually succeeded server-side. It intentionally does NOT
// block a genuine resend after the window elapses, and never blocks a
// retry after a FAILED send (see isDuplicateSend below).
const DUPLICATE_SEND_WINDOW_MS = 15000;

// ── Input normalization (public submission) ────────────────────
// Real names/addresses use unicode letters, apostrophes, periods, unit
// numbers, etc. — this is a support request, not an eligibility check
// (lib/resident-auth.js's normalizeLastName intentionally fails closed on
// an unfamiliar character; that would be the wrong call here, since a
// resident who can't already log in must never be blocked from asking for
// help over a formatting quirk in their own name or address). Values are
// trimmed, whitespace-collapsed, control-character-stripped, and
// length-capped only. Spreadsheet-formula-injection protection happens
// separately at write time (buildAccessRequestRow -> sanitizeForSpreadsheet).
function normalizeRequiredText(raw, maxLen) {
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LEN) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

// Optional field — blank is valid, oversized/invalid is not.
function normalizeComments(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim();
  if (trimmed.length > MAX_COMMENTS_LEN) return null;
  return trimmed;
}

// Central validation for the public POST body. Returns { ok:true, fields }
// or { ok:false, error }. Deliberately never touches the resident directory
// or the shared password — this endpoint has no eligibility check to leak
// through timing, error text, or otherwise (see resident-access-request.js).
function validateSubmission(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Malformed request." };
  }
  // Honeypot: a real resident never fills this hidden field. A bot that
  // autofills every input will. Signaled back via a dedicated flag (not an
  // error) so the caller can accept-and-drop rather than reveal detection.
  if (typeof data.website === "string" && data.website.trim() !== "") {
    return { ok: false, honeypot: true };
  }

  const firstName = normalizeRequiredText(data.firstName, MAX_NAME_LEN);
  const lastName = normalizeRequiredText(data.lastName, MAX_NAME_LEN);
  const homeAddress = normalizeRequiredText(data.homeAddress, MAX_ADDRESS_LEN);
  const email = normalizeEmail(data.email);
  const comments = normalizeComments(data.comments);

  if (!firstName || !lastName || !homeAddress) {
    return { ok: false, error: "Please complete your first name, last name, and home address." };
  }
  if (!email) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (comments === null) {
    return { ok: false, error: "Comments are too long — please shorten and try again." };
  }

  return { ok: true, fields: { firstName, lastName, homeAddress, email, comments } };
}

function isValidStatus(status) {
  return STATUSES.includes(status);
}

function isValidTemplateType(templateType) {
  return TEMPLATE_TYPES.includes(templateType);
}

// Pure — takes the row's current Delivery Status / Response Sent At UTC and
// "now", returns true if a new send should be refused as a likely
// duplicate. Only ever true right after a SUCCESSFUL send; a prior failure
// never blocks a retry, no matter how recent.
function isDuplicateSend(deliveryStatus, lastSentAtIso, nowMs) {
  if (deliveryStatus !== DELIVERY_SENT || !lastSentAtIso) return false;
  const lastSentMs = new Date(lastSentAtIso).getTime();
  if (!Number.isFinite(lastSentMs)) return false;
  const elapsed = (nowMs == null ? Date.now() : nowMs) - lastSentMs;
  return elapsed >= 0 && elapsed < DUPLICATE_SEND_WINDOW_MS;
}

// ── IDs / timestamps ─────────────────────────────────────────
function generateRequestId() {
  return "ACC-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
}

function nowIsoUtc() {
  return new Date().toISOString();
}

// ── Row construction (pure — no I/O, directly testable) ────────
// Builds a brand-new row for a public submission: Status defaults to "New",
// every board-owned column (notes, response fields) starts blank. Never
// includes anything password-related — there is no code path here that
// reads a password value at all.
function buildAccessRequestRow(fields) {
  return [
    generateRequestId(),
    nowIsoUtc(),
    sanitizeForSpreadsheet(boundedText(fields.firstName, MAX_NAME_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.lastName, MAX_NAME_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.homeAddress, MAX_ADDRESS_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.email, MAX_EMAIL_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.comments || "", MAX_COMMENTS_LEN)),
    "New",
    "", "", "", "", "", "", "",
  ];
}

// ── Reply templates ──────────────────────────────────────────
// Only the "approved" template ever mentions a password, and only as the
// literal placeholder — never a real value. The board can edit any of
// these before sending (see board-api.js's sendAccessResponse), but this
// function itself has no way to produce a template containing the actual
// RESIDENT_PORTAL_PASSWORD.
function buildTemplate(templateType, resident) {
  if (!isValidTemplateType(templateType)) return null;
  const firstName = resident?.firstName || "there";
  const portalUrl = "https://twinlakes.netlify.app/resident-login.html";
  const boardEmail = "hoa.twinlakes.board@gmail.com";

  if (templateType === "approved") {
    return {
      subject: "Your Twin Lakes Resident Portal Access — Approved",
      body:
`Hi ${firstName},

We've verified your residency and your Resident Portal access request is approved.

Resident Portal: ${portalUrl}

To log in, enter your House Number and Last Name exactly as they appear on file with the HOA, along with the Community Access Password below.

Community Access Password: ${PASSWORD_PLACEHOLDER}

If you have any trouble logging in, reply to this email or contact the board at ${boardEmail}.

Best regards,
Twin Lakes at Floyds Fork HOA Board`,
    };
  }

  if (templateType === "more_info") {
    return {
      subject: "Twin Lakes Resident Portal Access — More Information Needed",
      body:
`Hi ${firstName},

Thank you for your Resident Portal access request. Before we can verify your residency, we need a bit more information — please reply to this email with the exact name and address as they appear on your HOA account (or let us know if either has recently changed).

If you have any questions, contact the board at ${boardEmail}.

Best regards,
Twin Lakes at Floyds Fork HOA Board`,
    };
  }

  // unable_to_verify
  return {
    subject: "Twin Lakes Resident Portal Access — Unable to Verify",
    body:
`Hi ${firstName},

We were unable to verify your residency at Twin Lakes at Floyds Fork based on the information provided, so we can't grant Resident Portal access at this time.

If you believe this is an error, please contact Mulloy Properties at (502) 498-2411 or the board at ${boardEmail} so we can look into it further.

Best regards,
Twin Lakes at Floyds Fork HOA Board`,
  };
}

// Replaces the literal placeholder with the real password. Only ever call
// this for templateType === "approved" — callers must gate on that
// themselves (see board-api.js's sendAccessResponse), because this
// function does not check templateType; it just does a literal string
// replace. If the placeholder isn't present (e.g. a board member edited it
// out before sending), the body is returned unchanged — the password is
// never appended or guessed into place.
function insertPassword(body, realPassword) {
  if (typeof body !== "string" || !body.includes(PASSWORD_PLACEHOLDER)) return body;
  return body.split(PASSWORD_PLACEHOLDER).join(realPassword);
}

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

async function sheetsAppend(token, range, values) {
  await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${token}` }, { values });
}

// Cached per warm container (same technique as lib/resident-audit.js's
// auditTabEnsured) so every request isn't preceded by an extra metadata +
// header round-trip. Never blindly overwrites an existing header: a
// brand-new tab (or a genuinely blank row 1) gets the header written once;
// an existing header is validated against HEADERS and left untouched
// either way. A mismatch throws access_requests_header_mismatch rather
// than silently "fixing" whatever is actually there.
let tabEnsured = false;

async function ensureAccessRequestsTab(token) {
  if (tabEnsured) return;
  const meta = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}`, { Authorization: `Bearer ${token}` });
  const spreadsheet = JSON.parse(meta.body);
  const existing = (spreadsheet.sheets || []).map((s) => s.properties.title);

  if (!existing.includes(TAB_NAME)) {
    await httpsReq("POST", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      { Authorization: `Bearer ${token}` },
      { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] });
    await sheetsUpdate(token, `'${TAB_NAME}'!A1`, [HEADERS]);
    tabEnsured = true;
    return;
  }

  const headerRange = `'${TAB_NAME}'!A1:${String.fromCharCode(64 + HEADERS.length)}1`;
  const headerResult = await sheetsGet(token, headerRange);
  const existingHeader = (headerResult.values && headerResult.values[0]) || [];

  if (existingHeader.length === 0) {
    await sheetsUpdate(token, `'${TAB_NAME}'!A1`, [HEADERS]);
    tabEnsured = true;
    return;
  }

  const headerMatches =
    existingHeader.length === HEADERS.length &&
    HEADERS.every((h, i) => existingHeader[i] === h);
  if (!headerMatches) {
    throw new Error("access_requests_header_mismatch");
  }
  tabEnsured = true;
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

module.exports = {
  TAB_NAME,
  HEADERS,
  STATUSES,
  TEMPLATE_TYPES,
  TEMPLATE_LABELS,
  DELIVERY_SENT,
  DELIVERY_FAILED,
  PASSWORD_PLACEHOLDER,
  MAX_NAME_LEN,
  MAX_ADDRESS_LEN,
  MAX_EMAIL_LEN,
  MAX_COMMENTS_LEN,
  MAX_BODY_BYTES,
  MAX_NOTE_LEN,
  WRITE_TIMEOUT_MS,
  DUPLICATE_SEND_WINDOW_MS,
  normalizeRequiredText,
  normalizeEmail,
  normalizeComments,
  validateSubmission,
  isValidStatus,
  isValidTemplateType,
  isDuplicateSend,
  generateRequestId,
  nowIsoUtc,
  buildAccessRequestRow,
  buildTemplate,
  insertPassword,
  getGoogleToken,
  httpsReq,
  sheetsGet,
  sheetsUpdate,
  sheetsAppend,
  ensureAccessRequestsTab,
  withTimeout,
};
