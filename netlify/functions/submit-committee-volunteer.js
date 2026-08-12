"use strict";
/* ═══════════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — submit-committee-volunteer.js
   ───────────────────────────────────────────────────────────
   Public endpoint behind committee-volunteer.html. For each valid
   submission it:
     1. Saves the entry to the "Committee_Volunteers" Google Sheet tab
     2. Emails the Board + Mulloy (Eddie) with the details
     3. Sends the resident a confirmation email
   Sheets append is authoritative — email is best-effort, same
   convention as resident-access-request.js: an expired Gmail token
   must never lose an already-saved submission.
   ═══════════════════════════════════════════════════════════ */
const https = require("https");
const {
  TAB_NAME,
  MAX_BODY_BYTES,
  validateSubmission,
  buildVolunteerRow,
  ensureVolunteersTab,
  getGoogleToken,
  sheetsAppend,
  withTimeout,
  WRITE_TIMEOUT_MS,
} = require("./lib/committee-volunteers");

const BOARD_EMAIL = "hoa.twinlakes.board@gmail.com";
const MULLOY_EMAIL = "edouglas@mulloyproperties.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GENERIC_CONFIRMATION =
  "Thank you for your interest! Your submission has been received and the Board will review it.";
const GENERIC_FAILURE =
  "We could not submit your form right now. Please try again later, or download and email the form directly to edouglas@mulloyproperties.com, copying hoa.twinlakes.board@gmail.com.";

function jsonResponse(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(body) };
}

// ── Gmail OAuth (refresh token) — notification/confirmation, best-effort.
// Duplicated pattern (see resident-access-request.js, submit-request.js) —
// kept self-contained beyond lib/committee-volunteers.js, same convention
// as the rest of this codebase.
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

// Plain-text only (never HTML) — the same choice every mailer in this repo
// makes, which sidesteps HTML-injection risk in outgoing mail entirely
// rather than needing an HTML sanitizer for user-submitted text.
function buildEmail(to, subject, text, replyTo) {
  const lines = [
    `From: Twin Lakes HOA <${BOARD_EMAIL}>`,
    `To: ${to}`,
  ];
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(
    `Subject: ${encodeHeader(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    text,
  );
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

async function sendEmail(gmailToken, to, subject, text, replyTo) {
  const raw = buildEmail(to, subject, text, replyTo);
  const r = await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
    { Authorization: `Bearer ${gmailToken}`, "Content-Type": "application/json" }, { raw });
  if (r.status >= 400) throw new Error(`Gmail send failed (${r.status})`);
  return r;
}

function notificationBody(fields) {
  return `A resident submitted the Committee Volunteer Interest Form via the website.

RESIDENT INFORMATION
Name:               ${fields.name}
Property Address:   ${fields.address}
Email:              ${fields.email}
Phone:              ${fields.phone || "(not provided)"}

COMMITTEE INTEREST
Committees:         ${fields.committees.join("; ")}
First Choice:       ${fields.firstChoice || "(not specified)"}
Second Choice:      ${fields.secondChoice || "(not specified)"}

SKILLS & EXPERIENCE
${fields.skills || "(none provided)"}

Prior committee/volunteer experience: ${fields.priorExperience}${fields.priorExperienceDetails ? `\n${fields.priorExperienceDetails}` : ""}

INTEREST & CONTRIBUTION
${fields.interest}

CONFLICT OF INTEREST
${fields.conflict}${fields.conflictDetails ? `\n${fields.conflictDetails}` : ""}

ACKNOWLEDGMENT
Acknowledged and certified by: ${fields.typedName}

──────────────────────────────────────────
Reply directly to this email to contact the resident.`;
}

async function notifyBoardAndMulloy(fields) {
  const gmailToken = await refreshGmailToken();
  const text = notificationBody(fields);
  await sendEmail(
    gmailToken,
    `${BOARD_EMAIL}, ${MULLOY_EMAIL}`,
    `New Committee Volunteer Submission – ${fields.name}`,
    text,
    fields.email
  );
  return gmailToken;
}

async function confirmResident(gmailToken, fields) {
  const text = `Hi ${fields.name},

Thank you for your interest in volunteering for a Twin Lakes at Floyds Fork HOA committee. We've received your submission and the Board will review it.

Committees selected: ${fields.committees.join("; ")}

Submitting this form expresses your interest only and does not guarantee appointment. Committee membership and assignments are subject to appointment or approval in accordance with the HOA governing documents and applicable Board procedures, based on community needs, committee composition, experience, availability, and other relevant considerations.

If you have any questions, contact the board at ${BOARD_EMAIL}.

Best regards,
Twin Lakes at Floyds Fork HOA Board`;
  await sendEmail(gmailToken, fields.email, "We received your Committee Volunteer Interest Form — Twin Lakes HOA", text, BOARD_EMAIL);
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

  // Honeypot: respond exactly like a real success (never reveal detection)
  // but skip the Sheets write and every email.
  if (!result.ok && result.honeypot) {
    return jsonResponse(200, { ok: true, message: GENERIC_CONFIRMATION });
  }
  if (!result.ok) {
    return jsonResponse(400, { error: result.error });
  }

  try {
    const token = await getGoogleToken();
    await ensureVolunteersTab(token);
    const row = buildVolunteerRow(result.fields);
    await withTimeout(
      sheetsAppend(token, `'${TAB_NAME}'!A:Q`, [row]),
      WRITE_TIMEOUT_MS,
      new Error("committee_volunteer_write_timeout")
    );

    // Best-effort: the submission is already saved above, so an expired
    // Gmail token must not lose it or fail the resident's submission.
    try {
      const gmailToken = await notifyBoardAndMulloy(result.fields);
      try { await confirmResident(gmailToken, result.fields); } catch (e) { /* confirmation is a nice-to-have */ }
    } catch (mailErr) {
      console.error(JSON.stringify({ committeeVolunteerNotifyFailed: true }));
    }

    return jsonResponse(200, { ok: true, message: GENERIC_CONFIRMATION });
  } catch (err) {
    console.error(JSON.stringify({ committeeVolunteerSubmitFailed: true, category: String(err && err.message || err).slice(0, 100) }));
    return jsonResponse(500, { error: GENERIC_FAILURE });
  }
};
