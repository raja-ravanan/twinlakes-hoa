"use strict";
const { COOKIE_NAME, parseCookies, verifySession, jsonResponse } = require("./lib/resident-auth");
const {
  COMMITTEES,
  TAB_NAME,
  getGoogleToken,
  sheetsGet,
  ensureVolunteersTab,
  ensureVolunteerExtHeaders,
} = require("./lib/committee-volunteers");

// Short, neutral scope descriptions for the Resident Portal's Community
// Committees cards. Cosmetic copy, not sourced from a governing document —
// keep to general scope language, matching the "Committee Role and
// Authority" section already on committee-volunteer.html.
const DESCRIPTIONS = {
  "Nomination Committee": "Helps identify and vet candidates for open Board of Directors seats ahead of elections.",
  "Social / Events Committee": "Plans community gatherings and social events for Twin Lakes residents.",
  "Architectural Review Committee (ARC)": "Reviews resident requests for exterior changes — fences, decks, paint, and similar modifications.",
  "Beautification Committee": "Supports projects that improve the appearance of common areas and community entrances.",
  "Bylaw Committee": "Reviews and recommends updates to the HOA's governing documents.",
  "Landscape & Grounds Committee": "Supports oversight of common-area landscaping and grounds maintenance.",
  "Irrigation Committee": "Supports oversight of the community's irrigation systems and related maintenance.",
  "Pond / Water Management Committee": "Supports oversight of the community's ponds and water management.",
};
const OTHER_NAME = "Other";
const OTHER_DESCRIPTION = "Residents interested in an area not covered by an existing committee.";

// Board-appointed committee rosters aren't tracked anywhere yet (no chair /
// members / open-seats data source exists — see committee-volunteer.html's
// future-proofing notes). Empty until that's built; a committee's card then
// simply shows no current members rather than fabricating any.
const COMMITTEE_MEMBERS = {};

async function getSheetData(token, tab) {
  const res = await sheetsGet(token, `'${tab}'!A:S`);
  const rows = res.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ""; });
    return obj;
  });
}

// Architecture note (mirrors resident-financials.js): protected resource
// endpoint, independently re-verifies the signed tl_resident_session cookie
// on every request. Only Name + Committees Selected are ever read out of the
// sheet rows below — Address, Email, Phone, Notes, and Status are never
// touched by this function, let alone returned, so there is no path by which
// they could leak into the Resident Portal response.
exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const secret = process.env.RESIDENT_SESSION_SECRET;
  const version = process.env.RESIDENT_SESSION_VERSION;
  if (!secret || !version) {
    return jsonResponse(500, { error: "Resident portal is temporarily unavailable. Please try again later." });
  }

  const cookieHeader = event.headers && (event.headers.cookie || event.headers.Cookie);
  const token = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!token || !verifySession(token, secret, version)) {
    return jsonResponse(401, { error: "Not authenticated." });
  }

  const byName = new Map(COMMITTEES.map((name) => [name, { name, description: DESCRIPTIONS[name] || "", members: COMMITTEE_MEMBERS[name] || [], interested: [] }]));
  const other = { name: OTHER_NAME, description: OTHER_DESCRIPTION, members: COMMITTEE_MEMBERS[OTHER_NAME] || [], interested: [] };
  let hasOther = false;

  try {
    const googleToken = await getGoogleToken();
    await ensureVolunteersTab(googleToken);
    await ensureVolunteerExtHeaders(googleToken);
    const rows = await getSheetData(googleToken, TAB_NAME);

    for (const row of rows) {
      if (!row["Timestamp"]) continue;
      if ((row["Public Listing"] || "").trim().toLowerCase() !== "yes") continue;
      const name = (row["Name"] || "").trim();
      if (!name) continue;

      const selections = (row["Committees Selected"] || "").split(";").map((s) => s.trim()).filter(Boolean);
      for (const selection of selections) {
        const bucket = selection.startsWith("Other:") || selection === "Other" ? other : byName.get(selection);
        if (!bucket) continue; // unrecognized value — fail closed, don't guess a bucket
        if (bucket === other) hasOther = true;
        if (!bucket.interested.includes(name)) bucket.interested.push(name);
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ residentCommitteesLoadFailed: true, category: String(err && err.message || err).slice(0, 100) }));
    return jsonResponse(502, { error: "Committee information could not be loaded right now. Please try again shortly." });
  }

  const committees = [...byName.values()];
  if (hasOther) committees.push(other);

  return jsonResponse(200, { committees });
};
