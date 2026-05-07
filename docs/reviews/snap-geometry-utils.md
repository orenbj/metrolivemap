# Review: Snap, Geometry, Utility Math

Reviewer: automated review batch 2026-05-06
Scope: js/snap.js, js/utils.js

## Summary
The geometry/snap pipeline is compact, correct, and well-suited to LA-latitude routes; the planar-metre approximation, segment projection, and inverse-arc lookup are all implemented cleanly. No bugs were found that affect production output. A handful of small documentation, robustness, and micro-perf observations are noted below.

## Findings — Bugs (highest priority)
- None observed.

## Findings — Math / Statistics
- [INFO] LA-latitude conversion factors are sound — js/utils.js:7-9 — `M_PER_DEG_LAT = 110540` is the global mean (varies 110567 m at equator → 111694 m at pole; at 34°N actual is ~110920 m, ~0.34% under). `M_PER_DEG_LNG_LA = 92630` matches `111195 × cos(33.6°) ≈ 92627`, i.e. the mean Earth-radius value at LA's central latitude. Both are well within snap-accuracy tolerance for the LA Metro service area (~33.7°–34.4°N, max error ≪ 1 m at typical offsets).
  - Recommendation: Add a one-line comment in utils.js noting the latitude band assumption (e.g. "calibrated for 33.5°–34.4°N; degrades >0.5% above 35°N").
  - Status: Recommended.
- [INFO] Spherical bearing formula in `computeBearing` (utils.js:30-35) is the standard initial-bearing formula and is correct. At zero-displacement (coincident points) `atan2(0, 0)` returns 0, which is benign because callers (snap.js:111-114) gate the call behind a ≥1 m degenerate-window guard.
  - Recommendation: None — current guard is sufficient.
  - Status: Recommended (no action).
- [INFO] Float64 cumulative arc-length accumulation (snap.js:24-30) is numerically safe at LA-rail scale. Even a 1000 km polyline at ~50 m segments yields cumulative error ≪ 1 µm given Float64's 15–17 significant digits. No Kahan summation needed.
  - Recommendation: None.
  - Status: Recommended (no action).
- [LOW] `lngLatAtArc` defends against single-point shape arrays only via the upstream filter in `loadShapes` (`pts?.length > 1`) — direct callers of `precomputeRoute` (e.g. tests, future code) could install a single-point shape, after which `lngLatAtArc` would dereference `pts[1]` at snap.js:139 and crash.
  - Recommendation: Add `if (pts.length < 2) return null;` near snap.js:134 alongside the existing nullish guard. (Not applied inline — out of scope for "obvious bug fix" since it is unreachable in production.)
  - Status: Recommended.

## Findings — Code Quality
- [INFO] Exports `shapeData` / `arcLengths` are public only because the unit tests in tests/snap.test.js import them directly to seed fixtures. Acceptable trade-off; alternative would be a `_test_setShape()` helper.
  - Status: Recommended (no action).
- [INFO] `precomputeRoute` recomputes a per-segment `planarMeters` that is later recomputed inside `snapToRoute` (snap.js:97) when materialising `arcMeters`. The duplication is negligible (one segment per snap call) and keeps the API simple.
  - Status: Recommended (no action).
- [LOW] In `snapToRoute` the local variable `bestDist` stores a *squared* distance — naming is slightly misleading.
  - Recommendation: Rename to `_bestDistSq` (matches underscore-prefix convention in CLAUDE memory).
  - Status: Recommended.

## Findings — Performance
- [INFO] `snapToRoute` is O(n) over polyline length per VP fix, as documented. No upstream memoisation is needed because the caller passes a fresh GPS coord each fix. The inner loop is tight (no allocations, no function calls except final `planarMeters` for arc-meters).
  - Status: Recommended (no action).
- [LOW] `loadShapes` parses the entire `rail-shapes.json` on every call before checking the in-flight promise. Current implementation already returns the cached promise, so there is no double-parse. No action.
  - Status: Recommended (no action).

## Findings — Security / Privacy
- None — both files are pure client-side math/strings with no I/O beyond a static fetch and no untrusted-data sinks. `escHtml` (utils.js:125-133) correctly escapes the five canonical HTML metacharacters.

## Findings — Documentation / JSDoc
- [LOW] `snapToRoute` (snap.js:65-69) and `lngLatAtArc` (snap.js:126-130) describe their return values in prose only. Adding a `@returns {{snappedLng:number, snappedLat:number, arcIndex:number, arcMeters:number, tangentForward:?number, endpointTangent:boolean}|null}` JSDoc would surface the shape to editors.
  - Recommendation: Add typedef-style `@returns` to both functions.
  - Status: Recommended.
- [LOW] `M_PER_DEG_LNG_LA` lacks an explicit latitude band annotation in its JSDoc.
  - Recommendation: Note "≈ cos(33.6°) × 111195 m" inline.
  - Status: Recommended.
- [LOW] `setVisibleInterval` (utils.js:93-97) does not return a handle, so the registered interval cannot be cancelled by the caller. Non-defect for current use (singleton-style timers) but worth a JSDoc note.
  - Recommendation: Document that the interval lives for the lifetime of the page.
  - Status: Recommended.

## Suggestions (non-defect improvements)
- [LOW] Consider extracting the planar-metre projection (snap.js:79-92) into an exported helper `projectOntoSegment(lat, lng, ay, ax, by, bx)` — reusable for any per-segment geometry that grows up later (stop-radius checks, microzone lookups).
- [LOW] Consider a `Float32Array` variant of `arcLengths` for very long bus polylines if memory ever matters; Float64 is fine for current rail data and the precision is worth keeping.

## Findings out-of-lane (for other units)
- None observed in this scope.

## Inline fixes applied in this PR
- None. All findings are low-severity documentation or defensive-guard suggestions; per the brief, inline fixes are reserved for obvious bugs or zero-risk single-file edits, and the only candidate (the `lngLatAtArc` single-point guard) is unreachable given the loader filter.

## Test impact
- npm test: 173 passed before review; 173 passed after review (no code changes).
- New/changed tests: none.
