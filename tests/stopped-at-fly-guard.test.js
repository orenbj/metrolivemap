/**
 * Regression: the "fly to the terminus, then teleport back" bug.
 *
 * Observed in production (A Line / 801): a train STOPPED_AT Grand/LATTC whose
 * GPS momentarily glitched to the Downtown Long Beach terminus (~30 km away on
 * the polyline) glided the ENTIRE length of the line and then hard-reanchored
 * back on the next clean fix. The fly log captured fromArc≈60.8 km, toArc≈92.9 km
 * (end of shape), arcGapM≈32 km, but distM≈128 m and keyMismatch=false.
 *
 * Root cause: `_applySnap`'s STOPPED_AT branch overrode the straight-line target
 * (`_targetLng/_targetLat`) to the DECLARED stop coords, but left `marker.lastSnap`
 * pointing at the raw GPS snap. `_applyVelocityCorrections` measures the >5 km
 * hard-reanchor gate from the (small) current→stop distance — so it glides — while
 * arcGlide uses `lastSnap.arcMeters` (the far GPS arc) as its target → the fly.
 *
 * Two defenses, both pinned here:
 *   1. SOURCE: STOPPED_AT re-anchors `lastSnap` to the stop's own snap, so the arc
 *      space agrees with the adopted target (no divergence, no fly).
 *   2. BACKSTOP: the rail branch teleports when the glide's actual arc span
 *      (current → lngLatAtArc(toArc)) exceeds the 5 km hard-discontinuity floor,
 *      catching any future target/arc divergence regardless of cause.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

// Ascending, reliable, EMPTY stop list — keeps the jitter-hold + stop-lag out of
// the way so these tests isolate the snap/glide arc geometry.
vi.mock('../js/predictions.js', async (importActual) => {
    const actual = await importActual();
    return {
        findIdx: actual.findIdx,
        getRouteCache: vi.fn(() => ({ arcAscending: true, arcUnreliable: false, stops: [], arcMeters: [] })),
        getTerminalStopId: vi.fn(() => null),
        getSecondsToNextStop: vi.fn(() => null),
        getScheduledArrivals: vi.fn(() => []),
        isOriginStop: vi.fn(() => false),
        isAtOwnOriginStop: vi.fn(() => false),
    };
});

import { markers, _applySnap, _applyVelocityCorrections } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import { shapeData, precomputeRoute, lngLatAtArc } from '../js/snap.js';

const RC = 'FLYGUARD_TEST';
const M_PER_DEG_LAT = 110_540;
const DEG = 100 / M_PER_DEG_LAT;            // ~100 m per vertex

// Straight N-S route, ~100 m per vertex, 320 vertices (~31.9 km) — long enough
// that the stop and the GPS glitch sit tens of km apart in arc, like 801.
function buildRoute() {
    const pts = Array.from({ length: 320 }, (_, i) => [34.0 + i * DEG, -118.2]); // [lat,lng]
    shapeData[RC] = pts;
    precomputeRoute(RC, pts);
}
const arcToLat = (arc) => 34.0 + (arc / 100) * DEG;

let _now, _nextRafId, _rafQueue;
function step(dtMs) {
    _now += dtMs;
    const batch = [..._rafQueue.entries()];
    _rafQueue.clear();
    for (const [, cb] of batch) cb(_now);
}

const STOP_ARC = 5000;    // declared-stop position (~"Grand/LATTC")
const GPS_ARC  = 29000;   // glitched GPS fix near the far terminus (~"DTLB")

beforeEach(() => {
    installGlobals();
    buildRoute();
    for (const k of Object.keys(markers)) delete markers[k];
    _now = 0; _nextRafId = 1; _rafQueue = new Map();
    vi.stubGlobal('requestAnimationFrame', (cb) => { const id = _nextRafId++; _rafQueue.set(id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id) => { _rafQueue.delete(id); });
    vi.spyOn(performance, 'now').mockImplementation(() => _now);

    // Declared stop sits ON the polyline at STOP_ARC.
    window.masterStopsData = {
        STOP_NEAR: { lat: arcToLat(STOP_ARC), lon: -118.2, name: 'Grand/LATTC' },
    };
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Marker is visually parked AT the stop (arc STOP_ARC); the incoming STOPPED_AT
// frame carries a glitched GPS fix at GPS_ARC (far terminus) but declares the
// near stop.
function makeStoppedAtGlitchFrame() {
    const atStop = lngLatAtArc(RC, STOP_ARC);
    const marker = makeMarker({ tripId: 'F1', routeCode: RC, directionId: null, speed: 0,
        stopId: 'STOP_NEAR', currentStatus: 'STOPPED_AT',
        lastSnap: { arcMeters: STOP_ARC }, lngLat: [atStop.lng, atStop.lat] });
    marker._currentArc = STOP_ARC;
    marker._currentArcKey = RC;
    markers['F1'] = marker;

    const glitch = lngLatAtArc(RC, GPS_ARC);
    const newTs = Math.floor(Date.now() / 1000);
    const vehicle = makeFeature({ tripId: 'F1', routeCode: RC, directionId: null, speed: 0,
        stopId: 'STOP_NEAR', currentStatus: 'STOPPED_AT',
        lngLat: [glitch.lng, glitch.lat], timestamp: newTs });
    return { marker, vehicle, newTs };
}

describe('STOPPED_AT GPS-glitch fly guard', () => {
    it('SOURCE: _applySnap re-anchors lastSnap to the declared stop, not the glitched GPS arc', () => {
        const { marker, vehicle } = makeStoppedAtGlitchFrame();
        _applySnap(marker, vehicle);

        // lastSnap.arcMeters must follow the DECLARED stop (~STOP_ARC), NOT the
        // 24 km-away GPS glitch.
        expect(Math.abs(marker.lastSnap.arcMeters - STOP_ARC)).toBeLessThan(50);
        expect(marker.lastSnap.arcMeters).not.toBeCloseTo(GPS_ARC, -3);
        // Straight-line target also at the stop, so target and arc now AGREE.
        expect(Math.abs(marker._targetLat - arcToLat(STOP_ARC))).toBeLessThan(DEG);
        // Deviation reflects the stop's tiny off-polyline distance (reliable), not
        // the discarded ~24 km GPS gap.
        expect(marker.lastSnapDeviationM).toBeLessThan(50);
    });

    it('does not fly: the marker glides nowhere near the far terminus and ends at the stop', () => {
        const { marker, vehicle, newTs } = makeStoppedAtGlitchFrame();
        _applySnap(marker, vehicle);
        _applyVelocityCorrections(marker, vehicle, 'F1', newTs - 6, false, false);

        // Drive any queued glide to completion.
        for (let i = 0; i < 200 && _rafQueue.size; i++) step(100);

        const endLat = marker.getLngLat().lat;
        // The dot must stay at the stop, never sweep toward the far terminus.
        expect(Math.abs(endLat - arcToLat(STOP_ARC))).toBeLessThan(5 * DEG);          // within ~500 m
        expect(Math.abs(endLat - arcToLat(GPS_ARC))).toBeGreaterThan(100 * DEG);      // far from DTLB
        expect(Math.abs(marker._currentArc - STOP_ARC)).toBeLessThan(500);
    });

    it('BACKSTOP: a forced target/arc divergence >5 km teleports to the fix instead of gliding the line', () => {
        // Bypass the source fix to prove the rail-branch geometric backstop on its
        // own: park the marker at STOP_ARC but hand it a lastSnap.arcMeters at the
        // far terminus while the straight-line target stays near the stop.
        const atStop = lngLatAtArc(RC, STOP_ARC);
        const marker = makeMarker({ tripId: 'F2', routeCode: RC, directionId: null, speed: 12,
            stopId: 'STOP_NEAR', currentStatus: 'IN_TRANSIT_TO',
            lastSnap: { arcMeters: GPS_ARC }, lngLat: [atStop.lng, atStop.lat] });
        marker._currentArc = STOP_ARC;
        marker._currentArcKey = RC;
        marker._targetLng = atStop.lng;      // target near the marker (small distMeters)
        marker._targetLat = atStop.lat;
        markers['F2'] = marker;

        const newTs = Math.floor(Date.now() / 1000);
        const vehicle = makeFeature({ tripId: 'F2', routeCode: RC, directionId: null, speed: 12,
            stopId: 'STOP_NEAR', currentStatus: 'IN_TRANSIT_TO',
            lngLat: [atStop.lng, atStop.lat], timestamp: newTs });

        _applyVelocityCorrections(marker, vehicle, 'F2', newTs - 6, false, false);

        // No glide should be armed — the >5 km arc span teleported synchronously.
        expect(_rafQueue.size).toBe(0);
        // The teleport lands on toArc (the fix), and never animates across the line.
        expect(Math.abs(marker._currentArc - GPS_ARC)).toBeLessThan(50);
    });
});
