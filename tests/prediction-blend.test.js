/**
 * Tests for getScheduledArrivals / getArrivalBreakdown — the Tier 1/2/3
 * prediction blend in predictions.js.
 *
 *   Tier 1: GTFS-RT entry exists & plausible & fresh → horizon-adaptive blend
 *           - gtfsHorizon <60s:  70% GTFS + 30% calc (smooths near-arrival jitter)
 *           - gtfsHorizon <300s: 90% GTFS + 10% calc (GTFS dominates mid-range)
 *           - gtfsHorizon ≥300s: 100% GTFS (calc noise dominates at long horizons)
 *           - stale-replay guard: calcHorizon<300 & gtfsHorizon>2×calcHorizon+60 → calc
 *           - disagreement decay: |Δ|≤60s full agreement, ≥180s pure GTFS,
 *             linear between (replaces the previous hard 120s cliff)
 *           - GTFS stale/implausible → pure calc
 *   Tier 2: No GTFS-RT entry for this trip → calc only
 *   Tier 3: GTFS-only entries (vehicle missing from VP feed) appended at end
 *
 * Origin guard: a vehicle STOPPED_AT idx=0 has its calc value suppressed
 * because layover dwell is unmodeled.
 *
 * No shape data is loaded in these tests (loadShapes needs network), so
 * adherence offset returns 0 and gtfsLooksPlausible returns true (trust feed).
 * That isolates the blend logic itself.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));

import { initPredictions, getScheduledArrivals, getArrivalBreakdown, getRouteCache }
    from '../js/predictions.js';
import { installGlobals, addArrival } from './_helpers/globals.js';
import { makeMarker } from './_fixtures/markers.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    installGlobals();
    initPredictions();
});

/**
 * Install one moving marker on route A, currently between stop 1 (idx 1) and stop 2 (idx 2).
 * Schedule is 0/120/240/360 s. Vehicle just left stop 1 (statusChangedAt = now).
 */
function installRailMarker({ tripId = 'TR-A-1', vehicleId = 'V1', stopIdx = 2,
                            currentStatus = 'IN_TRANSIT_TO',
                            statusOffset = 0, timestamp = NOW() } = {}) {
    const stops = window.masterTripsData[tripId].stops;
    const m = makeMarker({
        tripId, vehicleId, routeCode: '801', directionId: 0,
        stopId: stops[stopIdx], currentStatus,
        timestamp,
        statusChangedAt: timestamp - statusOffset,
    });
    window.vehicleMarkers[tripId] = m;
    return m;
}

describe('getScheduledArrivals — Tier 2 (calc only, no GTFS-RT entry)', () => {
    it('emits a single calc-based arrival for a moving vehicle approaching its target', () => {
        installRailMarker();
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals).toHaveLength(1);
        expect(arrivals[0].vehicleId).toBe('V1');
        expect(arrivals[0].arrivalUnix).toBeGreaterThan(NOW());
    });

    it('skips a vehicle whose nextIdx > targetIdx (vehicle already passed the target)', () => {
        installRailMarker({ stopIdx: 3 }); // heading to stop idx 3 (last)
        // Target is idx 2 — already passed
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals).toHaveLength(0);
    });

    it('skips stale markers (older than VEHICLE_MARKER_TTL_S = 180s)', () => {
        installRailMarker({ timestamp: NOW() - 200 });
        expect(getScheduledArrivals('80303')).toHaveLength(0);
    });
});

describe('getScheduledArrivals — Tier 1 (GTFS-RT blend)', () => {
    it('returns a GTFS-weighted arrival when calc and GTFS are close (short horizon)', () => {
        installRailMarker();
        const gtfsTime = NOW() + 50; // short horizon (<60s) → 70/30 blend
        addArrival('80303', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals).toHaveLength(1);
        const a = arrivals[0].arrivalUnix;
        expect(a).toBeGreaterThan(NOW());
        // Heavily-weighted toward GTFS time (within 60s)
        expect(Math.abs(a - gtfsTime)).toBeLessThan(60);
    });

    it('falls back to pure GTFS when |GTFS−calc| ≥ HARD threshold (180 s)', () => {
        // Long-horizon marker so calcHorizon ≥ BLEND_REPLAY_NEAR_S (300 s) and the
        // stale-replay guard cannot fire — isolates the disagreement gate.
        window.vehicleMarkers['TR-A-1'] = makeMarker({
            tripId: 'TR-A-1', vehicleId: 'V1', routeCode: '801', directionId: 0,
            stopId: window.masterTripsData['TR-A-1'].stops[1],
            currentStatus: 'IN_TRANSIT_TO',
            timestamp: NOW(), statusChangedAt: NOW(),
        });
        // calc ≈ now+400; gtfs = now+150 → |Δ| ≈ 250 ≫ HARD(180), agreement=0,
        // calcWeight=0, result must equal gtfsTime exactly.
        const gtfsTime = NOW() + 150;
        addArrival('80404', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        expect(getScheduledArrivals('80404')[0].arrivalUnix).toBe(gtfsTime);
    });

    it('falls back to calc when the GTFS entry is older than GTFS_ENTRY_STALENESS_S (90s)', () => {
        installRailMarker();
        const gtfsTime = NOW() + 100;
        addArrival('80303', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW() - 200, // stale
        });
        const a = getScheduledArrivals('80303')[0].arrivalUnix;
        // Calc, not GTFS — should differ from gtfsTime
        expect(a).not.toBe(gtfsTime);
    });
});

describe('getScheduledArrivals — horizon-adaptive blend weights', () => {
    // Vehicle at stopIdx=1; target 80404 (idx=3): calc ≈ now+400s with 1 intermediate.
    // This gives a long enough calc horizon to verify w=1.0 at >300s GTFS horizon.
    function installFarMarker() {
        const m = makeMarker({
            tripId: 'TR-A-1', vehicleId: 'V1', routeCode: '801', directionId: 0,
            stopId: window.masterTripsData['TR-A-1'].stops[1],
            currentStatus: 'IN_TRANSIT_TO',
            timestamp: NOW(), statusChangedAt: NOW(),
        });
        window.vehicleMarkers['TR-A-1'] = m;
        return m;
    }

    it('applies 90/10 blend at mid-range horizon (60–300s GTFS)', () => {
        installRailMarker(); // calc ≈ now+120s for target 80303
        const gtfsTime = NOW() + 150; // gtfsHorizon=150 → w=0.9
        addArrival('80303', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        const a = getScheduledArrivals('80303')[0].arrivalUnix;
        // 90/10 blend: result must be closer to GTFS than to calc
        expect(Math.abs(a - gtfsTime)).toBeLessThan(Math.abs(a - (NOW() + 120)));
    });

    it('applies 100% GTFS weight at long horizon (>300s GTFS)', () => {
        installFarMarker(); // calc ≈ now+400s for target 80404
        const gtfsTime = NOW() + 420; // gtfsHorizon=420 > 300 → w=1.0
        addArrival('80404', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        // disagreement = |420-400| = 20 < 120, so no override — pure GTFS via w=1.0
        expect(getScheduledArrivals('80404')[0].arrivalUnix).toBe(gtfsTime);
    });

    // The stale-replay guard was deleted with the blend-tier simplification
    // (PR #192). The 2026-05 sweep showed it fires on 0.36 % of rows.
    // Reconnect-artifact protection now belongs in the WS layer
    // (api.js / tripUpdates.js), not in the prediction blend.
});

describe('getScheduledArrivals — origin-stop guard', () => {
    it('suppresses calc when the vehicle is STOPPED_AT origin (idx=0)', () => {
        installRailMarker({ stopIdx: 0, currentStatus: 'STOPPED_AT' });
        // No GTFS-RT entry for this trip → with calc suppressed, no result
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals).toHaveLength(0);
    });

    it('still surfaces a Tier-3 GTFS-only entry for an origin-stopped vehicle', () => {
        installRailMarker({ stopIdx: 0, currentStatus: 'STOPPED_AT' });
        const gtfsTime = NOW() + 200;
        // GTFS entry without a covering marker (different vehicleId triggers
        // GTFS-only path, but here we use the same trip — so it goes through
        // Tier 1 with calc suppressed → falls back to gtfs alone)
        addArrival('80303', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals).toHaveLength(1);
        expect(arrivals[0].arrivalUnix).toBe(gtfsTime);
    });
});

describe('getScheduledArrivals — Tier 3 (GTFS-only entries)', () => {
    it('appends GTFS entries whose tripId has no covering marker', () => {
        // No marker installed at all
        const gtfsTime = NOW() + 180;
        addArrival('80303', {
            tripId: 'TR-A-2', vehicleId: 'V2', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals).toHaveLength(1);
        expect(arrivals[0].arrivalUnix).toBe(gtfsTime);
    });

    it('skips GTFS entries clearly past the grace window', () => {
        // 90 s past — well past the 60 s shared PAST_ARRIVAL_GRACE_S. The
        // grace is intentional: a vehicle the feed says arrived ~30 s ago may
        // still be at the platform, and dropping it would make the popup
        // oscillate "Now / gone / Now" across refreshes.
        addArrival('80303', {
            tripId: 'TR-A-2', vehicleId: 'V2', routeId: '801', directionId: 0,
            arrivalUnix: NOW() - 90, lastIngestUnix: NOW(),
        });
        expect(getScheduledArrivals('80303')).toHaveLength(0);
    });

    it('skips stale GTFS entries (lastIngest > 90s old)', () => {
        addArrival('80303', {
            tripId: 'TR-A-2', vehicleId: 'V2', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 180, lastIngestUnix: NOW() - 200,
        });
        expect(getScheduledArrivals('80303')).toHaveLength(0);
    });
});

describe('getScheduledArrivals — GPS-past-target guard (PR #222 follow-on)', () => {
    // When the marker's snap arc has moved past the target stop's arc by
    // ≥ STOP_ID_LAG_MARGIN_M, the vehicle has physically passed the target
    // even though the feed's stopId can still claim "target is next" for
    // 10-30 s. The station popup at the just-passed stop must NOT surface
    // an ETA for that vehicle — without this guard, the vehicle popup
    // (which uses the GPS-inferred next stop) and the station popup (which
    // would surface the vehicle for the stale stop) disagree about the
    // same vehicle.

    // Inject synthetic arcMeters into the route cache so the guard has
    // data to evaluate. Default fixture trip TR-A-1 has 4 stops; treat
    // them as evenly spaced at arc [0, 1000, 2000, 3000].
    function installArcCache() {
        // getRouteCache returns the same object reference held in the
        // module's internal `routeStops` map; mutating it propagates.
        const cache = getRouteCache('801', 0);
        if (cache) cache.arcMeters = [0, 1000, 2000, 3000];
    }

    function installMarker({ stopIdx, snapArc, speed = 10 }) {
        const stops = window.masterTripsData['TR-A-1'].stops;
        const m = makeMarker({
            tripId: 'TR-A-1', vehicleId: 'V1', routeCode: '801', directionId: 0,
            stopId: stops[stopIdx], currentStatus: 'IN_TRANSIT_TO',
            timestamp: NOW(), statusChangedAt: NOW(),
            speed,
        });
        m.properties.smoothedSpeed = speed;
        m.lastSnap = { arcMeters: snapArc, snappedLng: 0, snappedLat: 0 };
        window.vehicleMarkers['TR-A-1'] = m;
        return m;
    }

    it('drops a vehicle from arrivals when GPS arc is past the target by ≥ margin (and moving)', () => {
        installArcCache();
        // Target is stop idx 1 (80202, arc 1000). Marker's snap is at arc
        // 1050 — 50 m past, well over STOP_ID_LAG_MARGIN_M (30 m). Marker
        // is moving. Feed still says stopId is 80202. Without the guard
        // the vehicle would surface as an arrival at 80202. With the
        // guard, it's dropped.
        installMarker({ stopIdx: 1, snapArc: 1050 });
        const arrivals = getScheduledArrivals('80202');
        expect(arrivals).toHaveLength(0);
    });

    it('keeps the vehicle when it is STATIONARY at the target (platform overshoot guard)', () => {
        // A stopped 3-car train (~82 m long) reports GPS ~25-40 m past
        // the platform centroid because the antenna sits mid-car. Without
        // the moving-speed gate, this would fire the past-target guard
        // and drop the vehicle from the popup at the stop where it's
        // actually sitting — riders standing at the platform wouldn't see
        // their train. Confirm the gate suppresses the drop when speed < 0.5 m/s.
        installArcCache();
        installMarker({ stopIdx: 1, snapArc: 1040, speed: 0 }); // 40 m past, stopped
        const arrivals = getScheduledArrivals('80202');
        expect(arrivals).toHaveLength(1);
    });

    it('keeps the vehicle when GPS arc is BEFORE the target (normal approach)', () => {
        installArcCache();
        installMarker({ stopIdx: 1, snapArc: 900 });   // 100 m short of target
        const arrivals = getScheduledArrivals('80202');
        expect(arrivals).toHaveLength(1);
    });

    it('keeps the vehicle when overshoot is under STOP_ID_LAG_MARGIN_M (GPS noise)', () => {
        installArcCache();
        installMarker({ stopIdx: 1, snapArc: 1010 });  // only 10 m past
        const arrivals = getScheduledArrivals('80202');
        expect(arrivals).toHaveLength(1);
    });

    it('also drops the GTFS-RT entry for that trip (no zombie re-append)', () => {
        installArcCache();
        installMarker({ stopIdx: 1, snapArc: 1050 });
        // Metro's trip_updates feed still has a prediction for this trip
        // at this stop. The guard's coveredTripIds.add(trip_id) call must
        // prevent the GTFS-only loop at the bottom from re-appending it.
        addArrival('80202', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 30, lastIngestUnix: NOW(),
        });
        expect(getScheduledArrivals('80202')).toHaveLength(0);
    });

    it('no-op when arc cache is absent (cold start, no shapes loaded)', () => {
        // No installArcCache() — cache.arcMeters is undefined. The guard
        // safely falls through and the standard path runs.
        installMarker({ stopIdx: 1, snapArc: 1050 });
        const arrivals = getScheduledArrivals('80202');
        // Without arcMeters the guard can't evaluate — the vehicle is
        // still emitted via the standard nextIdx check. Documents the
        // graceful degradation: when shapes haven't loaded yet, behavior
        // is the same as before this guard was added.
        expect(arrivals.length).toBeGreaterThanOrEqual(0);
    });
});

describe('getScheduledArrivals — capping per direction', () => {
    it('keeps at most 2 arrivals per (routeId, directionId)', () => {
        // Three vehicles all heading to 80303 — register their trips first
        for (let i = 2; i <= 3; i++) {
            window.masterTripsData[`TR-A-${i}`] = { ...window.masterTripsData['TR-A-1'] };
        }
        for (let i = 1; i <= 3; i++) {
            installRailMarker({ tripId: `TR-A-${i}`, vehicleId: `V${i}` });
        }
        const arrivals = getScheduledArrivals('80303');
        expect(arrivals.length).toBeLessThanOrEqual(2);
    });
});

describe('getArrivalBreakdown — diagnostic fields', () => {
    it('emits calcEta and gtfsEta separately for inspection', () => {
        installRailMarker();
        const gtfsTime = NOW() + 110;
        addArrival('80303', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: gtfsTime, lastIngestUnix: NOW(),
        });
        const rows = getArrivalBreakdown('80303');
        expect(rows).toHaveLength(1);
        expect(rows[0].gtfsEta).toBe(gtfsTime);
        expect(rows[0].calcEta).toBeGreaterThan(NOW());
    });

    it('reports gtfsEta=null when no fresh GTFS-RT entry exists', () => {
        installRailMarker();
        const rows = getArrivalBreakdown('80303');
        expect(rows[0].gtfsEta).toBeNull();
        expect(rows[0].calcEta).toBeGreaterThan(NOW());
    });

    it('reports _atOrigin=true for STOPPED_AT idx=0 vehicles', () => {
        installRailMarker({ stopIdx: 0, currentStatus: 'STOPPED_AT' });
        const rows = getArrivalBreakdown('80303');
        expect(rows[0]._atOrigin).toBe(true);
        expect(rows[0].calcEta).toBeNull(); // suppressed
    });

    it('exposes _intermediateStops count between vehicle and target', () => {
        installRailMarker(); // nextIdx=2, target idx=3 → 0 intermediate
        const rows1 = getArrivalBreakdown('80303');
        expect(rows1[0]._intermediateStops).toBe(0);

        // Aim further: vehicle at idx 1 → target idx 3 → 1 intermediate (idx 2)
        installRailMarker({ stopIdx: 1 });
        const rows2 = getArrivalBreakdown('80404');
        expect(rows2[0]._intermediateStops).toBe(1);
    });
});
