# Review: Test Coverage, Fixtures, Diagnostics

Reviewer: automated review batch 2026-05-06
Scope: tests/**, tests/_lib/accuracy-aggregator.js

## Summary
12 test files / 173 passing tests (spec said 174 — 1-test discrepancy worth confirming). Coverage of math-heavy modules (predictions, snap, scheduleCalibration, markers DR/spike/heading, tripUpdates, api) is solid; 9 of 15 `js/` modules have **no** test file at all (alerts, bikeshare, config, main, map, microzones, stations, ui, utils). Live harness `tests/eta-live-accuracy.js` cleanly tracks `calcEta` and `gtfsEta` separately — no residual blended-ETA fields — but the production blend logic still lives in `js/predictions.js` (lines 330–393), so the harness intentionally measures pre-blend signals.

## Findings — Bugs (highest priority)

- [HIGH] `median` field is computed from absolute values, contradicting JSDoc — `tests/_lib/accuracy-aggregator.js:31` — `const med = median(sortedAbs);` while the JSDoc on `stats()` (line 25) says “n / mean / median use signed values”. The reported `median` is therefore `median(|error|)`, not the median signed error. Downstream consumers comparing `mean` vs `median` to detect skew are misled (mean is signed, median is unsigned absolute).
  - Recommendation: change to `const med = median(sortedSigned);` to match the documented contract, OR rename the field to `medianAbs` and update the JSDoc. The existing `p50` field already gives the signed median, which is why the two diverge silently today.
  - Status: Recommended

- [MEDIUM] Percentile selection biases high at the tails for small n — `tests/_lib/accuracy-aggregator.js:42-44` — `sortedSigned[Math.floor(0.10 * n)]` returns `arr[0]` for n<10 and returns `arr[n-1]` (the maximum) when `0.90*n` rounds down to `n-1`, e.g. n=10 → p90 = arr[9] = max. Same pattern for p10. With the live harness routinely producing tens-to-hundreds of snapshots per bucket this is mostly cosmetic, but for small horizon buckets (10–15 min, 15+ min) where n can be <10, p10/p90 often equal the min/max and are not meaningful.
  - Recommendation: switch to nearest-rank with `Math.floor((n - 1) * p)` for stable indexing, or proper linear interpolation (`p * (n - 1)` then lerp the two flanking samples). Add a guard so p10/p50/p90 are reported as `null` when `n < MIN_PCTL_N` (e.g. 5) rather than degenerating to extremes.
  - Status: Recommended

- [LOW] `tests/_helpers/diagnostics.js:18` `statsOf` has the same percentile bug (`Math.floor(p * n)`) — used by DR and spike-rejection diagnostic tables. Same fix applies.
  - Recommendation: extract a single `pctl(sorted, p)` helper in `_lib/` and reuse from both `accuracy-aggregator.js` and `_helpers/diagnostics.js`.
  - Status: Recommended

## Findings — Math / Statistics

- **MAE / RMSE definitions correct.** `mae = mean(|e|)` and `rmse = sqrt(mean(e²))` — both correct (line 29-30). One redundancy worth noting: line 30 sorts the values into `sortedAbs` and then squares them, but RMSE doesn’t need a sort. Cosmetic only — not a defect.
- **Sign convention** is documented at `flattenSnapshots()` (lines 53-55) and at the top of `eta-live-accuracy.js` (lines 23-25). Consistent: `error = actual - predicted`, negative = arrived earlier than predicted.
- **`median` vs `p50`** — they SHOULD be the same. Today they aren’t, because `median` is computed on `sortedAbs` and `p50` on `sortedSigned` (see HIGH bug above). After the fix they will match.
- **Zero-input handling** — `stats(values)` returns `null` on `n=0` (line 25). `n=1` works but degenerates: mean = median = p10 = p50 = p90 = the single value. Not crashy, but reported numbers are noise. Recommend a `MIN_N` gate at the call sites in the harness rather than inside `stats()`.
- **Sample-size handling in `consoleTablePlus`** — guards against empty `entries` and missing `keys`. Fine.

## Findings — Code Quality

- [LOW] `tests/spike-rejection.test.js:23` had `closeStationPopup: vi.fn()` inside the `js/ui.js` mock — `closeStationPopup` is exported from `js/stations.js`, not `js/ui.js`. The entry in the ui.js mock was dead. Fixed inline.
- [LOW] `tests/_helpers/globals.js:32-36` `addArrival` mutates `window.masterArrivalsData` directly. Two callers (`prediction-blend`, `boarding-vehicles`) rely on it. Works, but `installGlobals()` is the canonical reset path; consider moving `addArrival` next to `installGlobals` in the same module section with a JSDoc note that it must be called *after* `installGlobals()`.
- [LOW] `_seenFeatures` array module-scoped in `tests/api.test.js:5` — reset in `beforeEach` (line 24). Fine, but a closure-over-mock pattern would localize state per `describe` block more cleanly.
- [LOW] `tests/eta-live-accuracy.js:417-433` `calcByBucket()` and `tests/eta-live-accuracy.js:242-250` reportSection both inline duplicate `buckets` arrays. Should import `DEFAULT_BUCKETS` from `_lib/accuracy-aggregator.js` (already exported).

## Findings — Performance

- [LOW] `tests/_lib/accuracy-aggregator.js:30` RMSE recomputes `e * e` after sorting — sorting is wasted work for RMSE. Trivial cost; ignore unless profiling shows it.
- [LOW] `tests/_lib/accuracy-aggregator.js:107-112` `bucketResults()` calls `flat.filter()` once per bucket × per (calc, gtfs) — O(buckets × n). For typical n<1000 not a concern, but a single-pass bucket-bin loop would be cleaner.

## Findings — Coverage Gaps

(Prioritized by regression-risk = recent churn × user-visibility.)

- **`js/markers.js` is largely covered** by `dr-animation`, `spike-rejection`, `marker-lifecycle`, and `heading` — already strong. No gap.
- **`js/ui.js`** — uncovered. Highest-value test: `getPopupHTML()` snapshot for a known marker fixture, to catch regressions in popup field rendering (route, headsign, ETA, vehicle label) — a common visible breakage class. Also `cleanDestination()` for headsign normalization (off-by-one whitespace fixes have shipped here historically).
- **`js/stations.js`** — uncovered, large module. Highest-value test: `getArrivalBreakdown` was just refactored with terminus boarding badges (per memory `terminus_boarding_badges`); a snapshot test of the badge data structure for a terminus-stop fixture would catch the “origin marker hidden but boarding badge missing” regression class.
- **`js/microzones.js`** — uncovered. Highest-value test: zone-membership lookup for a known lng/lat fixture — catches polygon-data drift on rebuilds.
- **`js/utils.js`** — uncovered. Highest-value test: `haversine()` and any time-formatting helpers used in popups; a 2-3 case parameterized test would prevent silent unit regressions.
- **`js/alerts.js`** — uncovered. Highest-value test: alert-filtering by route/severity, since alerts are user-visible and feeds change shape occasionally.
- **`js/bikeshare.js`** — uncovered. Highest-value test: feed-shape parser for the bikeshare GBFS endpoints — fixture-based, catches API-shape drift.
- **`js/config.js`** — pure constants; testing it directly is low-value. Acceptable gap.
- **`js/main.js`** — entry-point glue; integration test territory, low ROI for unit tests. Acceptable gap.
- **`js/map.js`** — MapLibre wiring; mostly side-effectful and hard to unit test. Consider a smoke test that asserts `initMap()` registers expected layers, to catch broken style references.

## Findings — Documentation / JSDoc

- `tests/_lib/accuracy-aggregator.js` has solid JSDoc at the file and function level. The `stats()` JSDoc (line 22-26) is the only stale piece — it mis-describes what `median` actually returns (see HIGH bug).
- `tests/_fixtures/trips.js` and `tests/_fixtures/markers.js` are well-documented fixture factories.
- `tests/eta-live-accuracy.js` has a strong header comment block (lines 3-25) that doubles as a changelog. Worth keeping that pattern.
- Test-file headers vary in depth: `predictions.test.js` and `snap.test.js` have no top-level intent comment; the others do. Cheap consistency win.

## Suggestions (non-defect improvements)

- Extract `pctl()` and a shared `MIN_N_FOR_PCTL` to `tests/_lib/stats.js` so `accuracy-aggregator.js` and `_helpers/diagnostics.js` use the same helpers — avoids the “fix in two places” hazard for the percentile bug above.
- Add a Vitest `coverage` config (c8) so coverage gaps surface in CI. Even at 50% threshold this would have flagged the 9 untested modules.
- The `eta-live-accuracy.js` browser harness is structurally similar to `scripts/live-accuracy-harness.js` (Node). The aggregator was already factored — consider moving the bucket / route / per-line / convergence reporters out of the browser harness and into `_lib/` too, so the Node harness gets the same tables for free.
- `prediction-blend.test.js` is the largest test file (285 lines) and tests behavior that is currently in production but flagged as “to be removed” by your spec — once that refactor lands, this whole file can be deleted or pivoted to test the new logic.

## Findings out-of-lane (for other units)

- Unit (predictions / blend): `js/predictions.js:330-393` still implements the horizon-adaptive blend (Tier 1), even though the live harness was refactored to no longer measure a blended ETA. Confirm whether the blend is intended to remain in production but be measured upstream-only by the harness — or whether removal is pending.
- Unit (predictions / blend): `js/predictions.js:346` `calcEtaForBlend = atOrigin ? null : calcEta` — the “null calc at origin” suppression is documented in `prediction-blend.test.js` but not in `js/predictions.js` JSDoc; flagging for the predictions reviewer.
- Unit (live harness ops): `tests/eta-live-accuracy.js:45` reads `window.__etaTestTargetStops` — undocumented runtime knob. Consider documenting in README or a `docs/eta-harness.md`.

## Inline fixes applied in this PR

- Removed dead `closeStationPopup: vi.fn()` from the `js/ui.js` mock in `tests/spike-rejection.test.js` (export lives in `js/stations.js`, which is already mocked separately on the next line).

## Test impact

- npm test before review: 173 passed (12 files)
- npm test after inline fix: expected 173 passed (no behavior change)
- New/changed tests: none (per spec — recommendations only)
