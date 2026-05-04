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

async function createSheetTabs(token) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  try {
    const meta = await httpsReq("GET", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}`, { Authorization: `Bearer ${token}` });
    const spreadsheet = JSON.parse(meta.body);
    const existing = (spreadsheet.sheets || []).map(s => s.properties.title);
    console.log("Existing tabs:", existing.join(", "));
    const needed = ["ARC_Requests","Violations","Other_Items","Activity_Log"];
    const toAdd = needed.filter(n => !existing.includes(n));
    if (toAdd.length === 0) { console.log("All tabs exist"); return; }
    console.log("Creating tabs:", toAdd.join(", "));
    await httpsReq("POST", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      { requests: toAdd.map(title => ({ addSheet: { properties: { title } } })) });
    const headers = {
      ARC_Requests: [["id","date_received","homeowner_name","homeowner_email","address","request_type","description","email_subject","drive_folder_url","attachment_urls","ai_summary","ai_recommendation","ai_reasoning","ai_pros","ai_cons","tony_vote","tony_conditions","tony_note","tony_voted_at","yashu_vote","yashu_conditions","yashu_note","yashu_voted_at","ramana_vote","ramana_conditions","ramana_note","ramana_voted_at","raja_vote","raja_conditions","raja_note","raja_voted_at","aimee_vote","aimee_conditions","aimee_note","aimee_voted_at","mike_vote","mike_conditions","mike_note","mike_voted_at","vote_count","final_status","consolidated_conditions","notified_mulloy","notified_at","days_open","conflict_flag"]],
      Violations: [["id","date_received","homeowner_name","homeowner_email","address","violation_type","description","email_subject","drive_folder_url","ai_summary","ai_suggestion","status","comments_json","days_open"]],
      Other_Items: [["id","date_received","from","subject","category","ai_summary","status","drive_folder_url","needs_attention"]],
      Activity_Log: [["timestamp","board_member","action","item_id","item_type","details"]]
    };
    for (const tab of toAdd) {
      await httpsReq("PUT", "sheets.googleapis.com",
        `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A1")}?valueInputOption=RAW`,
        { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        { range: tab + "!A1", majorDimension: "ROWS", values: headers[tab] });
    }
    console.log("Tabs created successfully");
  } catch(e) { console.log("createSheetTabs error:", e.message); }
}

async function sheetsAppend(sheetsToken, tab, values) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const r = await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!A:A")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${sheetsToken}`, "Content-Type": "application/json" },
    { values: [values] });
  const result = JSON.parse(r.body);
  if (result.error) {
    console.log(`sheetsAppend ERROR for ${tab}:`, JSON.stringify(result.error));
  } else {
    console.log(`sheetsAppend OK for ${tab}: ${result.updates?.updatedRows || 0} rows added`);
  }
}

async function getExistingIds(sheetsToken, tab, colLetter) {
  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  try {
    const r = await httpsReq("GET", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tab + "!" + colLetter + ":" + colLetter)}`,
      { Authorization: `Bearer ${sheetsToken}` });
    const body = JSON.parse(r.body);
    if (body.error) return new Set(); // Tab doesn't exist yet
    const vals = body.values || [];
    return new Set(vals.flat().filter(v => v && v !== tab.split("_")[0])); // Exclude header
  } catch(e) { return new Set(); }
}

// ── Claude AI Analysis ────────────────────────────────────
async function analyzeWithClaude(emailData, category) {
  const systemPrompt = category === "ARC"
    ? `You are an HOA assistant analyzing ARC requests for Twin Lakes at Floyds Fork HOA in Louisville, KY.

CRITICAL: Extract ALL information from the email carefully. Look in the subject line, body, and any forwarded content.

Governing rules:
- All exterior modifications require board approval before work begins
- Fences must be on property line, approved materials only
- Paint/stain requires color sample approval
- Decks, sheds, enclosures need ARC approval
- Garden beds, handrails, landscaping changes need approval

You MUST respond with ONLY a valid JSON object, no other text:
{
  "homeowner_name": "Extract full name from email - look in signature, From field, or body. Never return Unknown.",
  "homeowner_email": "Extract email address from From field or body",
  "address": "Extract street address - look for numbers like 16004, 15805 followed by street name. Return FULL address.",
  "title": "Short descriptive title like Front Yard Tree Planting or Backyard Fence Installation",
  "request_type": "Fence|Deck|Landscaping|Paint|Shed|Enclosure|Lighting|Tree|Other",
  "description": "One clear sentence describing exactly what they want to do",
  "ai_summary": "2-3 sentences: who is requesting what at which address, and key details",
  "ai_recommendation": "Approve|Deny|Conditional",
  "ai_reasoning": "2-3 sentences explaining recommendation based on HOA guidelines",
  "ai_pros": "Reason 1, Reason 2, Reason 3",
  "ai_cons": "Concern 1, Concern 2",
  "conflict_flag": "yes|no"
}`
    : category === "Violation"
    ? `You are an HOA assistant analyzing violation reports for Twin Lakes at Floyds Fork HOA.

You MUST respond with ONLY a valid JSON object, no other text:
{
  "homeowner_name": "Full name if available, else Unknown",
  "homeowner_email": "Email if available, else empty string",
  "address": "Street address if mentioned, else Unknown",
  "violation_type": "Parking|Unauthorized Construction|Lawn|Noise|Trash|Lighting|Other",
  "description": "One sentence describing the violation",
  "ai_summary": "2-3 sentences summarizing the violation and its impact",
  "ai_suggestion": "Specific suggested action referencing CC&Rs"
}`
    : `You are an HOA assistant categorizing emails for Twin Lakes at Floyds Fork HOA board.

You MUST respond with ONLY a valid JSON object, no other text:
{
  "from": "Sender name and email",
  "category": "Financial|Insurance|Maintenance|Vendor|Legal|General Inquiry|Other",
  "ai_summary": "2-3 sentences summarizing what this email is about and what action if any is needed",
  "needs_attention": "yes|no",
  "attention_reason": "Specific reason board needs to act, or empty if no action needed"
}`;

  const userPrompt = `Analyze this HOA email carefully and extract all details:

FROM: ${emailData.from}
DATE: ${emailData.date}
SUBJECT: ${emailData.subject}
BODY:
${emailData.body}

Remember: Return ONLY valid JSON, nothing else.`;

  try {
    const r = await httpsReq("POST", "api.anthropic.com", "/v1/messages",
      { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      { model: "claude-haiku-4-5-20251001", max_tokens: 1000, 
        system: systemPrompt, 
        messages: [{ role: "user", content: userPrompt }] });

    const resp = JSON.parse(r.body);
    if (resp.error) {
      console.log("Claude API error:", JSON.stringify(resp.error));
      return {};
    }
    const text = resp.content?.[0]?.text || "{}";
    console.log("Claude raw response:", text.slice(0, 300));
    const clean = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(clean);
  } catch(e) { 
    console.log("Claude error:", e.message);
    return {}; 
  }
}

// ── Categorize email ──────────────────────────────────────
async function categorizeEmail(emailData) {
  const subject = emailData.subject.toLowerCase();
  const body = emailData.body.toLowerCase();
  const combined = subject + " " + body;

  // FIX 4: Explicitly exclude financial/insurance/vendor emails first
  const financialKeywords = ["financial", "financials", "invoice", "payment", "insurance", "premium", "budget", "expense", "bill", "receipt", "quarterly", "annual report", "bank", "deposit", "reserve fund"];
  if (financialKeywords.some(k => combined.includes(k))) return "Other";

  // Must be clearly an ARC request - not just any "request"
  const arcKeywords = ["arc request", "arc form", "architectural review", "modification request", "exterior modification",
    "fence", "deck", "landscaping", "front yard", "backyard", "back yard", "tree planting", "shed", "enclosure",
    "paint color", "stain", "handrail", "garden bed", "paver", "patio", "trimlight", "lighting installation",
    "retaining wall", "brick border", "roof", "addition", "pergola"];
  if (arcKeywords.some(k => combined.includes(k))) return "ARC";

  const violationKeywords = ["violation", "parking", "overnight parking", "complaint", "unauthorized construction",
    "code violation", "non-compliance", "encroachment", "reported by hoa"];
  if (violationKeywords.some(k => combined.includes(k))) return "Violation";

  // Use Claude for genuinely ambiguous ones
  try {
    const r = await httpsReq("POST", "api.anthropic.com", "/v1/messages",
      { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      { model: "claude-haiku-4-5-20251001", max_tokens: 50,
        messages: [{ role: "user", content: `Classify this HOA email. Reply with ONLY one word: ARC (homeowner requesting approval for exterior modification), Violation (rule violation reported), or Other (everything else including financial, insurance, maintenance, vendor).\nSubject: ${emailData.subject}\nBody: ${emailData.body.slice(0,400)}` }] });
    const cat = JSON.parse(r.body).content?.[0]?.text?.trim() || "Other";
    if (cat.includes("ARC")) return "ARC";
    if (cat.includes("Violation")) return "Violation";
  } catch(e) { console.log("Categorize error:", e.message); }
  return "Other";
}

// ── Generate item ID ──────────────────────────────────────
function generateId(type, address, existingIds) {
  const prefix = type === "ARC" ? "ARC" : type === "Violation" ? "VIO" : "OTH";
  // Extract house number from address like "16004 Cumberland Lake Circle"
  const houseNum = (address || "").match(/\b(1[0-9]{4})\b/)?.[0] || // 5-digit house numbers
                   (address || "").match(/^(\d+)/)?.[0] || // any leading digits
                   Date.now().toString().slice(-5);
  let id = `${prefix}-${houseNum}`;
  let counter = 1;
  while (existingIds.has(id)) { id = `${prefix}-${houseNum}-${counter++}`; }
  return id;
}


// ── Resident Directory Lookup ─────────────────────────────
let residentCache = null;
async function getResidentByEmail(token, email) {
  if (!process.env.RESIDENT_SHEET_ID) return null;
  try {
    if (!residentCache) {
      const SHEET_ID = process.env.RESIDENT_SHEET_ID;
      const r = await httpsReq("GET", "sheets.googleapis.com",
        `/v4/spreadsheets/${SHEET_ID}/values/A:D`,
        { Authorization: `Bearer ${token}` });
      const rows = JSON.parse(r.body).values || [];
      residentCache = rows.slice(1); // Skip header
      console.log(`Loaded ${residentCache.length} residents from directory`);
    }
    if (!email) return null;
    const emailLower = email.toLowerCase();
    const match = residentCache.find(row => {
      const rowEmails = (row[3] || "").toLowerCase(); // Column D = Email (may have multiple)
      return rowEmails.includes(emailLower) || emailLower.includes(rowEmails.split(";")[0].trim());
    });
    if (match) {
      const fullAddress = `${(match[1] || "").trim()} ${(match[2] || "").trim()}`.trim();
      return { name: match[0] || "", address: fullAddress, email: (match[3] || "").split(";")[0].trim() };
    }
  } catch(e) { console.log("Resident lookup error:", e.message); }
  return null;
}

async function getResidentByAddress(token, address) {
  if (!process.env.RESIDENT_SHEET_ID || !address) return null;
  try {
    if (!residentCache) await getResidentByEmail(token, ""); // Initialize cache
    const addrLower = address.toLowerCase();
    const houseNum = addrLower.match(/\b(1[0-9]{4})\b/)?.[0];
    if (!houseNum) return null;
    const match = residentCache.find(row => (row[1] || "").toString().trim() === houseNum);
    if (match) {
      const fullAddress = `${(match[1] || "").trim()} ${(match[2] || "").trim()}`.trim();
      return { name: match[0] || "", address: fullAddress, email: (match[3] || "").split(";")[0].trim() };
    }
  } catch(e) {}
  return null;
}

// ── Main Handler ──────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  const reqBody = JSON.parse(event.body || "{}");
  const { secret } = reqBody;
  if (secret !== process.env.DIGEST_SECRET)
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };

  try {
    const [gmailToken, googleToken] = await Promise.all([
      getGmailToken(),
      getGoogleToken(["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"])
    ]);

    const ROOT_FOLDER = process.env.GOOGLE_DRIVE_FOLDER_ID;

    // Create sheet tabs if they don't exist
    console.log("Ensuring sheet tabs exist...");
    await createSheetTabs(googleToken);
    const year = new Date().getFullYear().toString();

    // Get or create year folders
    const [arcYearFolder, vioYearFolder, othYearFolder] = await Promise.all([
      findOrCreateFolder(googleToken, year, await findOrCreateFolder(googleToken, "ARC Requests", ROOT_FOLDER)),
      findOrCreateFolder(googleToken, year, await findOrCreateFolder(googleToken, "Violations", ROOT_FOLDER)),
      findOrCreateFolder(googleToken, year, await findOrCreateFolder(googleToken, "Other", ROOT_FOLDER))
    ]);

    // Get existing Gmail message IDs to avoid duplicates (column H = email_subject, use message IDs stored separately)
    // We store Gmail message ID in a hidden way - check the drive_folder_url column for existing items
    const [existingArcIds, existingVioIds, existingOthIds] = await Promise.all([
      getExistingIds(googleToken, "ARC_Requests", "A"),
      getExistingIds(googleToken, "Violations", "A"),
      getExistingIds(googleToken, "Other_Items", "A")
    ]);
    // Also track processed Gmail IDs to prevent duplicates in this run
    const processedGmailIds = new Set();

    // Fetch emails — last 90 days, max 30 at a time
    const { daysBack = 90, maxEmails = 30 } = reqBody;
    console.log(`Fetching last ${maxEmails} emails from past ${daysBack} days...`);
    const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000);
    const q = encodeURIComponent(`in:inbox after:${after}`);
    const listRes = await httpsReq("GET", "gmail.googleapis.com",
      `/gmail/v1/users/me/messages?maxResults=${maxEmails}&q=${q}`,
      { Authorization: `Bearer ${gmailToken}` });
    const messages = JSON.parse(listRes.body).messages || [];
    console.log(`Found ${messages.length} emails to process`);

    const results = { arc: 0, violation: 0, other: 0, skipped: 0 };
    const allIds = new Set([...existingArcIds, ...existingVioIds, ...existingOthIds]);

    // Process in parallel batches of 5
    const BATCH_SIZE = 5;
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      console.log(`Processing batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(messages.length/BATCH_SIZE)}`);

      // Process sequentially within batch to prevent race conditions
      for (const msgRef of batch) {
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

          if (!emailData.subject && !emailData.body) { results.skipped++; continue; }
          
          // Skip if already processed in this run
          if (processedGmailIds.has(msgRef.id)) { results.skipped++; continue; }
          processedGmailIds.add(msgRef.id);

          // Categorize and analyze in parallel
          const category = await categorizeEmail(emailData);
          const analysis = await analyzeWithClaude(emailData, category);

          if (category === "Other" && analysis.needs_attention === "no") { results.skipped++; continue; }

          // Extract address from analysis - prefer numeric address for ID generation
          const address = analysis.address || "";
          const itemId = generateId(category, address, allIds);
          allIds.add(itemId); // Add immediately to prevent parallel duplicates
          console.log(`Categorized email as ${category}, ID: ${itemId}, address: "${address}", name: "${analysis.homeowner_name || ""}"`);
          
          // Enhance with resident directory if available
          if (process.env.RESIDENT_SHEET_ID) {
            const fromEmail = emailData.from.match(/[\w.-]+@[\w.-]+/)?.[0] || "";
            const resident = await getResidentByEmail(googleToken, fromEmail) || 
                            await getResidentByAddress(googleToken, address);
            if (resident) {
              if (!analysis.homeowner_name || analysis.homeowner_name === "Unknown") analysis.homeowner_name = resident.name;
              if (!analysis.homeowner_email) analysis.homeowner_email = resident.email;
              if (!analysis.address || analysis.address === "Unknown") analysis.address = resident.address;
              console.log(`Matched resident: ${resident.name} at ${resident.address}`);
            }
          }

          const attachments = getAttachments(msg);
          const attachmentUrls = [];

          if (category === "ARC" || category === "Violation") {
            const folderName = `${itemId} — ${address.slice(0, 40)}`;
            const parentFolder = category === "ARC" ? arcYearFolder : category === "Violation" ? vioYearFolder : othYearFolder;
            console.log(`Creating Drive folder: ${folderName} in parent ${parentFolder}`);
            const itemFolder = await createDriveFolder(googleToken, folderName, parentFolder);
            console.log(`Drive folder created: ${itemFolder}`);
            if (!itemFolder) { console.log("ERROR: Drive folder creation returned undefined"); throw new Error("Drive folder creation failed"); }

            // Upload attachments in parallel
            await Promise.all(attachments.map(async (att) => {
              try {
                const attData = await downloadAttachment(gmailToken, msgRef.id, att.attachmentId);
                const url = await uploadFileToDrive(googleToken, att.filename, att.mimeType, attData, itemFolder);
                attachmentUrls.push(url);
              } catch (e) { console.log(`Attachment error: ${e.message}`); }
            }));

            const summaryText = `TWIN LAKES HOA — AI SUMMARY\n⚠️ AI GENERATED — FOR BOARD REVIEW ONLY\n\nItem ID: ${itemId}\nDate: ${emailData.date}\nFrom: ${emailData.from}\nSubject: ${emailData.subject}\n\nSUMMARY:\n${analysis.ai_summary}\n\nRECOMMENDATION: ${analysis.ai_recommendation || analysis.ai_suggestion}\n\nREASONING:\n${analysis.ai_reasoning || analysis.ai_suggestion}\n\nPROS: ${analysis.ai_pros || "N/A"}\nCONS: ${analysis.ai_cons || "N/A"}\n\nGenerated: ${new Date().toISOString()}`;
            await uploadTextToDrive(googleToken, "ai_summary.txt", summaryText, itemFolder);
            const folderUrl = `https://drive.google.com/drive/folders/${itemFolder}`;

            console.log(`Writing ${category} item ${itemId} to sheet...`);
            if (category === "ARC") {
              // Use title from analysis for better display, fallback to subject
              const displayTitle = analysis.title || analysis.description || emailData.subject;
              const displayAddress = analysis.address && analysis.address !== "Unknown" ? analysis.address : "";
              const displayName = analysis.homeowner_name && analysis.homeowner_name !== "Unknown" ? analysis.homeowner_name : "";
              
              await sheetsAppend(googleToken, "ARC_Requests", [
                itemId, emailData.date, displayName, analysis.homeowner_email || "",
                displayAddress, analysis.request_type || "Other", displayTitle,
                emailData.subject, folderUrl, attachmentUrls.join(", "),
                analysis.ai_summary || "", analysis.ai_recommendation || "", analysis.ai_reasoning || "",
                analysis.ai_pros || "", analysis.ai_cons || "",
                "","","","","","","","","","","","","","","","","","","","","","",
                "0","Open","","No","","0", analysis.conflict_flag || "no"
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
            console.log(`Writing Other item ${itemId} to sheet...`);
            const otherSummary = analysis.ai_summary || `Email from ${emailData.from} regarding: ${emailData.subject}. ${emailData.body.slice(0, 200)}`;
            await sheetsAppend(googleToken, "Other_Items", [
              itemId, emailData.date, analysis.from || emailData.from, emailData.subject,
              analysis.category || "Other", otherSummary,
              "Open", "", analysis.needs_attention || "yes"
            ]);
            existingOthIds.add(itemId);
            results.other++;
          }
        } catch (e) {
          console.log(`Error processing message: ${e.message}`);
          results.skipped++;
        }
      } // end for loop
    }

    console.log(`Done: ${JSON.stringify(results)}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, results, message: `Processed: ${results.arc} ARC, ${results.violation} violations, ${results.other} other, ${results.skipped} skipped` })
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};