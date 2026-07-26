"use strict";
// End-to-end verification of the resident-portal audit pipeline against a
// SIMULATED Google Sheets backend — not a live Google Sheet.
//
// Why simulated rather than live: this repo's real Google service-account
// key has a pre-existing, unrelated local-dev parsing issue (also affects
// board-api.js, seen independently of this work) that prevents signing a
// real JWT locally. Rather than skip end-to-end coverage, this script:
//   1. Generates a throwaway, syntactically valid RSA keypair at runtime
//      (via Node's own crypto.generateKeyPairSync) so the REAL
//      getGoogleToken()/JWT-signing code in resident-audit.js runs for
//      real, unmodified.
//   2. Intercepts Node's https.request — the actual transport
//      resident-audit.js calls — with an in-memory fake that behaves like
//      the Google Sheets API (tab metadata, header get/put, batchUpdate,
//      append). Every other line of resident-audit.js, resident-login.js,
//      and resident-logout.js runs unmodified and unmocked.
//   3. Inspects the exact bytes that would have been sent over the wire,
//      not just the in-process event objects — the strongest available
//      check that secrets never reach the request payload.
//
// Run with: node scripts/test-resident-audit-e2e.js
// Uses fake secrets/data only.

const assert = require("assert");
const crypto = require("crypto");
const https = require("https");

// Fake "TL Directory"-shaped source rows: [Name, Street No], matching the
// two real formats confirmed in the actual sheet — one comma "Last, First"
// row and one no-comma "First Last" row, per house 123 and 125 respectively.
const FAKE_DIRECTORY_SOURCE_ROWS = [
  ["Smith, John", "123"],
  ["Jane O'Brien", "125"],
];
const FAKE_PASSWORD = "test-community-password-42";
const FAKE_SESSION_SECRET = "test-session-secret-do-not-use-in-prod";
const FAKE_SESSION_VERSION = "1";
const FAKE_IP_SALT = "test-ip-salt-do-not-use-in-prod";
const FAKE_AUDIT_SHEET_ID = "fake-audit-sheet-id-for-e2e-test";
const FAKE_RESIDENT_SHEET_ID = "fake-resident-sheet-id-for-e2e-test";
const FAKE_SA_EMAIL = "fake-service-account@fake-project.iam.gserviceaccount.com";

// A real, syntactically valid (but throwaway) RSA private key so the real
// RSA-SHA256 signing code path actually runs. Google never sees this key —
// the HTTP transport itself is intercepted below.
const { privateKey: FAKE_SA_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

process.env.RESIDENT_PORTAL_PASSWORD = FAKE_PASSWORD;
process.env.RESIDENT_SESSION_SECRET = FAKE_SESSION_SECRET;
process.env.RESIDENT_SESSION_VERSION = FAKE_SESSION_VERSION;
process.env.RESIDENT_AUDIT_IP_SALT = FAKE_IP_SALT;
process.env.GOOGLE_SHEET_ID = FAKE_AUDIT_SHEET_ID;
process.env.RESIDENT_SHEET_ID = FAKE_RESIDENT_SHEET_ID;
process.env.GOOGLE_SA_EMAIL = FAKE_SA_EMAIL;
process.env.GOOGLE_SA_KEY = FAKE_SA_KEY;

let passed = 0;
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

// ── Fake Google Sheets transport ────────────────────────────────
// Mirrors just enough of the real API surface resident-audit.js calls:
// oauth2 token exchange, spreadsheet metadata, values.get, values.update
// (PUT), values.append (POST ...:append), and :batchUpdate (addSheet).
function createFakeSheetsState() {
  return {
    tabs: new Set(), headers: new Map(), rows: new Map(), requestsSent: [], outage: false,
    directoryRows: FAKE_DIRECTORY_SOURCE_ROWS.slice(), // fresh copy per test
  };
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

        // Outages are scoped per-sheet: audit and directory now have
        // different failure semantics (audit fails OPEN, directory fails
        // CLOSED — see lib/resident-audit.js vs lib/resident-directory.js),
        // so tests need to be able to take one down without the other.
        const isAuditRequest = options.hostname === "sheets.googleapis.com" && options.path.includes(`/v4/spreadsheets/${FAKE_AUDIT_SHEET_ID}`);
        const isDirectoryRequest = options.hostname === "sheets.googleapis.com" && options.path.includes(`/v4/spreadsheets/${FAKE_RESIDENT_SHEET_ID}`);
        if ((state.auditOutage && isAuditRequest) || (state.directoryOutage && isDirectoryRequest)) {
          // Simulate a network-level failure (e.g. Sheets unreachable) —
          // real https.request would emit 'error' on the request object.
          setImmediate(() => req._errorHandler && req._errorHandler(new Error("simulated_network_outage")));
          return;
        }

        let status = 200;
        let respBody = "{}";
        try {
          if (options.hostname === "oauth2.googleapis.com" && options.path === "/token") {
            respBody = JSON.stringify({ access_token: "fake-access-token" });
          } else if (options.hostname === "sheets.googleapis.com" && options.path.includes(`/v4/spreadsheets/${FAKE_RESIDENT_SHEET_ID}/`)) {
            // Resident directory reads are GET-only, single fixed sheet — a
            // much narrower surface than the audit sheet's create/validate/
            // append flow, so it's handled separately here.
            if (options.method === "GET" && options.path.includes("/values/")) {
              respBody = JSON.stringify({ values: state.directoryRows || [] });
            } else {
              status = 404;
            }
          } else if (options.hostname === "sheets.googleapis.com") {
            const path = options.path;
            if (options.method === "GET" && /^\/v4\/spreadsheets\/[^/]+$/.test(path)) {
              respBody = JSON.stringify({ sheets: [...state.tabs].map((t) => ({ properties: { title: t } })) });
            } else if (options.method === "GET" && path.includes("/values/")) {
              const range = decodeURIComponent(path.split("/values/")[1]);
              const tab = range.split("!")[0].replace(/^'|'$/g, "");
              const header = state.headers.get(tab);
              respBody = JSON.stringify({ values: header ? [header] : [] });
            } else if (options.method === "PUT" && path.includes("/values/")) {
              const parsed = JSON.parse(bodyStr);
              const tab = parsed.range.split("!")[0].replace(/^'|'$/g, "");
              state.headers.set(tab, parsed.values[0]);
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
          const res = {
            statusCode: status,
            on(event, cb) {
              if (event === "data") cb(respBody);
              if (event === "end") cb();
            },
          };
          callback(res);
        });
      },
      on(event, cb) {
        if (event === "error") req._errorHandler = cb;
      },
    };
    return req;
  };
  return () => { https.request = realRequest; };
}

function freshHandlers() {
  for (const mod of ["resident-login", "resident-logout", "resident-session", "lib/resident-audit", "lib/resident-auth"]) {
    delete require.cache[require.resolve(`../netlify/functions/${mod}`)];
  }
  return {
    loginHandler: require("../netlify/functions/resident-login").handler,
    logoutHandler: require("../netlify/functions/resident-logout").handler,
    sessionHandler: require("../netlify/functions/resident-session").handler,
  };
}

function getHeader(res, name) {
  const key = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? res.headers[key] : undefined;
}

function loginEvent(body, headers) {
  return { httpMethod: "POST", body: JSON.stringify(body), headers: headers || {} };
}

const AUDIT_TAB = "Resident Portal Audit";

(async () => {
  await step("brand-new tab is created with the exact header, one row written for a successful login", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler } = freshHandlers();
      const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      assert.strictEqual(res.statusCode, 200);
      assert.ok(getHeader(res, "Set-Cookie"));
      assert.ok(state.tabs.has(AUDIT_TAB), "tab should have been created");
      const auditLib = require("../netlify/functions/lib/resident-audit");
      assert.deepStrictEqual(state.headers.get(AUDIT_TAB), auditLib.AUDIT_HEADERS);
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 1, "exactly one row for the one login attempt");
      const [eventId, timestamp, eventType, houseNumber, lastName, householdMatch, failureCategory, sessionRef] = rows[0];
      assert.strictEqual(eventType, "LOGIN_SUCCESS");
      assert.strictEqual(houseNumber, "123");
      assert.strictEqual(lastName, "smith");
      assert.strictEqual(householdMatch, "true");
      assert.strictEqual(failureCategory, "");
      assert.ok(sessionRef, "session reference should be present");
      assert.match(eventId, /^[0-9a-f-]{36}$/i);
      assert.strictEqual(new Date(timestamp).toISOString(), timestamp);
    } finally {
      restore();
    }
  });

  await step("wrong password writes one row: Household Match=true, Failure Category=INVALID_PASSWORD", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler } = freshHandlers();
      const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: "wrong-password" }));
      assert.strictEqual(res.statusCode, 401);
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0][2], "LOGIN_FAILURE");
      assert.strictEqual(rows[0][5], "true", "household match is true — the resident combination itself was valid");
      assert.strictEqual(rows[0][6], "INVALID_PASSWORD");
    } finally {
      restore();
    }
  });

  await step("unknown resident writes one row: Household Match=false, Failure Category=INVALID_RESIDENT", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler } = freshHandlers();
      const res = await loginHandler(loginEvent({ houseNumber: "999", lastName: "Nobody", password: FAKE_PASSWORD }));
      assert.strictEqual(res.statusCode, 401);
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0][2], "LOGIN_FAILURE");
      assert.strictEqual(rows[0][5], "false");
      assert.strictEqual(rows[0][6], "INVALID_RESIDENT");
    } finally {
      restore();
    }
  });

  await step("invalid input writes one row with Household Match left blank", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler } = freshHandlers();
      const res = await loginHandler(loginEvent({ houseNumber: "", lastName: "", password: "" }));
      assert.strictEqual(res.statusCode, 400);
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0][5], "", "household match is blank, not false, when never determined");
      assert.strictEqual(rows[0][6], "INVALID_INPUT");
    } finally {
      restore();
    }
  });

  await step("logout writes exactly one LOGOUT row correlated to the login's session reference", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler, logoutHandler } = freshHandlers();
      const loginRes = await loginHandler(loginEvent({ houseNumber: "125", lastName: "O'Brien", password: FAKE_PASSWORD }));
      const cookieHeader = getHeader(loginRes, "Set-Cookie").split(";")[0];
      const logoutRes = await logoutHandler({ httpMethod: "POST", headers: { cookie: cookieHeader } });
      assert.strictEqual(logoutRes.statusCode, 200);
      assert.ok(getHeader(logoutRes, "Set-Cookie").includes("Max-Age=0"));
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 2, "one row for login, one for logout — never overwritten");
      assert.strictEqual(rows[1][2], "LOGOUT");
      assert.strictEqual(rows[1][7], rows[0][7], "logout shares the login's session reference");
      assert.notStrictEqual(rows[1][7], "");
    } finally {
      restore();
    }
  });

  await step("refreshing the portal (resident-session) writes nothing", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler, sessionHandler } = freshHandlers();
      const loginRes = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      const cookieHeader = getHeader(loginRes, "Set-Cookie").split(";")[0];
      const rowsAfterLogin = (state.rows.get(AUDIT_TAB) || []).length;
      await sessionHandler({ httpMethod: "GET", headers: { cookie: cookieHeader } });
      await sessionHandler({ httpMethod: "GET", headers: { cookie: cookieHeader } });
      const rowsAfterRefreshes = (state.rows.get(AUDIT_TAB) || []).length;
      assert.strictEqual(rowsAfterRefreshes, rowsAfterLogin, "a session check must not append a row");
    } finally {
      restore();
    }
  });

  await step("password, session token, cookie, and raw IP never appear in any request sent over the wire", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler, logoutHandler } = freshHandlers();
      const realIp = "203.0.113.77";
      const loginRes = await loginHandler(loginEvent(
        { houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD },
        { "x-nf-client-connection-ip": realIp, "user-agent": "TestAgent/1.0" }
      ));
      const cookieHeader = getHeader(loginRes, "Set-Cookie");
      const cookieValue = cookieHeader.split(";")[0];
      await logoutHandler({ httpMethod: "POST", headers: { cookie: cookieValue, "x-nf-client-connection-ip": realIp } });

      const allWireBytes = state.requestsSent.map((r) => r.body).join("\n");
      assert.ok(!allWireBytes.includes(FAKE_PASSWORD), "password never sent to Sheets");
      assert.ok(!allWireBytes.includes(cookieValue), "cookie/session token never sent to Sheets");
      assert.ok(!allWireBytes.includes(realIp), "raw IP never sent to Sheets — only its salted hash");
      assert.ok(!allWireBytes.includes(FAKE_SESSION_SECRET), "session secret never sent to Sheets");
      // The service-account private key is used locally to SIGN the JWT
      // (crypto.sign never transmits the key itself) — confirm the PEM
      // body/material never appears in the wire bytes either.
      assert.ok(!allWireBytes.includes(FAKE_SA_KEY.split("\n")[1]), "service account key material never sent");
    } finally {
      restore();
    }
  });

  await step("audit-sheet outage: login and logout still behave normally (fail-open); nothing is exposed to the resident", async () => {
    const state = createFakeSheetsState();
    state.auditOutage = true; // directory sheet stays reachable
    const restore = installFakeHttps(state);
    try {
      const { loginHandler, logoutHandler } = freshHandlers();

      const successRes = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      assert.strictEqual(successRes.statusCode, 200, "valid login still succeeds during an audit outage");
      assert.ok(getHeader(successRes, "Set-Cookie"));
      assert.deepStrictEqual(Object.keys(JSON.parse(successRes.body)), ["ok"], "no audit-failure detail leaks into the response");

      const failRes = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: "wrong" }));
      assert.strictEqual(failRes.statusCode, 401, "invalid login still fails normally during an audit outage");

      const logoutRes = await logoutHandler({ httpMethod: "POST", headers: {} });
      assert.strictEqual(logoutRes.statusCode, 200, "logout still succeeds during an audit outage");
      assert.ok(getHeader(logoutRes, "Set-Cookie").includes("Max-Age=0"), "cookie still cleared during an audit outage");

      assert.strictEqual((state.rows.get(AUDIT_TAB) || []).length, 0, "no rows could be written during the simulated audit outage");
    } finally {
      restore();
    }
  });

  await step("directory-sheet outage: login fails CLOSED (never silently admits anyone); logout is unaffected", async () => {
    const state = createFakeSheetsState();
    state.directoryOutage = true; // audit sheet stays reachable
    const restore = installFakeHttps(state);
    try {
      const { loginHandler, logoutHandler } = freshHandlers();

      const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      assert.strictEqual(res.statusCode, 500, "a directory outage must fail closed, unlike an audit outage");
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 1, "the failed attempt is still audited (audit sheet is unaffected)");
      assert.strictEqual(rows[0][6], "CONFIGURATION_ERROR");

      // Logout doesn't depend on the directory at all — must be unaffected.
      const logoutRes = await logoutHandler({ httpMethod: "POST", headers: {} });
      assert.strictEqual(logoutRes.statusCode, 200, "logout does not depend on the resident directory");
      assert.ok(getHeader(logoutRes, "Set-Cookie").includes("Max-Age=0"));
    } finally {
      restore();
    }
  });

  await step("existing header is validated, never blindly overwritten — mismatch skips the write, matching header proceeds", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      // Pre-seed a tab with a header that does NOT match the current schema.
      state.tabs.add(AUDIT_TAB);
      state.headers.set(AUDIT_TAB, ["Event ID", "Some Other Column"]);

      const { loginHandler } = freshHandlers();
      const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      assert.strictEqual(res.statusCode, 200, "login still succeeds even though the audit header is wrong");
      assert.deepStrictEqual(state.headers.get(AUDIT_TAB), ["Event ID", "Some Other Column"], "mismatched header is left untouched, not overwritten");
      assert.strictEqual((state.rows.get(AUDIT_TAB) || []).length, 0, "no row is appended under a mismatched header");
    } finally {
      restore();
    }

    // Now with a MATCHING pre-existing header: the write should proceed and
    // the header must remain byte-identical (never re-sent/overwritten).
    const state2 = createFakeSheetsState();
    const restore2 = installFakeHttps(state2);
    try {
      const auditLib = require("../netlify/functions/lib/resident-audit");
      state2.tabs.add(AUDIT_TAB);
      state2.headers.set(AUDIT_TAB, auditLib.AUDIT_HEADERS.slice());

      const { loginHandler } = freshHandlers();
      const res = await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual((state2.rows.get(AUDIT_TAB) || []).length, 1, "row is appended once the header validates");
    } finally {
      restore2();
    }
  });

  await step("two consecutive events never overwrite each other's rows", async () => {
    const state = createFakeSheetsState();
    const restore = installFakeHttps(state);
    try {
      const { loginHandler } = freshHandlers();
      await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: "wrong-1" }));
      await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: "wrong-2" }));
      await loginHandler(loginEvent({ houseNumber: "123", lastName: "Smith", password: FAKE_PASSWORD }));
      const rows = state.rows.get(AUDIT_TAB) || [];
      assert.strictEqual(rows.length, 3, "three distinct attempts produce three distinct rows");
      const ids = rows.map((r) => r[0]);
      assert.strictEqual(new Set(ids).size, 3, "all three event IDs are unique");
    } finally {
      restore();
    }
  });

  console.log(`\n${passed} test groups passed.`);
  if (process.exitCode) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("All tests passed.");
  }
})();
