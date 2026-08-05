# Working on the Twin Lakes HOA site

You design and build this website in Claude Code: read the codebase, edit files, **preview
and verify in a browser, then ship**. Your failure mode is not incompetence — it's
*plausibility*: producing work that *looks* correct. Everything here defends against that.
Full craft handover is in **HANDOVER.md** — read it when in doubt.

## The 7 rules (ranked by leverage)
1. **Nothing is true until you've seen it painted.** Render every change — desktop AND ~375px
   mobile — before claiming anything works. Prevents most bugs.
2. **Diagnose before you prescribe.** Write one sentence: "the underlying problem is ___."
   Fix the problem the user *meant*, not the words they typed. ("Make the header smaller"
   usually means "the page feels cramped.")
3. **Change the token, not the component.** All styling cascades from `:root`. Typing a raw
   hex or pixel value is an alarm. No token fits? Add one to `:root`, name it, use it.
4. **You're forging the previous author's handwriting.** Read the existing patterns, ids, and
   hooks BEFORE editing; copy them. New code that looks "yours" is a defect even if it works.
5. **Specifics get sourced or get hedged — never naked.** Reconcile every number, read every
   API before naming it. Tag claims: verified / expected / don't-know. Fluency is the hazard.
6. **Shared code has a blast radius; grep before you edit it.** Before changing anything used
   in >1 place, find every consumer. After, spot-check pages you didn't touch. Never silently
   delete/rename a load-bearing id or class.
7. **Done is a checklist; polish is a suggestion.** Request satisfied → verified both widths →
   regression sweep clean (nav, forms, console) → patterns matched → ship and stop. Ideas
   beyond scope go in one closing line, not the commit. Don't gold-plate.

Also: ask **one sharp question** only when the answer changes architecture/deliverable;
otherwise assume and state it. Accessibility floor: semantic elements, alt text, labels,
visible focus, real contrast (gold-on-cream ~2:1 — decorative only, never for meaningful text).

## House style (match this exactly; it's project law)
Tokens live in `:root` in `style.css` — everything cascades from them.
- **Colors:** `--navy #1B4B7A` (brand: headers, buttons, links) · `--navy-dark #0f2d4a`
  (depth/footers/hover) · `--gold #C9A84C` (accent — *precious*; wordmark, rare CTA, thin
  rules under headings — never everywhere, never meaningful text) · `--cream #FAF7F2` (warm
  page background). Supporting tints also in `:root`; derive new shades as named tokens.
- **Type:** Georgia serif headings (established/traditional) · Great Vibes script for the
  **wordmark only** (never a heading/button) · system-sans body.
- **Scale:** defined spacing / radius / shadow ramp in `:root` — one card radius, subtle
  shadow (lifted on hover). A value outside the scale is a bug even if it looks fine.
- **Components:** one card pattern, one button family (navy primary, outlined secondary, gold
  for the rare emphasized CTA). Assemble new components from these — don't invent beside them.

**To re-theme later** (it's changeable, not sacred — a token operation, not a rewrite): keep
navy as the anchor; swap `--gold` first (sage/lake-teal reads modern), then heading type, then
soften radius/shadows — **one lever per pass, render the whole site between changes.** The
Great Vibes wordmark caps how modern it can feel; changing it is high-impact — ask, don't assume.

**The law, verbatim:** *Never hardcode a color or size a token already covers. Change the
token, not the component. No token? Add one to `:root`. Every inlined `#hex` is a small theft
from the next re-theme.*

## Deploy discipline (this project)
Static HTML/CSS/JS + Netlify functions; deploys build from git `main` (a push IS the deploy).
Owner is non-technical with limited Netlify credits — **prefer bulk deploys; deploy only when
asked.** Preview and verify before every push; verify production after. Project specifics
(the two-association model, gotchas, credentials) are in the saved project memory.
