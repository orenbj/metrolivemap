# Review: Config Constants Audit

Reviewer: automated review batch 2026-05-06
Scope: js/config.js

## Summary
The file exports 48 symbols (45 scalar/string constants + 3 route-metadata maps). One dead export was found and removed inline (`BIKESHARE_COLOR`). All remaining 47 symbols have at least one consumer in `js/**`. A handful of low-severity code-quality and documentation issues are flagged below; no value tunings recommended (out of scope for this review).

## Findings — Bugs (highest priority)
- None.

## Findings — Math / Statistics
- [LOW] Three "max speed" constants live in different domains and could confuse a reader — `MAX_PLAUSIBLE_SPEED_MPS=50` (ingestion clamp), `RAIL_MAX_SPEED_MPS=27` (rail arc spike gate), `ETA_MAX_SPEED_MPS=30` (ETA plausibility) — js/config.js:17, 39, 69 — Each has a distinct purpose and current values are defensible (ingestion clamp generous, rail-only tighter, ETA between).
  - Recommendation: Add a brief comment cross-referencing the other two so future maintainers don't conflate them.
  - Status: Recommended
- [INFO] `RAIL_SNAP_MAX_M=150` and `FINAL_STOP_HOLD_M=150` happen to share a value but are independent — js/config.js:21, 27 — Coincidence, not coupling. No action.

## Findings — Code Quality
- [LOW] Dead export `BIKESHARE_COLOR='#00a651'` — js/config.js:126 (pre-fix) — Zero consumers across `js/**`, `*.css`, `*.html`. `js/bikeshare.js` defines its own pie-segment color constants (`C_EBIKE`, `C_BIKE`, `C_DOCK`) and never imports this.
  - Recommendation: Remove.
  - Status: Fixed inline
- [LOW] Inconsistent numeric-separator style — js/config.js:105 vs 123 — `WS_MAX_RECONNECT_MS = 300000` (no separator) vs `ALERTS_POLL_MS = 120_000` (separator). Cosmetic.
  - Recommendation: Pick one style across the file.
  - Status: Recommended
- [LOW] `BIKESHARE_POLL_MS = 30000` lacks unit-separator that the section above uses — js/config.js:127.
  - Recommendation: `30_000` for consistency once the above is normalized.
  - Status: Recommended

## Findings — Performance
- None.

## Findings — Documentation / JSDoc
- [LOW] `STATIONARY_SPEED_MPS=0.5` has no rationale — js/config.js:15 — Comment says the threshold exists but not why 0.5 m/s (~1.1 mph) was chosen.
  - Recommendation: Add a one-liner ("below ~1 mph treats vehicle as stopped to avoid GPS-noise heading flips").
  - Status: Recommended
- [LOW] `GPS_SPIKE_STOP_RADIUS_M=5000` — comment describes mechanic but not why 5 km — js/config.js:34.
  - Recommendation: Note this is roughly the largest inter-station spacing on the rail network, so a fix close to the next stop is plausibly real even after a feed gap.
  - Status: Recommended
- [LOW] `GPS_SPIKE_MIN_DIST_M=200` lacks rationale — js/config.js:36.
  - Recommendation: Note this is comparable to `RAIL_SNAP_MAX_M` (150) plus headroom, so sub-snap-noise displacements bypass the spike check.
  - Status: Recommended
- [LOW] `DR_SPEED_FACTOR=0.75` has the *why* but not the *how was 0.75 chosen* — js/config.js:46.
  - Recommendation: Note empirical tuning origin if known.
  - Status: Recommended
- [LOW] `WS_BASE_RECONNECT_MS=5000` has no comment of its own (only `WS_MAX_RECONNECT_MS`'s comment refers to it indirectly) — js/config.js:104.
  - Recommendation: One-liner.
  - Status: Recommended
- [LOW] `STATION_MERGE_RADIUS_M=300` — js/config.js:98 — Has a what but not a why. 300 m equals roughly 1 city block; consider noting that.
  - Status: Recommended
- [LOW] Section "Viewport / zoom breakpoints" has the rule "Above TABLET initial zoom = 10" embedded as a trailing comment — js/config.js:110 — but no constant exists for the three zoom values (8/9/10). They are presumably referenced as magic numbers in `js/map.js`.
  - Recommendation: Either add `INITIAL_ZOOM_MOBILE/_TABLET/_DESKTOP` constants, or add a JSDoc tag to make the existing comment more discoverable.
  - Status: Recommended (see also Findings out-of-lane)
- [LOW] Service-Alerts URLs are described as "undocumented but stable" — js/config.js:120 — A nice note, but consider linking the actual `alerts.metro.net` page they back, or noting last-verified date.
  - Status: Recommended

## Suggestions (non-defect improvements)
- Group the two unit suffixes the file uses (`_S`, `_SEC`, `_MS`, `_M`, `_MPS`, `_MPS2`, `_DEG`, `_PX`) — they're consistent, but a one-line table at the top of the file or in README would aid readability.
- Consider exporting a single frozen object (e.g. `CONFIG = Object.freeze({...})`) for the route-metadata maps so consumers can't accidentally mutate them. Low value, no defect.
- The "Viewport / zoom breakpoints" section uses `_BREAKPOINT_` for px widths but has no parallel constant for the resulting zoom level — encoding 8/9/10 as constants would close that loop.

## Constants table
| Constant | Value | Units | Consumers (count) | Notes |
|---|---|---|---|---|
| STALE_THRESHOLD_SEC | 300 | s | 5 | OK |
| STALE_CHECK_INTERVAL_MS | 5000 | ms | 3 | OK |
| STALE_FADE_START_SEC | 60 | s | 7 | OK |
| STALE_REF_SEC | 120 | s | 3 | OK |
| STATIONARY_SPEED_MPS | 0.5 | m/s | 6 | rationale comment thin |
| MAX_PLAUSIBLE_SPEED_MPS | 50 | m/s | 2 | one of three "max speed" constants |
| GPS_NOISE_FLOOR_DEG | 0.0001 | deg | 2 | OK |
| FINAL_STOP_HOLD_M | 150 | m | 2 | shares value with RAIL_SNAP_MAX_M |
| DOWNSTREAM_MIN_METERS | 20 | m | 2 | OK; suffix `_METERS` differs from `_M` elsewhere |
| RAIL_SNAP_MAX_M | 150 | m | 2 | OK |
| BUS_SNAP_MAX_M | 75 | m | 2 | OK |
| GPS_SPIKE_STOP_RADIUS_M | 5000 | m | 3 | rationale comment thin |
| GPS_SPIKE_MIN_DIST_M | 200 | m | 2 | rationale comment thin |
| RAIL_MAX_SPEED_MPS | 27 | m/s | 2 | OK |
| RAIL_ARC_SPIKE_NOISE_M | 500 | m | 2 | OK |
| DR_SPEED_FACTOR | 0.75 | ratio | 4 | unitless; OK |
| DR_MAX_SECONDS | 20 | s | 6 | OK; name uses `SECONDS` not `_S` |
| DR_SPEED_ALPHA | 0.4 | ratio | 2 | OK |
| DR_DECEL_ZONE_M | 150 | m | 6 | OK |
| DR_DECEL_RATE_MPS2 | 1.0 | m/s² | 4 | OK |
| TERMINUS_TURNAROUND_RADIUS_M | 1000 | m | 2 | OK |
| VEHICLE_MARKER_TTL_S | 180 | s | 4 | OK |
| ETA_MAX_SPEED_MPS | 30 | m/s | 2 | OK |
| ADHERENCE_TAPER_K | 0.35 | ratio | 3 | OK; tuning history documented |
| ETA_PLAUSIBILITY_GRACE_S | 45 | s | 2 | OK |
| ETA_DEPARTURE_LAG_S | 15 | s | 5 | OK; tuning history documented |
| GTFS_ENTRY_STALENESS_S | 90 | s | 7 | OK |
| ETA_INTERMEDIATE_DWELL_S | 40 | s | 2 | OK; tuning history documented |
| ETA_INTERMEDIATE_DWELL_BUS_S | 45 | s | 2 | OK; tuning history documented |
| STATION_MERGE_RADIUS_M | 300 | m | 5 | rationale comment thin |
| STATION_POPUP_REFRESH_MS | 5000 | ms | 4 | OK |
| WS_BASE_RECONNECT_MS | 5000 | ms | 4 | rationale comment thin |
| WS_MAX_RECONNECT_MS | 300000 | ms | 4 | numeric-separator inconsistent |
| VIEWPORT_BREAKPOINT_MOBILE | 768 | px | 2 | OK |
| VIEWPORT_BREAKPOINT_TABLET | 1280 | px | 2 | OK |
| VEHICLE_ZOOM_MIN | 9 | zoom | 4 | OK |
| VEHICLE_ZOOM_MAX | 14 | zoom | 3 | OK |
| VEHICLE_SIZE_MIN_PX | 15 | px | 4 | OK |
| VEHICLE_SIZE_MAX_PX | 38 | px | 3 | OK |
| RAIL_ALERTS_URL | (URL) | — | 2 | OK |
| BUS_ALERTS_URL | (URL) | — | 2 | OK |
| ALERTS_POLL_MS | 120_000 | ms | 3 | OK |
| ~~BIKESHARE_COLOR~~ | ~~'#00a651'~~ | — | 0 | **DEAD — removed inline** |
| BIKESHARE_POLL_MS | 30000 | ms | 3 | numeric-separator inconsistent |
| GBFS_INFO_URL | (URL) | — | 2 | OK |
| GBFS_STATUS_URL | (URL) | — | 2 | OK |
| routeIcons | (map) | — | 4 | OK |
| routeDirectionLabels | (map) | — | 2 | OK |
| routeHexColors | (map) | — | 9 | OK |

## Findings out-of-lane (for other units)
- Unit (markers): `TRIP_COVERAGE_CHECK_INTERVAL_MS = 300_000` is a private module-level constant — js/markers.js:300 — consider promoting to `js/config.js` for consistency with all other tunable intervals.
- Unit (map / viewport): the three initial-zoom values (8/9/10) implied by the comment at js/config.js:110 likely live as magic numbers in `js/map.js`. Either promote them to `INITIAL_ZOOM_*` constants or document where they're set.
- Unit (api / tripUpdates): WebSocket `pingInterval` durations at js/api.js:131 and js/tripUpdates.js:49 are magic numbers — candidates for promotion to `WS_PING_INTERVAL_MS` in `js/config.js`.
- Unit (naming): `DOWNSTREAM_MIN_METERS` (config.js:23) uses suffix `_METERS`; the rest of the file uses `_M`. Consistency would help.
- Unit (naming): `DR_MAX_SECONDS` (config.js:48) uses `_SECONDS`; the rest of the file uses `_S` or `_SEC`. Consistency would help.

## Inline fixes applied in this PR
- Remove dead export `BIKESHARE_COLOR` from `js/config.js` (zero consumers across `js/**`, CSS, HTML; `js/bikeshare.js` uses its own local color constants).

## Test impact
- npm test: pass before, pass after (173 tests; no test imports `BIKESHARE_COLOR`).
- New/changed tests: none.
