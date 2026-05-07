# Review: Documentation Coherence

Reviewer: automated review batch 2026-05-06
Scope: README.md, CLAUDE.md, JSDoc sample across js/**

## Summary
Documentation is generally accurate and well-structured, but several drift items had crept in: the `data/` table missed the committed `bus-routes.json`, the script list referenced files that no longer exist (`analyze-eta.js`, `capture-eta.js`, `diag.js`), the bus trip_updates URL no longer carries a route filter, the CI workflow filename was stale, and both READMEs understated the test count and the test surface (currently 173 tests across 12 files, not just two). Inline drift fixes are applied; remaining items are out-of-lane JSDoc gaps in `main.js`, `markers.js`, `api.js`, and `ui.js`.

## Findings — Drift (highest priority)
- [HIGH] README scripts list referenced three files that no longer exist — README.md:163-166 — `scripts/` actually contains `build-shapes.js`, `audit-feeds.js`, `live-accuracy-harness.js` (plus `package.json`).
  - Recommendation: replace with current script set
  - Status: Fixed inline
- [HIGH] README data-files table omitted `data/bus-routes.json` — README.md:85-88 — file is committed, fetched in `js/main.js:24`, and referenced by `scripts/build-shapes.js`.
  - Recommendation: add row + repo-tree entry
  - Status: Fixed inline
- [HIGH] Bus trip_updates WebSocket URL drifted — README.md:107 — README claimed `wss://.../trip_updates/910,901,950`, but `js/tripUpdates.js:21` opens the unfiltered `wss://api.metro.net/ws/LACMTA/trip_updates` so arrival popups can populate for all routes.
  - Recommendation: align URL and note it is unfiltered
  - Status: Fixed inline
- [MED] G/J bus vehicle_positions URL listed routes in wrong order — README.md:105 — code uses `910,901` (`js/main.js:42`), README had `901,910`.
  - Recommendation: align ordering
  - Status: Fixed inline
- [MED] CI workflow filename stale — README.md:195 — README referenced `gtfs-drift.yml`, actual file is `.github/workflows/gtfs-drift-check.yml`. Also `tests.yml` runs the Vitest suite on push/PR and was undocumented.
  - Recommendation: rename and add tests.yml
  - Status: Fixed inline
- [MED] README and CLAUDE.md understated the test surface — README.md:191, CLAUDE.md:23 — both implied tests cover only `predictions.test.js` + `snap.test.js`. Actual: 12 files, 173 tests (`adherence-offset`, `api`, `boarding-vehicles`, `dr-animation`, `heading`, `marker-lifecycle`, `prediction-blend`, `predictions`, `scheduleCalibration`, `snap`, `spike-rejection`, `tripUpdates`).
  - Recommendation: list categories and the current count
  - Status: Fixed inline
- [LOW] CLAUDE.md "Built JSON files" enumeration was incomplete — CLAUDE.md:20 — listed only rail-shapes / stops / trips; bus-routes.json and metro-micro-zones.json are also committed.
  - Recommendation: add them
  - Status: Fixed inline

## Findings — Documentation / JSDoc
- JSDoc coverage is good across the rendering / data-flow modules sampled (`alerts.js initAlerts`, `api.js setupWebSocket`, `bikeshare.js initBikeShare`, `map.js initMap`, `markers.js computeHeading`, `microzones.js initMicroZones`, `predictions.js initPredictions / findIdx`, `scheduleCalibration.js recordSegmentTime`, `snap.js precomputeRoute`, `stations.js initStations`, `tripUpdates.js initTripUpdates / processUpdate`, `ui.js initUI`, `utils.js planarMeters / computeBearing`). Blocks are terse, accurate, and consistent with the underscore-prefix private convention.
- `js/config.js` has zero JSDoc-style annotation. The constants are self-documenting via inline `//` comments and section headers, which is acceptable for a constants file; no change recommended.
- Several internal helpers lack JSDoc — listed under "out-of-lane" below since this unit may not edit JS modules.

## Findings — Code Quality
- README.md and CLAUDE.md formatting is clean — no typos found in the modified passages. Tables align, fence languages set, link text matches targets.
- README's "Architecture" ASCII flow diagram still accurately describes the data flow after the renames/additions and was left unchanged.

## Suggestions (non-defect improvements)
- README.md "Tests" section could link to `tests/` directly so contributors see the file list at a glance.
- CLAUDE.md could absorb a single-line pointer to `docs/reviews/` once review batches accumulate, so future agents discover prior reviews.
- The `scripts/` directory has its own `package.json` (separate from the root); README does not mention it. Worth a sentence in the Development section if the dev tooling there grows.

## Findings out-of-lane (for other units)
- Unit owning `js/main.js` (entry-point/init): `function autoLocate(isStartup = false)` (`js/main.js`, search for `autoLocate`) has no JSDoc — purpose, side effects on map, and `isStartup` semantics should be documented.
- Unit owning `js/markers.js`: several private helpers lack JSDoc — `bearingToStop` (line 53), `downstreamBearing` (line 65), `makeArrowSvgUrl` (line 156), `makeSquareSvgUrl` (line 165), `makeTerminusSvgUrl` (line 174), `isAtTerminus` (line 192), `markerSvgUrl` (line 215), `createNewMarker` (line 383), `updateExistingMarker` (line 484), `updateMarkerTimestamp` (line 729), `updatePopup` (line 737), `getVehicleEtaSecs` (line 752), `getBoardingDepSecs` (line 765), `animateMarker` (line 965). `computeHeading`, `isGpsSpike`, `processVehicleData`, `startBearingDeadReckoning`, `startDeadReckoning`, `initMarkerCleanup`, `restoreMarkerOpacity`, `applyOriginVisibility` already have full JSDoc.
- Unit owning `js/api.js`: `function processAndUpdate(data, map)` (line 44), `function _warnOnce(vid, msg)` (line 37), and `function drainPending(entries, map, start)` (line 203) lack JSDoc; `setupWebSocket` and `initVisibilityHandler` already have it.
- Unit owning `js/ui.js`: `export function cleanDestination(dest)` (top of file) has a description block but is missing `@param {string} dest` and `@returns {string}` tags; minor cleanup only.
- Unit owning `js/scheduleCalibration.js`: top-of-file private helpers (`loadState`, `saveState`, debounced writer) — verify they have at least a one-line description; sampled exports were well-covered.

## Inline fixes applied in this PR
- docs: align README data-files / scripts / WebSocket URLs with current code
- docs: refresh README test description and CI workflow names
- docs: bring CLAUDE.md test list and built-data list up to date

## Test impact
- npm test: pass (173/173, 12 files) before; pass after (no JS changes, only Markdown)
- New/changed tests: none
