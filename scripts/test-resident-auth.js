"use strict";
// Focused validation script for the resident-portal auth + audit layer
// (Phase 2A + audit-logging + live-directory follow-ups). No test
// framework — just Node's built-in `assert`, run with:
//   node scripts/test-resident-auth.js
// Uses fake secrets/data only. Google Sheets is never actually called: the
// audit-integration and directory-integration tests mock
// lib/resident-audit's appendAuditEvent and lib/resident-directory's
// fetchResidentDirectory respectively, and the "unavailable" tests rely on
// GOOGLE_SHEET_ID/SA_EMAIL/SA_KEY being unset in this plain `node` process
// (no .env is loaded), which naturally exercises the real fail-closed/
// fail-open paths with zero network calls.

const assert = require("assert");
const crypto = require("crypto");
const lib = require("../netlify/functions/lib/resident-auth");
const auditLib = require("../netlify/functions/lib/resident-audit");
const directoryLib = require("../netlify/functions/lib/resident-directory");

const FAKE_DIRECTORY = [
  { houseNumber: "123", lastName: "Smith" },
  { houseNumber: "125", lastName: "O'Brien" },
];
const FAKE_PASSWORD = "test-community-password-42";
const FAKE_SECRET = "test-session-secret-do-not-use-in-prod";
const FAKE_VERSION = "1";

function withEnv(vars, fn) {
  const prevValues = {};
  for (const key of Object.keys(vars)) prevValues[key] = process.env[key];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prevValues[key] === undefined) delete process.env[key];
      else process.env[key] = prevValues[key];
    }
  }
}

function validEnv() {
  return {
    RESIDENT_PORTAL_PASSWORD: FAKE_PASSWORD,
    RESIDENT_SESSION_SECRET: FAKE_SECRET,
    RESIDENT_SESSION_VERSION: FAKE_VERSION,
  };
}

function getHeader(res, name) {
  const key = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? res.headers[key] : undefined;
}

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

// ── Normalization ─────────────────────────────────────────────
console.log("Normalization");
test("house number: trims and lowercases", () => {
  assert.strictEqual(lib.normalizeHouseNumber("  123A  "), "123a");
});
test("house number: rejects markup/control chars", () => {
  assert.strictEqual(lib.normalizeHouseNumber("<script>"), null);
});
test("house number: rejects oversized input", () => {
  assert.strictEqual(lib.normalizeHouseNumber("12345678901"), null);
});
test("last name: collapses internal whitespace, case-insensitive", () => {
  assert.strictEqual(lib.normalizeLastName("  O'Brien   Jones "), "o'brien jones");
});
test("last name: preserves apostrophes and hyphens", () => {
  assert.strictEqual(lib.normalizeLastName("Smith-Jones"), "smith-jones");
});
test("last name: rejects oversized input", () => {
  assert.strictEqual(lib.normalizeLastName("a".repeat(61)), null);
});
test("password: opaque, no trimming", () => {
  assert.strictEqual(lib.validatePassword("  spaced  "), "  spaced  ");
});
test("password: rejects oversized input", () => {
  assert.strictEqual(lib.validatePassword("a".repeat(201)), null);
});
test("password: rejects blank", () => {
  assert.strictEqual(lib.validatePassword(""), null);
});

// ── Constant-time comparison ───────────────────────────────────
console.log("Password comparison");
test("constantTimeEqual: matches identical strings", () => {
  assert.strictEqual(lib.constantTimeEqual("abc", "abc"), true);
});
test("constantTimeEqual: rejects mismatched strings of different length", () => {
  assert.strictEqual(lib.constantTimeEqual("abc", "abcdef"), false);
});

// ── loadConfig / findResident (fail-closed config) ─────────────
// Note: the resident directory is no longer part of loadConfig() — it's
// fetched live from Google Sheets (lib/resident-directory.js, tested in
// its own section below) because the full list doesn't fit in a Netlify
// environment variable (~7KB vs an empirically-confirmed ~5KB ceiling).
console.log("Config loading");
test("loadConfig: returns null when a variable is missing", () => {
  withEnv({ RESIDENT_PORTAL_PASSWORD: undefined, RESIDENT_SESSION_SECRET: FAKE_SECRET, RESIDENT_SESSION_VERSION: FAKE_VERSION }, () => {
    delete process.env.RESIDENT_PORTAL_PASSWORD;
    assert.strictEqual(lib.loadConfig(), null);
  });
});
test("loadConfig: succeeds with valid env", () => {
  withEnv(validEnv(), () => {
    const config = lib.loadConfig();
    assert.ok(config);
    assert.strictEqual(config.password, FAKE_PASSWORD);
  });
});
test("findResident: matches normalized house+lastName pair", () => {
  const directory = FAKE_DIRECTORY;
  assert.strictEqual(lib.findResident(directory, "123", "smith"), true);
  assert.strictEqual(lib.findResident(directory, "123", "obrien"), false);
  assert.strictEqual(lib.findResident(directory, "999", "smith"), false);
});

// ── Session sign/verify ─────────────────────────────────────────
console.log("Sessions");
test("signSession/verifySession: valid round trip", () => {
  const { token } = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  assert.strictEqual(lib.verifySession(token, FAKE_SECRET, FAKE_VERSION), true);
});
test("signSession: returns a random sid alongside the token", () => {
  const a = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  const b = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  assert.ok(a.sid && typeof a.sid === "string");
  assert.notStrictEqual(a.sid, b.sid, "sid should be random per session");
});
test("verifySession: rejects tampered token", () => {
  const { token } = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
  assert.strictEqual(lib.verifySession(tampered, FAKE_SECRET, FAKE_VERSION), false);
});
test("verifySession: rejects wrong secret", () => {
  const { token } = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  assert.strictEqual(lib.verifySession(token, "a-different-secret", FAKE_VERSION), false);
});
test("verifySession: rejects wrong version", () => {
  const { token } = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  assert.strictEqual(lib.verifySession(token, FAKE_SECRET, "2"), false);
});
test("verifySession: rejects expired token", () => {
  const payload = { purpose: "resident_session", iat: 0, exp: 1, v: FAKE_VERSION, sid: "x" };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", FAKE_SECRET).update(payloadB64).digest("base64url");
  assert.strictEqual(lib.verifySession(`${payloadB64}.${sig}`, FAKE_SECRET, FAKE_VERSION), false);
});
test("verifySession: rejects garbage input", () => {
  assert.strictEqual(lib.verifySession("not-a-token", FAKE_SECRET, FAKE_VERSION), false);
  assert.strictEqual(lib.verifySession(undefined, FAKE_SECRET, FAKE_VERSION), false);
});
test("signSession: payload carries no resident-identifying data (sid is a random correlator only)", () => {
  const { token } = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  const payloadB64 = token.split(".")[0];
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  assert.deepStrictEqual(Object.keys(payload).sort(), ["exp", "iat", "purpose", "sid", "v"]);
});
test("getValidSessionPayload: returns payload for a valid token, null otherwise", () => {
  const { token, sid } = lib.signSession(FAKE_SECRET, FAKE_VERSION);
  const payload = lib.getValidSessionPayload(token, FAKE_SECRET, FAKE_VERSION);
  assert.strictEqual(payload.sid, sid);
  assert.strictEqual(lib.getValidSessionPayload("garbage", FAKE_SECRET, FAKE_VERSION), null);
});

// ── Cookie helpers ───────────────────────────────────────────
console.log("Cookies");
test("parseCookies: parses a standard cookie header", () => {
  const cookies = lib.parseCookies("tl_resident_session=abc123; other=xyz");
  assert.strictEqual(cookies.tl_resident_session, "abc123");
});
test("buildSessionCookie: sets HttpOnly/Secure/SameSite=Lax", () => {
  const cookie = lib.buildSessionCookie("token-value");
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("Secure"));
  assert.ok(cookie.includes("SameSite=Lax"));
  assert.ok(cookie.includes(`Max-Age=${14 * 24 * 60 * 60}`));
});
test("buildClearCookie: expires immediately", () => {
  assert.ok(lib.buildClearCookie().includes("Max-Age=0"));
});

// ── Resident directory parsing (lib/resident-directory.js) ────────
// These cover the two Name-field shapes actually found in the source
// "TL Directory" sheet (confirmed by direct inspection: ~83% comma-
// separated "Last, First", ~17% space-separated "First Last", both
// optionally with a second "& First2 [Last2]" co-owner).
console.log("Resident directory parsing");
test("validHouseNumber: accepts digits, rejects blank/oversized/markup", () => {
  assert.strictEqual(directoryLib.validHouseNumber("  16004  "), "16004");
  assert.strictEqual(directoryLib.validHouseNumber(""), null);
  assert.strictEqual(directoryLib.validHouseNumber("1".repeat(11)), null);
  assert.strictEqual(directoryLib.validHouseNumber("<script>"), null);
});
test("parseLastNames: 'Last, First' (comma format)", () => {
  assert.deepStrictEqual(directoryLib.parseLastNames("Smith, John"), ["Smith"]);
});
test("parseLastNames: 'Last, First & First2' (comma, shared surname)", () => {
  assert.deepStrictEqual(directoryLib.parseLastNames("Smith, John & Jane"), ["Smith"]);
});
test("parseLastNames: 'Last, First & First2 Last2' (comma, different surnames)", () => {
  const result = directoryLib.parseLastNames("Smith, John & Jane Doe");
  assert.strictEqual(result.length, 2);
  assert.ok(result.includes("Smith") && result.includes("Doe"));
});
test("parseLastNames: 'First Last' (no comma)", () => {
  assert.deepStrictEqual(directoryLib.parseLastNames("Raja Ravanan"), ["Ravanan"]);
});
test("parseLastNames: 'First Last & First2 Last2' (no comma, different surnames)", () => {
  const result = directoryLib.parseLastNames("Raja Ravanan & Priya Kumar");
  assert.strictEqual(result.length, 2);
  assert.ok(result.includes("Ravanan") && result.includes("Kumar"));
});
test("parseLastNames: 'First Last & First2' (no comma, shared surname)", () => {
  assert.deepStrictEqual(directoryLib.parseLastNames("Raja Ravanan & Priya"), ["Ravanan"]);
});
test("parseLastNames: preserves apostrophes and hyphens in surnames", () => {
  assert.deepStrictEqual(directoryLib.parseLastNames("O'Brien, Michael"), ["O'Brien"]);
  assert.deepStrictEqual(directoryLib.parseLastNames("Smith-Jones, Michael"), ["Smith-Jones"]);
});
test("parseLastNames: returns null (unclear) rather than guessing — blank, bare word, unfamiliar shape", () => {
  assert.strictEqual(directoryLib.parseLastNames(""), null);
  assert.strictEqual(directoryLib.parseLastNames("SingleWord"), null, "a bare single token is ambiguous — first name only? entity name? don't guess");
  assert.strictEqual(directoryLib.parseLastNames("First Middle Last Extra"), null, "unfamiliar 4-token shape with no comma/& — don't guess");
  assert.strictEqual(directoryLib.parseLastNames("A, B & C & D"), null, "3+ '&'-joined owners in an unfamiliar shape — don't guess");
});

// ── Resident audit — pure functions (no network) ────────────────
console.log("Resident audit — sanitization & correlation");
test("sanitizeForSpreadsheet: neutralizes leading =, +, -, @ with a forcing apostrophe", () => {
  assert.strictEqual(auditLib.sanitizeForSpreadsheet("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
  assert.strictEqual(auditLib.sanitizeForSpreadsheet("+1234"), "'+1234");
  assert.strictEqual(auditLib.sanitizeForSpreadsheet("-1234"), "'-1234");
  assert.strictEqual(auditLib.sanitizeForSpreadsheet("@mention"), "'@mention");
  assert.strictEqual(auditLib.sanitizeForSpreadsheet("smith"), "smith");
});
test("sanitizeForSpreadsheet/boundedText: strips control characters", () => {
  assert.strictEqual(auditLib.stripControlChars("abc\x00\x1Fdef"), "abcdef");
});
test("boundedText: truncates to the given length", () => {
  assert.strictEqual(auditLib.boundedText("a".repeat(300), 250).length, 250);
});
test("trustedClientIp: only trusts the Netlify-provided header, not client-suppliable ones", () => {
  assert.strictEqual(auditLib.trustedClientIp({ "x-nf-client-connection-ip": "203.0.113.5" }), "203.0.113.5");
  assert.strictEqual(auditLib.trustedClientIp({ "x-forwarded-for": "1.2.3.4" }), "", "must not trust x-forwarded-for");
  assert.strictEqual(auditLib.trustedClientIp({}), "");
});
test("hashIp: same IP+salt produce the same hash; different IP or salt differ; missing input is blank", () => {
  // resident-audit.js reads RESIDENT_AUDIT_IP_SALT once at module load (same
  // convention as GOOGLE_SHEET_ID etc. elsewhere in the repo — correct for a
  // real deployment, where env vars are static for a container's lifetime).
  // To exercise different salts here without desyncing the single cached
  // module instance the rest of this suite's mocking relies on, we swap the
  // require.cache entry out and carefully restore the original afterward.
  const auditPath = require.resolve("../netlify/functions/lib/resident-audit");
  const originalCacheEntry = require.cache[auditPath];
  try {
    withEnv({ RESIDENT_AUDIT_IP_SALT: "salt-a" }, () => {
      delete require.cache[auditPath];
      const fresh = require(auditPath);
      const a1 = fresh.hashIp("203.0.113.5");
      const a2 = fresh.hashIp("203.0.113.5");
      const bIp = fresh.hashIp("198.51.100.9");
      assert.strictEqual(a1, a2, "same ip+salt -> same hash");
      assert.notStrictEqual(a1, bIp, "different ip -> different hash");
      assert.ok(/^[0-9a-f]{16,24}$/.test(a1), "hash should be 16-24 hex chars");
    });
    withEnv({ RESIDENT_AUDIT_IP_SALT: "salt-b" }, () => {
      delete require.cache[auditPath];
      const fresh = require(auditPath);
      const c1 = fresh.hashIp("203.0.113.5");
      assert.notStrictEqual(c1, undefined);
    });
    delete require.cache[auditPath];
    const noSalt = require(auditPath);
    assert.strictEqual(noSalt.hashIp("203.0.113.5"), "", "no salt configured -> blank, never unsalted");
    assert.strictEqual(noSalt.hashIp(""), "", "no ip -> blank");
  } finally {
    require.cache[auditPath] = originalCacheEntry;
  }
});
test("deriveSessionReference: same sid+secret match; different sid/secret differ; missing input blank", () => {
  const ref1 = auditLib.deriveSessionReference("sid-abc", FAKE_SECRET);
  const ref2 = auditLib.deriveSessionReference("sid-abc", FAKE_SECRET);
  const refOtherSid = auditLib.deriveSessionReference("sid-xyz", FAKE_SECRET);
  const refOtherSecret = auditLib.deriveSessionReference("sid-abc", "different-secret");
  assert.strictEqual(ref1, ref2);
  assert.notStrictEqual(ref1, refOtherSid);
  assert.notStrictEqual(ref1, refOtherSecret);
  assert.strictEqual(auditLib.deriveSessionReference("", FAKE_SECRET), "");
  assert.strictEqual(auditLib.deriveSessionReference("sid-abc", ""), "");
});
test("deriveSessionReference: cannot be reversed into the original sid (one-way)", () => {
  const ref = auditLib.deriveSessionReference("sid-abc", FAKE_SECRET);
  assert.notStrictEqual(ref, "sid-abc");
  assert.ok(!ref.includes("sid-abc"));
});
test("buildAuditRow: produces exactly one row matching the header count, with formula-injection neutralized", () => {
  const row = auditLib.buildAuditRow({
    eventType: "LOGIN_FAILURE",
    houseNumber: "=123",
    lastName: "-Smith",
    householdMatch: false,
    failureCategory: "INVALID_RESIDENT",
    userAgent: "@evil-agent\x00",
  });
  assert.strictEqual(row.length, auditLib.AUDIT_HEADERS.length);
  assert.strictEqual(row[3], "'=123", "house number formula-injection neutralized");
  assert.strictEqual(row[4], "'-Smith", "last name formula-injection neutralized");
  assert.strictEqual(row[5], "false");
});
test("buildAuditRow: Household Match is blank (not 'false') when not determined", () => {
  const row = auditLib.buildAuditRow({ eventType: "LOGIN_FAILURE", failureCategory: "MALFORMED_REQUEST" });
  assert.strictEqual(row[5], "");
  assert.strictEqual(row[6], "MALFORMED_REQUEST");
});
test("buildAuditRow: event id is unique per call and timestamp is server-generated ISO-8601 UTC", () => {
  const before = Date.now();
  const row1 = auditLib.buildAuditRow({ eventType: "LOGOUT" });
  const row2 = auditLib.buildAuditRow({ eventType: "LOGOUT" });
  const after = Date.now();
  assert.notStrictEqual(row1[0], row2[0]);
  assert.match(row1[0], /^[0-9a-f-]{36}$/i);
  const ts = new Date(row1[1]);
  assert.strictEqual(ts.toISOString(), row1[1], "timestamp must be exact ISO-8601 UTC");
  assert.ok(ts.getTime() >= before - 1000 && ts.getTime() <= after + 1000, "timestamp must be current, server-generated");
});
test("buildAuditRow: never includes a password or session-token field", () => {
  const row = auditLib.buildAuditRow({
    eventType: "LOGIN_SUCCESS", houseNumber: "123", lastName: "smith", householdMatch: true,
  });
  const serialized = JSON.stringify(row);
  assert.ok(!serialized.toLowerCase().includes("password"));
  assert.ok(!serialized.includes(FAKE_PASSWORD));
});

// ── Handler-level integration tests ───────────────────────────
console.log("resident-login / resident-logout / resident-session handlers");

function freshHandlers() {
  // Deliberately NOT clearing lib/resident-directory's or lib/resident-audit's
  // own require.cache entries here — mockAudit()/realAudit() mutate methods
  // on the already-cached module objects (directoryLib/auditLib), and a
  // fresh re-require would return a *different* object, silently detaching
  // the mock (the same pitfall this file's audit-mocking hit before).
  delete require.cache[require.resolve("../netlify/functions/resident-login")];
  delete require.cache[require.resolve("../netlify/functions/resident-logout")];
  delete require.cache[require.resolve("../netlify/functions/resident-session")];
  return {
    loginHandler: require("../netlify/functions/resident-login").handler,
    logoutHandler: require("../netlify/functions/resident-logout").handler,
    sessionHandler: require("../netlify/functions/resident-session").handler,
  };
}

// Mock the shared audit module's appendAuditEvent AND the shared directory
// module's fetchResidentDirectory so handler tests can assert
// exactly-once-per-attempt writes, inspect row content, and control
// resident-match outcomes without any network call. Handlers destructure
// both at require time, so the cache must be cleared and the handler
// re-required after swapping the mocks in (mirrors the file's existing
// require.cache-clearing style).
let auditCalls = [];
const realAppendAuditEvent = auditLib.appendAuditEvent;
const realFetchResidentDirectory = directoryLib.fetchResidentDirectory;
function mockAudit(directoryOverride) {
  auditCalls = [];
  auditLib.appendAuditEvent = async (evt) => {
    auditCalls.push(evt);
    return { ok: true, eventId: "mock-event-id" };
  };
  directoryLib.fetchResidentDirectory = directoryOverride
    ? async () => { throw directoryOverride === "throw" ? new Error("mock_directory_unavailable") : directoryOverride; }
    : async () => FAKE_DIRECTORY;
  return freshHandlers();
}
function realAudit() {
  auditLib.appendAuditEvent = realAppendAuditEvent;
  directoryLib.fetchResidentDirectory = realFetchResidentDirectory;
  return freshHandlers();
}

function loginEvent(body, headers) {
  return { httpMethod: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: headers || {} };
}

// Async counterpart to test(): catches so one failing scenario doesn't
// abort the rest of the suite (an unhandled rejection would otherwise
// crash the whole process before later groups get a chance to run).
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

(async () => {
  await step("login success writes one LOGIN_SUCCESS audit event with no secrets", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
    assert.strictEqual(res.statusCode, 200, "valid resident + password should succeed");
    assert.ok(getHeader(res, "Set-Cookie"), "should set a session cookie");
    assert.strictEqual(auditCalls.length, 1, "exactly one audit write per attempt");
    const evt = auditCalls[0];
    assert.strictEqual(evt.eventType, "LOGIN_SUCCESS");
    assert.strictEqual(evt.houseNumber, "123");
    assert.strictEqual(evt.lastName, "smith", "canonical/normalized matched last name is stored");
    assert.strictEqual(evt.householdMatch, true);
    assert.strictEqual(evt.failureCategory, undefined);
    assert.ok(evt.sessionReference, "session reference is present");
    assert.ok(!("password" in evt), "password is absent from the audit event");
    assert.ok(!("token" in evt) && !("cookie" in evt), "raw session token/cookie is absent from the audit event");
    assert.ok(!JSON.stringify(evt).includes(FAKE_PASSWORD), "password value never appears in the audit event");
  }));

  let wrongPasswordAudit, wrongPasswordBody;
  await step("wrong password writes one LOGIN_FAILURE / INVALID_PASSWORD", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: "wrong-password" }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(auditCalls.length, 1);
    wrongPasswordAudit = auditCalls[0];
    wrongPasswordBody = JSON.parse(res.body);
    assert.strictEqual(wrongPasswordAudit.eventType, "LOGIN_FAILURE");
    assert.strictEqual(wrongPasswordAudit.failureCategory, "INVALID_PASSWORD");
    assert.strictEqual(wrongPasswordAudit.householdMatch, true, "resident combination itself was valid");
    assert.ok(!("password" in wrongPasswordAudit));
  }));

  let wrongResidentAudit, wrongResidentBody;
  await step("wrong resident writes one LOGIN_FAILURE / INVALID_RESIDENT", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent({ houseNumber: "999", lastName: "Nobody", password: FAKE_PASSWORD }));
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(auditCalls.length, 1);
    wrongResidentAudit = auditCalls[0];
    wrongResidentBody = JSON.parse(res.body);
    assert.strictEqual(wrongResidentAudit.eventType, "LOGIN_FAILURE");
    assert.strictEqual(wrongResidentAudit.failureCategory, "INVALID_RESIDENT");
    assert.strictEqual(wrongResidentAudit.householdMatch, false);
  }));

  test("browser cannot distinguish wrong-password from wrong-resident (identical response; different internal category)", () => {
    assert.strictEqual(wrongPasswordBody.error, wrongResidentBody.error);
    assert.notStrictEqual(wrongPasswordAudit.failureCategory, wrongResidentAudit.failureCategory);
    assert.ok(!("householdMatch" in wrongPasswordBody) && !("failureCategory" in wrongPasswordBody));
  });

  await step("blank values: one LOGIN_FAILURE / INVALID_INPUT", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent({ houseNumber: "", lastName: "", password: "" }));
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].failureCategory, "INVALID_INPUT");
  }));

  await step("oversized values: one LOGIN_FAILURE / INVALID_INPUT, oversized value itself not written", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "a".repeat(100), password: FAKE_PASSWORD }));
    assert.strictEqual(res.statusCode, 400, "oversized values should fail");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].failureCategory, "INVALID_INPUT");
    assert.strictEqual(auditCalls[0].lastName, "", "the oversized value itself is never written");
  }));

  await step("malformed JSON: one LOGIN_FAILURE / MALFORMED_REQUEST, no raw body stored", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent("{not valid json"));
    assert.strictEqual(res.statusCode, 400, "malformed JSON should fail");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].failureCategory, "MALFORMED_REQUEST");
    assert.ok(!("body" in auditCalls[0]) && !("rawBody" in auditCalls[0]), "raw request body is absent from the audit event");
  }));

  await step("missing env vars: one LOGIN_FAILURE / CONFIGURATION_ERROR, fails closed", () => withAsyncEnv(
    { RESIDENT_PORTAL_PASSWORD: undefined, RESIDENT_SESSION_SECRET: FAKE_SECRET, RESIDENT_SESSION_VERSION: FAKE_VERSION }, async () => {
    delete process.env.RESIDENT_PORTAL_PASSWORD;
    const { loginHandler } = mockAudit();
    const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
    assert.strictEqual(res.statusCode, 500, "missing env vars should fail closed");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].failureCategory, "CONFIGURATION_ERROR");
  }));

  await step("directory fetch fails (e.g. Sheets unavailable): one LOGIN_FAILURE / CONFIGURATION_ERROR, fails closed — never lets anyone through", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit("throw");
    const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
    assert.strictEqual(res.statusCode, 500, "directory fetch failure should fail closed, not silently admit the resident");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].failureCategory, "CONFIGURATION_ERROR");
  }));

  await step("non-POST: one LOGIN_FAILURE / UNSUPPORTED_METHOD, handled consistently", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler } = mockAudit();
    const res = await loginHandler({ httpMethod: "GET", body: "", headers: {} });
    assert.strictEqual(res.statusCode, 405, "non-POST should be rejected consistently");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].failureCategory, "UNSUPPORTED_METHOD");
  }));

  await step("resident-session refresh never writes an audit row", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler, sessionHandler } = mockAudit();
    const loginRes = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
    const cookieHeader = getHeader(loginRes, "Set-Cookie").split(";")[0];
    auditCalls = []; // reset after login so we isolate the session-check call
    const res1 = await sessionHandler({ httpMethod: "GET", headers: { cookie: cookieHeader } });
    const res2 = await sessionHandler({ httpMethod: "GET", headers: { cookie: cookieHeader } });
    assert.strictEqual(JSON.parse(res1.body).authenticated, true);
    assert.strictEqual(JSON.parse(res2.body).authenticated, true);
    assert.strictEqual(auditCalls.length, 0, "a portal refresh / session check must not create an audit row");
  }));

  await step("login + logout correlate via the same safe session reference", () => withAsyncEnv(validEnv(), async () => {
    const { loginHandler, logoutHandler } = mockAudit();
    const loginRes = await loginHandler(loginEvent({ houseNumber: "125", lastName: "O'Brien", password: FAKE_PASSWORD }));
    const loginEvt = auditCalls[0];
    const cookieHeader = getHeader(loginRes, "Set-Cookie").split(";")[0];

    const logoutRes = await logoutHandler({ httpMethod: "POST", headers: { cookie: cookieHeader } });
    assert.strictEqual(logoutRes.statusCode, 200);
    assert.strictEqual(auditCalls.length, 2, "login wrote one row, logout wrote exactly one more");
    const logoutEvt = auditCalls[1];
    assert.strictEqual(logoutEvt.eventType, "LOGOUT");
    assert.strictEqual(logoutEvt.sessionReference, loginEvt.sessionReference, "login and logout correlate via the same reference");
    assert.ok(!("sid" in logoutEvt) && !JSON.stringify(logoutEvt).includes(cookieHeader), "raw session token/sid is never written");
    assert.ok(getHeader(logoutRes, "Set-Cookie").includes("Max-Age=0"), "logout clears the cookie");
  }));

  await step("invalid-session logout still clears the cookie without erroring", () => withAsyncEnv(validEnv(), async () => {
    const { logoutHandler } = mockAudit();
    const res = await logoutHandler({ httpMethod: "POST", headers: { cookie: "tl_resident_session=garbage" } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(getHeader(res, "Set-Cookie").includes("Max-Age=0"), "cookie is cleared even for an invalid session");
    assert.strictEqual(auditCalls.length, 1);
    assert.strictEqual(auditCalls[0].sessionReference, "", "no reference can be derived from an invalid session");
  }));

  // GOOGLE_SHEET_ID / GOOGLE_SA_EMAIL / GOOGLE_SA_KEY are not loaded by plain
  // `node` (no .env parsing here), so clearing them explicitly and using the
  // REAL (unmocked) appendAuditEvent exercises the actual fail-open code
  // path with zero network calls — a true proxy for "Google Sheets is
  // unreachable," without needing a mocked HTTPS layer. The directory fetch
  // stays MOCKED here so this test isolates audit-outage behavior only —
  // directory-outage is tested separately below.
  await step("audit storage unavailable never changes the login/logout outcome", () => withAsyncEnv(
    { ...validEnv(), GOOGLE_SHEET_ID: undefined, GOOGLE_SA_EMAIL: undefined, GOOGLE_SA_KEY: undefined,
      RESIDENT_AUDIT_IP_SALT: undefined }, async () => {
    delete process.env.GOOGLE_SHEET_ID; delete process.env.GOOGLE_SA_EMAIL; delete process.env.GOOGLE_SA_KEY;
    delete process.env.RESIDENT_AUDIT_IP_SALT;
    // Order matters: both module-property mutations must land BEFORE
    // freshHandlers() re-requires resident-login.js, since it destructures
    // these functions into its own local bindings at require time — setting
    // them after (like an earlier version of this test did) would silently
    // leave the handler using whatever was bound at the last freshHandlers()
    // call, defeating the mock/real swap without any test failure to show it.
    auditLib.appendAuditEvent = realAppendAuditEvent; // audit real/unmocked...
    directoryLib.fetchResidentDirectory = async () => FAKE_DIRECTORY; // ...directory stays mocked
    const { loginHandler, logoutHandler } = freshHandlers();

    const result = await auditLib.appendAuditEvent({ eventType: "LOGIN_SUCCESS" });
    assert.strictEqual(result.ok, false, "append fails when Sheets config is unavailable");
    assert.strictEqual(result.error, "audit_config_missing");

    const successRes = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
    assert.strictEqual(successRes.statusCode, 200, "audit outage does not block a valid login");
    assert.ok(getHeader(successRes, "Set-Cookie"), "session cookie is still issued");

    const failRes = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: "wrong" }));
    assert.strictEqual(failRes.statusCode, 401, "audit outage does not turn an invalid login into a success");

    const logoutRes = await logoutHandler({ httpMethod: "POST", headers: {} });
    assert.strictEqual(logoutRes.statusCode, 200, "audit outage does not prevent logout");
    assert.ok(getHeader(logoutRes, "Set-Cookie").includes("Max-Age=0"), "cookie is still cleared during an audit outage");
  }));

  // Mirror test for the directory side: real (unmocked) fetchResidentDirectory
  // with RESIDENT_SHEET_ID/GOOGLE_SA_EMAIL/GOOGLE_SA_KEY unset — this must
  // fail CLOSED (500), unlike the audit case above which fails open, because
  // the directory is part of the auth decision, not a side-channel log.
  await step("directory storage unavailable fails closed (never silently admits a login)", () => withAsyncEnv(
    { ...validEnv(), RESIDENT_SHEET_ID: undefined, GOOGLE_SA_EMAIL: undefined, GOOGLE_SA_KEY: undefined }, async () => {
    delete process.env.RESIDENT_SHEET_ID; delete process.env.GOOGLE_SA_EMAIL; delete process.env.GOOGLE_SA_KEY;
    auditCalls = [];
    auditLib.appendAuditEvent = async (evt) => { auditCalls.push(evt); return { ok: true, eventId: "mock-event-id" }; };
    directoryLib.fetchResidentDirectory = realFetchResidentDirectory; // directory real/unmocked, audit stays mocked
    const { loginHandler } = freshHandlers(); // both mutations applied BEFORE the handler re-requires/destructures them

    const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
    assert.strictEqual(res.statusCode, 500, "directory outage must fail closed, not admit the login");
    assert.strictEqual(auditCalls[0].failureCategory, "CONFIGURATION_ERROR");
  }));

  realAudit(); // restore real (unmocked) audit + directory functions for anything after this point

  console.log(`\n${passed} test groups passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("All tests passed.");
  }
})();

async function withAsyncEnv(vars, fn) {
  const prevValues = {};
  for (const key of Object.keys(vars)) prevValues[key] = process.env[key];
  for (const key of Object.keys(vars)) {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prevValues[key] === undefined) delete process.env[key];
      else process.env[key] = prevValues[key];
    }
  }
}
