"use strict";
const {
  COOKIE_NAME,
  parseCookies,
  getValidSessionPayload,
  buildClearCookie,
  jsonResponse,
} = require("./lib/resident-auth");
const {
  appendAuditEvent,
  trustedClientIp,
  hashIp,
  boundedUserAgent,
  deriveSessionReference,
} = require("./lib/resident-audit");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  // Cookie clearing below must happen no matter what this section finds —
  // an invalid/expired/missing session still gets a normal logout response.
  const secret = process.env.RESIDENT_SESSION_SECRET;
  const version = process.env.RESIDENT_SESSION_VERSION;
  const cookieHeader = event.headers && (event.headers.cookie || event.headers.Cookie);
  const token = parseCookies(cookieHeader)[COOKIE_NAME];

  let sessionReference = "";
  if (token && secret && version) {
    const payload = getValidSessionPayload(token, secret, version);
    if (payload && payload.sid) {
      sessionReference = deriveSessionReference(payload.sid, secret);
    }
  }

  // Fail-open: appendAuditEvent never throws, so this await can never
  // prevent the cookie from being cleared below, even if Sheets is down,
  // slow, or misconfigured.
  await appendAuditEvent({
    eventType: "LOGOUT",
    sessionReference,
    ipHash: hashIp(trustedClientIp(event.headers)),
    userAgent: boundedUserAgent(event.headers),
    source: "resident-portal",
  });

  return jsonResponse(200, { ok: true }, { "Set-Cookie": buildClearCookie() });
};
