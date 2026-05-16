/**
 * @module phase5Wiring
 *
 * Phase 5.2 orchestrator. Receives WebSocket frames from `api.js` (vehicle
 * positions) and `tripUpdates.js` (predicted arrivals) and updates the
 * trajectory-model singletons in `phase5State.js` accordingly.
 *
 * Callers gate the call sites with `USE_TRAJECTORY_MODEL`; the functions in
 * this module do NOT re-check the flag. This makes them directly testable
 * with synthetic frames without flag gymnastics.
 *
 * ## Vehicle position flow
 *
 * For each accepted GPS fix (post-spike-check, snapped):
 *   1. Resolve the route cache + this vehicle's `nextStopIdx`.
 *   2. Build the observation `{arc, velocity, t}` from the snap + feature.
 *   3. Dispatch:
 *        - STOPPED_AT → `applyStoppedAt(state, {arc: stop.arc, t})`
 *        - IN_TRANSIT_TO → `applyInTransitTo(state, {stopArc, t})`
 *        - Otherwise → `applyGpsFix(state, obs)`
 *   4. If no prior state exists, seed via `createState` first.
 *   5. Rebuild the trajectory via `buildTrajectoryFor` and stash via
 *      `withTrajectory`. Rebuild runs every fix in v1 — cheap (~O(stops)),
 *      simpler than diffing what changed.
 *   6. Store the new frozen state under tripId.
 *
 * ## Trip update flow
 *
 * For each `stopTimeUpdate` entry in a GTFS-RT `trip_update` frame:
 *   - Resolve the stop's arc from the route cache.
 *   - Call `applyTripUpdate(state, {stopArc, etaUnix, t})`.
 *   - v1 `applyTripUpdate` is a no-op except for `tickTime`. Phase 6 folds
 *     the prediction into a learned bias offset (see stateUpdaters.js doc).
 *
 * ## What this module does NOT do
 *
 *   - Spike rejection (caller in markers.js has already run that).
 *   - Marker DOM mutation (Phase 5.4 render loop reads state and writes DOM).
 *   - Removing stale state (Phase 5.4 cleanup tick handles archive/prune).
 *
 * ## Return values
 *
 * Every public function returns the new frozen state on success (useful for
 * tests) or `null` if the frame couldn't be ingested (missing cache, no
 * arc data for this route, malformed inputs). Callers ignore the return
 * value in production.
 */

import { isStoppedAt, isBusRoute } from './utils.js';
import { getRouteCache, findIdx } from './predictions.js';
import { createState, withTrajectory } from './vehicleState.js';
import { applyGpsFix, applyStoppedAt, applyInTransitTo, applyTripUpdate } from './stateUpdaters.js';
import { vehicleStateStore, dwellModel } from './phase5State.js';
import { buildTrajectoryFor, serviceDateMidnightUnixFor } from './trajectoryBuilder.js';

/**
 * GTFS-RT vehicle.currentStatus enum values per spec:
 *   0 = INCOMING_AT  (vehicle is approaching the stop)
 *   1 = STOPPED_AT
 *   2 = IN_TRANSIT_TO
 * Metro can also emit the string form, which `isStoppedAt` already handles
 * for the STOPPED_AT case. Mirror that for IN_TRANSIT_TO.
 */
const _isInTransitTo = status => status === 2 || status === 'IN_TRANSIT_TO';

/**
 * Ingest one accepted, snapped GPS fix into the trajectory-model store.
 *
 * The caller (markers.js, after the existing snap + spike-rejection gates)
 * provides the feature + snap so we don't repeat that work here.
 *
 * @param {Object} feature  GeoJSON feature with .properties (route_code, trip_id,
 *                          vehicle_id, direction_id, stopId, currentStatus,
 *                          position_speed, timestamp)
 * @param {Object} snap     {arcMeters, snappedLat, snappedLng, ...} from snap.js
 * @param {number} ts       Frame timestamp in unix seconds
 * @returns {Readonly<Object>|null}  the new state, or null on ingest failure
 */
export function ingestVehicleFix(feature, snap, ts) {
    const props = feature?.properties;
    if (!props || !snap) return null;
    const { route_code, trip_id, vehicle_id, direction_id, stopId, currentStatus } = props;
    if (!trip_id || !route_code) return null;
    if (direction_id == null) return null;       // ambiguous direction → can't pick arcs
    if (!Number.isFinite(snap.arcMeters)) return null;

    const dir = Number(direction_id);
    const cache = getRouteCache(String(route_code), dir);
    // No cache → no upcoming stops → no trajectory. Caller handles fallback.
    if (!cache?.arcMeters?.length) return null;

    const nextStopIdx = stopId != null ? findIdx(cache.stops, String(stopId)) : -1;
    if (nextStopIdx < 0) return null;            // nextStop not in this trip's stop list

    // Speed: GTFS-RT carries m/s in position.speed; api.js normalised to position_speed.
    const velocity = Math.max(0, Number(props.position_speed) || 0);
    const arc      = snap.arcMeters;

    // Resolve prior state and pick the right Kalman updater.
    let state = vehicleStateStore.get(trip_id);
    const stoppedAtNext = isStoppedAt(currentStatus);
    const inTransitToNext = _isInTransitTo(currentStatus);
    const stopArc = cache.arcMeters[nextStopIdx];
    const stopArcFinite = Number.isFinite(stopArc);

    if (!state) {
        // Seed initial state. Apply the very first observation directly (no
        // tick — no prior time to tick from). Use the GPS fix for v_now and
        // arc_now regardless of currentStatus; on the NEXT fix the proper
        // STOPPED_AT/IN_TRANSIT_TO updater fires against this seeded state.
        try {
            state = createState({
                vehicleId:   String(vehicle_id ?? ''),
                tripId:      String(trip_id),
                routeId:     String(route_code),
                directionId: dir,
                arc, velocity,
                t_now: ts,
            });
        } catch {
            // createState validates non-empty vehicleId/tripId; tripId already
            // checked, vehicleId may be '' for Metro frames that omit it. Use
            // the tripId as a stand-in so createState's invariant holds.
            state = createState({
                vehicleId:   String(trip_id),
                tripId:      String(trip_id),
                routeId:     String(route_code),
                directionId: dir,
                arc, velocity,
                t_now: ts,
            });
        }
    } else if (stoppedAtNext && stopArcFinite) {
        state = applyStoppedAt(state, { arc: stopArc, t: ts });
    } else if (inTransitToNext && stopArcFinite) {
        state = applyInTransitTo(state, { stopArc, t: ts });
    } else {
        state = applyGpsFix(state, { arc, velocity, t: ts });
    }

    // Rebuild trajectory after every state update. Cheap enough at the scale
    // of one Metro fleet that diffing-then-rebuilding isn't worth the
    // complexity. Optimise later if profiling shows it matters.
    const trajectory = buildTrajectoryFor({
        t_now: state.lastObservedAt,
        arc_now: state.arc,
        v_now: state.velocity,
        cache,
        nextStopIdx,
        routeId: String(route_code),
        directionId: dir,
        dwellModel,
        serviceDateMidnightUnix: serviceDateMidnightUnixFor(ts * 1000),
    });

    state = withTrajectory(state, trajectory, state.lastObservedAt);
    vehicleStateStore.set(state);
    return state;
}

/**
 * Record an observed STOPPED_AT dwell duration into the dwell learner.
 *
 * Called by markers.js when a vehicle transitions OUT of STOPPED_AT (we know
 * the dwell only after it ends). Pure pass-through into `dwellModel.record`
 * with the right shape — keeps the markers.js call site short.
 *
 * @param {Object} obs
 * @param {string} obs.stopId
 * @param {string} obs.routeId
 * @param {number} obs.directionId
 * @param {number} obs.observedSec
 */
export function recordObservedDwell({ stopId, routeId, directionId, observedSec }) {
    return dwellModel.record({ stopId, routeId, directionId, observedSec });
}

/**
 * Ingest one GTFS-RT trip_update frame's stop_time_update entries.
 *
 * v1: each entry funnels through `applyTripUpdate` which is currently a
 * `tickTime` no-op (Phase 6 turns this into a bias-learner). We wire the
 * call site now so Phase 6 only has to fill in the updater, not also wire
 * the trip_updates feed through.
 *
 * @param {string} tripId
 * @param {Array<{stopId:string, arrival?:{time:number}, departure?:{time:number}}>} stopTimeUpdates
 * @param {string} routeCode
 * @param {number} directionId
 * @param {number} t_now  unix seconds
 * @returns {Readonly<Object>|null}
 */
export function ingestTripUpdate(tripId, stopTimeUpdates, routeCode, directionId, t_now) {
    if (!tripId || !Array.isArray(stopTimeUpdates) || stopTimeUpdates.length === 0) return null;
    const dir = Number(directionId);
    if (!Number.isFinite(dir)) return null;
    const cache = getRouteCache(String(routeCode), dir);
    if (!cache?.arcMeters?.length) return null;

    let state = vehicleStateStore.get(tripId);
    if (!state) return null;  // no kinematic state yet — nothing to fold the prediction into

    for (const stu of stopTimeUpdates) {
        const sid = String(stu?.stopId ?? '');
        if (!sid) continue;
        const idx = findIdx(cache.stops, sid);
        if (idx < 0) continue;
        const stopArc = cache.arcMeters[idx];
        if (!Number.isFinite(stopArc)) continue;
        const etaUnix = Number(stu?.arrival?.time ?? stu?.departure?.time);
        if (!Number.isFinite(etaUnix)) continue;

        state = applyTripUpdate(state, { stopArc, etaUnix, t: t_now });
    }

    vehicleStateStore.set(state);
    return state;
}
