# Board Portal — authentication, authorization and rendering safety

Phase A1. Covers how a board member signs in, what each person is allowed to
do, and the rules the portal follows when putting data on screen.

Phase A2 (ARC schema, Jodi's vote columns, canonical vote vocabulary,
one-request Sheets writes) is **not** in this document.

---

## 1. Authentication

### How a session works

Sign-in posts to `board-api` with `{action:"login", username, password}`. On
success the server returns `{ok:true}` and a cookie:

```
tl_board_session=<payloadB64>.<hmacB64>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800
```

The response body contains **no token, no name, no title and no privilege
flag**. The cookie is `HttpOnly`, so page scripts cannot read it — which is
what makes a future XSS bug unable to steal a session.

The signed payload carries five fields and nothing else:

| Field | Meaning |
|---|---|
| `purpose` | Always `board-session`. Stops a resident-portal token being replayed here. |
| `v` | `BOARD_SESSION_VERSION`. Bumping it invalidates every session at once. |
| `sub` | The member key (`raja`, `tony`, …). |
| `iat` | Issued at. |
| `exp` | Expires 8 hours after issue. |

**No title, access level, admin flag or permission list is in the token.**
Those are resolved from `lib/board-members.js` on every request, so a roster
change takes effect on the member's next request without anyone re-logging-in,
and no privilege claim ever travels on the wire where it could be edited.

### Verification order

`lib/board-auth.js` has exactly one verification path:

1. Token contains `.` and splits into exactly two parts
2. HMAC-SHA256 matches, compared with `timingSafeEqual` after a length guard
3. `purpose` is `board-session`
4. `v` matches `BOARD_SESSION_VERSION`
5. `exp` is in the future
6. `sub` is an **active** member in the roster

Step 6 is why a resigned member cannot use a session that is otherwise
cryptographically valid.

### Legacy tokens

The old portal issued `base64(JSON{username,name,role,isAdmin,exp})` with no
signature, and the server trusted every field in it — including `isAdmin`. Any
such token is now rejected: the base64 alphabet contains no `.`, so it fails
step 1. The `Authorization: Bearer` header is no longer read anywhere.

### Logout

`board-logout` returns the clearing cookie **unconditionally**, including for a
missing, expired, malformed, tampered or now-inactive session. Refusing to log
out someone whose session is already broken would strand them on the portal.

### Login hardening

- Constant-time password comparison (`lib/timing.js`), hash-then-compare so
  inputs of different lengths are safe.
- An unknown username is compared against a dummy password, so a bad username
  and a bad password cost the same work.
- One generic message — `"Invalid username or password."` — for unknown user,
  wrong password, inactive member and unconfigured server alike.
- Randomized 250–500 ms delay after any failure.
- **No cookie is set on a failed login.**
- Missing `BOARD_SESSION_SECRET` or `BOARD_SESSION_VERSION` fails closed: no
  session is issued and the generic failure is returned.

A distributed rate limiter is a later security item; this is not one.

### Environment variables

| Name | Purpose |
|---|---|
| `BOARD_SESSION_SECRET` | HMAC signing key. High-entropy random value, set in the Netlify UI. Never in the repository. |
| `BOARD_SESSION_VERSION` | Start at `"1"`. Increment to force every board member to sign in again. |

Set both **before** deploying, and set them separately for the Deploy Preview
context (with a different secret and a test spreadsheet) so previews never
authenticate against production data.

### Rotating a compromised session

Bump `BOARD_SESSION_VERSION` in Netlify. Every existing session fails step 4 on
its next request. No deploy required beyond the environment change taking
effect.

---

## 2. Authorization

One table in `lib/board-auth.js` (`PERMISSIONS`), **default deny**. An action
that is not listed is refused with 403 and never reaches a handler.

Authorization is driven by the explicit `access` field on each roster entry.
**Board title is display text and is never consulted** — Yashu is Vice
President with `admin`; Tony is President with `officer`.

| Access | Members |
|---|---|
| `admin` | Raja (Secretary), Yashu (Vice President) |
| `officer` | Tony (President) |
| `member` | Aimee, Mike, Jodi (Members at Large) |

`admin` ⊃ `officer` ⊃ `member`.

### What each level can do

**Every active board member** — view all operational queues (ARC, Concerns,
Violations, Other Items, Resident Requests, Portal Access Requests); add and
edit announcements; update statuses; add notes and comments; cast their own
vote; open the resident directory.

**Officers and admins** — additionally: delete announcements; add, edit and
delete minutes; create and correct ARC records; send official HOA email; send
resident portal access responses.

**Admins only** — portal and site settings; run inbox scans and backfills;
delete ARC records; record another member's vote; technical diagnostics
(the Activity Log).

`adminSetVotes` is additionally pinned to `raja` and `yashu` **by name**, so
adding a future administrator does not silently grant vote override.

### Frontend visibility is only a hint

`board-session` returns the caller's permitted actions and the portal hides
controls accordingly. That is a usability convenience. **Every action is
authorized again server-side**, so hiding a button is never the security
control, and a member who reconstructs a request by hand gets a 403.

### CSRF

Three independent layers on authenticated actions:

1. `SameSite=Strict` — the cookie is not sent on any cross-site request.
2. A required `X-Board-Request: 1` header — a cross-origin request cannot set a
   custom header without a CORS preflight, and this API answers none.
3. `Origin`/`Referer` must match the request's own `Host` for state-changing
   actions. Compared against the live host, so previews, localhost and any
   future custom domain work without an allow-list.

### CORS

The public website, the portal and the functions are same-origin, so **no CORS
headers are sent at all** and the previous `Access-Control-Allow-Origin: *` is
gone. If a genuine cross-origin consumer of the public read actions appears,
the answer is dedicated public endpoints, not loosening these.

---

## 3. Roster changes

`lib/board-members.js` holds identity; passwords remain in `board-api.js`
(moving them to environment variables is the first Phase B security item).

### Adding a member

1. Add a roster entry: `key`, `displayName`, `displayTitle`, `access`,
   `status: "active"`, `emailAliases`.
2. Add their password to `BOARD_PASSWORDS` in `board-api.js`.
3. `voteFields` stays `null` until a Phase A2 schema migration adds their
   four ARC columns. Until then they can log in and do everything except vote,
   and the portal says so plainly instead of accepting a vote it cannot save.

### Removing a member

Set `status: "historical"`, clear `access`, and remove their password. **Do not
delete the entry**, and do not delete their vote fields:

- Their recorded votes must keep counting on the records they were cast on.
  Removing them would retroactively change `final_status` on decided records.
- Email they forwarded must still be recognised as a forward, or the scanner
  would attribute a resident's request to them as the homeowner.

They cannot log in, hold a session, cast a vote, or be targeted by
`adminSetVotes`. In the vote grid they appear only on records where they
actually voted, read-only and labelled "former".

This is exactly how Ramana N is configured.

### Vacant seats

`VACANT_SEATS` is display-only. A vacant seat has no key, no credential, no
session, no permissions, no vote mapping and no email alias. **Never create a
placeholder user.** The Treasurer seat is currently vacant.

---

## 4. Write reliability

`lib/sheets-write.js` treats all of these as failures:

- any non-2xx status
- an unparseable response body
- a Google `error` object inside a 200
- update metadata showing nothing was written (`updatedCells < 1`,
  `updates.updatedRows < 1`)

A failure throws `SheetsWriteError`, which the handler maps to **502** with a
message that plainly states nothing was recorded. Anything else stays a 500 so
a genuine bug is not disguised as a persistence failure.

Audit logging is **non-fatal**: the member's action has already been persisted
by the time it runs, so a failed audit append is logged to stderr and never
fails the request.

On the client, `api()` **throws** on any non-2xx and redirects on 401 — there
is no sentinel return value a caller can forget to check. `uiAction()` is the
single route from action to message, and the success toast runs only after the
call resolves. An `unhandledrejection` listener catches any `ApiError` that
escapes a call site so it still reaches the user.

> Known limitation: several actions still issue multiple independent writes, so
> a partial failure is possible. Phase A2 consolidates each logical action to
> one request. Sheets has no transactions; Phase A1 makes failure *visible*
> rather than pretending it is impossible.

---

## 5. Rendering and URL safety

- **One** escaping function, `esc()`, covering `& < > " '`. The previous helper
  left single quotes untouched, so any single-quoted attribute was escapable.
- **No inline event handlers carry data-derived values.** Record identifiers
  travel as `data-*` attributes and are dispatched by delegated listeners, so a
  value from the sheet is never placed inside a JS string inside an HTML
  attribute.
- **Links are built with DOM APIs** — `createElement`, `.href =`,
  `.textContent =`, `rel="noopener noreferrer"` — never by interpolating a URL
  into markup.

### URL validators

| Validator | Rule | Used for |
|---|---|---|
| `safeUrl(v, {driveOnly:true})` | `https:` **and** host in `drive.google.com` / `docs.google.com` | Attachment and Drive folder links |
| `safeUrl(v)` | `https:`, any host | General approved links |
| *(none)* | never linkified | Resident descriptions, internal notes, AI summaries, Gmail subjects |

Both reject `javascript:`, `data:`, `file:`, `vbscript:`, plain `http:`,
malformed input (via `new URL()`), and anything with an unexpected protocol.
Quote injection cannot survive because `new URL()` normalises the result.

**The Drive allow-list is deliberately not global** — restricting every portal
link to Drive hosts would break legitimate links. Only attachments are
host-restricted.

Anything failing validation renders as plain text. This also fixed a display
bug: web-form ARC submissions store a prose note in `attachment_urls`
("3 file(s) emailed to the board: a.jpg, b.jpg"), which the old code split on
commas and rendered as broken "Attachment 1/2/3" buttons.

---

## 6. Running the tests

```bash
npm run test:board            # the whole Phase A1 suite
npm run test:board-auth       # sessions, cookies, login, roster
npm run test:board-authz      # 186-case authorization matrix
npm run test:board-write      # Sheets write contract
npm run test:board-render     # escaping and URL validation
npm run check:secrets         # no new credential or PII in the diff
```

No test touches the network, Gmail, Drive or a live spreadsheet.

Run the pre-existing suites too — `test:resident-auth`,
`test:resident-audit-e2e`, `test:access-requests`.

---

## 7. Troubleshooting

**Everyone is logged out unexpectedly.** `BOARD_SESSION_VERSION` or
`BOARD_SESSION_SECRET` changed. Expected after a rotation.

**Login always fails, for everyone, with the generic message.** Most likely
`BOARD_SESSION_SECRET` or `BOARD_SESSION_VERSION` is unset — the server fails
closed. Check the function log for `{"boardAuthUnconfigured":true}`.

**A member gets 403 on something they should be able to do.** Check their
`access` in `lib/board-members.js` and the entry in `PERMISSIONS`. Do not fix
it by changing their board title — title has no effect on access.

**"Could not save your change. Nothing was recorded."** A Sheets write was
rejected. The function log carries `{"sheetsWriteFailed":true,"detail":…}`;
`http_403` usually means the service account lost access to the spreadsheet.

**A board member cannot vote.** If `voteFields` is `null` for them (Jodi, until
Phase A2), this is expected and the portal explains it. Their vote is refused
server-side rather than written to a range built from `undefined` — which is
the bug this replaced, where the vote was silently discarded and the portal
reported success.
