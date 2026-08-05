"use strict";
// Shared Board roster — identity ONLY. This module is imported by
// board-api.js, board-session.js, board-logout.js and scan-inbox.js, so it
// deliberately contains no passwords, no secrets, no cookie/session logic
// and no permission functions. Credentials still live beside the login
// action in board-api.js (Phase B moves them to environment variables);
// keeping them out of here is what lets scan-inbox.js import the roster
// without ever pulling board credentials into the scanner's module graph.
//
// Authorization is driven by `access` ONLY. `displayTitle` is presentation
// text and must never be used to decide what someone may do — Yashu is Vice
// President with `admin`, Tony is President with `officer`.

// ── Access levels (ordered least → most privileged) ───────────
const ACCESS_LEVELS = ["member", "officer", "admin"];

// ── Roster ────────────────────────────────────────────────────
// status:
//   "active"     — may log in, hold a session, vote, be attributed votes
//   "historical" — no login, no session, no new votes; retained so past
//                  votes still count on the records they were cast on and
//                  so old forwarded email is still recognised as a forward
//
// voteFields: the ARC_Requests HEADER NAMES (never column letters — Phase A2
//   resolves letters from the live header). `null` means this member has no
//   vote columns in the sheet yet, so voting is not yet supported for them.
const MEMBERS = {
  raja: {
    key: "raja",
    displayName: "Raja Ravanan",
    displayTitle: "Secretary",
    access: "admin",
    status: "active",
    voteFields: { vote: "raja_vote", conditions: "raja_conditions", note: "raja_note", votedAt: "raja_voted_at" },
    emailAliases: ["rraja14@gmail.com"],
  },
  yashu: {
    key: "yashu",
    displayName: "Yashu M Basavaraju",
    displayTitle: "Vice President",
    access: "admin",
    status: "active",
    voteFields: { vote: "yashu_vote", conditions: "yashu_conditions", note: "yashu_note", votedAt: "yashu_voted_at" },
    emailAliases: ["12.yashumb@gmail.com"],
  },
  tony: {
    key: "tony",
    displayName: "Tony Backert",
    displayTitle: "President",
    access: "officer",
    status: "active",
    voteFields: { vote: "tony_vote", conditions: "tony_conditions", note: "tony_note", votedAt: "tony_voted_at" },
    emailAliases: ["tonybackert@gmail.com"],
  },
  aimee: {
    key: "aimee",
    displayName: "Aimee Green",
    displayTitle: "Member at Large",
    access: "member",
    status: "active",
    voteFields: { vote: "aimee_vote", conditions: "aimee_conditions", note: "aimee_note", votedAt: "aimee_voted_at" },
    emailAliases: ["aimee.green@pnc.com", "ratgreen13@gmail.com"],
  },
  mike: {
    key: "mike",
    displayName: "Mike Schnell",
    displayTitle: "Member at Large",
    access: "member",
    status: "active",
    voteFields: { vote: "mike_vote", conditions: "mike_conditions", note: "mike_note", votedAt: "mike_voted_at" },
    emailAliases: ["mschnell194@gmail.com"],
  },
  jodi: {
    key: "jodi",
    displayName: "Jodi Budenaers",
    displayTitle: "Member at Large",
    access: "member",
    status: "active",
    // Phase A2 adds jodi_* columns to ARC_Requests and populates this. Until
    // then voting is refused server-side with a clear error rather than
    // written to a range built from `undefined` (which silently lost the vote
    // while reporting success).
    voteFields: null,
    emailAliases: ["budenaers.jodi@gmail.com"],
  },
  ramana: {
    key: "ramana",
    displayName: "Ramana N",
    displayTitle: "Treasurer (former)",
    // No access level: resigned. Kept in the roster so (a) his recorded votes
    // still count toward the records they were cast on, and (b) email he
    // forwarded is still recognised as a board forward rather than being
    // attributed to him as the requesting homeowner.
    access: null,
    status: "historical",
    voteFields: { vote: "ramana_vote", conditions: "ramana_conditions", note: "ramana_note", votedAt: "ramana_voted_at" },
    emailAliases: ["ramana.nar@yahoo.com", "ramana_nar@yahoo.com"],
  },
};

// Board seats with no sitting member. Display only — no key, no credential,
// no session, no permissions, no vote mapping. Filling the seat is a
// deliberate code change (roster entry) plus a Phase A2 schema migration.
const VACANT_SEATS = [{ displayTitle: "Treasurer", status: "vacant", member: "TBD" }];

function getMember(key) {
  if (typeof key !== "string") return null;
  return Object.prototype.hasOwnProperty.call(MEMBERS, key) ? MEMBERS[key] : null;
}

// The only lookup the auth layer may use: an active member with an access
// level. Historical members resolve to null here by design.
function getActiveMember(key) {
  const m = getMember(key);
  if (!m || m.status !== "active" || !m.access) return null;
  return m;
}

function isActive(key) {
  return getActiveMember(key) !== null;
}

function listActive() {
  return Object.values(MEMBERS).filter((m) => m.status === "active" && m.access);
}

// Every member, active AND historical. Used for vote counting (a resigned
// member's recorded vote still counts on that record) and for recognising
// forwarded email. Never used for authorization.
function listAll() {
  return Object.values(MEMBERS);
}

// Members who can actually have a vote persisted today: active AND with
// vote columns declared. Jodi is excluded until Phase A2.
function listVotingMembers() {
  return listActive().filter((m) => m.voteFields);
}

function canVote(key) {
  const m = getActiveMember(key);
  return Boolean(m && m.voteFields);
}

function accessRank(access) {
  const i = ACCESS_LEVELS.indexOf(access);
  return i === -1 ? -1 : i;
}

// True when `access` meets or exceeds `required`.
function accessAtLeast(access, required) {
  const a = accessRank(access);
  const r = accessRank(required);
  return a !== -1 && r !== -1 && a >= r;
}

module.exports = {
  ACCESS_LEVELS,
  VACANT_SEATS,
  getMember,
  getActiveMember,
  isActive,
  listActive,
  listAll,
  listVotingMembers,
  canVote,
  accessRank,
  accessAtLeast,
};
