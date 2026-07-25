"use strict";
const { COOKIE_NAME, parseCookies, verifySession, jsonResponse } = require("./lib/resident-auth");

// Invalid, missing, or expired sessions return 200 {authenticated:false}
// rather than 401 — this is a routine state check, not an authorization
// failure, and it keeps the frontend's handling to a single branch.
exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const secret = process.env.RESIDENT_SESSION_SECRET;
  const version = process.env.RESIDENT_SESSION_VERSION;
  if (!secret || !version) {
    return jsonResponse(200, { authenticated: false });
  }

  const cookieHeader = event.headers && (event.headers.cookie || event.headers.Cookie);
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];
  const authenticated = token ? verifySession(token, secret, version) : false;

  return jsonResponse(200, { authenticated });
};
