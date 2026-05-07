# Review: Stations & Boarding Logic

Reviewer: automated review batch 2026-05-06
Scope: js/stations.js

## Summary
The module is well-structured: registry merge, popup builder, and badge renderer are cleanly separated, and every feed-derived string going into innerHTML is routed through `esc()`. A few defensive gaps stand out — most notably an unguarded `directionId` index that could throw on malformed feed data (fixed inline) — plus a handful of perf/a11y/doc-debt items. The file ships with zero direct test coverage despite housing nontrivial merge math, popup HTML construction, and badge dedupe logic.

## Findings — Bugs (highest priority)
- [HIGH] `routeMap.get(a.routeId)[a.directionId].push(a)` throws if `directionId` is null/undefined or not 0/1 — js/stations.js:333 — `getScheduledArrivals` derives `directionId` from feed data; a malformed trip_update with `direction_id` missing produces `undefined.push(...)` and breaks the entire popup. Note the bus path on line 547 already uses `?? 0` defensively — inconsistent.
  - Recommendation: Coerce to 0/1 before indexing.
  - Status: Fixed inline (`const dir = a.directionId === 1 ? 1 : 0;`).
- [LOW] `!stop?.lat || !stop?.lon` rejects valid `lat=0`/`lon=0` — js/stations.js:144, 199, 688, 751 — works for LA Metro but is technically incorrect; copies of this pattern propagate.
  - Recommendation: Use `Number.isFinite(stop?.lat) && Number.isFinite(stop?.lon)`.
  - Status: Recommended.
- [LOW] Stale/garbled comment block above `_boardingBadges` left a dangling sentence ("Key: `${stopId}|${routeCode}|${dir}` — one badge per (origin stop, route,") from a prior refactor — js/stations.js:733-740 — current keying is by station group's first stopId, which contradicts the stale comment.
  - Recommendation: Replace with accurate comment.
  - Status: Fixed inline.
- [LOW] `RAIL_LIKE_ROUTES` includes `'806'` but no `ROUTE_LETTER` mapping exists for it — js/stations.js:31, 326 — a hypothetical 806 arrival would render as the literal `"806"` letter and sort under its own digit-prefix instead of an alpha letter. Likely vestigial.
  - Recommendation: Either remove `'806'` from `RAIL_LIKE_ROUTES` or add it to `ROUTE_LETTER`.
  - Status: Recommended.
- [LOW] Active-alert filter assumes `activePeriod.start`/`end` are always present — js/stations.js:470 — if either side is `undefined`, comparison silently yields `false`, so an open-ended alert (only `start`, no `end`) is silently dropped.
  - Recommendation: Treat missing `end` as Infinity (and missing `start` as 0) so open-ended alerts surface.
  - Status: Recommended.

## Findings — Math / Statistics
- [MED] 300 m merge radius lacks documented justification — js/stations.js:13 (imported), used at 61, 71, 841 — value lives in config.js but the trade-off (over-merge of nearby distinct stations vs under-merge of transfer pairs) is undocumented in the call sites.
  - Recommendation: Inline a one-line rationale comment ("Empirically chosen to capture 7th/Metro paired platforms, ~280 m") at first use.
  - Status: Recommended.
- [LOW] `cleanStationName` regex chain (utils.js:43, applied here for normName) has potential false positives: a station literally named "...Lower Level Annex" would be truncated to "..." by `\s*-\s*(Upper|Lower)\s+Level\b.*` — utils.js, called from js/stations.js:67 — out-of-lane (utils.js) but worth flagging since correct merge depends entirely on this normalization.
  - Recommendation: Out-of-lane.
  - Status: Out-of-lane (see below).
- [LOW] Cardinal-direction calculation uses degrees of lat/lon directly — js/stations.js:584-587 — at LA latitude (~34°), 1° lat ≈ 111 km but 1° lon ≈ 92 km. Comparing `|dLat|` vs `|dLon|` is biased toward classifying east-west as north-south. The 0.0005° threshold is also asymmetric in meters (~55 m N/S vs ~46 m E/W).
  - Recommendation: Multiply `dLon` by `cos(lat)` before comparison, or use `planarMeters`-style projection.
  - Status: Recommended.

## Findings — Code Quality
- [LOW] Duplicated badge-row HTML between `_badgeHTML` and `_entryHTML` — js/stations.js:792-809 — both build the identical row, kept in sync only by author discipline.
  - Recommendation: Have `_badgeHTML` call `entries.map(_entryHTML).join('')`.
  - Status: Recommended.
- [LOW] `findGroup` does an O(n) scan inside `addToRegistry`, called once per stop — js/stations.js:58-63 — overall O(n²) station merge. n≈100 today, so ~10k ops at startup. Fine, but if rail expansion lands the trend is wrong.
  - Recommendation: Build a `Map<normName, group[]>` index if station count grows beyond ~500.
  - Status: Recommended.
- [LOW] Module-global `_lastHighlightVids` carries highlight state across the whole module rather than living on the popup instance — js/stations.js:37 — couples popup lifecycle to a free-floating var that must be cleared by every exit path (currently is, but fragile).
  - Recommendation: Attach to `activePopup` (`activePopup._highlightVids`) so its lifetime tracks the popup.
  - Status: Recommended.
- [LOW] Error swallowing on popup refresh — js/stations.js:258-260 — `console.warn` only; if `getScheduledArrivals` ever throws on bad data the popup will silently keep showing stale HTML.
  - Recommendation: Acceptable — refresh failures are recoverable. Leave as-is but consider adding an error counter for telemetry.
  - Status: Recommended (nit).
- [INFO] No direct unit tests — `tests/` has no `stations.test.js` — js/stations.js (whole file) — non-trivial logic (merge math, popup HTML construction, alert dedupe, cardinal resolution) is unverified.
  - Recommendation: Add `tests/stations.test.js` covering: `addToRegistry` merge cases (same-name <300 m, same-name >300 m, busway-fallback different-name), `cardinalToTerminus` (latitude correction once applied), alert dedupe by effect, and `_formatDeparture` boundary (`secs <= 30` boundary, `null` input).
  - Status: Recommended.

## Findings — Performance
- [LOW] `document.querySelectorAll('.marker').forEach(...)` runs on every popup tick — js/stations.js:287 — O(markers) DOM scan per refresh, even though the 285 early-return prevents the loop when the highlight set is unchanged. Fine in practice (~50–150 markers).
  - Recommendation: Track highlighted elements in a `Set<HTMLElement>` so the unhighlight loop hits only previously-highlighted nodes.
  - Status: Recommended.
- [LOW] `wrapEl.innerHTML = entries.map(_entryHTML).join('')` re-renders every badge every tick regardless of whether `entries` changed — js/stations.js:901 — causes layout thrash for unchanged badges.
  - Recommendation: Hash the entry list and skip the assignment when unchanged (mirrors the highlight-set short-circuit).
  - Status: Recommended.
- [LOW] `byRoute` populates with `if (!slot.some(x => x.tripId === a.tripId))` — js/stations.js:548 — O(n²) over arrival list per route per stop. Bounded by Metro feed sizes so practical impact is nil.
  - Recommendation: Use a `Set<tripId>` per slot.
  - Status: Recommended.

## Findings — Security / Privacy
- [INFO] All feed-derived string interpolations into innerHTML go through `esc()` — verified line-by-line for `name`, `dest`, `dest.label`, `dest.title`, `meta.long_name`, `meta.short_name`, `a.description`, `a.header`. Constant/config-derived values (`letter`, `iconSrc`, `color`, `routeIcons[*]`, `routeHexColors[*]`) skip escaping but originate in `config.js` (not feed-controlled).
  - Recommendation: Add an inline comment at line 230 (already present) and at the badge HTML builders (792, 803) noting the trust boundary, so future contributors don't add a feed-sourced field next to the unescaped color.
  - Status: Recommended.
- [LOW] `style="--bb-color:${color};"` interpolates the route color directly into a CSS custom property — js/stations.js:795, 805 — currently safe because `color` is `routeHexColors[routeCode] || '#231f20'` from config. If `routeHexColors` ever picks up a feed-sourced value, an attacker-controlled string could break out of the property and inject CSS (not script, but UI defacement).
  - Recommendation: Validate `color` matches `/^#[0-9a-fA-F]{3,8}$/` before interpolation.
  - Status: Recommended.

## Findings — Accessibility
- [MED] Station popup has no `role="dialog"`, `aria-label`, or focus management — js/stations.js:227 (popup construction) — popup opens on hover with no keyboard equivalent and screen readers cannot announce it as a dialog.
  - Recommendation: Add `role="dialog"` and `aria-label` (the station name) to `.station-popup-wrap`. For keyboard parity, add `tabindex="0"` on the click layer or surface station list elsewhere. Hover-only opening is a known a11y gap.
  - Status: Recommended.
- [LOW] Pills (`.arr-time-pill`) and badges have no `aria-label` — js/stations.js:427, 437, 618, 797 — assistive tech reads "1m" / "Now" with no context ("1 minute to Westbound A Line").
  - Recommendation: Add `aria-label="1 minute"` (or compose with route + direction context) to pill elements.
  - Status: Recommended.
- [GOOD] `<details>`/`<summary>` for alerts and nearby buses is keyboard-accessible by default.

## Findings — Documentation / JSDoc
- [LOW] Internal helpers `findGroup`, `addToRegistry`, `groupsToFeatures`, `_addStationSourceAndLayer`, `addBuswayStopsFromTrips`, `clearVehicleHighlights`, `applyVehicleHighlights`, `buildArrivalsHTML`, `_renderBoardingBadges`, `_findStationCoords`, `_formatDeparture`, `_badgePlacement`, `_badgeHTML`, `_entryHTML`, `_applyBadgeZoom`, `toDisplayName` all lack JSDoc — js/stations.js — consistent with project's "JSDoc terse" convention for private helpers, so largely OK, but `buildArrivalsHTML` and `_renderBoardingBadges` are big enough to deserve a 1-line summary.
  - Recommendation: Add 1-line JSDoc on `buildArrivalsHTML` and `_renderBoardingBadges`.
  - Status: Recommended.
- [LOW] `addToRegistry` `isBusway=true` semantics ("proximity-only fallback") only hinted in the inline comment at 65 — js/stations.js:66 — the parameter name and call sites read clearly, but the trade-off (different normalized name + within 300 m → merge) is the kind of thing future maintainers will want one paragraph on.
  - Recommendation: Expand the comment to one paragraph or add JSDoc.
  - Status: Recommended.

## Suggestions (non-defect improvements)
- [INFO] `getNearbyBusStops` is exported but only used inside this file — js/stations.js:684 — verify no other importer; if internal, drop `export`.
- [INFO] `findNearestStation` parameter order is `(lng, lat)` while everything else in the file uses `(lat, lng)` order — js/stations.js:701 — easy mistake site for callers.
  - Recommendation: Rename to `findNearestStationLngLat` or normalize to `(lat, lng)`.
- [INFO] Window globals `__openStationByGroup`, `__hoverStationByGroup`, `__closeStationIfUnpinned` are an ad-hoc API for bikeshare.js — js/stations.js:724-731 — could be a single named-export module that bikeshare.js imports lazily, but the comment correctly notes "circular import" as the rationale. Acceptable.

## Findings out-of-lane (for other units)
- Unit (utils): `cleanStationName` regex `\s*-\s*(Upper|Lower)\s+Level\b.*` truncates on first match — js/utils.js:49 — a station "Foo - Lower Level Annex" would be reduced to "Foo". Probably no real-world hit in LA Metro but worth a quick scan of master stops.
- Unit (predictions): `getScheduledArrivals` should guarantee `directionId` is 0 or 1; the rail path here trusted that and would have crashed on a malformed value — js/predictions.js (caller of `getScheduledArrivals`) — recommend `directionId` normalization in predictions.js so consumers don't each defend.
- Unit (config): `routeHexColors` and `routeIcons` are interpolated unescaped into popup HTML/CSS — js/config.js — values must remain author-controlled; add a comment at the source so contributors don't pull them from a feed later.
- Unit (alerts): `STRIP_EFFECT_LABELS` is consumed at js/stations.js:469 with a one-off override (`ACCESSIBILITY_ISSUE: 'Elevator/escalator'`) — js/alerts.js — consider moving the override into alerts.js for a single source of truth.
- Unit (tests): no `tests/stations.test.js` exists despite ~932 lines of nontrivial logic — tests/ — recommend a dedicated suite.

## Inline fixes applied in this PR
- fix(stations): guard `directionId` indexing on rail arrivals to prevent `undefined.push` on malformed feed entries (js/stations.js:333)
- polish(stations): replace stale half-finished comment block above `_boardingBadges` with accurate description (js/stations.js:733-740)

## Test impact
- npm test before: 173 passed (12 files)
- npm test after: 173 passed (12 files)
- New/changed tests: none (no behavioral change; recommended tests/stations.test.js noted as a follow-up)
