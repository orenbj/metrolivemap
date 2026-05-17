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
 * ## Runaway / overshoot protection — five layers
 *
 *   A. Builder-side speed clamp in `animationBuilder.js`.
 *   B. Builder-side arc cap — `currentArc` is clamped to `nextStopArc` at
 *      input so the trajectory's `arc_end` always equals `nextStopArc`
 *      (`animationBuilder.js`).
 *   C. Staleness gate (`DR_MAX_SECONDS` / `DR_MAX_SECONDS_RAIL`) — this module.
 *   D. Per-frame `stopArcCap` re-check — MANDATORY invariant: the marker
 *      must NEVER animate past the declared next stop. Defense in depth
 *      on top of the builder's input cap and Trajectory's terminal-arc
 *      clamp — this module.
 *   E. Anchor refresh on every WS fix (see `animationWiring.updateAnimationFor`).
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

        let arc = traj.positionAt(nowSec);
        if (!Number.isFinite(arc)) continue;

        // Layer D — per-frame next-stop arc cap. MANDATORY invariant: the
        // marker must NEVER animate past the declared next stop. This is
        // defense-in-depth on top of the builder's input cap and
        // Trajectory.positionAt's terminal-arc clamp. If a future builder
        // bug, edge case, or hostile inputs slip a too-large arc through,
        // the renderer still pins it at nextStopArc — the rider never
        // sees a marker past the station, ever.
        let atStop = false;
        if (Number.isFinite(entry.nextStopArc) && arc >= entry.nextStopArc - 0.5) {
            if (arc > entry.nextStopArc) recordRenderDrop('stopArcCap');
            arc = entry.nextStopArc;
            atStop = true;
        }

        const pos = lngLatAtArc(String(entry.routeId), arc);
        if (!pos) { recordRenderDrop('noShape'); continue; }

        const marker = window.vehicleMarkers?.[entry.tripId];
        if (!marker?.setLngLat) continue;        // no MapLibre marker yet for this trip

        // When the marker is AT the declared next stop, snap visually to
        // the station's EXACT geographic coords (from masterStopsData),
        // not the polyline's projection of them. The polyline often runs
        // alongside the station icon with a ~30-100 m offset; using the
        // polyline projection here would leave the marker visibly past
        // the station icon even though the arc cap is firing correctly.
        // For in-transit positions (arc < nextStopArc), we keep using
        // lngLatAtArc so the marker tracks the polyline correctly.
        const lng = atStop && Number.isFinite(entry.nextStopLng) ? entry.nextStopLng : pos.lng;
        const lat = atStop && Number.isFinite(entry.nextStopLat) ? entry.nextStopLat : pos.lat;

        marker.setLngLat([lng, lat]);
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
