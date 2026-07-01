const https = require("https");

// ── Google Auth ───────────────────────────────────────────
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

// ── Board Members ─────────────────────────────────────────
const BOARD_MEMBERS = {
  tony:   { name: "Tony Backert",       role: "President",       password: "TL2026#TB", isAdmin: false },
  yashu:  { name: "Yashu M Basavaraju", role: "Vice President",  password: "TL2026#YB", isAdmin: false },
  ramana: { name: "Ramana N",           role: "Treasurer",       password: "TL2026#RN", isAdmin: false },
  raja:   { name: "Raja Ravanan",       role: "Secretary",       password: "TL2026#RR", isAdmin: true  },
  aimee:  { name: "Aimee Green",        role: "Member at Large", password: "TL2026#AG", isAdmin: false },
  mike:   { name: "Mike Schnell",       role: "Member at Large", password: "TL2026#MS", isAdmin: false },
};

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY   = process.env.GOOGLE_SA_KEY;
const SCOPES   = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"];

async function sheetsGet(token, range) {
  const r = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { Authorization: `Bearer ${token}` });
  return JSON.parse(r.body);
}

async function sheetsUpdate(token, range, values) {
  const r = await httpsReq("PUT", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { Authorization: `Bearer ${token}` }, { range, majorDimension: "ROWS", values });
  return JSON.parse(r.body);
}

async function sheetsAppend(token, range, values) {
  const r = await httpsReq("POST", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${token}` }, { values });
  return JSON.parse(r.body);
}

async function ensureSheetTabs(token) {
  const meta = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}`, { Authorization: `Bearer ${token}` });
  const spreadsheet = JSON.parse(meta.body);
  const existing = (spreadsheet.sheets || []).map(s => s.properties.title);

  const needed = ["ARC_Requests", "Violations", "Other_Items", "Activity_Log", "Resident_Requests", "Announcements", "Minutes", "Settings"];
  const toAdd = needed.filter(n => !existing.includes(n));

  if (toAdd.length > 0) {
    await httpsReq("POST", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      { Authorization: `Bearer ${token}` },
      { requests: toAdd.map(title => ({ addSheet: { properties: { title } } })) });

    // Add headers
    const headers = {
      ARC_Requests: [["id","date_received","homeowner_name","homeowner_email","address","request_type","description","email_subject","drive_folder_url","attachment_urls","ai_summary","ai_recommendation","ai_reasoning","ai_pros","ai_cons","tony_vote","tony_conditions","tony_note","tony_voted_at","yashu_vote","yashu_conditions","yashu_note","yashu_voted_at","ramana_vote","ramana_conditions","ramana_note","ramana_voted_at","raja_vote","raja_conditions","raja_note","raja_voted_at","aimee_vote","aimee_conditions","aimee_note","aimee_voted_at","mike_vote","mike_conditions","mike_note","mike_voted_at","vote_count","final_status","consolidated_conditions","notified_mulloy","notified_at","days_open","conflict_flag"]],
      Violations: [["id","date_received","homeowner_name","homeowner_email","address","violation_type","description","email_subject","drive_folder_url","ai_summary","ai_suggestion","status","comments_json","days_open"]],
      Other_Items: [["id","date_received","from","subject","category","ai_summary","status","drive_folder_url","needs_attention"]],
      Activity_Log: [["timestamp","board_member","action","item_id","item_type","details"]],
      Resident_Requests: [["id","date_received","request_type","name","email","address","subject","description","sent_to","status","assigned_to","board_notes"]],
      Announcements: [["id","date_posted","title","body","status","posted_by"]],
      Minutes: [["id","meeting_date","title","summary","status","posted_by","attendees"]],
      Settings: [["key","value"],["financials_published","false"]]
    };
    for (const tab of toAdd) {
      await sheetsUpdate(token, `${tab}!A1`, headers[tab]);
    }
  }
}

async function logActivity(token, member, action, itemId, itemType, details) {
  await sheetsAppend(token, "Activity_Log!A:F", [[
    new Date().toISOString(), member, action, itemId, itemType, details
  ]]);
}

async function getSheetData(token, tab) {
  try {
    const res = await sheetsGet(token, `${tab}!A:AV`);
    const rows = res.values || [];
    if (rows.length < 2) return [];
    const headers = rows[0];
    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] || ""; });
      return obj;
    });
  } catch(e) { return []; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" } };
  }

  const body = JSON.parse(event.body || "{}");
  const { action, username, password, data } = body;

  // ── LOGIN ──
  if (action === "login") {
    const member = BOARD_MEMBERS[username];
    if (!member || member.password !== password) {
      return { statusCode: 401, body: JSON.stringify({ error: "Invalid credentials" }) };
    }
    const token = Buffer.from(JSON.stringify({ username, name: member.name, role: member.role, isAdmin: member.isAdmin, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64");
    return { statusCode: 200, body: JSON.stringify({ token, name: member.name, role: member.role, isAdmin: member.isAdmin }) };
  }

  // ── PUBLIC: GET PUBLISHED ANNOUNCEMENTS (no auth — read by the public website) ──
  if (action === "getPublicAnnouncements") {
    const publicToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
    await ensureSheetTabs(publicToken);
    const all = await getSheetData(publicToken, "Announcements");
    const published = all
      .filter(a => (a.status || "published") === "published")
      .map(a => ({ id: a.id, date_posted: a.date_posted, title: a.title, body: a.body }))
      .sort((x, y) => new Date(y.date_posted) - new Date(x.date_posted));
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ announcements: published })
    };
  }

  // ── PUBLIC: GET PUBLISHED MEETING MINUTES (no auth — read by the public website) ──
  if (action === "getPublicMinutes") {
    const publicToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
    await ensureSheetTabs(publicToken);
    const all = await getSheetData(publicToken, "Minutes");
    const published = all
      .filter(m => (m.status || "published") === "published")
      .map(m => ({ id: m.id, meeting_date: m.meeting_date, title: m.title, summary: m.summary, attendees: m.attendees || "" }))
      .sort((x, y) => new Date(y.meeting_date) - new Date(x.meeting_date));
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ minutes: published })
    };
  }

  // ── PUBLIC: GET SITE SETTINGS (no auth — read by the public website) ──
  if (action === "getPublicSettings") {
    const publicToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
    await ensureSheetTabs(publicToken);
    const rows = (await sheetsGet(publicToken, "Settings!A:B")).values || [];
    const map = {};
    rows.slice(1).forEach(r => { if (r[0]) map[r[0]] = r[1]; });
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ financials_published: (map.financials_published === "true") })
    };
  }

  // ── AUTH CHECK ──
  const authHeader = event.headers?.authorization || "";
  const sessionToken = authHeader.replace("Bearer ", "");
  let session;
  try {
    session = JSON.parse(Buffer.from(sessionToken, "base64").toString());
    if (session.exp < Date.now()) throw new Error("Expired");
  } catch {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  const googleToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
  await ensureSheetTabs(googleToken);

  // ── GET DASHBOARD DATA ──
  if (action === "getDashboard") {
    const [arcs, violations, others, requests, announcements, minutes, activityRows] = await Promise.all([
      getSheetData(googleToken, "ARC_Requests"),
      getSheetData(googleToken, "Violations"),
      getSheetData(googleToken, "Other_Items"),
      getSheetData(googleToken, "Resident_Requests"),
      getSheetData(googleToken, "Announcements"),
      getSheetData(googleToken, "Minutes"),
      sheetsGet(googleToken, "Activity_Log!A:F").then(r => (r.values || []).slice(1).slice(-50).reverse())
    ]);
    announcements.sort((x, y) => new Date(y.date_posted) - new Date(x.date_posted));
    minutes.sort((x, y) => new Date(y.meeting_date) - new Date(x.meeting_date));

    // Calculate days open
    const now = Date.now();
    arcs.forEach(a => {
      a.days_open = a.date_received ? Math.floor((now - new Date(a.date_received).getTime()) / 86400000) : 0;
      a.age_color = a.days_open > 14 ? "red" : a.days_open > 7 ? "yellow" : "green";
    });
    violations.forEach(v => {
      v.days_open = v.date_received ? Math.floor((now - new Date(v.date_received).getTime()) / 86400000) : 0;
    });
    requests.forEach(rq => {
      rq.days_open = rq.date_received ? Math.floor((now - new Date(rq.date_received).getTime()) / 86400000) : 0;
    });

    await logActivity(googleToken, session.username, "viewed_dashboard", "-", "dashboard", "");

    return {
      statusCode: 200,
      body: JSON.stringify({ arcs, violations, others, requests, announcements, minutes, activity: activityRows })
    };
  }

  // ── GET RESIDENT DIRECTORY (master inventory) ──
  if (action === "getResidents") {
    const RID = process.env.RESIDENT_SHEET_ID;
    if (!RID) return { statusCode: 200, body: JSON.stringify({ residents: [] }) };
    const r = await httpsReq("GET", "sheets.googleapis.com",
      `/v4/spreadsheets/${RID}/values/${encodeURIComponent("A1:Z500")}`,
      { Authorization: `Bearer ${googleToken}` });
    const rows = (JSON.parse(r.body).values) || [];
    // Columns: A Name, B Street No, C Street Name, D Email, E Phone1, F Ph1Type, G Phone2, H Ph2Type, I Series
    const residents = rows.slice(1)
      .filter(row => (row[0] || "").trim())
      .map(row => {
        const streetNo = (row[1] || "").trim();
        const streetName = (row[2] || "").trim();
        return {
          name: (row[0] || "").trim(),
          streetNo, streetName,
          address: `${streetNo} ${streetName}`.trim(),
          email: (row[3] || "").trim(),
          phone1: (row[4] || "").trim(),
          phone2: (row[6] || "").trim(),
          series: (row[8] || "").trim()
        };
      })
      .sort((a, b) => a.streetName.localeCompare(b.streetName) || (parseInt(a.streetNo) || 0) - (parseInt(b.streetNo) || 0));
    return { statusCode: 200, body: JSON.stringify({ residents, count: residents.length }) };
  }

  // ── SET A SITE SETTING (admin only) ──
  if (action === "setSetting") {
    if (!session.isAdmin) return { statusCode: 403, body: JSON.stringify({ error: "Admin only" }) };
    const key = (data?.key || "").trim();
    const value = String(data?.value);
    if (!key) return { statusCode: 400, body: JSON.stringify({ error: "key required" }) };
    const rows = (await sheetsGet(googleToken, "Settings!A:B")).values || [];
    let rowIdx = -1; // 1-based sheet row
    for (let i = 1; i < rows.length; i++) { if ((rows[i][0] || "") === key) { rowIdx = i + 1; break; } }
    if (rowIdx > 0) {
      await sheetsUpdate(googleToken, `Settings!A${rowIdx}:B${rowIdx}`, [[key, value]]);
    } else {
      await sheetsAppend(googleToken, "Settings!A:B", [[key, value]]);
    }
    await logActivity(googleToken, session.username, "set_setting", key, "settings", value);
    return { statusCode: 200, body: JSON.stringify({ success: true, key, value }) };
  }

  // ── ADD ANNOUNCEMENT ──
  if (action === "addAnnouncement") {
    const title = (data?.title || "").trim();
    const text  = (data?.body || "").trim();
    if (!title || !text) return { statusCode: 400, body: JSON.stringify({ error: "Title and body are required" }) };
    const id = "ANN-" + Date.now().toString(36).toUpperCase();
    await sheetsAppend(googleToken, "Announcements!A:F", [[
      id, new Date().toISOString(), title, text, "published", session.name
    ]]);
    await logActivity(googleToken, session.username, "posted_announcement", id, "announcement", title.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, id }) };
  }

  // ── UPDATE ANNOUNCEMENT (edit text and/or change published status) ──
  if (action === "updateAnnouncement") {
    const { itemId, title, body: text, status } = data || {};
    const items = await getSheetData(googleToken, "Announcements");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const updates = [];
    if (typeof title === "string")  updates.push(sheetsUpdate(googleToken, `Announcements!C${row}`, [[title.trim()]]));
    if (typeof text === "string")   updates.push(sheetsUpdate(googleToken, `Announcements!D${row}`, [[text.trim()]]));
    if (typeof status === "string") updates.push(sheetsUpdate(googleToken, `Announcements!E${row}`, [[status]]));
    await Promise.all(updates);
    await logActivity(googleToken, session.username, status ? `announcement_${status}` : "edited_announcement", itemId, "announcement", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── DELETE ANNOUNCEMENT (mark deleted; row is blanked so it disappears everywhere) ──
  if (action === "deleteAnnouncement") {
    const { itemId } = data || {};
    const items = await getSheetData(googleToken, "Announcements");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    // Clear the row's content (A:F) so it no longer appears on the site or portal
    await sheetsUpdate(googleToken, `Announcements!A${row}:F${row}`, [["", "", "", "", "deleted", ""]]);
    await logActivity(googleToken, session.username, "deleted_announcement", itemId, "announcement", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── ADD MEETING MINUTES ──
  if (action === "addMinutes") {
    const meetingDate = (data?.meeting_date || "").trim();
    const title = (data?.title || "").trim();
    const summary  = (data?.summary || "").trim();
    const attendees = (data?.attendees || "").trim();
    if (!meetingDate || !title || !summary) return { statusCode: 400, body: JSON.stringify({ error: "Meeting date, title and summary are required" }) };
    const id = "MIN-" + Date.now().toString(36).toUpperCase();
    await sheetsAppend(googleToken, "Minutes!A:G", [[
      id, meetingDate, title, summary, "published", session.name, attendees
    ]]);
    await logActivity(googleToken, session.username, "posted_minutes", id, "minutes", title.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, id }) };
  }

  // ── UPDATE MEETING MINUTES (edit text and/or change published status) ──
  if (action === "updateMinutes") {
    const { itemId, meeting_date: meetingDate, title, summary, status, attendees } = data || {};
    const items = await getSheetData(googleToken, "Minutes");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const updates = [];
    if (typeof meetingDate === "string") updates.push(sheetsUpdate(googleToken, `Minutes!B${row}`, [[meetingDate.trim()]]));
    if (typeof title === "string")       updates.push(sheetsUpdate(googleToken, `Minutes!C${row}`, [[title.trim()]]));
    if (typeof summary === "string")     updates.push(sheetsUpdate(googleToken, `Minutes!D${row}`, [[summary.trim()]]));
    if (typeof status === "string")      updates.push(sheetsUpdate(googleToken, `Minutes!E${row}`, [[status]]));
    if (typeof attendees === "string")   updates.push(sheetsUpdate(googleToken, `Minutes!G${row}`, [[attendees.trim()]]));
    await Promise.all(updates);
    await logActivity(googleToken, session.username, status ? `minutes_${status}` : "edited_minutes", itemId, "minutes", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── DELETE MEETING MINUTES (mark deleted; row is blanked so it disappears everywhere) ──
  if (action === "deleteMinutes") {
    const { itemId } = data || {};
    const items = await getSheetData(googleToken, "Minutes");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    // Clear the row's content (A:G) so it no longer appears on the site or portal
    await sheetsUpdate(googleToken, `Minutes!A${row}:G${row}`, [["", "", "", "", "deleted", "", ""]]);
    await logActivity(googleToken, session.username, "deleted_minutes", itemId, "minutes", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── UPDATE RESIDENT REQUEST STATUS ──
  if (action === "updateRequestStatus") {
    const { itemId, status } = data;
    const items = await getSheetData(googleToken, "Resident_Requests");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    await sheetsUpdate(googleToken, `Resident_Requests!J${rowIndex + 2}`, [[status]]);
    await logActivity(googleToken, session.username, `status_changed_to_${status.replace(/ /g, "_")}`, itemId, "request", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── ADD INTERNAL NOTE TO RESIDENT REQUEST ──
  if (action === "addRequestNote") {
    const { itemId, note } = data;
    const items = await getSheetData(googleToken, "Resident_Requests");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    let notes = [];
    try { notes = JSON.parse(items[rowIndex].board_notes || "[]"); } catch {}
    notes.push({ author: session.name, username: session.username, text: note, timestamp: new Date().toISOString() });
    await sheetsUpdate(googleToken, `Resident_Requests!L${rowIndex + 2}`, [[JSON.stringify(notes)]]);
    await logActivity(googleToken, session.username, "added_note", itemId, "request", note.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, notes }) };
  }

  // ── CAST VOTE ──
  if (action === "castVote") {
    const { itemId, vote, conditions, note } = data;
    const arcs = await getSheetData(googleToken, "ARC_Requests");
    const rowIndex = arcs.findIndex(a => a.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };

    const sheetRow = rowIndex + 2; // +1 for header, +1 for 1-indexed
    const username = session.username;
    const voteColMap = { tony: "P", yashu: "T", ramana: "X", raja: "AB", aimee: "AF", mike: "AJ" };
    const condColMap = { tony: "Q", yashu: "U", ramana: "Y", raja: "AC", aimee: "AG", mike: "AK" };
    const noteColMap = { tony: "R", yashu: "V", ramana: "Z", raja: "AD", aimee: "AH", mike: "AL" };
    const timeColMap = { tony: "S", yashu: "W", ramana: "AA", raja: "AE", aimee: "AI", mike: "AM" };

    const now = new Date().toISOString();
    await Promise.all([
      sheetsUpdate(googleToken, `ARC_Requests!${voteColMap[username]}${sheetRow}`, [[vote]]),
      sheetsUpdate(googleToken, `ARC_Requests!${condColMap[username]}${sheetRow}`, [[conditions || ""]]),
      sheetsUpdate(googleToken, `ARC_Requests!${noteColMap[username]}${sheetRow}`, [[note || ""]]),
      sheetsUpdate(googleToken, `ARC_Requests!${timeColMap[username]}${sheetRow}`, [[now]]),
    ]);

    // Count votes and check majority
    const updatedArcs = await getSheetData(googleToken, "ARC_Requests");
    const arc = updatedArcs[rowIndex];
    const votes = ["tony_vote","yashu_vote","ramana_vote","raja_vote","aimee_vote","mike_vote"].map(k => arc[k]).filter(v => v && v !== "");
    const approveCount = votes.filter(v => v === "Approve" || v === "Conditional").length;
    const denyCount = votes.filter(v => v === "Deny").length;

    let newStatus = arc.final_status;
    if (approveCount >= 4) newStatus = "Approved";
    else if (denyCount >= 4) newStatus = "Denied";
    else if (approveCount === 3 && denyCount === 3) newStatus = "Tie - Tony Decides";

    await sheetsUpdate(googleToken, `ARC_Requests!AO${sheetRow}`, [[votes.length.toString()]]);
    await sheetsUpdate(googleToken, `ARC_Requests!AP${sheetRow}`, [[newStatus || "Open"]]);

    await logActivity(googleToken, username, `voted_${vote}`, itemId, "ARC", conditions ? `Conditions: ${conditions}` : "");

    return { statusCode: 200, body: JSON.stringify({ success: true, newStatus, voteCount: votes.length }) };
  }

  // ── ADD VIOLATION COMMENT ──
  if (action === "addComment") {
    const { itemId, comment } = data;
    const violations = await getSheetData(googleToken, "Violations");
    const rowIndex = violations.findIndex(v => v.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };

    const sheetRow = rowIndex + 2;
    let comments = [];
    try { comments = JSON.parse(violations[rowIndex].comments_json || "[]"); } catch {}
    comments.push({ author: session.name, username: session.username, text: comment, timestamp: new Date().toISOString() });
    await sheetsUpdate(googleToken, `Violations!M${sheetRow}`, [[JSON.stringify(comments)]]);
    await logActivity(googleToken, session.username, "added_comment", itemId, "Violation", comment.slice(0, 100));

    return { statusCode: 200, body: JSON.stringify({ success: true, comments }) };
  }

  // ── UPDATE STATUS ──
  if (action === "updateStatus") {
    const { itemId, status, itemType } = data;
    const tab = itemType === "violation" ? "Violations" : "Other_Items";
    const colLetter = itemType === "violation" ? "L" : "G";
    const items = await getSheetData(googleToken, tab);
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    await sheetsUpdate(googleToken, `${tab}!${colLetter}${rowIndex + 2}`, [[status]]);
    await logActivity(googleToken, session.username, `status_changed_to_${status}`, itemId, itemType, "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── GET EMAIL PREVIEW FOR NOTIFY MULLOY ──
  if (action === "getEmailPreview") {
    const { itemId } = data;
    const arcs = await getSheetData(googleToken, "ARC_Requests");
    const arc = arcs.find(a => a.id === itemId);
    if (!arc) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };

    const isApproved = arc.final_status === "Approved";
    const isConditional = ["tony_vote","yashu_vote","ramana_vote","raja_vote","aimee_vote","mike_vote"].some(k => arc[k] === "Conditional");

    let subject, bodyText;
    if (isApproved && isConditional) {
      subject = `ARC Request ${arc.id} — Approved with Conditions`;
      bodyText = `Dear ${arc.homeowner_name},\n\nThe Twin Lakes at Floyds Fork HOA Board has reviewed your ARC request (${arc.id}) for: ${arc.request_type} at ${arc.address}.\n\nDecision: APPROVED WITH CONDITIONS\n\nConditions:\n${arc.consolidated_conditions || arc.ai_summary}\n\nPlease ensure all work complies with the approved conditions and our Architectural Guidelines before proceeding.\n\nIf you have any questions, please contact Eddie Douglas at edouglas@mulloyproperties.com.\n\nBest regards,\nTwin Lakes at Floyds Fork HOA Board`;
    } else if (isApproved) {
      subject = `ARC Request ${arc.id} — Approved`;
      bodyText = `Dear ${arc.homeowner_name},\n\nThe Twin Lakes at Floyds Fork HOA Board has reviewed your ARC request (${arc.id}) for: ${arc.request_type} at ${arc.address}.\n\nDecision: APPROVED\n\nPlease ensure all work complies with our Architectural Guidelines. Board approval is required before beginning any work.\n\nIf you have any questions, please contact Eddie Douglas at edouglas@mulloyproperties.com.\n\nBest regards,\nTwin Lakes at Floyds Fork HOA Board`;
    } else {
      subject = `ARC Request ${arc.id} — Not Approved`;
      bodyText = `Dear ${arc.homeowner_name},\n\nThe Twin Lakes at Floyds Fork HOA Board has reviewed your ARC request (${arc.id}) for: ${arc.request_type} at ${arc.address}.\n\nDecision: NOT APPROVED\n\nReason: ${arc.consolidated_conditions || "Does not meet current Architectural Guidelines."}\n\nYou may resubmit with modifications. Please contact Eddie Douglas at edouglas@mulloyproperties.com to discuss.\n\nBest regards,\nTwin Lakes at Floyds Fork HOA Board`;
    }

    return { statusCode: 200, body: JSON.stringify({ subject, body: bodyText, to: "edouglas@mulloyproperties.com", homeowner: arc.homeowner_name, homeownerEmail: arc.homeowner_email }) };
  }

  // ── SEND NOTIFY MULLOY EMAIL ──
  if (action === "sendNotification") {
    const { itemId, subject, emailBody } = data;
    const token2 = await getGoogleToken(process.env.GMAIL_CLIENT_ID ? null : SA_EMAIL, SA_KEY, ["https://mail.google.com/"]);

    // Use existing Gmail OAuth instead
    const gmailToken = await refreshGmailToken();
    const raw = buildEmail("edouglas@mulloyproperties.com", subject, emailBody);
    await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
      { Authorization: `Bearer ${gmailToken}`, "Content-Type": "application/json" },
      { raw });

    const arcs = await getSheetData(googleToken, "ARC_Requests");
    const rowIndex = arcs.findIndex(a => a.id === itemId);
    if (rowIndex >= 0) {
      await sheetsUpdate(googleToken, `ARC_Requests!AR${rowIndex + 2}`, [["Yes"]]);
      await sheetsUpdate(googleToken, `ARC_Requests!AS${rowIndex + 2}`, [[new Date().toISOString()]]);
    }
    await logActivity(googleToken, session.username, "notified_mulloy", itemId, "ARC", subject);
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
};

async function refreshGmailToken() {
  const res = await httpsReq("POST", "oauth2.googleapis.com", "/token",
    { "Content-Type": "application/x-www-form-urlencoded" },
    null);
  // Use existing env vars
  const body = `client_id=${encodeURIComponent(process.env.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(process.env.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token`;
  const r = await new Promise((resolve, reject) => {
    const https = require("https");
    const req = https.request({ hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }},
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(JSON.parse(d))); });
    req.on("error", reject); req.write(body); req.end();
  });
  return r.access_token;
}

function encodeHeader(value) {
  const s = String(value == null ? "" : value);
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function buildEmail(to, subject, text) {
  const raw = [`From: Twin Lakes HOA <hoa.twinlakes.board@gmail.com>`, `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`, `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: 8bit`, ``, text].join("\r\n");
  return Buffer.from(raw).toString("base64url");
}
