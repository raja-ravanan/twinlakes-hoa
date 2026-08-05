# Inbox Scanner, Board Portal & Admin Architecture Review

> **Date:** 2026-07-27 · **Phase:** Investigative only. No code was modified, committed, or deployed.
> **Method:** Derived from *reading* the codebase at commit `1fb5a48` plus local uncommitted changes. Nothing was executed against live Gmail, Drive, or Sheets.
> **Claim tags:** **[V]** verified in code (file:line given) · **[E]** expected — a reasoned inference from code, not observed at runtime · **[?]** don't know — needs owner confirmation or a live check.

---

## 1. Executive summary

The system does what it was built to do, but it was built as a **sequence of point fixes rather than a pipeline**, and it has no memory of its own behaviour. Three findings dominate everything else:

1. **The Board Portal session token is unsigned and therefore forgeable.** `board-api.js:169` mints a session as plain `base64(JSON)` and `board-api.js:240` decodes it without verifying anything. Anyone who can reach the function can hand-craft an admin session — no password, no secret. This grants ARC record deletion, resident-directory export, settings changes, and the ability to send email as the HOA. **[V]** This is the single most serious issue in the codebase and it is out of proportion to everything else. Notably, the *resident* portal built later (`lib/resident-auth.js:94–110`) does this correctly with HMAC-SHA256 + `timingSafeEqual`; the board portal simply predates that discipline.

2. **The scanner can only ever see the newest 10 emails, and deduplication happens *after* listing.** The default button is `runScan(30, 10)` (`board.html:365`), which becomes Gmail `maxResults=10` (`scan-inbox.js:659`). There is no `pageToken` anywhere. Gmail returns newest-first, and already-processed threads consume slots before being discarded. On a mailbox with normal traffic, repeated scans re-examine the same ten threads and **never reach unprocessed older mail**. **[V] for the mechanism; [E] that this is the primary cause of "some qualifying emails do not become Board requests."** This one fact explains the largest reported symptom.

3. **Nothing anywhere records what the scanner did.** There is no run log, no per-message outcome, no "last successful scan" on the server (the portal's "Last scan" is `localStorage` on one browser — `board.html:1338`). Every skip path increments one opaque `results.skipped` counter (`scan-inbox.js:712, 718, 864`) that merges "empty email", "deemed unimportant", "already seen", and "threw an exception" into a single number. **[V]** The system is therefore *unsupportable by construction*: when an email doesn't become a request, there is no artifact that can tell you why.

Underneath those, a consistent theme: **failures are swallowed and then rendered as success.** Drive uploads that fail produce URLs containing the literal string `undefined` (`scan-inbox.js:269`); Sheets writes are never status-checked in `board-api.js`; a board member who is not in the vote column map has her vote written to a range named `undefined` and receives a success toast. The portal is confident about data it has no basis for confidence in.

There is **no Admin Portal**. "Admin" is one boolean on one account that hides tabs client-side and guards five server actions. Most write endpoints — including deleting announcements and minutes, and emailing Mulloy on the HOA's behalf — are available to any authenticated board member. **[V]**

**Recommended shape of the fix:** do *not* restructure the portals. The architecture (one shell, permission-gated modules) is right. Fix the session, put real server-side authorization on the action list, give the scanner pagination and a run ledger, and make failure visible. That is roughly 5–7 focused changes, sequenced in §14.

---

## 2. Current architecture

```
                          ┌──────────────────────────────────────┐
   PUBLIC WEBSITE         │  index.html · script.js · style.css  │
   (no auth)              └───────────┬──────────────────────────┘
                                      │ getPublicAnnouncements
                                      │ getPublicMinutes
                                      │ getPublicSettings        (no auth — board-api.js:174/200/216)
                                      ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                     NETLIFY FUNCTIONS (CommonJS, raw https)            │
   │                                                                        │
   │  board-api.js ──────── 26 actions, one giant if-chain, 897 lines       │
   │  scan-inbox.js ─────── the Inbox Scanner (878 lines, timeout 300s)     │
   │  submit-request.js ─── public request + ARC form → Sheets + Gmail      │
   │  resident-access-request.js ─ public portal-access form                │
   │  resident-login/-logout/-session/-financials ── resident portal auth   │
   │  email-digest.js ───── DIGEST_SECRET-gated mail digest                 │
   │  health-check.js ───── scheduled every 3h (netlify.toml:14)            │
   │  lib/ ── access-requests · resident-audit · resident-auth ·            │
   │          resident-directory        (shared, not endpoints)             │
   └───────┬──────────────────────┬─────────────────────┬───────────────────┘
           │                      │                     │
      Gmail API              Google Sheets          Google Drive
   (OAuth refresh token,   (service-account JWT,  (service-account JWT;
    account hoa.twinlakes   GOOGLE_SHEET_ID +      NO storage quota —
    .board@gmail.com)       RESIDENT_SHEET_ID)     uploads fail. See §9.3)
           ▲                      ▲
           │                      │
   ┌───────┴──────────────────────┴───────────────────────────────────────┐
   │  board.html (2783 lines, single page, 16 tabs)                       │
   │  ← board-login.html → localStorage{board_token, board_user}          │
   │  Admin = raja only. Tabs hidden via CSS when !isAdmin.               │
   └──────────────────────────────────────────────────────────────────────┘
```

**Datastore is a single Google Spreadsheet** (`GOOGLE_SHEET_ID`) with tabs:
`ARC_Requests` (46 cols + an unheadered col AU) · `Violations` (14 + col O) · `Other_Items` (9 + col J) · `Activity_Log` · `Resident_Requests` · `Announcements` · `Minutes` · `Settings` · `Resident Portal Access Requests`. A second spreadsheet (`RESIDENT_SHEET_ID`) holds the resident directory. **[V]** `board-api.js:106–124`, `scan-inbox.js:312–315`.

**Two functions write to `ARC_Requests` with different layouts** — `scan-inbox.js:826` (47 values incl. thread ID) and `submit-request.js:385` (16 values, `A:P`). Neither knows about the other. **[V]** See §9.4.

---

## 3. Inbox Scanner — end-to-end flow

`POST /.netlify/functions/scan-inbox` with `{secret, daysBack, maxEmails, beforeDays}`.

| # | Stage | Code | Notes / failure modes |
|---|---|---|---|
| 1 | Auth | `:606` | Plain `!==` compare against `DIGEST_SECRET`. Secret is typed into a browser `prompt()` (`board.html:2733`) and posted from the client. |
| 2 | Tokens | `:610–613` | Gmail via refresh token; Google SA JWT for Sheets+Drive. `getGmailToken` (`:45`) **does not check for an error response** — an expired token yields `undefined`, and every later Gmail call 401s inside a per-message `try`, so the run reports `skipped` for every message and still returns HTTP 200 `success:true`. **[V]** |
| 3 | Ensure tabs | `:619` | Creates the 4 scanner tabs if absent. Errors are logged and swallowed (`:324`). |
| 4 | Drive folders | `:623–627` | `ARC Requests/<year>`, `Violations/<year>`, `Other/<year>` under `GOOGLE_DRIVE_FOLDER_ID`. `findOrCreateFolder` never checks HTTP status. |
| 5 | Load dedup keys | `:631–642` | Reads existing IDs (col A) and **thread IDs** from `ARC_Requests!AU`, `Violations!O`, `Other_Items!J`. |
| 6 | **List messages** | `:649–661` | `q = in:inbox after:<ts> [before:<ts>]`, `maxResults = maxEmails` (default 30; UI sends **10**). **No pagination.** **No label filter, no sender filter.** |
| 7 | Per message (batches of 5, but sequential within) | `:669–866` | |
| 7a | Fetch + decode | `:676–681` | `decodeBody` (`:189`) recurses MIME correctly, prefers text/plain, falls back to HTML→text. Capped at **2000 chars** — long ARC requests are truncated before classification. |
| 7b | Dedup | `:685–692` | Thread-level, cross-run and in-run. Correct *given* it is reached. |
| 7c | Forward unwrap | `:695` | `extractOriginalSender` regex-scans the body for the last `From:` line. |
| 7d | Thread fetch | `:699` | Earliest message → true request date; collects board members' replies for vote extraction. Errors swallowed (`:135`). |
| 7e | Classify | `:715` | Keyword-first, Claude-fallback. See §3.1. |
| 7f | Analyze | `:716` | Claude Haiku, one call. On any error returns `{}` (`:441`) — the row is still written, blank. |
| 7g | Skip test | `:718` | `Other` + `needs_attention:"no"` → dropped with no record. |
| 7h | Directory resolve | `:725–750` | Address-first (authoritative), sender-email fallback only for non-internal senders. This part is well-reasoned. |
| 7i | Re-summarize | `:755–763` | Second Claude call to re-attribute the summary to the real homeowner. |
| 7j | ID | `:768` | `ARC-<housenum>`, collision-suffixed. Falls back to a timestamp fragment when no house number is found. |
| 7k | Attachments | `:772` | `getAttachments` (`:216`) — **only iterates `msg.payload.parts` one level deep.** See §3.2. |
| 7l | Drive folder + upload | `:779–793` | Per-attachment `try/catch` that only `console.log`s. `ai_summary.txt` written alongside. |
| 7m | Vote extraction (ARC) | `:804` | Claude reads each member's replies → `Approved/Conditional/Denied/Pending`. |
| 7n | Sheet write | `:826/840/853` | `sheetsAppend` logs errors but **the caller ignores the outcome** (`:334`). |
| 8 | Return | `:870` | `{arc, violation, other, skipped}` counts. Nothing persisted. |

### 3.1 Classification rules — what they actually do

`categorizeEmail` (`:446`) runs three gates in order:

1. **Financial veto (`:452`)** — if the subject+body contains any of `financial, invoice, payment, insurance, premium, budget, expense, bill, receipt, quarterly, annual report, bank, deposit, reserve fund`, the email is forced to `Other` **before ARC detection runs**. An ARC request saying *"happy to pay the bill for the fence permit"* is silently demoted to Other. **[V]** This is a direct, verified cause of "not all emails are classified correctly."
2. **ARC keywords (`:456`)** — 28 substrings. Reasonable coverage but substring-based: "roof" matches "waterproofing"; "tree" is absent but "tree planting" is present.
3. **Violation keywords (`:462`)** — includes `"complaint"`, so **every resident complaint is filed as a Violation** regardless of whether anyone is violating anything. A complaint about pond algae becomes a Violation record against no one. **[V]**
4. Claude fallback (`:467`) with a 3-way choice — no retry, errors → `Other`.

**Categories the intended workflow names but the code has no concept of:** maintenance requests, resident questions, "emails from Mulloy or Eddie" as a first-class class. All of these land in `Other_Items` — which is an **admin-only tab** (`board.html:414`). **[V]** So the majority of the operational email the Board asked to see is routed into a bucket six of seven board members cannot open.

### 3.2 Attachment discovery — the concrete gap

```js
// scan-inbox.js:216
function getAttachments(msg) {
  const parts = msg.payload.parts || [];      // ← one level, no recursion
  for (const part of parts) {
    if (part.filename && part.body?.attachmentId) { ... }
  }
}
```

`decodeBody` immediately above it (`:198`) *does* recurse, with a comment explaining that a flat scan "silently dropped every board vote". **The same lesson was never applied to attachments.** **[V]**

Real Gmail structure for a message with text + photos is commonly `multipart/mixed → [multipart/alternative → [text/plain, text/html], image/jpeg]` — that works. But a forwarded message (the dominant case here, since Eddie forwards resident mail) nests as `multipart/mixed → [text/plain, message/rfc822 → multipart/mixed → [text, image/jpeg]]`, and **those attachments are invisible to this function**. **[E — high confidence, but worth confirming against one real forwarded ARC email before fixing.]**

Inline images (`Content-Disposition: inline` with a `Content-ID`) are found *only* if they happen to sit at the top level and carry a `filename`. Photos pasted into a Gmail compose window frequently do not. **[E]**

### 3.3 What the scanner does well

Worth stating so a fix doesn't destroy it: thread-level dedup keyed on a persisted Gmail thread ID is the right design; the MIME-recursive body decode is correct; the address-keyed directory resolution (`:720–750`) is a genuinely thoughtful solution to the "Eddie forwards everything" problem; and refusing to record a forwarder as the homeowner (`:743`) is exactly right. The vote-extraction prompt's refusal to infer denial from silence (`:164`) shows good judgment about the domain.

---

## 4. Board Portal — architecture & workflow

**Entry:** `board-login.html` → `POST board-api {action:"login"}` → `localStorage.board_token` + `board_user` → `board.html`. Guard is client-side only (`board.html:1319`).

**Structure:** one 2783-line HTML file, 16 tabs, `switchTab()` toggling `display`. All state in module-scope globals; `loadDashboard()` is called from **18 places**.

**Tabs visible to a non-admin board member (6 of 7 members):**
ARC Requests · Portal Access Requests · Announcements · Post Public Minutes · Residents · Community Map · Documents · Meeting Records · Special Meeting · Financials · Budget vs Actual

**Hidden from them** (`data-admin="true"`, `board.html:1333`):
Concerns & Requests · Violations · Other Items · Resident Requests · Activity Log

> **This is the central Board Portal finding.** The portal is presented as "the main operational workspace for Board members who may not regularly use Gmail." But four of the five work queues are hidden from almost everyone, and the one queue they *can* see (ARC) is the only one the scanner routes a minority of mail into. For a typical board member the portal is a **document viewer with a voting widget attached**, not a work queue. **[V]**

**ARC workflow (the one that works):** table → "Take Action" expands a detail row → AI summary (gated behind the `ai_suggestions` setting) → request details → attachments/Drive → 6-member vote grid → Approve / Deny / Approve-with-Conditions → conditions box → `castVote` → recount → optional "Notify Mulloy" email preview → send.

**Gmail-originated requests are indistinguishable from web-form ones.** There is no source field, no "from email" indicator, no link back to the Gmail thread. **[V]**

**Attachments display** (`board.html:1917–1922`): a Drive folder button when `drive_folder_url` is non-empty, plus one button per comma-separated entry in `attachment_urls`. For web-form ARCs, `attachment_urls` holds the prose string `"3 file(s) emailed to the board: a.jpg, b.jpg"` — which gets split on commas and rendered as **three broken link buttons** reading "Attachment 1/2/3". **[V]** `submit-request.js:378` → `board.html:1920`.

**Status vocabulary is inconsistent across item types:**

| Tab | Statuses | Set by |
|---|---|---|
| ARC | `Open` / `Approved` / `Denied` / `Tie - Tony Decides` | derived from votes |
| Violations | `Open` / free text via `updateStatus` | manual |
| Other Items | free text via `updateStatus` | manual |
| Resident Requests | `New` / free text via `updateRequestStatus` | manual |
| Access Requests | `New`/`Under Review`/`Approved`/`Rejected`/`Closed` (validated) | manual |

Only the last is server-validated (`access-requests.js:38`). Everything else accepts whatever string arrives. **[V]**

**Internal vs resident-facing separation:** correct where it was built deliberately — access requests keep `Internal Board Notes` (col I) strictly server-side and never expose them via a public endpoint (`board-api.js:508–513`). Violations use `comments_json`; Resident Requests use `board_notes`. Three different mechanisms for the same concept. There is **no resident-facing reply path at all** for ARC/Violation/Other items — the only outbound mail is "Notify Mulloy". **[V]**

**Error visibility:** `api()` (`board.html:1341`) returns `res.json()` regardless of status; most callers show a success toast without checking. `updateStatus` (`:2700`) shows "Status updated" unconditionally. **A failed write is indistinguishable from a successful one in the UI.** **[V]**

**Efficiency:** `getDashboard` performs 7 full-tab reads plus a full `Activity_Log` read on every call, and **writes a `viewed_dashboard` row to `Activity_Log` each time** (`board-api.js:289`). With 18 call sites, the audit log fills with noise, grows unbounded, and is re-read in full on every subsequent load. No caching, no pagination, no `If-Modified-Since`. **[V]**

**Mobile:** not assessed in this pass — no browser verification was run, per the investigate-only constraint. **[?]**

---

## 5. Admin Portal — architecture & workflow

**There is no Admin Portal.** No separate page, route, function, or login. Administration is:

- One field: `isAdmin: true` on the `raja` record (`board-api.js:53`). Every other member is `false`, including the President.
- A client-side reveal of three UI blocks and a hide of five tabs (`board.html:1325–1335`).
- **Five** server-checked actions: `setSetting`, `adminSetVotes`, `updateARC`, `addARC`, `deleteARC` (`board-api.js:331, 702, 773, 791, 809`).

**Administrative capability inventory:**

| Capability | Exists? | Where |
|---|---|---|
| Trigger an inbox scan | Yes — button + `prompt()` for `DIGEST_SECRET` | `board.html:364–376` |
| Choose scan window (7/30/90d, 3-step backfill) | Yes | `board.html:369–375` |
| Correct an AI-misread ARC record | Yes — 7 fields | `updateARC`, `board-api.js:779` |
| Create an ARC/Concern manually | Yes | `addARC` |
| Delete an ARC record | Yes — blanks the row | `deleteARC` |
| Record votes cast by email | Yes | `adminSetVotes` |
| Toggle site feature flags | Yes — `financials_published`, `ai_suggestions` | `setSetting` |
| View the activity log | Yes (admin-only tab) | `board.html:430` |
| **Reprocess a single failed email** | **No** | — |
| **Retry a failed Drive upload** | **No** | — |
| **See which emails were skipped and why** | **No** | — |
| **See scanner run history / last success** | **No** | — |
| **Manage board users or passwords** | **No** — hardcoded, redeploy required | `board-api.js:49–57` |
| **Configure Drive folders / sheet IDs** | **No** — env vars only | — |
| **Edit the resident directory** | **No** — read-only via `getResidents` | `board-api.js:298` |

**Board vs Admin separation — flags:**

- ❌ **Frontend-only restriction on reads.** `getDashboard` returns violations, other items, and resident requests to *any* authenticated member regardless of `isAdmin`; the tabs are merely `display:none`. Anyone with a board login and dev tools sees everything. **[V]**
- ❌ **`getResidents` has no admin check** (`board-api.js:298`) — returns the full directory: names, addresses, both phone numbers, emails, "frequent offender" flag, for ~144 homes. **[V]**
- ❌ **Destructive actions available to all members:** `deleteAnnouncement` (`:414`), `deleteMinutes` (`:471`) — both blank the row irrecoverably. No admin check, no soft-delete, no undo. **[V]**
- ❌ **Outbound email available to all members:** `sendNotification` (`:846`) sends mail *as the HOA* to Mulloy with a fully client-supplied subject and body. No admin check, no rate limit, no content validation. **[V]**
- ❌ **Hardcoded credentials.** Seven plaintext passwords in source, in git history (`board-api.js:50–56`). Compared with `!==` rather than a constant-time compare. **[V]**
- ⚠️ **Dead code path:** `board-api.js:848` computes `token2` from `getGoogleToken(...)` and never uses it — and passes `null` as the service-account email when `GMAIL_CLIENT_ID` is set. Harmless today; confusing and fragile. **[V]**
- ⚠️ **`listMessages()` in `scan-inbox.js:53` is defined and never called.** **[V]**

---

## 6. Board vs Admin responsibility matrix

| Action | Endpoint | Server check | Reachable by ordinary member? | Should be |
|---|---|---|---|---|
| Log in | `login` | password | — | — |
| View dashboard (all queues) | `getDashboard` | session only | **Yes (all data)** | Member — but scope the payload |
| View resident directory | `getResidents` | **none beyond session** | **Yes** | Member (read) — but log it |
| Cast own vote | `castVote` | session only | Yes | Member ✅ |
| Record votes on behalf | `adminSetVotes` | `isAdmin` | No | Admin ✅ |
| Edit ARC record | `updateARC` | `isAdmin` | No | Admin ✅ |
| Create ARC/Concern | `addARC` | `isAdmin` | No | Admin ✅ |
| Delete ARC record | `deleteARC` | `isAdmin` | No | Admin ✅ |
| Change item status | `updateStatus` | session only | Yes | Member ✅ |
| Change request status | `updateRequestStatus` | session only | Yes | Member ✅ |
| Add internal note | `addRequestNote`, `addComment`, `addAccessRequestNote` | session only | Yes | Member ✅ |
| Post announcement | `addAnnouncement` | session only | Yes | Member ✅ |
| Edit announcement | `updateAnnouncement` | session only | Yes | Member ✅ |
| **Delete announcement** | `deleteAnnouncement` | **none** | **Yes** | **Admin ❌** |
| Post/edit minutes | `addMinutes`, `updateMinutes` | session only | Yes | Member ✅ |
| **Delete minutes** | `deleteMinutes` | **none** | **Yes** | **Admin ❌** |
| **Send email to Mulloy** | `sendNotification` | **none** | **Yes** | **Admin or President ❌** |
| Send resident access reply | `sendAccessResponse` | session only | Yes | Member (arguably) ⚠️ |
| **Change site settings** | `setSetting` | `isAdmin` | No | Admin ✅ |
| **Run inbox scan** | `scan-inbox` | `DIGEST_SECRET` | Only if they learn the secret | Admin / scheduler ⚠️ |
| Public reads | `getPublic*` | none (intended) | — | Public ✅ |

**Summary: 4 actions are materially under-protected** (`deleteAnnouncement`, `deleteMinutes`, `sendNotification`, `getResidents`), and **all 5 admin-checked actions are protected by a check that a forged token defeats anyway** (§7).

---

## 7. Authentication & authorization assessment

### 7.1 Board portal — the critical defect

```js
// board-api.js:169  — MINT
const token = Buffer.from(JSON.stringify({
  username, name, role, isAdmin, exp: Date.now() + 8*60*60*1000
})).toString("base64");

// board-api.js:240  — VERIFY
session = JSON.parse(Buffer.from(sessionToken, "base64").toString());
if (session.exp < Date.now()) throw new Error("Expired");
```

There is **no signature**. The "verification" step decodes attacker-supplied data and trusts every field in it, including `isAdmin`. **[V]**

Practical consequence: a single unauthenticated HTTP request carrying a self-constructed token yields administrator access to every action in §6 — including `deleteARC` (destroys a record), `getResidents` (exfiltrates the directory for ~144 households), `sendNotification` (sends mail as the HOA), and `setSetting` (publishes or hides site content). No password is required and nothing in the system would record it as anomalous, because `logActivity` faithfully records whatever `session.username` claims to be.

**The contrast is instructive.** `lib/resident-auth.js` — written months later for the resident portal — does this properly: HMAC-SHA256 over the payload, `timingSafeEqual` comparison, purpose and version fields, HttpOnly/Secure/SameSite cookie (`resident-login.js:137`), randomized failure delay. **The fix for the board portal is to apply the pattern that already exists in this repo**, not to invent one. **[V]**

### 7.2 Other auth surfaces

| Surface | Mechanism | Assessment |
|---|---|---|
| Board portal | unsigned base64, `localStorage`, 8h | **Broken** (§7.1). Also XSS-readable — see §8. |
| Resident portal | HMAC-signed, HttpOnly cookie, versioned | Sound |
| `scan-inbox` | shared `DIGEST_SECRET`, client-supplied | Weak — see below |
| `email-digest` | same `DIGEST_SECRET` | Weak, and coupled |
| `health-check` | **none** — public GET/POST | Acceptable (idempotent, no secrets returned) but it *writes* to the Settings sheet, so it is an unauthenticated write endpoint. **[V]** |
| Public reads | none, by design | Correct |
| `submit-request` | none, `Access-Control-Allow-Origin: *` | No rate limit, no CAPTCHA, no honeypot — a spam/abuse vector that also writes to `ARC_Requests` and sends mail. **[V]** |

**`DIGEST_SECRET` handling is poor:** it is typed into `prompt()` (`board.html:2733`) and POSTed from the browser. It therefore lives in browser memory and is visible to anyone shoulder-surfing or with devtools open, and it is shared between two functions. Project memory already flags it as due for rotation. **[V]**

**Authorization model overall:** a single boolean is being asked to express a 7-person board with distinct offices (President, VP, Treasurer, Secretary, three Members at Large). It cannot. Roles are already stored (`board-api.js:50–56`) but are used only for display.

---

## 8. Gap analysis

### 8.1 Scanner

| # | Gap | Evidence | Effect |
|---|---|---|---|
| S1 | No pagination; hard cap of `maxResults` | `:659` | Older qualifying mail never seen **[V/E]** |
| S2 | Dedup runs *after* listing | `:685` | Already-seen threads consume the budget **[V]** |
| S3 | No scheduled run | `netlify.toml` | Processing depends on a manual click **[V]** |
| S4 | Query is `in:inbox` only | `:651` | Archived/labelled/filtered mail invisible; read mail included forever **[V]** |
| S5 | `getAttachments` is non-recursive | `:219` | Attachments in nested/forwarded parts lost **[V/E]** |
| S6 | Attachment failures swallowed | `:789` | Request created with silently incomplete attachments **[V]** |
| S7 | Drive calls never status-checked | `:239, 269, 290` | `.../folders/undefined` links that *look* valid **[V]** |
| S8 | `sheetsAppend` result ignored by caller | `:334` vs `:826` | Request silently not created **[V]** |
| S9 | `getGmailToken` doesn't check for errors | `:45` | Expired token ⇒ whole run reports 200/success **[V]** |
| S10 | Financial veto precedes ARC detection | `:452` | ARC emails misfiled as Other **[V]** |
| S11 | "complaint" ⇒ Violation | `:462` | Complaints filed as violations against no one **[V]** |
| S12 | Body truncated to 2000 chars | `:208` | Long requests classified on a fragment **[V]** |
| S13 | No maintenance/question categories | `:396–405` | Real work routed to an admin-only tab **[V]** |
| S14 | No per-message outcome record | throughout | Root cause of unsupportability **[V]** |
| S15 | No reply/new-message handling on an existing thread | `:685` | A resident's follow-up is skipped as a dup; the Board never learns of it **[V]** |
| S16 | Claude errors return `{}` and still write a row | `:441` | Blank request records **[V]** |
| S17 | No retry on any external call | throughout | A single transient 503 loses the item **[V]** |
| S18 | No size/type guard on attachments | `:784` | A large attachment can blow the 300s budget or memory **[E]** |

### 8.2 Board Portal

| # | Gap | Evidence |
|---|---|---|
| B1 | Most work queues hidden from most members | `board.html:412–430` **[V]** |
| B2 | No unified "needs attention" view | — **[V]** |
| B3 | No assignment / owner / due date on any item | schemas **[V]** |
| B4 | No source indicator (Gmail vs web form) | **[V]** |
| B5 | No link back to the originating Gmail thread | thread ID stored but never surfaced **[V]** |
| B6 | Failed writes render as success | `board.html:1341, 2700` **[V]** |
| B7 | Prose rendered as attachment links | `submit-request.js:378` → `board.html:1920` **[V]** |
| B8 | Status vocabulary inconsistent & unvalidated | §4 **[V]** |
| B9 | Three different internal-note mechanisms | **[V]** |
| B10 | No resident-facing reply for ARC/Violation/Other | **[V]** |
| B11 | `Activity_Log` polluted by `viewed_dashboard` and read in full each load | `board-api.js:258, 289` **[V]** |
| B12 | 7 full-sheet reads per dashboard load, no caching | `:251–259` **[V]** |
| B13 | Unescaped interpolation of sheet data into HTML | `board.html:1899–1920` **[V]** — see §10 |

### 8.3 Admin

| # | Gap |
|---|---|
| A1 | No reprocess/retry/repair capability of any kind **[V]** |
| A2 | No diagnostics surface (no run history, no failure list) **[V]** |
| A3 | Passwords hardcoded; rotation requires a deploy **[V]** |
| A4 | Single admin (`raja`) — no continuity if unavailable **[V]** |
| A5 | Four destructive/outbound actions ungated (§6) **[V]** |
| A6 | Admin reads gated only in the browser **[V]** |

---

## 9. Root-cause hypotheses for the known failures

### 9.1 "Some qualifying emails do not become Board requests"

**Primary:** S1+S2 — the 10-message ceiling with post-listing dedup. **[E, high confidence]** Test: run a scan and compare `results.skipped` against `maxEmails`; if they are equal or near-equal, every slot was consumed by already-processed threads and no new mail was reachable.

**Secondary, in order of likelihood:**
- S10 — the financial-keyword veto capturing ARC emails. **[V mechanism]**
- The `Other` + `needs_attention:"no"` drop (`:718`) — Claude Haiku deciding an email needs no action. No record is kept, so this is currently unmeasurable. **[V]**
- S9 — an expired Gmail token producing a full-run silent failure that reports success. Given the token's documented ~7-day expiry in testing mode (project memory), this is likely to have happened repeatedly. **[E, high confidence]**
- S15 — replies on an existing thread are skipped by design.
- S3 — scans that were simply never run.

### 9.2 "Some attachments are missing from Google Drive"

- **S5** (non-recursive part walk) for forwarded mail — the dominant email shape here. **[E, high confidence]**
- **S6** (swallowed upload errors) — the request is created anyway, so the loss is invisible.
- **§9.3** — for web-form ARCs, attachments were *never intended* to reach Drive.

### 9.3 "Some requests have missing Drive links"

Two distinct causes:

1. **Web-form ARCs never get one.** `submit-request.js:385` writes `""` into `drive_folder_url` (col I) and a prose note into `attachment_urls` (col J). This is deliberate — project memory records that **the Google service account has no Drive storage quota and file uploads fail** (folder *creation* works; file *upload* does not). **[V in memory; E that it still holds]** ⚠️ **This raises a question that must be resolved before any fix:** if service-account uploads genuinely fail, then `uploadFileToDrive` in `scan-inbox.js:251` is *also* failing — silently, per S7 — and the scanner's Drive folders may contain nothing but the `ai_summary.txt` (which would fail too). **[?] This is the single most important thing to verify empirically before planning attachment work.** Open one scanner-created Drive folder and check whether any files are actually in it.
2. **Failed folder creation writing `undefined`.** `createDriveFolder` returns `JSON.parse(r.body).id` with no status check; on failure the URL becomes `https://drive.google.com/drive/folders/undefined`. The guard at `:781` catches `undefined` for folders — but **not** for `uploadFileToDrive`, whose failed result becomes `https://drive.google.com/file/d/undefined/view` and is pushed into `attachmentUrls`. **[V]**

### 9.4 "Not all emails are classified correctly"

S10 (financial veto ordering), S11 (complaint⇒Violation), S12 (2000-char truncation), S13 (no category for maintenance/questions), and substring matching without word boundaries. **[V]**

### 9.5 "Reliability appears inconsistent"

This is the aggregate signature of **an unrecorded pipeline with a manual trigger and a periodically-expiring token**. The same button run twice on the same day can produce entirely different results depending on how much mail arrived, whether the token happened to be alive, and which ten threads Gmail returned. **[E]**

---

## 10. Silent-data-loss scenarios

Ranked by likelihood × invisibility.

| # | Scenario | Mechanism | Visible anywhere? |
|---|---|---|---|
| 1 | Qualifying email never processed | S1/S2 — beyond the 10-message window | **No** |
| 2 | Entire run fails on an expired Gmail token, reports success | `:45` no error check; per-message catch → `skipped` | **No** — reports HTTP 200 |
| 3 | Attachment lost in a nested MIME part | S5 | **No** |
| 4 | Attachment download or upload throws | `:789` `console.log` only | **No** |
| 5 | Drive upload returns an error body → `.../d/undefined/view` | `:269` | **Looks like a working link** |
| 6 | `sheetsAppend` fails → request never created, but the Drive folder exists | `:334` result ignored | **No** — orphan folder, no row |
| 7 | **Jodi Budenaers casts a vote** | `jodi` is in `BOARD_MEMBERS` (`:56`) but has **no vote column, no `voteColMap` entry** (`:667`), and is absent from `scan-inbox` `VOTE_ORDER`/`BOARD_VOTE_EMAILS`. `castVote` builds range `ARC_Requests!undefined<row>`; `sheetsUpdate` never checks the response | **No — she gets a success toast** **[V]** |
| 8 | Claude returns an error → blank ARC row created | `:441` returns `{}` | Partially — blank fields |
| 9 | Resident replies to an existing thread with new information | Thread dedup skips it | **No** |
| 10 | Email dropped as "needs_attention: no" | `:718` | **No** |
| 11 | `deleteARC` blanks `A:AV` **including the thread ID in AU** → the Gmail thread becomes eligible for re-creation on the next scan | `board-api.js:815` | Reappears as a "new" request |
| 12 | Scanner times out at 300s mid-batch | Written rows persist; no resume marker, no record of where it stopped | **No** |
| 13 | Web-form ARC + scanner both create a record for the same request | §9.3(1) + no thread ID on the web-form row | Two rows, no link |
| 14 | Any board write fails at the Sheets layer | `board-api.js` never checks `sheetsUpdate`/`sheetsAppend` results | **No — success toast** |

**#7 and #14 deserve emphasis:** these are not scanner problems. A board member takes an action, the UI confirms it, and nothing happened. That is the worst failure mode a work queue can have, because it destroys trust in every other confirmation the system gives.

---

## 11. Risk matrix

| Sev | ID | Risk | Impact | Likelihood |
|---|---|---|---|---|
| 🔴 **Critical** | R1 | Forgeable session ⇒ unauthenticated admin (`board-api.js:169/240`) | Full data access + destructive writes + email as the HOA | Low today (obscurity), catastrophic if found |
| 🔴 **Critical** | R2 | Scanner's 10-message ceiling ⇒ qualifying emails never processed | Board work items missing; residents unanswered | **Occurring now** |
| 🔴 **Critical** | R3 | Whole-run silent failure on expired Gmail token, reported as success | Days of mail unprocessed with no signal | High (token expires ~weekly) |
| 🟠 High | R4 | No run/message audit ⇒ nothing is diagnosable | Every future incident is guesswork | Certain |
| 🟠 High | R5 | Stored XSS: user-controlled filename → `href="${url}"` unescaped (`submit-request.js:378` → `board.html:1920`); also `ai_summary`/`ai_reasoning`/`ai_pros`/`ai_cons`/`drive_folder_url` interpolated raw | Executes in a session that can delete records; token is `localStorage`-readable | Low intent, trivial to exploit |
| 🟠 High | R6 | Jodi's votes silently discarded | Wrong vote counts; a decision recorded incorrectly | **Occurring now** |
| 🟠 High | R7 | Vote vocabulary split `Approve` vs `Approved` | Portal counter disagrees with `final_status`; scanner-detected approvals show as 0 | **Occurring now** |
| 🟠 High | R8 | Attachments lost (S5/S6) with no record | Board decides without seeing the photos | High |
| 🟠 High | R9 | Ungated destructive/outbound actions (`deleteAnnouncement`, `deleteMinutes`, `sendNotification`) | Irrecoverable content loss; mail sent as the HOA | Medium |
| 🟠 High | R10 | Full resident directory readable by any board session, unlogged | PII exposure, ~144 households | Medium |
| 🟡 Medium | R11 | Duplicate ARC records (web form + scanner) | Board confusion, double work | Medium |
| 🟡 Medium | R12 | `undefined` Drive URLs presented as working links | Board clicks into nothing | Medium |
| 🟡 Medium | R13 | Misclassification (financial veto, complaint⇒Violation) | Work in the wrong queue | High, low severity each |
| 🟡 Medium | R14 | Failed board writes shown as success | Loss of trust in the tool | Medium |
| 🟡 Medium | R15 | `Activity_Log` unbounded + noise-dominated, fully re-read per load | Dashboard slows, audit trail unusable | Certain over time |
| 🟡 Medium | R16 | Plaintext passwords in git history | Requires a deploy to rotate | Certain |
| 🟢 Low | R17 | `submit-request` unrate-limited, `CORS: *` | Spam into `ARC_Requests` | Low |
| 🟢 Low | R18 | `health-check` is an unauthenticated write endpoint | Settings-sheet noise | Low |
| 🟢 Low | R19 | Dead code (`listMessages`, `token2`) | Maintenance confusion | Certain |

---

## 12. Technical debt inventory

1. **`board-api.js` is a 26-branch if-chain in one 897-line handler.** No routing table, no shared auth middleware, no per-action permission declaration. Adding an action means remembering to add a check.
2. **Sheets-as-database with load-bearing column letters.** `voteColMap = {tony:"P", ..., mike:"AJ"}` (`:667`) is hand-maintained in four parallel objects, plus `VOTE_ORDER` in `scan-inbox.js:806`, plus `memberVotes` in `board.html:1868`, plus the header arrays in **three** files. Adding Jodi required touching all of them; it touched one. **This is exactly how R6 happened.**
3. **Two writers on `ARC_Requests` with different column counts** (47 vs 16) and no shared schema module.
4. **Schema definitions duplicated in three places** — `scan-inbox.js:312`, `board-api.js:117`, `submit-request.js:210`. They currently agree; nothing enforces that.
5. **No result checking on any Sheets write in `board-api.js`.**
6. **`board.html` is 2783 lines** of markup, CSS, and logic with 18 `loadDashboard()` call sites and module-scope mutable state.
7. **Two escaping helpers** (`esc` at `:1381`, `escapeHtml` at `:2060`) with different character sets, applied inconsistently.
8. **Copy-pasted infrastructure:** `httpsReq` and `getGoogleToken` reimplemented in ~6 files with subtle differences (some check for errors, some don't).
9. **`refreshGmailToken` (`board-api.js:870`) makes a pointless first HTTP request** with a `null` body before doing the real one.
10. **No tests for the scanner or the board API.** Three test scripts exist, all for the resident portal (`scripts/test-*.js`).
11. **Dead code:** `listMessages` (`scan-inbox.js:53`), `token2` (`board-api.js:848`).
12. **Env vars referenced in code but absent from `.env`:** `DIGEST_SECRET`, `GOOGLE_DRIVE_FOLDER_ID`, `ANTHROPIC_API_KEY`, `RESIDENT_ACCESS_REQUESTS_SHEET_NAME`. **[E: set in Netlify only — local scanner runs would fail.]**

---

## 13. Documentation gaps

**`HANDOVER.md` (34 KB) contains zero occurrences of "scan-inbox", "scanner", or "inbox".** **[V]** The single most complex and least reliable component in the system is entirely undocumented. `docs/` covers announcements, resident access requests, resident portal setup, and the phase-2 plan — the scanner appears only as a filename in an inventory list (`website-phase2-masterplan.md:68`).

Missing entirely:

- **Inbox Scanner operations** — what it does, when to run it, what the menu options mean, what "Deep Backfill · run each once" implies, what the returned counts mean, what to do when they look wrong.
- **Undocumented environment variables** — `DIGEST_SECRET`, `GOOGLE_DRIVE_FOLDER_ID`, `ANTHROPIC_API_KEY`, `RESIDENT_ACCESS_REQUESTS_SHEET_NAME`.
- **Google permission requirements** — Gmail scopes (`https://mail.google.com/`), the service-account Sheets+Drive scopes, which account owns what, **and the service-account Drive-quota limitation** (currently only in a session memory, not in the repo).
- **Drive folder contract** — `<ROOT>/ARC Requests/<year>/<ID> — <address>`, and that folder names are derived from data.
- **Sheet schemas** — the 46-column `ARC_Requests` layout, the unheadered thread-ID columns (`AU` / `O` / `J`), and a loud warning that column letters are load-bearing in four files.
- **Board vote column map** and the checklist for adding a board member (currently: 7 places).
- **The two-writer arrangement** on `ARC_Requests`.
- **Board Portal user guide** for non-technical members — what each tab is for, what a status means, what "4 needed for majority" means now that there are 7 members.
- **Admin runbook** — Gmail token renewal (partially in memory, not in the repo), what to do when a scan reports odd numbers, how to correct a misfiled item, how to rotate a board password.
- **Recovery procedures** — there are none, because there are no recovery capabilities (§5).

**Outdated / incorrect:**
- `board.html:1932` says "4 needed for majority" and the vote grid shows 6 members; the board is now 7 (`board-api.js:56`).
- `board.html:1332` comment claims non-admins "see only ARC Requests, Announcements, Meeting Minutes" — they actually see 11 tabs.
- `PROGRESS.md` (last touched 2026-06-11) predates most of the current system. **[E]**

---

## 14. Prioritized implementation plan

Sequenced so that each phase makes the next one safe or measurable. **Nothing here is implemented; all of it awaits approval.**

### Phase 0 — Stop the bleeding (do first, small, independent)

| # | Change | Problem | Impact | Root cause | Effort | Risk | Class |
|---|---|---|---|---|---|---|---|
| 0.1 | HMAC-sign the board session using the existing `lib/resident-auth.js` pattern; add a `BOARD_SESSION_SECRET`; verify signature + expiry server-side | R1 — session is forgeable | Removes unauthenticated admin access | Token was never signed | **S** (~1–2h) | **Low** — reuses a proven in-repo helper; all members re-login once | **Security** |
| 0.2 | Add `jodi` to the sheet header, `VOTE_ORDER`, all four column maps, `BOARD_VOTE_EMAILS`, and the portal vote grid; guard `castVote` to reject an unknown member with a 400 | R6 — votes silently discarded | Her votes count; no more silent loss | Column maps hand-maintained in 7 places | **S** (~1h) | Low | **Bug fix** |
| 0.3 | Unify vote vocabulary on `Approved`/`Denied`/`Conditional`; migrate existing `Approve`/`Deny` cells | R7 — counters disagree with status | Vote counts become trustworthy | Two authors, two vocabularies | **S** (~1–2h) | **Medium** — touches live data; do a sheet backup first | **Bug fix** |
| 0.4 | Check `res.status` on every `sheetsUpdate`/`sheetsAppend`/Drive call; return a real error; make `api()` in `board.html` surface it | R14, #6, #12, S7, S8 | Failed writes stop showing as success | No result checking anywhere | **M** (~3–4h) | Low | **Reliability** |
| 0.5 | Escape all sheet-derived values before HTML interpolation in `board.html` (ai_*, drive_folder_url, attachment_urls) | R5 — stored XSS | Closes the injection path | Inconsistent use of the existing `esc()` | **S** (~1h) | Low | **Security** |
| 0.6 | Add `isAdmin` checks to `deleteAnnouncement`, `deleteMinutes`, `sendNotification`; add one to `getResidents` or log every access | R9, R10 | Destructive/outbound actions gated | Checks added ad hoc per action | **S** (~1h) | Low — but confirm with the owner *who* should retain each | **Security** |

### Phase 1 — Make the scanner actually see the mail

| # | Change | Problem | Impact | Root cause | Effort | Risk | Class |
|---|---|---|---|---|---|---|---|
| 1.1 | Add Gmail `pageToken` pagination; keep fetching until the window is exhausted or a per-run cap is hit; **apply thread dedup during pagination so skipped threads don't consume the budget** | R2 / S1+S2 | The largest single reliability win | No pagination; dedup after listing | **M** (~4h) | **Medium** — more Claude calls and API volume per run; needs a cost/time cap and testing against the 300s timeout | **Reliability** |
| 1.2 | Check the token response in `getGmailToken`; fail the whole run loudly (non-200 + a written run record) when Gmail auth fails | R3 | Ends whole-run silent failures | No error check at `:45` | **S** (~1h) | Low | **Reliability** |
| 1.3 | Make `getAttachments` recurse the MIME tree (mirroring `decodeBody`); include `message/rfc822` sub-parts and inline images with a Content-ID | R8 / S5 | Attachments stop disappearing | Fix applied to body decoding but not attachments | **S** (~2h) | Low | **Bug fix** |
| 1.4 | **Verify the service-account Drive-quota question (§9.3)** before any further attachment work; if uploads genuinely fail, decide between a Shared Drive, an OAuth-user upload, or keeping email delivery and being honest about it in the UI | R12 / §9.3 | Determines whether attachment storage is fixable at all | Service account has no storage quota | **S** to verify; **M–L** to fix | — | **Investigation → Architecture** |
| 1.5 | Add a scheduled scan in `netlify.toml` (e.g. `0 */6 * * *`), authenticated by an env-var secret rather than a browser prompt; keep the manual button for backfills | S3 | Processing stops depending on a person | Never scheduled | **S** (~1h) | Low — but confirm Netlify credit impact with the owner first | **Reliability** |

### Phase 2 — Make it observable

| # | Change | Problem | Impact | Root cause | Effort | Risk | Class |
|---|---|---|---|---|---|---|---|
| 2.1 | New `Scan_Runs` tab: `run_id, started_at, finished_at, window, listed, created, skipped, failed, status, error`. Write a row at start and update at end | R4 | "When did it last work?" becomes answerable | No run record | **S** (~2h) | Low | **Reliability** |
| 2.2 | New `Scan_Log` tab, one row per message: `run_id, thread_id, message_id, subject_snippet, decision (created/dup/skipped/failed), reason, category, item_id, attachments_found, attachments_uploaded, error` | R4, #10, S14 | Every "why wasn't this a request?" becomes a lookup | No per-message record | **M** (~3h) | Low | **Reliability** |
| 2.3 | Add `scan_status` + `attachments_expected` / `attachments_uploaded` to ARC/Violation/Other rows; flag any row where they disagree | #4, #5, S6 | Incomplete requests become identifiable | Failures swallowed per-attachment | **M** (~3h) | Low | **Reliability** |
| 2.4 | Stop writing `viewed_dashboard` to `Activity_Log`; read only the tail | R15 | Audit log becomes usable; dashboard gets faster | Logging a read as an action | **S** (~30m) | Low | **Reliability** |
| 2.5 | Admin "Scanner Health" panel: last successful run, last run's counts, recent failures with reasons, and a per-item **Reprocess** button | A1, A2 | First actual recovery capability | No diagnostics surface | **L** (~1–2 days) | Low | **Usability** |

### Phase 3 — Make it a work queue for non-technical members

| # | Change | Problem | Impact | Effort | Risk | Class |
|---|---|---|---|---|---|---|
| 3.1 | Replace the `isAdmin` boolean with a role + a server-side per-action permission table; declare permissions in one place | §7.2, A5 | Authorization stops being ad hoc | **M** (~4h) | Medium — must enumerate every action deliberately | **Security / Architecture** |
| 3.2 | Unhide the operational queues for all board members (keep Activity Log admin-only), scoping `getDashboard` by role server-side | B1 | The Board can finally see its own work | **M** (~3h) | Low — but a product decision the owner must confirm | **Usability** |
| 3.3 | A single "Needs Attention" home tab across all item types, sorted by age, with a per-member "assigned to me" filter | B2, B3 | Turns a viewer into a queue | **L** (~1–2 days) | Low | **Usability** |
| 3.4 | Add `source` (gmail / web / manual) and a Gmail thread deep-link to every item | B4, B5 | Board can open the original email in one click | **S** (~2h) | Low | **Usability** |
| 3.5 | Add categories for Maintenance and Resident Question; move the financial veto to run *after* ARC detection; stop mapping "complaint" to Violation | S10, S11, S13, R13 | Items land in the right queue | **M** (~3h) | Medium — changes classification of future mail; validate against a sample first | **Bug fix** |
| 3.6 | Link web-form ARCs to their notification email (write a synthetic thread key) to stop the duplicate pair | R11 | One request, one record | **M** (~3h) | Low | **Bug fix** |
| 3.7 | Move board passwords out of source into env/hashed storage; add a rotation path that doesn't need a deploy | R16, A3 | Credentials rotatable | **M** (~3h) | Low | **Security** |
| 3.8 | Extract shared schema/column-map/`httpsReq`/`getGoogleToken` into `lib/`; single source of truth | Debt 1–4, 8 | Adding a board member becomes one edit | **L** | Medium — wide blast radius; do last | **Architecture** |

### Phase 4 — Documentation (do alongside, not after)

`docs/inbox-scanner.md` (operations + schema + recovery), `docs/board-portal-guide.md` (for non-technical members), `docs/admin-runbook.md` (token renewal, password rotation, scan triage), and an env-var reference. **Effort: M. Risk: none. Class: usability.**

---

## 15. Recommended test strategy

The repo already has a good pattern to copy: `scripts/test-resident-auth.js`, `test-resident-audit-e2e.js`, `test-access-requests.js` are plain Node scripts run via `npm run test:*`, no framework. Extend that rather than introducing one.

**Unit (pure functions, no network) — highest value per hour:**
- `categorizeEmail` against a fixture corpus of ~30 real anonymized emails, including the known-bad cases: an ARC request mentioning "bill", a complaint that isn't a violation, a maintenance request, a Mulloy forward.
- `getAttachments` against saved Gmail `messages.get` JSON payloads — flat, nested, forwarded `message/rfc822`, inline-image. **This is the direct regression test for S5.**
- `decodeBody`, `topReply`, `extractOriginalSender`, `boardKeyForEmail`, `generateId`, `extractArcNumber`.
- Session sign/verify: valid, tampered `isAdmin`, tampered expiry, wrong secret, malformed. **This is the regression test for R1.**

`.claude/inbox-dump.json` and `.claude/fetch-threads.mjs` already exist and appear to be exactly the fixture-capture tooling this needs. **[E — worth confirming their contents before building new capture scripts.]**

**Integration (against a dedicated test spreadsheet + a test Gmail label — never production):**
- Full scan of a seeded mailbox: N qualifying emails in, N requests out, counts reconcile with the `Scan_Log`.
- Idempotency: run twice, assert zero new rows on the second run.
- Pagination: seed 25 emails with a `maxEmails` of 10, assert all 25 are reachable.
- Injected failures: Drive upload 500, Sheets append 500, Gmail token 401 — assert each produces a *recorded* failure and a non-success response, not a silent skip.
- Authorization matrix: for each of the 26 actions × {no token, forged token, member token, admin token}, assert the expected status. Table-driven; this is the highest-leverage single test in the suite.

**Manual verification checklist (per CLAUDE.md rule 1 — render before claiming):**
- Board portal at desktop and ~375px, as both an admin and a non-admin member.
- One real ARC with photos through the full path: email → scan → Drive folder → portal → attachment opens.
- A vote from each of the 7 members, including Jodi.
- Console clean; no failed network requests.

**Do not build:** a mocking framework, a CI pipeline, or coverage tooling. The owner is non-technical and Netlify credits are limited; tests that only ever run locally on demand are the right ceiling here.

---

## 16. Implementation recommendation — the smallest sufficient set

If only a few things are done, do these — chosen because each removes a whole class of failure rather than one instance.

**To make inbox scanning reliable (3 changes):**
1. **Pagination + dedup-during-listing** (1.1). Without this, nothing else about the scanner matters.
2. **Fail loudly on Gmail auth failure** (1.2). One line of error checking ends the most common invisible outage.
3. **Scheduled runs** (1.5). Reliability cannot depend on someone remembering.

**To make attachment storage complete and traceable (2 changes + 1 decision):**
4. **Recursive `getAttachments`** (1.3).
5. **Status-check every Drive/Sheets call; never write an `undefined` URL** (0.4). A missing link is recoverable; a broken link that looks real is not.
6. **Decide the Drive-quota question** (1.4) — this is a prerequisite, not a task. If service-account uploads fail, items 4–5 improve traceability but not storage, and the honest fix is a Shared Drive.

**To make Board work items consistent (3 changes):**
7. **Unify the vote vocabulary and add Jodi** (0.2 + 0.3).
8. **Add a `Scan_Log` with a per-message decision and reason** (2.2). This converts every future "why didn't this show up?" from an investigation into a lookup — and it is the change that makes the system supportable at all.
9. **Add `source` + Gmail thread deep-link** (3.4).

**To make Board Portal review easy for non-technical users (2 changes):**
10. **Unhide the operational queues** (3.2) — subject to the owner's confirmation that all members should see them. Today the portal cannot be "the main operational workspace" while most of the work is hidden from most of the board.
11. **A single "Needs Attention" view** (3.3).

**To make admin responsibilities secure and understandable (3 changes):**
12. **Sign the session** (0.1). Everything else labelled "admin only" is decoration until this is done.
13. **Gate the four under-protected actions** (0.6).
14. **A Scanner Health panel with per-item reprocess** (2.5) — the first real recovery capability, and the thing that turns §10's silent-loss list from permanent to correctable.

**Portal structure: keep one portal.** Do not split Board and Admin into separate applications. The current shape — one shell with permission-controlled modules — is correct and already ~80% there. Splitting would duplicate the shell, the auth, and the data layer while fixing none of the actual problems, all of which are about *enforcement* and *observability* rather than layout. The right move is to finish the model that exists: signed sessions, a declared permission table, and a role field instead of a boolean (3.1).

**Suggested sequence:** Phase 0 (a day, mostly small and independent) → Phase 1 (the reliability core) → Phase 2 (observability, which makes Phase 1 verifiable) → Phase 3 (product work, needs owner input) → Phase 4 documentation written alongside each phase rather than at the end.

**Deploy note (per CLAUDE.md):** Netlify credits are limited and deploys build from `main`. These phases should be batched into as few pushes as the owner's risk tolerance allows — Phase 0 is a natural single deploy, as is Phase 1+2 together.

---

### Open questions for the owner — answers change the plan

1. **Does the service account actually succeed at Drive *file* uploads today?** (§9.3) Open a scanner-created Drive folder and say whether files are in it. This determines whether the attachment work is a bug fix or an infrastructure change.
2. **Should all board members see Violations, Other Items, and Resident Requests?** (3.2) This is a governance decision, not a technical one, and it changes both the portal design and the permission table.
3. **Who besides Raja should hold admin rights?** Currently there is a single point of failure.
4. **Is a scheduled scan acceptable given the Netlify credit budget?** (1.5) A 6-hourly scan is 4 invocations a day plus Claude API calls.
