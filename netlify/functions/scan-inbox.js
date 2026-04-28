const https = require("https");
const crypto = require("crypto");

// ── Helpers ───────────────────────────────────────────────
function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const req = https.request({
      hostname, path, method,
      headers: { ...headers, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) }
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Google Service Account Token ──────────────────────────
function getGoogleToken(scopes) {
  return new Promise((resolve, reject) => {
    const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
    const SA_KEY = process.env.GOOGLE_SA_KEY.replace(/\\n/g, "\n");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: SA_EMAIL, scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now
    })).toString("base64url");
    const sign = crypto.createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const sig = sign.sign(SA_KEY, "base64url");
    const jwt = `${header}.${payload}.${sig}`;
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    httpsReq("POST", "oauth2.googleapis.com", "/token",
      { "Content-Type": "application/x-www-form-urlencoded" }, body)
      .then(r => { const j = JSON.parse(r.body); j.access_token ? resolve(j.access_token) : reject(new Error(r.body)); })
      .catch(reject);
  });
}

// ── Gmail Token via OAuth refresh ────────────────────────
async function getGmailToken() {
  const body = `client_id=${encodeURIComponent(process.env.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(process.env.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token`;
  const r = await httpsReq("POST", "oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded" }, body);
  return JSON.parse(r.body).access_token;
}

// ── Gmail helpers ─────────────────────────────────────────
async function listMessages(gmailToken, maxResults = 100) {
  const r = await httpsReq("GET", "gmail.googleapis.com",
    `/gmail/v1/users/me/messages?maxResults=${maxResults}&q=in:inbox`,
    { Authorization: `Bearer ${gmailToken}` });
  return JSON.parse(r.body).messages || [];
}

async function getMessage(gmailToken, id) {
  const r = await httpsReq("GET", "gmail.googleapis.com",
    `/gmail/v1/users/me/messages/${id}?format=full`,
    { Authorization: `Bearer ${gmailToken}` });
  return JSON.parse(r.body);
}

function getHeader(headers, name) {
  return (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";
}

function decodeBody(msg) {
  try {
    const parts = msg.payload.parts || [msg.payload];
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data)
        return Buffer.from(part.body.data, "base64url").toString("utf8").slice(0, 2000);
    }
    if (msg.payload.body?.data)
      return Buffer.from(msg.payload.body.data, "base64url").toString("utf8").slice(0, 2000);
  } catch {}
  return "";
}

function getAttachments(msg) {
  const attachments = [];
  const parts = msg.payload.parts || [];
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId, mimeType: part.mimeType });
    }
  }
  return attachments;
}

async function downloadAttachment(gmailToken, messageId, attachmentId) {
  const r = await httpsReq("GET", "gmail.googleapis.com",
    `/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { Authorization: `Bearer ${gmailToken}` });
  return JSON.parse(r.body).data;
}

// ── Google Drive helpers ──────────────────────────────────
async function createDriveFolder(driveToken, name, parentId) {
  const r = await httpsReq("POST", "www.googleapis.com", "/drive/v3/files",
    { Authorization: `Bearer ${driveToken}`, "Content-Type": "application/json" },
    { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] });
  return JSON.parse(r.body).id;
}

async function findOrCreateFolder(driveToken, name, parentId) {
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const r = await httpsReq("GET", "www.googleapis.com", `/drive/v3/files?q=${q}`,
    { Authorization: `Bearer ${driveToken}` });
  const files = JSON.parse(r.body).files || [];
  if (files.length > 0) return files[0].id;
  return createDriveFolder(driveToken, name, parentId);
}

async function uploadFileToDrive(driveToken, filename, mimeType, data, parentId) {
  const metadata = JSON.stringify({ name: filename, parents: [parentId] });
  const boundary = "boundary_tl_upload";
  const fileData = Buffer.from(data, "base64url");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    fileData,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=multipart",
      method: "POST",
      headers: { Authorization: `Bearer ${driveToken}`, "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": body.length }
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
    req.on("error", reject); req.write(body); req.end();
  });
  return `https://drive.google.com/file/d/${r.id}/view`;
}

async function uploadTextToDrive(driveToken, filename, content, parentId) {
  const buf = Buffer.from(content, "utf8");
  const metadata = JSON.stringify({ name: filename, parents: [parentId] });
  const boundary = "boundary_tl_txt";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "www.googleapis.com",
      path: "/upload/drive/v3/files?uploadType=multipart",
      method: "POST",
      headers: { Authorization: `Bearer ${driveToken}`, "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": body.length }
    }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
    req.on("error", reject); req.write(body); req.end();
  });
  return `https://drive.google.com/file/d/${r.id}/view`;
}

// ── Google Sheets helpers ─────────────────────────────────
async function sheetsAppend(sheetsToken, tab, values) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A:A")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${sheetsToken}`, "Content-Type": "application/json" },
    { values: [values] });
}

async function getExistingIds(sheetsToken, tab, colLetter) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const r = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!" + colLetter + ":" + colLetter)}`,
    { Authorization: `Bearer ${sheetsToken}` });
  const vals = JSON.parse(r.body).values || [];
  return new Set(vals.flat());
}

// ── Claude AI Analysis ────────────────────────────────────
async function analyzeWithClaude(emailData, category) {
  const systemPrompt = category === "ARC"
    ? `You are an HOA assistant analyzing ARC (Architectural Review Committee) requests for Twin Lakes at Floyds Fork HOA in Louisville, KY.

You have knowledge of these governing documents:
- CC&Rs: https://drive.google.com/file/d/1dQdZQ3sKi4SkXM-z5OnTncUEEqTTnuoX/view
- Architectural Guidelines: https://drive.google.com/file/d/1Es1AqJ_kjEpOdZQpY1T8fc8Dj9lt1n9q/view

Key rules:
- All exterior modifications require board approval before work begins
- Fences must be on property line, approved materials only
- Paint/stain requires color sample approval
- Decks, sheds, enclosures need ARC approval
- Garden beds, handrails, landscaping changes need approval
- No unfinished plywood, corrugated metal, or plastic panels visible from street

Analyze the ARC request and respond in this EXACT JSON format:
{
  "homeowner_name": "...",
  "homeowner_email": "...",
  "address": "...",
  "request_type": "Fence|Deck|Landscaping|Paint|Shed|Enclosure|Lighting|Other",
  "description": "one sentence description of what they want",
  "ai_summary": "2-3 sentence summary for board review",
  "ai_recommendation": "Approve|Deny|Conditional",
  "ai_reasoning": "2-3 sentence explanation referencing CC&Rs or guidelines",
  "ai_pros": "comma separated list of reasons to approve",
  "ai_cons": "comma separated list of concerns or reasons to deny",
  "conflict_flag": "yes|no"
}

IMPORTANT: Always label your output as AI-generated. Do not make final decisions.`
    : category === "Violation"
    ? `You are an HOA assistant analyzing violation reports for Twin Lakes at Floyds Fork HOA.

Analyze the email and respond in this EXACT JSON format:
{
  "homeowner_name": "...",
  "homeowner_email": "...",
  "address": "...",
  "violation_type": "Parking|Unauthorized Construction|Lawn|Noise|Trash|Other",
  "description": "one sentence description",
  "ai_summary": "2-3 sentence summary",
  "ai_suggestion": "suggested action for board consideration - reference CC&Rs where applicable"
}`
    : `You are an HOA assistant categorizing emails for Twin Lakes at Floyds Fork HOA board.

Respond in this EXACT JSON format:
{
  "from": "sender name or email",
  "category": "Financial|Insurance|Maintenance|Vendor|Legal|General Inquiry|Other",
  "ai_summary": "2-3 sentence summary of what needs board attention",
  "needs_attention": "yes|no",
  "attention_reason": "why board needs to act on this"
}`;

  const userPrompt = `Analyze this email:

From: ${emailData.from}
Date: ${emailData.date}
Subject: ${emailData.subject}
Body: ${emailData.body}`;

  const r = await httpsReq("POST", "api.anthropic.com", "/v1/messages",
    { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    { model: "claude-haiku-4-5-20251001", max_tokens: 1000, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] });

  const text = JSON.parse(r.body).content?.[0]?.text || "{}";
  try {
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(clean);
  } catch { return {}; }
}

// ── Categorize email ──────────────────────────────────────
async function categorizeEmail(emailData) {
  const subject = emailData.subject.toLowerCase();
  const body = emailData.body.toLowerCase();
  const combined = subject + " " + body;

  // Quick pattern matching first
  if (combined.includes("arc") || combined.includes("architectural") || combined.includes("request") ||
      combined.includes("fence") || combined.includes("deck") || combined.includes("landscap") ||
      combined.includes("paint") || combined.includes("shed") || combined.includes("modification") ||
      combined.includes("approval")) return "ARC";

  if (combined.includes("violation") || combined.includes("parking") || combined.includes("overnight") ||
      combined.includes("complaint") || combined.includes("unauthorized") || combined.includes("encroach")) return "Violation";

  // Use Claude for ambiguous ones
  const r = await httpsReq("POST", "api.anthropic.com", "/v1/messages",
    { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    { model: "claude-haiku-4-5-20251001", max_tokens: 50,
      messages: [{ role: "user", content: `Classify this HOA email as exactly one word: ARC, Violation, or Other.\nSubject: ${emailData.subject}\nBody preview: ${emailData.body.slice(0,300)}` }] });
  const cat = JSON.parse(r.body).content?.[0]?.text?.trim() || "Other";
  if (cat.includes("ARC")) return "ARC";
  if (cat.includes("Violation")) return "Violation";
  return "Other";
}

// ── Generate item ID ──────────────────────────────────────
function generateId(type, address, existingIds) {
  const year = new Date().getFullYear();
  const prefix = type === "ARC" ? "ARC" : type === "Violation" ? "VIO" : "OTH";
  // Use house number from address
  const houseNum = (address || "").match(/^\d+/)?.[0] || Date.now().toString().slice(-5);
  let id = `${prefix}-${houseNum}`;
  let counter = 1;
  while (existingIds.has(id)) { id = `${prefix}-${houseNum}-${counter++}`; }
  return id;
}

// ── Main Handler ──────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  const { secret } = JSON.parse(event.body || "{}");
  if (secret !== process.env.DIGEST_SECRET)
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

  try {
    const [gmailToken, googleToken] = await Promise.all([
      getGmailToken(),
      getGoogleToken(["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"])
    ]);

    const ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const year = new Date().getFullYear().toString();

    // Get or create year folders
    const [arcYearFolder, vioYearFolder, othYearFolder] = await Promise.all([
      findOrCreateFolder(googleToken, year, await findOrCreateFolder(googleToken, "ARC Requests", ROOT_FOLDER)),
      findOrCreateFolder(googleToken, year, await findOrCreateFolder(googleToken, "Violations", ROOT_FOLDER)),
      findOrCreateFolder(googleToken, year, await findOrCreateFolder(googleToken, "Other", ROOT_FOLDER))
    ]);

    // Get existing IDs to avoid duplicates
    const [existingArcIds, existingVioIds, existingOthIds] = await Promise.all([
      getExistingIds(googleToken, "ARC_Requests", "A"),
      getExistingIds(googleToken, "Violations", "A"),
      getExistingIds(googleToken, "Other_Items", "A")
    ]);

    // Fetch emails
    console.log("Fetching emails...");
    const messages = await listMessages(gmailToken, 150);
    const results = { arc: 0, violation: 0, other: 0, skipped: 0 };

    for (const msgRef of messages.slice(0, 150)) {
      try {
        const msg = await getMessage(gmailToken, msgRef.id);
        const headers = msg.payload?.headers || [];
        const emailData = {
          id: msgRef.id,
          from: getHeader(headers, "From"),
          subject: getHeader(headers, "Subject"),
          date: getHeader(headers, "Date"),
          body: decodeBody(msg)
        };

        // Skip if no meaningful content
        if (!emailData.subject && !emailData.body) { results.skipped++; continue; }

        const category = await categorizeEmail(emailData);
        const analysis = await analyzeWithClaude(emailData, category);

        // Skip Other items that don't need attention
        if (category === "Other" && analysis.needs_attention === "no") { results.skipped++; continue; }

        const address = analysis.address || analysis.homeowner_name || "Unknown";
        const allIds = new Set([...existingArcIds, ...existingVioIds, ...existingOthIds]);
        const itemId = generateId(category, address, allIds);

        // Get attachments
        const attachments = getAttachments(msg);
        const attachmentUrls = [];

        if (category === "ARC" || attachments.length > 0) {
          // Create Drive folder for this item
          const folderName = `${itemId} — ${address.slice(0, 40)}`;
          const parentFolder = category === "ARC" ? arcYearFolder : category === "Violation" ? vioYearFolder : othYearFolder;
          const itemFolder = await createDriveFolder(googleToken, folderName, parentFolder);

          // Upload attachments
          for (const att of attachments) {
            try {
              const attData = await downloadAttachment(gmailToken, msgRef.id, att.attachmentId);
              const url = await uploadFileToDrive(googleToken, att.filename, att.mimeType, attData, itemFolder);
              attachmentUrls.push(url);
            } catch (e) { console.log(`Attachment error: ${e.message}`); }
          }

          // Save AI summary to Drive
          const summaryText = `TWIN LAKES HOA — AI SUMMARY\n⚠️ AI GENERATED — FOR BOARD REVIEW ONLY\n\nItem ID: ${itemId}\nDate: ${emailData.date}\nFrom: ${emailData.from}\nSubject: ${emailData.subject}\n\nSUMMARY:\n${analysis.ai_summary}\n\nRECOMMENDATION: ${analysis.ai_recommendation || analysis.ai_suggestion}\n\nREASONING:\n${analysis.ai_reasoning || analysis.ai_suggestion}\n\nPROS: ${analysis.ai_pros || "N/A"}\nCONS: ${analysis.ai_cons || "N/A"}\n\nGenerated: ${new Date().toISOString()}`;
          await uploadTextToDrive(googleToken, "ai_summary.txt", summaryText, itemFolder);

          const folderUrl = `https://drive.google.com/drive/folders/${itemFolder}`;

          if (category === "ARC") {
            await sheetsAppend(googleToken, "ARC_Requests", [
              itemId, emailData.date, analysis.homeowner_name || "", analysis.homeowner_email || "",
              analysis.address || "", analysis.request_type || "", analysis.description || "",
              emailData.subject, folderUrl, attachmentUrls.join(", "),
              analysis.ai_summary || "", analysis.ai_recommendation || "", analysis.ai_reasoning || "",
              analysis.ai_pros || "", analysis.ai_cons || "",
              "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
              "0", "Open", "", "No", "", "0", analysis.conflict_flag || "no"
            ]);
            existingArcIds.add(itemId);
            results.arc++;
          } else if (category === "Violation") {
            await sheetsAppend(googleToken, "Violations", [
              itemId, emailData.date, analysis.homeowner_name || "", analysis.homeowner_email || "",
              analysis.address || "", analysis.violation_type || "", analysis.description || "",
              emailData.subject, folderUrl, analysis.ai_summary || "", analysis.ai_suggestion || "",
              "Open", "[]", "0"
            ]);
            existingVioIds.add(itemId);
            results.violation++;
          }
        } else {
          // Other items - no folder needed if no attachments
          await sheetsAppend(googleToken, "Other_Items", [
            itemId, emailData.date, analysis.from || emailData.from, emailData.subject,
            analysis.category || "Other", analysis.ai_summary || "",
            "Open", "", analysis.needs_attention || "yes"
          ]);
          existingOthIds.add(itemId);
          results.other++;
        }

        allIds.add(itemId);

      } catch (e) {
        console.log(`Error processing message: ${e.message}`);
        results.skipped++;
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, results, message: `Processed: ${results.arc} ARC, ${results.violation} violations, ${results.other} other, ${results.skipped} skipped` })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
