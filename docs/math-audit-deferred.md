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

5. **J Line 950 empty rail-shapes.json fixed** ([scripts/build-shapes.cjs](../scripts/build-shapes.cjs)) — root cause was last-write-wins in `shapeToRoute`. Fixed; pinned by [tests/build-shapes.test.js](../tests/build-shapes.test.js). **User action: rerun `node scripts/build-shapes.cjs` against fresh GTFS to regenerate `data/rail-shapes.json` and `data/trips.json`.**
6. **`_elapsedWithLag` helper** ([predictions.js](../js/predictions.js)) — single source of truth for the `(now - statusChangedAt) + ETA_DEPARTURE_LAG_S` arithmetic; both call sites refactored.
7. **Boundary tests for blend + EWMA** ([tests/blend-boundaries.test.js](../tests/blend-boundaries.test.js)) — pins horizon-band boundaries (60s, 300s), disagreement decay (60s, 180s), stale-replay guard at 299/300, EWMA convergence + warmup gate. 14 new cases.
8. **`MAX_ADHERENCE_OFFSET_S = 600` provenance comment** ([predictions.js](../js/predictions.js)).
9. **`getBoardingVehicles` Tier-1/2 staleness asymmetry documented** ([predictions.js](../js/predictions.js)) — the 180 s vs 90 s gap is the layover-bridge feature, not a bug.
10. **`M_PER_DEG_LNG_LA` calibration verified + documented** ([utils.js](../js/utils.js)) — 92,630 corresponds to ~33.68 °N, not 34 °N as the prior comment claimed; bias is conservative across the service area.
11. **Cross-references between `STATION_MERGE_RADIUS_M = 300` and bikeshare `MERGE_RADIUS_M = 50`** ([config.js](../js/config.js), [bikeshare.js](../js/bikeshare.js)) — different scales are intentional.
12. **Bikeshare hover-delay constants explained** ([config.js](../js/config.js)) — 180/200 ms vs the 250 ms research threshold for deliberate hover.

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
| Reverse-direction (southbound) DR test | MED | [tests/dr-animation.test.js](../tests/dr-animation.test.js) | `arcSign = -1` path is not exercised. Worth adding next time the DR animation surface is touched. |
| Pin `DR_SPEED_FACTOR = 0.75` regression test | MED | [tests/dr-animation.test.js](../tests/dr-animation.test.js) | Current ±50 % tolerance lets the factor drift. The headless live-accuracy harness is the better signal here — drift would show up in the byHorizon MAE. |
| `_heavyRailScheduleSpeed` integration test with real B/D trip | LOW | [markers.js](../js/markers.js) | Defensive code is there; only synthetic data tests it. Needs a real-world fixture. |
| Heading wrap-around test at exact 0°/360° | LOW | [tests/heading.test.js](../tests/heading.test.js) | Modulo math is correct; cardinal tests already pass through the boundary. Low value. |
| Terminus-turnaround distance sanity cap | LOW | [markers.js](../js/markers.js) | Real code change with subtle risk. Mitigated by next-fix arc gate (brief artifacts only). |

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

The headless harness writes a three-way summary (calc / gtfs-rt / hybrid) per
horizon bucket and per route. The GH Actions workflow runs twice on weekdays
(peak + off-peak). To validate a constant change locally:

```bash
npm run test:live:headless -- --duration=15m --tag=before-change
# make the change
npm run test:live:headless -- --duration=15m --tag=after-change
# diff the summary.json files in scripts/
```

Or trigger the workflow manually via `workflow_dispatch` with a custom `tag`.
Artifacts are retained 30 days.
