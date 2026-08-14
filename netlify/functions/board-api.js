const https = require("https");
const accessRequestsLib = require("./lib/access-requests");
const committeeVolunteersLib = require("./lib/committee-volunteers");
const auth = require("./lib/board-auth");
const members = require("./lib/board-members");
const sheetsWrite = require("./lib/sheets-write");
const { delay, randomFailureDelayMs, constantTimeEqual } = require("./lib/timing");

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

// ── Board credentials ─────────────────────────────────────
// Passwords only. Identity, display title and access level now live in
// lib/board-members.js, which scan-inbox.js imports — keeping the secret
// half here is what stops credentials entering the scanner's module graph.
// Moving these to environment variables is the first Phase B security item.
//
// Ramana N resigned: his password is removed, so he can no longer log in and
// any session naming him fails the active-member check in lib/board-auth.js.
// His historical votes, notes, timestamps and spreadsheet columns are
// untouched — see lib/board-members.js.
const BOARD_PASSWORDS = {
  tony:   "mapletiger42",
  yashu:  "oceanbreeze17",
  raja:   "silverfox23",
  aimee:  "goldenpine55",
  mike:   "riverstone31",
  jodi:   "hazelbrook49",
};
// Compared against when the username is unknown, so a bad username and a bad
// password cost the same work and reveal the same thing: nothing.
const DUMMY_PASSWORD = "$not-a-real-password$";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY   = process.env.GOOGLE_SA_KEY;
const SCOPES   = ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"];

// ── Announcement organization fields (Phase 1A) ─────────────
// Columns G-O of the Announcements sheet. All optional; unknown/invalid
// input is safely defaulted rather than trusted or rejected outright, so a
// stray dropdown value never lands in the sheet unchecked.
const ANNOUNCEMENT_EXT_HEADERS = ["category","priority","event_date","work_status","summary","featured","archive_date","related_project","show_on_banner"];
const ANN_CATEGORIES = ["General","Board & Meetings","Ponds","Landscaping","Irrigation","Traffic","Safety","Community Events","Maintenance","Documents"];
const ANN_PRIORITIES = ["normal","high","critical"];
const ANN_WORK_STATUSES = ["none","upcoming","in-progress","completed"];

function normalizeAnnCategory(v) { const s = String(v || "").trim(); return ANN_CATEGORIES.includes(s) ? s : "General"; }
function normalizeAnnPriority(v) { const s = String(v || "").trim().toLowerCase(); return ANN_PRIORITIES.includes(s) ? s : "normal"; }
function normalizeAnnWorkStatus(v) { const s = String(v || "").trim().toLowerCase(); return ANN_WORK_STATUSES.includes(s) ? s : "none"; }
function normalizeAnnFeatured(v) { return (v === true || v === "yes" || v === "true") ? "yes" : "no"; }
function normalizeAnnDate(v) { const s = String(v || "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
// Defaults to "yes" — the opposite of every other flag here, and deliberately
// so: legacy A-N rows carry no value for column O, and an announcement that
// silently vanished from the banner on deploy would be a regression. Only an
// explicit "no" takes a post off the banner.
function normalizeAnnShowOnBanner(v) { return (v === false || v === "no" || v === "false") ? "no" : "yes"; }

async function sheetsGet(token, range) {
  const r = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`,
    { Authorization: `Bearer ${token}` });
  return JSON.parse(r.body);
}

// Writes go through lib/sheets-write.js, which throws SheetsWriteError on a
// non-2xx status, an unparseable body, a Google `error` object, or update
// metadata showing nothing was actually written. The handler turns that into
// a 502 so the portal can never report success for a write that did not
// happen. Reads are intentionally left on the original lenient path — this
// change is scoped to write reliability.
async function sheetsUpdate(token, range, values) {
  return sheetsWrite.valuesUpdate(token, SHEET_ID, range, values);
}

async function sheetsAppend(token, range, values) {
  return sheetsWrite.valuesAppend(token, SHEET_ID, range, values);
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
      Announcements: [["id","date_posted","title","body","status","posted_by","category","priority","event_date","work_status","summary","featured","archive_date","related_project","show_on_banner"]],
      Minutes: [["id","meeting_date","title","summary","status","posted_by","attendees","meeting_type"]],
      Settings: [["key","value"],["financials_published","false"]]
    };
    for (const tab of toAdd) {
      await sheetsUpdate(token, `${tab}!A1`, headers[tab]);
    }
  }
}

// Audit logging is deliberately NON-FATAL. The member's action has already
// been persisted by the time this runs; failing the request because the audit
// row could not be appended would turn a successful change into a reported
// failure and invite a duplicate retry.
async function logActivity(token, member, action, itemId, itemType, details) {
  try {
    await sheetsAppend(token, "Activity_Log!A:F", [[
      new Date().toISOString(), member, action, itemId, itemType, details
    ]]);
  } catch (e) {
    console.error(JSON.stringify({ activityLogFailed: true, action, itemId, detail: String(e.message || e).slice(0, 200) }));
  }
}

async function getSheetData(token, tab) {
  try {
    // Quoted defensively so tab names containing spaces (e.g. "Resident
    // Portal Access Requests") are valid A1 notation; a no-op for the
    // existing plain underscored tab names.
    const res = await sheetsGet(token, `'${tab}'!A:AV`);
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

// One generic failure for every unsuccessful login: unknown username, wrong
// password, inactive member, and unconfigured server all look identical from
// outside, so the response never reveals whether an account exists.
const LOGIN_FAILED = { statusCode: 401, body: JSON.stringify({ error: "Invalid username or password." }) };

async function handleRequest(event) {
  // The portal, the public website and these functions are same-origin, so no
  // CORS headers are needed anywhere and none are sent. Removing the wildcard
  // also means a cross-origin request carrying the required custom header
  // cannot clear preflight.
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, body: "" };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Bad request" }) }; }
  const { action, username, password, data } = body;

  // ── AUTHENTICATE ──
  // Resolved before authorization so the permission table can key off a
  // verified identity. A signed session naming a member who has resigned
  // resolves to null here, not to a valid session.
  const session = auth.getSessionContext(event);

  // ── AUTHORIZE (default deny) ──
  // Unknown or undeclared actions are refused here and never reach a handler.
  const denied = auth.authorize(event, action, session);
  if (denied) return denied;

  // ── LOGIN ──
  if (action === "login") {
    const config = auth.loadConfig();
    if (!config) {
      // Fail closed: without BOARD_SESSION_SECRET/VERSION no session can be
      // signed, so no session is issued and no cookie is set.
      console.error(JSON.stringify({ boardAuthUnconfigured: true }));
      await delay(randomFailureDelayMs());
      return LOGIN_FAILED;
    }
    const key = typeof username === "string" ? username.trim().toLowerCase() : "";
    const member = members.getActiveMember(key);
    const expected = Object.prototype.hasOwnProperty.call(BOARD_PASSWORDS, key)
      ? BOARD_PASSWORDS[key]
      : DUMMY_PASSWORD;
    // Always compare, even for an unknown or inactive user, so the work done
    // does not depend on whether the account exists.
    const passwordOk = constantTimeEqual(expected, typeof password === "string" ? password : "");
    if (!member || !passwordOk) {
      await delay(randomFailureDelayMs());
      return LOGIN_FAILED;   // no Set-Cookie on failure
    }
    const token = auth.signSession(config.secret, config.version, member.key);
    return {
      statusCode: 200,
      headers: { "Set-Cookie": auth.buildSessionCookie(token), "Cache-Control": "no-store" },
      // Response body carries no token, no access level and no privilege
      // claim — the portal calls board-session for its display data.
      body: JSON.stringify({ ok: true })
    };
  }

  // ── PUBLIC: GET PUBLISHED ANNOUNCEMENTS (no auth — read by the public website) ──
  if (action === "getPublicAnnouncements") {
    const publicToken = await getGoogleToken(SA_EMAIL, SA_KEY, SCOPES);
    await ensureSheetTabs(publicToken);
    const all = await getSheetData(publicToken, "Announcements");
    const published = all
      .filter(a => (a.status || "published") === "published")
      .map(a => ({
        id: a.id, date_posted: a.date_posted, title: a.title, body: a.body,
        category: normalizeAnnCategory(a.category),
        priority: normalizeAnnPriority(a.priority),
        event_date: normalizeAnnDate(a.event_date),
        work_status: normalizeAnnWorkStatus(a.work_status),
        summary: String(a.summary || "").trim(),
        featured: normalizeAnnFeatured(a.featured),
        archive_date: normalizeAnnDate(a.archive_date),
        related_project: String(a.related_project || "").trim(),
        show_on_banner: normalizeAnnShowOnBanner(a.show_on_banner)
      }))
      .sort((x, y) => new Date(y.date_posted) - new Date(x.date_posted));
    return {
      statusCode: 200,
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
      .map(m => ({ id: m.id, meeting_date: m.meeting_date, title: m.title, summary: m.summary, attendees: m.attendees || "", meeting_type: (m.meeting_type === "community" ? "community" : "board") }))
      .sort((x, y) => new Date(y.meeting_date) - new Date(x.meeting_date));
    return {
      statusCode: 200,
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
      body: JSON.stringify({
        financials_published: (map.financials_published === "true"),
        ai_suggestions: (map.ai_suggestions === "true"),
        email_health: map.email_health || "unknown",
        email_checked_at: map.email_checked_at || "",
        email_health_detail: map.email_health_detail || ""
      })
    };
  }

  // Authentication and authorization already happened at the top of the
  // handler. The legacy `Authorization: Bearer <base64(JSON)>` token is no
  // longer read anywhere — an unsigned token cannot produce a session.

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

    // Normalize Phase 1A organization fields so the portal always shows safe,
    // known values even for legacy A-F rows that predate these columns.
    announcements.forEach(a => {
      a.category = normalizeAnnCategory(a.category);
      a.priority = normalizeAnnPriority(a.priority);
      a.event_date = normalizeAnnDate(a.event_date);
      a.work_status = normalizeAnnWorkStatus(a.work_status);
      a.summary = String(a.summary || "").trim();
      a.featured = normalizeAnnFeatured(a.featured);
      a.archive_date = normalizeAnnDate(a.archive_date);
      a.related_project = String(a.related_project || "").trim();
      a.show_on_banner = normalizeAnnShowOnBanner(a.show_on_banner);
    });

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

    // Operational queues go to every active board member. The activity log is
    // technical diagnostics and is withheld from the payload for non-admins —
    // not merely hidden in the UI.
    const canSeeDiagnostics = members.accessAtLeast(session.access, "admin");
    return {
      statusCode: 200,
      body: JSON.stringify({
        arcs: arcs.filter(a => a.id), violations, others, requests: requests.filter(rq => rq.id), announcements, minutes,
        activity: canSeeDiagnostics ? activityRows : []
      })
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
    // Field scoping by access level. An ordinary member gets what they need
    // to do board work — who lives where, and how to reach them. The
    // administrative judgement fields (frequent-offender flag, committee,
    // lot) and the secondary phone are officer/admin only, and the export
    // affordance is gated on the same flag in the portal UI.
    const expanded = members.accessAtLeast(session.access, "officer");
    const residents = rows.slice(1)
      .filter(row => (row[0] || "").trim())
      .map(row => {
        const streetNo = (row[1] || "").trim();
        const streetName = (row[2] || "").trim();
        const base = {
          name: (row[0] || "").trim(),
          streetNo, streetName,
          address: `${streetNo} ${streetName}`.trim(),
          email: (row[3] || "").trim(),
          phone1: (row[4] || "").trim(),
          series: (row[8] || "").trim(),
          zone: (row[12] || "").trim()
        };
        if (!expanded) return base;
        return {
          ...base,
          phone2: (row[6] || "").trim(),
          lot: (row[9] || "").trim(),
          committee: (row[10] || "").trim(),
          offender: (row[11] || "").trim()
        };
      })
      .sort((a, b) => a.streetName.localeCompare(b.streetName) || (parseInt(a.streetNo) || 0) - (parseInt(b.streetNo) || 0));

    // Directory reads are PII access and are always attributable.
    await logActivity(googleToken, session.username, "viewed_resident_directory", "-", "residents",
      `access=${session.access} scope=${expanded ? "expanded" : "basic"} records=${residents.length}`);
    return { statusCode: 200, body: JSON.stringify({ residents, count: residents.length }) };
  }

  // ── SET A SITE SETTING (admin only) ──
  if (action === "setSetting") {
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
    // Optional Phase 1A fields — every value is normalized server-side rather
    // than trusted, so a plain Title+Body post (no fields sent) still lands
    // with safe defaults, same as an existing pre-Phase-1A announcement.
    const category      = normalizeAnnCategory(data?.category);
    const priority       = normalizeAnnPriority(data?.priority);
    const eventDate      = normalizeAnnDate(data?.event_date);
    const workStatus     = normalizeAnnWorkStatus(data?.work_status);
    const summary        = String(data?.summary || "").trim();
    const featured       = normalizeAnnFeatured(data?.featured);
    const archiveDate    = normalizeAnnDate(data?.archive_date);
    const relatedProject = String(data?.related_project || "").trim();
    const showOnBanner   = normalizeAnnShowOnBanner(data?.show_on_banner);
    // Self-heal the header for sheets created before columns G-O existed,
    // so getSheetData (which maps by header name) can read the values back.
    await sheetsUpdate(googleToken, "Announcements!G1:O1", [ANNOUNCEMENT_EXT_HEADERS]);
    await sheetsAppend(googleToken, "Announcements!A:O", [[
      id, new Date().toISOString(), title, text, "published", session.displayName,
      category, priority, eventDate, workStatus, summary, featured, archiveDate, relatedProject, showOnBanner
    ]]);
    await logActivity(googleToken, session.username, "posted_announcement", id, "announcement", title.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, id }) };
  }

  // ── UPDATE ANNOUNCEMENT (edit text and/or change published status) ──
  if (action === "updateAnnouncement") {
    const {
      itemId, title, body: text, status,
      category, priority, event_date: eventDate, work_status: workStatus,
      summary, featured, archive_date: archiveDate, related_project: relatedProject,
      show_on_banner: showOnBanner
    } = data || {};
    const items = await getSheetData(googleToken, "Announcements");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const updates = [];
    if (typeof title === "string")  updates.push(sheetsUpdate(googleToken, `Announcements!C${row}`, [[title.trim()]]));
    if (typeof text === "string")   updates.push(sheetsUpdate(googleToken, `Announcements!D${row}`, [[text.trim()]]));
    if (typeof status === "string") updates.push(sheetsUpdate(googleToken, `Announcements!E${row}`, [[status]]));

    // Phase 1A fields (G-O) — each is independently optional, only touched
    // when the caller actually sent it, and normalized rather than trusted.
    const hasExtField = [category, priority, eventDate, workStatus, summary, featured, archiveDate, relatedProject, showOnBanner]
      .some(v => typeof v === "string" || typeof v === "boolean");
    if (hasExtField) {
      // Self-heal the header for sheets created before columns G-O existed.
      updates.push(sheetsUpdate(googleToken, "Announcements!G1:O1", [ANNOUNCEMENT_EXT_HEADERS]));
      if (typeof category === "string")       updates.push(sheetsUpdate(googleToken, `Announcements!G${row}`, [[normalizeAnnCategory(category)]]));
      if (typeof priority === "string")       updates.push(sheetsUpdate(googleToken, `Announcements!H${row}`, [[normalizeAnnPriority(priority)]]));
      if (typeof eventDate === "string")      updates.push(sheetsUpdate(googleToken, `Announcements!I${row}`, [[normalizeAnnDate(eventDate)]]));
      if (typeof workStatus === "string")     updates.push(sheetsUpdate(googleToken, `Announcements!J${row}`, [[normalizeAnnWorkStatus(workStatus)]]));
      if (typeof summary === "string")        updates.push(sheetsUpdate(googleToken, `Announcements!K${row}`, [[summary.trim()]]));
      if (typeof featured !== "undefined")    updates.push(sheetsUpdate(googleToken, `Announcements!L${row}`, [[normalizeAnnFeatured(featured)]]));
      if (typeof archiveDate === "string")    updates.push(sheetsUpdate(googleToken, `Announcements!M${row}`, [[normalizeAnnDate(archiveDate)]]));
      if (typeof relatedProject === "string") updates.push(sheetsUpdate(googleToken, `Announcements!N${row}`, [[relatedProject.trim()]]));
      if (typeof showOnBanner !== "undefined")updates.push(sheetsUpdate(googleToken, `Announcements!O${row}`, [[normalizeAnnShowOnBanner(showOnBanner)]]));
    }

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
    // Clear the row's content (A:O) so it no longer appears on the site or portal
    await sheetsUpdate(googleToken, `Announcements!A${row}:O${row}`, [["", "", "", "", "deleted", "", "", "", "", "", "", "", "", "", ""]]);
    await logActivity(googleToken, session.username, "deleted_announcement", itemId, "announcement", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── ADD MEETING MINUTES ──
  if (action === "addMinutes") {
    const meetingDate = (data?.meeting_date || "").trim();
    const title = (data?.title || "").trim();
    const summary  = (data?.summary || "").trim();
    const attendees = (data?.attendees || "").trim();
    const meetingType = (data?.meeting_type === "community") ? "community" : "board";
    if (!meetingDate || !title || !summary) return { statusCode: 400, body: JSON.stringify({ error: "Meeting date, title and summary are required" }) };
    // Draft minutes are saved unpublished (visible in the portal for review,
    // not on the website) until the board clicks Publish.
    const status = (data?.status === "draft" || data?.status === "unpublished") ? "unpublished" : "published";
    const id = "MIN-" + Date.now().toString(36).toUpperCase();
    // Self-heal the header for sheets created before the meeting_type column existed,
    // so getSheetData (which maps by header name) can read the value back.
    await sheetsUpdate(googleToken, "Minutes!H1", [["meeting_type"]]);
    await sheetsAppend(googleToken, "Minutes!A:H", [[
      id, meetingDate, title, summary, status, session.displayName, attendees, meetingType
    ]]);
    await logActivity(googleToken, session.username, status === "published" ? "posted_minutes" : "drafted_minutes", id, "minutes", title.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, id, status }) };
  }

  // ── UPDATE MEETING MINUTES (edit text and/or change published status) ──
  if (action === "updateMinutes") {
    const { itemId, meeting_date: meetingDate, title, summary, status, attendees, meeting_type: meetingType } = data || {};
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
    if (typeof meetingType === "string") {
      updates.push(sheetsUpdate(googleToken, "Minutes!H1", [["meeting_type"]]));   // self-heal header
      updates.push(sheetsUpdate(googleToken, `Minutes!H${row}`, [[meetingType === "community" ? "community" : "board"]]));
    }
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
    // Clear the row's content (A:H) so it no longer appears on the site or portal
    await sheetsUpdate(googleToken, `Minutes!A${row}:H${row}`, [["", "", "", "", "deleted", "", "", ""]]);
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
    notes.push({ author: session.displayName, username: session.username, text: note, timestamp: new Date().toISOString() });
    await sheetsUpdate(googleToken, `Resident_Requests!L${rowIndex + 2}`, [[JSON.stringify(notes)]]);
    await logActivity(googleToken, session.username, "added_note", itemId, "request", note.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, notes }) };
  }

  // ── DELETE A RESIDENT REQUEST (admin only) — blanks the row so it disappears ──
  if (action === "deleteRequest") {
    const { itemId } = data || {};
    const items = await getSheetData(googleToken, "Resident_Requests");
    const rowIndex = items.findIndex(i => i.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    await sheetsUpdate(googleToken, `Resident_Requests!A${row}:L${row}`, [Array(12).fill("")]);
    await logActivity(googleToken, session.username, "deleted_request", itemId, "request", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── RESIDENT PORTAL ACCESS REQUESTS (Board review of public submissions) ──
  // Internal Board Notes are only ever read here, behind the same AUTH CHECK
  // as every other board-only action above — there is no public endpoint
  // that returns this tab's data. See lib/access-requests.js for the
  // worksheet schema, safe-creation/header-validation, and password
  // placeholder handling.

  if (action === "getAccessRequests") {
    await accessRequestsLib.ensureAccessRequestsTab(googleToken);
    const items = await getSheetData(googleToken, accessRequestsLib.TAB_NAME);
    return { statusCode: 200, body: JSON.stringify({ requests: items.filter(r => r["Request ID"]) }) };
  }

  // Returns a subject/body preview for the board to review and edit before
  // sending. For the "approved" template the body contains only the literal
  // PASSWORD_PLACEHOLDER text — the real RESIDENT_PORTAL_PASSWORD is never
  // read, computed, or returned here.
  if (action === "getAccessRequestPreview") {
    const { itemId, templateType } = data || {};
    if (!accessRequestsLib.isValidTemplateType(templateType)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid template type" }) };
    }
    await accessRequestsLib.ensureAccessRequestsTab(googleToken);
    const items = await getSheetData(googleToken, accessRequestsLib.TAB_NAME);
    const item = items.find(r => r["Request ID"] === itemId);
    if (!item) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const tmpl = accessRequestsLib.buildTemplate(templateType, { firstName: item["First Name"] });
    return {
      statusCode: 200,
      body: JSON.stringify({ to: item["Email Address"], subject: tmpl.subject, body: tmpl.body, templateType }),
    };
  }

  // Sends the board-edited reply. Only when templateType === "approved" is
  // the real password substituted for the placeholder, and only in the
  // outgoing email — never in the Sheets update, the activity log, or the
  // JSON returned to the browser. A send failure leaves the request NOT
  // marked as delivered (Delivery Status = "Failed", Response Sent At left
  // untouched) so the board knows to retry.
  if (action === "sendAccessResponse") {
    const { itemId, templateType, subject, body: emailBody } = data || {};
    if (!accessRequestsLib.isValidTemplateType(templateType)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid template type" }) };
    }
    const cleanSubject = (subject || "").trim();
    const cleanBody = (emailBody || "").trim();
    if (!cleanSubject || !cleanBody) {
      return { statusCode: 400, body: JSON.stringify({ error: "Subject and message are required" }) };
    }
    await accessRequestsLib.ensureAccessRequestsTab(googleToken);
    const items = await getSheetData(googleToken, accessRequestsLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Request ID"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const to = items[rowIndex]["Email Address"];
    if (!to) return { statusCode: 400, body: JSON.stringify({ error: "Request has no email on file" }) };
    const row = rowIndex + 2;

    // Duplicate-send guard — see lib/access-requests.js's isDuplicateSend
    // for why this is a time-window check on the row's own last-send state
    // rather than a hard lock. Never triggers after a FAILED send, so a
    // retry is always immediately available.
    if (accessRequestsLib.isDuplicateSend(items[rowIndex]["Delivery Status"], items[rowIndex]["Response Sent At UTC"], Date.now())) {
      return { statusCode: 409, body: JSON.stringify({ success: false, error: "A response was already sent moments ago. Please wait before sending again." }) };
    }

    const outgoingBody = templateType === "approved"
      ? accessRequestsLib.insertPassword(cleanBody, process.env.RESIDENT_PORTAL_PASSWORD || "")
      : cleanBody;

    let delivered = false;
    try {
      const gmailToken = await refreshGmailToken();
      const raw = buildEmail(to, cleanSubject, outgoingBody);
      const sendRes = await httpsReq("POST", "gmail.googleapis.com", "/gmail/v1/users/me/messages/send",
        { Authorization: `Bearer ${gmailToken}`, "Content-Type": "application/json" }, { raw });
      if (sendRes.status >= 400) throw new Error(`gmail_send_failed_${sendRes.status}`);
      delivered = true;
    } catch (sendErr) {
      console.error(JSON.stringify({ accessResponseSendFailed: true, itemId }));
    }

    const now = new Date().toISOString();
    const TAB = accessRequestsLib.TAB_NAME;
    const updates = [
      sheetsUpdate(googleToken, `'${TAB}'!J${row}`, [[now]]),
      sheetsUpdate(googleToken, `'${TAB}'!K${row}`, [[session.displayName]]),
      sheetsUpdate(googleToken, `'${TAB}'!O${row}`, [[delivered ? accessRequestsLib.DELIVERY_SENT : accessRequestsLib.DELIVERY_FAILED]]),
    ];
    if (delivered) {
      updates.push(sheetsUpdate(googleToken, `'${TAB}'!L${row}`, [[now]]));
      updates.push(sheetsUpdate(googleToken, `'${TAB}'!M${row}`, [[accessRequestsLib.TEMPLATE_LABELS[templateType]]]));
      updates.push(sheetsUpdate(googleToken, `'${TAB}'!N${row}`, [[cleanSubject]]));
    }
    await Promise.all(updates);
    await logActivity(googleToken, session.username, delivered ? "sent_access_response" : "access_response_send_failed",
      itemId, "access_request", accessRequestsLib.TEMPLATE_LABELS[templateType]);

    if (!delivered) {
      return { statusCode: 502, body: JSON.stringify({ success: false, error: "Email could not be sent. The request was not marked as delivered." }) };
    }
    return { statusCode: 200, body: JSON.stringify({ success: true, deliveryStatus: accessRequestsLib.DELIVERY_SENT }) };
  }

  // ── UPDATE ACCESS REQUEST STATUS ──
  if (action === "updateAccessRequestStatus") {
    const { itemId, status } = data || {};
    if (!accessRequestsLib.isValidStatus(status)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid status" }) };
    }
    await accessRequestsLib.ensureAccessRequestsTab(googleToken);
    const items = await getSheetData(googleToken, accessRequestsLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Request ID"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const now = new Date().toISOString();
    const TAB = accessRequestsLib.TAB_NAME;
    await Promise.all([
      sheetsUpdate(googleToken, `'${TAB}'!H${row}`, [[status]]),
      sheetsUpdate(googleToken, `'${TAB}'!J${row}`, [[now]]),
      sheetsUpdate(googleToken, `'${TAB}'!K${row}`, [[session.displayName]]),
    ]);
    await logActivity(googleToken, session.username, `access_request_status_${status.replace(/ /g, "_")}`, itemId, "access_request", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── ADD INTERNAL NOTE TO ACCESS REQUEST ──
  if (action === "addAccessRequestNote") {
    const { itemId, note } = data || {};
    const cleanNote = (note || "").trim();
    if (!cleanNote) return { statusCode: 400, body: JSON.stringify({ error: "Note text is required" }) };
    if (cleanNote.length > accessRequestsLib.MAX_NOTE_LEN) return { statusCode: 400, body: JSON.stringify({ error: "Note is too long" }) };
    await accessRequestsLib.ensureAccessRequestsTab(googleToken);
    const items = await getSheetData(googleToken, accessRequestsLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Request ID"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    let notes = [];
    try { notes = JSON.parse(items[rowIndex]["Internal Board Notes"] || "[]"); } catch {}
    notes.push({ author: session.displayName, username: session.username, text: cleanNote, timestamp: new Date().toISOString() });
    const now = new Date().toISOString();
    const TAB = accessRequestsLib.TAB_NAME;
    await Promise.all([
      sheetsUpdate(googleToken, `'${TAB}'!I${row}`, [[JSON.stringify(notes)]]),
      sheetsUpdate(googleToken, `'${TAB}'!J${row}`, [[now]]),
      sheetsUpdate(googleToken, `'${TAB}'!K${row}`, [[session.displayName]]),
    ]);
    await logActivity(googleToken, session.username, "added_access_request_note", itemId, "access_request", cleanNote.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, notes }) };
  }

  // ── DELETE A PORTAL ACCESS REQUEST (admin only) — blanks the row so it disappears ──
  if (action === "deleteAccessRequest") {
    const { itemId } = data || {};
    await accessRequestsLib.ensureAccessRequestsTab(googleToken);
    const items = await getSheetData(googleToken, accessRequestsLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Request ID"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const TAB = accessRequestsLib.TAB_NAME;
    const lastCol = String.fromCharCode(64 + accessRequestsLib.HEADERS.length);
    await sheetsUpdate(googleToken, `'${TAB}'!A${row}:${lastCol}${row}`, [Array(accessRequestsLib.HEADERS.length).fill("")]);
    await logActivity(googleToken, session.username, "deleted_access_request", itemId, "access_request", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── COMMITTEE VOLUNTEER INTERESTS (Board review of committee-volunteer.html
  // submissions) ── Same shared "Committee_Volunteers" sheet the public
  // submission endpoint (submit-committee-volunteer.js) writes to — this is
  // the single Board-facing view of that data, gated behind the same AUTH
  // CHECK as everything else above. Row identity is the Timestamp column
  // (millisecond-precision ISO string set server-side at submission time,
  // never resident-supplied) rather than a synthetic ID column — collisions
  // would require two submissions in the same millisecond.
  if (action === "getCommitteeVolunteers") {
    await committeeVolunteersLib.ensureVolunteersTab(googleToken);
    await committeeVolunteersLib.ensureVolunteerExtHeaders(googleToken);
    const items = await getSheetData(googleToken, committeeVolunteersLib.TAB_NAME);
    const volunteers = items.filter(v => v["Timestamp"]);
    // PII read, same convention as getResidents.
    await logActivity(googleToken, session.username, "viewed_committee_volunteers", "-", "committee_volunteers",
      `access=${session.access} records=${volunteers.length}`);
    return { statusCode: 200, body: JSON.stringify({ volunteers }) };
  }

  if (action === "updateCommitteeVolunteerStatus") {
    const { itemId, status } = data || {};
    if (!committeeVolunteersLib.isValidStatus(status)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid status" }) };
    }
    await committeeVolunteersLib.ensureVolunteersTab(googleToken);
    const items = await getSheetData(googleToken, committeeVolunteersLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Timestamp"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const TAB = committeeVolunteersLib.TAB_NAME;
    await sheetsUpdate(googleToken, `'${TAB}'!Q${row}`, [[status]]);
    await logActivity(googleToken, session.username, `committee_volunteer_status_${status.replace(/ /g, "_")}`, itemId, "committee_volunteer", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  if (action === "updateCommitteeVolunteerNotes") {
    const { itemId, notes } = data || {};
    const cleanNotes = (notes || "").trim();
    if (cleanNotes.length > 2000) return { statusCode: 400, body: JSON.stringify({ error: "Notes are too long" }) };
    await committeeVolunteersLib.ensureVolunteersTab(googleToken);
    await committeeVolunteersLib.ensureVolunteerExtHeaders(googleToken);
    const items = await getSheetData(googleToken, committeeVolunteersLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Timestamp"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const TAB = committeeVolunteersLib.TAB_NAME;
    await sheetsUpdate(googleToken, `'${TAB}'!R${row}`, [[cleanNotes]]);
    await logActivity(googleToken, session.username, "added_committee_volunteer_note", itemId, "committee_volunteer", cleanNotes.slice(0, 100));
    return { statusCode: 200, body: JSON.stringify({ success: true, notes: cleanNotes }) };
  }

  // Controls whether a resident's name is shown on the Resident Portal's
  // Community Committees page — off by default (see buildVolunteerRow /
  // ensureVolunteerExtHeaders), only ever flipped on here by a Board member.
  if (action === "updateCommitteeVolunteerPublicListing") {
    const { itemId, publicListing } = data || {};
    await committeeVolunteersLib.ensureVolunteersTab(googleToken);
    await committeeVolunteersLib.ensureVolunteerExtHeaders(googleToken);
    const items = await getSheetData(googleToken, committeeVolunteersLib.TAB_NAME);
    const rowIndex = items.findIndex(r => r["Timestamp"] === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const value = publicListing === true ? "yes" : "no";
    const TAB = committeeVolunteersLib.TAB_NAME;
    await sheetsUpdate(googleToken, `'${TAB}'!S${row}`, [[value]]);
    await logActivity(googleToken, session.username, `committee_volunteer_public_listing_${value}`, itemId, "committee_volunteer", "");
    return { statusCode: 200, body: JSON.stringify({ success: true, publicListing: value }) };
  }

  // ── CAST VOTE ──
  if (action === "castVote") {
    // A member with no vote columns in ARC_Requests (currently Jodi) cannot
    // have a vote persisted. Previously the column maps below yielded
    // `undefined`, the range became "ARC_Requests!undefined<row>", the write
    // result was discarded and the portal reported success — so the vote was
    // silently lost. Refuse before touching the sheet; Phase A2 adds her
    // columns and this guard stops applying to her.
    if (!members.canVote(session.username)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Voting is not yet enabled for your account. Your vote was NOT recorded — please ask an administrator to record it for now.",
          code: "voting_not_enabled"
        })
      };
    }
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

  // ── ADMIN: RECORD VOTES ON BEHALF (votes already cast by email) ──
  if (action === "adminSetVotes") {
    const { itemId, votes } = data || {};
    const arcs = await getSheetData(googleToken, "ARC_Requests");
    const rowIndex = arcs.findIndex(a => a.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };

    const sheetRow = rowIndex + 2;
    const voteColMap = { tony: "P", yashu: "T", ramana: "X", raja: "AB", aimee: "AF", mike: "AJ" };
    const timeColMap = { tony: "S", yashu: "W", ramana: "AA", raja: "AE", aimee: "AI", mike: "AM" };
    const now = new Date().toISOString();

    const updates = [];
    for (const [k, v] of Object.entries(votes || {})) {
      if (!voteColMap[k]) continue;
      updates.push(sheetsUpdate(googleToken, `ARC_Requests!${voteColMap[k]}${sheetRow}`, [[v || ""]]));
      if (v) updates.push(sheetsUpdate(googleToken, `ARC_Requests!${timeColMap[k]}${sheetRow}`, [[now]]));
    }
    await Promise.all(updates);

    // Recount and re-derive status using the same rule as castVote.
    const updatedArcs = await getSheetData(googleToken, "ARC_Requests");
    const arc = updatedArcs[rowIndex];
    const castVotes = ["tony_vote","yashu_vote","ramana_vote","raja_vote","aimee_vote","mike_vote"].map(key => arc[key]).filter(x => x && x !== "");
    const approveCount = castVotes.filter(x => x === "Approve" || x === "Conditional").length;
    const denyCount = castVotes.filter(x => x === "Deny").length;

    let newStatus = arc.final_status;
    if (approveCount >= 4) newStatus = "Approved";
    else if (denyCount >= 4) newStatus = "Denied";
    else if (approveCount === 3 && denyCount === 3) newStatus = "Tie - Tony Decides";

    await sheetsUpdate(googleToken, `ARC_Requests!AO${sheetRow}`, [[castVotes.length.toString()]]);
    await sheetsUpdate(googleToken, `ARC_Requests!AP${sheetRow}`, [[newStatus || "Open"]]);

    await logActivity(googleToken, session.username, "recorded_votes_on_behalf", itemId, "ARC", `${Object.keys(votes || {}).length} member vote(s) recorded`);

    return { statusCode: 200, body: JSON.stringify({ success: true, newStatus, voteCount: castVotes.length }) };
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
    comments.push({ author: session.displayName, username: session.username, text: comment, timestamp: new Date().toISOString() });
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

  // ── EDIT AN ARC RECORD (admin only) — correct AI-misread fields ──
  if (action === "updateARC") {
    const { itemId, fields } = data || {};
    const arcs = await getSheetData(googleToken, "ARC_Requests");
    const rowIndex = arcs.findIndex(a => a.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    const COLS = { date_received: "B", homeowner_name: "C", homeowner_email: "D", address: "E", request_type: "F", description: "G", final_status: "AO" };
    const updates = [];
    for (const [k, col] of Object.entries(COLS)) {
      if (fields && typeof fields[k] === "string") updates.push(sheetsUpdate(googleToken, `ARC_Requests!${col}${row}`, [[fields[k]]]));
    }
    await Promise.all(updates);
    await logActivity(googleToken, session.username, "edited_arc", itemId, "arc", "");
    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  // ── ADD AN ARC RECORD / CONCERN (admin only) — manually create an entry ──
  if (action === "addARC") {
    const f = data?.fields || {};
    const prefix = /concern/i.test(f.request_type || "") ? "CON-" : "ARC-";
    const id = prefix + Date.now().toString(36).toUpperCase();
    const date = (f.date_received || new Date().toISOString().slice(0, 10)).trim();
    // Columns A-G: id, date_received, homeowner_name, homeowner_email, address, request_type, description
    // Remaining columns left blank; empty final_status renders as "Open".
    await sheetsAppend(googleToken, "ARC_Requests!A:G", [[
      id, date,
      (f.homeowner_name || "").trim(), (f.homeowner_email || "").trim(),
      (f.address || "").trim(), (f.request_type || "Other").trim(), (f.description || "").trim()
    ]]);
    await logActivity(googleToken, session.username, "added_arc", id, "arc", (f.request_type || "").slice(0, 60));
    return { statusCode: 200, body: JSON.stringify({ success: true, id }) };
  }

  // ── DELETE AN ARC RECORD / CONCERN (admin only) — blanks the row so it disappears ──
  if (action === "deleteARC") {
    const { itemId } = data || {};
    const arcs = await getSheetData(googleToken, "ARC_Requests");
    const rowIndex = arcs.findIndex(a => a.id === itemId);
    if (rowIndex === -1) return { statusCode: 404, body: JSON.stringify({ error: "Not found" }) };
    const row = rowIndex + 2;
    await sheetsUpdate(googleToken, `ARC_Requests!A${row}:AV${row}`, [Array(48).fill("")]);
    await logActivity(googleToken, session.username, "deleted_arc", itemId, "arc", "");
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

  // Unreachable in practice: authorize() denies any action missing from the
  // permission table with a 403 before dispatch. Kept as a backstop.
  return { statusCode: 400, body: JSON.stringify({ error: "Unknown action" }) };
}

// A failed Sheets write must surface as a failure, never as a 200 the portal
// renders as success. SheetsWriteError becomes a 502 naming the problem;
// anything else is a genuine bug and stays a 500 rather than being disguised
// as a persistence failure.
exports.handler = async (event) => {
  try {
    return await handleRequest(event);
  } catch (err) {
    const writeError = sheetsWrite.toErrorResponse(err);
    if (writeError) {
      console.error(JSON.stringify({ sheetsWriteFailed: true, detail: String(err.detail || err.message || err).slice(0, 200) }));
      return writeError;
    }
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: "Unexpected server error." }) };
  }
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
