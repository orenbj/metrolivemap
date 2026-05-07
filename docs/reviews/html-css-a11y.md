# Review: HTML, CSS, Accessibility, Performance

Reviewer: automated review batch 2026-05-06
Scope: index.html, styles/index-style.css

## Summary
The HTML document is clean and well-structured for a single-page map app, with thoughtful CSP/SRI hygiene and reasonable a11y baseline (aria-live regions, aria-labels on icon buttons, focus-visible rings). The CSS has a few dead rules and one stale route filter; semantic landmark structure is light (no `<header>`/`<main>`); inline styles are heavy in a few places; color-only signaling on routes (icons use color, not text) deserves a documented note.

## Findings - Bugs (highest priority)
- [LOW] Stale `body.hide-route-806` selector targets a non-existent route - styles/index-style.css:601 - No data-route="806" exists anywhere in HTML or JS (only 801-805, 807, 901, 910). Dead selector, no functional impact.
  - Recommendation: Remove the unused selector.
  - Status: Fixed inline

## Findings - Code Quality
- [LOW] Dead CSS rule `#legend-mini-logo` - styles/index-style.css:119 - No element with this id exists in HTML or is created by JS.
  - Recommendation: Remove.
  - Status: Fixed inline
- [LOW] Dead CSS rule `#legend-description` - styles/index-style.css:420 - No element with this id exists.
  - Recommendation: Remove.
  - Status: Fixed inline
- [LOW] Dead CSS rule `#legend hr` - styles/index-style.css:427 - No `<hr>` inside `#legend` in HTML or JS-injected DOM.
  - Recommendation: Remove.
  - Status: Fixed inline
- [LOW] Inline `style="..."` attributes used heavily in `#legend-mini`, `#legend-total-row`, `#legend-toggle-hint`, `#mobile-total-row`, `#update-time-container`, `#legend-header`, `#total-count-badge*` - index.html:116, 144-156, 207-214 - bypasses CSS file, complicates theming and CSP `style-src 'unsafe-inline'` justification.
  - Recommendation: Move these to `index-style.css`. Once moved, the `'unsafe-inline'` in style-src can eventually be tightened (note GTM still injects inline styles, so cannot remove yet).
  - Status: Recommended
- [LOW] `!important` overuse in dark-mode map control overrides - styles/index-style.css:416, 1276-1297 - Eight !important declarations in dark-mode rules. Workaround for MapLibre's stylesheet specificity but worth replacing with more specific selectors where practical.
  - Recommendation: Track as tech debt; not urgent.
  - Status: Recommended
- [LOW] `min-width` on `.metric-badge` (24px) is wider than its content rendering at small numbers; visually fine but check tablet breakpoint.
  - Recommendation: None required.
  - Status: Recommended

## Findings - Performance
- [LOW] Google Fonts (`Open+Sans`) loaded with `display=swap` but no `preload` for the font file - index.html:74 - causes ~200ms FOIT/FOUT delay on cold load.
  - Recommendation: Add `<link rel="preload" as="font" type="font/woff2" crossorigin>` for the primary woff2 (or self-host the family). Low-impact since `font-family` falls back to `sans-serif` quickly.
  - Status: Recommended
- [LOW] `backdrop-filter: blur(...)` applied to `#legend-container`, `#legend-mini`, `#station-search`, `#loading` - styles/index-style.css:83, 134, 213, 1052 - cheap on modern GPUs but compounds when overlaid; `#loading` is full-screen, briefly. Acceptable.
  - Recommendation: None.
  - Status: Recommended
- [LOW] `transition: ... height 0.3s, margin 0.3s` on `.legend-row` - styles/index-style.css:455 - animating non-composited properties triggers layout per frame on toggle. Number of rows is small (8) so impact is negligible, but `max-height` would be cheaper.
  - Recommendation: Switch to `max-height` if route count grows.
  - Status: Recommended
- [LOW] No `loading="lazy"` on the legend route SVG icons - index.html:161-198 - 8 small SVGs from `lacmta.github.io`, all visible above the fold on desktop, hidden behind sheet on mobile. Adding `loading="lazy"` would help mobile.
  - Recommendation: Add `loading="lazy" decoding="async"` to legend `<img>` tags.
  - Status: Recommended
- [LOW] MapLibre script uses `defer` (good), but `mapbox-gl-esri-sources` also uses `defer` and depends on MapLibre globals - index.html:69 - script execution order with `defer` follows source order, so this works, but is fragile if anyone reorders.
  - Recommendation: Document the load-order dependency in a comment.
  - Status: Recommended

## Findings - Security / Privacy
- [LOW] No `Referrer-Policy` meta tag - index.html (head) - default referrer behavior may leak the full URL to third-party CDNs (unpkg, googleapis, fonts.gstatic).
  - Recommendation: Add `<meta name="referrer" content="strict-origin-when-cross-origin">`.
  - Status: Fixed inline
- [INFO] CSP `'unsafe-inline'` on `script-src` and `style-src` - index.html:20 - acceptable trade-off for GA/GTM, already documented in head comment. Trusted Types path also documented (S-3).
  - Recommendation: None now; revisit when GTM supports nonce-based CSP.
  - Status: Recommended
- [LOW] CSP `connect-src` includes `https://*.lambda-url.us-west-1.on.aws` (a wildcard) - index.html:20 - not a tight bound; any AWS Lambda URL in that region is allowed. Acceptable since the keys are restricted on the AWS side, but worth a comment.
  - Recommendation: Replace with specific Lambda hostname when deployment is stable.
  - Status: Recommended
- [INFO] No inline event handlers (`onclick=...`) in HTML; all interaction wired via JS modules. Good.
  - Status: Recommended

## Findings - Accessibility
- [MEDIUM] No semantic landmarks - index.html:80-220 - body uses bare `<div>` for everything. Screen readers benefit from `<header>`, `<main>` (the map region), and `<aside>` (legend).
  - Recommendation: Wrap `#map` in `<main>` (or add `role="main"`), wrap `#legend-container` in `<aside aria-label="Route legend">`. Inline-fixed: added `role="region" aria-label="Interactive Metro map"` on `#map`.
  - Status: Partial fix inline; full landmark refactor recommended
- [LOW] No skip-link or `<h1>` - index.html - The visible "Metro Live Map" text in the legend (line 130) is rendered as a `<div>` not `<h1>`. There is no document heading.
  - Recommendation: Either change `#legend-title` first child to `<h1>` or add a visually-hidden `<h1>Metro Live Map</h1>` near top of body.
  - Status: Recommended
- [LOW] `.legend-row` is interactive (`cursor: pointer`, click handler) but rendered as `<div>` without `role="button"` or `tabindex="0"` - index.html:160-199 - keyboard users cannot toggle a route.
  - Recommendation: Add `role="button" tabindex="0"` and a keyboard handler, or convert to `<button>`. Behavioral change so left for design review.
  - Status: Recommended
- [LOW] Search results items (built dynamically in JS) are clickable `<div>`s; ensure JS sets `role="option"` and supports arrow-key nav.
  - Recommendation: Out-of-lane; flag to JS owner.
  - Status: Recommended
- [LOW] Color-only signaling for routes - index.html:160-199 - route icons distinguishable mostly by hue. The official Metro SVGs include the letter (A/B/C/...), so color-blind users can still read the route. Acceptable - Metro iconography is designed for this.
  - Status: Recommended
- [LOW] `#connection-status-dot` has `title="Connecting"` initially but the title is not updated when class flips to `.connected/.disconnected` - styles/index-style.css:387-393 (CSS), index.html:212 (HTML) - screen readers cannot tell connection state.
  - Recommendation: Have JS update the `title` and add `aria-label` when flipping the class. Out-of-lane (JS).
  - Status: Recommended
- [LOW] `#total-count-badge.pulse` animation does not respect `prefers-reduced-motion` - styles/index-style.css:545. Same for `.dot` (loader), `pulse-green`, `pulse-green-dk`, `.legend-row` transitions.
  - Recommendation: Add `@media (prefers-reduced-motion: reduce) { ... animation: none; transition: none; }` block. Behavioral change so left for design review.
  - Status: Recommended
- [LOW] Color contrast: `--text-muted: #888` on `--bg-glass: rgba(255,255,255,0.85)` - styles/index-style.css:18-21. #888 on #fff is ~3.5:1 - below WCAG AA 4.5:1 for body text. Used for labels, "Connecting...", count-badge in default legend, search hint.
  - Recommendation: Darken to `#6b6b6b` (~5.0:1) or restrict #888 to >=18px text.
  - Status: Recommended
- [LOW] Color contrast in dark mode: `--text-muted: #aaa` on `rgba(40,40,40,0.85)` is ~5.5:1 - OK. `#0072bc` link color on white passes (4.6:1). Dark-mode `.filter-text-btn` `#93c5fd` on `rgba(40,40,40,0.85)` ~7:1 - good.
  - Status: Recommended
- [LOW] `<button id="legend-mini">` contains a literal `<div>` child with inline-styled "LEGEND" text - index.html:116 - invalid: block-level inside button is allowed in HTML5 but inconsistent. Works in all browsers.
  - Recommendation: Replace inner `<div>` with `<span>`.
  - Status: Recommended

## Findings - Documentation / JSDoc
- None for these files (HTML/CSS).

## Suggestions (non-defect improvements)
- [LOW] Add `<link rel="dns-prefetch" href="...">` for `lacmta.github.io` (legend SVGs) and `gbfs.bcycle.com` (bikeshare).
- [LOW] Move repeated `.maplibregl-popup-content` styling for vehicle/station popups into a shared mixin/class to reduce duplication.
- [LOW] CSS section comments are good and consistent - keep that style.
- [LOW] Consider adding `rel="noopener"` to any future external `<a>` tags (currently none in static HTML).

## Findings out-of-lane (for other units)
- Unit (js): Search results rendered as `<div>`; lack `role="option"`/keyboard nav - js/ui.js (search results render).
- Unit (js): `#connection-status-dot` class flip should also update `title`/`aria-label` for SR users - js/main.js or wherever connection state is set.
- Unit (deployment/SEO): `<meta property="og:url">` says `https://metrolivemap.net/`, but README/CLAUDE.md says custom domain is `livemap.metro.net` (DNS pending). Verify intended canonical domain - index.html:52.

## Inline fixes applied in this PR
- polish: remove dead `#legend-mini-logo`, `#legend-description`, `#legend hr` rules
- polish: remove stale `body.hide-route-806` selector (no such route)
- polish: add `Referrer-Policy: strict-origin-when-cross-origin` meta tag
- a11y: add `role="region" aria-label="Interactive Metro map"` on `#map`

## Test impact
- npm test: passing before changes; expected to remain passing (CSS-only and meta-tag-only changes).
- New/changed tests: none
