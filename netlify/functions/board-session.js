"use strict";
// Returns the current Board member's profile for the portal UI.
//
// This exists because the session cookie is HttpOnly — the browser can no
// longer read who it is signed in as. Everything returned here is resolved
// server-side from the roster on this request; the client is told what it
// MAY see, but every action is authorized again server-side regardless.
// Mirrors resident-session.js.

const auth = require("./lib/board-auth");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const session = auth.getSessionContext(event);
  if (!session) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  return {
    statusCode: 200,
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify({
      username: session.username,
      displayName: session.displayName,
      displayTitle: session.displayTitle,
      access: session.access,
      canVote: session.canVote,
      permissions: auth.permissionsFor(session),
    }),
  };
};
