# Resident Portal Access Requests — Setup & Operations

Lets a resident who can't log in to the Resident Portal ask the Board for help, without
revealing whether they're in the directory and without ever exposing the shared Community
Access Password to a browser, a log, a spreadsheet, or Git.

## Architecture overview

```
resident-login.html ──"Request access"──▶ resident-access-request.html (public form)
                                                     │ POST
                                                     ▼
                                    resident-access-request.js
                                    (validates, sanitizes, never checks the
                                     directory or the password)
                                                     │
                                                     ▼
                          "Resident Portal Access Requests" Google Sheet tab
                                                     ▲
                                                     │ (Bearer board session token)
                                          board.html ──▶ board-api.js
                                          (Portal Access Requests tab: review,
                                           status, internal notes, reply)
```

- `resident-access-request.html` is a public static file, same trust level as
  `resident-login.html` — no private data lives in it.
- `netlify/functions/lib/access-requests.js` is the shared, non-endpoint library (same
  convention as `lib/resident-audit.js`) used by both the public submission function and the
  Board Portal actions in `board-api.js`. It owns: input validation/sanitization, the
  worksheet schema and safe-creation/header-validation, the three reply templates, and the
  password-placeholder substitution.
- The public submission function **never reads the resident directory and never touches
  `RESIDENT_PORTAL_PASSWORD`** — there is no code path in it that could leak either.

## Public submission flow

1. Resident fills First Name, Last Name, Home Address, Email, optional Comments.
2. `resident-access-request.js` validates server-side (required fields, email format, length
   caps), strips control characters, and neutralizes spreadsheet-formula-injection characters
   (`sanitizeForSpreadsheet` — same convention as the audit log).
3. A hidden honeypot field (`website`) must be empty. If a bot fills it, the response is
   identical to a real success, but nothing is stored and no email is sent — detection is
   never revealed.
4. On success, one row is appended to the **"Resident Portal Access Requests"** tab (created
   automatically, header validated the same way `resident-audit.js` protects
   `Resident Portal Audit`'s header — never blindly overwritten) and the board is
   best-effort notified by email. A Gmail outage never loses the submission; a Sheets outage
   fails the request with a generic 500 (nothing partially written).
5. The resident always sees the same generic confirmation — the Board will review and
   respond by email. The directory is never queried, so there is nothing to reveal either way.

## Worksheet schema — "Resident Portal Access Requests" (columns A–O)

| # | Column | Written by |
|---|---|---|
| 1 | Request ID | Public submission (`ACC-<timestamp36>-<random>`) |
| 2 | Submitted At UTC | Public submission |
| 3 | First Name | Public submission |
| 4 | Last Name | Public submission |
| 5 | Home Address | Public submission |
| 6 | Email Address | Public submission |
| 7 | Resident Comments | Public submission (optional) |
| 8 | Status | Public submission (`New`), then Board (`updateAccessRequestStatus`) |
| 9 | Internal Board Notes | Board only (`addAccessRequestNote`) — JSON array, same shape as `Resident_Requests`' `board_notes` |
| 10 | Last Updated At UTC | Board, on any status/note/response mutation |
| 11 | Last Updated By | Board, on any status/note/response mutation |
| 12 | Response Sent At UTC | Board (`sendAccessResponse`) — **only on a confirmed successful send** |
| 13 | Response Type | Board — the template label ("Access Approved", "More Information Needed", "Unable to Verify") |
| 14 | Response Subject | Board — subject line only, never the body |
| 15 | Delivery Status | Board — `Sent` or `Failed` |

Statuses: `New`, `Under Review`, `Approved`, `Rejected`, `Closed`. Internal Board Notes are
never returned by any public/unauthenticated endpoint — there isn't one that reads this tab.

**The full response email body is never stored anywhere** — not in this sheet, not in
Activity_Log, not in any request history. Only the metadata above (type, subject, timestamp,
delivery result) is kept.

## Board Portal actions (board-api.js, all behind the existing session check)

`getAccessRequests`, `getAccessRequestPreview`, `sendAccessResponse`,
`updateAccessRequestStatus`, `addAccessRequestNote`. Available to any authenticated board
member (not admin-gated, matching the ARC Requests tab) — the whole board reviews these, not
just the admin.

### Reply templates and the password

Three editable templates: **Access Approved**, **More Information Needed**,
**Unable to Verify**. Only the Approved template's body ever contains anything
password-related, and only the literal placeholder text:

```
[Current Community Access Password will be inserted securely when sent]
```

`getAccessRequestPreview` returns this placeholder verbatim — `RESIDENT_PORTAL_PASSWORD` is
never read at preview time. Only `sendAccessResponse`, and only when `templateType ===
"approved"`, calls `insertPassword()` to substitute the real value **in the outgoing email
only** — the substituted body is never written back to the Sheet, never logged, and never
included in the JSON response to the board's browser. If a board member edits the placeholder
out of the textarea before sending, the password is simply not inserted (never guessed into
place). More Information Needed and Unable to Verify never call `insertPassword()` at all —
structurally, not just by convention.

A send failure (Gmail error) is recorded as `Delivery Status: Failed` and leaves
`Response Sent At UTC` / `Response Type` / `Response Subject` untouched — a failed send is
never reported as delivered.

## Email mechanism

Reuses the existing Gmail OAuth refresh-token flow already configured for `submit-request.js`
and `board-api.js` (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`) and the
existing sender `hoa.twinlakes.board@gmail.com`. No new email credentials were introduced.

## Required environment variables

All reused from the existing Board Portal / Resident Portal setup — nothing new to configure:
`GOOGLE_SHEET_ID`, `GOOGLE_SA_EMAIL`, `GOOGLE_SA_KEY`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN`, `RESIDENT_PORTAL_PASSWORD`. Optional: `RESIDENT_ACCESS_REQUESTS_SHEET_NAME`
(defaults to `Resident Portal Access Requests`).

## What must never be committed

Same list as [resident-portal-setup.md](resident-portal-setup.md#what-must-never-be-committed),
plus: exported/downloaded copies of the `Resident Portal Access Requests` worksheet (submitted
names/addresses/emails are personal data even before verification).

## Tests

`npm run test:access-requests` (`scripts/test-access-requests.js`) — validation, spreadsheet-
and HTML-injection handling, honeypot behavior, board-auth boundaries, and — using an
intercepted-HTTPS harness that inspects the actual bytes sent over the wire — proof that the
real password reaches only the outgoing "Access Approved" email and nowhere else (not Sheets
writes, not the Activity Log, not the JSON returned to the board's browser).
