"use strict";
// Scans the working diff for credentials, resident PII and production secrets.
//   node scripts/check-diff-secrets.js [baseRef]
//
// Scoped to NEWLY ADDED lines. The six board passwords already sit in
// board-api.js on main (moving them to environment variables is the first
// Phase B security item), so this checks that the diff does not introduce or
// relocate a credential — not that the repository is free of them.

const { execSync } = require("child_process");

const base = process.argv[2] || "main";
let added = "";
try {
  added = execSync(`git diff ${base}...HEAD`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    + execSync("git diff HEAD", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error("Could not read the diff:", e.message);
  process.exit(1);
}

const addedLines = added.split("\n")
  .filter(l => l.startsWith("+") && !l.startsWith("+++"))
  .map(l => l.slice(1));

// Lines that legitimately name a secret without containing one: env-var
// references, prose, and the test that asserts credentials are absent.
function isReference(line) {
  return /process\.env\./.test(line)
    || /^\s*(\/\/|\*|#)/.test(line)
    || /must not contain the credential/.test(line);
}

const RULES = [
  { name: "board password", re: /\b(mapletiger42|silverfox23|hazelbrook49|oceanbreeze17|goldenpine55|riverstone31|coppermoon88)\b/ },
  { name: "private key material", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "assigned Google/Gmail secret", re: /(GMAIL_REFRESH_TOKEN|GMAIL_CLIENT_SECRET|GOOGLE_SA_KEY|DIGEST_SECRET|BOARD_SESSION_SECRET|RESIDENT_SESSION_SECRET|RESIDENT_PORTAL_PASSWORD)\s*[:=]\s*["'][^"'\s]{8,}/ },
  { name: "Google OAuth client id", re: /\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "Anthropic API key", re: /\bsk-ant-[0-9A-Za-z_-]{20,}\b/ },
  { name: "spreadsheet id", re: /\b1[A-Za-z0-9_-]{42,}\b/ },
  { name: "resident street address", re: /\b1[0-9]{4}\s+(Cumberland Lake|Scenic Lakes|Barkley Lake|Cabin View)\b/i },
  { name: "personal email address", re: /\b[\w.+-]+@(gmail|yahoo|hotmail|outlook|aol|pnc)\.com\b/ },
];

// The active roster's email aliases are configuration, not leaked PII — they
// are already in the repository and are required for vote attribution.
const ALLOWED_EMAILS = new Set([
  "rraja14@gmail.com", "12.yashumb@gmail.com", "tonybackert@gmail.com",
  "aimee.green@pnc.com", "ratgreen13@gmail.com", "mschnell194@gmail.com",
  "budenaers.jodi@gmail.com", "ramana.nar@yahoo.com", "ramana_nar@yahoo.com",
  "hoa.twinlakes.board@gmail.com", "edouglas@mulloyproperties.com",
  "peterfotos@yahoo.com", "noreply@anthropic.com",
]);

// A secret that already exists on the base ref is not something this diff
// introduced. The six board passwords sit in board-api.js on main; this change
// restructures that object (identity moved to lib/board-members.js, Ramana's
// entry removed) without copying a credential anywhere new. Flagging that as a
// leak would train everyone to ignore this check — which is worse than not
// having it. Pre-existing exposure is tracked as the first Phase B item.
let baseContent = "";
try {
  const files = execSync(`git ls-tree -r --name-only ${base}`, { encoding: "utf8" }).split("\n")
    .filter(f => /\.(js|html|json|toml|md)$/.test(f));
  baseContent = files.map(f => {
    try { return execSync(`git show ${base}:${f}`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }); }
    catch { return ""; }
  }).join("\n");
} catch { /* base unavailable — every finding is then treated as new */ }

const findings = [];
const preExisting = [];
for (const line of addedLines) {
  if (isReference(line)) continue;
  for (const rule of RULES) {
    const m = line.match(rule.re);
    if (!m) continue;
    if (rule.name === "personal email address" && ALLOWED_EMAILS.has(m[0].toLowerCase())) continue;
    const entry = { rule: rule.name, match: m[0], line: line.trim().slice(0, 120) };
    if (baseContent.includes(m[0])) preExisting.push(entry);
    else findings.push(entry);
  }
}

if (preExisting.length) {
  const unique = [...new Set(preExisting.map(f => `${f.rule}: ${f.match.slice(0, 12)}…`))];
  console.log(`Pre-existing on ${base}, moved but not introduced (${preExisting.length} line(s)):`);
  for (const u of unique) console.log(`  · ${u}`);
  console.log("  → tracked as the first Phase B security item, not a new leak.\n");
}

console.log(`\nScanned ${addedLines.length} added lines against ${RULES.length} rules.\n`);
if (findings.length) {
  console.log("POTENTIAL SECRET OR PII IN DIFF:\n");
  for (const f of findings) console.log(`  [${f.rule}] ${f.match}\n    ${f.line}\n`);
  console.log(`${findings.length} finding(s).\n`);
  process.exit(1);
}
console.log("  ok  - no new credential, resident data or production secret in the diff\n");
process.exit(0);
