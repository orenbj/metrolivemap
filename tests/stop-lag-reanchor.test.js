/**
 * Tests for _stopLagFromDeclared() — the underground GPS-freeze lag detector
 * that drives the stop-lag re-anchor in _applyVelocityCorrections.
 *
 * Underground (Regional Connector tunnel, B/D subway) the feed reports a FROZEN
 * lat/lng while the train-control stopId advances through tunnel stations. This
 * helper measures, in whole stops, how far the marker's visual arc lags the
 * feed-declared stop so the caller can re-anchor forward when the gap is real.
 *
 * Decision logic only (the setLngLat/teleport side-effects live in
 * _applyVelocityCorrections, which needs a live MapLibre map + arcGlide).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
    // markers.js imports this for the marker accessible name (R6-02); a mock
    // missing it fails the module load, not the assertion.
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

// Control getRouteCache; stub the rest of predictions.js used by markers.js but
// keep the REAL findIdx (the fuzzy stopId matcher under test in one case).
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

// hasShapeData → true so the helper proceeds; snapToRoute/lngLatAtArc unused here.
// resolveShapeKey feeds the arc-space guard — return the per-direction key so a
// marker whose _currentArcKey matches (or is unset, as these fixtures are) is not
// spuriously bailed. The dedicated mismatch case is exercised separately below.
vi.mock('../js/snap.js', () => ({
    hasShapeData: vi.fn(() => true),
    snapToRoute: vi.fn(() => null),
    lngLatAtArc: vi.fn(() => null),
    resolveShapeKey: vi.fn((rc, dir) => (dir == null ? String(rc) : `${rc}|${dir}`)),
}));

import { _stopLagFromDeclared } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';

// Ascending route: stops A..D at arc 0/1000/2000/3000.
const ASC = {
    stops: ['A', 'B', 'C', 'D'],
    arcMeters: [0, 1000, 2000, 3000],
    arcAscending: true,
    arcUnreliable: false,
};

// The lag reference is the reported GPS snap arc, passed as the 3rd arg.
function markerAtArc(arc) {
    const m = makeMarker({ routeCode: '801', directionId: 0, lastSnap: { arcMeters: arc } });
    m._currentArc = arc;
    return m;
}

beforeEach(() => {
    installGlobals();
    _routeCache.current = ASC;
});

describe('_stopLagFromDeclared — ascending route', () => {
    it('reports 1 stop ahead for a normal IN_TRANSIT marker (declared = immediate next)', () => {
        const marker  = markerAtArc(1500); // GPS between B and C
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        const lag = _stopLagFromDeclared(marker, vehicle, 1500);
        expect(lag.stopsAhead).toBe(1); // just C
    });

    it('reports the full multi-stop lag for a frozen underground marker', () => {
        const marker  = markerAtArc(200); // GPS frozen just past A
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        const lag = _stopLagFromDeclared(marker, vehicle, 200);
        expect(lag.stopsAhead).toBe(2);   // B and C
        expect(lag.declaredArc).toBe(2000);
        expect(lag.prevArc).toBe(1000);   // B — the IN_TRANSIT re-anchor bound
        expect(lag.stopped).toBe(false);
        expect(lag.ascending).toBe(true);
    });

    it('counts the declared stop itself when STOPPED_AT it from far behind', () => {
        const marker  = markerAtArc(100); // GPS frozen far behind, still at A
        const vehicle = makeFeature({ routeCode: '801', stopId: 'D', currentStatus: 'STOPPED_AT' });
        const lag = _stopLagFromDeclared(marker, vehicle, 100);
        expect(lag.stopsAhead).toBe(3);   // B, C, D
        expect(lag.stopped).toBe(true);
    });

    it('reports 0 when the declared stop is behind the GPS reference', () => {
        const marker  = markerAtArc(2500); // GPS past C
        const vehicle = makeFeature({ routeCode: '801', stopId: 'B', currentStatus: 'IN_TRANSIT_TO' });
        expect(_stopLagFromDeclared(marker, vehicle, 2500).stopsAhead).toBe(0);
    });

    it('is reference-agnostic — a forward reference reports low lag', () => {
        // The helper measures from whatever reference arc the caller passes. The
        // GPS-refresh override passes the VISIBLE arc; here we confirm that passing a
        // forward reference (near C) yields just 1 stop ahead (the declared next stop).
        const marker  = makeMarker({ routeCode: '801', lastSnap: { arcMeters: 1900 } });
        marker._currentArc = 1900;
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        expect(_stopLagFromDeclared(marker, vehicle, 1900).stopsAhead).toBe(1);
    });

    it('falls back to lastSnap/_currentArc when no fromArc is passed', () => {
        const marker  = makeMarker({ routeCode: '801', lastSnap: { arcMeters: 200 } });
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        expect(_stopLagFromDeclared(marker, vehicle).stopsAhead).toBe(2);
    });
});

describe('_stopLagFromDeclared — descending route (reverse direction)', () => {
    const DESC = {
        stops: ['A', 'B', 'C', 'D'],
        arcMeters: [3000, 2000, 1000, 0], // forward progress DECREASES arc
        arcAscending: false,
        arcUnreliable: false,
    };

    it('measures lag in the decreasing-arc direction', () => {
        _routeCache.current = DESC;
        const marker  = markerAtArc(2800); // GPS just past A (3000), heading toward 0
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        const lag = _stopLagFromDeclared(marker, vehicle, 2800);
        expect(lag.stopsAhead).toBe(2);   // B (2000) and C (1000)
        expect(lag.declaredArc).toBe(1000);
        expect(lag.prevArc).toBe(2000);   // B — idx-1 in sequence order
        expect(lag.ascending).toBe(false);
    });
});

describe('_stopLagFromDeclared — null guards', () => {
    it('returns null when arc data is unreliable', () => {
        _routeCache.current = { ...ASC, arcUnreliable: true };
        const marker  = markerAtArc(200);
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C' });
        expect(_stopLagFromDeclared(marker, vehicle, 200)).toBeNull();
    });

    it('returns null when the declared stop is not in the route cache', () => {
        const marker  = markerAtArc(200);
        const vehicle = makeFeature({ routeCode: '801', stopId: 'ZZ' });
        expect(_stopLagFromDeclared(marker, vehicle, 200)).toBeNull();
    });

    it('returns null when there is no arc reference at all', () => {
        const marker  = makeMarker({ routeCode: '801' }); // no _currentArc, no lastSnap
        const vehicle = makeFeature({ routeCode: '801', stopId: 'C' });
        expect(_stopLagFromDeclared(marker, vehicle)).toBeNull();
    });

    it('returns null when no stopId is declared', () => {
        const marker  = markerAtArc(200);
        const vehicle = makeFeature({ routeCode: '801', stopId: null });
        expect(_stopLagFromDeclared(marker, vehicle, 200)).toBeNull();
    });

    it('returns null when the reference arc is in a DIFFERENT shape space (arc-space guard)', () => {
        // The marker's arc lives in the bare '801' space, but this frame carries
        // direction_id 0 → cache shape key '801|0'. Those polylines are built in
        // reversed order, so measuring lag across them is garbage. The guard bails
        // (no override) — the arc-space guard in _applyVelocityCorrections teleports
        // on this same frame instead.
        const marker  = markerAtArc(200);
        marker._currentArcKey = '801';                 // stale/generic space
        const vehicle = makeFeature({ routeCode: '801', directionId: 0, stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        expect(_stopLagFromDeclared(marker, vehicle, 200)).toBeNull();
    });

    it('proceeds when _currentArcKey matches the frame shape key', () => {
        const marker  = markerAtArc(200);
        marker._currentArcKey = '801|0';               // matches resolveShapeKey('801', 0)
        const vehicle = makeFeature({ routeCode: '801', directionId: 0, stopId: 'C', currentStatus: 'IN_TRANSIT_TO' });
        expect(_stopLagFromDeclared(marker, vehicle, 200).stopsAhead).toBe(2);
    });

    it('matches a declared stopId that carries a directional suffix (fuzzy findIdx)', () => {
        // Feed reports "80204N"; cache.stops has bare "80204" — findIdx reconciles
        // the directional suffix where a bare indexOf would silently miss.
        _routeCache.current = {
            stops: ['80200', '80202', '80204', '80206'],
            arcMeters: [0, 1000, 2000, 3000],
            arcAscending: true,
            arcUnreliable: false,
        };
        const marker  = markerAtArc(200);
        const vehicle = makeFeature({ routeCode: '801', stopId: '80204N', currentStatus: 'IN_TRANSIT_TO' });
        expect(_stopLagFromDeclared(marker, vehicle, 200).stopsAhead).toBe(2);
    });
});
