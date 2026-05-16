/**
 * Tests for the trajectory-model ETA path in predictions.js.
 *
 * The dispatcher in `getScheduledArrivals` reads `USE_TRAJECTORY_MODEL` at
 * call time (module-level const). Rather than juggle the flag in tests, we
 * call the underlying `_getTrajectoryArrivals` directly and verify it
 * produces the expected shape against synthetic state.
 *
 * Coverage:
 *   - State with trajectory + target ahead → arrival with timeAtArc result
 *   - State without trajectory → skipped
 *   - State already past the target stop → skipped
 *   - Multiple vehicles → all returned, sorted ascending
 *   - GTFS-only entries appended for trips with no state
 *   - 2-per-direction cap matches legacy
 *   - Past arrivals beyond grace are filtered out
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { _getTrajectoryArrivals, initPredictions, _clearRouteStopsCache } from '../js/predictions.js';
import { vehicleStateStore } from '../js/phase5State.js';
import { createState, withTrajectory } from '../js/vehicleState.js';
import { Trajectory } from '../js/trajectory.js';

// Stub the time so PAST_ARRIVAL_GRACE_S and timing comparisons are deterministic.
// Date.now() controls Math.floor(Date.now()/1000) inside the function.
const NOW_SEC = 1_700_000_000;
let _origDateNow;
beforeAll(() => {
    _origDateNow = Date.now;
    Date.now = () => NOW_SEC * 1000;
});
afterAll(() => { Date.now = _origDateNow; });

// jsdom doesn't include localStorage by default in our setup; the trajectory
// path itself doesn't touch it, but phase5State eagerly imports DwellModel
// which DOES try to read at construction. Provide a shim.
beforeAll(() => {
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

function makeFreeTraj({ arc_start, v, t_start, durationSec }) {
    return new Trajectory([{
        kind: 'free',
        t_start, t_end: t_start + durationSec,
        arc_start, arc_end: arc_start + v * durationSec,
        v_start: v, v_end: v,
    }]);
}

function makeState({ tripId, routeId, directionId, vehicleId, arc, velocity, traj }) {
    let s = createState({
        vehicleId, tripId, routeId, directionId,
        arc, velocity, t_now: NOW_SEC,
    });
    if (traj) s = withTrajectory(s, traj, NOW_SEC);
    return s;
}

// Seed predictions' route cache for trip data. The cache normally builds via
// initPredictions() from masterTripsData; arcMeters get added by snap.js
// lookups. In tests we mutate the cache directly after init.
async function seedCache({ routeCode, dir, stops, scheduledTimes, arcMeters }) {
    window.masterTripsData = {
        [`T-${routeCode}-${dir}`]: { rc: routeCode, dir, stops, scheduledTimes },
    };
    _clearRouteStopsCache();
    initPredictions();
    const { getRouteCache } = await import('../js/predictions.js');
    const cache = getRouteCache(routeCode, dir);
    if (cache) cache.arcMeters = arcMeters;
    return cache;
}

beforeEach(() => {
    vehicleStateStore.clear();
    window.masterArrivalsData = new Map();
});

describe('_getTrajectoryArrivals', () => {
    it('returns arrival for a state whose trajectory reaches the target', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B', 'C'],
            scheduledTimes: [0, 120, 240],
            arcMeters: [0, 1000, 2000],
        });
        // Vehicle 500 m before stop B (1000 m), moving at 10 m/s
        const traj = makeFreeTraj({ arc_start: 500, v: 10, t_start: NOW_SEC, durationSec: 300 });
        vehicleStateStore.set(makeState({
            tripId: 'TR1', routeId: '801', directionId: 0, vehicleId: 'V1',
            arc: 500, velocity: 10, traj,
        }));

        const arr = _getTrajectoryArrivals('B');
        expect(arr).toHaveLength(1);
        expect(arr[0].tripId).toBe('TR1');
        // 500 m at 10 m/s → ETA = now + 50s
        expect(arr[0].arrivalUnix).toBeCloseTo(NOW_SEC + 50, 0);
    });

    it('skips states without a trajectory', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        vehicleStateStore.set(makeState({
            tripId: 'TR1', routeId: '801', directionId: 0, vehicleId: 'V1',
            arc: 100, velocity: 5,
            // no traj
        }));
        const arr = _getTrajectoryArrivals('B');
        expect(arr).toEqual([]);
    });

    it("skips vehicles already past the target stop", async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        // Vehicle at arc=1500, target at arc=1000 (B). Past.
        const traj = makeFreeTraj({ arc_start: 1500, v: 10, t_start: NOW_SEC, durationSec: 300 });
        vehicleStateStore.set(makeState({
            tripId: 'TR1', routeId: '801', directionId: 0, vehicleId: 'V1',
            arc: 1500, velocity: 10, traj,
        }));
        expect(_getTrajectoryArrivals('B')).toEqual([]);
    });

    it('returns multiple arrivals sorted by ETA', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        // V1 at arc=800 (200m to go) → ETA NOW+20s
        // V2 at arc=500 (500m to go) → ETA NOW+50s
        vehicleStateStore.set(makeState({
            tripId: 'TR1', routeId: '801', directionId: 0, vehicleId: 'V1',
            arc: 800, velocity: 10,
            traj: makeFreeTraj({ arc_start: 800, v: 10, t_start: NOW_SEC, durationSec: 100 }),
        }));
        vehicleStateStore.set(makeState({
            tripId: 'TR2', routeId: '801', directionId: 0, vehicleId: 'V2',
            arc: 500, velocity: 10,
            traj: makeFreeTraj({ arc_start: 500, v: 10, t_start: NOW_SEC, durationSec: 200 }),
        }));
        const arr = _getTrajectoryArrivals('B');
        expect(arr).toHaveLength(2);
        expect(arr[0].tripId).toBe('TR1');
        expect(arr[1].tripId).toBe('TR2');
    });

    it('appends GTFS-only entries for trips not in the state store', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        // No vehicle state — only a GTFS-RT entry from tripUpdates
        window.masterArrivalsData.set('B', [{
            routeId: '801', directionId: 0,
            vehicleId: 'V-only-gtfs', tripId: 'TR-gtfs',
            arrivalUnix: NOW_SEC + 60,
            lastIngestUnix: NOW_SEC - 5,
        }]);
        const arr = _getTrajectoryArrivals('B');
        expect(arr).toHaveLength(1);
        expect(arr[0].tripId).toBe('TR-gtfs');
        expect(arr[0].arrivalUnix).toBe(NOW_SEC + 60);
    });

    it('does NOT double-list a trip that has both state and GTFS-RT entry', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        const traj = makeFreeTraj({ arc_start: 800, v: 10, t_start: NOW_SEC, durationSec: 100 });
        vehicleStateStore.set(makeState({
            tripId: 'TR-shared', routeId: '801', directionId: 0, vehicleId: 'V1',
            arc: 800, velocity: 10, traj,
        }));
        window.masterArrivalsData.set('B', [{
            routeId: '801', directionId: 0,
            vehicleId: 'V1', tripId: 'TR-shared',
            arrivalUnix: NOW_SEC + 100,            // intentionally different from state-derived
            lastIngestUnix: NOW_SEC - 5,
        }]);
        const arr = _getTrajectoryArrivals('B');
        expect(arr).toHaveLength(1);
        // Trajectory wins (state-driven ETA), not GTFS.
        expect(arr[0].arrivalUnix).toBeCloseTo(NOW_SEC + 20, 0);
    });

    it('caps results at 2 per (route, direction)', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        // Three vehicles converging on B
        for (let i = 0; i < 3; i++) {
            const arc = 200 + i * 100;            // 200, 300, 400 → ETAs 80, 70, 60
            vehicleStateStore.set(makeState({
                tripId: `TR${i}`, routeId: '801', directionId: 0, vehicleId: `V${i}`,
                arc, velocity: 10,
                traj: makeFreeTraj({ arc_start: arc, v: 10, t_start: NOW_SEC, durationSec: 300 }),
            }));
        }
        const arr = _getTrajectoryArrivals('B');
        // Only the 2 closest survive
        expect(arr).toHaveLength(2);
        expect(arr.map(a => a.tripId).sort()).toEqual(['TR1', 'TR2']);
    });

    it('filters out past arrivals beyond the past-arrival grace window', async () => {
        await seedCache({
            routeCode: '801', dir: 0,
            stops: ['A', 'B'], scheduledTimes: [0, 120], arcMeters: [0, 1000],
        });
        // Only a stale GTFS entry — well past grace
        window.masterArrivalsData.set('B', [{
            routeId: '801', directionId: 0,
            vehicleId: 'V', tripId: 'TR-stale',
            arrivalUnix: NOW_SEC - 3600,            // 1 h ago
            lastIngestUnix: NOW_SEC - 5,
        }]);
        const arr = _getTrajectoryArrivals('B');
        expect(arr).toEqual([]);
    });
});
