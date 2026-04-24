const https = require("https");

// ── helpers ──────────────────────────────────────────────
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: raw }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ── get Gmail access token ────────────────────────────────
async function getAccessToken() {
  const res = await httpsPost(
    "https://oauth2.googleapis.com/token",
    { "Content-Type": "application/x-www-form-urlencoded" },
    `client_id=${encodeURIComponent(process.env.GMAIL_CLIENT_ID)}` +
    `&client_secret=${encodeURIComponent(process.env.GMAIL_CLIENT_SECRET)}` +
    `&refresh_token=${encodeURIComponent(process.env.GMAIL_REFRESH_TOKEN)}` +
    `&grant_type=refresh_token`
  );
  const data = JSON.parse(res.body);
  if (!data.access_token) throw new Error("Failed to get access token: " + res.body);
  return data.access_token;
}

// ── list all message IDs ──────────────────────────────────
async function listMessages(token, maxResults = 200) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=in:inbox`;
  const res = await httpsGet(url, { Authorization: `Bearer ${token}` });
  const data = JSON.parse(res.body);
  return data.messages || [];
}

// ── get single message ────────────────────────────────────
async function getMessage(token, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const res = await httpsGet(url, { Authorization: `Bearer ${token}` });
  return JSON.parse(res.body);
}

// ── decode base64 email body ──────────────────────────────
function decodeBody(msg) {
  try {
    const parts = msg.payload.parts || [msg.payload];
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8").slice(0, 800);
      }
    }
    if (msg.payload.body?.data) {
      return Buffer.from(msg.payload.body.data, "base64url").toString("utf8").slice(0, 800);
    }
  } catch (_) {}
  return "";
}

// ── extract headers ───────────────────────────────────────
function getHeader(headers, name) {
  return (headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) || {}).value || "";
}

// ── send email via Gmail API ──────────────────────────────
async function sendEmail(token, to, subject, htmlBody) {
  const boundary = "boundary_twinlakes_digest";
  const raw = [
    `From: Twin Lakes HOA <hoa.twinlakes.board@gmail.com>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    htmlBody,
  ].join("\r\n");

  const encoded = Buffer.from(raw).toString("base64url");
  const res = await httpsPost(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    JSON.stringify({ raw: encoded })
  );
  return res;
}

// ── ask Claude to summarize ───────────────────────────────
async function summarizeWithClaude(emailsText) {
  const res = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: `You are an assistant helping the Twin Lakes at Floyds Fork HOA board in Louisville, Kentucky review their email inbox.

Analyze all emails and produce a structured HTML summary organized into these categories:
1. 🏗️ ARC Requests — architectural review requests from homeowners
2. 🔧 Maintenance & Repairs — issues with common areas, ponds, landscaping
3. 📢 Violations & Complaints — parking, noise, property violations
4. 💬 Resident Inquiries — general questions from residents
5. 📋 Mulloy / Management — communications from Eddie Douglas or Mulloy Properties
6. 💰 Financial — dues, payments, invoices
7. 📅 Meetings & Events — board meeting notices, community events
8. ✅ Resolved / Closed — items that appear to be resolved
9. 📂 Other — anything that doesn't fit above

For each email in each category include:
- Sender name and email
- Date received
- Subject
- 1-2 sentence summary of what they need or what happened
- Suggested status: 🔴 Needs Action / 🟡 In Progress / ✅ Resolved

At the top include an executive summary with total counts per category and overall inbox health.

Format everything as clean HTML using inline styles. Use the color scheme: navy #1B4B7A and gold #C9A84C.`,
      messages: [
        {
          role: "user",
          content: `Here are all the emails from the Twin Lakes HOA inbox. Please analyze and summarize them:\n\n${emailsText}`,
        },
      ],
    }
  );

  const data = JSON.parse(res.body);
  if (!data.content?.[0]?.text) throw new Error("Claude error: " + res.body);
  return data.content[0].text;
}

// ── build full HTML email ─────────────────────────────────
function buildEmailHtml(summaryHtml, totalEmails, generatedAt) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#F8F7F4;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:800px;margin:0 auto;padding:24px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1B4B7A,#0F2D4A);border-radius:12px 12px 0 0;padding:32px;text-align:center;border-bottom:3px solid #C9A84C;">
      <div style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#C9A84C;margin-bottom:8px;">Twin Lakes at Floyds Fork</div>
      <h1 style="color:#fff;margin:0;font-size:26px;font-weight:normal;">HOA Inbox Summary</h1>
      <div style="color:rgba(255,255,255,0.6);font-size:14px;margin-top:8px;font-style:italic;">Generated ${generatedAt} &nbsp;·&nbsp; ${totalEmails} emails analyzed</div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:32px;border-radius:0 0 12px 12px;border:1px solid rgba(201,168,76,0.2);border-top:none;">
      ${summaryHtml}
    </div>

    <!-- Footer -->
    <div style="text-align:center;padding:20px;font-size:12px;color:#999;font-family:sans-serif;">
      This digest was generated automatically for Twin Lakes HOA Board members only.<br/>
      Do not forward or share outside the board.
    </div>
  </div>
</body>
</html>`;
}

// ── main handler ──────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Simple auth check — board only
  const { secret } = JSON.parse(event.body || "{}");
  if (secret !== process.env.DIGEST_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  try {
    console.log("Getting Gmail access token...");
    const token = await getAccessToken();

    console.log("Fetching message list...");
    const messages = await listMessages(token, 200);
    console.log(`Found ${messages.length} messages`);

    // Fetch up to 150 emails (to stay within Claude context)
    const limit = Math.min(messages.length, 150);
    const emailDetails = [];

    for (let i = 0; i < limit; i++) {
      try {
        const msg = await getMessage(token, messages[i].id);
        const headers = msg.payload?.headers || [];
        emailDetails.push({
          id: messages[i].id,
          from: getHeader(headers, "From"),
          to: getHeader(headers, "To"),
          subject: getHeader(headers, "Subject"),
          date: getHeader(headers, "Date"),
          body: decodeBody(msg),
        });
      } catch (e) {
        console.log(`Skipping message ${messages[i].id}: ${e.message}`);
      }
    }

    // Format emails for Claude
    const emailsText = emailDetails
      .map((e, i) => `--- EMAIL ${i + 1} ---\nFrom: ${e.from}\nDate: ${e.date}\nSubject: ${e.subject}\nBody Preview: ${e.body}\n`)
      .join("\n");

    console.log("Sending to Claude for analysis...");
    const summaryHtml = await summarizeWithClaude(emailsText);

    // Build full email
    const now = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "America/Louisville",
    });
    const fullHtml = buildEmailHtml(summaryHtml, emailDetails.length, now);

    // Board member emails
    const boardEmails = [
      "tbackert@example.com",       // Tony Backert — UPDATE WITH REAL EMAIL
      "yashu@example.com",           // Yashu — UPDATE WITH REAL EMAIL
      "ramana@example.com",          // Ramana — UPDATE WITH REAL EMAIL
      "hoa.twinlakes.board@gmail.com", // Raja (you)
      "agreen@example.com",          // Aimee — UPDATE WITH REAL EMAIL
      "mschnell@example.com",        // Mike — UPDATE WITH REAL EMAIL
    ];

    console.log("Sending digest emails...");
    const subject = `🏘️ Twin Lakes HOA — Inbox Digest (${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })})`;

    for (const email of boardEmails) {
      if (!email.includes("example.com")) {
        await sendEmail(token, email, subject, fullHtml);
        console.log(`Sent to ${email}`);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        emailsAnalyzed: emailDetails.length,
        message: `Digest generated from ${emailDetails.length} emails and sent to board members.`,
        preview: summaryHtml.slice(0, 500),
      }),
    };
  } catch (err) {
    console.error("Digest error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
