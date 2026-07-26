"use strict";
const {
  MAX_BODY_BYTES,
  normalizeHouseNumber,
  normalizeLastName,
  validatePassword,
  constantTimeEqual,
  loadConfig,
  findResident,
  signSession,
  buildSessionCookie,
  jsonResponse,
  delay,
  randomFailureDelayMs,
} = require("./lib/resident-auth");
const { fetchResidentDirectory } = require("./lib/resident-directory");
const {
  appendAuditEvent,
  trustedClientIp,
  hashIp,
  boundedUserAgent,
  deriveSessionReference,
} = require("./lib/resident-audit");

const GENERIC_FAILURE =
  "We could not verify your resident access information. Please review your entries and try again.";

exports.handler = async (event) => {
  const baseAudit = {
    source: "resident-portal",
    ipHash: hashIp(trustedClientIp(event.headers)),
    userAgent: boundedUserAgent(event.headers),
  };

  if (event.httpMethod !== "POST") {
    await appendAuditEvent({ ...baseAudit, eventType: "LOGIN_FAILURE", failureCategory: "UNSUPPORTED_METHOD" });
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const rawBody = event.body || "";
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    await appendAuditEvent({ ...baseAudit, eventType: "LOGIN_FAILURE", failureCategory: "INVALID_INPUT" });
    return jsonResponse(400, { error: "Request too large." });
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    await appendAuditEvent({ ...baseAudit, eventType: "LOGIN_FAILURE", failureCategory: "MALFORMED_REQUEST" });
    return jsonResponse(400, { error: "Malformed request." });
  }
  if (!data || typeof data !== "object") {
    await appendAuditEvent({ ...baseAudit, eventType: "LOGIN_FAILURE", failureCategory: "MALFORMED_REQUEST" });
    return jsonResponse(400, { error: "Malformed request." });
  }

  const houseNumber = normalizeHouseNumber(data.houseNumber);
  const lastName = normalizeLastName(data.lastName);
  const password = validatePassword(data.password);

  if (!houseNumber || !lastName || !password) {
    // Only the fields that individually passed normalization are stored —
    // never the raw submitted values (they may be oversized, malformed, or
    // contain markup/control characters).
    await appendAuditEvent({
      ...baseAudit,
      eventType: "LOGIN_FAILURE",
      failureCategory: "INVALID_INPUT",
      houseNumber: houseNumber || "",
      lastName: lastName || "",
    });
    return jsonResponse(400, { error: "Please complete all fields." });
  }

  const config = loadConfig();
  if (!config) {
    // Fail closed: missing/malformed server configuration is never the
    // resident's fault, but we still reveal no internal detail.
    await appendAuditEvent({
      ...baseAudit,
      eventType: "LOGIN_FAILURE",
      failureCategory: "CONFIGURATION_ERROR",
      houseNumber,
      lastName,
    });
    return jsonResponse(500, { error: "Resident portal is temporarily unavailable. Please try again later." });
  }

  // The directory is read live from the "TL Directory" Google Sheet on
  // every attempt (not cached, not an env var — see lib/resident-directory.js
  // for why). This is part of the auth data path, so a fetch failure fails
  // closed, same as a missing password/secret above — never silently let
  // anyone through because eligibility couldn't be checked.
  let directory;
  try {
    directory = await fetchResidentDirectory();
  } catch {
    await appendAuditEvent({
      ...baseAudit,
      eventType: "LOGIN_FAILURE",
      failureCategory: "CONFIGURATION_ERROR",
      houseNumber,
      lastName,
    });
    return jsonResponse(500, { error: "Resident portal is temporarily unavailable. Please try again later." });
  }

  const residentOk = findResident(directory, houseNumber, lastName);
  const passwordOk = constantTimeEqual(password, config.password);

  if (!residentOk || !passwordOk) {
    // Same generic response either way — never reveal which check failed.
    // The internal failure category (for board diagnosis only) DOES
    // distinguish them, but it is never returned to the browser.
    await delay(randomFailureDelayMs());
    await appendAuditEvent({
      ...baseAudit,
      eventType: "LOGIN_FAILURE",
      failureCategory: residentOk ? "INVALID_PASSWORD" : "INVALID_RESIDENT",
      houseNumber,
      lastName,
      householdMatch: residentOk,
    });
    return jsonResponse(401, { error: GENERIC_FAILURE });
  }

  const { token, sid } = signSession(config.secret, config.version);
  await appendAuditEvent({
    ...baseAudit,
    eventType: "LOGIN_SUCCESS",
    houseNumber,
    lastName,
    householdMatch: true,
    sessionReference: deriveSessionReference(sid, config.secret),
  });
  return jsonResponse(200, { ok: true }, { "Set-Cookie": buildSessionCookie(token) });
};
