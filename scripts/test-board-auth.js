"use strict";
// Board Portal session/cookie/login validation. No framework — Node's
// built-in assert, run with:
//   node scripts/test-board-auth.js
// Uses fake secrets only and makes no network calls: every function under
// test is pure, so Google Sheets and Gmail are never involved.

const assert = require("assert");
const crypto = require("crypto");
const auth = require("../netlify/functions/lib/board-auth");
const members = require("../netlify/functions/lib/board-members");
const timing = require("../netlify/functions/lib/timing");

const SECRET = "test-board-secret-do-not-use-in-prod";
const OTHER_SECRET = "a-different-test-secret";
const VERSION = "1";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.log(`  FAIL- ${name}\n        ${e.message}`); }
}

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); }
  finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

function tamper(token, mutate) {
  const [payloadB64, sig] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  mutate(payload);
  const newPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${newPayload}.${sig}`;   // signature deliberately left stale
}

function eventWithCookie(token, extra) {
  return {
    headers: {
      cookie: token ? `${auth.COOKIE_NAME}=${encodeURIComponent(token)}` : "",
      host: "example.test",
      origin: "https://example.test",
      "x-board-request": "1",
      ...(extra || {}),
    },
  };
}

console.log("\nBoard session — signing and verification");

// 1. Valid signed session
test("valid signed session verifies and returns the payload", () => {
  const token = auth.signSession(SECRET, VERSION, "raja");
  const payload = auth.decodeAndVerifySession(token, SECRET, VERSION);
  assert.ok(payload, "expected a payload");
  assert.strictEqual(payload.sub, "raja");
  assert.strictEqual(payload.purpose, "board-session");
});

// 3. Payload shape — no privilege claim may travel on the wire
test("payload contains ONLY purpose, v, sub, iat, exp", () => {
  const token = auth.signSession(SECRET, VERSION, "raja");
  const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.deepStrictEqual(Object.keys(payload).sort(), ["exp", "iat", "purpose", "sub", "v"]);
  for (const forbidden of ["role", "access", "isAdmin", "permissions", "name", "displayTitle"]) {
    assert.ok(!(forbidden in payload), `payload must not carry "${forbidden}"`);
  }
});

// 2. Tampered username
test("tampered username is rejected", () => {
  const token = auth.signSession(SECRET, VERSION, "mike");
  const forged = tamper(token, p => { p.sub = "raja"; });
  assert.strictEqual(auth.decodeAndVerifySession(forged, SECRET, VERSION), null);
});

// 3b. Tampered privilege — the old attack, now structurally impossible
test("injecting isAdmin into the payload is rejected", () => {
  const token = auth.signSession(SECRET, VERSION, "mike");
  const forged = tamper(token, p => { p.isAdmin = true; p.access = "admin"; });
  assert.strictEqual(auth.decodeAndVerifySession(forged, SECRET, VERSION), null);
});

// 4. Tampered expiry
test("extended expiry is rejected", () => {
  const token = auth.signSession(SECRET, VERSION, "raja");
  const forged = tamper(token, p => { p.exp = p.exp + 86400 * 365; });
  assert.strictEqual(auth.decodeAndVerifySession(forged, SECRET, VERSION), null);
});

// 5. Wrong signing secret
test("token signed with a different secret is rejected", () => {
  const token = auth.signSession(OTHER_SECRET, VERSION, "raja");
  assert.strictEqual(auth.decodeAndVerifySession(token, SECRET, VERSION), null);
});

// 6. Expired session
test("expired session is rejected", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  const payload = { purpose: "board-session", v: VERSION, sub: "raja", iat: past - 100, exp: past };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(b64).digest("base64url");
  assert.strictEqual(auth.decodeAndVerifySession(`${b64}.${sig}`, SECRET, VERSION), null);
});

// 7. Wrong purpose (e.g. a resident-portal token replayed here)
test("wrong session purpose is rejected", () => {
  const payload = { purpose: "resident-session", v: VERSION, sub: "raja",
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(b64).digest("base64url");
  assert.strictEqual(auth.decodeAndVerifySession(`${b64}.${sig}`, SECRET, VERSION), null);
});

// 8. Wrong session version — the global logout lever
test("wrong session version is rejected", () => {
  const token = auth.signSession(SECRET, "1", "raja");
  assert.strictEqual(auth.decodeAndVerifySession(token, SECRET, "2"), null);
});

// 9. Malformed input
test("malformed tokens are rejected", () => {
  const bad = ["", ".", "a.b.c", "not-base64!!", "onlyonepart", null, undefined, 42, {},
    Buffer.from("not json").toString("base64url") + ".sig"];
  for (const t of bad) {
    assert.strictEqual(auth.decodeAndVerifySession(t, SECRET, VERSION), null, `should reject ${JSON.stringify(t)}`);
  }
});

// 10. Legacy unsigned token — the exact format the old portal issued
test("legacy unsigned board token is rejected", () => {
  const legacy = Buffer.from(JSON.stringify({
    username: "raja", name: "Raja Ravanan", role: "Secretary",
    isAdmin: true, exp: Date.now() + 8 * 60 * 60 * 1000,
  })).toString("base64");
  assert.strictEqual(auth.decodeAndVerifySession(legacy, SECRET, VERSION), null);
  assert.ok(!legacy.includes("."), "legacy tokens contain no dot, so they fail the shape check first");
});

console.log("\nSession context — roster resolution");

test("valid session resolves to a live member context", () => {
  withEnv({ BOARD_SESSION_SECRET: SECRET, BOARD_SESSION_VERSION: VERSION }, () => {
    const token = auth.signSession(SECRET, VERSION, "tony");
    const ctx = auth.getSessionContext(eventWithCookie(token));
    assert.ok(ctx);
    assert.strictEqual(ctx.username, "tony");
    assert.strictEqual(ctx.access, "officer");
    assert.strictEqual(ctx.displayTitle, "President");
  });
});

// Ramana resigned: a perfectly valid signature naming him is still not a session.
test("session naming a resigned member is rejected", () => {
  withEnv({ BOARD_SESSION_SECRET: SECRET, BOARD_SESSION_VERSION: VERSION }, () => {
    const token = auth.signSession(SECRET, VERSION, "ramana");
    assert.strictEqual(auth.decodeAndVerifySession(token, SECRET, VERSION).sub, "ramana",
      "signature itself is valid");
    assert.strictEqual(auth.getSessionContext(eventWithCookie(token)), null,
      "but it must not resolve to a session");
  });
});

test("session naming an unknown member is rejected", () => {
  withEnv({ BOARD_SESSION_SECRET: SECRET, BOARD_SESSION_VERSION: VERSION }, () => {
    const token = auth.signSession(SECRET, VERSION, "ghost");
    assert.strictEqual(auth.getSessionContext(eventWithCookie(token)), null);
  });
});

test("missing session config fails closed", () => {
  withEnv({ BOARD_SESSION_SECRET: undefined, BOARD_SESSION_VERSION: undefined }, () => {
    delete process.env.BOARD_SESSION_SECRET;
    delete process.env.BOARD_SESSION_VERSION;
    assert.strictEqual(auth.loadConfig(), null);
    const token = auth.signSession(SECRET, VERSION, "raja");
    assert.strictEqual(auth.getSessionContext(eventWithCookie(token)), null);
  });
});

console.log("\nCookie attributes");

// 11. Cookie security attributes
test("session cookie is HttpOnly, Secure, SameSite=Strict, Path=/, 8h", () => {
  const cookie = auth.buildSessionCookie("token-value");
  assert.ok(/HttpOnly/.test(cookie), "HttpOnly");
  assert.ok(/Secure/.test(cookie), "Secure");
  assert.ok(/SameSite=Strict/.test(cookie), "SameSite=Strict");
  assert.ok(/Path=\//.test(cookie), "Path=/");
  assert.ok(/Max-Age=28800/.test(cookie), "8 hour lifetime");
});

// 12. Logout invalidation
test("clearing cookie empties the value and expires it with the same attributes", () => {
  const cookie = auth.clearSessionCookie();
  assert.ok(/Max-Age=0/.test(cookie), "Max-Age=0");
  assert.ok(new RegExp(`^${auth.COOKIE_NAME}=;`).test(cookie), "value emptied");
  assert.ok(/HttpOnly/.test(cookie) && /Secure/.test(cookie) && /SameSite=Strict/.test(cookie),
    "attributes must match the set cookie or the browser will not replace it");
});

test("logout endpoint clears the cookie even with no/expired/garbage session", async () => {
  const logout = require("../netlify/functions/board-logout");
  for (const headers of [{}, { cookie: `${auth.COOKIE_NAME}=garbage` }, { cookie: "" }]) {
    const res = await logout.handler({ httpMethod: "POST", headers });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(/Max-Age=0/.test(res.headers["Set-Cookie"]));
  }
});

test("cookie parser handles absent, empty and multi-cookie headers", () => {
  assert.deepStrictEqual(auth.parseCookies(undefined), {});
  assert.deepStrictEqual(auth.parseCookies(""), {});
  const parsed = auth.parseCookies(`a=1; ${auth.COOKIE_NAME}=abc; b=2`);
  assert.strictEqual(parsed[auth.COOKIE_NAME], "abc");
});

console.log("\nLogin hardening");

// 22. Constant-time comparison
test("constant-time comparison is correct and length-safe", () => {
  assert.strictEqual(timing.constantTimeEqual("hunter2", "hunter2"), true);
  assert.strictEqual(timing.constantTimeEqual("hunter2", "hunter3"), false);
  assert.strictEqual(timing.constantTimeEqual("short", "a-much-longer-value"), false,
    "must not throw on differing lengths");
  assert.strictEqual(timing.constantTimeEqual("", ""), true);
  assert.strictEqual(timing.constantTimeEqual(null, ""), true);
});

test("failure delay is randomized within a sane band", () => {
  const values = new Set();
  for (let i = 0; i < 50; i++) {
    const ms = timing.randomFailureDelayMs();
    assert.ok(ms >= 250 && ms < 500, `delay ${ms} out of band`);
    values.add(ms);
  }
  assert.ok(values.size > 5, "delay should actually vary");
});

console.log("\nCSRF");

// 23. CSRF controls
test("custom board request header is required", () => {
  assert.strictEqual(auth.hasBoardRequestHeader(eventWithCookie("t")), true);
  assert.strictEqual(auth.hasBoardRequestHeader({ headers: { host: "x" } }), false);
});

test("same-origin check compares Origin/Referer against the request host", () => {
  assert.strictEqual(auth.isSameOrigin({ headers: { host: "a.test", origin: "https://a.test" } }), true);
  assert.strictEqual(auth.isSameOrigin({ headers: { host: "a.test", referer: "https://a.test/board.html" } }), true);
  assert.strictEqual(auth.isSameOrigin({ headers: { host: "a.test", origin: "https://evil.test" } }), false);
  assert.strictEqual(auth.isSameOrigin({ headers: { host: "a.test" } }), false, "absent origin is not trusted");
  assert.strictEqual(auth.isSameOrigin({ headers: { host: "a.test", origin: "not a url" } }), false);
});

console.log("\nRoster");

test("active roster is the six sitting members", () => {
  const keys = members.listActive().map(m => m.key).sort();
  assert.deepStrictEqual(keys, ["aimee", "jodi", "mike", "raja", "tony", "yashu"]);
});

test("Ramana is historical: no access, no login, votes preserved", () => {
  const r = members.getMember("ramana");
  assert.strictEqual(r.status, "historical");
  assert.strictEqual(r.access, null);
  assert.strictEqual(members.getActiveMember("ramana"), null);
  assert.strictEqual(members.isActive("ramana"), false);
  assert.ok(r.voteFields && r.voteFields.vote === "ramana_vote",
    "historical vote fields must be preserved so past votes still count");
  assert.ok(members.listAll().some(m => m.key === "ramana"),
    "must remain in listAll() for vote counting and forward detection");
});

test("the vacant Treasurer seat has no account of any kind", () => {
  assert.strictEqual(members.getMember("treasurer"), null);
  assert.strictEqual(members.getMember("tbd"), null);
  assert.ok(members.VACANT_SEATS.some(s => s.displayTitle === "Treasurer" && s.status === "vacant"));
  for (const m of members.listAll()) {
    assert.notStrictEqual(m.displayName, "TBD", "no placeholder user may exist");
  }
});

test("access is independent of board title", () => {
  assert.strictEqual(members.getActiveMember("yashu").access, "admin",
    "Vice President holds admin");
  assert.strictEqual(members.getActiveMember("tony").access, "officer",
    "President holds officer, not admin");
});

test("Jodi can log in but cannot yet vote", () => {
  assert.ok(members.isActive("jodi"));
  assert.strictEqual(members.canVote("jodi"), false);
  assert.strictEqual(members.getMember("jodi").voteFields, null);
  assert.deepStrictEqual(members.getMember("jodi").emailAliases, ["budenaers.jodi@gmail.com"]);
});

test("every other active member can vote", () => {
  for (const key of ["raja", "yashu", "tony", "aimee", "mike"]) {
    assert.strictEqual(members.canVote(key), true, `${key} should be able to vote`);
  }
});

console.log("\nModule isolation");

// 24. Credentials must not be reachable from the scanner's module graph
test("roster and auth modules contain no credential values", () => {
  const fs = require("fs");
  const src = fs.readFileSync(require.resolve("../netlify/functions/lib/board-members.js"), "utf8")
            + fs.readFileSync(require.resolve("../netlify/functions/lib/board-auth.js"), "utf8");
  // The live board passwords, verbatim. Prose mentioning the word "password"
  // is fine; the actual secrets appearing here would not be.
  for (const secret of ["mapletiger42", "silverfox23", "hazelbrook49", "oceanbreeze17",
                        "goldenpine55", "riverstone31", "coppermoon88"]) {
    assert.ok(!src.includes(secret), `must not contain the credential "${secret}"`);
  }
});

test("no roster entry carries a password field", () => {
  for (const m of members.listAll()) {
    for (const k of Object.keys(m)) {
      assert.ok(!/pass|secret|token|credential/i.test(k), `member "${m.key}" exposes field "${k}"`);
    }
  }
});

// The whole point of splitting board-members.js out of board-api.js: importing
// the roster from the scanner must not drag board credentials in with it.
test("scan-inbox's module graph never reaches board credentials", () => {
  const path = require("path");
  const seen = new Set();
  (function walk(file) {
    const resolved = require.resolve(file);
    if (seen.has(resolved) || resolved.includes("node_modules")) return;
    seen.add(resolved);
    const src = require("fs").readFileSync(resolved, "utf8");
    for (const m of src.matchAll(/require\((["'])(\.[^"']+)\1\)/g)) {
      try { walk(path.resolve(path.dirname(resolved), m[2])); } catch { /* not a local file */ }
    }
  })("../netlify/functions/scan-inbox.js");

  assert.ok(seen.size > 1, "expected scan-inbox to pull in at least one local module");
  for (const file of seen) {
    assert.ok(!/board-api\.js$/.test(file), "scan-inbox must not import board-api.js");
    const src = require("fs").readFileSync(file, "utf8");
    assert.ok(!src.includes("BOARD_PASSWORDS"),
      `credentials reachable via ${path.basename(file)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
