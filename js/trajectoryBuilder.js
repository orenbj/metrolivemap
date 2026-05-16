/**
 * @module trajectoryBuilder
 *
 * Pure builder: given a vehicle's current anchor (arc, velocity, time) and
 * the route's stop cache, project a {@link Trajectory} forward through all
 * upcoming stops on the trip.
 *
 * Phase 5.2 wiring lives in [`phase5Wiring.js`](./phase5Wiring.js) — this
 * module owns just the cache-shape ↔ `fromAnchor` translation. Pure function;
 * no globals, no DOM, no MapLibre, no `window.*`. Importable from tests
 * without environment setup.
 *
 * ## Inputs
 *
 *   - `cache`           A `{stops, times, arcMeters}` shape produced by
 *                       `predictions.getRouteCache(routeCode, dir)`.
 *   - `nextStopIdx`     Index into `cache.stops` of the vehicle's NEXT stop
 *                       (i.e. the stop the vehicle hasn't reached yet).
 *   - `arc_now, v_now`  Current snapped position + velocity.
 *   - `t_now`           Anchor wall-clock time (unix seconds).
 *   - `dwellModel`      Per-(stop, route, dir) dwell learner.
 *   - `serviceDateMidnightUnix`  Unix seconds for the SERVICE day's local
 *                       midnight (caller computes from current time). The
 *                       cache's `times[i]` is seconds-since-midnight; this
 *                       value is the base unix offset to convert to
 *                       absolute wall-clock for the trajectory's `hold`
 *                       segments.
 *
 * ## Cruise speed
 *
 * The Trajectory's `cruise` parameter accepts a function `(stopIdx) → m/s`.
 * We derive each segment's cruise from the SCHEDULE — `dist / dt` between
 * the consecutive stop pairs in the cache — rather than the current GPS
 * speed. Rationale:
 *
 *   1) GPS speed reflects an instant; the trajectory needs a typical speed
 *      for that physical segment.
 *   2) Vehicles at speed=0 (red light / dwell completion) still need a
 *      sensible cruise for the next free segment.
 *   3) Schedule-derived cruise is the same input `predictions._blendArrivals`
 *      already uses for its calc-side ETA — keeping it here keeps the two
 *      paths comparable during A/B validation in Phase 8.
 *
 * The kinematic decel zone is `fromAnchor`'s job — it picks a kinematic
 * deceleration into each stop. v1 uses a constant rate (`DEFAULT_DECEL_MPS2 = 1`
 * in trajectory.js); Phase 6's variance learner may swap that to a per-route
 * value.
 *
 * ## Returns
 *
 *   - `Trajectory`  on success (at least one valid upcoming stop)
 *   - `null`        if the cache lacks `arcMeters` (route has no shape data,
 *                   e.g. bus routes without polylines) OR if no upcoming
 *                   stop in the cache has a finite arc.
 *
 * Callers fall back to the legacy DR / blend path when this returns null.
 */

import { fromAnchor } from './trajectory.js';
import { isBusRoute } from './utils.js';

/**
 * @param {Object}   params
 * @param {number}   params.t_now                   Anchor unix seconds
 * @param {number}   params.arc_now                 Current arc-meters
 * @param {number}   params.v_now                   Current velocity m/s
 * @param {Object}   params.cache                   {stops, times, arcMeters}
 * @param {number}   params.nextStopIdx             Index of next stop in cache
 * @param {string}   params.routeId                 Route code for dwell lookup
 * @param {number}   params.directionId             0 | 1
 * @param {DwellModel} params.dwellModel
 * @param {number}   params.serviceDateMidnightUnix Unix seconds at service-day local midnight
 * @returns {Trajectory|null}
 */
export function buildTrajectoryFor({
    t_now, arc_now, v_now,
    cache, nextStopIdx,
    routeId, directionId,
    dwellModel,
    serviceDateMidnightUnix,
}) {
    if (!cache?.arcMeters?.length) return null;
    if (!Number.isFinite(arc_now) || !Number.isFinite(v_now) || !Number.isFinite(t_now)) return null;
    if (!Number.isFinite(nextStopIdx) || nextStopIdx < 0 || nextStopIdx >= cache.stops.length) return null;

    const isBus = isBusRoute(String(routeId));

    // Build upcoming-stops list. Skip any stop whose arc is null (a cache row
    // for a stop snap.js couldn't resolve). The trajectory still projects to
    // the next finite-arc stop — better partial than no trajectory at all.
    const stops = [];
    for (let i = nextStopIdx; i < cache.stops.length; i++) {
        const arc = cache.arcMeters[i];
        if (!Number.isFinite(arc)) continue;

        const stopId = cache.stops[i];
        const dwellSec = dwellModel.get({
            stopId, routeId, directionId, isBus, t: t_now,
        });
        // cache.times[i] is seconds-since-midnight; convert to absolute unix.
        // Values > 86400 are owl-service overflow and convert correctly because
        // we're just adding seconds to a unix base.
        const schedSec = cache.times?.[i];
        const scheduled_time = Number.isFinite(schedSec)
            ? serviceDateMidnightUnix + schedSec
            : null;

        stops.push({ arc, dwell_s: dwellSec, scheduled_time });
    }

    if (stops.length === 0) return null;

    // Schedule-derived cruise: for the FIRST stop in the trajectory (segIdx=0)
    // we look up the cache's "this stop ← prior stop" segment speed. For
    // subsequent stops, "this stop ← previous stop in our slice". Returning
    // null falls back to v_now inside fromAnchor.
    const cruiseFn = (segIdx) => {
        const targetIdx = nextStopIdx + segIdx;
        const prevIdx   = targetIdx - 1;
        if (prevIdx < 0 || targetIdx >= cache.stops.length) return null;
        const prevArc  = cache.arcMeters[prevIdx];
        const curArc   = cache.arcMeters[targetIdx];
        const prevTime = cache.times?.[prevIdx];
        const curTime  = cache.times?.[targetIdx];
        if (!Number.isFinite(prevArc) || !Number.isFinite(curArc))   return null;
        if (!Number.isFinite(prevTime) || !Number.isFinite(curTime)) return null;
        const dist = curArc - prevArc;
        const dt   = curTime - prevTime;
        if (dist <= 0 || dt <= 0) return null;
        return dist / dt;
    };

    return fromAnchor({
        t_now, arc_now, v_now,
        stops,
        cruise: cruiseFn,
    });
}

/**
 * Compute the unix-seconds offset of the service day's local midnight.
 *
 * Metro's true service-day boundary is around 03:00 local — owl trips
 * crossing midnight still belong to the previous service date. v1 uses
 * the simpler local-midnight rule that `main.js _serviceDateKey` uses;
 * if A/B captures show the rollover materially affects ETA accuracy we
 * shift to the 03:00 boundary in a follow-up.
 *
 * @param {Date|number} [refMs]  Reference moment (Date or ms-unix). Default: now.
 * @returns {number}             Unix seconds at local midnight of that day.
 */
export function serviceDateMidnightUnixFor(refMs) {
    const d = refMs instanceof Date ? new Date(refMs.getTime())
            : Number.isFinite(refMs) ? new Date(refMs)
            : new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
}
