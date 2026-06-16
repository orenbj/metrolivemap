# App Chrome & Cross-Cutting — UI/UX Design Audit

**Date:** 2026-06-16 · **Status:** report; **C1 + C2 implemented** in this PR, rest report-only ·
**Scope:** everything the three prior audits did **not** cover — the app chrome (search bar,
legend / mobile bottom sheet, connection status, loading splash, toasts, PWA install banner),
the **service-alerts panel modal**, **map controls / layer toggles / follow-vehicle**, and the
**cross-cutting design system** (contrast, type scale, focus, dark mode, error boundary,
responsive/stacking).

Companion docs (do not re-litigate their findings here):
- `station-popup-ux-audit-2026-06-12.md` (station arrivals popup — implemented in #486)
- `tooltip-surfaces-ux-audit-2026-06-12.md` (vehicle / alert-tooltip / bikeshare / micro popups)
- `simplicity-audit-2026-06-14.md` (code-level KISS)

Method matches the prior audits: **Severity (1 cosmetic → 4 missed train / broken flow) ×
Frequency (1 edge case → 3 every session)**, ties broken glanceability > IA > polish. Every
claim cites `file:line`; agent-reported claims were re-verified by hand and **three were
refuted** (see §5). No browser is available in this environment, so layout/responsive claims
that need a real device are tagged **needs live verification** with a repro.

---

## 1. Executive summary

The chrome is in **good shape and visibly more coherent than most map apps**: one CSS-variable
theme system drives light/dark across every surface, the search combobox implements the full
WAI-ARIA pattern, the alerts panel has a real focus trap + roving-tabindex tablist, the legend
bottom-sheet drag physics are solid, and decorative motion is correctly gated by
`prefers-reduced-motion` while essential vehicle motion is not. The findings are concentrated
and mostly small.

**Top items by rider impact:**

1. **C1 — BUG (verified): the search results dropdown does not close on Escape or
   outside-click.** `.hidden` is toggled on `#search-results` but **no CSS rule acts on it**,
   and the two dismiss paths don't clear the list either — so a populated dropdown stays on
   screen over the map. One CSS line fixes it. (Sev 3 × Freq 2, Effort S)
2. **C2 — BUG (verified): the alerts-panel tabpanel `aria-labelledby` is stale.** It's
   hard-wired to the Service tab; switching to Accessibility never updates it, so screen-reader
   users on the Accessibility tab hear the panel labelled "Service alerts." (Sev 2 × Freq 3, S)
3. **A2 — informational text below WCAG AA on white** (`--color-text-muted` #9ca3af ≈ 2.5:1,
   used for the collapsed bus-route scent + disclosure arrow). Real low-vision cost. (Sev 2 × Freq 2, S)

Everything else is polish-grade or a documented trade-off. Total recommended effort for the
code-verifiable fixes (C1, C2, A1–A3, E1, E2): **about a day.** The touch/responsive items
(§3) are real but need a device to confirm before changing geometry.

## 2. Verified findings (code-confirmed, no device needed)

### C1 — Search dropdown never dismisses on Escape / outside-click · **Sev 3 × Freq 2 = 6** · Effort S
`#search-results` is shown/hidden by `searchResults.classList.toggle('hidden', !visible)`
(`js/ui.js:193`), but **there is no `#search-results.hidden` rule and no generic
`.hidden { display:none }`** in `styles/index-style.css` (every `.hidden` rule is ID-scoped to
the legend or alerts panel). The element is `position:absolute` with its own background, border,
and shadow (`css:334–348`). Two of the five dismiss paths — **Escape** (`ui.js:232–234`) and
**outside-click** (`ui.js:305–306`) — call `setResultsVisible(false)` **without** clearing
`innerHTML`. The other three paths (empty input `:254`, result selected `:298`, clear button
`:314`) clear `innerHTML` first, which is the *only* reason the dropdown ever disappears today.
Net effect: type a query, then press Escape or tap the map → the result list stays visible,
floating over the map, until the next keystroke.

**Fix:** add the missing rule — `#search-results.hidden { display: none; }` (one line). This
fixes all paths at once and makes the `.hidden` toggle actually mean something. (Avoid the
alternative of clearing `innerHTML` in every path — it loses the list on Escape, which a rider
may want to re-open.) Pin with a small jsdom test asserting the class hides it.

### C2 — Alerts tabpanel `aria-labelledby` is stale on the Accessibility tab · **Sev 2 × Freq 3 = 6** · Effort S
`#alerts-panel-body` is `role="tabpanel" aria-labelledby="alerts-tab-service"`
(`index.html:180`), hard-wired to the Service tab. `switchAlertsTab()` updates each tab's
`aria-selected`, roving `tabindex`, and the polite live-region — but **never re-points the
tabpanel's `aria-labelledby`** (no `aria-labelledby` write exists anywhere in
`js/alertsPanel.js`). A screen-reader user on the Accessibility tab hears the panel labelled
"Service alerts."

**Fix:** in `switchAlertsTab(tab)`, also
`body.setAttribute('aria-labelledby', tab === 'access' ? 'alerts-tab-access' : 'alerts-tab-service')`.
One line; pin in `alertsPanel.test.js`.

### A1 — z-index variable misnaming invites a future stacking bug · **Sev 1 × Freq 1 = 1** · Effort S · ✅ IMPLEMENTED (renamed `--z-alerts-panel` → `--z-search-dropdown`)
`--z-alerts-panel: 400` (`css:103`) does **not** style the alerts panel — the alerts panel uses
`--z-alerts-ui: 9502` (`css:762`). `--z-alerts-panel` is actually applied to the **search
results dropdown** (`css:346`). (One agent called the variable "dead/unused" — **refuted**, it's
used; the real problem is the misleading name.) A future edit that trusts the name to position
the panel will land it at z-400, behind popups.

**Fix:** rename `--z-alerts-panel` → `--z-search-dropdown` (it sits between `--z-search-panel`
and `--z-legend`, which already reads oddly) and update the single consumer at `css:346`; add a
one-line comment on `--z-alerts-ui` noting it is the panel's real layer. Pure rename, no visual
change.

### A2 — Informational muted text below WCAG AA on white · **Sev 2 × Freq 2 = 4** · Effort S · ✅ IMPLEMENTED (route scent, caret, `.sp-dest-empty` → `--text-muted`)
`--color-text-muted: #9ca3af` (`css:94`) is ≈ **2.5:1 on white** — below the 4.5:1 AA text
floor. It is an intentional *glyph-tint* variable (stale-vehicle dot, placeholders) — that use
is fine — but it is also applied to **actual text**: the collapsed bus-route scent
`.sp-bus-summary-routes` ("18 · 20 · 204 …", `css:1484`), the disclosure arrow `::before`
(`css:1463`), and `.sp-bus-summary` (`css:1418`). The route-number scent is meaningful
information, so it should clear AA. (This lives inside the already-audited station popup, but the
contrast point is new.) Light mode only — in dark mode #9ca3af on dark glass is fine.

**Fix:** point the **text** uses at `--text-muted` (#6b6b6b ≈ 5.3:1, `css:37`); keep
`--color-text-muted` for the dot/glyph tints. Update `route-color-contrast.test.js`'s neighbours
if it grows a token check. (One agent mislabeled this a typo for `--text-muted` — **refuted**,
both variables exist on purpose; the fix is to use the right one for text.)

### A3 — Search input focus ring is faint, especially in dark mode · **Sev 2 × Freq 1 = 2** · Effort S · ✅ IMPLEMENTED (solid `--color-focus-ring` + brighter dark-mode ring)
`#station-search` does `outline: none` (`css:299`) and replaces it with
`box-shadow: 0 0 0 2px rgba(0,114,188,0.35)` on `:focus-visible` (`css:380`) — a **35%-opacity**
blue ring that all but vanishes on the dark glassmorphic input. Every other interactive element
uses the full-opacity `--color-focus-ring`. (Flagged independently by two agents.)

**Fix:** `box-shadow: 0 0 0 2px var(--color-focus-ring)` in light, and a brighter blue
(`rgba(77,169,255,.7)` or a token) under `body.dark-mode`. Effort S.

### E1 — "Loading alerts…" is indistinguishable from "No alerts" · **Sev 2 × Freq 2 = 4** · Effort M
The alerts panel shows "Loading alerts…" before data lands and "No active service/accessibility
alerts" after (`alertsPanel.js:536–541, 547–553`). On a slow connection the rider can't tell
"still fetching" from "checked, nothing wrong" — same plain grey line, no motion, no
`aria-busy`. The Accessibility tab is worse: it can show "Loading…" when its data object simply
hasn't initialized yet.

**Fix:** set `aria-busy="true"` on the body and add a subtle inline spinner (or a distinct
colour/icon) for the loading state only; clear it when the first render with real data runs.
Effort M.

### E2 — "No stations found" reads as a disabled option · **Sev 1 × Freq 2 = 2** · Effort S · ✅ ALREADY DONE (`.search-no-results` is centred + italic + `pointer-events:none`, `css:440`)
The no-match message reuses the same padding/typography as a real result row
(`ui.js:278`, `css:433`), so it looks like a selectable-but-greyed option rather than an empty
state. **Fix:** centre it, add a little vertical padding and a faint background so it reads as a
message, not a row. Effort S.

### Minor (Sev 1 — fix opportunistically)
- **Search outside-click doesn't restore focus to the input** (`ui.js:305–306`); the clear
  button does (`:317`). Keyboard users lose their place. One `searchInput.focus()`.
- **Layer-toggle "on" state is opacity/greyscale-only** — bike/micro buttons signal *off* via
  `opacity:.35; grayscale(.6)` (`css:696`) with `aria-pressed` for AT, but sighted users get no
  positive "on" cue (no fill/check). Consider a subtle active background. (Sev 2 × Freq 2 for
  discoverability — borderline worth more than Sev 1; owner call.)
- **Dashed alert-item separator** (`css:975`) is nearly invisible on dark glass; a solid
  hairline or spacing reads more clearly.
- **Toasts** have no manual dismiss / Escape (`ui.js:511`); acceptable for transient status,
  noted only.

## 3. Touch & responsive — NEEDS LIVE VERIFICATION (no browser in this env)

These are real on paper but I will not change geometry without a device. All cite the
**documented WCAG 2.5.5 exception** at `css:2261` (controls deliberately kept compact for a
dense transit map) — the recommendation is to honour the visual size but expand the *hit area*.

- **R1 — Map control buttons (~29px) below 44px on touch. ✅ IMPLEMENTED (this PR).** Zoom,
  home/locate/dark-mode, Alerts, and the bike/micro layer toggles inherit MapLibre's ~29px. The
  44px touch bump (`css:2247`) covered the panel/legend close buttons but **not** the map
  controls. **Fix shipped:** a transparent `::before` hit-area overlay on `pointer:coarse`
  (`css` coarse-pointer block) widens each button's tap target to ~45px on the **horizontal**
  axis only — the buttons are stacked flush inside each ctrl-group, so vertical bleed would let
  zoom-in steal zoom-out's taps; the horizontal axis is free (groups hug a screen edge). The
  lone Alerts button (`:only-child`) gets a full all-round ~45px target. Icon size unchanged,
  zero layout/blank-space cost. *Vertical (stacked) deficiency is intentionally left as-is — the
  only cure is growing the visible box, which is barred.* **Needs live verification on a 360px
  phone** (confirm no cross-button mis-taps and that the group's border doesn't clip the
  overlay).
- **R2 — Legend filter rows ~28px on mobile (`css:2211`). NOT FIXABLE safely — skipped.** The
  rows live in a 3/4-column grid (`#legend-icons`, `css:499/2203`) with only 3–4px gaps, so
  **both** axes have neighbors — any hit overlay overlaps an adjacent row and causes mis-taps,
  and growing the rows is the legend bloat the 2.5.5 note explicitly reverts. Rows keep their
  keyboard path and the documented exception. (Owner preference 2026-06-16: keep the compact
  icons, no extra blank space.)
- **R3 — Follow-chip label truncation. ✅ IMPLEMENTED (chip).** The follow-chip label can read
  `Paused · {route} — tap to resume` (`followVehicle.js:328`), and it's `nowrap` + ellipsis
  bounded by the search bar's between-columns width, so on a narrow phone the actionable tail is
  cut. **Fix shipped:** `@media (max-width: 400px) { .follow-chip-label { white-space: normal } }`
  — the label wraps to a second line instead of truncating. **The panel/legend "overlap" half of
  R3 was a NON-ISSUE — dropped:** on a phone the alerts panel is `min(380px, 100vw-24px)` ×
  near-full-height (`css:768–774`) at z-9502 over a z-9501 backdrop, so it fully covers the
  legend; the only "bleed" is the deliberately **transparent** backdrop (HTML: "transparent, no
  dimming"), which is intended. No resize-observer needed.
- **R4 — Search bar width on small landscape. ❌ NON-ISSUE (verified) — no change.** The
  `@media (max-width: 768px)` block (`css:321`) already overrides the bar to
  `left/right: 62px; width:auto` for *every* viewport ≤768px wide — and a landscape phone's width
  (e.g. 667px) is ≤768px, so it never reaches the cramped desktop `min(400px, calc(100vw-120px))`
  rule. At widths >768px that rule always resolves to the 400px cap. There is no cramped case to
  fix. (The audit's original repro missed the 768px override.)
- **R5 — Tablet/large-phone landscape notch safe area. ✅ IMPLEMENTED.** `env(safe-area-inset-*)`
  on the top control columns lived only in the `≤768px` query (`css:2246`); a Dynamic Island /
  side notch beside the controls in landscape on a >768px-wide device fell through. **Fix
  shipped:** a `@media (min-width: 769px) and (orientation: landscape)` block re-applies the env
  insets (keeping MapLibre's 10px default; env is 0 without a notch, so it's inert elsewhere).
  **Needs live verification on a notched device in landscape.**

## 4. Cross-surface consistency notes (systemic, low individual severity)

- **Type scale sprawl.** ~14 discrete px sizes (5/7/8/9/10/10.5/11/11.5/12/12.5/13/14/16/18) plus
  em relatives. Most are deliberate density tuning, but 10.5/11.5/12.5 read as legacy. A
  documented ramp (10/12/13/14/16/18) would make future components self-consistent. **Effort L,
  low rider value — do NOT churn now**, adopt for new work.
- **Inline styles in `index.html`** (legend header, total row, toggle hint) sit outside the
  token system; they happen to use `var(--…)` so dark mode still works, but they're the same
  drift the popup audit's F11 flagged for bikeshare/micro. Opportunistic only.

## 5. Refuted agent claims (recorded so they aren't re-raised)

- **"Error-recovery banner breaks in dark mode"** — **false.** `errorBoundary.js:75` renders
  white (#fff) on dark red (#b22222) ≈ 7:1, readable in *any* theme. Inline styles here are the
  **correct** choice: the recovery banner must render even if the stylesheet failed to load.
  Verified-good, not a finding.
- **"`--z-alerts-panel` is dead/unused"** — **false.** Used at `css:346` (search dropdown). Real
  issue is the misleading name → folded into A1.
- **"`--color-text-muted` is a typo for `--text-muted`"** — **false.** Both are intentional
  (`css:94` glyph tint vs `css:37` body-muted). Real issue is using the glyph tint for text →
  folded into A2.

## 6. Verified-good (checked, leave alone)

- **Search combobox a11y** — full WAI-ARIA: `role=combobox`, `aria-expanded`,
  `aria-autocomplete=list`, `aria-controls`, active-descendant on options, ArrowUp/Down/Enter/
  Escape, screen-reader hint (`index.html:117–134`, `ui.js:230–249`). The dismiss bug (C1) is
  the one gap.
- **Alerts modal** — `role=dialog aria-modal`, focus trap with Tab/Shift+Tab boundary wrap
  (`alertsPanel.js:798–815`), Escape + backdrop dismiss, `activeElement` snapshot/restore,
  roving-tabindex tablist + polite live-region for tab changes (the `aria-labelledby` slip in C2
  is the only defect).
- **Skip-link + landmarks** — skip-nav → `#station-search` (first useful control, not the bare
  map), `<main>`, `<header role=search>`, visually-hidden `<h1>`.
- **Dark mode** — single source of truth via `:root` / `body.dark-mode` token redefinition;
  `theme-color` meta per scheme; no hardcoded surface colors in CSS.
- **Reduced motion** — decorative motion (flyTo, popup/chip fades, pulses) gated
  (`css:1929–1932, 3043–3048`); essential vehicle motion correctly exempt (CLAUDE.md contract).
- **Focus visibility** — `:focus-visible` rings on legend rows, controls, tabs, PWA buttons,
  popup close (each `outline:none` has a replacement). Search input is the one weak ring (A3).
- **Legend bottom sheet** — peek/open states, drag handle, velocity+distance dismiss,
  `--sheet-lift` coordination with the MapLibre attribution control.
- **Loading splash** — `role=status aria-live=polite`, 15 s fallback, fade-out gated so popups
  don't render over it.
- **E/K/J route-color 1.4.11** — already an accepted decision, mitigated by the numeric count
  text and pinned by `route-color-contrast.test.js`. Confirmed handled.

## 7. Suggested implementation order (if/when approved)

1. **C1** (bug, S) — one CSS line; ship immediately.
2. **C2 + A1 + A3 + E2 + search-refocus** (all S, a11y/CSS) — one small "chrome polish" PR.
3. **A2** (S) — point the scent text at `--text-muted`; one PR with the contrast-test update.
4. **E1 + layer-toggle "on" cue** (M) — empty/affordance pass.
5. **R1–R5** (M/S) — one "touch & responsive" PR, **only after device verification**.
6. Type-scale / inline-style cleanup — adopt for new work; no dedicated churn PR.
