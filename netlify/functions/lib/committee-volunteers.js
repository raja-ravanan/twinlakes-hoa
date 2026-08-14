"use strict";
/* ═══════════════════════════════════════════════════════════
   TWIN LAKES AT FLOYDS FORK — lib/committee-volunteers.js
   ───────────────────────────────────────────────────────────
   Shared validation/row-building for the Committee Volunteer
   Interest Form (committee-volunteer.html, submitted through
   submit-committee-volunteer.js). Writes to a dedicated
   "Committee_Volunteers" tab in the SAME spreadsheet
   (GOOGLE_SHEET_ID) everything else in this repo already uses.

   Reuses the Google token + Sheets transport already exported by
   lib/access-requests.js rather than re-implementing the same
   JWT-signing/HTTPS boilerplate a third time in this codebase.

   Committee names are the exact wording from the finalized
   "Twin Lakes Committee Volunteer Interest Form" PDF — that PDF
   is the source of truth; do not rename/add/remove committees
   here without updating the PDF first.
   ═══════════════════════════════════════════════════════════ */
const {
  stripControlChars,
  boundedText,
  sanitizeForSpreadsheet,
} = require("./resident-audit");

const TAB_NAME = (process.env.COMMITTEE_VOLUNTEERS_SHEET_NAME || "Committee_Volunteers").trim();

// Exact wording from the finalized PDF, section 2 (Committee Interest).
// "Other" is handled separately (see OTHER_VALUE) since it pairs with a
// free-text field rather than being a fixed name.
const COMMITTEES = [
  "Nomination Committee",
  "Social / Events Committee",
  "Architectural Review Committee (ARC)",
  "Beautification Committee",
  "Bylaw Committee",
  "Landscape & Grounds Committee",
  "Irrigation Committee",
  "Pond / Water Management Committee",
];
const OTHER_VALUE = "Other";
const CHOICE_VALUES = [...COMMITTEES, OTHER_VALUE];

// Column order is load-bearing — every read/write assumes this exact A:Q
// layout. Change it deliberately, together with the live sheet's row 1.
const HEADERS = [
  "Timestamp", "Name", "Property Address", "Email", "Phone",
  "Committees Selected", "First Choice", "Second Choice",
  "Skills / Experience", "Prior Committee Experience", "Prior Experience Details",
  "Interest / Contribution", "Conflict of Interest", "Conflict Details",
  "Acknowledgment", "Typed Name", "Status",
];

// Board-only extension columns (R:S) added for Committee Volunteer Interest
// tracking. Kept separate from HEADERS/A:Q rather than folded in, so a sheet
// that already has live resident submissions under the original 17-column
// header never fails ensureVolunteersTab's check — see
// ensureVolunteerExtHeaders, which self-heals these the same way
// board-api.js self-heals Announcements!G1:O1 / Minutes!H1.
const EXT_HEADERS = ["Notes", "Public Listing"];

// Suggested Board workflow statuses. "Interested" is the default a fresh
// submission is written with (see buildVolunteerRow) — a row may still carry
// the older literal "New" if it was submitted before this status existed;
// that's a legacy value, not an error, and the Board can move it forward.
const STATUSES = ["Interested", "Contacted", "Confirmed", "Not Selected", "Withdrew"];
function isValidStatus(v) { return STATUSES.includes(v); }

const MAX_NAME_LEN = 80;
const MAX_ADDRESS_LEN = 200;
const MAX_EMAIL_LEN = 200;
const MAX_PHONE_LEN = 30;
const MAX_OTHER_LEN = 100;
const MAX_SKILLS_LEN = 2000;
const MAX_EXPERIENCE_DETAILS_LEN = 1000;
const MAX_INTEREST_LEN = 2000;
const MAX_CONFLICT_DETAILS_LEN = 1000;
const MAX_BODY_BYTES = 8000;

const WRITE_TIMEOUT_MS = 4000;

// ── Input normalization ─────────────────────────────────────
function normalizeRequiredText(raw, maxLen) {
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function normalizeOptionalText(raw, maxLen) {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim();
  if (trimmed.length > maxLen) return null;
  return trimmed;
}

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = stripControlChars(raw).trim();
  if (!trimmed || trimmed.length > MAX_EMAIL_LEN) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeYesNo(raw) {
  return raw === "Yes" || raw === "No" ? raw : null;
}

// Prior committee/volunteer experience is optional (unlike Conflict of
// Interest, which is a required disclosure) — blank is valid, but a
// non-blank value must still be exactly "Yes" or "No".
function normalizeOptionalYesNo(raw) {
  if (raw == null || raw === "") return "";
  return raw === "Yes" || raw === "No" ? raw : null;
}

// Server-side allowlist check for the committee checkboxes. Accepts an
// array of strings; every entry must be an exact COMMITTEES name or the
// literal "Other" (which requires non-blank otherText — checked by the
// caller, see validateSubmission). Anything else fails closed.
function normalizeCommittees(raw, otherText) {
  if (!Array.isArray(raw)) return null;
  const deduped = [...new Set(raw.map((v) => (typeof v === "string" ? v.trim() : "")))].filter(Boolean);
  if (deduped.length === 0) return null;
  for (const v of deduped) {
    if (v === OTHER_VALUE) {
      if (!otherText) return null; // "Other" checked but no text supplied
      continue;
    }
    if (!COMMITTEES.includes(v)) return null;
  }
  return deduped;
}

// First/Second Choice are optional; if provided, must be a known
// committee name or "Other" (paired with otherText, same as above).
function normalizeChoice(raw, otherText) {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === OTHER_VALUE) return otherText ? trimmed : null;
  return CHOICE_VALUES.includes(trimmed) ? trimmed : null;
}

// Central validation for the public POST body. Returns { ok:true, fields }
// or { ok:false, error } or { ok:false, honeypot:true }.
function validateSubmission(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: "Malformed request." };
  }
  if (typeof data.website === "string" && data.website.trim() !== "") {
    return { ok: false, honeypot: true };
  }

  const name = normalizeRequiredText(data.name, MAX_NAME_LEN);
  const address = normalizeRequiredText(data.address, MAX_ADDRESS_LEN);
  const email = normalizeEmail(data.email);
  const phone = normalizeOptionalText(data.phone, MAX_PHONE_LEN);

  const otherText = normalizeOptionalText(data.otherCommittee, MAX_OTHER_LEN);
  if (otherText === null) return { ok: false, error: "The 'Other' committee description is too long." };

  const committees = normalizeCommittees(data.committees, otherText);
  const firstChoice = normalizeChoice(data.firstChoice, otherText);
  const secondChoice = normalizeChoice(data.secondChoice, otherText);

  const skills = normalizeOptionalText(data.skills, MAX_SKILLS_LEN);

  const priorExperience = normalizeOptionalYesNo(data.priorExperience);
  const priorExperienceDetailsRaw = normalizeOptionalText(data.priorExperienceDetails, MAX_EXPERIENCE_DETAILS_LEN);

  const interest = normalizeOptionalText(data.interest, MAX_INTEREST_LEN);

  const conflict = normalizeYesNo(data.conflict);
  const conflictDetailsRaw = normalizeOptionalText(data.conflictDetails, MAX_CONFLICT_DETAILS_LEN);

  const acknowledged = data.acknowledged === true;
  const typedName = normalizeRequiredText(data.typedName, MAX_NAME_LEN);

  if (!name || !address) {
    return { ok: false, error: "Please complete your name and property address." };
  }
  if (!email) {
    return { ok: false, error: "Please enter a valid email address." };
  }
  if (phone === null) {
    return { ok: false, error: "Phone number is too long." };
  }
  if (!committees) {
    return { ok: false, error: "Please select at least one committee." };
  }
  if (firstChoice === null || secondChoice === null) {
    return { ok: false, error: "Please choose a valid committee for your first/second choice." };
  }
  // If provided, First/Second Choice must be among the committees this
  // resident actually checked — not just anywhere on the master allowlist.
  if (firstChoice && !committees.includes(firstChoice)) {
    return { ok: false, error: "First Choice must be one of the committees you checked above." };
  }
  if (secondChoice && !committees.includes(secondChoice)) {
    return { ok: false, error: "Second Choice must be one of the committees you checked above." };
  }
  if (firstChoice && secondChoice && firstChoice === secondChoice) {
    return { ok: false, error: "First Choice and Second Choice must be different." };
  }
  if (skills === null) {
    return { ok: false, error: "Skills & experience is too long — please shorten and try again." };
  }
  if (priorExperience === null) {
    return { ok: false, error: "Prior committee/volunteer experience must be answered Yes or No." };
  }
  if (priorExperienceDetailsRaw === null) {
    return { ok: false, error: "Prior experience details are too long — please shorten and try again." };
  }
  if (interest === null) {
    return { ok: false, error: "Interest & contribution is too long — please shorten and try again." };
  }
  if (!conflict) {
    return { ok: false, error: "Please answer the conflict of interest question." };
  }
  if (conflictDetailsRaw === null) {
    return { ok: false, error: "Conflict of interest details are too long — please shorten and try again." };
  }
  if (conflict === "Yes" && !conflictDetailsRaw) {
    return { ok: false, error: "Please briefly explain the potential conflict." };
  }
  if (!acknowledged) {
    return { ok: false, error: "Please check the acknowledgment box to submit." };
  }
  if (!typedName) {
    return { ok: false, error: "Please type your name to certify your submission." };
  }

  // "Other" committee is stored as "Other: <text>" in the sheet/emails so a
  // board reviewer sees the resident's actual description, not just "Other".
  const committeesDisplay = committees.map((c) => (c === OTHER_VALUE ? `Other: ${otherText}` : c));
  const firstChoiceDisplay = firstChoice === OTHER_VALUE ? `Other: ${otherText}` : firstChoice;
  const secondChoiceDisplay = secondChoice === OTHER_VALUE ? `Other: ${otherText}` : secondChoice;

  return {
    ok: true,
    fields: {
      name, address, email, phone,
      committees: committeesDisplay,
      firstChoice: firstChoiceDisplay,
      secondChoice: secondChoiceDisplay,
      skills,
      priorExperience,
      priorExperienceDetails: priorExperienceDetailsRaw,
      interest,
      conflict,
      conflictDetails: conflict === "Yes" ? conflictDetailsRaw : "",
      typedName,
    },
  };
}

function nowIsoUtc() {
  return new Date().toISOString();
}

// ── Row construction (pure — no I/O, directly testable) ────────
function buildVolunteerRow(fields) {
  return [
    nowIsoUtc(),
    sanitizeForSpreadsheet(boundedText(fields.name, MAX_NAME_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.address, MAX_ADDRESS_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.email, MAX_EMAIL_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.phone || "", MAX_PHONE_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.committees.join("; "), 500)),
    sanitizeForSpreadsheet(boundedText(fields.firstChoice || "", MAX_OTHER_LEN + 20)),
    sanitizeForSpreadsheet(boundedText(fields.secondChoice || "", MAX_OTHER_LEN + 20)),
    sanitizeForSpreadsheet(boundedText(fields.skills || "", MAX_SKILLS_LEN)),
    fields.priorExperience,
    sanitizeForSpreadsheet(boundedText(fields.priorExperienceDetails || "", MAX_EXPERIENCE_DETAILS_LEN)),
    sanitizeForSpreadsheet(boundedText(fields.interest, MAX_INTEREST_LEN)),
    fields.conflict,
    sanitizeForSpreadsheet(boundedText(fields.conflictDetails || "", MAX_CONFLICT_DETAILS_LEN)),
    "Yes",
    sanitizeForSpreadsheet(boundedText(fields.typedName, MAX_NAME_LEN)),
    "Interested",
  ];
}

// ── Sheets transport — reused from lib/access-requests.js, not
// re-implemented here (same spreadsheet, same service account). ──
const {
  getGoogleToken,
  httpsReq,
  sheetsGet,
  sheetsUpdate,
  sheetsAppend,
  withTimeout,
} = require("./access-requests");

// Cached per warm container, same pattern as ensureAccessRequestsTab /
// ensureAuditTab. Never blindly overwrites an existing header.
let tabEnsured = false;

async function ensureVolunteersTab(token) {
  if (tabEnsured) return;
  const meta = await httpsReq("GET", "sheets.googleapis.com",
    `/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}`, { Authorization: `Bearer ${token}` });
  const spreadsheet = JSON.parse(meta.body);
  const existing = (spreadsheet.sheets || []).map((s) => s.properties.title);

  if (!existing.includes(TAB_NAME)) {
    await httpsReq("POST", "sheets.googleapis.com",
      `/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}:batchUpdate`,
      { Authorization: `Bearer ${token}` },
      { requests: [{ addSheet: { properties: { title: TAB_NAME } } }] });
    await sheetsUpdate(token, `'${TAB_NAME}'!A1`, [HEADERS]);
    tabEnsured = true;
    return;
  }

  const headerRange = `'${TAB_NAME}'!A1:${String.fromCharCode(64 + HEADERS.length)}1`;
  const headerResult = await sheetsGet(token, headerRange);
  const existingHeader = (headerResult.values && headerResult.values[0]) || [];

  if (existingHeader.length === 0) {
    await sheetsUpdate(token, `'${TAB_NAME}'!A1`, [HEADERS]);
    tabEnsured = true;
    return;
  }

  // Prefix match, not exact-length match: the Board-only extension columns
  // (R:S, see EXT_HEADERS) live past column Q and are self-healed separately
  // by ensureVolunteerExtHeaders, so their presence/absence here must never
  // fail this check — a live sheet with real resident submissions already
  // has exactly the base A:Q header and nothing past it.
  const headerMatches = HEADERS.every((h, i) => existingHeader[i] === h);
  if (!headerMatches) {
    throw new Error("committee_volunteers_header_mismatch");
  }
  tabEnsured = true;
}

// Self-heals the R1:S1 extension header (Notes, Public Listing) the same way
// board-api.js self-heals Announcements!G1:O1 / Minutes!H1 — called before
// any board-portal read or write that touches these columns, never by the
// public submission endpoint. Idempotent; cheap enough to call on every
// admin request rather than caching like ensureVolunteersTab's tabEnsured.
async function ensureVolunteerExtHeaders(token) {
  const range = `'${TAB_NAME}'!R1:S1`;
  const result = await sheetsGet(token, range);
  const existing = (result.values && result.values[0]) || [];
  const matches = existing.length === EXT_HEADERS.length && EXT_HEADERS.every((h, i) => existing[i] === h);
  if (!matches) {
    await sheetsUpdate(token, range, [EXT_HEADERS]);
  }
}

module.exports = {
  TAB_NAME,
  HEADERS,
  EXT_HEADERS,
  STATUSES,
  isValidStatus,
  COMMITTEES,
  OTHER_VALUE,
  MAX_NAME_LEN,
  MAX_ADDRESS_LEN,
  MAX_EMAIL_LEN,
  MAX_BODY_BYTES,
  WRITE_TIMEOUT_MS,
  normalizeRequiredText,
  normalizeOptionalText,
  normalizeEmail,
  normalizeYesNo,
  normalizeOptionalYesNo,
  normalizeCommittees,
  normalizeChoice,
  validateSubmission,
  nowIsoUtc,
  buildVolunteerRow,
  getGoogleToken,
  httpsReq,
  sheetsGet,
  sheetsUpdate,
  sheetsAppend,
  ensureVolunteersTab,
  ensureVolunteerExtHeaders,
  withTimeout,
};
