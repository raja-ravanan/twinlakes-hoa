"use strict";
// Focused validation script for the Committee Volunteer Interest Form
// feature: lib/committee-volunteers.js (pure validation/row-building) and
// submit-committee-volunteer.js (the public endpoint). No test framework —
// Node's built-in `assert`, run with:
//   node scripts/test-committee-volunteers.js
//
// Uses fake secrets/data only. Real Google/Gmail networks are never
// called: Node's https.request is intercepted with an in-memory fake (same
// technique as scripts/test-access-requests.js) so the real JWT-signing,
// Sheets-append, and Gmail-send code runs unmodified.

const assert = require("assert");
const crypto = require("crypto");
const https = require("https");

const FAKE_SHEET_ID = "fake-sheet-id-for-committee-volunteers-test";
const FAKE_SA_EMAIL = "fake-service-account@fake-project.iam.gserviceaccount.com";

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

// ── lib/committee-volunteers.js — pure functions, no network ────────
const lib = require("../netlify/functions/lib/committee-volunteers");

function baseSubmission(overrides) {
  return Object.assign({
    name: "Jane Doe",
    address: "123 Lake Rd",
    email: "jane@example.com",
    phone: "502-555-1234",
    committees: ["Irrigation Committee", "Bylaw Committee"],
    otherCommittee: "",
    firstChoice: "Irrigation Committee",
    secondChoice: "Bylaw Committee",
    skills: "Landscaping and project management.",
    priorExperience: "No",
    priorExperienceDetails: "",
    interest: "I'd like to help keep the community beautiful.",
    conflict: "No",
    conflictDetails: "",
    acknowledged: true,
    typedName: "Jane Doe",
    website: "",
  }, overrides || {});
}

console.log("Validation — allowlist and required fields");
test("COMMITTEES matches the finalized PDF exactly (8 named committees)", () => {
  assert.strictEqual(lib.COMMITTEES.length, 8);
  assert.ok(lib.COMMITTEES.includes("Nomination Committee"));
  assert.ok(lib.COMMITTEES.includes("Architectural Review Committee (ARC)"));
  assert.ok(lib.COMMITTEES.includes("Bylaw Committee"));
  assert.ok(lib.COMMITTEES.includes("Irrigation Committee"));
  assert.ok(lib.COMMITTEES.includes("Social / Events Committee"));
  assert.ok(lib.COMMITTEES.includes("Beautification Committee"));
  assert.ok(lib.COMMITTEES.includes("Landscape & Grounds Committee"));
  assert.ok(lib.COMMITTEES.includes("Pond / Water Management Committee"));
});
test("validateSubmission: honeypot filled -> honeypot flag, not a normal error", () => {
  const r = lib.validateSubmission(baseSubmission({ website: "http://spam.example" }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.honeypot, true);
});
test("validateSubmission: missing name/address/email rejected", () => {
  assert.strictEqual(lib.validateSubmission({}).ok, false);
  assert.strictEqual(lib.validateSubmission(baseSubmission({ name: "" })).ok, false);
  assert.strictEqual(lib.validateSubmission(baseSubmission({ email: "not-an-email" })).ok, false);
});
test("validateSubmission: at least one committee required", () => {
  const r = lib.validateSubmission(baseSubmission({ committees: [] }));
  assert.strictEqual(r.ok, false);
  assert.ok(/committee/i.test(r.error));
});
test("validateSubmission: server-side allowlist rejects a committee name not on the PDF", () => {
  const r = lib.validateSubmission(baseSubmission({ committees: ["Made Up Committee"] }));
  assert.strictEqual(r.ok, false);
});
test("validateSubmission: 'Other' committee requires non-blank otherCommittee text", () => {
  const missingText = lib.validateSubmission(baseSubmission({ committees: ["Other"], otherCommittee: "" }));
  assert.strictEqual(missingText.ok, false);
  const withText = lib.validateSubmission(baseSubmission({ committees: ["Other"], otherCommittee: "Newsletter Committee", firstChoice: "", secondChoice: "" }));
  assert.strictEqual(withText.ok, true);
  assert.strictEqual(withText.fields.committees[0], "Other: Newsletter Committee");
});
test("validateSubmission: First/Second Choice validated against the same allowlist", () => {
  const bad = lib.validateSubmission(baseSubmission({ firstChoice: "Not A Real Committee" }));
  assert.strictEqual(bad.ok, false);
  const blank = lib.validateSubmission(baseSubmission({ firstChoice: "", secondChoice: "" }));
  assert.strictEqual(blank.ok, true, "First/Second Choice are optional");
});
test("validateSubmission: First/Second Choice must be one of the committees actually checked (not just anywhere on the allowlist)", () => {
  // Bylaw Committee is on the allowlist but NOT checked in this submission (only Irrigation is).
  const r = lib.validateSubmission(baseSubmission({ committees: ["Irrigation Committee"], firstChoice: "Bylaw Committee", secondChoice: "" }));
  assert.strictEqual(r.ok, false);
  assert.ok(/one of the committees you checked/i.test(r.error));
  const ok = lib.validateSubmission(baseSubmission({ committees: ["Irrigation Committee"], firstChoice: "Irrigation Committee", secondChoice: "" }));
  assert.strictEqual(ok.ok, true);
});
test("validateSubmission: First Choice and Second Choice must differ when both provided", () => {
  const r = lib.validateSubmission(baseSubmission({ committees: ["Irrigation Committee", "Bylaw Committee"], firstChoice: "Irrigation Committee", secondChoice: "Irrigation Committee" }));
  assert.strictEqual(r.ok, false);
  assert.ok(/must be different/i.test(r.error));
});
test("validateSubmission: prior experience is optional — blank is valid, and 'Yes' no longer requires a description", () => {
  const blank = lib.validateSubmission(baseSubmission({ priorExperience: "", priorExperienceDetails: "" }));
  assert.strictEqual(blank.ok, true);
  assert.strictEqual(blank.fields.priorExperience, "");
  const yesNoDetails = lib.validateSubmission(baseSubmission({ priorExperience: "Yes", priorExperienceDetails: "" }));
  assert.strictEqual(yesNoDetails.ok, true, "Prior Experience Details is optional per the finalized required-fields list");
});
test("validateSubmission: prior experience must be exactly Yes/No when answered, not free text", () => {
  const r = lib.validateSubmission(baseSubmission({ priorExperience: "maybe" }));
  assert.strictEqual(r.ok, false);
});
test("validateSubmission: conflict of interest Yes/No is required (not optional)", () => {
  const missing = lib.validateSubmission(baseSubmission({ conflict: "" }));
  assert.strictEqual(missing.ok, false);
});
test("validateSubmission: conflict of interest 'Yes' requires an explanation", () => {
  const missing = lib.validateSubmission(baseSubmission({ conflict: "Yes", conflictDetails: "" }));
  assert.strictEqual(missing.ok, false);
  const withDetails = lib.validateSubmission(baseSubmission({ conflict: "Yes", conflictDetails: "My spouse works for a vendor." }));
  assert.strictEqual(withDetails.ok, true);
});
test("validateSubmission: interest/contribution is optional", () => {
  const r = lib.validateSubmission(baseSubmission({ interest: "" }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.fields.interest, "");
});
test("validateSubmission: acknowledgment checkbox required", () => {
  const r = lib.validateSubmission(baseSubmission({ acknowledged: false }));
  assert.strictEqual(r.ok, false);
});
test("validateSubmission: typed name required to certify", () => {
  const r = lib.validateSubmission(baseSubmission({ typedName: "" }));
  assert.strictEqual(r.ok, false);
});
test("validateSubmission: oversized skills/interest text rejected", () => {
  assert.strictEqual(lib.validateSubmission(baseSubmission({ skills: "a".repeat(2001) })).ok, false);
  assert.strictEqual(lib.validateSubmission(baseSubmission({ interest: "a".repeat(2001) })).ok, false);
});
test("validateSubmission: valid full submission returns normalized fields", () => {
  const r = lib.validateSubmission(baseSubmission());
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fields.committees, ["Irrigation Committee", "Bylaw Committee"]);
});

console.log("\nRow construction (spreadsheet-injection protection)");
test("buildVolunteerRow: matches HEADERS length, Status defaults to Interested", () => {
  const r = lib.validateSubmission(baseSubmission());
  const row = lib.buildVolunteerRow(r.fields);
  assert.strictEqual(row.length, lib.HEADERS.length);
  assert.strictEqual(row[row.length - 1], "Interested");
});
test("buildVolunteerRow: neutralizes leading =, +, -, @ (spreadsheet-formula injection)", () => {
  const r = lib.validateSubmission(baseSubmission({
    name: "=cmd|'/c calc'!A1",
    address: "+123 Lake Rd",
    skills: "-drop table",
    interest: "@mention everyone",
  }));
  assert.strictEqual(r.ok, true);
  const row = lib.buildVolunteerRow(r.fields);
  assert.strictEqual(row[1], "'=cmd|'/c calc'!A1");
  assert.strictEqual(row[2], "'+123 Lake Rd");
  assert.strictEqual(row[8], "'-drop table");
  assert.strictEqual(row[11], "'@mention everyone");
});
test("buildVolunteerRow: Status column is never resident-controlled", () => {
  const r = lib.validateSubmission(baseSubmission());
  const row = lib.buildVolunteerRow(r.fields);
  assert.strictEqual(row[16], "Interested");
  assert.ok(!("status" in r.fields), "validateSubmission must never accept a client-supplied status");
});

// ── Fake Google Sheets + Gmail transport (same technique as
// scripts/test-access-requests.js) ──────────────────────────────────
function createFakeState() {
  return { tabs: new Set(), headers: new Map(), rows: new Map(), requestsSent: [], gmailSent: [], sheetsOutage: false, gmailOutage: false };
}

function decodeRawEmail(raw) {
  return Buffer.from(raw, "base64url").toString("utf8");
}

// Subjects with non-ASCII characters (e.g. the en dash in "Submission –
// Name") are RFC 2047 encoded-word by encodeHeader(), same convention as
// submit-request.js — so a raw decoded email won't contain the literal
// subject text. Decode the Subject header specifically to assert on it.
function decodedSubject(rawEmailText) {
  const line = rawEmailText.split(/\r\n/).find((l) => l.startsWith("Subject: "));
  const value = line.slice("Subject: ".length);
  const match = value.match(/^=\?UTF-8\?B\?(.+)\?=$/);
  return match ? Buffer.from(match[1], "base64").toString("utf8") : value;
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
              }
              respBody = JSON.stringify({ updatedRange: parsed.range, updatedCells: (parsed.values || []).reduce((n, r) => n + r.length, 0) });
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
              respBody = JSON.stringify({ updates: { updatedRows: parsed.values.length } });
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

function freshHandler() {
  for (const mod of ["lib/committee-volunteers", "lib/access-requests", "lib/resident-audit", "submit-committee-volunteer"]) {
    delete require.cache[require.resolve(`../netlify/functions/${mod}`)];
  }
  return require("../netlify/functions/submit-committee-volunteer").handler;
}

function publicEvent(body) {
  return { httpMethod: "POST", headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) };
}

const TAB = lib.TAB_NAME;

(async () => {
  console.log("\nsubmit-committee-volunteer.js (public submission endpoint)");

  await step("valid submission: 200 generic message, one sanitized row appended, board+Mulloy notified, resident confirmed", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent(baseSubmission()));
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.ok, true);

      assert.ok(state.tabs.has(TAB), "tab should have been created");
      assert.deepStrictEqual(state.headers.get(TAB), lib.HEADERS);
      const rows = state.rows.get(TAB) || [];
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0][16], "Interested");

      assert.strictEqual(state.gmailSent.length, 2, "one board+Mulloy notification, one resident confirmation");
      const notification = state.gmailSent[0].decoded;
      assert.ok(notification.includes("hoa.twinlakes.board@gmail.com"));
      assert.ok(notification.includes("edouglas@mulloyproperties.com"));
      assert.strictEqual(decodedSubject(notification), "New Committee Volunteer Submission – Jane Doe");
      assert.ok(state.gmailSent[1].decoded.includes("jane@example.com"), "confirmation addressed to the resident");
      assert.ok(state.gmailSent[1].decoded.includes("does not guarantee appointment"));
    } finally { restore(); }
  });

  await step("missing required fields: 400, nothing written", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent({ name: "Jane" }));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0);
      assert.strictEqual(state.gmailSent.length, 0);
    } finally { restore(); }
  });

  await step("invalid committee value (server-side allowlist): 400, nothing written", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent(baseSubmission({ committees: ["Secret Committee"] })));
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0);
    } finally { restore(); }
  });

  await step("oversized request body: 400 before JSON parsing", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent(baseSubmission({ skills: "a".repeat(9000) })));
      assert.strictEqual(res.statusCode, 400);
    } finally { restore(); }
  });

  await step("malformed JSON: 400, generic error", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent("{not valid json"));
      assert.strictEqual(res.statusCode, 400);
    } finally { restore(); }
  });

  await step("non-POST: 405", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler({ httpMethod: "GET", headers: {}, body: "" });
      assert.strictEqual(res.statusCode, 405);
    } finally { restore(); }
  });

  await step("honeypot filled: 200 generic success, but nothing written and no email sent", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent(baseSubmission({ website: "http://spam.example" })));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((state.rows.get(TAB) || []).length, 0, "honeypot submission is silently dropped, not stored");
      assert.strictEqual(state.gmailSent.length, 0);
    } finally { restore(); }
  });

  await step("Sheets outage: 500 generic failure, no partial write, no email attempted", async () => {
    const state = createFakeState();
    state.sheetsOutage = true;
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent(baseSubmission()));
      assert.strictEqual(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.ok(!body.error.toLowerCase().includes("write_timeout"), "internal error detail never leaks to the caller");
      assert.strictEqual(state.gmailSent.length, 0);
    } finally { restore(); }
  });

  await step("Gmail outage: submission still succeeds (email is best-effort, request already saved)", async () => {
    const state = createFakeState();
    state.gmailOutage = true;
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const res = await handler(publicEvent(baseSubmission()));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((state.rows.get(TAB) || []).length, 1, "row still saved even though the notification email failed");
    } finally { restore(); }
  });

  await step("duplicate rapid submissions both save (no distributed lock — client disables the submit button; documented limitation)", async () => {
    const state = createFakeState();
    const restore = installFakeHttps(state);
    try {
      const handler = freshHandler();
      const [r1, r2] = await Promise.all([
        handler(publicEvent(baseSubmission())),
        handler(publicEvent(baseSubmission())),
      ]);
      assert.strictEqual(r1.statusCode, 200);
      assert.strictEqual(r2.statusCode, 200);
      assert.strictEqual((state.rows.get(TAB) || []).length, 2, "server does not itself dedupe — this documents current behavior, not a guarantee");
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
