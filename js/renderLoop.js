/**
 * @module renderLoop
 *
 * Phase 5.4 — single rAF that drives marker position + rotation from the
 * trajectory model. Replaces the per-marker `_arcTick` / `_bearingTick` loops
 * in markers.js when `USE_TRAJECTORY_MODEL` is true.
 *
 * Per frame, for every `VehicleState` in the store that has a trajectory:
 *   1. `arc = state.trajectory.positionAt(now)` — accurate physics; the
 *      trajectory's segments handle cruise, kinematic decel into stops,
 *      and dwell/hold at each stop without our needing to integrate.
 *   2. `{lat, lng, tangent} = lngLatAtArc(routeCode, arc)` — snap.js
 *      converts route arc back to map coordinates plus a forward tangent.
 *   3. Look up the MapLibre Marker DOM via `window.vehicleMarkers[tripId]`
 *      (the same map the legacy code writes to) and update its position
 *      and rotation.
 *
 * Trajectories enforce monotonically-increasing arc, so the tangent from
 * `lngLatAtArc` is by construction the direction of travel — no
 * upstream/downstream disambig needed here (that was a workaround for the
 * legacy DR's reliance on the feed's stopId, which lags). The legacy
 * `computeHeading` priority chain stays in place for the WS-fix path
 * (markers.js) — it sets the heading on cold-start frames before any
 * trajectory exists.
 *
 * ## Staleness gate
 *
 * A trajectory projected forward indefinitely is unreliable. We freeze the
 * marker (skip the render update) once `now - state.lastObservedAt`
 * exceeds the mode's DR window — same threshold the legacy DR uses, so
 * the visible behavior between A/B variants is comparable.
 *
 * ## Skipped vehicles (fallback behavior)
 *
 * A state without a `trajectory` is skipped. The marker DOM stays at the
 * lat/lng of its most recent WS fix (markers.js wrote that during
 * `createNewMarker` / `updateExistingMarker`). This is the same cold-start
 * behavior the legacy path has and covers:
 *   - First WS frame of a new vehicle (no snap yet → no trajectory).
 *   - Routes without polyline shape data (trajectoryBuilder returns null).
 *   - Trips whose `direction_id` reverses the polyline (arcs would be
 *     decreasing → builder rejects). Phase 5.4b can lift this restriction
 *     by introducing a per-trip signed arc translation; out of scope here.
 *
 * ## What this module does NOT do
 *
 *   - Marker creation/removal (markers.js owns lifecycle).
 *   - Spike rejection / fix validation (markers.js handles).
 *   - ETA reads (PR 4 wires `state.trajectory.timeAtArc` into predictions.js).
 *   - Cleanup of stale states (cleanup tick in a follow-up).
 */

import { USE_TRAJECTORY_MODEL, DR_MAX_SECONDS, DR_MAX_SECONDS_RAIL } from './config.js';
import { vehicleStateStore } from './phase5State.js';
import { lngLatAtArc } from './snap.js';
import { isBusRoute } from './utils.js';
import { recordRenderDrop } from './feedStats.js';

let _rafHandle = null;

/**
 * Drive one render frame. Exported for tests so the caller can step the
 * loop deterministically with synthetic state without scheduling rAFs.
 *
 * @param {number} nowSec  Current unix seconds (float OK; used for trajectory eval)
 * @returns {number}       Count of markers actually moved this tick (for testing).
 */
export function _renderTick(nowSec) {
    let moved = 0;
    for (const state of vehicleStateStore.values()) {
        const traj = state.trajectory;
        if (!traj) { recordRenderDrop('noTraj'); continue; }

        // Staleness gate — match the legacy DR window per mode so A/B looks
        // identical when the marker eventually freezes.
        const ageSec = nowSec - state.lastObservedAt;
        const maxAge = isBusRoute(String(state.routeId ?? '')) ? DR_MAX_SECONDS : DR_MAX_SECONDS_RAIL;
        if (ageSec > maxAge) { recordRenderDrop('stale'); continue; }

        const arc = traj.positionAt(nowSec);
        if (!Number.isFinite(arc)) continue;

        const pos = lngLatAtArc(String(state.routeId), arc);
        if (!pos) { recordRenderDrop('noShape'); continue; }

        const marker = window.vehicleMarkers?.[state.tripId];
        if (!marker?.setLngLat) continue;        // no MapLibre marker yet for this trip

        marker.setLngLat([pos.lng, pos.lat]);
        if (Number.isFinite(pos.tangent) && marker.setRotation) {
            marker.setRotation(pos.tangent);
        }
        moved++;
    }
    return moved;
}

/**
 * Schedule the rAF chain. Idempotent — calling twice is a no-op. Self-gates
 * on `USE_TRAJECTORY_MODEL` so callers don't have to wrap the call site.
 */
export function startTrajectoryRender() {
    if (!USE_TRAJECTORY_MODEL) return;
    if (_rafHandle != null) return;              // already running

    const loop = () => {
        _renderTick(Date.now() / 1000);
        _rafHandle = requestAnimationFrame(loop);
    };
    _rafHandle = requestAnimationFrame(loop);
}

/**
 * Stop the rAF chain. Tests reset between cases via this; production never
 * calls it (the loop runs for the lifetime of the page).
 */
export function _stopTrajectoryRender() {
    if (_rafHandle != null) {
        cancelAnimationFrame(_rafHandle);
        _rafHandle = null;
    }
}
