# Phase 5b — Blend-Anchored Animation (ARCHIVED 2026-05-17)

**STATUS: REVERTED.** Shipped 2026-05-17 morning (PR #189), reverted 2026-05-17
evening (PR #198) after surfacing unresolved bugs the legacy DR system had
already handled — direction-reversed polylines (D Line going westbound when
the cache was stored eastbound: arrow wrong, marker pinned at wrong arc),
polyline-vs-station-icon visual offset, plus compounding patches (PRs #196,
#197) that made the direction-reversed case worse. Current production system
uses the pre-Phase-5b legacy DR motion model (`markers.js` `_arcTick` /
`_bearingTick` continuous-loop integrator).

Document kept for archival reference of the design + lessons learned.

Original supersedes-the-Phase-5 trajectory-model overhaul (archived
in [`trajectory-overhaul.md`](./trajectory-overhaul.md) and
[`phase-5-wiring.md`](./phase-5-wiring.md)) — that one was abandoned for
different reasons (physics can't beat GTFS-RT). Phase 5b was abandoned for
animation-correctness reasons.

## What changed

Phase 5 attempted to replace both the legacy DR animation AND the
calc/blend ETA pipeline with a single physics model: a Kalman-filtered
`Trajectory` per vehicle whose `positionAt(t)` drove animation and
whose `timeAtArc(arc)` drove ETA. The unification idea was correct;
the "physics out-predicts blend" assumption was not.

2026-05-16 weekend A/B captures showed trajectory ETA ~10× worse than
blend on apples-to-apples comparisons. The cause is structural: GTFS-RT
(which feeds blend) carries dispatcher information no physics model can
reproduce. Even a perfectly-calibrated trajectory will never out-predict
the operator's own predictions on the pre-arrival window.

**Pivot:** keep blend as the ETA source (it already works), but back-
compute the animation from it. Animation and ETA agree by construction
because they consume the same number.

## Architecture

```
GTFS-RT trip_updates ──► masterArrivalsData ─┐
                                             ├─► _blendArrivals ──► blendEta
GPS fix (snap.arcMeters) ──► calc ETA ───────┘                          │
                                                                        ▼
GPS fix ──► marker.lastSnap.arcMeters ─────► buildAnimationTrajectory ──► Trajectory
                                                                        │
                                                          renderLoop.js │ rAF: positionAt(now)
                                                                        ▼
                                                          marker.setLngLat / setRotation

Popup ETA: getScheduledArrivals(stopId) returns the SAME blendEta the
            animator consumed. By construction, marker arrives at next-
            stop arc at exactly the moment the popup shows "0s".
```

## Modules

| File | Role |
|---|---|
| `js/trajectory.js` | Unchanged. `Trajectory` class + `fromAnchor` (segment evaluator math). The new builder produces a single-segment `free` trajectory; the class survives intact. |
| `js/animationStore.js` | Singleton `Map<tripId, AnimationEntry>` |
| `js/animationBuilder.js` | `buildAnimationTrajectory({...})` — back-computes cruise speed from blend ETA |
| `js/animationWiring.js` | `updateAnimationFor({...})` — called on every WS fix; idempotent within 250ms debounce |
| `js/renderLoop.js` | Single rAF reads `animations` map, calls `positionAt(now)` + `lngLatAtArc` + DOM update |
| `js/predictions.js` `blendEtaForNextStop` | NEW. Slim per-marker variant of `getScheduledArrivals`'s inner loop, scoped to the marker's own next stop. |

## Five layers of runaway / overshoot protection

| Layer | Where | What it guards |
|---|---|---|
| **A** Builder speed clamp | `animationBuilder.js` | Speed clamped to `[1, 22]` m/s rail / `[1, 17]` m/s bus. Hostile blend ETA (`now + 0.001s`) cannot produce impossible speed. |
| **B** Trajectory `positionAt` terminal-arc clamp | `trajectory.js` lines 150–151 | `t >= last.t_end` → returns `last.arc_end`. Built-in; no change needed. |
| **C** Per-frame `stopArcCap` re-check | `renderLoop.js` | After `positionAt(now)`, if `arc > entry.nextStopArc` clamp + `recordRenderDrop('stopArcCap')`. |
| **D** Staleness gate | `renderLoop.js` | `now − lastObservedAt > DR_MAX_SECONDS{,_RAIL}` → skip frame; marker freezes. |
| **E** Anchor refresh ≤ 5 s | `markers.js` `updateExistingMarker` | Every WS vehicle fix rebuilds the trajectory via `updateAnimationFor`. Stale-anchor window bounded by WS cadence. |

## What was deleted

~2400 lines net:

- `js/stateUpdaters.js`, `js/vehicleState.js`, `js/dwellModel.js`, `js/phase5State.js`, `js/phase5Wiring.js`, `js/trajectoryBuilder.js` — Kalman + dwell EWMA + Phase 5 wiring
- `js/markers.js` `_arcTick`, `_bearingTick`, `startDeadReckoning`, `startBearingDeadReckoning`, `_stopDr`, `_heavyRailScheduleSpeed`, `animateMarker`, all `_dr*` marker fields — legacy DR integrators
- `js/predictions.js` `_getTrajectoryArrivals`, `_capTrajectoryEta`, `TRAJECTORY_ETA_MAX_HORIZON_S`, flag check, `trajectoryEta` column
- `js/config.js` `USE_TRAJECTORY_MODEL` + 6 `DR_*` integrator constants
- `tests/_lib/accuracy-aggregator.js` — trajectory column + `headToHeadTrajectoryVsBlend`
- 14 test files: phase5-*, dwellModel, vehicleState, stateUpdaters, trajectoryBuilder*, dr-animation, accuracy-aggregator-trajectory, trajectory-runaway, trajectory-replay

## What was kept

- All of `js/snap.js`, `js/scheduleCalibration.js` (calc ETA still feeds blend)
- `js/predictions.js` everything except the deleted helpers — blend pipeline is the new source of truth
- `js/markers.js` `_applySnap`, `isGpsSpike`, GPS-pullback suppression block (user-stated requirement), freshness tiers, terminus heading, `computeHeading` chain
- `js/trajectory.js` Trajectory class + `fromAnchor` — still useful

## Known regressions vs legacy DR

- **At-grade light-rail red-light freezes** — legacy used `isNearIntersection()` + `data/light-rail-intersections.json` to distinguish "stopped at known crossing" from "GPS tunnel dropout." Under the new model the GPS-speed=0-fresh check in `animationBuilder` handles both cases without needing crossing data: stopped train has GPS speed=0 with fresh timestamp; tunnel dropout has no fresh GPS at all. Crossing data is unused but kept in tree pending decision to delete.
- **Cold-start glide** — legacy `animateMarker` smoothed the visible jump from old marker position to new GPS over ~1 s. New model lets the renderLoop teleport at 60fps. Pin in visual QA.
- **Direction-reversed polylines** — same deferred regression as Phase 5. New builder also rejects (`nextStopArc <= currentArc` → tiny dwell, marker stays put). Fix is the same signed-arc translation work, orthogonal to this pivot.

## Verification

```bash
npm test -- --run     # 1245 tests pass (was 1438 pre-pivot; net 193 deleted)
```

End-to-end visual QA at <https://metrolivemap.net> after merge:

1. Marker visibly converges to the stop arc as popup ETA counts down
2. Marker arrives at the stop at the moment popup shows "0s"
3. Marker does NOT animate past the stop
4. Marker freezes when WS feed silent past `DR_MAX_SECONDS{,_RAIL}`
5. Terminus turnarounds flip the icon and don't rotate to a stale tangent
6. GPS spikes still rejected (no visible teleport)
