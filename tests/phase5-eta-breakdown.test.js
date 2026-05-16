/**
 * Tests for the `trajectoryEta` column added to getArrivalBreakdown in
 * Phase 5.6 (PR #173). The harness consumes this for paired (calc, gtfs,
 * blend, trajectory) capture in a single window — no alternating-day
 * production runs required.
 *
 * Coverage:
 *   - State exists with trajectory + target ahead → trajectoryEta populated
 *   - State exists but no trajectory → trajectoryEta is null
 *   - State exists but vehicle is past target arc → trajectoryEta is null
 *   - No state exists for this trip → trajectoryEta is null
 *   - Existing columns (calcEta, gtfsEta, blendEta) still produced
 *
 * The integration runs through the real getArrivalBreakdown function, so
 * route-cache + marker + masterTripsData all need to be seeded.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { getArrivalBreakdown, initPredictions, _clearRouteStopsCache } from '../js/predictions.js';
import { vehicleStateStore } from '../js/phase5State.js';
import { createState, withTrajectory } from '../js/vehicleState.js';
import { Trajectory } from '../js/trajectory.js';

const NOW_SEC = 1_700_000_000;
let _origDateNow;
beforeAll(() => {
    _origDateNow = Date.now;
    Date.now = () => NOW_SEC * 1000;
    // localStorage shim for the DwellModel construct in phase5State.
    const store = {};
    Object.defineProperty(window, 'localStorage', {
        value: {
            getItem(k)    { return store[k] ?? null; },
            setItem(k, v) { store[k] = String(v); },
            removeItem(k) { delete store[k]; },
            clear()       { for (const k of Object.keys(store)) delete store[k]; },
        },
        writable: true, configurable: true,
    });
});
afterAll(() => { Date.now = _origDateNow; });

function makeFreeTraj({ arc_start, v, durationSec = 300 }) {
    return new Trajectory([{
        kind: 'free',
        t_start: NOW_SEC, t_end: NOW_SEC + durationSec,
        arc_start, arc_end: arc_start + v * durationSec,
        v_start: v, v_end: v,
    }]);
}

// Minimal marker shape getArrivalBreakdown reads.
function makeMarker({ tripId, routeCode, dir, vehicleId, stopId, currentStatus = 'IN_TRANSIT_TO' }) {
    return {
        timestamp: NOW_SEC - 1,
        lastSnap: { arcMeters: 0, snappedLat: 0, snappedLng: 0 },
        lastSnapDeviationM: 5,
        route_code: routeCode,
        properties: {
            vehicle_id: vehicleId, trip_id: tripId, route_code: routeCode,
            direction_id: dir, stopId, currentStatus,
            statusChangedAt: NOW_SEC - 60,
            position_speed: 10,
        },
    };
}

async function seedCacheAndTrip({ routeCode, dir, stops, scheduledTimes, arcMeters }) {
    const tripId = `T-${routeCode}-${dir}`;
    window.masterTripsData = {
        [tripId]: { rc: routeCode, dir, stops, scheduledTimes },
    };
    _clearRouteStopsCache();
    initPredictions();
    const { getRouteCache } = await import('../js/predictions.js');
    const cache = getRouteCache(routeCode, dir);
    if (cache) cache.arcMeters = arcMeters;
    return { tripId, cache };
}

beforeEach(() => {
    vehicleStateStore.clear();
    window.vehicleMarkers = {};
    window.masterArrivalsData = new Map();
});

describe('getArrivalBreakdown — trajectoryEta column', () => {
    it('populates trajectoryEta when state has trajectory and target is ahead', async () => {
        const { tripId } = await seedCacheAndTrip({
            routeCode: '801', dir: 0,
            stops: ['A', 'B', 'C'],
            scheduledTimes: [21600, 21720, 21840],
            arcMeters: [0, 1000, 2000],
        });
        window.vehicleMarkers.T1 = makeMarker({
            tripId: 'T1', routeCode: '801', dir: 0,
            vehicleId: 'V1', stopId: 'B',
        });
        // State at arc=500 m, moving 10 m/s. Target B is at arc 1000 → 500 m / 10 m/s = 50 s
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 500, velocity: 10, t_now: NOW_SEC,
        });
        state = withTrajectory(state, makeFreeTraj({ arc_start: 500, v: 10 }), NOW_SEC);
        vehicleStateStore.set(state);

        const rows = getArrivalBreakdown('B');
        expect(rows).toHaveLength(1);
        expect(rows[0].trajectoryEta).toBeCloseTo(NOW_SEC + 50, 0);
    });

    it('leaves trajectoryEta null when state has no trajectory yet', async () => {
        await seedCacheAndTrip({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [21600, 21720], arcMeters: [0, 1000],
        });
        window.vehicleMarkers.T1 = makeMarker({
            tripId: 'T1', routeCode: '801', dir: 0,
            vehicleId: 'V1', stopId: 'B',
        });
        vehicleStateStore.set(createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 500, velocity: 10, t_now: NOW_SEC,
            // intentionally NO trajectory
        }));

        const rows = getArrivalBreakdown('B');
        expect(rows[0].trajectoryEta).toBeNull();
    });

    it('leaves trajectoryEta null when state.arc has already crossed the target', async () => {
        await seedCacheAndTrip({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [21600, 21720], arcMeters: [0, 1000],
        });
        window.vehicleMarkers.T1 = makeMarker({
            tripId: 'T1', routeCode: '801', dir: 0,
            vehicleId: 'V1', stopId: 'B',
        });
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 1500, velocity: 10, t_now: NOW_SEC,  // already past B
        });
        state = withTrajectory(state, makeFreeTraj({ arc_start: 1500, v: 10 }), NOW_SEC);
        vehicleStateStore.set(state);

        const rows = getArrivalBreakdown('B');
        expect(rows[0].trajectoryEta).toBeNull();
    });

    it('leaves trajectoryEta null when no state exists for the trip', async () => {
        await seedCacheAndTrip({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [21600, 21720], arcMeters: [0, 1000],
        });
        window.vehicleMarkers['T-no-state'] = makeMarker({
            tripId: 'T-no-state', routeCode: '801', dir: 0,
            vehicleId: 'V1', stopId: 'B',
        });
        // No state.set — store is empty for T-no-state

        const rows = getArrivalBreakdown('B');
        expect(rows[0].trajectoryEta).toBeNull();
    });

    it('still produces calcEta, gtfsEta, blendEta alongside trajectoryEta', async () => {
        await seedCacheAndTrip({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [21600, 21720], arcMeters: [0, 1000],
        });
        window.vehicleMarkers.T1 = makeMarker({
            tripId: 'T1', routeCode: '801', dir: 0,
            vehicleId: 'V1', stopId: 'B',
        });
        // Seed GTFS-RT entry so gtfsEta + blendEta are non-null
        window.masterArrivalsData.set('B', [{
            routeId: '801', directionId: 0,
            vehicleId: 'V1', tripId: 'T1',
            arrivalUnix: NOW_SEC + 90,
            lastIngestUnix: NOW_SEC - 5,
        }]);
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 500, velocity: 10, t_now: NOW_SEC,
        });
        state = withTrajectory(state, makeFreeTraj({ arc_start: 500, v: 10 }), NOW_SEC);
        vehicleStateStore.set(state);

        const rows = getArrivalBreakdown('B');
        expect(rows).toHaveLength(1);
        const r = rows[0];
        // All four columns present
        expect(r.gtfsEta).toBe(NOW_SEC + 90);
        expect(r.trajectoryEta).toBeCloseTo(NOW_SEC + 50, 0);
        expect(r).toHaveProperty('calcEta');
        expect(r).toHaveProperty('blendEta');
    });
});
