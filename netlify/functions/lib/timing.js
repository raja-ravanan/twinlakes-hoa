"use strict";
// Small timing/comparison helpers shared by the board auth layer. No
// secrets, no credentials, no member data — safe for any function to import.
// Mirrors the intent of the resident portal's login hardening
// (netlify/functions/lib/resident-auth.js) without coupling the two.

const crypto = require("crypto");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Randomized pause after a failed login. Not a rate limiter (a distributed
// limiter is a later security item) — it just removes the tight, uniform
// response time that makes credential stuffing cheap and makes timing
// differences between "no such user" and "wrong password" easier to read.
function randomFailureDelayMs() {
  return 250 + crypto.randomInt(0, 250);
}

// Constant-time string comparison that is safe for inputs of differing
// length. crypto.timingSafeEqual throws unless both buffers are the same
// size, and comparing raw lengths first would itself leak length — so both
// sides are hashed to a fixed 32 bytes and the digests are compared.
function constantTimeEqual(a, b) {
  const bufA = crypto.createHash("sha256").update(String(a == null ? "" : a), "utf8").digest();
  const bufB = crypto.createHash("sha256").update(String(b == null ? "" : b), "utf8").digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { delay, randomFailureDelayMs, constantTimeEqual };
