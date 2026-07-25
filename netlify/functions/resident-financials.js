"use strict";
const { COOKIE_NAME, parseCookies, verifySession, jsonResponse } = require("./lib/resident-auth");

// Snapshot of board.html's BUDGET_DATA (board.html ~line 1524), duplicated
// here by owner's choice rather than moving to a shared Google Sheet tab.
// This WILL drift from the board's copy — when the board updates monthly
// actuals in board.html, update this object too, in the same change.
const AS_OF = "June 30, 2026";
const BUDGET_DATA = {
  master: { name: "Master HOA", tag: "m", budget: 133324, spent: 60549, cats: [
    ["🚜", "Lawn Cutting (common)", 45938, 19141],
    ["🗑️", "Trash Removal", 26730, 13110],
    ["💧", "Water", 15145, 4506],
    ["🐟", "Lake / Pond Maintenance", 10123, 3412],
    ["🏦", "Reserves (savings)", 6081, 3041],
    ["🏢", "Management Fees", 5346, 2664],
    ["💡", "Street Lights", 4992, 3265],
    ["❄️", "Snow Removal", 4000, 6816],
    ["🌿", "Landscape Maintenance", 2600, 0],
    ["⚡", "Common Area Electric", 2195, 315],
    ["🛡️", "Insurance", 2000, 2655],
    ["🦟", "Mosquito Treatments", 1717, 575],
    ["🌳", "Tree & Shrub Replacements", 1500, 0],
    ["🔧", "Irrigation Repair", 1225, 640],
    ["📎", "Office Expenses", 975, 310],
    ["🧾", "Tax Preparation", 750, 0],
    ["🔧", "Irrigation Maintenance", 625, 0],
    ["🎄", "Holiday Décor", 600, 0],
    ["🔨", "Maintenance & Repairs", 550, 0],
    ["⚖️", "Legal Fees", 216, 0],
    ["📄", "Annual Filing Fee", 15, 0],
    ["📦", "Miscellaneous (unbudgeted)", 0, 100],
  ] },
  garden: { name: "Garden Homes", tag: "g", budget: 154118, spent: 50547, cats: [
    ["🚜", "Lawn Cutting (homes)", 66780, 20034],
    ["💧", "Water – Irrigation", 29285, 4185],
    ["🧪", "Lawn Chemicals (TruGreen)", 10042, 3347],
    ["🍂", "Mulch – Homes", 9646, 8613],
    ["🏢", "Management Fees", 8350, 4170],
    ["♻️", "Recycling", 5428, 2694],
    ["🏦", "Reserves (savings)", 4665, 2333],
    ["✂️", "Trimming (2×/yr)", 4452, 0],
    ["🌳", "Tree & Shrub Replacements", 4000, 0],
    ["🔧", "Irrigation Maintenance", 2675, 3804],
    ["🌲", "Mulch – Street Trees", 2608, 458],
    ["🔧", "Irrigation Repair", 2500, 0],
    ["🌿", "Monthly Weeding", 2078, 534],
    ["🏡", "Landscape Maintenance", 1000, 0],
    ["📎", "Office Expenses", 360, 375],
    ["🍁", "Fall Clean-up", 250, 0],
  ] },
};

// Architecture note: this is a protected resource endpoint, not a login
// endpoint — it independently re-verifies the signed tl_resident_session
// cookie on every request (never assumes resident-portal.html's own
// redirect-on-failure already handled it). A missing/invalid session
// returns 401; that's fine here (unlike resident-login's generic-failure
// requirement) because there's no credential-guessing surface to protect.
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

  return jsonResponse(200, { asOf: AS_OF, ...BUDGET_DATA });
};
