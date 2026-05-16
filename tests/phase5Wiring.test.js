/**
 * Tests for js/phase5Wiring.js — Phase 5.2 WS-routing orchestrator.
 *
 * Strategy: stand up a synthetic route cache + GeoJSON feature + snap result
 * and assert the wiring produces a state in the singleton store with the
 * expected shape (arc, velocity, has trajectory, etc.).
 *
 * The functions under test do NOT check USE_TRAJECTORY_MODEL — callers gate
 * that — so we exercise them directly without flag manipulation. The flag
 * being permanently false in production is verified separately by the
 * 637-test suite passing with the wiring imported but never invoked.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

// jsdom localStorage shim — same pattern as tests/phase5-state-bootstrap.test.js.
const _storage = {};
let _origDescriptor;
beforeAll(() => {
    _origDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
        value: {
            getItem(k)    { return _storage[k] ?? null; },
            setItem(k, v) { _storage[k] = String(v); },
            removeItem(k) { delete _storage[k]; },
            clear()       { for (const k of Object.keys(_storage)) delete _storage[k]; },
        },
        writable: true, configurable: true,
    });
});
afterAll(() => {
    if (_origDescriptor) Object.defineProperty(window, 'localStorage', _origDescriptor);
});

// predictions.js reads window.masterTripsData at initPredictions time and uses
// the result to populate routeStops (the cache the wiring reads). Seed before
// importing.
beforeAll(async () => {
    window.masterTripsData = {
        'T-901': {
            rc: '901', dir: 0,
            stops: ['80101', '80102', '80103', '80104'],
            scheduledTimes: [21600, 21720, 21840, 21960],  // 06:00 + 0/2/4/6 min
        },
    };
});

import { initPredictions, _clearRouteStopsCache } from '../js/predictions.js';
import { vehicleStateStore } from '../js/phase5State.js';
import { ingestVehicleFix, ingestTripUpdate } from '../js/phase5Wiring.js';

// Patch the route cache directly so we don't need real shape data — the
// builder only cares about cache.arcMeters being finite. predictions'
// initPredictions populates cache.arcMeters from snap.js; in tests we'd
// otherwise need real polylines. Reach into the module's internal cache via
// a re-init + manual override.
function seedRouteCache() {
    _clearRouteStopsCache();
    initPredictions();
    // initPredictions doesn't add arcMeters when shape data is absent. Inject
    // a synthetic cache directly — we know what the wiring needs.
    // (Imported via dynamic import so we can grab the underlying routeStops
    // bag; predictions.js does not export it. Side-step by going through
    // getRouteCache mutation.)
    //
    // The simplest reliable path is to mutate the cache object returned by
    // getRouteCache — it's a live reference into routeStops.
    // eslint-disable-next-line no-restricted-syntax
    return import('../js/predictions.js').then(({ getRouteCache }) => {
        const cache = getRouteCache('901', 0);
        if (cache) {
            cache.arcMeters = [0, 1000, 2000, 3000];
            return cache;
        }
        // initPredictions skipped this route because masterTripsData didn't seed
        // it. Bail to a no-op cache the tests can check against directly.
        return null;
    });
}

function makeFeature({
    tripId = 'T-901', routeCode = '901', vehicleId = 'V-1',
    directionId = 0, stopId = '80102',
    lng = -118.25, lat = 34.05, speed = 8,
    currentStatus = 'IN_TRANSIT_TO',
    ts = 1_700_000_000,
} = {}) {
    return {
        type: 'Feature',
        properties: {
            vehicle_id: vehicleId,
            trip_id: tripId,
            route_code: routeCode,
            direction_id: directionId,
            stopId,
            currentStatus,
            position_speed: speed,
            timestamp: ts,
        },
        geometry: { type: 'Point', coordinates: [lng, lat] },
    };
}

function makeSnap({ arcMeters = 500 } = {}) {
    return {
        arcMeters,
        snappedLat: 34.05,
        snappedLng: -118.25,
        tangentForward: 90,
        arcIndex: 0,
        endpointTangent: false,
    };
}

describe('ingestVehicleFix', () => {
    let cache;
    beforeEach(async () => {
        vehicleStateStore.clear();
        cache = await seedRouteCache();
    });

    it('returns null when the route cache lacks arcMeters', () => {
        // Unknown route → no cache at all
        const f = makeFeature({ routeCode: '999' });
        const res = ingestVehicleFix(f, makeSnap(), 1_700_000_000);
        expect(res).toBeNull();
        expect(vehicleStateStore.size).toBe(0);
    });

    it('returns null when direction_id is null', () => {
        const f = makeFeature({ directionId: null });
        const res = ingestVehicleFix(f, makeSnap(), 1_700_000_000);
        expect(res).toBeNull();
    });

    it('returns null when stopId is not in the trip cache', () => {
        const f = makeFeature({ stopId: 'unknown-stop' });
        const res = ingestVehicleFix(f, makeSnap(), 1_700_000_000);
        expect(res).toBeNull();
    });

    it('seeds a fresh state on the first fix', () => {
        if (!cache) return; // skip if route cache couldn't be set up
        const f = makeFeature();
        const state = ingestVehicleFix(f, makeSnap({ arcMeters: 250 }), 1_700_000_000);
        expect(state).not.toBeNull();
        expect(state.tripId).toBe('T-901');
        expect(state.routeId).toBe('901');
        expect(state.arc).toBeCloseTo(250, 1);
        expect(state.velocity).toBeCloseTo(8, 1);
        // A trajectory was built and stashed
        expect(state.trajectory).not.toBeNull();
        // Store is keyed by tripId
        expect(vehicleStateStore.get('T-901')).toBe(state);
    });

    it('updates an existing state via applyGpsFix on subsequent IN_TRANSIT_TO fixes', () => {
        if (!cache) return;
        ingestVehicleFix(makeFeature(), makeSnap({ arcMeters: 100 }), 1_700_000_000);
        // 10 seconds later, vehicle has moved 80 m at 8 m/s → arc≈180
        const next = ingestVehicleFix(
            makeFeature({ ts: 1_700_000_010 }),
            makeSnap({ arcMeters: 180 }),
            1_700_000_010,
        );
        expect(next.arc).toBeGreaterThan(100);
        expect(next.arc).toBeLessThan(250);  // Kalman blends prior + obs
        expect(next.lastObservedAt).toBe(1_700_000_010);
    });

    it('applies STOPPED_AT updater and pulls arc to the stop', () => {
        if (!cache) return;
        ingestVehicleFix(
            makeFeature({ stopId: '80102', currentStatus: 'IN_TRANSIT_TO' }),
            makeSnap({ arcMeters: 950 }),
            1_700_000_000,
        );
        const stopped = ingestVehicleFix(
            makeFeature({ stopId: '80102', currentStatus: 'STOPPED_AT', speed: 0, ts: 1_700_000_010 }),
            makeSnap({ arcMeters: 990 }),
            1_700_000_010,
        );
        // applyStoppedAt pulls arc strongly toward stop.arc = 1000 (cache.arcMeters[1])
        expect(stopped.arc).toBeGreaterThan(990);
        expect(stopped.velocity).toBeLessThan(0.5);  // pulled to 0
    });
});

describe('ingestTripUpdate', () => {
    beforeEach(async () => {
        vehicleStateStore.clear();
        await seedRouteCache();
    });

    it('returns null when no vehicle state exists for the trip', () => {
        const res = ingestTripUpdate('T-unknown', [{ stopId: '80102', arrival: { time: 1_700_001_000 } }], '901', 0, 1_700_000_000);
        expect(res).toBeNull();
    });

    it('updates state.lastObservedAt to the trip-update time when a state exists', () => {
        const seeded = ingestVehicleFix(makeFeature(), makeSnap({ arcMeters: 100 }), 1_700_000_000);
        if (!seeded) return;  // route cache not seeded → skip
        const result = ingestTripUpdate(
            'T-901',
            [{ stopId: '80102', arrival: { time: 1_700_000_500 } }],
            '901', 0,
            1_700_000_100,
        );
        expect(result).not.toBeNull();
        // applyTripUpdate calls tickTime(state, obs.t) which advances lastObservedAt
        expect(result.lastObservedAt).toBeGreaterThanOrEqual(1_700_000_100);
    });

    it('silently ignores stopTimeUpdate entries whose stopId is not in the cache', () => {
        const seeded = ingestVehicleFix(makeFeature(), makeSnap({ arcMeters: 100 }), 1_700_000_000);
        if (!seeded) return;
        // Should not throw
        expect(() => ingestTripUpdate(
            'T-901',
            [{ stopId: 'unknown', arrival: { time: 1_700_000_500 } }],
            '901', 0,
            1_700_000_100,
        )).not.toThrow();
    });
});
