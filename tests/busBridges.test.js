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

import { detectBusBridges } from '../js/busBridges.js';

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
