# Deferred recommendations — math/logic audit

**Source:** Three-agent deep audit, 2026-05-10. See conversation transcript for full
findings. This file tracks items that were intentionally **not** addressed yet
so they don't get lost.

## Shipped — initial round

1. Stale "positive = early" docstring removed from `computeTripAdherenceOffset` ([predictions.js](../js/predictions.js)).
2. Implicit constant coupling between blend horizons / replay-guard / disagreement thresholds documented inline ([config.js](../js/config.js)).
3. `arcSign` Path-3 fallback defaults to forward when both `Heading` and `tangentForward` are null (eliminates a NaN → -1 silent regression) ([markers.js](../js/markers.js)).
4. Comment on shared alert-entry object across `masterAlertsData` / `masterStopAlertsData` ([alerts.js](../js/alerts.js)).

## Shipped — follow-up rounds

5. **J Line 950 empty rail-shapes.json fixed** ([scripts/build-shapes.cjs](../scripts/build-shapes.cjs)) — two-part fix: (a) `shapeToRoute` changed to `Set`-based to survive shared `shape_id` values, (b) Pass 2 now registers every J Line shape under both `910` and `950` because Metro GTFS publishes the entire J Line under a single `route_id` (`910-13196`) with no 950-specific shape entries. `build-shapes.cjs` now auto-downloads the latest Metro GTFS when source files are absent. A weekly CI job (`.github/workflows/rebuild-gtfs.yml`) regenerates and PRs the data files automatically. Verified 2026-05-10: `rail-shapes.json[950]` = 1186 pts.
6. **`_elapsedWithLag` helper** ([predictions.js](../js/predictions.js)) — single source of truth for the `(now - statusChangedAt) + ETA_DEPARTURE_LAG_S` arithmetic; both call sites refactored.
7. **Boundary tests for blend + EWMA** ([tests/blend-boundaries.test.js](../tests/blend-boundaries.test.js)) — pins horizon-band boundaries (60s, 300s), disagreement decay (60s, 180s), stale-replay guard at 299/300, EWMA convergence + warmup gate. 14 new cases.
8. **`MAX_ADHERENCE_OFFSET_S = 600` provenance comment** ([predictions.js](../js/predictions.js)).
9. **`getBoardingVehicles` Tier-1/2 staleness asymmetry documented** ([predictions.js](../js/predictions.js)) — the 180 s vs 90 s gap is the layover-bridge feature, not a bug.
10. **`M_PER_DEG_LNG_LA` calibration verified + documented** ([utils.js](../js/utils.js)) — 92,630 corresponds to ~33.68 °N, not 34 °N as the prior comment claimed; bias is conservative across the service area.
11. **Cross-references between `STATION_MERGE_RADIUS_M = 300` and bikeshare `MERGE_RADIUS_M = 50`** ([config.js](../js/config.js), [bikeshare.js](../js/bikeshare.js)) — different scales are intentional.
12. **Bikeshare hover-delay constants explained** ([config.js](../js/config.js)) — 180/200 ms vs the 250 ms research threshold for deliberate hover.
13. **Continuous DR loop — kill the unison pulse** ([markers.js](../js/markers.js)) — `startDeadReckoning` is an idempotent param-refresh; `_arcTick` reads speed, arc-cap, and direction fresh each frame. No rAF cancel/restart on WS update → no synchronized position snap across the whole feed batch. Bearing-DR for buses retired in PR #226 — bus markers now use the per-WS-frame `animateMarker` glide instead.
14. **Speed glide (τ = 0.5 s)** ([markers.js](../js/markers.js), [config.js](../js/config.js)) — `_drTargetSpeed` is the WS-updated truth; `_drSpeed` lerps toward it with `1 − exp(−dt / τ)` each frame. Velocity transitions ramp over ~1.5 s instead of stepping in one frame.
15. **`prefers-reduced-motion` gate removed from DR** ([markers.js](../js/markers.js)) — vehicle motion is functional (mirrors a moving bus/train), not decorative. The gate caused instant GPS teleports for users with the OS accessibility setting on. Map zoom/pan remains MapLibre's responsibility.
16. **Unified per-vehicle freshness tiers** ([markers.js](../js/markers.js), [config.js](../js/config.js), [ui.js](../js/ui.js), [styles/index-style.css](../styles/index-style.css)) — replaced the two-clock `marker.timestamp` / `marker._lastFreshTs` model and 4 overlapping constants (`STALE_FADE_START_SEC` 60s, `STALE_LIVE_WINDOW_S` 45s, `STALE_THRESHOLD_SEC` 300s, `STALE_CHECK_INTERVAL_MS`) with one pure tier function `getFreshnessTier(marker, nowSec) → 'live' | 'aging' | 'stale' | 'expired'`. Tiers map to (opacity, popup-dot color, `data-stale` attr): live → 1.0/green, aging → 0.75/amber, stale → 0.5/gray, expired → fade-out & remove. New constants `FRESH_LIVE_S=30`, `FRESH_AGING_S=90`, `FRESH_EXPIRE_S=300`. The 60s un-fade gate (`STALE_LIVE_WINDOW_S`) was deleted — it was the root cause of vehicles fading before the documented 60s threshold under typical Metro feed lag. Spike-rejection's separate `SPIKE_BYPASS_S=120` (renamed from `STALE_REF_SEC`) and predictions' `VEHICLE_MARKER_TTL_S=180` are unchanged — algorithmic gates, not visual.

## Investigated — found to be a non-issue

- ~~**Alert dedup loses route context for J Line 910/950**~~ — false alarm. `stations.js` already pre-filters alerts by `routeId` at line 576 before the effect-based dedup, and `alerts.js` correctly fans out each alert only to the routes its `informedEntities` actually mention. A 950-only DETOUR is stored only under 950 and only collapses with other 950 alerts.

---

## Still deferred — by area

### Predictions / blend / adherence

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| Test trip spanning midnight | MED | [predictions.js getScheduledArrivals](../js/predictions.js) | `Math.floor(Date.now()/1000)` rolls fine; needs Date mocking in jsdom which is fragile. Skip until owl-service ETA is observed in the wild as a defect. |
| Test single-stop trip and `targetIdx - nextIdx - 1 = -1` path | LOW | [predictions.js](../js/predictions.js) | `max(0, …)` already guards. Add only if a single-stop route enters service. |
| Test `localStorage.QuotaExceededError` handling | MED | [scheduleCalibration.js](../js/scheduleCalibration.js) | Catch-all swallow exists. Mocking `localStorage.setItem` to throw is fragile across vitest/jsdom versions. |

### Markers / kinematic / snap / heading

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| Heading wrap-around test at exact 0°/360° | LOW | [tests/heading.test.js](../tests/heading.test.js) | Modulo math is correct; cardinal tests already pass through the boundary. Low value. |
| Terminus-turnaround distance sanity cap | LOW | [markers.js](../js/markers.js) | Real code change with subtle risk. Mitigated by next-fix arc gate (brief artifacts only). |

| Reverse-direction (southbound) DR test | MED | [tests/dr-animation.test.js](../tests/dr-animation.test.js) | `arcSign = -1` path is not exercised. Worth adding next time the DR animation surface is touched. |
| Pin `DR_SPEED_FACTOR = 0.75` regression test | MED | [tests/dr-animation.test.js](../tests/dr-animation.test.js) | Current ±50 % tolerance lets the factor drift. The headless live-accuracy harness is the better signal here — drift would show up in the byHorizon MAE. |
| `_heavyRailScheduleSpeed` integration test with real B/D trip | LOW | [markers.js](../js/markers.js) | Defensive code is there; only synthetic data tests it. Needs a real-world fixture. |

### Stations / boarding / alerts

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| `cleanStationName` regex fragility | MED | [utils.js](../js/utils.js) | Schema changes would silently break station merging. Add a corpus test against the actual `data/stops.json` names. |
| Multi-stop alert spanning 3+ routes test | MED | [tests/alerts.test.js](../tests/alerts.test.js) | Fan-out behavior. Worth adding next time alerts.js is touched. |
| Two overlapping alerts on same route+effect test | MED | [tests/alerts.test.js](../tests/alerts.test.js) | Dedup by id only — overlapping non-id-equal alerts may both render. |
| Boarding at terminus when only one trip in service | LOW | [tests/boarding-vehicles.test.js](../tests/boarding-vehicles.test.js) | Terminus-also-origin case for reverse direction. |
| Display name selection on merge is iteration-order-dependent | LOW | [stations.js](../js/stations.js) | First-registered wins; deterministic in modern JS. Document only if the order ever flips visibly. |

### Cross-cutting

| Item | Severity | Notes |
|------|----------|-------|
| `ETA_INTERMEDIATE_DWELL_S = 40` (rail) vs `_BUS_S = 45` (bus) rationale | LOW | Both have audit-trail comments but the 5 s differential between modes isn't justified relative to measured dwell distributions. The headless harness will eventually surface whether the gap is right. |

---

## Use the headless harness to validate before retuning

The headless harness writes a four-way summary (calc / gtfs-rt / blend /
trajectory) per horizon bucket and per route. The GH Actions workflow runs
twice on weekdays (peak + off-peak) and four times on weekends — see
[STATUS.md](./STATUS.md) for the cron schedule. To validate a constant
change locally:

```bash
npm run test:live:headless -- --duration=15m --tag=before-change
# make the change
npm run test:live:headless -- --duration=15m --tag=after-change
# diff the summary.json files in scripts/
```

Or trigger the workflow manually via `workflow_dispatch` with a custom `tag`.
Artifacts are retained 90 days (bumped from 30 in PR #173 to cover the
full Phase 8 A/B validation window).
