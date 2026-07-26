"use strict";
// Focused validation script for the Resident Portal Access Request feature:
// the public submission endpoint (resident-access-request.js), the shared
// validation/sanitization/template library (lib/access-requests.js), and
// the Board Portal review actions added to board-api.js. No test
// framework — Node's built-in `assert`, run with:
//   node scripts/test-access-requests.js
//
// Uses fake secrets/data only. Real Google/Gmail networks are never called:
// Node's https.request is intercepted with an in-memory fake (same
// technique as scripts/test-resident-audit-e2e.js) so the real
// JWT-signing, Sheets-append, and Gmail-send code in these files runs
// unmodified, and the exact bytes sent over the wire can be inspected —
// the strongest available check that the real Community Access Password
// only ever appears in the one place it's allowed to: the outgoing
// "Access Approved" email, never in a Sheets write or an HTTP response
// back to a browser.

const assert = require("assert");
const crypto = require("crypto");
const https = require("https");

const FAKE_SHEET_ID = "fake-sheet-id-for-access-requests-test";
const FAKE_SA_EMAIL = "fake-service-account@fake-project.iam.gserviceaccount.com";
const FAKE_REAL_PASSWORD = "super-secret-community-password-do-not-leak";

const { privateKey: FAKE_SA_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

process.env.GOOGLE_SHEET_ID = FAKE_SHEET_ID;
process.env.GOOGLE_SA_EMAIL = FAKE_SA_EMAIL;
process.env.GOOGLE_SA_KEY = FAKE_SA_KEY;
process.env.GMAIL_CLIENT_ID = "fake-client-id";
process.env.GMAIL_CLIENT_SECRET = "fake-client-secret";
process.env.GMAIL_REFRESH_TOKEN = "fake-refresh-token";
process.env.RESIDENT_PORTAL_PASSWORD = FAKE_REAL_PASSWORD;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL  - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL  - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ── lib/access-requests.js — pure functions, no network ─────────────
const lib = require("../netlify/functions/lib/access-requests");

console.log("Validation");
test("normalizeRequiredText: trims, collapses whitespace, caps length", () => {
  assert.strictEqual(lib.normalizeRequiredText("  John   Q. Public  ", 80), "John Q. Public");
  assert.strictEqual(lib.normalizeRequiredText("a".repeat(81), 80), null);
  assert.strictEqual(lib.normalizeRequiredText("", 80), null);
  assert.strictEqual(lib.normalizeRequiredText("   ", 80), null);
});
test("normalizeRequiredText: does not reject unicode/apostrophes (a support form, not an eligibility check)", () => {
  assert.strictEqual(lib.normalizeRequiredText("O'Brien-Muñoz", 80), "O'Brien-Muñoz");
});
test("normalizeEmail: validates format and length", () => {
  assert.strictEqual(lib.normalizeEmail("  a@b.com  "), "a@b.com");
  assert.strictEqual(lib.normalizeEmail("not-an-email"), null);
  assert.strictEqual(lib.normalizeEmail("a@b." + "c".repeat(200)), null);
});
test("normalizeComments: optional (blank ok), oversized rejected", () => {
  assert.strictEqual(lib.normalizeComments(""), "");
  assert.strictEqual(lib.normalizeComments(undefined), "");
  assert.strictEqual(lib.normalizeComments("hello"), "hello");
  assert.strictEqual(lib.normalizeComments("a".repeat(1001)), null);
});
test("validateSubmission: honeypot filled -> honeypot flag, not a normal error", () => {
  const result = lib.validateSubmission({ firstName: "A", lastName: "B", homeAddress: "1 Main St", email: "a@b.com", website: "http://spam.example" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.honeypot, true);
});
test("validateSubmission: missing required fields rejected", () => {
  assert.strictEqual(lib.validateSubmission({}).ok, false);
  assert.strictEqual(lib.validateSubmission({ firstName: "A" }).ok, false);
});
test("validateSubmission: invalid email rejected", () => {
  const r = lib.validateSubmission({ firstName: "A", lastName: "B", homeAddress: "1 Main St", email: "nope" });
  assert.strictEqual(r.ok, false);
});
test("validateSubmission: valid submission returns normalized fields, comments default to empty string", () => {
  const r = lib.validateSubmission({ firstName: " Jane ", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com" });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fields, { firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com", comments: "" });
});

console.log("Status / template validation");
test("isValidStatus: accepts only the 5 defined statuses", () => {
  assert.strictEqual(lib.isValidStatus("New"), true);
  assert.strictEqual(lib.isValidStatus("Closed"), true);
  assert.strictEqual(lib.isValidStatus("Deleted"), false);
  assert.strictEqual(lib.isValidStatus(""), false);
});
test("isValidTemplateType: accepts only the 3 defined templates", () => {
  assert.strictEqual(lib.isValidTemplateType("approved"), true);
  assert.strictEqual(lib.isValidTemplateType("more_info"), true);
  assert.strictEqual(lib.isValidTemplateType("unable_to_verify"), true);
  assert.strictEqual(lib.isValidTemplateType("hacked"), false);
});

console.log("Duplicate-send guard");
test("isDuplicateSend: true only within the window, and only after a real Sent status", () => {
  const now = Date.parse("2026-01-01T00:00:10.000Z");
  const justSent = "2026-01-01T00:00:05.000Z"; // 5s ago
  const longAgo = "2026-01-01T00:00:00.000Z"; // 10s ago (still under 15s window)
  const wayEarlier = "2025-12-31T00:00:00.000Z"; // well outside window
  assert.strictEqual(lib.isDuplicateSend(lib.DELIVERY_SENT, justSent, now), true);
  assert.strictEqual(lib.isDuplicateSend(lib.DELIVERY_SENT, longAgo, now), true);
  assert.strictEqual(lib.isDuplicateSend(lib.DELIVERY_SENT, wayEarlier, now), false, "outside the cooldown window, a resend is allowed");
});
test("isDuplicateSend: never true after a Failed send, no matter how recent", () => {
  const now = Date.parse("2026-01-01T00:00:10.000Z");
  const justFailed = "2026-01-01T00:00:09.000Z";
  assert.strictEqual(lib.isDuplicateSend(lib.DELIVERY_FAILED, justFailed, now), false);
});
test("isDuplicateSend: never true with no prior send recorded", () => {
  assert.strictEqual(lib.isDuplicateSend("", "", Date.now()), false);
  assert.strictEqual(lib.isDuplicateSend(lib.DELIVERY_SENT, "", Date.now()), false);
});

console.log("Row construction (spreadsheet-injection protection)");
test("buildAccessRequestRow: matches HEADERS length, defaults Status=New, board columns blank", () => {
  const row = lib.buildAccessRequestRow({ firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com", comments: "hi" });
  assert.strictEqual(row.length, lib.HEADERS.length);
  assert.strictEqual(row[7], "New");
  assert.deepStrictEqual(row.slice(8), ["", "", "", "", "", "", ""]);
});
test("buildAccessRequestRow: neutralizes leading =, +, -, @ (spreadsheet-formula injection)", () => {
  const row = lib.buildAccessRequestRow({ firstName: "=cmd|'/c calc'!A1", lastName: "-Doe", homeAddress: "+123", email: "jane@example.com", comments: "@mention" });
  assert.strictEqual(row[2], "'=cmd|'/c calc'!A1");
  assert.strictEqual(row[3], "'-Doe");
  assert.strictEqual(row[4], "'+123");
  assert.strictEqual(row[6], "'@mention");
});
test("buildAccessRequestRow: never includes a password field", () => {
  const row = lib.buildAccessRequestRow({ firstName: "Jane", lastName: "Doe", homeAddress: "x", email: "a@b.com", comments: "" });
  assert.ok(!JSON.stringify(row).toLowerCase().includes("password"));
});

console.log("Reply templates and password placeholder");
test("buildTemplate: only 'approved' contains the password placeholder", () => {
  const approved = lib.buildTemplate("approved", { firstName: "Jane" });
  const moreInfo = lib.buildTemplate("more_info", { firstName: "Jane" });
  const unable = lib.buildTemplate("unable_to_verify", { firstName: "Jane" });
  assert.ok(approved.body.includes(lib.PASSWORD_PLACEHOLDER));
  assert.ok(!moreInfo.body.includes(lib.PASSWORD_PLACEHOLDER));
  assert.ok(!unable.body.includes(lib.PASSWORD_PLACEHOLDER));
});
test("buildTemplate: no template ever contains a real-looking secret — only the literal placeholder string", () => {
  for (const t of lib.TEMPLATE_TYPES) {
    const tmpl = lib.buildTemplate(t, { firstName: "Jane" });
    assert.ok(!tmpl.body.includes(FAKE_REAL_PASSWORD));
  }
});
test("buildTemplate: invalid template type returns null", () => {
  assert.strictEqual(lib.buildTemplate("hacked", { firstName: "Jane" }), null);
});
test("insertPassword: replaces the literal placeholder only", () => {
  const body = `before ${lib.PASSWORD_PLACEHOLDER} after`;
  assert.strictEqual(lib.insertPassword(body, "real-pw"), "before real-pw after");
});
test("insertPassword: leaves body unchanged if placeholder was edited out", () => {
  const body = "no placeholder here";
  assert.strictEqual(lib.insertPassword(body, "real-pw"), body);
});

// ── Fake Google Sheets + Gmail transport ────────────────────────────
function createFakeState() {
  return { tabs: new Set(), headers: new Map(), rows: new Map(), requestsSent: [], gmailSent: [], sheetsOutage: false, gmailOutage: false };
}

function decodeRawEmail(raw) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

// "A" -> 0, "B" -> 1, ..., "O" -> 14 (base-26, 1-indexed letters to 0-indexed column).
function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) idx = idx * 26 + (letters.charCodeAt(i) - 64);
  return idx - 1;
}

function installFakeHttps(state) {
  const realRequest = https.request;
  https.request = function fakeRequest(options, callback) {
    const chunks = [];
    const req = {
      write(chunk) { chunks.push(chunk); },
      end() {
        const bodyStr = chunks.join("");
        state.requestsSent.push({ hostname: options.hostname, path: options.path, method: options.method, body: bodyStr });

        if (state.sheetsOutage && options.hostname === "sheets.googleapis.com") {
          setImmediate(() => req._errorHandler && req._errorHandler(new Error("simulated_sheets_outage")));
          return;
        }
        if (state.gmailOutage && options.hostname === "gmail.googleapis.com") {
          setImmediate(() => {
            const res = { statusCode: 500, on(event, cb) { if (event === "data") cb(JSON.stringify({ error: "simulated_gmail_outage" })); if (event === "end") cb(); } };
            callback(res);
          });
          return;
        }

        let status = 200;
        let respBody = "{}";
        try {
          if (options.hostname === "oauth2.googleapis.com" && options.path === "/token") {
            respBody = JSON.stringify({ access_token: "fake-access-token" });
          } else if (options.hostname === "gmail.googleapis.com" && options.path === "/gmail/v1/users/me/messages/send") {
            const parsed = JSON.parse(bodyStr);
            state.gmailSent.push({ raw: parsed.raw, decoded: decodeRawEmail(parsed.raw) });
            respBody = JSON.stringify({ id: "fake-message-id" });
          } else if (options.hostname === "sheets.googleapis.com") {
            const path = options.path;
            if (options.method === "GET" && /^\/v4\/spreadsheets\/[^/]+$/.test(path)) {
              respBody = JSON.stringify({ sheets: [...state.tabs].map((t) => ({ properties: { title: t } })) });
            } else if (options.method === "GET" && path.includes("/values/")) {
              // Ranges here are always "!A1:<lastCol>1" (header-only, used by
              // ensure*Tab's header validation) or "!A:AV"/"!A:O" (full read,
              // used by getSheetData) — distinguish by whether a row number
              // narrower than the sheet appears in the range, and otherwise
              // return header + every seeded/appended data row.
              const range = decodeURIComponent(path.split("/values/")[1]);
              const tab = range.split("!")[0].replace(/^'|'$/g, "");
              const header = state.headers.get(tab);
              const isHeaderOnlyRange = /^[A-Z]+1:[A-Z]+1$/.test(range.split("!")[1] || "");
              const dataRows = state.rows.get(tab) || [];
              respBody = JSON.stringify({
                values: !header ? [] : isHeaderOnlyRange ? [header] : [header, ...dataRows],
              });
            } else if (options.method === "PUT" && path.includes("/values/")) {
              const parsed = JSON.parse(bodyStr);
              const tab = parsed.range.split("!")[0].replace(/^'|'$/g, "");
              const cellRef = parsed.range.split("!")[1] || "";
              if (/^[A-Z]+1$/.test(cellRef)) {
                state.headers.set(tab, parsed.values[0]);
              } else {
                // Single-cell update like "O5" against an existing data
                // row — must actually be applied to state.rows, since
                // later calls in the same test (e.g. a second
                // sendAccessResponse) re-read the row via a full GET and
                // need to see this write, not the original seeded value.
                const m = cellRef.match(/^([A-Z]+)(\d+)$/);
                if (m) {
                  const colIndex = colLettersToIndex(m[1]);
                  const dataRowIndex = parseInt(m[2], 10) - 2; // row 1 = header, row 2 = first data row
                  const rows = state.rows.get(tab);
                  if (rows && rows[dataRowIndex]) rows[dataRowIndex][colIndex] = parsed.values[0][0];
                }
              }
              respBody = "{}";
            } else if (options.method === "POST" && path.endsWith(":batchUpdate")) {
              const parsed = JSON.parse(bodyStr);
              (parsed.requests || []).forEach((r) => { if (r.addSheet) state.tabs.add(r.addSheet.properties.title); });
              respBody = "{}";
            } else if (options.method === "POST" && path.includes(":append")) {
              const rangePart = decodeURIComponent(path.split("/values/")[1].split(":append")[0]);
              const tab = rangePart.split("!")[0].replace(/^'|'$/g, "");
              const parsed = JSON.parse(bodyStr);
              if (!state.rows.has(tab)) state.rows.set(tab, []);
              state.rows.get(tab).push(...parsed.values);
              respBody = "{}";
            } else {
              status = 404;
            }
          } else {
            status = 404;
          }
        } catch (err) {
          status = 500;
          respBody = JSON.stringify({ error: String(err) });
        }

        setImmediate(() => {
          const res = { statusCode: status, on(event, cb) { if (event === "data") cb(respBody); if (event === "end") cb(); } };
          callback(res);
        });
      },
      on(event, cb) { if (event === "error") req._errorHandler = cb; },
    };
    return req;
  };
  return () => { https.request = realRequest; };
}

function freshModules() {
  for (const mod of ["board-api", "lib/access-requests", "resident-access-request"]) {
    delete require.cache[require.resolve(`../netlify/functions/${mod}`)];
  }
  return {
    boardApi: require("../netlify/functions/board-api").handler,
    accessRequest: require("../netlify/functions/resident-access-request").handler,
  };
}

function fakeBoardToken(overrides) {
  const payload = { username: "raja", name: "Raja Ravanan", role: "Secretary", isAdmin: true, exp: Date.now() + 3600000, ...(overrides || {}) };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function boardEvent(action, data, tokenOverride) {
  const token = tokenOverride === undefined ? fakeBoardToken() : tokenOverride;
  return {
    httpMethod: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ action, data }),
  };
}

function publicEvent(body) {
  return { httpMethod: "POST", headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) };
}

const TAB = lib.TAB_NAME;

// Preloads a fake sheet with the tab already created + headered + one
// seeded request row, so board-api tests don't need to go through the
// public submission flow first.
function seedOneRequest(state, overrides) {
  state.tabs.add(TAB);
  state.headers.set(TAB, lib.HEADERS);
  const row = lib.buildAccessRequestRow({ firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com", comments: "Can't log in" });
  Object.assign(row, overrides || {});
  state.rows.set(TAB, [row]);
  return row[0]; // Request ID
}

(async () => {
  console.log("\nresident-access-request.js (public submission endpoint)");

  await step("valid submission: 200 generic message, one sanitized row appended, board notified", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({
        firstName: "Jane", lastName: "=Doe", homeAddress: "123 Lake Rd", email: "jane@example.com", comments: "Forgot my house number", website: "",
      }));
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.ok, true);
      assert.ok(!("id" in body), "public response never echoes internal request id/detail beyond the generic message");

      assert.ok(state.tabs.has(TAB), "tab should have been created");
      assert.deepStrictEqual(state.headers.get(TAB), lib.HEADERS);
      const rows = state.rows.get(TAB) || [];
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0][3], "'=Doe", "leading = neutralized with a forcing apostrophe");
      assert.strictEqual(rows[0][7], "New");

      assert.strictEqual(state.gmailSent.length, 1, "board notification email sent");
      assert.ok(state.gmailSent[0].decoded.includes("jane@example.com"));
    } finally { restore(); }
  });

  await step("missing required fields: 400, nothing written", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "Jane" }));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0);
      assert.strictEqual(state.gmailSent.length, 0);
    } finally { restore(); }
  });

  await step("invalid email: 400, nothing written", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "not-an-email" }));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0);
    } finally { restore(); }
  });

  await step("oversized comments: 400, nothing written", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com", comments: "a".repeat(1001) }));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0);
    } finally { restore(); }
  });

  await step("oversized request body: 400 before JSON parsing", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "a".repeat(5000), lastName: "Doe", homeAddress: "x", email: "a@b.com" }));
      assert.strictEqual(res.statusCode, 400);
    } finally { restore(); }
  });

  await step("malformed JSON: 400, generic error", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent("{not valid json"));
      assert.strictEqual(res.statusCode, 400);
    } finally { restore(); }
  });

  await step("non-POST: 405", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest({ httpMethod: "GET", headers: {}, body: "" });
      assert.strictEqual(res.statusCode, 405);
    } finally { restore(); }
  });

  await step("honeypot filled: 200 generic success, but nothing written and no email sent (bot never learns it was detected)", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "Bot", lastName: "Spam", homeAddress: "x", email: "bot@example.com", website: "http://spam.example" }));
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.ok, true);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0, "honeypot submission is silently dropped, not stored");
      assert.strictEqual(state.gmailSent.length, 0, "no board notification for a honeypot submission");
    } finally { restore(); }
  });

  await step("Sheets outage: 500 generic failure, no partial write, no email attempted", async () => {
    const state = createFakeState();
    state.sheetsOutage = true;
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com" }));
      assert.strictEqual(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.ok(!body.error.toLowerCase().includes("sheets_outage"), "internal error detail never leaks to the caller");
      assert.strictEqual(state.gmailSent.length, 0);
    } finally { restore(); }
  });

  await step("Gmail outage: submission still succeeds (email is best-effort, request already saved)", async () => {
    const state = createFakeState();
    state.gmailOutage = true;
    const restore = installFakeHttps(state);
    try {
      const { accessRequest } = freshModules();
      const res = await accessRequest(publicEvent({ firstName: "Jane", lastName: "Doe", homeAddress: "123 Lake Rd", email: "jane@example.com" }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((state.rows.get(TAB) || []).length, 1, "row still saved even though the notification email failed");
    } finally { restore(); }
  });

  console.log("\nboard-api.js — Portal Access Requests actions");

  await step("unauthenticated request: 401, no network calls at all (fails before touching Sheets)", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const res = await boardApi(boardEvent("getAccessRequests", {}, ""));
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(state.requestsSent.length, 0, "no Sheets/Gmail request should happen before auth succeeds");
    } finally { restore(); }
  });

  await step("expired session token: 401", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const token = fakeBoardToken({ exp: Date.now() - 1000 });
      const res = await boardApi(boardEvent("getAccessRequests", {}, token));
      assert.strictEqual(res.statusCode, 401);
    } finally { restore(); }
  });

  await step("authenticated board member: getAccessRequests returns the seeded request, including internal notes (board-only data)", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const res = await boardApi(boardEvent("getAccessRequests", {}));
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.requests.length, 1);
      assert.strictEqual(body.requests[0]["Request ID"], id);
      assert.strictEqual(body.requests[0]["Status"], "New");
    } finally { restore(); }
  });

  await step("getAccessRequestPreview: invalid template type -> 400", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const res = await boardApi(boardEvent("getAccessRequestPreview", { itemId: id, templateType: "hacked" }));
      assert.strictEqual(res.statusCode, 400);
    } finally { restore(); }
  });

  await step("getAccessRequestPreview: approved template shows the placeholder, never the real password", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const res = await boardApi(boardEvent("getAccessRequestPreview", { itemId: id, templateType: "approved" }));
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.ok(body.body.includes(lib.PASSWORD_PLACEHOLDER));
      assert.ok(!body.body.includes(FAKE_REAL_PASSWORD), "the browser preview must never contain the real password");
      assert.ok(!JSON.stringify(body).includes(FAKE_REAL_PASSWORD));
    } finally { restore(); }
  });

  await step("getAccessRequestPreview: more_info / unable_to_verify never mention the password at all", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      for (const templateType of ["more_info", "unable_to_verify"]) {
        const res = await boardApi(boardEvent("getAccessRequestPreview", { itemId: id, templateType }));
        const body = JSON.parse(res.body);
        assert.ok(!body.body.includes(lib.PASSWORD_PLACEHOLDER));
        assert.ok(!body.body.includes(FAKE_REAL_PASSWORD));
      }
    } finally { restore(); }
  });

  await step("updateAccessRequestStatus: invalid status rejected with no write to the access-requests tab", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const before = state.requestsSent.length;
      const res = await boardApi(boardEvent("updateAccessRequestStatus", { itemId: id, status: "Deleted" }));
      assert.strictEqual(res.statusCode, 400);
      // Every authenticated board-api call unconditionally runs the
      // pre-existing, unrelated ensureSheetTabs() first (creates its own
      // fixed set of tabs if missing) — that's expected background noise,
      // not something this action controls. What matters here is that the
      // rejected status never produces a write to *this* tab/column.
      const putsToAccessRequestsTab = state.requestsSent.slice(before)
        .filter(r => r.method === "PUT" && r.body.includes(`'${TAB}'!H`));
      assert.strictEqual(putsToAccessRequestsTab.length, 0, "an invalid status must never reach a Sheets write for this tab");
    } finally { restore(); }
  });

  await step("updateAccessRequestStatus: valid status accepted", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const res = await boardApi(boardEvent("updateAccessRequestStatus", { itemId: id, status: "Under Review" }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(JSON.parse(res.body).success, true);
    } finally { restore(); }
  });

  await step("addAccessRequestNote: appends a note; empty note rejected; internal notes never touch the password", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const empty = await boardApi(boardEvent("addAccessRequestNote", { itemId: id, note: "  " }));
      assert.strictEqual(empty.statusCode, 400);
      const res = await boardApi(boardEvent("addAccessRequestNote", { itemId: id, note: "Verified via Mulloy roster" }));
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.notes.length, 1);
      assert.strictEqual(body.notes[0].author, "Raja Ravanan");
      assert.ok(!JSON.stringify(body).includes(FAKE_REAL_PASSWORD));
    } finally { restore(); }
  });

  await step("sendAccessResponse (approved): real password reaches ONLY the outgoing Gmail payload — never Sheets writes, activity log, or the JSON returned to the browser", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const preview = lib.buildTemplate("approved", { firstName: "Jane" });
      const res = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: preview.subject, body: preview.body }));
      assert.strictEqual(res.statusCode, 200);
      const respBody = JSON.stringify(JSON.parse(res.body));
      assert.ok(!respBody.includes(FAKE_REAL_PASSWORD), "response to the board browser never contains the real password");

      assert.strictEqual(state.gmailSent.length, 1);
      assert.ok(state.gmailSent[0].decoded.includes(FAKE_REAL_PASSWORD), "the real password must reach the actual outgoing email");
      assert.ok(!state.gmailSent[0].decoded.includes(lib.PASSWORD_PLACEHOLDER), "placeholder was fully replaced, not left alongside the real value");

      const sheetsWrites = state.requestsSent.filter(r => r.hostname === "sheets.googleapis.com" && (r.method === "PUT" || r.method === "POST"));
      for (const w of sheetsWrites) assert.ok(!w.body.includes(FAKE_REAL_PASSWORD), "no Sheets write ever contains the real password");

      // Explicit check on the Activity_Log append specifically (logActivity
      // only ever receives the template LABEL, e.g. "Access Approved", as
      // its details string — never the email body).
      const activityAppends = state.requestsSent.filter(r => r.hostname === "sheets.googleapis.com" && r.method === "POST" && r.path.includes(":append") && r.path.includes("Activity_Log"));
      assert.ok(activityAppends.length >= 1, "an activity log entry should have been written");
      for (const w of activityAppends) assert.ok(!w.body.includes(FAKE_REAL_PASSWORD), "Activity_Log never contains the real password");
    } finally { restore(); }
  });

  await step("sendAccessResponse (more_info): even if the board pastes the literal placeholder into a non-approved template, it is never resolved to the real password", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const bodyWithPlaceholder = `Please reply with more info. ${lib.PASSWORD_PLACEHOLDER}`;
      const res = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "more_info", subject: "More info needed", body: bodyWithPlaceholder }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(state.gmailSent.length, 1);
      assert.ok(state.gmailSent[0].decoded.includes(lib.PASSWORD_PLACEHOLDER), "placeholder text is sent verbatim, unresolved");
      assert.ok(!state.gmailSent[0].decoded.includes(FAKE_REAL_PASSWORD), "non-approved templates never get the real password substituted in, structurally");
    } finally { restore(); }
  });

  await step("sendAccessResponse: send failure is not reported as delivered, and Sent-At/Type/Subject are not written", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    state.gmailOutage = true;
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const preview = lib.buildTemplate("approved", { firstName: "Jane" });
      const res = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: preview.subject, body: preview.body }));
      assert.strictEqual(res.statusCode, 502);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.success, false);

      // Delivery Status (col O) should be written as Failed; Response Sent
      // At (col L) / Type (M) / Subject (N) should NOT be written at all.
      const puts = state.requestsSent.filter(r => r.hostname === "sheets.googleapis.com" && r.method === "PUT");
      const wroteFailed = puts.some(p => { try { return JSON.parse(p.body).range.includes("!O") && JSON.parse(p.body).values[0][0] === lib.DELIVERY_FAILED; } catch { return false; } });
      const wroteSentAt = puts.some(p => { try { return JSON.parse(p.body).range.includes("!L"); } catch { return false; } });
      assert.ok(wroteFailed, "Delivery Status should be recorded as Failed");
      assert.ok(!wroteSentAt, "Response Sent At UTC must not be written on a failed send");
    } finally { restore(); }
  });

  await step("sendAccessResponse: missing subject/body rejected before any send attempt", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const res = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: "", body: "" }));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(state.gmailSent.length, 0);
    } finally { restore(); }
  });

  await step("sendAccessResponse: duplicate-send guard rejects an immediate re-send of the same request (409), sends only once", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const preview = lib.buildTemplate("approved", { firstName: "Jane" });
      const first = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: preview.subject, body: preview.body }));
      assert.strictEqual(first.statusCode, 200);
      assert.strictEqual(state.gmailSent.length, 1);

      const second = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: preview.subject, body: preview.body }));
      assert.strictEqual(second.statusCode, 409, "an immediate second send of the same response should be refused");
      assert.strictEqual(JSON.parse(second.body).success, false);
      assert.strictEqual(state.gmailSent.length, 1, "the duplicate must never actually be sent");
    } finally { restore(); }
  });

  await step("sendAccessResponse: a FAILED send never blocks an immediate retry (guard only triggers after a real success)", async () => {
    const state = createFakeState();
    const id = seedOneRequest(state);
    state.gmailOutage = true;
    const restore = installFakeHttps(state);
    try {
      const { boardApi } = freshModules();
      const preview = lib.buildTemplate("approved", { firstName: "Jane" });
      const failedSend = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: preview.subject, body: preview.body }));
      assert.strictEqual(failedSend.statusCode, 502);

      state.gmailOutage = false; // board fixes the outage and retries right away
      const retry = await boardApi(boardEvent("sendAccessResponse", { itemId: id, templateType: "approved", subject: preview.subject, body: preview.body }));
      assert.strictEqual(retry.statusCode, 200, "a retry immediately after a failed send must be allowed, not blocked as a duplicate");
      assert.strictEqual(state.gmailSent.length, 1, "only the successful attempt actually sent mail");
    } finally { restore(); }
  });

  console.log(`\n${passed} test groups passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("All tests passed.");
  }
})();
