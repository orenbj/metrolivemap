/**
 * @module renderLoop
 *
 * Phase 5b — single rAF that drives marker position + rotation from a
 * blend-anchored Trajectory. Replaces the per-marker `_arcTick` /
 * `_bearingTick` loops in markers.js (deleted in commit 3 of the pivot).
 *
 * Per frame, for every AnimationEntry in `animationStore.animations`:
 *
 *   1. `arc = entry.trajectory.positionAt(now)`
 *   2. `{lat, lng, tangent} = lngLatAtArc(routeCode, arc)`
 *   3. Look up the MapLibre marker via `window.vehicleMarkers[tripId]`
 *      and update its position and rotation.
 *
 * The trajectory is back-computed from the blend ETA at the vehicle's
 * next stop (see `animationBuilder.buildAnimationTrajectory`). Animation
 * arrival time and popup ETA agree by construction — both consume the
 * same blend ETA.
 *
 * ## Runaway / overshoot protection — four layers
 *
 *   A. Builder-side speed clamp in `animationBuilder.js`.
 *   B. Trajectory `positionAt(t > t_end)` returns `arc_end` (in `trajectory.js`).
 *      This is what pins the marker at nextStopArc once it arrives — no
 *      separate per-frame cap is needed in this module.
 *   C. Staleness gate (`DR_MAX_SECONDS` / `DR_MAX_SECONDS_RAIL`) — this module.
 *   D. Anchor refresh on every WS fix (see `animationWiring.updateAnimationFor`).
 *
 * ## Skipped vehicles
 *
 * An entry without a trajectory is skipped (`recordRenderDrop('noTraj')`).
 * Caused by:
 *   - First WS frame of a new vehicle (no snap yet → no entry).
 *   - Routes without polyline shape data (`lngLatAtArc` returns null).
 *   - Trips whose direction reverses the polyline (decreasing arcs →
 *     builder rejects). Same deferred regression as the legacy path.
 *
 * The marker stays at whatever lat/lng the most recent WS fix wrote.
 *
 * ## What this module does NOT do
 *
 *   - Marker creation/removal (markers.js owns lifecycle).
 *   - Spike rejection / fix validation (markers.js handles).
 *   - ETA reads (popup ETA flows through `predictions.getScheduledArrivals`).
 *   - Cleanup of stale entries (animations are cleaned via
 *     `clearAnimationFor` in `_fadeOutAndRemove`).
 */

import { DR_MAX_SECONDS, DR_MAX_SECONDS_RAIL } from './config.js';
import { animations } from './animationStore.js';
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
    for (const entry of animations.values()) {
        const traj = entry.trajectory;
        if (!traj) { recordRenderDrop('noTraj'); continue; }

        // Layer C — staleness gate. Match the legacy DR window per mode so
        // a vehicle whose WS feed has gone silent freezes at its last
        // animated position rather than running open-loop.
        const ageSec = nowSec - entry.lastObservedAt;
        const maxAge = isBusRoute(String(entry.routeId ?? '')) ? DR_MAX_SECONDS : DR_MAX_SECONDS_RAIL;
        if (ageSec > maxAge) { recordRenderDrop('stale'); continue; }

        const arc = traj.positionAt(nowSec);
        if (!Number.isFinite(arc)) continue;

        // No per-frame stopArcCap here — Trajectory.positionAt already
        // clamps to arc_end once t > t_end (Layer B). A separate clamp
        // would actively pull the marker BACKWARD in the GTFS-RT-lag
        // case where currentArc > declared nextStopArc and the builder
        // emits a dwell at currentArc.

        const pos = lngLatAtArc(String(entry.routeId), arc);
        if (!pos) { recordRenderDrop('noShape'); continue; }

        const marker = window.vehicleMarkers?.[entry.tripId];
        if (!marker?.setLngLat) continue;        // no MapLibre marker yet for this trip

        marker.setLngLat([pos.lng, pos.lat]);
        if (Number.isFinite(pos.tangent) && marker.setRotation && !marker.atTerminus) {
            marker.setRotation(pos.tangent);
        }
        moved++;
    }
    return moved;
}

/**
 * Schedule the rAF chain. Idempotent — calling twice is a no-op.
 */
export function startAnimationRender() {
    if (_rafHandle != null) return;              // already running
    if (typeof requestAnimationFrame !== 'function') return;  // non-browser env

    const loop = () => {
        _renderTick(Date.now() / 1000);
        _rafHandle = requestAnimationFrame(loop);
    };
    _rafHandle = requestAnimationFrame(loop);
}

/**
 * Stop the rAF chain. Tests reset between cases via this; production
 * never calls it (the loop runs for the lifetime of the page).
 */
export function _stopAnimationRender() {
    if (_rafHandle != null) {
        cancelAnimationFrame(_rafHandle);
        _rafHandle = null;
    }
}
