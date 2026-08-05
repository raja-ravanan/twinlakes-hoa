# Twin Lakes HOA — Design Uplift Brief for Fable

Hand this to Fable in Claude Code. **Paste "Part 1" first** so Fable has full context, then give it one task prompt at a time from Part 2 / Part 3. Work on one page or component per prompt, review, then move on.

---

## PART 1 — Context (paste this first, once)

> You are redesigning the front-end of an existing Homeowners Association website. Keep the tech stack exactly as-is — **static HTML + CSS + vanilla JS, no framework, no build step.** Do not introduce React, Tailwind, npm packages, or a bundler.
>
> **Files:**
> - `index.html` — public site, a single-page app. Navigation swaps `.page` divs via a `go('pageName')` function (in `script.js`). Pages: home, board, vendors, faq, updates (Announcements), minutes, newsletters, financials, contact. **Do not break the `go()` / `id="page-…"` / `id="nav-…"` structure.**
> - `style.css` — shared styles for the public site (design tokens live in `:root`).
> - `script.js` — nav logic, chat widget, dynamic content loaders.
> - `board.html` — private board portal (separate page, mostly inline styles). Uses a `switchTab('key')` function whose active-highlight logic depends on the DOM order of `.tab` buttons — **preserve their order and keys.**
> - `chat.js` — AI chat widget calling `/.netlify/functions/chat` (renders markdown via marked.js).
>
> **Brand tokens (keep these unless proposing an intentional evolution — if you evolve them, update the `:root` variables so everything cascades):**
> ```
> --navy:#1B4B7A  --navy-dark:#0f2d4a  --navy-light:#EEF3F8
> --gold:#C9A84C  --gold-dark:#8B6914  --gold-light:#F5EDD6  --gold-border:#dfc07a
> --cream:#FAF7F2  --cream-dark:#F0EBE1  --cream-border:#DDD5C4
> --text:#12202e (dark)  plus --text-s / --text-m for secondary
> ```
> **Type:** headings use Georgia serif; a `Great Vibes` cursive script is used for the "Twin Lakes" wordmark; body is system sans-serif. Logo is `logo.png`.
> **Aesthetic goal:** upscale, calm, "lakeside community" — trustworthy and warm, not corporate or generic. Think boutique HOA, gracious living, navy + gold + cream.
>
> **Hard requirements for every change:**
> - **Mobile-first and fully responsive** (test ~375px, ~768px, ~1280px). The nav collapses to a hamburger below 960px; the board portal sidebar collapses below 860px.
> - Preserve all element `id`s and JS hooks (`onclick`, `go()`, `switchTab()`, chat IDs, form field ids).
> - Accessible: sufficient contrast, focus states, tap targets ≥44px, `alt` text, reduced-motion support.
> - Give me **drop-in replacements** (full file or clearly-marked CSS blocks) I can paste in, and note exactly where.

---

## PART 2 — Design tasks (one prompt each)

### 0. Foundation first (do this before page work)
> Audit `style.css` and propose a refreshed **design system**: a cohesive type scale (sizes/line-heights/weights), spacing scale, refined color usage (keep navy/gold/cream but modernize tints, shadows, borders, radii), button styles, and card styles. Deliver it as an updated `:root` + base-component CSS block that I can drop into `style.css`, keeping all existing class names working. Show me a before/after of 2–3 key components.

### 1. Homepage hero + landing
> Redesign the homepage (`#page-home` in `index.html`) — hero, intro, feature highlights, stats, and the CTA band — into a more elegant, modern lakeside-community landing page. Improve visual hierarchy, whitespace, and imagery treatment. Keep the same content and the `go()` links. Provide updated HTML for `#page-home` and the matching CSS. Make it beautiful on mobile first.

### 2. Navigation (desktop + mobile)
> Redesign the top navigation and mobile hamburger menu for a more premium feel — refined spacing, hover/active states, dropdown styling, and a polished slide-in mobile menu with smooth transitions. Keep the exact link structure, `id`s, `onclick="go(...)"`, `toggleMenu()`, and `toggleNavGroup()` hooks, and the 960px breakpoint behavior. Deliver CSS (and minimal HTML tweaks if needed).

### 3. Content pages & cards
> Restyle the shared content components used across Announcements, FAQ, Vendors, Minutes, Newsletters, and Contact — page headers, `.notice-card` variants, tables, `.faq-*`, `.vendor-*`, and the contact flow diagram. Create a consistent, elegant card/section system. Deliver updated CSS. Keep all class names and structure.

### 4. Financials page polish
> Elevate the resident Financials page (`#page-financials`) — the health banner, stat cards, the spending donut, and the dues cards — into a more polished, infographic-style layout while keeping it high-level and reassuring. Improve the donut visual and legend. Keep the `fin-*` class names and content. Deliver updated CSS (and HTML tweaks if helpful).

### 5. Mobile overhaul pass
> Do a dedicated mobile-responsiveness pass across the whole public site at 375px and 768px. Fix any cramped spacing, overflow, tiny tap targets, or awkward stacking. Improve the mobile hero, cards, tables (make wide tables scroll or reflow), and the chat widget size on small screens. Deliver the responsive CSS additions/overrides.

### 6. Board portal visual uplift
> Restyle the board portal (`board.html`) — the top bar, the left sidebar menu, stat cards, tables (ARC/violations/residents), the resource/document cards, and the community map panel — into a cleaner, more modern admin UI. It has mostly inline styles and a `<style>` block; consolidate into a tidy style block. **Critical: do not change the `.tab` button order/keys or the `switchTab` logic, the `data-admin` attributes, or any element `id`s.** Deliver the updated `<style>` block and any safe markup tweaks.

### 7. Community map upgrade
> Redesign the board portal's Community Map (currently colored squares grouped by street, generated in JS by `renderMap()`) into a more attractive illustrated schematic — nicer home markers/house icons, subtle streets, lake shapes, a cleaner legend and detail panel. It's generated in JS from `residentsData`; give me the updated `renderMap()` + `showHome()` + CSS. Keep the click behavior and the fields shown (lot, series, sprinkler zone, committee volunteer, offender flag).

---

## PART 3 — Chatbot uplift

### 8. Chat widget redesign (visual)
> Redesign the chat widget in `index.html` (`#chat-widget`, `#chat-toggle`, `#chat-box`, `#chat-header`, `#chat-avatar`, `#chat-messages`, `#chat-input-area`) and its CSS. Make the launcher button, open/close animation, header, message bubbles (user vs assistant), typing indicator, and input area feel modern and on-brand (navy/gold/cream). Ensure it's comfortable on mobile (sensible width/height, doesn't cover the whole screen). Keep all `id`s and the JS hooks in `script.js`/`chat.js` intact. Deliver updated HTML for the widget + CSS.

### 9. Chatbot persona & conversation UX
> Improve the assistant's personality and conversation experience. (a) Suggest a warm, helpful "Twin Lakes Assistant" persona and rewrite the system prompt in `netlify/functions/chat.js` to match — friendly neighbor tone, concise, points residents to the right page/contact, never invents HOA rules. (b) Add nice UX touches to the chat UI: a friendly greeting message, 3–4 suggested starter questions as tappable chips, and graceful error/empty states. Show me the updated `chat.js` system prompt and the front-end changes.

---

## Tips for working with Fable
- **Give it the current file(s)** it's editing (paste `style.css`, or the relevant HTML section) so it edits the real thing rather than guessing.
- **One task per message.** Review the result, deploy/preview, then continue. Small diffs are easier to check and revert.
- Ask for **both desktop and mobile** in the same request, and ask it to describe the mobile behavior.
- If it proposes new brand tokens, have it **update `:root`** so the whole site cascades — don't hardcode colors.
- After each change, I (your build assistant) can verify it in the live preview, check responsiveness, and deploy.
