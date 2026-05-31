/**
 * Tests for js/busBridges.js detectBusBridges() — pure detection from
 * masterAlertsData + masterStopsData + getRouteCache. The init/render
 * functions touch MapLibre and DOM and are out of scope here.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock getRouteCache so we can drive the stop-sequence input directly.
const _routeCaches = new Map();
vi.mock('../js/predictions.js', () => ({
    getRouteCache: vi.fn((rc, dir) => _routeCaches.get(`${rc}|${dir}`)),
}));

import { detectBusBridges, _bridgePolyline } from '../js/busBridges.js';
import { planarMeters } from '../js/utils.js';

function setRouteCache(rc, dir, stops) {
    _routeCaches.set(`${rc}|${dir}`, { stops });
}

function setStops(stopMap) {
    window.masterStopsData = {};
    for (const [id, [lat, lon]] of Object.entries(stopMap)) {
        window.masterStopsData[id] = { lat, lon, name: id };
    }
}

function setAlerts(alertsByRoute) {
    window.masterAlertsData = new Map(Object.entries(alertsByRoute));
}

beforeEach(() => {
    _routeCaches.clear();
    window.masterAlertsData = new Map();
    window.masterStopsData  = {};
});

describe('detectBusBridges — basic detection', () => {
    it('returns empty when masterAlertsData is missing', () => {
        delete window.masterAlertsData;
        expect(detectBusBridges()).toEqual([]);
    });

    it('returns empty when masterStopsData is missing', () => {
        delete window.masterStopsData;
        expect(detectBusBridges()).toEqual([]);
    });

    it('emits one bridge for a 2-stop consecutive run', () => {
        setRouteCache('801', 0, ['80101', '80102', '80103', '80104', '80105']);
        setStops({ '80102': [34.0, -118.2], '80103': [34.01, -118.21] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80102', '80103'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        const bridges = detectBusBridges();
        expect(bridges).toHaveLength(1);
        expect(bridges[0]).toMatchObject({
            routeCode: '801', fromStopId: '80102', toStopId: '80103',
            fromCoords: [-118.2, 34.0], toCoords: [-118.21, 34.01],
        });
    });

    it('emits one bridge spanning a longer run (first to last only)', () => {
        setRouteCache('801', 0, ['80101', '80102', '80103', '80104', '80105']);
        setStops({
            '80102': [34.0, -118.2], '80103': [34.01, -118.21],
            '80104': [34.02, -118.22],
        });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80102', '80103', '80104'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        const bridges = detectBusBridges();
        expect(bridges).toHaveLength(1);
        expect(bridges[0].fromStopId).toBe('80102');
        expect(bridges[0].toStopId).toBe('80104');
    });

    it('does not emit a bridge for a run of 1 stop', () => {
        setRouteCache('801', 0, ['80101', '80102', '80103']);
        setStops({ '80102': [34.0, -118.2] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80102'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        // .length < 2 short-circuits before the loop, so this is essentially
        // covered above — exercise the path explicitly.
        expect(detectBusBridges()).toHaveLength(0);
    });

    it('does not emit a bridge when only non-adjacent stops are affected', () => {
        // 80102 and 80104 are NOT consecutive in the route sequence; 80103 sits between.
        setRouteCache('801', 0, ['80101', '80102', '80103', '80104', '80105']);
        setStops({ '80102': [34.0, -118.2], '80104': [34.02, -118.22] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80102', '80104'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toHaveLength(0);
    });

    it('emits two bridges for two non-adjacent runs in the same alert', () => {
        setRouteCache('801', 0, ['80101', '80102', '80103', '80104', '80105', '80106']);
        setStops({
            '80101': [34.0, -118.2], '80102': [34.01, -118.21],
            '80105': [34.04, -118.24], '80106': [34.05, -118.25],
        });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                // Two 2-stop runs separated by 80103/80104
                stopIds: ['80101', '80102', '80105', '80106'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        const bridges = detectBusBridges();
        expect(bridges).toHaveLength(2);
        expect(bridges.map(b => `${b.fromStopId}-${b.toStopId}`).sort())
            .toEqual(['80101-80102', '80105-80106']);
    });
});

describe('detectBusBridges — filtering', () => {
    it('ignores alerts with effect != NO_SERVICE', () => {
        setRouteCache('801', 0, ['80101', '80102', '80103']);
        setStops({ '80101': [34.0, -118.2], '80102': [34.01, -118.21] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'DETOUR',
                stopIds: ['80101', '80102'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toEqual([]);
    });

    it('ignores alerts with stopIds < 2', () => {
        setRouteCache('801', 0, ['80101', '80102']);
        setStops({ '80101': [34.0, -118.2] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80101'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toEqual([]);
    });

    it('skips a bridge when an endpoint is missing from masterStopsData', () => {
        setRouteCache('801', 0, ['80101', '80102', '80103']);
        setStops({ '80102': [34.01, -118.21] });   // 80101 deliberately missing
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80101', '80102'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toEqual([]);
    });
});

describe('detectBusBridges — direction dedupe', () => {
    it('emits exactly one bridge when the same alert matches both directions (regression for canonical-key fix)', () => {
        // Both directions traverse the same stops; running the detection twice
        // would naively yield "80102→80103" from dir 0 and "80103→80102" from dir 1.
        // The canonical sorted key collapses these to a single bridge.
        setRouteCache('801', 0, ['80101', '80102', '80103', '80104']);
        setRouteCache('801', 1, ['80104', '80103', '80102', '80101']);
        setStops({ '80102': [34.0, -118.2], '80103': [34.01, -118.21] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80102', '80103'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        const bridges = detectBusBridges();
        expect(bridges).toHaveLength(1);
    });
});

describe('detectBusBridges — stop ID normalization', () => {
    it('matches alert stopIds with directional suffixes against base IDs in the cache', () => {
        // Real-world: alert.stopIds carry "_N"/"_S" suffixes from the GTFS-RT
        // informedEntities; alerts.js normalizes these on ingest, so by the
        // time detectBusBridges runs they're already stripped. This test
        // confirms detection works against the normalized form.
        setRouteCache('801', 0, ['80101', '80102', '80103']);
        setStops({ '80101': [34.0, -118.2], '80102': [34.01, -118.21] });
        setAlerts({
            '801': [{
                id: 'a-1', effect: 'NO_SERVICE',
                stopIds: ['80101', '80102'],   // already normalized by alerts.js _ingest
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toHaveLength(1);
    });
});

describe('_bridgePolyline — bracket geometry', () => {
    // Helper: distance from `pt` to the midpoint of A↔B (the *un-offset* chord midpoint).
    const chordMidDistM = (A, B, pt) => {
        const chordMid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
        return planarMeters(chordMid[1], chordMid[0], pt[1], pt[0]);
    };

    it('returns 4 coords with endpoints unchanged', () => {
        const A = [-118.2, 34.0];
        const B = [-118.21, 34.01];
        const poly = _bridgePolyline(A, B);
        expect(poly).not.toBeNull();
        expect(poly.coords).toHaveLength(4);
        expect(poly.coords[0]).toEqual(A);
        expect(poly.coords[3]).toEqual(B);
    });

    it('returns null for a degenerate (zero-length) input', () => {
        const A = [-118.2, 34.0];
        expect(_bridgePolyline(A, A)).toBeNull();
    });

    it('offsets the midpoint perpendicular to A→B by ~500 m (east-west pair)', () => {
        // A → B running due east — perpendicular-left is due north.
        const A = [-118.20, 34.0];
        const B = [-118.19, 34.0]; // ~927 m east at 34°N
        const poly = _bridgePolyline(A, B);
        const dist = chordMidDistM(A, B, poly.midpoint);
        expect(dist).toBeGreaterThan(499);
        expect(dist).toBeLessThan(501);
        // Perpendicular-left of east is north → midpoint lat > chord-mid lat
        const chordMidLat = (A[1] + B[1]) / 2;
        expect(poly.midpoint[1]).toBeGreaterThan(chordMidLat);
    });

    it('offsets the midpoint perpendicular to A→B by ~500 m (north-south pair)', () => {
        // A → B running due north — perpendicular-left is due west.
        const A = [-118.20, 34.00];
        const B = [-118.20, 34.01]; // ~1105 m north
        const poly = _bridgePolyline(A, B);
        const dist = chordMidDistM(A, B, poly.midpoint);
        expect(dist).toBeGreaterThan(499);
        expect(dist).toBeLessThan(501);
        // Perpendicular-left of north is west → midpoint lng < chord-mid lng
        const chordMidLng = (A[0] + B[0]) / 2;
        expect(poly.midpoint[0]).toBeLessThan(chordMidLng);
    });

    it('offsets by ~500 m on a 45° diagonal', () => {
        const A = [-118.200, 34.000];
        const B = [-118.190, 34.010]; // roughly diagonal NE
        const poly = _bridgePolyline(A, B);
        const dist = chordMidDistM(A, B, poly.midpoint);
        expect(dist).toBeGreaterThan(499);
        expect(dist).toBeLessThan(501);
    });

    it('produces a parallel offset segment: A_off→B_off has the same direction as A→B', () => {
        const A = [-118.20, 34.00];
        const B = [-118.19, 34.01];
        const { coords } = _bridgePolyline(A, B);
        const [, Aoff, Boff] = coords;

        // Direction of A→B
        const dx1 = B[0] - A[0];
        const dy1 = B[1] - A[1];
        // Direction of A_off→B_off
        const dx2 = Boff[0] - Aoff[0];
        const dy2 = Boff[1] - Aoff[1];

        // Vectors parallel ⇒ cross product ≈ 0
        const cross = dx1 * dy2 - dy1 * dx2;
        expect(Math.abs(cross)).toBeLessThan(1e-10);

        // Same direction (not opposite) ⇒ dot product > 0
        expect(dx1 * dx2 + dy1 * dy2).toBeGreaterThan(0);
    });

    it('accepts a custom offsetMeters parameter', () => {
        const A = [-118.20, 34.0];
        const B = [-118.19, 34.0];
        const poly = _bridgePolyline(A, B, 120);
        const dist = chordMidDistM(A, B, poly.midpoint);
        expect(dist).toBeGreaterThan(119);
        expect(dist).toBeLessThan(121);
    });
});

describe('detectBusBridges — effect + shuttle-text gating', () => {
    it('emits a bridge for a MODIFIED_SERVICE alert whose text names a bus shuttle', () => {
        // Metro tags PARTIAL closures (trains still run on part of the line) as
        // MODIFIED_SERVICE, not NO_SERVICE — the real 2026-05 B Line case.
        setRouteCache('802', 0, ['80201', '80202', '80203', '80204', '80205']);
        setStops({ '80203': [34.14, -118.36], '80204': [34.16, -118.39] });
        setAlerts({
            '802': [{
                id: 'b-1', effect: 'MODIFIED_SERVICE',
                header: 'Modified service: B Line',
                description: 'Universal City/Studio City and North Hollywood stations will be closed. Bus shuttles will provide service during this time.',
                stopIds: ['80203', '80204'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        const bridges = detectBusBridges();
        expect(bridges).toHaveLength(1);
        expect(bridges[0]).toMatchObject({ routeCode: '802', fromStopId: '80203', toStopId: '80204' });
    });

    it('does NOT emit a bridge for a MODIFIED_SERVICE alert with no shuttle language', () => {
        setRouteCache('802', 0, ['80201', '80202', '80203', '80204', '80205']);
        setStops({ '80203': [34.14, -118.36], '80204': [34.16, -118.39] });
        setAlerts({
            '802': [{
                id: 'b-2', effect: 'MODIFIED_SERVICE',
                header: 'Modified service: B Line',
                description: 'Trains are running with delays due to signal maintenance.',
                stopIds: ['80203', '80204'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toHaveLength(0);
    });

    it('matches the plural "bus shuttles" and is case-insensitive', () => {
        setRouteCache('802', 0, ['80201', '80202', '80203', '80204']);
        setStops({ '80202': [34.1, -118.3], '80203': [34.12, -118.33] });
        setAlerts({
            '802': [{
                id: 'b-3', effect: 'OTHER_EFFECT',
                header: '', description: 'BUS SHUTTLES replace train service here.',
                stopIds: ['80202', '80203'],
                activePeriod: { start: 0, end: Infinity },
            }],
        });
        expect(detectBusBridges()).toHaveLength(1);
    });
});
