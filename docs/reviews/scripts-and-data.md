# Review: Scripts & Data Pipeline

Reviewer: automated review batch 2026-05-06
Scope: scripts/build-shapes.js, scripts/audit-feeds.js, scripts/live-accuracy-harness.js, data/*.json (schema)

## Summary
The Node-side scripts are coherent and correctly produce the JSON shapes the runtime consumes (verified against js/snap.js, js/predictions.js cache builders, js/main.js loaders). audit-feeds.js and live-accuracy-harness.js are well-structured, with proper exit codes and reconnect logic. The main concerns are (a) a path-resolution inconsistency in build-shapes.js between input/output locations and the script's docstring, (b) unrelated dead code, and (c) a couple of minor numeric-parsing nits — none of which break the pipeline.

## Findings — Bugs (highest priority)
- [LOW] `BUS_ROUTES_OUT_FILE` write path is inconsistent with sibling outputs — scripts/build-shapes.js:23-25 — `OUT_FILE` and `TRIPS_OUT_FILE` resolve to `scripts/data/rail-shapes.json` and `scripts/data/trips.json` (under `__dirname`, which is `scripts/`), but `BUS_ROUTES_OUT_FILE` resolves to `<repo>/data/bus-routes.json` via `'..', 'data'`. The script's docstring says `Output: livemap-main/data/rail-shapes.json`, but with `__dirname` set to `scripts/`, `path.join(DIR, 'data', ...)` writes to `scripts/data/`, not `data/`. The committed JSONs live in `<repo>/data/`, so the script as written produces files in the wrong place unless the operator manually copies them, or unless the GTFS source files are placed in `scripts/data/rail_gtfs/`. Either the in/out paths should be normalized (e.g. `path.join(DIR, '..', 'data', ...)` for outputs that belong at repo root) or the docstring/README updated to clarify the expected layout.
  - Recommendation: Pick one: (1) write all three outputs to `<repo>/data/` using `'..', 'data'`, with sources in `scripts/data/rail_gtfs/` (gitignored); or (2) keep all three under `scripts/data/` and document a separate copy step. Currently the script is half-and-half.
  - Status: Recommended

- [LOW] `RAIL_NAME_MAP` has no entry for route `950` — scripts/build-shapes.js:32-36 — `RAIL_ROUTE_CODES` includes `'950'` but `RAIL_NAME_MAP` does not; `routeCodeFromId` only resolves `950` if its `route_id` is plain numeric or has the `950-` prefix. If Metro's GTFS ever uses a long-name form for the future Metro Micro/J Line variant, those trips would silently drop.
  - Recommendation: Either remove `950` from `RAIL_ROUTE_CODES` until it's actually represented in the source GTFS, or add the appropriate name entry. Document the assumption alongside.
  - Status: Recommended

## Findings — Math / Statistics
- [INFO] `percentile()` uses linear-interpolation on a pre-sorted array — scripts/audit-feeds.js:666-671 — Correct implementation; matches the textbook NIST type-7 estimator. No issue.
- [INFO] EWMA-feasibility gate-A/gate-B counts assume strict adjacency in `trip.stops[]` (`newIdx === prevIdx + 1`) — scripts/audit-feeds.js:308-313 — This will undercount legitimate 2-hop transitions (skip-stop service, missed message between adjacent updates). The "neither" bucket therefore conflates skip-stop and dropped messages. Consider widening to `newIdx > prevIdx && newIdx <= prevIdx + 3` with a separate counter, or document the strictness explicitly.
- [INFO] `live-accuracy-harness.js` records arrival timestamp from `v.timestamp` (the vehicle's reported clock), not the harness's wall clock — scripts/live-accuracy-harness.js:184 — This is the right choice (`v.timestamp` reflects actual arrival, not when the message reached us), but should be noted for downstream consumers; if a feed drifts, this propagates into `actualUnix` used as ground truth.

## Findings — Code Quality
- [LOW] Dead variable `const prev = state.vehicles.get(tripId)` — scripts/live-accuracy-harness.js:167 (pre-fix) — Captured but never read; the immediately following `state.vehicles.set(...)` overwrites unconditionally.
  - Recommendation: Remove.
  - Status: Fixed inline.
- [LOW] `parseInt(v.timestamp)` missing radix — scripts/live-accuracy-harness.js:164, scripts/audit-feeds.js:238 — Strict-mode safe but inconsistent with other `parseInt(..., 10)` calls in the same files.
  - Recommendation: Add `, 10` for consistency.
  - Status: Fixed inline.
- [INFO] `parseCSVLine` is correct for the GTFS dialect (handles quoted fields and `""` escapes) but does not handle embedded newlines inside a quoted field. GTFS feeds rarely include those; if Metro ever does, `readline` would prematurely split the row. Acceptable risk given current data.
- [INFO] `timeToSec()` accepts hours ≥ 24 (GTFS allows 24:35:00 for after-midnight trips) and produces correct seconds-since-noon-minus-12h-of-service-day; the `parseInt(parts[0] || 0, 10)` form mixes a `0` numeric default with `parseInt` — it works (`parseInt(0,10) === 0`) but is stylistically inconsistent with the rest of the file. Minor.

## Findings — Performance
- [INFO] `audit-feeds.js` `FieldTracker.observe` does `JSON.stringify(value)` for object values on every message and stores up to 200 distinct keys per field. With 4 feeds × ~200ms cadence × 60min, this is ~10⁵ ops per tracker — cheap. No issue.
- [INFO] `build-shapes.js` reads `stop_times.txt` (the largest GTFS file, hundreds of MB at full Metro scale) twice — once for rail (Pass A) and once for bus (Pass B, with a route-code filter). Each pass is a streaming line read, so memory is bounded; but elapsed time scales linearly with file size. A single pass routing rows by `routeFilter` would halve I/O. Optional optimization.
- [INFO] `tripsData[t].stops[seq - 1] = stopId` creates sparse arrays during ingestion, then a fill loop (line 327-332) compacts them. This works but allocates one V8 holey-array per trip. For 25k trips × 50 stops each, the GC cost is fine; just noting the pattern.

## Findings — Data Schema
- `data/trips.json` (3.8 MB): `{tripId: {dest, rc, dir, total, stops[], scheduledTimes[], isLast?}}` — matches `js/predictions.js:28` consumer (`{rc, dir, stops, scheduledTimes}`). `total === stops.length` invariant relied on by the line `if (trip.stops.length !== trip.scheduledTimes.length) continue;` is enforced by the build-time fill loop (build-shapes.js:327-332). OK.
- `data/stops.json` (~977 KB): `{stopId: {lat, lon, name}}` — consumed by `predictions.js:48` (`stop.lon, stop.lat`) and `markers.js`. OK.
- `data/rail-shapes.json` (~280 KB): `{routeCode: [[lat, lng], ...]}` — consumed by `js/snap.js:42`. OK; rail routes are the union of all shape points (deduped at 5-decimal precision); bus routes (901/910/950) are a single canonical (longest) shape in sequence order.
- `data/bus-routes.json` (~12 KB): `{routeCode: {short_name, long_name}}` — consumed in markers/popups. OK.
- `data/metro-micro-zones.json` (~21 KB): GeoJSON FeatureCollection. Note: file begins with a UTF-8 BOM (`﻿`). `JSON.parse()` on a string containing a BOM throws. Confirm consumer either fetches as JSON (browser auto-strips BOM in most fetch.json paths but not all) or strips it explicitly — recommend ensuring this is stripped at build time or in the consumer to avoid a future surprise.
- Schema drift watch: `tripsData[tripId].dir` is written as `Number(meta.dir)` in build-shapes.js:284, while the GTFS source contains string `"0"`/`"1"`. Consumer (`predictions.js:30`) treats it correctly (`dir == null` check uses loose equality). OK as long as the build pipeline is the only writer.

## Findings — Documentation / JSDoc
- [LOW] `build-shapes.js` header (line 7-8) says `Run: node build-shapes.js` and `Output: livemap-main/data/rail-shapes.json`, but the script must be run as `node scripts/build-shapes.js` (per `package.json`/CLAUDE.md), and outputs are split between `scripts/data/` and `data/` (see Bug #1). Update header to match reality.
- [INFO] `audit-feeds.js` header is excellent and captures the 2026-05-05 changes; serves as a model. No action.
- [INFO] `live-accuracy-harness.js` header clearly documents that calc-side blending is intentionally not run server-side and that calcEta is set to `null`. Good.

## Suggestions (non-defect improvements)
- Add a top-level `npm run build:shapes` script to package.json so the build entry-point is discoverable and the cwd / path layout is locked in.
- Consider exporting `evaluateThresholds()` from audit-feeds.js as an importable function so unit tests can exercise the threshold logic with synthetic feed-stat snapshots.
- The harness's `pending`/`arrived` Maps grow unbounded; for a 60-min run this is fine, but a comment noting maximum expected size (≈ vehicles × stops-per-trip ≈ a few thousand entries) would aid future review.
- `consoleTablePlus(summary.byHorizon)` is called only when `summary.meta.arrivals > 0` — consider also printing `byRoute` and `feedStats` so a human reading the terminal output can spot a single misbehaving feed without opening the JSON.

## Findings out-of-lane (for other units)
- Unit (predictions / runtime data loading): `data/metro-micro-zones.json` begins with a UTF-8 BOM — verify the consumer (likely js/microzones.js) tolerates it or strip during fetch.
- Unit (predictions): `predictions.js:35` enforces `trip.stops.length === trip.scheduledTimes.length` and silently `continue`s on mismatch. The build script's fill loop should make this invariant impossible to break, but a logged warn would surface real drift.
- Unit (markers): `markers.js:368-377` already has a D-1 staleness check that aligns with `audit-feeds.js`'s `tripIdInStatic` tracking — these two should reference the same threshold semantics in code comments.

## Inline fixes applied in this PR
- live-accuracy-harness.js: removed dead `const prev` capture in handleVp; added missing `, 10` radix to `parseInt(v.timestamp)`.
- audit-feeds.js: added missing `, 10` radix to `parseInt(v.timestamp)` for consistency.

## Test impact
- npm test: 173 passed before / 173 passed after.
- New/changed tests: none (scripts have no unit-test coverage by design).
