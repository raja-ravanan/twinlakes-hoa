# Resident Portal — Setup & Operations (Phase 2A)

Version 1: shared-password gated access for residents. No individual accounts, no real
private data yet — see [Scope exclusions](#scope-exclusions).

## Architecture overview

```
resident-login.html ──POST──▶ resident-login.js ──▶ Set-Cookie: tl_resident_session
                                                        │
resident-portal.html ──GET──▶ resident-session.js ◀────┘ (verifies signature/exp/version)
       │
       └──POST──▶ resident-logout.js (clears cookie)
```

- `resident-login.html` / `resident-portal.html` are **public static files** — anyone can
  load them. They contain no private data; they only orchestrate calls to the functions.
- The three Netlify Functions and the shared `netlify/functions/lib/resident-auth.js`
  utility are the actual access-control layer.
- The session cookie (`tl_resident_session`) is `HttpOnly`, `Secure`, `SameSite=Lax`,
  `Path=/`, 14-day max age. Its payload is `{ purpose, iat, exp, v, sid }` — no resident
  name, house number, or password. `sid` is a random opaque correlator (see
  [Audit logging](#audit-logging)) — a valid session proves only that the browser passed
  resident verification once; it does not identify who.
- A durable, server-only audit trail records login/logout activity to a dedicated Google
  Sheet — see [Audit logging](#audit-logging). The browser never writes to it directly.

## Login flow

1. Resident submits House Number + Last Name + Community Access Password (POST JSON to
   `/.netlify/functions/resident-login`).
2. The function normalizes/validates input, loads the password/session config from
   environment variables, fetches the resident eligibility list **live from the "TL
   Directory" Google Sheet** (`RESIDENT_SHEET_ID`, `lib/resident-directory.js` — not an
   environment variable, see below), and checks the (house number, last name) pair against
   it plus the password against `RESIDENT_PORTAL_PASSWORD` (constant-time comparison).
3. Any failure — bad resident, bad password, missing config — returns the **same** generic
   401 message. A 300–700ms random delay is added on failure only.
4. On success, a signed session cookie is set and the page redirects to
   `resident-portal.html`.

## Session flow

- `resident-portal.html` calls `GET /.netlify/functions/resident-session` on load.
- **Chosen behavior:** this endpoint always returns `200` with `{ authenticated: true|false }`
  — never `401` — because it's a routine state check, not an authorization failure. The
  frontend has a single branch: `authenticated` → show the shell; anything else → redirect
  to `resident-login.html`.
- `resident-logout.js` clears the cookie (same name/path/attributes) and returns
  `{ ok: true }`. Logout is a real server round-trip, not just a frontend redirect.

## Required environment variables (Netlify)

| Variable | Purpose |
|---|---|
| `RESIDENT_PORTAL_PASSWORD` | The one shared community access password. |
| `RESIDENT_SESSION_SECRET` | HMAC signing key for session cookies. Generate with `openssl rand -hex 32`. |
| `RESIDENT_SESSION_VERSION` | Any string/number. Bump it to invalidate all existing sessions. |
| `RESIDENT_AUDIT_IP_SALT` | Secret salt for the audit log's IP correlation hash. Generate with `openssl rand -hex 32`. Distinct from `RESIDENT_SESSION_SECRET`. |
| `RESIDENT_AUDIT_SHEET_NAME` | Optional. Worksheet tab name for the audit trail. Defaults to `Resident Portal Audit` if unset. |
| `RESIDENT_SHEET_ID` | The "TL Directory" Google Sheet ID the resident eligibility list is read from live. |
| `RESIDENT_DIRECTORY_SHEET_NAME` | Optional. Tab name within that sheet. Defaults to `Sheet1` if unset. |

Both audit logging and the resident directory **reuse** the site's existing `GOOGLE_SA_EMAIL`
/ `GOOGLE_SA_KEY` (already configured for the Board Portal's Sheets integration) — nothing new
to set up there. Audit logging also reuses `GOOGLE_SHEET_ID`; the directory uses the separate
`RESIDENT_SHEET_ID` (a different spreadsheet).

**There is no `RESIDENT_DIRECTORY_DATA` environment variable.** An earlier version of this
phase stored the resident list as one large JSON environment variable, but the real
~140-household list runs ~7KB — over Netlify's per-value environment variable size limit
(empirically confirmed: values above ~5KB silently fail to persist via `netlify env:set` even
though the CLI reports success, with no error surfaced). The directory is now read live from
Google Sheets instead (`lib/resident-directory.js`), which has no such ceiling and lets the
board add/remove residents by editing the Sheet directly, with no redeploy required.

If `RESIDENT_PORTAL_PASSWORD`/`RESIDENT_SESSION_SECRET`/`RESIDENT_SESSION_VERSION` is missing,
or the directory fetch fails for any reason (missing `RESIDENT_SHEET_ID`, credentials, network
error, timeout), `resident-login` fails closed with a `500` and `resident-session` reports
`authenticated:false` — neither ever crashes or leaks which variable/step failed. Unlike audit
logging (which fails *open* — see below), a directory fetch failure fails *closed*: it's part
of the authentication decision, not a side-channel log, so a Sheets outage must never silently
let someone through.

## Netlify setup steps

1. Site settings → Environment variables → add the variables above.
2. Share the "TL Directory" Google Sheet with the service account email (`GOOGLE_SA_EMAIL`) if
   it isn't already shared, with at least read access.
3. Deploy (or trigger a redeploy) so the functions pick up the new values — Netlify
   Functions read `process.env` at cold start.
4. Share the password with residents through the board-approved channel.

## How to add or remove a resident

Edit the "TL Directory" Google Sheet directly (columns: `Name`, `Street No`, plus other
columns the portal never reads — see [Field parsing](#field-parsing-from-the-source-sheet)
below). Changes take effect on the **next login attempt** — no redeploy needed, since the
directory is fetched live, not cached.

### Field parsing from the source sheet

Only two columns are read: `Name` and `Street No`. Everything else (email, phone, lot number,
committee flags, etc.) is ignored entirely — never fetched into more columns than `A2:B1000`.
The `Name` field is parsed into one or more last names using two recognized shapes (both
present in the real sheet):
- `"Last, First"` or `"Last, First & First2 [Last2]"` (comma-separated)
- `"First Last"` or `"First Last & First2 [Last2]"` (space-separated, no comma)

A household where co-owners have different surnames produces **two** directory entries for
that house number, so either resident can log in with their own last name. Rows that don't
confidently match either shape (a bare single word, an unfamiliar token layout, 3+ "&"-joined
names) are **excluded rather than guessed** — see `parseLastNames()` in
`netlify/functions/lib/resident-directory.js` for the exact rules. If a resident can't log in,
check whether their sheet row's `Name` field matches one of the two recognized shapes.

## How to rotate the shared password

1. Update `RESIDENT_PORTAL_PASSWORD` in Netlify.
2. Increment `RESIDENT_SESSION_VERSION` (e.g. `"1"` → `"2"`) — this is what actually
   invalidates existing sessions; see below.
3. Redeploy if Netlify requires it to pick up the env-var change.
4. Share the new password with residents through the board-approved channel.

## How to invalidate all sessions

Increment `RESIDENT_SESSION_VERSION` and redeploy. `resident-session.js` compares the
version embedded in each signed cookie against the current env var; any mismatch is treated
as unauthenticated. **Changing only the password does not invalidate existing sessions** —
a resident who already logged in stays logged in (up to 14 days) until the version is also
bumped. Rotate both together when you want an immediate cutoff.

## Cookie duration

14 days (`Max-Age=1209600`), sliding is **not** implemented — each login issues a fresh
14-day window; the session is not renewed on activity in Phase 2A.

## Audit logging

### Why it exists

The board needs to know which verified resident combination accessed the portal, when, and
whether repeated failed attempts are happening — without weakening the login's generic
failure responses or exposing credentials anywhere. `netlify/functions/lib/resident-audit.js`
appends one row per `LOGIN_SUCCESS`, `LOGIN_FAILURE`, or `LOGOUT` event to a dedicated Google
Sheet tab, **`Resident Portal Audit`**, in the same spreadsheet the rest of the site already
uses (`GOOGLE_SHEET_ID`). The browser never talks to Google Sheets directly — only the
server-side functions do, and only after the authentication decision is already made.

### Worksheet columns (in order)

| # | Column | Notes |
|---|---|---|
| 1 | Event ID | `crypto.randomUUID()`, unique per row. |
| 2 | Timestamp (UTC) | Server-generated, ISO-8601 (`2026-07-25T01:42:18.527Z`). Never a browser-supplied time. |
| 3 | Event Type | `LOGIN_SUCCESS`, `LOGIN_FAILURE`, or `LOGOUT`. |
| 4 | House Number | Normalized submitted value. Blank if it didn't pass basic validation. |
| 5 | Last Name | Normalized submitted value. Blank if it didn't pass basic validation. |
| 6 | Household Match | `true`/`false`, or blank if never determined (e.g. malformed request). See rules below. |
| 7 | Failure Category | Blank for success/logout. See categories below — internal only, never returned to the browser. |
| 8 | Session Reference | One-way HMAC derivative of the session's random `sid` — correlates a LOGIN_SUCCESS to its later LOGOUT. Cannot recreate or authenticate a session by itself. |
| 9 | IP Hash | HMAC-SHA-256(client IP, `RESIDENT_AUDIT_IP_SALT`), first 20 hex chars. Blank if no trustworthy IP was available. |
| 10 | User Agent | Bounded to 250 chars, control characters stripped. |
| 11 | Source | Always `resident-portal`. |
| 12 | App Version | Netlify's `COMMIT_REF` or `DEPLOY_ID` when available; blank otherwise (never fails logging). |

**Household Match rules:**
| Scenario | Household Match | Failure Category |
|---|---|---|
| `LOGIN_SUCCESS` | `true` | *(blank)* |
| Correct resident, wrong password | `true` | `INVALID_PASSWORD` |
| Unknown resident (house/name pair not on file) | `false` | `INVALID_RESIDENT` |
| Invalid/blank/oversized input, malformed request, unsupported method, config error | *(blank)* | matching category |

Failure categories: `INVALID_RESIDENT`, `INVALID_PASSWORD`, `INVALID_INPUT`,
`MALFORMED_REQUEST`, `UNSUPPORTED_METHOD`, `CONFIGURATION_ERROR`.

### Successful vs. submitted/unverified identity — read this before trusting a row

> **A failed login record shows the information that was submitted. It does not prove that
> the resident whose name was entered made the attempt.**

Only `LOGIN_SUCCESS` rows represent a verified resident (matched against the live "TL
Directory" Sheet *and* the correct password). A `LOGIN_FAILURE` row's House Number/Last Name
are whatever was typed into the form — anyone can type any name. Treat
repeated failures against the same name as a signal to investigate, not as proof of who was
at the keyboard.

### Password and session-token exclusion

The Community Access Password and the raw session cookie/token are **never** written to the
worksheet, logged to Netlify's console, or included in any error message — by construction,
not by convention: `buildAuditRow()` has no code path that reads `evt.password` or a token
value, and the two things that ARE session-related (`sid` → Session Reference) are one-way
HMAC derivatives that cannot be reversed back into a working cookie.

### IP hashing behavior

`IP Hash` is a **non-reversible correlation value for abuse detection, not resident
identification.** It's `HMAC-SHA256(clientIp, RESIDENT_AUDIT_IP_SALT)` truncated to 20 hex
characters. Only Netlify's own trusted `x-nf-client-connection-ip` header is used — never an
arbitrary client-suppliable header — so it can't be spoofed by the request itself. If that
header isn't present (e.g. some local dev setups) or `RESIDENT_AUDIT_IP_SALT` isn't
configured, the column is left blank rather than guessed or unsalted.

### User-agent limitations

The User Agent column is for troubleshooting only — it's client-supplied, trivially
spoofable, bounded to 250 characters, and stripped of control characters and
spreadsheet-formula-injection characters. It is not parsed, fingerprinted, or used as proof
of anything.

### Spreadsheet-injection protection

Every user-influenced cell (House Number, Last Name, User Agent) is passed through
`sanitizeForSpreadsheet()`: control characters are stripped, and any value beginning with
`=`, `+`, `-`, or `@` is prefixed with a literal apostrophe (the same convention Sheets/Excel
use to force plain text). The Sheets API append also always uses `valueInputOption=RAW`, so a
live formula can't be triggered inside Google Sheets itself regardless — the apostrophe
prefix is defense-in-depth for the more realistic risk: someone later exporting this sheet to
CSV and opening it in Excel, which *does* interpret a leading `=`/`+`/`-`/`@` as a formula
trigger on import.

Rows are also never overwritten: every write uses the Sheets API's `append` operation with
`insertDataOption=INSERT_ROWS`, which structurally finds the table's current end and inserts
there — there is no code path in this module that does a fixed-range `update()` against
existing data rows.

### Who should have access

Whoever already has edit access to the Board Portal's Google Sheet (the board). Do not share
a link to just the `Resident Portal Audit` tab more broadly — house numbers and last names of
failed attempts are still personal data even though they're unverified.

### Retention and archival

**Recommended: keep 12 months of rows.** Once a year, export the worksheet (File → Download
→ CSV, or copy to a new sheet) to an access-controlled archive location, then delete rows
older than 12 months from the live tab. There is no automated retention/deletion in Phase
2A — this is a manual board task.

### Audit writing does not control login success

Fail-open by design: `appendAuditEvent()` is awaited (never fire-and-forget) but can never
throw, and the authentication decision is fully computed *before* it's called. A Sheets
outage, timeout, or misconfiguration only means that one row doesn't get written — it never
turns a valid login into a rejection or an invalid one into a success, and it never blocks
logout from clearing the cookie.

### Never exposed publicly

There is no endpoint that reads the `Resident Portal Audit` tab back out. It is written to,
never read from, by any Netlify Function in this repo. Do not add a public or resident-facing
endpoint that queries it, and do not surface any of its data inside `resident-portal.html` —
that page is a public static shell.

### How to create the worksheet

Nothing to do manually in the common case — if the `Resident Portal Audit` tab doesn't exist
in the spreadsheet at `GOOGLE_SHEET_ID`, it's created automatically on the first audit write,
with the 12-column header written once at creation. If you want it to exist ahead of time,
add a tab with that exact name (or whatever `RESIDENT_AUDIT_SHEET_NAME` is set to) — an empty
tab with a blank row 1 is fine, the header will be written once.

### Protecting the header and structure — validated, never auto-replaced

Unlike the `Minutes!H1` self-heal pattern elsewhere in this repo, the audit header is **not**
blindly rewritten on every cold start. Once a tab has *any* header in row 1, every subsequent
write only **validates** it against the expected 12 columns (exact names, exact order) and
leaves it untouched — matching or not. If it doesn't match (someone manually reordered,
renamed, or added/removed a column), that write is skipped with a sanitized
`audit_header_mismatch` error (fail-open — login/logout are unaffected) rather than the
header being silently overwritten to "fix" it.

Practically: **don't reorder, rename, insert, or delete columns** in row 1. If you need to
change the schema, do it deliberately — update `AUDIT_HEADERS` in
`netlify/functions/lib/resident-audit.js` and the live sheet's row 1 together, in the same
change, or new rows will silently stop being written until they're back in sync. In Google
Sheets, freeze row 1 and protect it (Data → Protected sheets and ranges) restricted to board
editors, to prevent accidental edits from causing exactly this.

### Troubleshooting failed audit writes

| Symptom | Likely cause |
|---|---|
| No new rows ever appear, but login/logout still work normally | Expected fail-open behavior if `GOOGLE_SHEET_ID`/`GOOGLE_SA_EMAIL`/`GOOGLE_SA_KEY` are missing or the service account key can't be parsed — check Netlify function logs for a `auditWriteFailed` line with `category: "audit_config_missing"` or `"audit_write_error"`. |
| Rows stop appearing after a while, then resume | Transient Sheets API slowness — writes are bounded to a ~2.5s timeout (`category: "audit_write_timeout"`) and simply skipped, not retried. |
| `IP Hash` column is blank for every row | `RESIDENT_AUDIT_IP_SALT` isn't set, or the request didn't carry Netlify's trusted IP header (e.g. local dev without a real edge connection). |
| A logged-in-then-logged-out resident's two rows don't share a Session Reference | The session cookie was invalid/expired/wrong-version by the time logout ran — no reference could be derived, so it's left blank rather than guessed. |
| Rows stopped appearing after someone edited the sheet | `category: "audit_header_mismatch"` — row 1 no longer matches `AUDIT_HEADERS` exactly. The header is validated, never auto-repaired; see [Protecting the header and structure](#protecting-the-header-and-structure--validated-never-auto-replaced). Fix row 1 to match exactly, or update `AUDIT_HEADERS` and row 1 together. |

## Protected-content rules (for future phases)

- `resident-portal.html` is a public static shell. It is not the protected asset.
- Future financials, directory records, and private documents must be returned only by
  their own authenticated Netlify Functions, each independently re-verifying the
  `tl_resident_session` cookie — never assume a page load implies authorization.
- Frontend redirects (e.g. "no session → go to login") are a UX convenience, not a
  security control.
- Files placed in the publicly deployed directory are publicly accessible even if nothing
  links to them. Private documents must never be committed into this repo's deployed root.

## Resident Directory — opt-in requirement (future)

The "Resident Directory" card is a placeholder only. When it's actually built:
- Must be opt-in per resident.
- Login-verification data (this doc) must stay separate from any display-directory data.
- Only resident-approved fields may be shown.
- Never return the full eligibility list to the browser.
- Portal access does not imply consent to display any individual's contact details.
- Avoid publishing children's information or other unnecessary personal data.

## Known security limitations

- **This is a shared-password model, not individual authentication.** It provides no
  per-resident accountability — anyone who has the password and any valid
  (house number, last name) pair can log in as "a resident."
- **No durable rate limiting.** Netlify Function instances are ephemeral and distributed;
  an in-memory counter would not actually throttle anything and is not implemented. The
  300–700ms failure delay is friction, not a limit. If abuse becomes an observed problem,
  consider a CAPTCHA or a platform-level rate limiter (not built now, no paid datastore
  added in this phase).
- **The (house number, last name) directory is not a secret** — it is committed to Netlify
  environment variables, not exposed to the browser, but is not treated as confidential;
  it exists to gate casual access, not to resist a targeted, informed attacker.
- Sessions are not revocable individually — only all-at-once via `RESIDENT_SESSION_VERSION`.
- **Audit log entries for failed logins are submitted values, not verified identity** — see
  [Audit logging](#audit-logging). Don't treat a failure row as proof of who attempted it.
- The audit log itself has no durable retention/deletion automation — see
  [Retention and archival](#retention-and-archival); it relies on an annual manual step.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Every login fails, including correct credentials | An env var is missing, or the directory fetch is failing (missing/wrong `RESIDENT_SHEET_ID`, service account not shared on the Sheet, network timeout) — check function logs for `500` responses (details are never included in the response body). |
| Portal always redirects to login even after a successful login | `RESIDENT_SESSION_SECRET` or `RESIDENT_SESSION_VERSION` differs between what signed the cookie and what's verifying it (e.g. redeploy changed the version) — log in again. |
| One specific resident can't log in but others can | Their sheet row's `Name` field likely doesn't match either recognized parsing shape — see [Field parsing from the source sheet](#field-parsing-from-the-source-sheet). |
| Login works locally but not in production | `Secure` cookies require HTTPS — this only works on the deployed Netlify URL / custom domain, not plain `http://`. |

## What must never be committed

- Real resident names or house-number mappings.
- The real `RESIDENT_PORTAL_PASSWORD` value.
- The real `RESIDENT_SESSION_SECRET` or `RESIDENT_AUDIT_IP_SALT` values.
- Local `.env` files containing any of the above.
- Exported/downloaded copies of the `Resident Portal Audit` worksheet (real submitted names,
  even unverified ones, are still personal data).
