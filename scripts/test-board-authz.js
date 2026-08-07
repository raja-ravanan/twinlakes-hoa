"use strict";
// Table-driven authorization matrix for the Board API.
//   node scripts/test-board-authz.js
//
// The expected table below is written by hand and compared against the
// PERMISSIONS table in lib/board-auth.js. If either drifts, this fails — so a
// typo in the source cannot quietly widen access, and a new action cannot be
// added without a deliberate decision recorded here.

const assert = require("assert");
const auth = require("../netlify/functions/lib/board-auth");
const members = require("../netlify/functions/lib/board-members");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.log(`  FAIL- ${name}\n        ${e.message}`); }
}

// ── The intended policy, stated independently of the implementation ──
const EXPECTED = {
  login:                     "public",
  getPublicAnnouncements:    "public",
  getPublicMinutes:          "public",
  getPublicSettings:         "public",

  getDashboard:              "member",
  getResidents:              "member",
  getAccessRequests:         "member",
  getAccessRequestPreview:   "member",
  getEmailPreview:           "member",
  updateRequestStatus:       "member",
  addRequestNote:            "member",
  updateAccessRequestStatus: "member",
  addAccessRequestNote:      "member",
  addComment:                "member",
  updateStatus:              "member",
  castVote:                  "member",
  addAnnouncement:           "member",
  updateAnnouncement:        "member",

  deleteAnnouncement:        "officer",
  addMinutes:                "officer",
  updateMinutes:             "officer",
  deleteMinutes:             "officer",
  sendAccessResponse:        "officer",
  sendNotification:          "officer",
  updateARC:                 "officer",
  addARC:                    "officer",

  viewDiagnostics:           "admin",
  setSetting:                "admin",
  deleteARC:                 "admin",
  deleteRequest:             "admin",
  deleteAccessRequest:       "admin",
  adminSetVotes:             "admin",
  runScan:                   "admin",
};

// adminSetVotes is additionally pinned to the two technical administrators.
const EXPECTED_KEYS = { adminSetVotes: ["raja", "yashu"] };

// ── Principals ──
const PRINCIPALS = {
  none:      null,
  member:    { username: "mike",  access: "member"  },   // Member at Large
  member2:   { username: "jodi",  access: "member"  },
  officer:   { username: "tony",  access: "officer" },   // President
  admin:     { username: "raja",  access: "admin"   },   // Secretary
  admin2:    { username: "yashu", access: "admin"   },   // Vice President
};

function ev(extra) {
  return { headers: { host: "a.test", origin: "https://a.test", "x-board-request": "1", ...(extra || {}) } };
}

function expectedStatus(action, principalName) {
  const need = EXPECTED[action];
  if (need === "public") return null;                      // allowed
  const p = PRINCIPALS[principalName];
  if (!p) return 401;
  if (!members.accessAtLeast(p.access, need)) return 403;
  const keys = EXPECTED_KEYS[action];
  if (keys && !keys.includes(p.username)) return 403;
  return null;                                             // allowed
}

console.log("\nPolicy table integrity");

test("implementation declares exactly the actions the policy expects", () => {
  const impl = Object.keys(auth.PERMISSIONS).sort();
  const expected = Object.keys(EXPECTED).sort();
  assert.deepStrictEqual(impl, expected,
    "PERMISSIONS and the expected policy table must list the same actions");
});

test("each action's required access level matches the policy", () => {
  for (const [action, need] of Object.entries(EXPECTED)) {
    assert.strictEqual(auth.PERMISSIONS[action].access, need,
      `${action}: expected "${need}", found "${auth.PERMISSIONS[action].access}"`);
  }
});

test("adminSetVotes is pinned to Raja and Yashu by name", () => {
  assert.deepStrictEqual(auth.PERMISSIONS.adminSetVotes.keys.sort(), ["raja", "yashu"]);
});

test("every state-changing action is marked as mutating", () => {
  const readOnly = ["getPublicAnnouncements", "getPublicMinutes", "getPublicSettings",
    "getDashboard", "getResidents", "getAccessRequests", "getAccessRequestPreview",
    "getEmailPreview", "viewDiagnostics"];
  for (const [action, p] of Object.entries(auth.PERMISSIONS)) {
    assert.strictEqual(p.mutates, !readOnly.includes(action), `${action}.mutates`);
  }
});

console.log("\nFull matrix: every action x every principal");

let cases = 0;
test("authorize() returns the expected status for all action/principal pairs", () => {
  for (const action of Object.keys(EXPECTED)) {
    for (const principalName of Object.keys(PRINCIPALS)) {
      const session = PRINCIPALS[principalName];
      const denied = auth.authorize(ev(), action, session);
      const want = expectedStatus(action, principalName);
      const got = denied ? denied.statusCode : null;
      assert.strictEqual(got, want,
        `${action} as ${principalName}: expected ${want === null ? "allow" : want}, got ${got === null ? "allow" : got}`);
      cases++;
    }
  }
});

console.log(`        (${cases} action/principal cases)`);

console.log("\nDefault deny");

test("unknown actions are denied with 403, even for an administrator", () => {
  for (const action of ["totallyMadeUp", "deleteEverything", "", null, undefined, 42, "__proto__", "constructor"]) {
    const denied = auth.authorize(ev(), action, PRINCIPALS.admin);
    assert.ok(denied, `expected denial for ${JSON.stringify(action)}`);
    assert.strictEqual(denied.statusCode, 403, `expected 403 for ${JSON.stringify(action)}`);
  }
});

test("prototype keys cannot be mistaken for declared actions", () => {
  assert.strictEqual(auth.getPermission("toString"), null);
  assert.strictEqual(auth.getPermission("hasOwnProperty"), null);
});

console.log("\nCSRF enforcement inside authorize()");

test("authenticated actions require the custom board header", () => {
  const noHeader = { headers: { host: "a.test", origin: "https://a.test" } };
  const denied = auth.authorize(noHeader, "getDashboard", PRINCIPALS.admin);
  assert.ok(denied && denied.statusCode === 403);
});

test("state-changing actions require a same-origin Origin/Referer", () => {
  const crossOrigin = ev({ origin: "https://evil.test" });
  assert.ok(auth.authorize(crossOrigin, "deleteARC", PRINCIPALS.admin).statusCode === 403,
    "cross-origin write must be refused");
  assert.strictEqual(auth.authorize(crossOrigin, "getDashboard", PRINCIPALS.admin), null,
    "reads are not origin-gated");
});

test("public actions need neither session, header nor origin", () => {
  for (const action of ["login", "getPublicAnnouncements", "getPublicMinutes", "getPublicSettings"]) {
    assert.strictEqual(auth.authorize({ headers: {} }, action, null), null, action);
  }
});

console.log("\nPermission hints given to the browser");

test("permissionsFor matches what authorize actually allows", () => {
  for (const [name, session] of Object.entries(PRINCIPALS)) {
    if (!session) continue;
    const hinted = auth.permissionsFor(session);
    for (const action of Object.keys(EXPECTED)) {
      if (EXPECTED[action] === "public") {
        assert.ok(!hinted.includes(action), `${action} is public and should not be hinted`);
        continue;
      }
      const allowed = auth.authorize(ev(), action, session) === null;
      assert.strictEqual(hinted.includes(action), allowed,
        `${name}: hint and enforcement disagree about ${action}`);
    }
  }
});

test("no session yields no permissions", () => {
  assert.deepStrictEqual(auth.permissionsFor(null), []);
});

console.log("\nSpecific policy outcomes");

const outcomes = [
  ["mike",  "deleteAnnouncement", false, "a Member at Large cannot delete announcements"],
  ["mike",  "deleteMinutes",      false, "a Member at Large cannot delete minutes"],
  ["mike",  "sendNotification",   false, "a Member at Large cannot email as the HOA"],
  ["mike",  "sendAccessResponse", false, "a Member at Large cannot send portal access approvals"],
  ["mike",  "getDashboard",       true,  "every member sees the operational queues"],
  ["mike",  "addAnnouncement",    true,  "every member can post announcements"],
  ["mike",  "castVote",           true,  "every member can cast their own vote"],
  ["mike",  "getResidents",       true,  "every member can open the directory"],
  ["mike",  "viewDiagnostics",    false, "diagnostics are admin-only"],
  ["tony",  "deleteAnnouncement", true,  "the President can delete announcements"],
  ["tony",  "updateARC",          true,  "the President can correct ARC records"],
  ["tony",  "sendNotification",   true,  "the President can send official email"],
  ["tony",  "deleteARC",          false, "the President cannot delete ARC records"],
  ["tony",  "setSetting",         false, "the President cannot change portal settings"],
  ["tony",  "runScan",            false, "the President cannot run inbox scans"],
  ["tony",  "adminSetVotes",      false, "the President cannot override votes"],
  ["tony",  "deleteRequest",      false, "the President cannot delete resident requests"],
  ["tony",  "deleteAccessRequest",false, "the President cannot delete portal access requests"],
  ["mike",  "deleteRequest",      false, "a Member at Large cannot delete resident requests"],
  ["mike",  "deleteAccessRequest",false, "a Member at Large cannot delete portal access requests"],
  ["raja",  "adminSetVotes",      true,  "Raja can record votes on behalf"],
  ["yashu", "adminSetVotes",      true,  "Yashu can record votes on behalf"],
  ["raja",  "deleteARC",          true,  "Raja can delete ARC records"],
  ["raja",  "deleteRequest",      true,  "Raja can delete resident requests"],
  ["raja",  "deleteAccessRequest",true,  "Raja can delete portal access requests"],
  ["yashu", "runScan",            true,  "Yashu can run inbox scans"],
];

for (const [username, action, shouldAllow, description] of outcomes) {
  test(description, () => {
    const member = members.getActiveMember(username);
    assert.ok(member, `${username} must be an active member`);
    const session = { username, access: member.access };
    const denied = auth.authorize(ev(), action, session);
    assert.strictEqual(denied === null, shouldAllow,
      shouldAllow ? `expected ${username} to be allowed ${action}` : `expected ${username} to be refused ${action}`);
  });
}

test("a resigned member has no access level and so satisfies nothing", () => {
  assert.strictEqual(members.getActiveMember("ramana"), null);
  assert.strictEqual(members.accessAtLeast(null, "member"), false);
  assert.strictEqual(members.accessAtLeast(undefined, "member"), false);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
