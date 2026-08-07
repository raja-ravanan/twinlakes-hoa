"use strict";
// Board Portal session, cookie, permission and CSRF layer.
//
// Contains NO roster data (see lib/board-members.js) and NO credentials
// (those still sit beside the login action in board-api.js). scan-inbox.js
// imports this module to authorize the scan trigger, so nothing
// password-shaped may ever be added here.
//
// The session format deliberately mirrors the resident portal's proven
// implementation (lib/resident-auth.js): `payloadB64.hmacB64`, verified
// through exactly one code path, with purpose/version/expiry checks.

const crypto = require("crypto");
const members = require("./board-members");

const COOKIE_NAME = "tl_board_session";
const SESSION_PURPOSE = "board-session";
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8h — matches the previous token lifetime
const CSRF_HEADER = "x-board-request";

// ── Config ────────────────────────────────────────────────────
// Fails closed: without both values no session can be issued or verified.
function loadConfig() {
  const secret = process.env.BOARD_SESSION_SECRET;
  const version = process.env.BOARD_SESSION_VERSION;
  if (!secret || !version) return null;
  return { secret, version };
}

// ── Session token ─────────────────────────────────────────────
// Payload carries identity only — no title, no access level, no admin flag,
// no permission list. Everything privilege-related is resolved from
// board-members.js on every single request, so a roster change (a
// resignation, a demotion) takes effect immediately without re-login and no
// privilege claim ever travels on the wire.
function signSession(secret, version, sub) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    purpose: SESSION_PURPOSE,
    v: version,
    sub,
    iat: now,
    exp: now + SESSION_MAX_AGE_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

// Single verification path. Returns the decoded payload or null.
//
// Legacy unsigned tokens were `base64(JSON{...})`. The base64 alphabet
// contains no ".", so such a token cannot split into two parts and is
// rejected by the shape check below before anything else happens.
function decodeAndVerifySession(token, secret, expectedVersion) {
  if (typeof token !== "string" || token.indexOf(".") === -1) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  if (payload.purpose !== SESSION_PURPOSE) return null;
  if (String(payload.v) !== String(expectedVersion)) return null;
  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) >= payload.exp) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  return payload;
}

// Resolves a request's cookie into a live session context, or null.
// A session naming someone who is no longer an active member (Ramana) fails
// here — the signature is valid, but the person is not.
function getSessionContext(event) {
  const config = loadConfig();
  if (!config) return null;
  const token = parseCookies(event.headers && (event.headers.cookie || event.headers.Cookie))[COOKIE_NAME];
  if (!token) return null;
  const payload = decodeAndVerifySession(token, config.secret, config.version);
  if (!payload) return null;
  const member = members.getActiveMember(payload.sub);
  if (!member) return null;
  return {
    username: member.key,
    displayName: member.displayName,
    displayTitle: member.displayTitle,
    access: member.access,
    canVote: Boolean(member.voteFields),
    iat: payload.iat,
    exp: payload.exp,
  };
}

// ── Cookie helpers ────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  if (typeof header !== "string" || !header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function buildSessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// ── Permission table ──────────────────────────────────────────
// DEFAULT DENY. An action absent from this table is refused with 403 — the
// table is the complete list of things the Board API will do.
//
//   access  : minimum access level ("member" | "officer" | "admin"), or
//             "public" for the unauthenticated endpoints
//   keys    : optional allow-list of member keys that must ALSO match
//   mutates : true when the action writes; drives Origin/Referer validation
const PERMISSIONS = {
  // ── Public (no session) ──
  login:                     { access: "public", mutates: true },
  getPublicAnnouncements:    { access: "public", mutates: false },
  getPublicMinutes:          { access: "public", mutates: false },
  getPublicSettings:         { access: "public", mutates: false },

  // ── Any active board member ──
  getDashboard:              { access: "member", mutates: false },
  getResidents:              { access: "member", mutates: false },
  getAccessRequests:         { access: "member", mutates: false },
  getAccessRequestPreview:   { access: "member", mutates: false },
  getEmailPreview:           { access: "member", mutates: false },
  updateRequestStatus:       { access: "member", mutates: true },
  addRequestNote:            { access: "member", mutates: true },
  updateAccessRequestStatus: { access: "member", mutates: true },
  addAccessRequestNote:      { access: "member", mutates: true },
  addComment:                { access: "member", mutates: true },
  updateStatus:              { access: "member", mutates: true },
  castVote:                  { access: "member", mutates: true },
  addAnnouncement:           { access: "member", mutates: true },
  updateAnnouncement:        { access: "member", mutates: true },

  // ── Officers and admins ──
  deleteAnnouncement:        { access: "officer", mutates: true },
  addMinutes:                { access: "officer", mutates: true },
  updateMinutes:             { access: "officer", mutates: true },
  deleteMinutes:             { access: "officer", mutates: true },
  sendAccessResponse:        { access: "officer", mutates: true },
  sendNotification:          { access: "officer", mutates: true },
  updateARC:                 { access: "officer", mutates: true },
  addARC:                    { access: "officer", mutates: true },

  // ── Admins only ──
  // Capability marker rather than a dispatchable action: it gates the
  // Activity Log tab in the portal and the `activity` payload in
  // getDashboard. Declared here so the hint and the server agree on one rule.
  viewDiagnostics:           { access: "admin", mutates: false },
  setSetting:                { access: "admin", mutates: true },
  deleteARC:                 { access: "admin", mutates: true },
  deleteRequest:             { access: "admin", mutates: true },
  deleteAccessRequest:       { access: "admin", mutates: true },
  // Recording a vote on another member's behalf is restricted to the two
  // technical administrators by name, not merely by access level, so adding
  // a future admin does not silently grant vote override.
  adminSetVotes:             { access: "admin", keys: ["raja", "yashu"], mutates: true },
  runScan:                   { access: "admin", mutates: true },
};

function getPermission(action) {
  if (typeof action !== "string") return null;
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, action) ? PERMISSIONS[action] : null;
}

function isPublicAction(action) {
  const p = getPermission(action);
  return Boolean(p && p.access === "public");
}

// Every permission this session satisfies. UI hints only — the server
// re-checks on every request regardless of what the client believes.
function permissionsFor(session) {
  if (!session) return [];
  return Object.keys(PERMISSIONS).filter((action) => {
    const p = PERMISSIONS[action];
    if (p.access === "public") return false;
    if (!members.accessAtLeast(session.access, p.access)) return false;
    if (p.keys && !p.keys.includes(session.username)) return false;
    return true;
  });
}

// ── CSRF ──────────────────────────────────────────────────────
function headerValue(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

// The custom header cannot be set by a cross-origin request without a CORS
// preflight, and this API answers no preflight for authenticated actions.
function hasBoardRequestHeader(event) {
  return String(headerValue(event, CSRF_HEADER) || "") === "1";
}

// Same-origin check for state-changing actions. Compared against the
// request's own Host so deploy previews, localhost and any future custom
// domain all work without a hardcoded allow-list.
function isSameOrigin(event) {
  const host = String(headerValue(event, "host") || "");
  if (!host) return false;
  const origin = headerValue(event, "origin");
  const referer = headerValue(event, "referer");
  const candidate = origin || referer;
  if (!candidate) return false;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false;
  }
}

// ── Authorization ─────────────────────────────────────────────
// Returns null when allowed, or an HTTP response when denied.
function authorize(event, action, session) {
  const permission = getPermission(action);

  // Default deny — unknown or undeclared actions never reach a handler.
  if (!permission) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  if (permission.access === "public") {
    return null;
  }

  if (!session) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (!hasBoardRequestHeader(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  if (permission.mutates && !isSameOrigin(event)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  if (!members.accessAtLeast(session.access, permission.access)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  if (permission.keys && !permission.keys.includes(session.username)) {
    return { statusCode: 403, body: JSON.stringify({ error: "Forbidden" }) };
  }

  return null;
}

module.exports = {
  COOKIE_NAME,
  CSRF_HEADER,
  SESSION_PURPOSE,
  SESSION_MAX_AGE_SECONDS,
  PERMISSIONS,
  loadConfig,
  signSession,
  decodeAndVerifySession,
  getSessionContext,
  parseCookies,
  buildSessionCookie,
  clearSessionCookie,
  getPermission,
  isPublicAction,
  permissionsFor,
  hasBoardRequestHeader,
  isSameOrigin,
  authorize,
};
