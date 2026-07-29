"use strict";
// Clears the Board session cookie.
//
// Idempotent by design: the clearing cookie is returned whether or not a
// valid session was presented. A member holding an expired, malformed,
// tampered, or now-inactive session (Ramana) must still be able to get the
// stale cookie off their browser — refusing to log out someone whose session
// is already broken would strand them.

const auth = require("./lib/board-auth");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  return {
    statusCode: 200,
    headers: {
      "Set-Cookie": auth.clearSessionCookie(),
      "Cache-Control": "no-store",
    },
    body: JSON.stringify({ ok: true }),
  };
};
