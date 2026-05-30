# Trajectory-model overhaul

> **SUPERSEDED — historical only (PR #257, 2026-05).** This plan was never
> completed. The dual-pipeline problem it set out to solve was instead resolved
> by **removing dead-reckoning entirely** and adopting the bounded arc-glide
> model (see [`CLAUDE.md`](../../CLAUDE.md) "Motion model"). The `USE_TRAJECTORY_MODEL`
> flag and every `js/` file named below (`trajectory.js`, `dwellModel.js`,
> `vehicleState.js`, `scheduleCalibration.js`, …) do **not** exist in the repo.
> Kept for design-history provenance only; do not treat as a roadmap.

Living plan for replacing the current dual-pipeline architecture (DR animation + ETA blend) with a single source-of-truth trajectory model. Animation position and popup ETA become two evaluations of the same function — they cannot disagree by construction.

> **Status: Phases 0–5 shipped (2026-05-15); Phase 5 sub-PRs are in [`docs/STATUS.md`](./STATUS.md).** `USE_TRAJECTORY_MODEL` defaults `false` in production. State + trajectory build unconditionally on every WS frame (instrumentation for Phase 8 A/B). Render rAF + ETA dispatcher gated by the flag. Old code is still live — Phase 9 deletes it after Phase 8 validation passes.

---

## Why this overhaul

### Current architecture has two independent pipelines

| Concern | Feed | Code path | User-visible as |
|---|---|---|---|
| Marker animation (DR) | `vehicle_positions` WS | `startDeadReckoning` → `_arcTick` reads `props.smoothedSpeed` | Marker position on map |
| ETA popup ("3 min") | `trip_updates` WS + calc | `_blendArrivals` mixes calc + GTFS-RT trip_updates | Arrival list, popup |

They share no state. As a result they can disagree: marker visibly past a station while popup still says "2 m to <station>"; popup ticking down "1 min" while marker hasn't started moving toward the stop. Bugs of this shape are inherent to the architecture, not individual mistakes — they fall out of having two predictors of the same thing.

### The trajectory-model alternative

Maintain one trajectory function per vehicle, `traj_v(t) → arc_meters`. Then:

```
animation_position(v, t_now)  = lngLatAtArc(traj_v(t_now))
popup_eta(v, target_stop)     = solve traj_v(t) == target_stop.arc for t
```

Both are evaluations of the same function. They cannot disagree. Improvements anywhere (calibration, feed quality, dwell modeling) help both simultaneously.

This is how Lyft/Uber driver tracking, MTA Subway Time, Google Maps Live View transit, and OneBusAway all work. It's the architecture that resolves the entire class of "X and Y disagree" bugs we keep finding.

### Why now, why not just keep tuning

We have a working live-accuracy harness and a documented statistical-tuning plan (H1–H5). But those hypotheses tune parameters that don't exist in the new architecture (band weights, agreement decay, K-taper). Tuning them now would be wasted work — worse, it would calcify the old architecture by giving us "good numbers" we'd then have to re-earn under the new model.

Correct order: rebuild → validate parity → tune the new system.

---

## Architectural primitives

### 1. `Trajectory`

A piecewise-defined function from time to arc-meters along the route polyline.

```ts
class Trajectory {
    // Internal representation: ordered segments
    //   [{ kind: 'free'|'decel'|'dwell'|'hold', arc_start, t_start, v_start, duration|distance }, …]

    positionAt(t):  number              // arc_meters; O(log n) via binary search
    timeAtArc(arc): number              // unix seconds; inverse of positionAt
    velocityAt(t):  number              // m/s
}
```

Segment kinds reflect transit physics:

- **`free`** — between stops, integrate `arc += v · dt`. Long-horizon attractor is calibrated per-segment scheduled speed.
- **`decel`** — within `v²/(2·a)` meters of a stop, decelerate kinematically to zero at the stop's arc.
- **`dwell`** — at a stop, hold position for the calibrated per-stop dwell time.
- **`hold`** — at scheduled timepoints, if the model is early, hold until scheduled time + bias.

Dwell and hold are the two things we currently model as zero. They're a large source of the systematic calc bias.

### 2. `VehicleState`

Per-vehicle Kalman-style state. Replaces the bag-of-properties on markers.

```ts
{
    vehicleId, tripId, routeId, directionId,
    arc:           number,    // current best estimate (meters)
    velocity:      number,    // m/s
    σ_arc:         number,    // position uncertainty
    σ_v:           number,    // velocity uncertainty
    bias:          number,    // (route, dir, time-of-day) learned offset
    trajectory:    Trajectory,
    lastObservedAt, lastTrajectoryAt
}
```

### 3. Observation updaters

One function per feed event. Each applies a Kalman gain `K = σ²_prior / (σ²_prior + σ²_obs)`:

| Function | Reads | Updates | Variance source |
|---|---|---|---|
| `applyGpsFix(state, lat, lng, speed, t, σ_gps)` | snap → arc + variance | `arc`, `velocity` | GPS noise + snap residual |
| `applyStoppedAt(state, stopId, t)` | stop arc | `arc = stop.arc`, `v = 0`, dwell starts | small (deterministic) |
| `applyInTransitTo(state, stopId, t)` | stop arc upper bound | `arc < stop.arc` constraint, ends dwell | small |
| `applyTripUpdate(state, stopId, etaUnix, σ_gtfs)` | future-time anchor | trajectory acceleration to hit `(stop.arc, etaUnix)` | observed GTFS-RT MAE per route |
| `tickTime(state, t)` | nothing | `σ_arc += σ_v · dt + process_noise · dt` | per-route process noise |

No multi-source blending logic. The Kalman gain *is* the blend. `_blendArrivals` is deleted entirely.

---

## Phased plan

```
Phase 0 ──┐
          ├──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 5 ──► Phase 8 ──► Phase 9
          │                                ▲
          │                                │
          └──► (parallel:)  Phase 4 ───────┘
                            Phase 6  (after Phase 5 lands)
                            Phase 7  (after Phase 5 lands)
```

### Phase 0 — Foundations (this PR)

**Goal:** instrument enough that we can prove the new system is no worse than the old before flipping the switch.

- Add **marker-arrival capture** to `tests/eta-live-accuracy.js` (per-snapshot `markerDistM`) so downstream analysis can compute when the dot visually reaches the stop vs. when the popup said it would.
- Add **cluster-bootstrap helpers** to `tests/_lib/accuracy-aggregator.js` for 95% CIs on MAE, hit rate, and paired A/B comparisons. Cluster by `tripId × targetStopId` because snapshots within a trip-stop pair are not independent.
- Add this `docs/trajectory-overhaul.md` as the living plan.
- After this PR ships, let the cron accumulate **5 days of baseline captures** (Mon–Fri, 2 runs/day = 10 captures) before any architectural code lands. That baseline is the floor the new system cannot regress past.

**Acceptance:** 5 days of paired captures collected, baseline summary published, harness emits `markerDistM` per snapshot.

### Phase 1 — Trajectory primitive

Build the core data type. No integration with existing code yet.

- `js/trajectory.js` exports a `Trajectory` class with `positionAt`, `timeAtArc`, `velocityAt`.
- Pure function — no globals, no DOM, no MapLibre, no `window.*`.
- 50+ unit tests covering: monotonicity of `positionAt`, exact inverse of `timeAtArc`, decel reaches zero at stop, dwell holds position, hold respects scheduled time, edge cases at segment boundaries.

**Acceptance:** PR merges with all tests green; class is unused by any other module.

### Phase 2 — VehicleState container

Wraps the trajectory with per-vehicle Kalman state.

- `js/vehicleState.js` defines the state shape and lifecycle (`createState`, `archiveState`).
- Independent of map rendering — no MapLibre coupling.
- Smoke tests show one state can be instantiated, observed, and produce a trajectory.

### Phase 3 — Observation updaters

Five functions (`applyGpsFix`, `applyStoppedAt`, `applyInTransitTo`, `applyTripUpdate`, `tickTime`) in `js/stateUpdaters.js`. Each is small, pure, and applies a Kalman update.

- Tests: each updater in isolation, then chained sequences mirroring real WS frames.
- Initial variance values hardcoded from current observed feed quality (lookup by route); learned online in Phase 6.

### Phase 4 — Dwell and timepoint model

This is where the systematic calc bias gets fixed.

- `js/dwellModel.js`: per-(stop, route, direction) dwell estimates built from GTFS `arrival_time` / `departure_time` deltas.
- **Timepoint detection** from GTFS `stop_times.timepoint` field.
- **Per-(route, direction, time-of-day) calibration**: dwell averages learned online from observed STOPPED_AT durations.
- Consumed by `Trajectory.fromAnchor` when constructing segments.

### Phase 5 — Render layer rewrite

The biggest blast radius. Feature-flagged behind `USE_TRAJECTORY_MODEL`.

- `markers.js`: deletes `_arcTick`, `_bearingTick`, `_drCurrentArc`, `_drStopArcCap`, `_drTargetSpeed`, `_drArcSign`, `startDeadReckoning`, `startBearingDeadReckoning`. Marker position each frame = `lngLatAtArc(state.trajectory.positionAt(t_now))`. ~300 lines deleted.
- `predictions.js`: deletes `_blendArrivals`, horizon-band logic, disagreement decay, replay guard. `getScheduledArrivals` becomes `state.trajectory.timeAtArc(target_arc)`. ~500 lines deleted.
- `snap.js`: unchanged (still converts GPS → arc).
- `intersections.js`: deleted — light-rail dwell handling moves to the dwell model.
- `scheduleCalibration.js`: replaced by `dwellModel.js` and the variance-learner in Phase 6.
- Updates: `stations.js`, popups, `ui.js`, `tripUpdates.js` — all read from `state.trajectory`.

Net code change: ~1500 lines deleted, ~1000 lines added.

### Phase 6 — Online variance learning

Each completed prediction-vs-actual updates measurement variance estimates per source per route. EWMA, persisted to localStorage like the current schedule-calibration table.

- `σ_gps` per route from snap residuals
- `σ_gtfs_trip_update` per route from prediction errors
- `σ_dwell` per (stop, route, direction)
- Process noise per route (how fast `σ_arc` grows during feed silence)

Replaces the hand-tuned constants from Phase 3. Self-improving over a day or two of operation.

### Phase 7 — Uncertainty in the UI

State-of-the-art differentiator. Popup ETA shows `±X s` band when `σ` is high; "Arriving" label when in decel-to-zero segment; marker opacity fades slightly when `σ_arc > 50 m`.

### Phase 8 — Migration & validation

Feature flag rollout: 1 day legacy, 1 day trajectory, alternating, captured side-by-side.

Comparison framework: paired tests on (legacy_blend_err, trajectory_eta_err) for each arrival. Sign test on the diff. Acceptance gates:
- overall ±30 s improves or holds
- overall MAE improves or holds
- no per-route ±30 s regresses by > 2 pp
- **animation-popup gap = 0 s** (by construction; non-zero means we built it wrong)

After 10 days of clean wins, promote default to `true`. Delete legacy code in a follow-up PR after one quiet week.

### Phase 9 — Statistical tuning (the original H1–H5 plan, retargeted)

The original tuning plan now applies to the new model's parameters:

- **H1' — observation variance priors:** are initial `σ` values right per route, or should we boot from learned values?
- **H2' — process noise tuning:** how fast should `σ_arc` grow during feed silence? Affects fade behavior and Kalman gain.
- **H3' — dwell model granularity:** per-stop vs. per-(stop, hour-of-week) — does the latter pay for its complexity?
- **H4' — timepoint hold strictness:** hold to scheduled time exactly, or until `σ`-bound says we'd be too late?
- **H5' — bias decay rate:** how fast should we forget yesterday's lateness when learning today's?

Same statistical hygiene as the original plan (see [Transit-data considerations](#transit-data-considerations) below).

---

## Transit-data considerations

Best practices that should reshape every measurement we take, not just the ones for this overhaul.

### Errors are not symmetric in cost

A rider seeing "1 min" who arrives 30 s late and misses the train waited a full headway for the next one. A rider seeing "1 min" whose train is actually 30 s away just feels lucky. **Underestimates are several times more costly than overestimates.**

Implication: don't optimize MAE alone. Optimize an asymmetric loss: `mean(max(0, predicted - actual))` weights the wrong-side errors. Today's calc bias of −37 s means we're systematically telling people the train arrives sooner than it does — exactly the wrong-side error.

### Time-of-day is the dominant covariate

Off-peak doesn't generalize to peak. Schedule slack is calibrated for peak; off-peak vehicles run ahead.

Implication: **never pool peak with off-peak**. Stratify every claim by AM peak / mid-day / PM peak / evening.

### Errors are not independent within a trip

Two snapshots from the same vehicle approaching the same stop 30 s apart are nearly perfectly correlated. Treating them as independent inflates effective `n` by ~10×.

Implication: **cluster-bootstrap by `tripId × targetStopId`**, not by snapshot. Implemented in Phase 0 of this plan.

### Distributions are heavy-tailed and skewed-right

"Vehicle 5 min late" happens at non-trivial frequency (traffic, breakdowns, holding-point waits). "Vehicle 5 min early" almost never happens.

Implication: report **median absolute error (MdAE) and p80/p95** alongside MAE. Don't drop outliers — they ARE the bad-UX moments.

### Headway-relative accuracy beats absolute accuracy

At 5-min headway, ±30 s is great. At 30-min headway, ±30 s on the first arrival is fine but missing it means a 30-min wait.

Implication: secondary metric is **fraction of predictions where `|error| > 0.25 × headway`**.

### Minute-bucket rounding is what users perceive

A 75 s prediction shown as "1m" with actual 35 s reads to the user as "app said 1 minute and it was 30 seconds." A 65 s prediction shown as "1m" with actual 45 s reads as accurate. Seconds-precision MAE misses this entirely.

Implication: primary user-facing metric is `P(round(predicted/60) == round(actual/60))`.

### Vehicle-loss censoring

Some snapshots never get an `actualUnix` — the vehicle disappeared (deadhead, GPS failure, marker TTL). If failure correlates with bad-prediction conditions, we're biasing toward easy cases.

Implication: capture and report the **disappearance rate** alongside accuracy.

### Revised metric stack

| Metric | What it measures | Priority |
|---|---|---|
| **MdAE** | Typical error magnitude (robust) | Headline |
| **Asymmetric loss** | Cost of "soon" predictions that are wrong | Calibration target |
| **Minute-bucket accuracy** | User-perceived accuracy | UX-facing claim |
| **`P(|err| > 0.25 × headway)`** | Useful-prediction rate | Decision-quality metric |
| **p95 abs error** | Tail behavior | Worst-case framing |
| **MAE / ±30 s** | Continuity with existing reports | Keep but demote |

Stratification: route × direction × time-of-day-band × horizon-band × `atOrigin`. Cluster-bootstrap CIs by `tripId × stopId`.

---

## Tracked engineering improvements (alongside the overhaul)

Items that don't block the overhaul but should land independently. Each one will reduce a class of bug or improve a quality bar we already care about.

### Heading audit: where the arrow can still flip 180°

`computeHeading` runs this priority chain:

| # | Condition | Returns |
|---|---|---|
| 1 | `prevHeading` exists + `speed < 0.5 m/s` + **no** snap tangent | `prevHeading` |
| 2 | `prevHeading` exists + within 150 m of trip's final stop | `prevHeading` |
| 3 | snap tangent exists + `downstream != null` | tangent disambiguated by downstream |
| 3a | snap is `endpointTangent` + `downstream != null` | raw downstream (skip tangent) |
| **3b** | **snap tangent exists + `downstream == null`** | **`prevHeading ?? tangent`** ⚠️ |
| 4 | no tangent + `downstream != null` | downstream |
| **5** | **cold-start: no prevHeading, no lastSnap, snap succeeds** | **`snap.tangentForward`** ⚠️ |
| 6 | else | `prevHeading ?? 0` |

#### Remaining flip vectors

**A. First-load STOPPED_AT terminus** (matches the user-reported "first load at a station" case).
`prevHeading = null`, lastSnap has tangent. `downstreamBearing` walks `stops` from `idx+1`; at the last stop `startIdx = stops.length` → loop never runs → returns `null`. Path 3b returns **raw `tangent`** with no disambiguation. Snap window near a terminus can easily produce the reverse direction (loop tracks, stub spurs, layover yards).

**B. All downstream stops within `DOWNSTREAM_MIN_METERS` (100 m).**
Rare but real near hubs (Union Station, 7th/Metro) — downstream filter rejects everything, returns null, same path as A.

**C. Cold-start, no lastSnap, no downstream** (path 5).
Returns `snap.tangentForward` directly — no disambiguation step at all.

**D. Stale `props.stopId` points backward** (matches the user-reported "at stations" flips).
After a tunnel re-acquisition or any feed lag, `stopId` can still name a stop the train has already passed. `bearingToStop(stopId, here)` then produces a bearing pointing *behind* the train. The disambiguation `delta = downstream − tangent` is now between two opposite-direction references → it flips a correct tangent to the wrong way.

**E. STOPPED_AT with `stopId` not found in `stops`.**
`findIndex` returns -1, `startIdx = 0`, so the scan can pick up a stop *behind* the train and use its bearing as "downstream." Rare; usually only on owl-service or feed-cache mismatch.

#### Recommended fix (one helper + two call sites)

Add `upstreamBearing(props, lng, lat)`: walks the trip stops *backward* from `props.stopId`, returns the bearing **from** the first valid upstream stop **to** the current position (≥ `DOWNSTREAM_MIN_METERS` away). Reliable because the train has demonstrably been there.

Then in path 3b (and as a sanity guard in path 5):

```js
// downstream is null — try upstream-derived reference before giving up.
const upstream = upstreamBearing(props, newLng, newLat);
if (upstream != null) {
    const delta = _shortestBearingDelta(upstream, tangent);
    return Math.abs(delta) < 90 ? tangent : (tangent + 180) % 360;
}
return prevHeading ?? tangent;
```

Solves A, B, gives C a disambiguator. For D, add a sanity check inside branch 3: if `downstream` and `upstream` disagree by > 90° (one of them is clearly behind us), discard `downstream` and use `upstream` for disambiguation instead.

~25 lines of new code, no API change, no behavior change for the happy path. Lands as its own PR independent of the trajectory overhaul.

---

## Reversibility

Every phase is reversible until Phase 8's flag-flip. Each phase ships as one or more small PRs with green tests. If any phase fails its acceptance gate, the next phase doesn't start; the existing architecture continues serving users untouched.

After Phase 8, the rollback path is one config change: `USE_TRAJECTORY_MODEL = false`. Legacy code is only deleted after one quiet week post-promotion.

---

## Update log

| Date | Change |
|---|---|
| 2026-05-11 | Initial plan; Phase 0 PR opened. |
| 2026-05-15 | Phases 1–5 shipped. PRs #155 (flag), #169 (5.1 singletons), #170 (5.2 routing + builder), #171 (5.4 render rAF), #172 (5.5 ETA reads), #173 (5.6 A/B instrumentation), #175 (5.7 hygiene), #176 (5.8 aggregator). Flag stays `false`; A/B captures begin via paired `trajectoryEta` column in every harness run. Weekend cron added (#174) to accelerate the starter dataset. |
