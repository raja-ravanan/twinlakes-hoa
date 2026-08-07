# Announcement Schema — Source of Truth

> Covers the `Announcements` Google Sheet tab and the Netlify Function (`netlify/functions/board-api.js`) actions that read and write it. This is the reference for any future phase that touches announcement data — update it whenever the schema changes.

## Purpose

Announcements are how the board publishes time-sensitive community information (pool hours, pond treatments, traffic alerts, meeting notices) directly to the public website, without a code change or a Netlify deploy. Phase 1A added optional organization metadata (category, priority, dates, work status, featured, archive) on top of the original title/body/status model, so future phases can build filtered views (by category, "upcoming work," "critical alerts," a homepage highlight) without asking the board to do anything differently than before.

## Announcement lifecycle

```
Board posts (Title + Body required, everything else optional)
        │
        ▼
  status = "published"  ──────────────►  Public website (getPublicAnnouncements)
        │                                  · homepage banner (newest 1 with
        │                                    show_on_banner = "yes")
        │                                  · Updates page (all published)
        │
        ├── Board clicks "Hide from website" → status = "unpublished"
        │     (row stays intact, disappears from the public site, still visible
        │      and editable in the portal)
        │
        ├── Board clicks "Publish" again → status = "published"
        │     (reappears on the public site)
        │
        └── Board clicks "Delete" → status = "deleted", row content blanked (A–D, F)
              (disappears everywhere, id/status remain for audit; the deletion
               itself is recorded in Activity_Log)
```

There is no separate "draft" state for announcements (unlike Meeting Minutes, which do have a draft→publish review flow). An announcement is either published, unpublished (hidden), or deleted.

## Schema: `Announcements` sheet, columns A–O

| Col | Field | Type | Introduced |
|---|---|---|---|
| A | `id` | string, `ANN-<timestamp36>` | original |
| B | `date_posted` | ISO 8601 timestamp | original |
| C | `title` | string | original |
| D | `body` | string (full text; markdown-lite links supported on the public site) | original |
| E | `status` | `published` \| `unpublished` \| `deleted` | original |
| F | `posted_by` | string (board member's display name) | original |
| G | `category` | enum, see below | Phase 1A |
| H | `priority` | enum, see below | Phase 1A |
| I | `event_date` | `YYYY-MM-DD` or empty | Phase 1A |
| J | `work_status` | enum, see below | Phase 1A |
| K | `summary` | string (short, free text) | Phase 1A |
| L | `featured` | `yes` \| `no` | Phase 1A |
| M | `archive_date` | `YYYY-MM-DD` or empty | Phase 1A |
| N | `related_project` | string (free text; stored only, not consumed yet) | Phase 1A |
| O | `show_on_banner` | `yes` \| `no` — **defaults to `yes`** | Banner phase |

**Only Title (C) and Body (D) are required.** Every column G–O is optional and safely defaulted if omitted — posting a plain announcement is unchanged from before Phase 1A.

## Allowed values

**Category (G)** — fixed list, defaults to `General`:
`General`, `Board & Meetings`, `Ponds`, `Landscaping`, `Irrigation`, `Traffic`, `Safety`, `Community Events`, `Maintenance`, `Documents`

**Priority (H)** — fixed list, defaults to `normal`:
`normal`, `high`, `critical`

**Work status (J)** — fixed list, defaults to `none`:
`none`, `upcoming`, `in-progress`, `completed`

**Featured (L)** — fixed list, defaults to `no`:
`yes`, `no`

**Show on banner (O)** — fixed list, **defaults to `yes`**:
`yes`, `no`

This is the one field in the sheet that defaults to the *permissive* value, and
deliberately: legacy A–N rows carry nothing in column O, and an announcement
that silently dropped off the banner the moment this shipped would be a
regression. Only an explicit `no` takes a post off the banner — and it stays
published on the Updates page either way. Hiding from the banner is **not**
unpublishing; `status` remains the only lever that removes an announcement
from the public site.

**Event date (I) / Archive date (M)** — `YYYY-MM-DD` or empty. Anything that doesn't match that exact format is dropped to empty rather than stored malformed.

**Summary (K) / Related project (N)** — free text, trimmed. No enum constraint; not currently rendered anywhere (see Developer notes).

The Board Portal only ever *offers* these values (fixed `<select>` dropdowns + a checkbox — no free-text entry for category/priority/work-status/featured). The backend does **not** trust that, however — every value is independently re-validated and defaulted server-side (`normalizeAnnCategory`, `normalizeAnnPriority`, `normalizeAnnWorkStatus`, `normalizeAnnFeatured`, `normalizeAnnDate`, `normalizeAnnShowOnBanner` in `board-api.js`), so a malformed or spoofed API call can't write an invalid value into the sheet.

## Defaults (applied server-side, always)

| Field | Default | Applied when |
|---|---|---|
| `category` | `General` | value missing, blank, or not in the fixed list |
| `priority` | `normal` | value missing, blank, or not in the fixed list |
| `event_date` | `""` (empty) | value missing or not `YYYY-MM-DD` |
| `work_status` | `none` | value missing, blank, or not in the fixed list |
| `summary` | `""` (empty) | value missing |
| `featured` | `no` | value missing or anything other than `true`/`"yes"`/`"true"` |
| `archive_date` | `""` (empty) | value missing or not `YYYY-MM-DD` |
| `related_project` | `""` (empty) | value missing |
| `show_on_banner` | `yes` | value missing, blank, or anything other than `false`/`"no"`/`"false"` |

These defaults are applied in **three** places, deliberately redundant: at write time (`addAnnouncement`, `updateAnnouncement`), and at read time (`getPublicAnnouncements`, `getDashboard`). Read-time normalization exists specifically so legacy rows — and any row from before the self-healing header existed — always come back safe, even if the write path is ever bypassed or the sheet is edited by hand.

## Backward compatibility

Announcements created before Phase 1A have only columns A–F. They are **not migrated** — there is no batch script and none is needed:

- `getSheetData` maps a sheet row to an object by the **header row's column names**. A pre-Phase-1A row simply has no G–N values, which the mapper already treats as `""` for any column beyond the row's actual length.
- Every read path (`getPublicAnnouncements`, `getDashboard`) then runs those blank/undefined values through the `normalizeAnn*()` functions, which is exactly what maps them to `category: "General"`, `priority: "normal"`, `work_status: "none"`, `featured: "no"`, and empty strings for the rest.
- **A legacy announcement can never appear critical, featured, upcoming, in-progress, completed, or archived by accident** — those all require an explicit, validated non-default value. `show_on_banner` is the deliberate exception: it defaults to `yes`, so legacy rows stay eligible for the banner exactly as they were before column O existed.
- Editing a legacy announcement only ever writes the specific columns the edit touched (see "Column-level writes" below) — it never rewrites columns it didn't receive, so A/B/F are never at risk and C/D/E/G–N are each independent.

### Self-healing header (columns G1:O1)

`ensureSheetTabs` only writes the full 14-column header when the `Announcements` tab is created from scratch (a brand-new spreadsheet) — it does **not** retrofit an existing tab's header row. For a sheet that already existed before Phase 1A (i.e., production), the columns G–N become readable the first time **any** announcement is created or edited after this deploy: `addAnnouncement` and `updateAnnouncement` (when an extended field is present) both write `Announcements!G1:O1` unconditionally before touching row data. This mirrors the pre-existing `meeting_type` / `Minutes!H1` self-heal pattern in the same file — same mechanism, same reasoning, applied to a second sheet.

Until that first post-Phase-1A write happens, `getSheetData`'s header-based mapping simply won't find columns named `category`/`priority`/etc., and every field falls through to its default anyway — so there's no window where the site behaves incorrectly, only a window where the header row hasn't been created yet.

### Column-level writes (not full-row rewrites)

`updateAnnouncement` never rewrites the entire A–N row. Each field is an independent `sheetsUpdate` call, gated by `typeof field === "string"` (or presence, for `featured`):

- `title` → C, `body` → D, `status` → E — each only written if explicitly sent.
- `category`…`show_on_banner` → G…O — each only written if explicitly sent, and only after the self-heal header write. The portal's "Remove from banner" / "Show in banner" button relies on this: it sends `show_on_banner` alone, so no other column is touched.
- `id` (A), `date_posted` (B), and `posted_by` (F) are **never in the update path's column list** — structurally impossible to change via `updateAnnouncement`.

`deleteAnnouncement` is the one path that touches the whole row: it blanks A–D and F and sets E to `"deleted"` (15-element array covering A–O, extended from A–N). This is the pre-existing "hard-wipe with an activity-log audit trail" design, unchanged in intent — only the column count grew.

## How future phases will consume each field

| Field | Phase 1B (Updates page) | Phase 1C (Homepage) | Later |
|---|---|---|---|
| `category` | Filter chips | — | — |
| `priority` | Visual emphasis on cards | Drives the conditional Critical Alert (`priority === "critical"`) | — |
| `event_date` | Sort key for "Upcoming Work" | "Upcoming Work" list, sorted ascending | — |
| `work_status` | Grouping (`upcoming` / `in-progress` / `completed`) | Filters what counts as "Upcoming Work" | — |
| `summary` | Shown in compact/card view in place of truncated body | Shown on homepage cards | — |
| `featured` | — | Selects which announcements appear in the homepage "Featured" section | — |
| `show_on_banner` | — | Gates the top banner: `loadBanner()` renders the **single newest** published, non-archived announcement with `show_on_banner !== "no"` | — |
| `archive_date` | Drives the monthly archive (items past this date move out of "current") | — | — |
| `related_project` | — | — | Deferred: will link an announcement to a Project page once a `Projects` sheet exists (not built yet — this column is stored now purely so no data is lost in the meantime) |

## Developer notes

- **Normalization functions live once, in `board-api.js`** (`normalizeAnnCategory`, `normalizeAnnPriority`, `normalizeAnnWorkStatus`, `normalizeAnnFeatured`, `normalizeAnnDate`) and are reused across every read and write path. If the allowed-values lists ever change, update `ANN_CATEGORIES` / `ANN_PRIORITIES` / `ANN_WORK_STATUSES` in one place — the Board Portal's `<select>` options in `board.html` must be kept in sync by hand (there is no shared config between the two files).
- **`related_project` is free text and is not rendered anywhere yet.** The Board Portal's announcement list displays `category`/`priority`/`featured`/`show_on_banner` as badges. The public site now consumes `category`, `priority`, `event_date`, `work_status`, `summary` and `archive_date` (Phases 1B/1C) and `show_on_banner` (the banner). Whoever first renders `related_project` to the DOM must escape it (the same way `title`/`body` already are via `escapeHtml`/`escapeHtmlText`) — it is a plain trimmed string, not HTML-safe by construction.
- **`featured` is written and badged but still consumed nowhere on the public site.** It was specified for a homepage "Featured" section that was never built — Latest Updates simply takes the 5 newest. Don't mistake it for a live lever; `show_on_banner` is the flag that actually changes what a resident sees.
- **The Board Portal edit modal always sends all 8 extended fields** on save (never a partial set), even though the backend supports partial updates — the partial-update path is what keeps `toggleAnnouncement` (publish/unpublish, which sends only `status`) from touching G–N at all.
- **Date fields are format-validated, not calendar-validated** — `normalizeAnnDate` accepts anything matching `\d{4}-\d{2}-\d{2}$`, including a nonsensical date like `2026-13-45`. The native `<input type="date">` UI prevents this from the Board Portal itself; a direct API call could still send one through. Acceptable for Phase 1A's scope; worth revisiting if this endpoint is ever exposed beyond the portal.
- **`getSheetData(token, "Announcements")` reads `Announcements!A:AV`** (a shared helper used for every sheet tab in this project) — already covers columns G–N with no changes needed there.
