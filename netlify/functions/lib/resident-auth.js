"use strict";
// Shared utility for the resident-login / resident-session / resident-logout
// functions. Not itself a Netlify function (lives in a subdirectory so the
// bundler won't register it as an endpoint).
const crypto = require("crypto");

const COOKIE_NAME = "tl_resident_session";
const SESSION_PURPOSE = "resident_session";
const SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60; // 14 days

const MAX_HOUSE_NUMBER_LEN = 10;
const MAX_LAST_NAME_LEN = 60;
const MAX_PASSWORD_LEN = 200;
const MAX_BODY_BYTES = 3000;

// ── Input normalization ─────────────────────────────────────
// House Number and Last Name are eligibility checks, not secrets — invalid
// input fails closed (rejected outright) rather than having characters
// stripped, so unrelated names can never be coerced into matching.
function normalizeHouseNumber(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HOUSE_NUMBER_LEN) return null;
  if (!/^[A-Za-z0-9-]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function normalizeLastName(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_LAST_NAME_LEN) return null;
  if (!/^[A-Za-z' -]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

// The shared password is opaque: no trimming, no case changes, no character
// substitution — only a length ceiling is enforced.
function validatePassword(raw) {
  if (typeof raw !== "string") return null;
  if (!raw || raw.length > MAX_PASSWORD_LEN) return null;
  return raw;
}

// ── Constant-time comparison ─────────────────────────────────
// Both sides are hashed to a fixed 32-byte digest first so differing input
// lengths can't leak timing information.
function constantTimeEqual(a, b) {
  const bufA = crypto.createHash("sha256").update(String(a)).digest();
  const bufB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Auth config (password + session signing) ──────────────────
// The resident directory itself is NOT loaded here — it's fetched live
// from the "TL Directory" Google Sheet (see lib/resident-directory.js).
// The full ~140-household list runs ~7KB, which exceeds Netlify's
// per-value environment variable size limit (~5KB); a live Sheet read has
// no such ceiling and lets the board add/remove residents without a
// redeploy.
function loadConfig() {
  const password = process.env.RESIDENT_PORTAL_PASSWORD;
  const secret = process.env.RESIDENT_SESSION_SECRET;
  const version = process.env.RESIDENT_SESSION_VERSION;
  if (!password || !secret || !version) return null;
  return { password, secret, version };
}

function findResident(directory, normalizedHouseNumber, normalizedLastName) {
  return directory.some((entry) => {
    return (
      normalizeHouseNumber(entry.houseNumber) === normalizedHouseNumber &&
      normalizeLastName(entry.lastName) === normalizedLastName
    );
  });
}

// ── Session token (stateless, HMAC-signed) ───────────────────
// Payload deliberately carries no resident-identifying data — a valid
// session proves only that the browser passed resident verification.
// `sid` is a random opaque correlator (not derived from anything secret)
// used only so the audit log can link a LOGIN_SUCCESS row to its later
// LOGOUT row — see netlify/functions/lib/resident-audit.js.
function signSession(secret, version) {
  const now = Math.floor(Date.now() / 1000);
  const sid = crypto.randomBytes(16).toString("hex");
  const payload = {
    purpose: SESSION_PURPOSE,
    iat: now,
    exp: now + SESSION_MAX_AGE_SECONDS,
    v: version,
    sid,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return { token: `${payloadB64}.${sig}`, sid };
}

// Verifies signature/expiry/purpose/version and returns the decoded payload,
// or null if the token is missing/tampered/expired/wrong-version. Shared by
// verifySession (boolean) and getValidSessionPayload (payload, for logout's
// audit-reference derivation) so there's exactly one verification path.
function decodeAndVerifySession(token, secret, expectedVersion) {
  if (typeof token !== "string" || token.indexOf(".") === -1) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.purpose !== SESSION_PURPOSE) return null;
  if (typeof payload.exp !== "number" || Math.floor(Date.now() / 1000) >= payload.exp) return null;
  if (String(payload.v) !== String(expectedVersion)) return null;
  return payload;
}

function verifySession(token, secret, expectedVersion) {
  return decodeAndVerifySession(token, secret, expectedVersion) !== null;
}

function getValidSessionPayload(token, secret, expectedVersion) {
  return decodeAndVerifySession(token, secret, expectedVersion);
}

// ── Cookie helpers ────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function buildSessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function buildClearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ── Response / timing helpers ────────────────────────────────
function jsonResponse(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A small randomized delay (300-700ms) on failed logins only — not durable
// rate limiting, just friction against naive brute-forcing.
function randomFailureDelayMs() {
  return 300 + Math.floor(Math.random() * 400);
}

module.exports = {
  COOKIE_NAME,
  MAX_BODY_BYTES,
  MAX_HOUSE_NUMBER_LEN,
  MAX_LAST_NAME_LEN,
  MAX_PASSWORD_LEN,
  normalizeHouseNumber,
  normalizeLastName,
  validatePassword,
  constantTimeEqual,
  loadConfig,
  findResident,
  signSession,
  verifySession,
  getValidSessionPayload,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  jsonResponse,
  delay,
  randomFailureDelayMs,
};
