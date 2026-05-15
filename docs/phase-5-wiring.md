# Phase 5 Wiring — Legacy → Trajectory Replacement Map

Companion to [`trajectory-overhaul.md`](./trajectory-overhaul.md). The plan
describes WHAT Phase 5 does; this doc maps WHERE the swap happens, seam by
seam. Read this first when picking up Phase 5 implementation.

The feature flag is **`USE_TRAJECTORY_MODEL`** (`js/config.js`). Today it's
`false` and the seams early-return to the legacy path; Phase 5 flips
default to `true` after a stretch of A/B validation per the overhaul plan.

> **Grep `USE_TRAJECTORY_MODEL`** to find every seam in code. The list below
> mirrors that grep with explanatory notes.

---

## Active seams (the if-else stubs are already in place)

### S1. Marker motion — bearing DR
**File:** `js/markers.js` → `startBearingDeadReckoning(markerKey)`
**Current behaviour:** kicks off `_bearingTick` rAF callback, integrates
position from last GPS fix + last known speed, slowly damps speed via
exponential glide.
**Phase 5 behaviour:** the integrator does not run. A new render-layer
rAF reads `state.trajectory.positionAt(t_now)` and `state.trajectory.tangentAt(t_now)`
for every active vehicle each frame. Heading still routes through the
upstream-bearing disambiguator added in PR #117 (kept).

### S2. Marker motion — arc-based DR (rail)
**File:** `js/markers.js` → `startDeadReckoning(markerKey)`
**Current behaviour:** kicks off `_arcTick` rAF callback. Integrates
along the route polyline in arc-meters, snaps to next stop, applies
decel zone near stop, handles dwell freeze near intersections (light
rail) or DR_HEAVY_RAIL_FALLBACK speed (heavy rail).
**Phase 5 behaviour:** same as S1 — `state.trajectory.positionAt(t_now)`
gives the lat/lng directly. Dwell handling moves to
`js/dwellModel.js` (already implemented, dormant).

### S3. ETA — scheduled arrivals
**File:** `js/predictions.js` → `getScheduledArrivals(targetStopId)`
**Current behaviour:** for each vehicle whose trip passes through the
target stop, builds (calc ETA, GTFS-RT ETA, blended ETA) tuple via
`_blendArrivals` + horizon-band weighting + disagreement decay +
replay guard. Returns blended.
**Phase 5 behaviour:** for each vehicle whose trajectory crosses the
target arc, `state.trajectory.timeAtArc(targetArc)` returns the ETA.
No blend — the Kalman gain in `stateUpdaters.applyTripUpdate` already
weights GTFS-RT vs calc by per-route variance learned online.

---

## Inactive seams (no early-return needed; just code Phase 5 deletes)

These are not flagged today because no caller is positioned where an
early-return-then-fallthrough would make sense. Phase 5 simply removes
them.

### D1. `_blendArrivals` (predictions.js)
Used only inside `getScheduledArrivals` (which now short-circuits under
the flag). Once S3 is fully cut over, this function and its constants
(`BLEND_HORIZON_NEAR_S`, `BLEND_WEIGHT_NEAR`, `BLEND_DISAGREEMENT_SOFT_S`,
`BLEND_REPLAY_NEAR_S`, etc.) drop. **~120 lines.**

### D2. `_arcTick` + `_bearingTick` (markers.js)
The rAF callbacks themselves. Reachable only from the start functions
(S1, S2), which now return early. Plus all DR state on markers:
`_drCurrentArc`, `_drTargetSpeed`, `_drStopArcCap`, `_drArcSign`,
`_drLastTick`, `_drDirection`, `_drBearing`, `_drMaxRemaining`,
`_drRouteCd`, `_drActive`, `_arcTickCb`, `_bearingTickCb`. **~300 lines.**

### D3. `interStopRemainingSeconds`, `computeScheduleEta`, the dwell-pad
constants in predictions.js
Calc-path helpers. Trajectory replaces with
`stateUpdaters.applyInTransitTo` + `Trajectory.fromAnchor`. **~150 lines.**

### D4. `scheduleCalibration.js` (entire module)
EWMA on inter-stop travel times. Replaced by `dwellModel.js` (already
shipped, dormant) and the variance learner Phase 6 introduces. Drop the
file, the `getSpeedMultiplier` import in predictions.js, and the
`recordSegmentTime` import in markers.js. **~250 lines.**

### D5. `intersections.js` `isNearIntersection` callers
The function stays (heading disambiguation still uses it), but its
**dwell** consumers in `markers.js` (`_arcTick` freeze logic) and
`predictions.js` move to `dwellModel.js`. Strip those references.

---

## New wiring Phase 5 adds

### W1. `VehicleStateStore` instantiation
Probably in `main.js`'s data-load handler or `markers.js` module top.
One per session. `state = new VehicleStateStore({ dwellModel, /*…*/ })`.
Replaces `markers[]` as the source-of-truth bag.

### W2. WS frame routing → stateUpdaters
- `api.js` `processVehicleData` → `applyGpsFix(state, frame)` and/or
  `applyStoppedAt`/`applyInTransitTo` based on currentStatus.
- `tripUpdates.js` per-stopTimeUpdate loop → `applyTripUpdate(state, tripId, stu)`.
- `markers.js` cleanup tick (or a new tick) → `tickTime(state, nowSec)` to
  advance trajectory time forward without a new fix.

### W3. Render loop
A single rAF that iterates active vehicles in `state`, evaluates
`positionAt(t_now)` + `tangentAt(t_now)`, calls `setLngLat` + `setRotation`
on each MapLibre marker. Replaces `_arcTick`/`_bearingTick`.

### W4. Popup ETA reads
`stations.js buildArrivalsHTML` and `ui.js getPopupHTML` swap
`getScheduledArrivals` for a trajectory-keyed read. Since `getScheduledArrivals`
already short-circuits under the flag, this can stay un-changed; just
remove the seam once the flag is the default.

### W5. DwellModel construction
`new DwellModel({ storageKey: 'metro-livemap.dwellV1' })`. Seed from
static GTFS at startup; updates live from `applyStoppedAt` durations.
Wired into `state.dwellModel` so trajectory segments respect learned
per-stop dwell.

---

## Files Phase 5 keeps untouched

The trajectory rewrite is scoped to the motion + ETA pipeline. **Do not**
touch these in the same PR — they have no replacement and changes here
risk muddling the diff:

- `alerts.js` — service alert ingest, popup labels
- `stations.js` station rendering / popup body / unified badge renderer
- `bikeshare.js` — independent feed
- `i18n.js`, `ui.js` (popup HTML scaffold)
- `map.js`, `microzones.js`, `busBridges.js`
- `freshness.js` — visual tier mapping stays, but the input
  (`marker.timestamp`) becomes a property on `VehicleState` rather than
  the MapLibre marker. One-line adapter or rename.
- `intersections.js` — kept; only its dwell consumers move.
- `snap.js` — kept; `snapToRoute` and `lngLatAtArc` are how trajectory
  builds its arc-keyed timeline.

---

## A/B harness (Phase 8 validation)

Phase 5 lands with `USE_TRAJECTORY_MODEL = false`. Phase 8 alternates the
default daily and uses the existing `live-accuracy-headless.js` runs to
collect paired (legacy, trajectory) ETA captures. The
`.github/workflows/live-accuracy.yml` cron already runs twice a weekday
with 30-day artifact retention — enough headroom for the 10-day clean-win
window the overhaul plan requires before flipping the default.

What Phase 5's PR should add to the workflow:
- Matrix the run on `USE_TRAJECTORY_MODEL: [false, true]` so each cron
  produces both pipelines' summaries.
- Bump `retention-days` to 90 to cover the full validation cycle without
  archiving artifacts manually.

---

## Smoke-test checklist for the flag flip

When flipping `USE_TRAJECTORY_MODEL = true` (Phase 8 default change or
manual local toggle), verify these flows manually before declaring done:

- [ ] Markers move smoothly across multiple zoom levels.
- [ ] Heading rotates correctly through curves (use a known A-Line bend).
- [ ] Vehicle popup shows live ETA, age counter ticks.
- [ ] Station popup arrival list populates and updates every 5 s.
- [ ] "Now" pill appears at the right moment for at least one arriving vehicle.
- [ ] Boarding pills at terminus stations show departure times.
- [ ] Alert badges, accessibility badges still render (S6 of the unified renderer is independent of the flag).
- [ ] Spike rejection still drops a manually-injected garbage fix
      (`window.vehicleMarkers['T1'].properties.lat = 0` via console).
- [ ] Midnight rollover (advance clock) reloads GTFS without breaking the trajectory state container.
- [ ] Visibility-resume after backgrounding the tab for 5 min produces a smooth catch-up, not a teleport.
- [ ] No `console.warn` / `console.error` on a fresh load.

When all pass on dev, ship the PR-with-flag-default-true. Phase 9
deletes everything in the "Inactive seams" section above as a follow-up.
