"use strict";
// Checked Google Sheets read/write helpers for Board Portal actions.
//
// The previous helpers in board-api.js ended in `return JSON.parse(r.body)`
// with no status check, across 60 call sites — so a rejected write (bad
// range, permission loss, quota) was indistinguishable from a successful one
// and the portal reported success either way. Everything here fails loudly
// instead.
//
// Deliberately schema-agnostic: it validates HTTP responses and update
// metadata, never column letters. ARC column resolution is Phase A2.

const https = require("https");

class SheetsWriteError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SheetsWriteError";
    this.detail = detail;
  }
}

function request(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          ...headers,
          ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Shared response gate: non-2xx, unparseable body, or a Google `error`
// object are all failures.
function parseOrThrow(res, what) {
  if (typeof res.status !== "number" || res.status < 200 || res.status >= 300) {
    throw new SheetsWriteError(`${what} failed`, `http_${res.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new SheetsWriteError(`${what} returned a malformed response`, "unparseable_body");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SheetsWriteError(`${what} returned a malformed response`, "non_object_body");
  }
  if (parsed.error) {
    const msg = (parsed.error && (parsed.error.message || parsed.error.status)) || "google_error";
    throw new SheetsWriteError(`${what} was rejected`, String(msg).slice(0, 200));
  }
  return parsed;
}

async function valuesGet(token, sheetId, range) {
  const res = await request(
    "GET",
    "sheets.googleapis.com",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { Authorization: `Bearer ${token}` }
  );
  return parseOrThrow(res, "Sheets read");
}

// A successful update must report that it actually touched cells; a 200 with
// no updatedCells means nothing was written.
async function valuesUpdate(token, sheetId, range, values) {
  const res = await request(
    "PUT",
    "sheets.googleapis.com",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { Authorization: `Bearer ${token}` },
    { range, majorDimension: "ROWS", values }
  );
  const parsed = parseOrThrow(res, "Sheets write");
  if (typeof parsed.updatedCells !== "number" || parsed.updatedCells < 1) {
    throw new SheetsWriteError("Sheets write reported no updated cells", "no_updated_cells");
  }
  return parsed;
}

async function valuesAppend(token, sheetId, range, values) {
  const res = await request(
    "POST",
    "sheets.googleapis.com",
    `/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { Authorization: `Bearer ${token}` },
    { values }
  );
  const parsed = parseOrThrow(res, "Sheets append");
  const updatedRows = parsed.updates && parsed.updates.updatedRows;
  if (typeof updatedRows !== "number" || updatedRows < 1) {
    throw new SheetsWriteError("Sheets append reported no inserted rows", "no_inserted_rows");
  }
  return parsed;
}

// Maps a thrown SheetsWriteError onto the HTTP response the browser sees.
// Anything else is re-thrown so genuine bugs are not disguised as
// persistence failures.
function toErrorResponse(err) {
  if (err instanceof SheetsWriteError) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        error: "Could not save your change. Nothing was recorded — please try again.",
        detail: err.detail || "",
      }),
    };
  }
  return null;
}

module.exports = {
  SheetsWriteError,
  request,
  parseOrThrow,
  valuesGet,
  valuesUpdate,
  valuesAppend,
  toErrorResponse,
};
