/* ═══════════════════════════════════════════════════════════
   TWIN LAKES — health-check.js
   ───────────────────────────────────────────────────────────
   Scheduled function (see netlify.toml) that verifies the Gmail
   sending token is still valid and records the result in the
   Settings sheet. The board portal reads this and shows a red
   banner if email notifications are down — so a dead token is
   noticed immediately instead of silently dropping resident
   request notifications.

   The check writes via the Google service account (Sheets), which
   is independent of Gmail — so the status is recorded even when
   Gmail itself is the thing that's broken.

   Can also be invoked manually (GET/POST) to check on demand.
   ═══════════════════════════════════════════════════════════ */

const https = require("https");
const crypto = require("crypto");

const SHEET_ID = (process.env.GOOGLE_SHEET_ID || "").trim();
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY   = process.env.GOOGLE_SA_KEY;

function httpsReq(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const req = https.request({ hostname, path, method,
      headers: { ...headers, ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

function getGoogleToken(scopes) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: SA_EMAIL, scope: scopes.join(" "),
      aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now })).toString("base64url");
    const sign = crypto.createSign("RSA-SHA256"); sign.update(`${header}.${payload}`);
    const sig = sign.sign(SA_KEY.replace(/\\n/g, "\n"), "base64url");
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${header}.${payload}.${sig}`;
    httpsReq("POST", "oauth2.googleapis.com", "/token", { "Content-Type": "application/x-www-form-urlencoded" }, body)
      .then(r => { const j = JSON.parse(r.body); j.access_token ? resolve(j.access_token) : reject(new Error(r.body)); })
      .catch(reject);
  });
}

// Returns { ok, detail } for the Gmail sending token.
async function checkGmail() {
  try {
    const body = `client_id=${encodeURIComponent(process.env.GMAIL_CLIENT_ID)}&client_secret=${encodeURIComponent(process.env.GMAIL_CLIENT_SECRET)}&refresh_token=${encodeURIComponent(process.env.GMAIL_REFRESH_TOKEN)}&grant_type=refresh_token`;
    const r = await httpsReq("POST", "oauth2.googleapis.com", "/token", { "Content-Type": "application/x-www-form-urlencoded" }, body);
    const j = JSON.parse(r.body);
    if (!j.access_token) return { ok: false, detail: (j.error_description || j.error || "no access_token") };
    // Confirm the token can actually reach Gmail
    const prof = await httpsReq("GET", "gmail.googleapis.com", "/gmail/v1/users/me/profile", { Authorization: `Bearer ${j.access_token}` });
    if (prof.status >= 400) return { ok: false, detail: `profile ${prof.status}` };
    return { ok: true, detail: "ok" };
  } catch (e) { return { ok: false, detail: String(e).slice(0, 120) }; }
}

// Upsert a key/value pair into the Settings tab.
async function setSetting(token, key, value) {
  const g = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("Settings!A:B")}`, { Authorization: `Bearer ${token}` });
  const rows = (JSON.parse(g.body).values) || [];
  let rowIdx = -1;
  for (let i = 1; i < rows.length; i++) { if ((rows[i][0] || "") === key) { rowIdx = i + 1; break; } }
  if (rowIdx > 0) {
    await httpsReq("PUT", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(`Settings!A${rowIdx}:B${rowIdx}`)}?valueInputOption=RAW`,
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      { range: `Settings!A${rowIdx}:B${rowIdx}`, majorDimension: "ROWS", values: [[key, value]] });
  } else {
    await httpsReq("POST", "sheets.googleapis.com",
      `/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent("Settings!A:B")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, { values: [[key, value]] });
  }
}

exports.handler = async () => {
  const result = await checkGmail();
  try {
    const token = await getGoogleToken(["https://www.googleapis.com/auth/spreadsheets"]);
    await setSetting(token, "email_health", result.ok ? "ok" : "down");
    await setSetting(token, "email_checked_at", new Date().toISOString());
    if (!result.ok) await setSetting(token, "email_health_detail", result.detail);
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: "could not record status", detail: String(e).slice(0, 150) }) };
  }
  return { statusCode: 200, body: JSON.stringify({ email_health: result.ok ? "ok" : "down", detail: result.detail }) };
};
