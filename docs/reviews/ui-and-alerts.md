# Review: UI Layer + Alerts

Reviewer: automated review batch 2026-05-06
Scope: js/ui.js, js/alerts.js

## Summary
Both modules are tight, readable, and consistently use `escHtml` for popup HTML and `textContent` for the `!` alert badge, so no XSS exposure was found. The main gaps are accessibility on the search results / alert badge tooltip (missing on hover/focus) and a per-click `localStorage` write in the legend filter that is fine but could batch. No regressions introduced; tests stay green.

Note: the task brief mentions a "recently added tooltip-on-hover feature" in `alerts.js`, but the current `alerts.js` (HEAD) contains no tooltip code — only a `!` badge with `aria-label="Service alert"`. Either the feature has not landed in this worktree, or the brief is forward-looking. Findings below cover what is actually present.

## Findings — Bugs (highest priority)
- [LOW] `cleanDestination` assumes a string and will throw on non-string inputs — js/ui.js:14 — `dest.trim()` is unguarded. Current callers (`ui.js:482`, `stations.js:376`) gate with `tripInfo?.dest ?`, so a falsy value is filtered, but a non-string (e.g. a number from a malformed feed) would throw.
  - Recommendation: `const d = String(dest ?? '').trim(); if (!d) return '';` at the top.
  - Status: Recommended.
- [LOW] `setLegendRowVisible` toggles `body` class and persists state even when `route` is the empty-string fallback — js/ui.js:68-80. `legendRoutes[i]` is computed as `r.getAttribute('data-route') || ''`; if a `.legend-row` were ever to lack `data-route`, the helper would write `hide-route-` and persist `""` in `disabledRoutes`.
  - Recommendation: early-return when `!route`. Currently filtered in callers (`if (legendRoutes[i])`) but the helper itself is not defensive.
  - Status: Recommended.
- [LOW] `_fetchAlerts` swallows all errors silently — js/alerts.js:52-54. A persistent fetch failure leaves stale data with no observable signal.
  - Recommendation: `console.warn('alerts fetch failed', err)` to aid debugging without affecting users.
  - Status: Recommended.
- [LOW] `updateAlertBadges` does not handle the case where `wrap` already exists but `img` is no longer the first child — js/alerts.js:117-124. Only relevant if other code re-parents the `img`; currently nothing does.
  - Recommendation: none required today; flag if the legend DOM changes.
  - Status: Recommended (informational).

## Findings — Math / Statistics
- [INFO] Drag velocity uses `(y - lastY) / dt` in px/ms — js/ui.js:271. Correct, well-scoped, and stable for typical 16ms touch frames. No EWMA smoothing, so a single noisy frame at end-of-drag could produce a spurious flick. Empirically the 0.4 px/ms threshold is high enough that this is not a problem, but worth noting.
  - Recommendation: optional smoothing `vel = 0.7*prevVel + 0.3*sample` if false-flick dismisses are reported.
  - Status: Recommended.
- [INFO] `SHEET_DISMISS_RATIO = 0.30` and `SHEET_VELOCITY_DISMISS = 0.4` — sensible defaults consistent with iOS/Material patterns. No issue.
  - Status: N/A.

## Findings — Code Quality
- [LOW] Stray comment `// ... rest of initUI ...` left at js/ui.js:24.
  - Recommendation: remove.
  - Status: Fixed inline.
- [LOW] `cleanDestination` regexes are applied unconditionally and may collapse legitimate names (e.g. a hypothetical "Foo - Bar" terminus). Today's data is fine; fragile to future feed changes.
  - Recommendation: add a unit test once UI tests are introduced.
  - Status: Recommended.
- [LOW] `updateUpdateTime` uses `toLocaleTimeString()` with no locale/options — output varies by user locale and may include AM/PM mid-string for some users.
  - Recommendation: pass `[]` options or `'en-US'` to stabilize, or prefer `HH:MM:SS` 24h format.
  - Status: Recommended.
- [INFO] `updateDataPanel` throttle uses `_now - _panelLastUpdated < 1000` so the very first call after a 1s gap is effectively never throttled — correct behavior. No issue.
- [INFO] `legendRoutes`/`legendRows` cached at init — good. Caching avoids repeat `querySelectorAll` on the hot path.

## Findings — Performance
- [LOW] `setLegendRowVisible` writes `localStorage` on every legend click — js/ui.js:73-78. Each click fires once (single-row solo or show/hide-all batches multiple). For batch operations (`showAll`/`hideAll`) this performs N synchronous `JSON.parse + JSON.stringify + setItem` cycles.
  - Recommendation: batch — compute the new disabled list once after the loop, then write once. Saves ~10 writes when the user toggles show-all/hide-all.
  - Status: Recommended.
- [LOW] `getPopupHTML` is rebuilt on every VP update for the open popup (markers.js:746) via full template-string concatenation. Cost per call is small (~2 KB string), but at >1 update/sec for many open popups this adds up.
  - Recommendation: cache the static parts (header, accent) and only rewrite `.pv2-secs`/`.arr-time-pill` text. Out-of-scope for ui.js alone (markers.js owns the call site).
  - Status: Recommended (cross-module).
- [INFO] Alerts polling interval is `ALERTS_POLL_MS` and pauses on hidden tabs via `setVisibleInterval` — good.
- [INFO] `updateAlertBadges` is O(legend-rows) per poll; legend has ≤10 rows, negligible.

## Findings — Security / Privacy
- [INFO] All popup HTML interpolations of feed-derived strings (`stopName`, `vehicleLabel`, `vehicleId`, `iconSrc`, `destination`, `etaStr`, `statusLabel`) are wrapped in `esc(...)` (escHtml) — XSS-safe. js/ui.js:495-545.
- [INFO] Style attributes use only numeric `pct` and config-controlled `accentColor` (`routeHexColors[routeCode] ?? '#888'`) — safe from CSS injection.
- [INFO] Alert badge uses `textContent = '!'` and `setAttribute('aria-label', 'Service alert')` — both XSS-safe. js/alerts.js:127-128.
- [INFO] Alerts feed text (`headerText`, `descriptionText`) is stored in `window.masterAlertsData` but never injected into the DOM by `alerts.js`. Any DOM consumer must escape it themselves; today's `updateAlertBadges` does not render alert text at all.
- [LOW] Search input is interpolated only via `data-id="${g.normName}"` and `${esc(g.displayName)}` — `normName` is from `stationGroups` (built locally from GTFS, not user-controlled) but is not escaped. If a future data source allows `"` in `normName`, the attribute would break.
  - Recommendation: `data-id="${esc(g.normName)}"` for defense in depth.
  - Status: Recommended.

## Findings — Accessibility
- [MEDIUM] Search results are visually a list but not announced as one — js/ui.js:163-174. Each match is a bare `<div>` with no `role="option"`, no parent `role="listbox"`, and the input has no `aria-controls`/`aria-activedescendant`.
  - Recommendation: add `role="listbox"` to `#search-results` and `role="option"` to each match `<div>`; arrow-key navigation would round it out.
  - Status: Recommended.
- [MEDIUM] Search results items lack `tabindex` and keyboard handling — only mouse `click` is wired (js/ui.js:177).
  - Recommendation: handle `Enter` on focused option; allow up/down arrow to traverse.
  - Status: Recommended.
- [LOW] `.alert-badge` has `aria-label="Service alert"` (good) but contrast of `#fff` on `#f59e0b` is ~2.0:1 — fails WCAG AA for 7px text. The element is 10×10px decorative; the `!` is borderline illegible.
  - Recommendation: keep the badge purely iconic (no text) and rely on `aria-label`. Optionally darken to `#b45309` for ~4.0:1 if "!" is to remain visible.
  - Status: Recommended.
- [LOW] No focus trap or focus restoration on the mobile bottom sheet (`#legend-container`) — when the sheet opens/closes, focus is not moved or restored. Keyboard users on mobile can't easily reach legend content.
  - Recommendation: focus first interactive element on open; restore previous focus on close.
  - Status: Recommended.
- [LOW] Toast (`showToast`) is not announced — no `role="status"` / `aria-live`. Screen-reader users miss it.
  - Recommendation: `toast.setAttribute('role','status')` (polite) before append.
  - Status: Recommended.
- [INFO] Legend rows correctly set `role="checkbox"`, `aria-checked`, `tabindex="0"`, and bind Enter/Space — good.

## Findings — Documentation / JSDoc
- [LOW] `cleanDestination` has a docstring but no `@param`/`@returns`.
  - Recommendation: add explicit tags.
  - Status: Recommended.
- [LOW] `initUI`, `removeLoadingScreen`, `showToast`, `updateDataPanel`, `updateUpdateTime`, `setConnectionStatus`, `getPopupHTML` all have JSDoc — good.
- [LOW] `getActiveAlerts`, `updateAlertBadges`, `initAlerts` all documented — good. `STRIP_EFFECT_LABELS` has a brief comment — good.
- [INFO] Internal `_fetchAlerts`, `_ingest`, `initSwipeSheet`, `updateFilterButtons`, `adjustMiniDisplay`, `isMobile` have no JSDoc — acceptable for private helpers.

## Suggestions (non-defect improvements)
- Pull `SHEET_DISMISS_RATIO` and `SHEET_VELOCITY_DISMISS` into `config.js` for tuning.
- Add a `data-test-id` on the alert badge wrap to ease future e2e tests.
- Consider extracting the `<button>` listeners (show-all / hide-all) into a tiny helper to deduplicate the two near-identical blocks at js/ui.js:121-137.
- `updateAlertBadges` could be debounced or cancelled when `document.hidden` (already partially mitigated by `setVisibleInterval` on the poll).

## Findings out-of-lane (for other units)
- Unit (markers): `markers.js:418` and `markers.js:747` rebuild full popup HTML on every WS update — see Performance above.
- Unit (config/data): `cleanDestination`'s regex set should be exercised by a unit test once a UI test scaffold lands.
- Unit (ui-tests): no test files cover `js/ui.js` or `js/alerts.js`. Recommend at minimum unit tests for `cleanDestination`, `getActiveAlerts` time-window filter, and `updateAlertBadges` idempotency.
- Unit (markers/stations): the popup `iconSrc` is interpolated but `routeIcons[routeCode]` may be undefined for unknown route codes; today the fallback is `''` which renders an empty `<img>`. Consider a default icon.

## Inline fixes applied in this PR
- ui.js: removed stray `// ... rest of initUI ...` placeholder comment at line 24.

## Test impact
- npm test: 173 passed before; 173 passed after.
- New/changed tests: none (no test files for ui.js/alerts.js — flagged as a finding).
