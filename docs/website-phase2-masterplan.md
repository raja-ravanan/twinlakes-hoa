# Twin Lakes at Floyds Fork — Website Phase 2 Masterplan

> **Status:** Approved priority order & scope locked (2026-07-22). Ready to implement Phase 1A on owner's go-ahead. No code has been written yet.
> **Branch:** `website-phase-2`
> **Verification note:** System analysis (Steps 1–2) is derived from *reading* the codebase, sourced to specific files/lines — not from running it. Claims about how a proposed change would behave are marked "expected."

---

## Approved priority order

1. **Organize and improve the public website first.**
2. **Add a Resident Portal nav item + an informational "Under Construction" page** — *no authentication yet.*
3. **Design and implement secure resident authentication only after** the public-website phase is complete and approved.
4. **Defer all other enhancements** until afterward.

This document now covers **Priorities 1 and 2 only** (the immediate implementation, split into Phases 1A–1E). Authentication (Priority 3) and everything else (Priority 4) are described only as **deferred** — they are *not* designed here and must not be built until the public phase is approved.

## Approved immediate scope (Phases 1A–1E)

**In scope now:**
- Preserve the existing Board Portal and its **no-deploy announcement publishing workflow**.
- Extend the announcement schema **only** with fields required for organization (simplified list below).
- Add **reusable announcement rendering** (one shared function).
- Add **Latest Updates** to the homepage.
- Add **Upcoming Work** to the homepage.
- Add a **conditional Critical Alert** to the homepage.
- Add **category filtering** on the Updates page.
- Add a **monthly archive** on the Updates page.
- **Clearly separate** dynamic announcements from permanent **Community Reminders & Policies**.
- Improve **mobile usability and accessibility**.
- Add a **Resident Portal** navigation item.
- Add a **static Resident Portal "Under Construction"** page.
- **Do not** add login forms, password collection, signup, authentication packages, or protected data yet.

**Explicitly deferred (do not build now):**
Netlify Identity or any authentication implementation · dedicated Projects sheet · project administration screens · search · hash routing / deep links · resident directory · private documents · personalized dashboards · major redesign · any new framework, database, or dependency.

## Guiding principle

Build **on top of** the current architecture. The site's core strength is that *announcements are live data posted from the Board Portal, and posting one does **not** require a deploy.* Phase 2 makes that same mechanism carry more structure — richer data, smarter derived views — with **zero new publishing steps** and **no unnecessary fields** for the board. Every change is a **token operation and a backwards-compatible schema extension**, never a rewrite.

---

# STEP 1 — The current system

### Overall architecture
A **single-page static site** with a **serverless backend** and **Google Sheets as the datastore**. No build step, no framework. The browser loads one `index.html`; JavaScript shows/hides page `<div>`s. Netlify Functions (Node, CommonJS) handle the dynamic parts. Deploys build from git `main` — **a push is the deploy**.

```
Resident browser ──▶ index.html (all pages inline) + style.css + script.js
                         │  fetch()
                         ▼
                 Netlify Functions (netlify/functions/*.js)
                         │  Sheets API (service account)
                         ▼
                 Google Sheet (tabs: Announcements, Minutes, ARC_Requests,
                 Violations, Resident_Requests, Settings, Activity_Log, …)
```

### Framework
**None.** Vanilla HTML/CSS/JS. Only npm dependency is `@anthropic-ai/sdk` (chat function). *(Verified: `package.json`.)*

### Folder structure (flat root)
- `index.html` — the entire public website, every page inline (~137 KB).
- `style.css` — all styles, tokenized in `:root` (~60 KB).
- `script.js` — all public-site behavior (~26 KB).
- `board.html` (~167 KB) — the Board Portal; `board-login.html` — the login gate.
- `netlify/functions/` — `board-api.js`, `submit-request.js`, `scan-inbox.js`, `email-digest.js`, `chat.js`, `health-check.js`.
- Assets: `entrance.jpg`, `pond.jpg`, `logo.png`, PDFs.

### Routing
**Client-side show/hide, no real routes.** `go(pageName)` (`script.js:5`) toggles `.active` on `#page-<name>`. Every nav link is `href="#" onclick="go('…')"`. No bookmarkable URLs, no deep links. *(Verified: `script.js:5–25`, `index.html:416–457`.)* Hash routing is **deferred** — Phase 1A–1E must not depend on shareable URLs.

### Styling approach
**Token-first.** All color/type/spacing/radius/shadow live in `:root` (`style.css:1`). Project law: change the token, never inline a hex or pixel value.

### How the Board Portal works
`board-login.html` → `board.html`. Login posts to `board-api.js`; credentials checked against a **hardcoded `BOARD_MEMBERS` map** (`board-api.js:48–55`); a base64 session token (8-hour expiry) is returned. Announcements/minutes are posted through `board-api` actions that **append rows to the Google Sheet**. *(Verified: `board-api.js:144–151, 305–315`.)*

### How announcements are stored
One Sheet tab, **`Announcements`**, six columns: `id, date_posted, title, body, status, posted_by` (A–F). *(Verified: `board-api.js:105, 310`.)* `status` = `published | unpublished | deleted`. No category/date/priority today — this is what Phase 1A extends.

### How announcements are rendered
**Dynamically, at page load, client-side.** On `DOMContentLoaded`, `script.js` fetches `getPublicAnnouncements` (published, newest-first) and renders the **top banner** (top 3, expandable — `loadBanner`, `script.js:379`) and the **Announcements page** (all cards — `loadAnnouncements`, `script.js:341`). Bodies run through `formatAnnouncementBody` (`script.js:321`). *(Verified.)*

### Does publishing trigger a Netlify deploy?
**No.** Publishing appends a Sheet row; the site reads it at runtime. No git push, no build, no deploy, no credit spend. **This must be preserved exactly.** *(Verified: `board-api.js:305–315` write; `script.js:341` runtime read.)*

### Static or dynamic?
- **Dynamic** (Sheet-backed): announcements, minutes, the Financials flag, portal data, chat.
- **Static** (hardcoded in `index.html`): hero, quick actions, stats, all evergreen reminder/policy notice-cards on the Updates page, FAQ, Vendors, Local Contacts, hardcoded Community Meetings entries.

### How pages are generated
Not generated — **every page is hand-authored inline in `index.html`**, toggled by `go()`. Page ids: `home, board, updates, minutes, documents, vendors, faq, newsletters, localcontacts, financials, contact`. *(Verified.)*

### Components to reuse
| Component | Where | Reuse for |
|---|---|---|
| `.notice-card` (+ `notice-gold`/`notice-info`/`notice-warning`) & `.notices-grid` | `index.html:699–780` | Every announcement/update card |
| `.notice-badge`, `.notice-detail`/`.notice-detail-row`/`.nd-label` | `index.html:702, 721–725` | Category badges, structured rows |
| `.announcement-bar`/`.announcement-item`/`.ann-dropdown` (expandable, touch+keyboard) | `script.js:379–411` | Critical alert bar |
| `.updates-toc` side-nav + `uJump()` | `index.html:684–696`, `script.js:28` | Filter/section navigation |
| `.minutes-month` accordion + `.mm-callout` | `script.js:430–465` | Monthly archive grouping |
| `.doc-section`/`.doc-grid`/`.doc-card`, doc modal `openDoc()` | Documents/Local Contacts, `script.js:66` | Static page building |
| `.card`, `.stats-bar`, `.quick-actions`/`.qa-item`, buttons (`btn-gold`/`btn-ghost`/`doc-btn`) | homepage | At-a-glance cards, CTAs |
| Formatters `formatAnnouncementBody`, `formatMinutesSummary`, `formatAnnouncementDate`, `monthKeyFromDate` | `script.js:286–421` | All new rendering + monthly grouping |
| **Settings feature-flag pattern** (`getPublicSettings` ↔ `financials_published`) | `board-api.js:186`, `script.js:498` | Ship new sections dark, flip on |
| **Self-healing header pattern** (`Minutes!H1` written on the fly) | `board-api.js:360` | Add announcement columns, zero manual setup |

### Technical debt / do NOT expand
1. **Hardcoded plaintext passwords** (`board-api.js:48–55`), committed. Fine for a 6-member portal; **do not gate resident-private data behind this** — that's exactly why real resident auth is a separate, later phase.
2. `board.html` (167 KB) and `index.html` (137 KB) are large single files. Favor **data-driven rendering** over hand-authoring many pages.
3. **No routing / deep links** — deferred.
4. **Duplicate `getPublicAnnouncements` fetch** (`loadBanner` + `loadAnnouncements`). Consolidate as views grow; don't multiply it.
5. **Service account can't upload to Drive** — attachments deferred.
6. **Gmail token expires periodically** — don't add silent email dependencies.

---

# STEP 2 — The current website, four perspectives

- **Residents:** clean and trustworthy, fast, easy contact/ARC intake. But answering "what's happening this week / is the pond being treated / latest update" means reading a long stack where time-sensitive news and permanent rules look identical, with no filtering and no at-a-glance.
- **Board:** one place to post, instant publish, no deploy, minutes draft→publish. But an announcement is only title+body — no topic tag, lifecycle, alert flag, so everything reads as one flat stream.
- **Designer:** rigorous tokens and reusable primitives, but three giant files, a muddy static/dynamic boundary on the Updates page, and card markup re-implemented in each place instead of one shared render.
- **Maintainability:** no framework/build = little to patch; Sheet-as-DB is legible; feature flags allow dark launches. Growth gets messy only if we hand-author pages or inline ever-more HTML — so **derive views from one dataset** instead.

---

# STEP 3 — Approved announcement schema (simplified)

**The load-bearing decision is the announcement data shape.** Approved recommendation: **extend the existing `Announcements` sheet** with the minimum organizational fields, all **optional with sensible defaults** so the board is never forced to fill unnecessary fields. All backwards-compatible and self-healing (the proven `meeting_type` pattern).

### Schema: extend `Announcements` A–F → A–N (14 columns)
| Col | Field | Required? | Default | Values / notes |
|---|---|---|---|---|
| A | `id` | (system) | — | *unchanged* |
| B | `date_posted` | (system) | now | *unchanged* — publish date |
| C | `title` | **yes** | — | *unchanged* |
| D | `body` | **yes** | — | *unchanged* — full content |
| E | `status` | (system) | published | *unchanged* — `published/unpublished/deleted` |
| F | `posted_by` | (system) | session name | *unchanged* |
| G | `category` | no | `General` | Board & Meetings · Ponds · Landscaping · Irrigation · Traffic · Safety · Community Events · Maintenance · Documents · General |
| H | `priority` | no | `normal` | `normal / high / critical` (drives the alert bar) |
| I | `event_date` | no | *(blank)* | optional — when the thing happens (powers Upcoming Work) |
| J | `work_status` | no | `none` | `none / upcoming / in-progress / completed` |
| K | `summary` | no | *(blank → truncate body)* | short one-liner for cards/homepage |
| L | `featured` | no | `no` | `yes / no` — highlights a card in Latest Updates |
| M | `archive_date` | no | *(blank)* | optional — auto-drops from active views after this date |
| N | `related_project` | no (optional) | *(blank)* | free-text tag, **stored now, unused until the deferred Projects work** |

**Board effort:** only Title + Body are required, exactly as today. Category defaults to General; everything else is a quick optional dropdown/field. Posting a plain announcement stays a two-field action.

**Backwards compatibility (expected):** existing 6-column rows read back as `category=General, priority=normal, work_status=none, featured=no`, no archive, no project — so today's announcements render unchanged, mirroring how untagged minutes default to `board` (`board-api.js:176`).

### Derived views (all client-side filters over one dataset — no manual page edits)
| View | Where | Filter rule |
|---|---|---|
| Latest Updates | homepage + Updates page | published, newest `date_posted` first (featured highlighted) |
| Upcoming Work | homepage | `work_status=upcoming` OR `event_date` in future → sort `event_date` asc |
| Critical Alert | homepage (conditional) | `priority=critical` AND not archived → renders only when present |
| By category | Updates page | `category` filter chips |
| Monthly archive | Updates page | group non-current published items by month (reuse `monthKeyFromDate` + `.minutes-month` accordion) |

---

# Revised implementation roadmap — Phases 1A–1E

Each phase is independently shippable and revertable. **Global rollback:** every change is additive — new sheet columns are backwards-compatible, and new UI ships **behind a Settings feature flag**, so rollback = flip the flag off and/or `git revert`. No data migration ever. **Deploy discipline:** batch and deploy only on the owner's say-so (limited Netlify credits). Suggested batches: 1A+1B together, then 1C, then 1D, with 1E verification gating each.

---

## Phase 1A — Announcement data & Board Portal fields

- **Purpose:** Extend `Announcements` to 14 columns (G–N); carry the new fields through `addAnnouncement` / `updateAnnouncement` / `getPublicAnnouncements`; self-heal headers; add the matching optional inputs to the portal post form.
- **Files to change:**
  - `netlify/functions/board-api.js` — `ensureSheetTabs` header (`:105`), `addAnnouncement` (`:305`, append range `A:F`→`A:N` + self-heal `G1:N1`), `updateAnnouncement` (`:317`, allow new columns), `getPublicAnnouncements` (`:154`, map new fields into the response).
  - `board.html` — add optional Category / Priority / Event date / Work status / Short summary / Featured / Archive date / Related project inputs to the existing "Post Announcement" form; carry them in the `addAnnouncement`/`updateAnnouncement` payload; render them in the portal's announcement edit view.
- **Components:** none new (data + form only); reuse existing portal form controls.
- **Complexity:** Medium.
- **Regression risk:** **Medium.** Two specific risks: (1) the append/update **range must change `A:F`→`A:N`** everywhere it's written, or fields land in the wrong columns; (2) `board.html` is 167 KB — the new inputs must match existing form markup and not disturb the minutes/ARC/request flows.
- **Testing required:**
  - `node -c netlify/functions/board-api.js` clean.
  - Post a **plain** announcement (Title+Body only) → verify it saves and reads back with correct defaults (General/normal/none/no).
  - Post a **fully-tagged** announcement → verify every field round-trips through `getPublicAnnouncements`.
  - Edit an existing (pre-Phase-1A) announcement → verify old rows still render and gain defaults without corruption.
  - Confirm the public site still renders today's announcements unchanged (no visual change expected in 1A — it's data plumbing).
  - Confirm Minutes / ARC / Resident Requests tabs are untouched.
  - *Live verification requires a deploy (owner-gated); until then, verification is `node -c` + a line-by-line diff against the existing add/update/get patterns.*
- **Rollback:** `git revert` the commit. New columns are harmless to old code, so no sheet cleanup needed.

## Phase 1B — Public Updates page organization

- **Purpose:** One reusable `renderAnnouncementCard()`; category filter chips; monthly archive of older items; and a clean split between **dynamic announcements** and permanent **Community Reminders & Policies**.
- **Files to change:** `index.html` (Updates page `#page-updates`, ~`:676`), `script.js` (`loadAnnouncements` `:341`, add render fn + filtering + archive grouping), `style.css` (filter-chip + section styles, token-based).
- **Components:** new `renderAnnouncementCard(a)` (also adopted by banner + homepage), `filterChipBar`; reuse `.notice-card`, `.updates-toc`, `.minutes-month` accordion for the archive.
- **Complexity:** Medium.
- **Regression risk:** **Medium** — the shared render fn also feeds the banner; grep all call sites. The evergreen policy cards must be **relocated into a clearly labeled section, not deleted** (leash, parking, snow, trash, maintenance schedule, etc. at `index.html:701–780`).
- **Testing required:** desktop + 375 px mobile; every category chip incl. empty states; archive grouping correct by month; banner still works; permanent reminders all present and clearly separated; console clean.
- **Rollback:** flag-gate the new filter/archive UI; `git revert`.

## Phase 1C — Homepage discovery sections

- **Purpose:** Add **Latest Updates**, **Upcoming Work**, and a **conditional Critical Alert** to the homepage — behind a `homepage_discovery` Settings flag so it ships dark.
- **Files to change:** `index.html` (homepage `#page-home`, insert after the existing announcement bar ~`:462`), `script.js` (new loaders reusing the shared fetch + `renderAnnouncementCard`), `style.css` (at-a-glance card + red critical-alert token variant).
- **Components:** reuse `.announcement-bar` (red variant) for the alert, `.card`/`.notice-card` for Latest/Upcoming; new `atAGlanceCard` helper.
- **Complexity:** Medium.
- **Regression risk:** **Medium** (homepage layout) — spot-check hero, quick-actions, gold strip, stats after. Critical alert must render **only** when a `priority=critical` item exists; sections collapse gracefully when empty.
- **Testing required:** with/without a critical announcement; with/without upcoming items; desktop + mobile; flag OFF must reproduce today's homepage exactly; console clean.
- **Rollback:** flip `homepage_discovery` off (instant, no deploy); `git revert`.

## Phase 1D — Resident Portal "Under Construction" page

- **Purpose:** Add a **Resident Portal** nav item and a **static informational** page. **No login, no forms, no auth, no protected data** — just a friendly "coming soon" explaining what it will offer.
- **Files to change:** `index.html` (nav — add `id="nav-residentportal"` in an appropriate group ~`:434–441`; add `id="page-residentportal"` static page built from `.doc-section`/`.card`), `style.css` only if a new token is genuinely needed.
- **Components:** reuse `.card`/`.doc-section`, buttons, existing page pattern. Copy an existing static page (e.g. Local Contacts) as the skeleton so header/footer/nav wiring matches.
- **Complexity:** Low.
- **Regression risk:** **Low** — additive page + one nav link; verify `go('residentportal')` activates the page and highlights the nav item (must follow the `page-<name>`/`nav-<name>` id convention `go()` depends on, `script.js:10–11`).
- **Testing required:** nav link works desktop + mobile dropdown; page renders; no console errors; no other page affected. **Confirm there is no input, password field, or data fetch on the page.**
- **Rollback:** `git revert` (fully additive).

## Phase 1E — Mobile, accessibility & regression testing

- **Purpose:** Make the new surfaces usable and accessible on phones, and run the full regression sweep before any deploy.
- **Files to change:** `style.css` (touch targets, chip scroll/wrap), `index.html`/`script.js` (aria attributes on new interactive elements) as needed — no new features.
- **Requirements:**
  - Filter chips: horizontally scrollable or wrapping, **≥44 px touch targets**, active state in navy token.
  - New collapsibles use `aria-expanded` (pattern at `script.js:396`); chips are semantic `<button>`s.
  - Real contrast — **never gold-on-cream for meaningful text** (~2:1, decorative only); visible focus states; alt text on any image.
  - Consolidate the duplicate `getPublicAnnouncements` fetch into one shared call feeding banner + homepage + Updates page.
- **Complexity:** Low–Medium.
- **Regression risk:** Low.
- **Testing required (full sweep, every deploy):** desktop **and** 375 px; nav works both widths incl. the new Resident Portal item; every filter/chip/collapsible; both banner and homepage discovery; forms (contact/ARC) still validate/submit; zero console errors; spot-check pages you didn't touch (FAQ, Vendors, Minutes, Documents) that share the stylesheet.
- **Rollback:** per-phase reverts above; flags off.

---

# Recommendations (scoped to Phases 1A–1E)

- **Refactor (small, high-leverage):** one shared `renderAnnouncementCard()`; consolidate the duplicate announcements fetch; clarify the Updates page split (dynamic news vs permanent reminders/policies).
- **Keep exactly as-is:** the Sheet-append no-deploy publish model (the core asset); the token system; Minutes, doc-viewer, submit-request, chat, nav; the Settings-flag and self-healing-header patterns.
- **Reuse:** `.notice-card` family · `.announcement-bar` · `.updates-toc`/`uJump` · `.minutes-month` accordion · `.doc-card`/`openDoc` · `.card`/`.stats-bar` · all formatters · Settings-flag + self-heal patterns.
- **New reusable components:** `renderAnnouncementCard(a)`, `filterChipBar`, `atAGlanceCard`, `criticalAlertBar` (red variant) — all assembled from existing tokens.
- **Do NOT (this phase):** add auth/login/passwords, a Projects sheet, project admin, search, hash routing, resident directory, private docs, dashboards, any framework/database/dependency, or any redesign.

---

# APPENDIX — Phase 1A implementation prompt (for Sonnet)

> Paste the block below into a fresh Sonnet session on the `website-phase-2` branch. It implements **Phase 1A only**.

```
You are implementing Phase 1A of the Twin Lakes HOA website Phase 2 plan
(docs/website-phase2-masterplan.md). Implement ONLY Phase 1A. Do not start 1B–1E.
Read CLAUDE.md and HANDOVER.md first — house style is project law.

GOAL (Phase 1A = data plumbing + portal form; no visible change to the public site):
Extend the announcement schema and Board Portal so board members can OPTIONALLY tag
announcements for organization, without breaking the existing no-deploy publishing
workflow and without requiring any new fields on a plain post.

PRESERVE ABSOLUTELY:
- The no-deploy publishing workflow: posting an announcement appends a Google Sheet row
  read at runtime. Do not change that model.
- Backwards compatibility: existing 6-column announcements must keep rendering unchanged
  and must read back with safe defaults.
- Only Title and Body remain required. All new fields are OPTIONAL with defaults.

SCHEMA — extend the `Announcements` sheet from A–F to A–N (14 columns):
  A id · B date_posted · C title · D body · E status · F posted_by   (all unchanged)
  G category       default "General"
     (Board & Meetings, Ponds, Landscaping, Irrigation, Traffic, Safety,
      Community Events, Maintenance, Documents, General)
  H priority       default "normal"   (normal | high | critical)
  I event_date     optional, blank    (YYYY-MM-DD)
  J work_status    default "none"     (none | upcoming | in-progress | completed)
  K summary        optional, blank
  L featured       default "no"       (yes | no)
  M archive_date   optional, blank    (YYYY-MM-DD)
  N related_project optional, blank   (free-text tag; stored only, not used yet)

FILES TO CHANGE:
1) netlify/functions/board-api.js
   - ensureSheetTabs (~:105): update the Announcements header array to the 14 columns above.
   - addAnnouncement (~:305): change the append range A:F -> A:N; write the new fields with
     the defaults above; keep Title/Body required. BEFORE the append, self-heal the header
     exactly like the meeting_type pattern at ~:360 — write Announcements!G1:N1 =
     ["category","priority","event_date","work_status","summary","featured",
      "archive_date","related_project"] so getSheetData (which maps by header name) reads
     the columns back on legacy sheets.
   - updateAnnouncement (~:317): allow editing the new columns (map each provided field to
     its column G–N), following the existing typeof-string guard pattern.
   - getPublicAnnouncements (~:154): include the new fields in the mapped response object
     (category, priority, event_date, work_status, summary, featured, archive_date,
     related_project) while still filtering status === "published" and sorting newest-first.
2) board.html
   - Add OPTIONAL inputs (Category select, Priority select, Event date, Work status select,
     Short summary, Featured checkbox, Archive date, Related project text) to the existing
     "Post Announcement" form. Match the existing form markup/classes exactly — this file is
     ~167 KB, so read the current announcement form and edit form first and copy their
     patterns. Carry the new fields in the addAnnouncement / updateAnnouncement request
     payloads, and show them in the announcement edit view.

DO NOT: touch Minutes / ARC / Violations / Resident Requests / chat / auth; add any
dependency; add any login/resident-portal code; change the public site's rendering
(that is Phase 1B); inline any raw hex or pixel value (use :root tokens).

VERIFY:
- `node -c netlify/functions/board-api.js` is clean.
- Diff your board-api changes line-by-line against the existing add/update/get patterns and
  confirm every write range is A:N (not A:F) and columns line up G–N.
- Confirm a plain Title+Body post still works (defaults applied) and a fully-tagged post
  round-trips through getPublicAnnouncements.
- Note honestly: live end-to-end verification needs a Netlify deploy (owner-gated, batched
  for credits). State clearly what you verified statically vs what needs the owner's deploy
  to confirm against the live sheet. Do NOT claim it "works" end-to-end without a deploy.

Report: what changed, what you verified, and the one line for the owner to test after the
next deploy. Then stop — do not proceed to Phase 1B.
```
