# Deferred recommendations — math/logic audit

**Source:** Three-agent deep audit, 2026-05-10. See conversation transcript for full
findings; this file tracks items that were intentionally **not** addressed in the
shipping branch (`claude/clever-lehmann-1413e2`) so they don't get lost.

The four high-confidence fixes that **were** shipped:

1. Stale "positive = early" docstring removed from `computeTripAdherenceOffset`
   ([predictions.js:229](../js/predictions.js)).
2. Implicit constant coupling between blend horizons and replay-guard / disagreement
   thresholds documented inline ([config.js:160-162](../js/config.js)).
3. `arcSign` Path-3 fallback now defaults to forward when both `Heading` and
   `tangentForward` are null, eliminating a NaN → -1 silent regression
   ([markers.js:1175-1180](../js/markers.js)).
4. Comment on shared alert-entry object across `masterAlertsData` /
   `masterStopAlertsData` so future code knows entries must be treated as
   immutable ([alerts.js:87-94](../js/alerts.js)).

---

## Deferred — by area

### Predictions / blend / adherence

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| Extract `getElapsedWithLag(statusChangedAt, now)` helper to unify the two `ETA_DEPARTURE_LAG_S` add sites | MED | [predictions.js:220, 280](../js/predictions.js) | If 15s is retuned both must change together; a helper enforces it. |
| Document rationale for `MAX_ADHERENCE_OFFSET_S = 600` | MED | [predictions.js:19](../js/predictions.js) | Round number with no audit-trail comment; vehicles held >10 min silently capped. |
| Test stale-replay guard at `calcHorizon = 300` boundary | MED | [predictions.js:117](../js/predictions.js) | Strict `<` cliff; pin the boundary in the prediction-blend test suite. |
| Test horizon-blend step at `60s` and `300s` exactly | MED | [predictions.js:123-125](../js/predictions.js) | Documented as intentional discontinuity; no test pins the magnitude. |
| Test disagreement decay at `SOFT (60)` and `HARD (180)` exactly | LOW | [predictions.js:130-134](../js/predictions.js) | Implicit coverage in prediction-blend.test.js but no boundary assertion. |
| Test trip spanning midnight | MED | [predictions.js getScheduledArrivals](../js/predictions.js) | `Math.floor(Date.now()/1000)` rolls fine; a wrap-around test would pin it. |
| Test single-stop trip and `targetIdx - nextIdx - 1 = -1` path | LOW | [predictions.js:358](../js/predictions.js) | `max(0, …)` already guards; explicit test would catch regressions. |
| Test EWMA convergence with alternating samples | MED | [scheduleCalibration.js:83-125](../js/scheduleCalibration.js) | `ALPHA=0.25` (was 0.15) cuts convergence time but doubles noise sensitivity; regression test would compare regimes. |
| Test step warmup at `obs=5` boundary | MED | [scheduleCalibration.js:111](../js/scheduleCalibration.js) | First post-warmup observation can swing the multiplier full range; no test asserts boundary behavior. |
| Test `localStorage.QuotaExceededError` handling | MED | [scheduleCalibration.js:43-71](../js/scheduleCalibration.js) | Catch-all swallow exists; no test verifies recovery. |

### Markers / kinematic / snap / heading

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| **Verify `M_PER_DEG_LNG_LA = 92630`** | MED | [utils.js:10](../js/utils.js) | Doesn't match `111320·cos(34°) ≈ 92,300`. Off by ~330. Either recompute or document the calibration source. Currently biases conservative (tightens spike gates) but the value should be traceable. |
| **Empty shape for J Line 950 in rail-shapes.json** | MED | [data/rail-shapes.json](../data/rail-shapes.json) | `950` has 0 points — vehicles on this route can't snap and fall through to busway path. `806` is also empty (likely cruft). Confirm 950 service status and either add a shape or formally exclude the code. |
| Reverse-direction (southbound) DR test | MED | [tests/dr-animation.test.js](../tests/dr-animation.test.js) | `arcSign = -1` path is not exercised. |
| Pin `DR_SPEED_FACTOR = 0.75` regression test | MED | [tests/dr-animation.test.js](../tests/dr-animation.test.js) | Current ±50% tolerance lets the factor drift undetected. |
| `_heavyRailScheduleSpeed` integration test with real B/D trip | LOW | [markers.js:1072-1110](../js/markers.js) | Defensive code is there but only synthetic data tests it. |
| Heading wrap-around test at exact 0°/360° | LOW | [tests/heading.test.js](../tests/heading.test.js) | Modulo math is correct; an EPS-near-boundary test would lock it. |
| Terminus-turnaround distance sanity cap | LOW | [markers.js:413-431](../js/markers.js) | Bypasses cold-start spike unconditionally; mitigated by next-fix arc gate, so brief artifacts only. |

### Stations / boarding / alerts

| Item | Severity | Where | Notes |
|------|----------|-------|-------|
| **Alert dedup loses route context for J Line 910/950** | HIGH (UI) | [stations.js:590-605](../js/stations.js) | Dedup is by `effect` only; a 950-only DETOUR collapses with a 910 alert into a generic "DETOUR" badge. Should key by `(effect, routeId)` or render multiple badges. |
| `cleanStationName` regex fragility | MED | [utils.js:44-60](../js/utils.js) | Schema changes (en-dash vs hyphen, "Lines" vs "Line") would silently break station merging. Add a corpus test against actual GTFS stop names. |
| Document station merge radius vs bikeshare merge radius | MED | [config.js:166](../js/config.js), [bikeshare.js:29](../js/bikeshare.js) | 300 m vs 50 m — intentional, undocumented. Add cross-reference comments. |
| Boarding-tier staleness mismatch (180s VP vs 90s TU) | MED | [predictions.js:780, 824](../js/predictions.js) | Up to 90 s of "ghost" boarding badges with no marker on VP-feed dropouts. Either unify or document. |
| Multi-stop alert spanning 3+ routes test | MED | [tests/alerts.test.js](../tests/alerts.test.js) | Fan-out into both `masterAlertsData` and `masterStopAlertsData`. |
| Two overlapping alerts on same route+effect test | MED | [tests/alerts.test.js](../tests/alerts.test.js) | Dedup by id only — overlapping non-id-equal alerts may both render. |
| Boarding at terminus when only one trip in service | LOW | [tests/boarding-vehicles.test.js](../tests/boarding-vehicles.test.js) | Terminus-also-origin case for reverse direction. |
| Display name selection on merge is iteration-order-dependent | LOW | [stations.js:91-99](../js/stations.js) | First-registered wins; deterministic in modern JS but worth documenting. |

### Cross-cutting

| Item | Severity | Notes |
|------|----------|-------|
| Provenance comments on bare-number constants | LOW | `MAX_ADHERENCE_OFFSET_S=600`, `GPS_SPIKE_STOP_RADIUS_M=1500`, `BIKESHARE_NEAR_RAIL_RADIUS_M=120` lack audit-trail rationales like the well-documented ones nearby. |
| `BIKESHARE_HOVER_DELAY_NEAR_MS = 180` vs `_SOLO_MS = 200` rationale | LOW | Both shipped without measurement. Worth noting whether 20 ms differential is meaningful. |
| `ETA_INTERMEDIATE_DWELL_S = 40` (rail) vs `_BUS_S = 45` (bus) rationale | LOW | Both have audit-trail comments but the 5 s differential between modes isn't justified relative to measured dwell distributions. |

---

## Use the new harness to validate before retuning

The headless harness now writes a three-way summary (calc / gtfs-rt / hybrid) per
horizon bucket and per route. Workflow runs twice on weekdays (peak + off-peak). To
validate a constant change locally:

```bash
npm run test:live:headless -- --duration=15m --tag=before-change
# make the change
npm run test:live:headless -- --duration=15m --tag=after-change
# diff the summary.json files in scripts/
```

Or trigger the GH Actions workflow manually via `workflow_dispatch` with a custom
`tag`. Artifacts are retained 30 days.
