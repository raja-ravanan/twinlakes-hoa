"use strict";
/* ═══════════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — resident-access-request.js
   ───────────────────────────────────────────────────────────
   Public endpoint for residents who can't log in to the Resident Portal.
   Collects First/Last Name, Home Address, Email, and optional Comments,
   stores the request in the "Resident Portal Access Requests" Google
   Sheet tab for Board review, and best-effort notifies the board by
   email. Never checks the resident directory, never grants access, and
   never touches RESIDENT_PORTAL_PASSWORD — approving a request and
   sending the password is an explicit, separate Board Portal action
   (see board-api.js: getAccessRequestPreview / sendAccessResponse).
   ═══════════════════════════════════════════════════════════ */
const https = require("https");
const {
  TAB_NAME,
  MAX_BODY_BYTES,
  validateSubmission,
  buildAccessRequestRow,
  ensureAccessRequestsTab,
  getGoogleToken,
  sheetsAppend,
  withTimeout,
  WRITE_TIMEOUT_MS,
} = require("./lib/access-requests");

const BOARD_EMAIL = "hoa.twinlakes.board@gmail.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GENERIC_CONFIRMATION =
  "Thank you. Your request has been received and the Board will review it and respond by email.";
const GENERIC_FAILURE =
  "We could not submit your request right now. Please try again later, or email the Board directly at hoa.twinlakes.board@gmail.com.";

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(body) };
}

// ── Gmail OAuth (refresh token) — board notification only, best-effort ──
// Duplicated pattern (see submit-request.js) rather than a shared lib, so
// this file has no dependency beyond lib/access-requests.js.
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
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function refreshGmailToken() {
  const body = `client_id=${encodeURIComponent(process.env.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(process.env.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token`;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d).access_token); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function encodeHeader(value) {
  const s = String(value == null ? "" : value);
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function buildEmail(to, subject, text) {
  const raw = [
    `From: Twin Lakes HOA <${BOARD_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    text,
  ].join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

async function notifyBoard(id, fields) {
  const gmailToken = await refreshGmailToken();
  const text =
`A resident submitted a Resident Portal access request via the website.

Request ID:   ${id}
Name:         ${fields.firstName} ${fields.lastName}
Address:      ${fields.homeAddress}
Email:        ${fields.email}
Comments:     ${fields.comments || "(none)"}

Open the Board Portal → Portal Access Requests to review and respond.`;
  const raw = buildEmail(BOARD_EMAIL, `[Portal Access Request] ${fields.firstName} ${fields.lastName} (${id})`, text);
  await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
    { Authorization: `Bearer ${gmailToken}`, "Content-Type": "application/json" }, { raw });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const rawBody = event.body || "";
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return jsonResponse(400, { error: "Request too large." });
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: "Malformed request." });
  }

  const result = validateSubmission(data);

  // Honeypot triggered: respond exactly like a real success (never reveal
  // detection) but skip the Sheets write and the board notification.
  if (!result.ok && result.honeypot) {
    return jsonResponse(200, { ok: true, message: GENERIC_CONFIRMATION });
  }
  if (!result.ok) {
    return jsonResponse(400, { error: result.error });
  }

  try {
    const token = await getGoogleToken();
    await ensureAccessRequestsTab(token);
    const row = buildAccessRequestRow(result.fields);
    const id = row[0];
    await withTimeout(
      sheetsAppend(token, `'${TAB_NAME}'!A:O`, [row]),
      WRITE_TIMEOUT_MS,
      new Error("access_request_write_timeout")
    );

    // Best-effort: the request is already saved above, so an expired Gmail
    // token must not lose the submission or fail the resident's request.
    try {
      await notifyBoard(id, result.fields);
    } catch (mailErr) {
      console.error(JSON.stringify({ accessRequestNotifyFailed: true, id }));
    }

    return jsonResponse(200, { ok: true, message: GENERIC_CONFIRMATION });
  } catch (err) {
    console.error(JSON.stringify({ accessRequestSubmitFailed: true, category: String(err && err.message || err).slice(0, 100) }));
    return jsonResponse(500, { error: GENERIC_FAILURE });
  }
};
