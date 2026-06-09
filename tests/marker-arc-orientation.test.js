/**
 * Regression for the decreasing-arc freeze + the STOPPED_AT declared-stop anchor.
 *
 * There is ONE shared polyline per route, so half the routes' directions travel
 * in DECREASING arc (e.g. A Line dir 0, J Line 910/950 dir 0). The jitter-hold
 * used to test `toArc - fromArc < deadband` with no orientation term, so every
 * forward step of a decreasing-arc train read as "backward" and the marker FROZE
 * until a 5 km re-anchor / stop-lag forcePull yanked it forward — the "stuck,
 * then jumps past the station" bug. The hold is now orientation-aware
 * (cache.arcAscending), and STOPPED_AT can anchor the dot to the declared stop.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

// Controllable route cache so we can pin arc orientation per test.
const _routeCache = { current: null };
vi.mock('../js/predictions.js', async (importActual) => {
    const actual = await importActual();
    return {
        findIdx: actual.findIdx,
        getRouteCache: vi.fn(() => _routeCache.current),
        getTerminalStopId: vi.fn(() => null),
        getSecondsToNextStop: vi.fn(() => null),
        getScheduledArrivals: vi.fn(() => []),
        isOriginStop: vi.fn(() => false),
        isAtOwnOriginStop: vi.fn(() => false),
    };
});

import { markers, _applyVelocityCorrections, _declaredStopAnchorArc } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import { shapeData, arcLengths, precomputeRoute, lngLatAtArc } from '../js/snap.js';

const RC = 'ARC_ORIENT_TEST';

// Straight N-S route; arc INCREASES northward (index order). lngLatAtArc resolves.
function buildRoute() {
    const DEG = 100 / 110_540;
    const pts = Array.from({ length: 30 }, (_, i) => [34.0 + i * DEG, -118.2]); // [lat,lng]
    shapeData[RC] = pts;
    precomputeRoute(RC, pts);
}

beforeEach(() => {
    installGlobals();
    for (const k of Object.keys(markers)) delete markers[k];
    buildRoute();
    _routeCache.current = null;
});

// Run one fix and report whether the marker GLIDED (vs held). Place the marker
// visually at fromArc and the incoming fix at toArc (both resolved on the route).
function frame({ fromArc, toArc, ascending, anchorArc = null, speed = 12 }) {
    _routeCache.current = { arcAscending: ascending, arcUnreliable: false, stops: [], arcMeters: [] };
    const key = 'F-1';
    const ptFrom = lngLatAtArc(RC, fromArc);
    const ptTo = lngLatAtArc(RC, toArc);
    const marker = makeMarker({ tripId: key, routeCode: RC, speed, lastSnap: { arcMeters: toArc } });
    marker._currentArc = fromArc;
    marker.setLngLat([ptFrom.lng, ptFrom.lat]);
    marker._targetLng = ptTo.lng;
    marker._targetLat = ptTo.lat;
    markers[key] = marker;
    const newTs = Math.floor(Date.now() / 1000);
    const vehicle = makeFeature({ tripId: key, routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed });
    _applyVelocityCorrections(marker, vehicle, key, newTs - 5, /*isFirstFix*/ false, /*isStaleRef*/ false, /*forcePull*/ false, anchorArc);
    return typeof marker._animateMarkerOnComplete === 'function'; // glide started?
}

describe('_applyVelocityCorrections — orientation-aware jitter hold', () => {
    it('GLIDES a forward move on a DECREASING-arc direction (the freeze bug fix)', () => {
        // Forward = arc decreases (900 -> 400). Pre-fix this froze the marker.
        expect(frame({ fromArc: 900, toArc: 400, ascending: false })).toBe(true);
    });

    it('HOLDS a backward move on a DECREASING-arc direction (arc increases = backward)', () => {
        // Backward for a decreasing-arc train = arc INCREASES (400 -> 900).
        expect(frame({ fromArc: 400, toArc: 900, ascending: false })).toBe(false);
    });

    it('GLIDES a forward move on an ASCENDING direction (unchanged control)', () => {
        expect(frame({ fromArc: 400, toArc: 900, ascending: true })).toBe(true);
    });

    it('HOLDS a backward move on an ASCENDING direction (unchanged control)', () => {
        expect(frame({ fromArc: 900, toArc: 400, ascending: true })).toBe(false);
    });
});

describe('_declaredStopAnchorArc — STOPPED_AT forward-anchor decision', () => {
    const lag = (o) => ({ stopped: true, declaredArc: 2000, ascending: true, stopsAhead: 1, prevArc: null, ...o });

    it('returns the declared arc when STOPPED_AT a stop ahead of dot AND ahead of GPS (ascending)', () => {
        // dot at 1000, GPS lagging at 1500, declared stop at 2000 → anchor to 2000.
        expect(_declaredStopAnchorArc(lag(), 1000, 1500)).toBe(2000);
    });

    it('returns null when the GPS is already at/past the declared stop (no backward pull)', () => {
        // GPS fresh at 2500 (past the declared 2000) → trust GPS, do not anchor back.
        expect(_declaredStopAnchorArc(lag(), 1000, 2500)).toBeNull();
    });

    it('returns null when the declared stop is behind the dot', () => {
        expect(_declaredStopAnchorArc(lag(), 2500, 2400)).toBeNull();
    });

    it('is orientation-aware on a DECREASING-arc direction', () => {
        // Descending: forward = smaller arc. Declared 1000 is forward of dot 2000
        // and forward of GPS 1500 → anchor to 1000.
        const l = lag({ declaredArc: 1000, ascending: false });
        expect(_declaredStopAnchorArc(l, 2000, 1500)).toBe(1000);
        // GPS already past (smaller than declared) → no anchor.
        expect(_declaredStopAnchorArc(l, 2000, 800)).toBeNull();
    });

    it('returns null when not STOPPED_AT', () => {
        expect(_declaredStopAnchorArc(lag({ stopped: false }), 1000, 1500)).toBeNull();
    });

    it('returns null on missing lag / arc data', () => {
        expect(_declaredStopAnchorArc(null, 1000, 1500)).toBeNull();
        expect(_declaredStopAnchorArc(lag({ declaredArc: null }), 1000, 1500)).toBeNull();
        expect(_declaredStopAnchorArc(lag(), 1000, null)).toBeNull();
    });
});
