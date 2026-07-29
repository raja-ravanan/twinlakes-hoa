"use strict";
// Google Sheets write-result contract.
//   node scripts/test-board-write-contract.js
//
// Google is never called: lib/sheets-write.js's own `request` function is
// stubbed, so these tests exercise the response gate with no network at all.

const assert = require("assert");
const sheetsWrite = require("../netlify/functions/lib/sheets-write");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.log(`  FAIL- ${name}\n        ${e.message}`); }
}

const realRequest = sheetsWrite.request;
function stub(response) {
  sheetsWrite.request = async () => response;
}
function restore() { sheetsWrite.request = realRequest; }

async function expectThrows(fn, why) {
  let threw = null;
  try { await fn(); } catch (e) { threw = e; }
  assert.ok(threw, `expected a throw: ${why}`);
  assert.strictEqual(threw.name, "SheetsWriteError", `expected SheetsWriteError, got ${threw.name}: ${threw.message}`);
  return threw;
}

(async () => {
  console.log("\nWrite failures must fail");

  // Every failure shape the old code silently swallowed.
  const failureCases = [
    ["non-2xx status (403 permission lost)", { status: 403, body: '{"error":{"message":"forbidden"}}' }],
    ["non-2xx status (429 quota)",           { status: 429, body: '{"error":{"message":"quota"}}' }],
    ["non-2xx status (500)",                 { status: 500, body: "upstream failure" }],
    ["unparseable body",                     { status: 200, body: "<html>proxy error</html>" }],
    ["null body",                            { status: 200, body: "null" }],
    ["google error object in a 200",         { status: 200, body: '{"error":{"message":"Unable to parse range"}}' }],
    ["missing update metadata",              { status: 200, body: '{"spreadsheetId":"x"}' }],
    ["zero cells updated",                   { status: 200, body: '{"updatedCells":0}' }],
  ];

  for (const [name, response] of failureCases) {
    await test(`update rejects: ${name}`, async () => {
      stub(response);
      try { await expectThrows(() => sheetsWrite.valuesUpdate("t", "sheet", "A1", [["x"]]), name); }
      finally { restore(); }
    });
  }

  await test("append rejects a response reporting no inserted rows", async () => {
    stub({ status: 200, body: '{"updates":{"updatedRows":0}}' });
    try { await expectThrows(() => sheetsWrite.valuesAppend("t", "sheet", "A:A", [["x"]])); }
    finally { restore(); }
  });

  await test("append rejects a response with no updates block", async () => {
    stub({ status: 200, body: '{"spreadsheetId":"x"}' });
    try { await expectThrows(() => sheetsWrite.valuesAppend("t", "sheet", "A:A", [["x"]])); }
    finally { restore(); }
  });

  console.log("\nWrite successes must succeed");

  await test("update accepts a well-formed success", async () => {
    stub({ status: 200, body: '{"updatedCells":4,"updatedRange":"Sheet!A1:D1"}' });
    try {
      const r = await sheetsWrite.valuesUpdate("t", "sheet", "A1:D1", [["a", "b", "c", "d"]]);
      assert.strictEqual(r.updatedCells, 4);
    } finally { restore(); }
  });

  await test("append accepts a well-formed success", async () => {
    stub({ status: 200, body: '{"updates":{"updatedRows":1}}' });
    try {
      const r = await sheetsWrite.valuesAppend("t", "sheet", "A:A", [["a"]]);
      assert.strictEqual(r.updates.updatedRows, 1);
    } finally { restore(); }
  });

  console.log("\nHTTP mapping");

  await test("a SheetsWriteError becomes a 502 that admits nothing was saved", async () => {
    const err = new sheetsWrite.SheetsWriteError("Sheets write failed", "http_403");
    const res = sheetsWrite.toErrorResponse(err);
    assert.strictEqual(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.success, false);
    assert.ok(/could not save/i.test(body.error), "message must be plain for a non-technical reader");
    assert.ok(/nothing was recorded/i.test(body.error), "must state the change did not happen");
  });

  await test("a genuine bug is not disguised as a persistence failure", () => {
    assert.strictEqual(sheetsWrite.toErrorResponse(new TypeError("undefined is not a function")), null);
    assert.strictEqual(sheetsWrite.toErrorResponse(new Error("boom")), null);
  });

  console.log("\nboard-api wiring");

  await test("board-api routes every Sheets write through the checked helpers", () => {
    const src = require("fs").readFileSync(
      require.resolve("../netlify/functions/board-api.js"), "utf8");
    assert.ok(src.includes("sheetsWrite.valuesUpdate"), "sheetsUpdate must delegate to the checked helper");
    assert.ok(src.includes("sheetsWrite.valuesAppend"), "sheetsAppend must delegate to the checked helper");
    assert.ok(src.includes("sheetsWrite.toErrorResponse"), "the handler must map SheetsWriteError to a response");
    assert.ok(!/async function sheetsUpdate[\s\S]{0,400}return JSON\.parse\(r\.body\)/.test(src),
      "the old unchecked write helper must be gone");
  });

  await test("audit logging is non-fatal", () => {
    const src = require("fs").readFileSync(
      require.resolve("../netlify/functions/board-api.js"), "utf8");
    const fn = src.slice(src.indexOf("async function logActivity"), src.indexOf("async function getSheetData"));
    assert.ok(/try\s*\{/.test(fn) && /catch/.test(fn),
      "a failed audit append must not fail the member's action");
  });

  await test("the handler is wrapped so a write failure cannot return 200", () => {
    const src = require("fs").readFileSync(
      require.resolve("../netlify/functions/board-api.js"), "utf8");
    assert.ok(/exports\.handler = async \(event\) => \{\s*try \{\s*return await handleRequest\(event\)/.test(src),
      "handleRequest must be wrapped in a try/catch");
  });

  console.log("\nboard.html client contract");

  await test("api() throws instead of returning a sentinel", () => {
    const src = require("fs").readFileSync(
      require.resolve("../board.html"), "utf8");
    assert.ok(/throw new ApiError\(res\.status/.test(src), "non-2xx must throw");
    assert.ok(!/if \(res\.status === 401\) \{ logout\(\); return null; \}/.test(src),
      "the old null-sentinel return must be gone");
    assert.ok(/async function uiAction/.test(src), "a shared UI-action wrapper must exist");
    assert.ok(/unhandledrejection/.test(src), "an escaped ApiError must still reach the user");
  });

  await test("no call site shows success without awaiting the call", () => {
    const src = require("fs").readFileSync(require.resolve("../board.html"), "utf8");
    // The specific regression: `await api(...)` immediately followed by an
    // unconditional success toast.
    assert.ok(!/await api\(\{[^}]*\}[^;]*\);\s*\n\s*showToast\([^,]*,\s*"success"\)/.test(src),
      "found an unconditional success toast after an api() call");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})();
