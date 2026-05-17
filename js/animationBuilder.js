/**
 * @module animationBuilder
 *
 * Build a Trajectory whose `positionAt(blendEtaUnix)` equals the next-stop
 * arc. Animation is anchored to the GTFS-RT-derived blend ETA — the popup's
 * ETA and the marker's arrival at the next stop are the same number by
 * construction.
 *
 * Inputs come from `marker.lastSnap.arcMeters` (current arc),
 * `cache.arcMeters[nextStopIdx]` (next-stop arc), and the per-trip blend
 * ETA at the next stop (`predictions._blendArrivals` result or
 * `masterArrivalsData` entry).
 *
 * The output Trajectory is normally a single `free` segment from now →
 * arriveUnix. The Trajectory class's terminal-arc clamp in `positionAt`
 * already pins the marker at `nextStopArc` once t > arriveUnix — no
 * trailing dwell needed for visual correctness, and dwell segments
 * would interact awkwardly with `timeAtArc(nextStopArc)` (returns the
 * dwell's end-time instead of arrive-time).
 *
 * Special cases that emit a single dwell instead of a free segment:
 *   - Vehicle already at or past the next-stop arc.
 *   - GPS reports speed=0 with a fresh timestamp — vehicle declares
 *     it's stopped; honor that over blend's back-computed creep.
 *   - blendEtaUnix is null but a schedule fallback speed is supplied →
 *     use the fallback. Animation still works during the first ~5 s
 *     before the first blend ETA refresh lands for a new marker.
 *   - Both blend and fallback missing → return null. renderLoop falls
 *     back to "marker stays at last GPS snap".
 *
 * Pure function — no globals, no DOM, no MapLibre.
 */

import { Trajectory } from './trajectory.js';
import { isBusRoute } from './utils.js';
import { recordTrajectoryDrop } from './feedStats.js';

/**
 * Dwell duration emitted for the at-stop and GPS-stopped special cases.
 * For normal cruise-to-stop trajectories no dwell is emitted — the
 * Trajectory class's terminal-arc clamp in `positionAt` already pins
 * the marker at `nextStopArc` once t > arriveUnix. The dwell here is
 * specifically for trajectories whose ENTIRE shape is "hold position"
 * (currentArc already past nextStopArc, or vehicle declares stopped),
 * which need a non-empty segment list to satisfy Trajectory's contract.
 */
const POST_ARRIVAL_DWELL_S = 60;

/**
 * Floor + ceiling on the back-computed animation speed.
 *
 * Floor (0.05 m/s = 5 cm/s): sanity guard against `0`, `null`, or NaN slipping
 * through the back-computation. NOT a defense against runaway — those are
 * handled by the `blendEtaUnix > nowUnix` guard (negative horizon) and the
 * MAX clamp (zero horizon → huge speed). Earlier this floor was 1 m/s; that
 * was too aggressive — it forced the marker to arrive ~27 minutes before
 * the popup said it would when blend predicts a long dispatcher hold (e.g.
 * 200 m away, 30 min ETA = 0.11 m/s back-computed). 0.05 m/s keeps the
 * marker essentially stationary AND respects blend's prediction within
 * the visual tolerance riders care about.
 *
 * Ceiling: 22 m/s rail / 17 m/s bus reflects Metro's revenue-service
 * top speed envelope. A blend ETA implying faster than this is hostile
 * (probably a fresh fix landed with a stale ETA) and we'd rather have
 * the marker arrive slightly LATE than visibly teleport.
 */
const MIN_ANIM_MPS_RAIL = 0.05;
const MAX_ANIM_MPS_RAIL = 22.0;
const MIN_ANIM_MPS_BUS  = 0.05;
const MAX_ANIM_MPS_BUS  = 17.0;

/**
 * Window during which a GPS speed=0 report is treated as authoritative
 * "vehicle is stopped." After this, we revert to blend-anchored motion —
 * a vehicle that has gone silent for 60 s is unlikely to have been parked
 * for that long; more likely lost GPS.
 */
const GPS_STOPPED_FRESHNESS_S = 60;

/**
 * Build the animation trajectory for one vehicle.
 *
 * @param {Object} params
 * @param {string} params.routeCode      Route code (for envelope selection)
 * @param {number} params.nowUnix         Current wall-clock unix seconds
 * @param {number} params.currentArc      Vehicle's last snapped arc (metres)
 * @param {number} params.nextStopArc     Next-stop arc on the polyline (metres)
 * @param {number|null} params.blendEtaUnix  Per-(trip, nextStop) blend ETA, or null
 * @param {number|null} params.fallbackSpeedMps  Schedule cruise fallback when blend ETA is null
 * @param {number|null} [params.gpsSpeedMps]     Vehicle's reported GPS speed (m/s) for the stopped-honor rule
 * @param {number|null} [params.gpsTimestamp]    Unix s of the GPS fix that produced gpsSpeedMps
 * @returns {Trajectory|null}
 */
export function buildAnimationTrajectory({
    routeCode, nowUnix, currentArc, nextStopArc,
    blendEtaUnix, fallbackSpeedMps,
    gpsSpeedMps = null, gpsTimestamp = null,
}) {
    if (!Number.isFinite(currentArc) || !Number.isFinite(nextStopArc)) {
        recordTrajectoryDrop('missingArc');
        return null;
    }

    // Apply the hard "marker cannot pass next stop" cap at the input.
    // This is a MANDATORY invariant — under no circumstances should the
    // marker visually exceed nextStopArc, even when GPS lands past the
    // declared next stop (GTFS-RT lag scenario: vehicle physically past
    // the stop but `marker.properties.stopId` hasn't updated yet).
    //
    // The "don't pull backwards" rule applies to GPS-pullback suppression
    // in markers._applyVelocityCorrections (where a fresh GPS fix landing
    // behind the projected marker is suppressed for visual smoothness).
    // It does NOT apply here: a marker SHOULD visually stop at the
    // declared next stop, even if GPS truth puts it further along the
    // line. The next WS fix will update stopId and the trajectory will
    // rebuild targeting the new next stop.
    const capArc = Math.min(currentArc, nextStopArc);

    // Honor a fresh "vehicle is stopped" report from GPS over blend's
    // back-computed creep. If the vehicle says it's stopped and we
    // believe the fix is recent, the marker should not move regardless
    // of what blend predicts arrival time to be. Dwell at capArc (which
    // is min(currentArc, nextStopArc)) so a past-the-stop GPS fix still
    // visually arrives at the stop, not past it.
    if (gpsSpeedMps === 0
        && Number.isFinite(gpsTimestamp)
        && (nowUnix - gpsTimestamp) < GPS_STOPPED_FRESHNESS_S) {
        return new Trajectory([{
            kind: 'dwell',
            t_start: nowUnix, t_end: nowUnix + POST_ARRIVAL_DWELL_S,
            arc_start: capArc, arc_end: capArc,
            v_start: 0, v_end: 0,
        }]);
    }

    // Vehicle at or past the next-stop arc (GTFS-RT lag, or normal
    // arrival). Dwell at nextStopArc — never past it. The next WS fix
    // will either confirm the arrival (STOPPED_AT) or update stopId to
    // the new next stop, at which point the trajectory rebuilds forward
    // from the GPS truth.
    if (nextStopArc <= currentArc) {
        return new Trajectory([{
            kind: 'dwell',
            t_start: nowUnix, t_end: nowUnix + POST_ARRIVAL_DWELL_S,
            arc_start: nextStopArc, arc_end: nextStopArc,
            v_start: 0, v_end: 0,
        }]);
    }

    const isBus  = isBusRoute(String(routeCode));
    const minMps = isBus ? MIN_ANIM_MPS_BUS  : MIN_ANIM_MPS_RAIL;
    const maxMps = isBus ? MAX_ANIM_MPS_BUS  : MAX_ANIM_MPS_RAIL;

    const distToStop = nextStopArc - currentArc;

    let speedMps;
    if (Number.isFinite(blendEtaUnix) && blendEtaUnix > nowUnix) {
        const horizonS = blendEtaUnix - nowUnix;
        speedMps = distToStop / horizonS;            // back-computed cruise
    } else if (Number.isFinite(fallbackSpeedMps) && fallbackSpeedMps > 0) {
        speedMps = fallbackSpeedMps;                 // pre-blend cold start
    } else {
        // No anchor at all — caller (renderLoop) treats this as "marker
        // stays at last GPS snap." Counted for observability.
        recordTrajectoryDrop('noBlendAnchor');
        return null;
    }

    // Layer A — operational-envelope clamp. After this, the marker may
    // arrive earlier (clamped up) or later (clamped down) than blend
    // predicted in pathological cases; the trailing dwell + next refresh
    // catch both.
    speedMps = Math.min(maxMps, Math.max(minMps, speedMps));

    const transitDurationS = distToStop / speedMps;
    const arriveUnix       = nowUnix + transitDurationS;

    // Single `free` segment. The Trajectory's positionAt clamps at
    // arc_end for t > arriveUnix, so the marker visually pins at the
    // stop arc once it gets there — no trailing dwell needed. And
    // timeAtArc(nextStopArc) returns exactly arriveUnix, which is the
    // load-bearing contract the popup ETA agreement depends on.
    return new Trajectory([{
        kind: 'free',
        t_start: nowUnix, t_end: arriveUnix,
        arc_start: currentArc, arc_end: nextStopArc,
        v_start: speedMps, v_end: speedMps,
    }]);
}

// Exported for test consumption only.
export const _BOUNDS = {
    MIN_ANIM_MPS_RAIL, MAX_ANIM_MPS_RAIL,
    MIN_ANIM_MPS_BUS,  MAX_ANIM_MPS_BUS,
    POST_ARRIVAL_DWELL_S, GPS_STOPPED_FRESHNESS_S,
};
