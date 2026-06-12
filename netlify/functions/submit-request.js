/* ═══════════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — submit-request.js
   ───────────────────────────────────────────────────────────
   Handles resident request submissions from the website form.
   For each submission it:
     1. Saves the request to the "Resident_Requests" Google Sheet tab
     2. Emails the Board and/or Mulloy (Eddie) with the details
     3. Sends the resident a confirmation email
   Reuses the same env vars as board-api.js — no new setup needed.
   ═══════════════════════════════════════════════════════════ */

const https = require("https");

// ── Config (same env vars used elsewhere) ──────────────────
const SHEET_ID      = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL      = process.env.GOOGLE_SA_EMAIL;
const SA_KEY        = process.env.GOOGLE_SA_KEY;
const SCOPES        = ["https://www.googleapis.com/auth/spreadsheets"];
const REQUESTS_TAB  = "Resident_Requests";
const ARC_TAB       = "ARC_Requests";

const BOARD_EMAIL   = "hoa.twinlakes.board@gmail.com";
const MULLOY_EMAIL  = "edouglas@mulloyproperties.com";

// ── Generic HTTPS JSON request ─────────────────────────────
function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname, path, method,
      headers: { ...headers, ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Google service-account auth (for Sheets) ───────────────
function getGoogleToken(serviceEmail, privateKey, scopes) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: serviceEmail, scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now
    })).toString("base64url");

    const crypto = require("crypto");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(privateKey.replace(/\\n/g, "\n"), "base64url");
    const jwt = `${header}.${payload}.${sig}`;

    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(new Error(d)); });
    });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ── Gmail OAuth (refresh token) for sending mail ───────────
async function refreshGmailToken() {
  const body = `client_id=${encodeURIComponent(process.env.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(process.env.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token`;
  const r = await new Promise((resolve, reject) => {
    const req = https.request({ hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }},
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
    req.on("error", reject); req.write(body); req.end();
  });
  return r.access_token;
}

function buildEmail(to, subject, text, replyTo) {
  const lines = [
    `From: Twin Lakes HOA <${BOARD_EMAIL}>`,
    `To: ${to}`,
  ];
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    text
  );
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

async function sendEmail(gmailToken, to, subject, text, replyTo) {
  const raw = buildEmail(to, subject, text, replyTo);
  const r = await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
    { Authorization: `Bearer ${gmailToken}`, "Content-Type": "application/json" }, { raw });
  if (r.status >= 400) throw new Error(`Gmail send failed (${r.status}): ${String(r.body).slice(0, 200)}`);
  return r;
}

// Builds a multipart/mixed email with file attachments (files: [{filename, mimeType, data(base64)}])
function buildEmailWithAttachments(to, subject, text, replyTo, files) {
  const boundary = "mixed_tl_req_boundary";
  const head = [
    `From: Twin Lakes HOA <${BOARD_EMAIL}>`,
    `To: ${to}`,
  ];
  if (replyTo) head.push(`Reply-To: ${replyTo}`);
  head.push(
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    text,
    ``
  );
  let msg = head.join("\r\n");
  for (const f of files) {
    if (!f || !f.data) continue;
    msg += [
      `--${boundary}`,
      `Content-Type: ${f.mimeType || "application/octet-stream"}; name="${f.filename || "attachment"}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${f.filename || "attachment"}"`,
      ``,
      // wrap base64 at 76 chars per line (RFC 2045)
      (f.data.match(/.{1,76}/g) || []).join("\r\n"),
      ``
    ].join("\r\n");
  }
  msg += `--${boundary}--`;
  return Buffer.from(msg).toString("base64url");
}

async function sendEmailWithAttachments(gmailToken, to, subject, text, replyTo, files) {
  const list = Array.isArray(files) ? files.filter(f => f && f.data) : [];
  if (!list.length) return sendEmail(gmailToken, to, subject, text, replyTo);
  const raw = buildEmailWithAttachments(to, subject, text, replyTo, list);
  const r = await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
    { Authorization: `Bearer ${gmailToken}`, "Content-Type": "application/json" }, { raw });
  if (r.status >= 400) throw new Error(`Gmail send failed (${r.status}): ${String(r.body).slice(0, 200)}`);
  return r;
}

// ── Sheets helpers ─────────────────────────────────────────
async function sheetsAppend(token, range, values) {
  const r = await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${token}` }, { values });
  return JSON.parse(r.body);
}

async function sheetsUpdate(token, range, values) {
  const r = await httpsReq("PUT", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { Authorization: `Bearer ${token}` }, { range, majorDimension: "ROWS", values });
  return JSON.parse(r.body);
}

// Creates the Resident_Requests tab (with headers) if it doesn't exist yet.
async function ensureRequestsTab(token) {
  const meta = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}`, { Authorization: `Bearer ${token}` });
  const spreadsheet = JSON.parse(meta.body);
  const existing = (spreadsheet.sheets || []).map(s => s.properties.title);
  if (existing.includes(REQUESTS_TAB)) return;

  await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    { Authorization: `Bearer ${token}` },
    { requests: [{ addSheet: { properties: { title: REQUESTS_TAB } } }] });

  await sheetsUpdate(token, `${REQUESTS_TAB}!A1`, [[
    "id", "date_received", "request_type", "name", "email",
    "address", "subject", "description", "sent_to", "status",
    "assigned_to", "board_notes"
  ]]);
}

// Ensures the ARC_Requests tab exists with the full schema the board dashboard expects.
async function ensureArcTab(token) {
  const meta = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}`, { Authorization: `Bearer ${token}` });
  const existing = (JSON.parse(meta.body).sheets || []).map(s => s.properties.title);
  if (existing.includes(ARC_TAB)) return;

  await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
    { Authorization: `Bearer ${token}` },
    { requests: [{ addSheet: { properties: { title: ARC_TAB } } }] });

  await sheetsUpdate(token, `${ARC_TAB}!A1`, [[
    "id","date_received","homeowner_name","homeowner_email","address","request_type","description","email_subject","drive_folder_url","attachment_urls","ai_summary","ai_recommendation","ai_reasoning","ai_pros","ai_cons","tony_vote","tony_conditions","tony_note","tony_voted_at","yashu_vote","yashu_conditions","yashu_note","yashu_voted_at","ramana_vote","ramana_conditions","ramana_note","ramana_voted_at","raja_vote","raja_conditions","raja_note","raja_voted_at","aimee_vote","aimee_conditions","aimee_note","aimee_voted_at","mike_vote","mike_conditions","mike_note","mike_voted_at","vote_count","final_status","consolidated_conditions","notified_mulloy","notified_at","days_open","conflict_flag"
  ]]);
}

// Builds the human-readable ARC detail block stored in the description column.
function buildArcDescription(message, d) {
  const yn = v => v || "—";
  const att = [];
  if (d.attaching) {
    if (d.attaching.plotPlan) att.push("Plot plan");
    if (d.attaching.plans) att.push("Blueprints/plans");
    if (d.attaching.similar) att.push("Similar-project photo");
  }
  return [
    message,
    "",
    "──────── ARC FORM DETAILS ────────",
    `Request type:        ${d.subtype || "—"}`,
    `Phone:               ${d.phone || "—"}${d.phoneType ? ` (${d.phoneType})` : ""}`,
    `Materials / match:   ${d.materials || "—"}`,
    `Completed by:        ${d.completedBy || "—"}`,
    `Start date:          ${d.startDate || "—"}`,
    `End date:            ${d.endDate || "—"}`,
    `Time to complete:    ${d.duration || "—"}`,
    `Building permits:    ${yn(d.permits)}`,
    `Landscape drawings:  ${yn(d.landscapeDrawings)}`,
    `Irrigation responsibility understood: ${yn(d.irrigationAck)}`,
    `Read Deed/Bylaws/Rules:               ${yn(d.readRules)}`,
    `Understands arrears policy:           ${yn(d.arrearsAck)}`,
    `Attaching:           ${att.length ? att.join(", ") : "—"}`,
    "",
    `Acknowledgment: ${d.acknowledged ? "AGREED" : "NOT AGREED"} — e-signed by "${d.signature || "—"}" on ${d.signedDate || "—"}`
  ].join("\n");
}

// ── CORS headers ───────────────────────────────────────────
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Main handler ───────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
  if (event.httpMethod !== "POST")  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: "Method not allowed" }) };

  // 1. Parse and validate the submission
  let p;
  try { p = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Bad request" }) }; }

  const name        = (p.name || "").trim();
  const email       = (p.email || "").trim();
  const address     = (p.address || "").trim();
  const requestType = (p.requestType || "").trim();
  const subject     = (p.subject || "").trim();
  const message     = (p.message || "").trim();
  const sendTo      = (p.sendTo || "both").trim();

  if (!name || !email || !message || !requestType) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Missing required fields" }) };
  }
  // Basic email sanity check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid email address" }) };
  }

  // ── ARC requests get their own richer flow (Drive upload + ARC_Requests sheet) ──
  if (requestType === "ARC") {
    return await handleArcSubmission({ p, name, email, address, subject, message, sendTo });
  }

  const id = "REQ-" + Date.now().toString(36).toUpperCase();
  const receivedAt = new Date().toISOString();
  const cleanSubject = subject || `${requestType} request`;

  try {
    // 2. Save to Google Sheets
    const googleToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
    await ensureRequestsTab(googleToken);
    await sheetsAppend(googleToken, `${REQUESTS_TAB}!A:L`, [[
      id, receivedAt, requestType, name, email,
      address, cleanSubject, message, sendTo, "New",
      "", ""
    ]]);

    // 3. Email the board and/or Mulloy
    const recipients = [];
    if (sendTo === "board" || sendTo === "both") recipients.push(BOARD_EMAIL);
    if (sendTo === "mulloy" || sendTo === "both") recipients.push(MULLOY_EMAIL);
    if (recipients.length === 0) recipients.push(BOARD_EMAIL);

    // Email is best-effort: the request is already saved above, so an expired
    // Gmail token must not cause the resident's submission to be lost.
    let emailSent = true;
    try {
    const gmailToken = await refreshGmailToken();

    const notifyBody =
`New resident request submitted via the Twin Lakes website.

Request ID:   ${id}
Type:         ${requestType}
From:         ${name}
Email:        ${email}
Address:      ${address || "(not provided)"}
Subject:      ${cleanSubject}

Message:
${message}

──────────────────────────────────────────
Reply directly to this email to respond to the resident.
View all requests on the Board Dashboard.`;

    // Notify board/Mulloy (Reply-To set to resident so replies go to them)
    await sendEmail(gmailToken, recipients.join(", "),
      `[${requestType}] ${cleanSubject} — ${name} (${id})`, notifyBody, email);

    // 4. Send the resident a confirmation
    const confirmBody =
`Hi ${name},

Thank you for contacting the Twin Lakes at Floyds Fork HOA. We have received your request and the board will review it.

Your reference number is: ${id}
Request type: ${requestType}

Summary of what you sent:
${message}

We aim to respond within 2–3 business days. For urgent property matters, please call Mulloy Properties at (502) 498-2411.

Best regards,
Twin Lakes at Floyds Fork HOA Board`;

    // Best-effort: don't fail the whole request if the confirmation bounces
    try { await sendEmail(gmailToken, email, `We received your request (${id}) — Twin Lakes HOA`, confirmBody, BOARD_EMAIL); }
    catch (e) { /* ignore confirmation failure */ }
    } catch (mailErr) {
      emailSent = false;
      console.error("Request email notification failed:", String(mailErr).slice(0, 200));
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, id, emailSent }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not submit request. Please email the board directly.", detail: String(err).slice(0, 200) }) };
  }
};

// ── ARC submission handler ─────────────────────────────────
async function handleArcSubmission({ p, name, email, address, subject, message, sendTo }) {
  const d = p.arcDetails || {};
  const files = Array.isArray(p.files) ? p.files : [];
  const id = "ARC-" + Date.now().toString(36).toUpperCase();
  const receivedAt = new Date().toISOString();
  const cleanSubject = subject || `ARC — ${d.subtype || "Architectural Request"}`;

  try {
    const googleToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
    await ensureArcTab(googleToken);

    // Attachments are delivered to the board via email (Google service accounts
    // have no Drive storage quota, so files can't be saved to Drive directly).
    const validFiles = files.filter(f => f && f.data);
    const fileNames  = validFiles.map(f => f.filename || "attachment");
    const attachmentNote = validFiles.length
      ? `${validFiles.length} file(s) emailed to the board: ${fileNames.join(", ")}`
      : "";

    // Save to ARC_Requests (description holds the full structured ARC detail)
    const description = buildArcDescription(message, d);
    // Columns A–P (P = first vote column, left blank). Row: id..ai_cons then start votes empty.
    await sheetsAppend(googleToken, `${ARC_TAB}!A:P`, [[
      id, receivedAt, name, email, address,
      d.subtype || "Other", description, cleanSubject, "", attachmentNote,
      "", "", "", "", "", ""   // ai_summary..ai_cons + leading blank for first vote col
    ]]);

    // 3. Notify board + Mulloy
    const recipients = [];
    if (sendTo === "board" || sendTo === "both") recipients.push(BOARD_EMAIL);
    if (sendTo === "mulloy" || sendTo === "both") recipients.push(MULLOY_EMAIL);
    if (recipients.length === 0) { recipients.push(BOARD_EMAIL); recipients.push(MULLOY_EMAIL); }

    // Email notifications are best-effort: the request is already saved above,
    // so a temporarily expired Gmail token must not lose the submission.
    let emailSent = true;
    try {
    const gmailToken = await refreshGmailToken();
    const notifyBody =
`New ARC (Architectural) request submitted via the Twin Lakes website.

Request ID:   ${id}
From:         ${name}
Email:        ${email}
Address:      ${address || "(not provided)"}
${description}

Attachments:  ${validFiles.length ? `${validFiles.length} file(s) attached to this email: ${fileNames.join(", ")}` : "(none)"}

──────────────────────────────────────────
Open the Board Dashboard → ARC Requests to review and vote.
Reply to this email to contact the resident directly.`;

    await sendEmailWithAttachments(gmailToken, recipients.join(", "),
      `[ARC] ${d.subtype || "Request"} — ${name} (${id})`, notifyBody, email, validFiles);

    // 4. Confirmation to resident
    const confirmBody =
`Hi ${name},

Thank you for submitting your Architectural Request (ARC) to the Twin Lakes at Floyds Fork HOA.

Your reference number is: ${id}
Request: ${d.subtype || "Architectural change"} at ${address || "your property"}

The board will review your request and any attachments. Please remember that no work may begin until you receive written approval from the HOA Board.

We aim to respond within 2–3 business days. Questions? Contact Mulloy Properties at (502) 498-2411.

Best regards,
Twin Lakes at Floyds Fork HOA Board`;
    try { await sendEmail(gmailToken, email, `We received your ARC request (${id}) — Twin Lakes HOA`, confirmBody, BOARD_EMAIL); }
    catch (e) { /* ignore */ }
    } catch (mailErr) {
      // Request is saved; notifications failed (e.g. expired Gmail token).
      emailSent = false;
      console.error("ARC email notification failed:", String(mailErr).slice(0, 200));
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true, id, emailSent }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Could not submit ARC request. Please email the board directly.", detail: String(err).slice(0, 200) }) };
  }
}
