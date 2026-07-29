"use strict";
// Rendering and URL safety for the Board Portal.
//   node scripts/test-board-render-safety.js
//
// The security-critical functions (esc, safeUrl) are pure, so they are
// extracted from board.html and exercised directly — no browser, no network,
// no dependency on jsdom. DOM construction itself (makeLink/hydrateAttachments)
// is verified in the browser during manual verification.
//
// Payloads are harmless probes: they set window.__xss, which does not exist.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  - ${name}`); }
  catch (e) { failed++; console.log(`  FAIL- ${name}\n        ${e.message}`); }
}

// ── Extract the pure helpers from board.html ──
const html = fs.readFileSync(path.join(__dirname, "..", "board.html"), "utf8");
function extract(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `could not find ${startMarker} in board.html`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end !== -1, `could not find ${endMarker} after ${startMarker}`);
  return html.slice(start, end);
}
const source = extract("  function esc(s) {", "  // Links are built with DOM APIs");
const sandbox = { URL, Set, console };
vm.createContext(sandbox);
vm.runInContext(source + "\n;({ esc, safeUrl, DOC_HOSTS });", sandbox);
const { esc, safeUrl } = vm.runInContext("({ esc, safeUrl })", sandbox);

console.log("\nHTML escaping");

test("escapes all five significant characters", () => {
  assert.strictEqual(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("escapes single quotes — the gap in the old helper", () => {
  // The previous esc() left ' untouched, so any single-quoted attribute was
  // escapable. This is the regression test for that.
  assert.ok(!esc("a' onmouseover='alert(1)").includes("'"),
    "single quotes must not survive escaping");
});

test("neutralises script payloads", () => {
  const out = esc("<script>window.__xss=1</script>");
  assert.ok(!out.includes("<script"), "no live tag");
  assert.ok(out.includes("&lt;script&gt;"), "rendered as visible text instead");
});

test("neutralises attribute-breakout payloads", () => {
  for (const payload of [
    `"><img src=x onerror="window.__xss=2">`,
    `'><img src=x onerror='window.__xss=3'>`,
    `photo.jpg" onmouseover="window.__xss=4`,
    `"><svg/onload=window.__xss=5>`,
  ]) {
    const out = esc(payload);
    assert.ok(!out.includes("<"), `"<" survived: ${out}`);
    assert.ok(!/["']/.test(out), `a quote survived: ${out}`);
  }
});

test("handles null, undefined and non-strings", () => {
  assert.strictEqual(esc(null), "");
  assert.strictEqual(esc(undefined), "");
  assert.strictEqual(esc(0), "0");
  assert.strictEqual(esc({}), "[object Object]");
});

console.log("\nURL validation — dangerous schemes");

test("rejects javascript:, data:, file:, vbscript: and friends", () => {
  const dangerous = [
    "javascript:window.__xss=6",
    "JavaScript:window.__xss=7",
    "  javascript:window.__xss=8  ",
    "data:text/html,<script>window.__xss=9</script>",
    "data:text/html;base64,PHNjcmlwdD4=",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://drive.google.com/abc",
    "about:blank",
  ];
  for (const u of dangerous) {
    assert.strictEqual(safeUrl(u), null, `must reject: ${u}`);
    assert.strictEqual(safeUrl(u, { driveOnly: true }), null, `must reject (drive): ${u}`);
  }
});

test("rejects plain http, so a link cannot be downgraded", () => {
  assert.strictEqual(safeUrl("http://drive.google.com/file/d/1/view"), null);
});

test("rejects malformed input and non-strings", () => {
  for (const u of ["", "   ", "not a url", "://missing-scheme", "3 file(s) emailed to the board: a.jpg",
                   null, undefined, 42, {}, []]) {
    assert.strictEqual(safeUrl(u), null, `must reject: ${JSON.stringify(u)}`);
  }
});

test("quote injection cannot survive validation", () => {
  const injected = `https://drive.google.com/file/d/1/view" onmouseover="window.__xss=10`;
  const out = safeUrl(injected, { driveOnly: true });
  if (out !== null) {
    assert.ok(!out.includes('"'), "a raw quote must never survive into a URL");
    assert.ok(!/onmouseover/i.test(out) || out.includes("%22"),
      "any quote must be percent-encoded by URL normalisation");
  }
});

console.log("\nURL validation — allowed cases");

test("accepts Google Drive and Docs links for attachments", () => {
  for (const u of [
    "https://drive.google.com/drive/folders/1abcDEF",
    "https://drive.google.com/file/d/1abcDEF/view",
    "https://docs.google.com/spreadsheets/d/1abc/edit",
  ]) {
    assert.ok(safeUrl(u, { driveOnly: true }), `should accept: ${u}`);
  }
});

test("attachment validator rejects non-Drive hosts", () => {
  for (const u of ["https://evil.example.com/x", "https://drive.google.com.evil.test/x",
                   "https://notdrive.google.com/x"]) {
    assert.strictEqual(safeUrl(u, { driveOnly: true }), null, `must reject: ${u}`);
  }
});

test("general validator allows any https host", () => {
  assert.ok(safeUrl("https://www.louisvilleky.gov/"), "general https should be allowed");
  assert.ok(safeUrl("https://evil.example.com/x"), "hosts are not restricted for general links");
  assert.strictEqual(safeUrl("https://evil.example.com/x", { driveOnly: true }), null,
    "but the attachment validator is stricter");
});

test("the Drive allow-list is not applied globally", () => {
  // Regression guard: attachments are Drive-only, everything else is not.
  assert.ok(safeUrl("https://example.org/doc.pdf") !== null,
    "a non-Drive https link must still be usable outside attachments");
});

console.log("\nboard.html structural guarantees");

test("no inline handler carries a record-derived identifier", () => {
  const bad = html.match(/on(click|change|keydown)="[a-zA-Z]+\([^"]*\$\{(?!esc\()/g) || [];
  assert.deepStrictEqual(bad, [], `found inline handlers with interpolated data: ${bad.join(", ")}`);
});

test("delegated dispatch reads identifiers from dataset, not from code", () => {
  assert.ok(/document\.addEventListener\("click"/.test(html), "a delegated click listener must exist");
  assert.ok(/el\.dataset\.id/.test(html), "identifiers must be read from data-* attributes");
  assert.ok(/closest\("\[data-act\]"\)/.test(html), "dispatch must key off data-act");
});

test("attachment links are built with DOM APIs, not string interpolation", () => {
  assert.ok(!/<a href="\$\{(arc|vio|url)/.test(html),
    "no anchor may be built by interpolating a URL into markup");
  assert.ok(/a\.href = href;/.test(html), "href must be assigned, not interpolated");
  assert.ok(/a\.textContent = text;/.test(html), "link text must use textContent");
  assert.ok(/rel = "noopener noreferrer"/.test(html), "external links need rel=noopener");
});

test("the previously-unescaped render paths now escape their data", () => {
  const region = html.slice(html.indexOf("function arcDetailBody"), html.indexOf("function renderViolations"));
  for (const field of ["ai_summary", "ai_reasoning"]) {
    const re = new RegExp(`\\$\\{esc\\(arc\\.${field}`);
    assert.ok(re.test(region), `arc.${field} must be escaped in arcDetailBody`);
  }
  const vio = html.slice(html.indexOf("function renderVioCard"), html.indexOf("function renderOthers"));
  for (const field of ["homeowner_name", "address", "ai_summary", "violation_type"]) {
    assert.ok(new RegExp(`esc\\(vio\\.${field}`).test(vio), `vio.${field} must be escaped`);
  }
});

test("board authentication is no longer kept in localStorage", () => {
  assert.ok(!/localStorage\.(get|set)Item\("board_token"\)/.test(html), "no token in localStorage");
  assert.ok(!/localStorage\.(get|set)Item\("board_user"\)/.test(html), "no user record in localStorage");
  assert.ok(!/Authorization: `Bearer/.test(html), "the legacy bearer header must be gone");
  assert.ok(/credentials: "include"/.test(html), "requests must send the session cookie");
});

test("the scan trigger no longer prompts for a shared secret", () => {
  assert.ok(!/prompt\("Enter admin secret/.test(html), "the DIGEST_SECRET prompt must be gone");
  assert.ok(!/JSON\.stringify\(\{ secret,/.test(html), "the secret must not be POSTed from the browser");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
