/**
 * Regression for the nearby-bus cap selection bug (UX audit F2).
 *
 * _renderNearbyBusSection caps the section at 6 routes. The selection comment
 * always promised "rank by soonest upcoming arrival so the surviving routes
 * are the ones most useful right now", but the comparator only sorted by
 * route number — so at a >6-route hub the cap kept the LOWEST-NUMBERED routes
 * and silently dropped the soonest bus (e.g. a 720 arriving in 1 minute lost
 * to six low-numbered locals arriving much later).
 *
 * Contract pinned here:
 *   - SELECTION: the 6 routes with the soonest upcoming arrival survive.
 *   - DISPLAY:   survivors render in route-number order (stable across the
 *                5 s refresh; soonest-first display would reorder every tick).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// stations.js imports these from predictions.js; the bus section itself never
// calls them, but the module graph needs them resolvable (same mock shape as
// station-row-geometry.test.js).
vi.mock('../js/predictions.js', () => ({
    getScheduledArrivals: () => [],
    getBoardingVehicles: () => [],
    getRouteCache: () => undefined,
    getTerminalName: () => null,
    resolveTripDestination: () => null,
    isOriginStop: () => false,
    isTerminalStop: () => false,
    isNearTerminalStop: () => false,
}));

import { _renderNearbyBusSection, stationGroups } from '../js/stations.js';

const NOW = 1_700_000_000;
const LAT = 34.06, LON = -118.29;

// Seven bus routes at one stop next to the station group. Route 720 (highest
// number) arrives soonest; route 18 arrives LAST so it's the one the cap
// should drop. The pre-fix numeric-sort selection kept 2..18 and dropped 720.
const ROUTES = [
    { routeId: '720', eta: 60 },
    { routeId: '2',   eta: 300 },
    { routeId: '4',   eta: 360 },
    { routeId: '10',  eta: 420 },
    { routeId: '14',  eta: 480 },
    { routeId: '16',  eta: 540 },
    { routeId: '18',  eta: 1200 },
];

beforeEach(() => {
    globalThis.window = globalThis.window || {};
    stationGroups.length = 0;
    stationGroups.push({ normName: 'test', displayName: 'Test', lat: LAT, lon: LON, stopIds: ['80001'] });
    // One bus stop 0 m from the group centroid (rail-stop IDs are 8xxxxx and
    // would be skipped by getNearbyBusStops, so use a bus-style id).
    window.masterStopsData = { 1001: { lat: LAT, lon: LON, name: 'Test / Stop' } };
    window.masterBusRoutes = Object.fromEntries(
        ROUTES.map(({ routeId }) => [routeId, { short_name: routeId, long_name: `Route ${routeId}` }]),
    );
    window.masterArrivalsData = new Map([[
        '1001',
        ROUTES.map(({ routeId, eta }, i) => ({
            routeId,
            directionId: 0,
            tripId: `t${i}`,
            vehicleId: `v${i}`,
            arrivalUnix: NOW + eta,
            lastIngestUnix: NOW,
            atStop: false,
        })),
    ]]);
});

const badge = (n) => `>${n}</span>`; // sp-bus-badge close — unambiguous per-route marker

describe('_renderNearbyBusSection — cap selection vs display order', () => {
    it('keeps the soonest-arriving route when the 6-route cap truncates', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        expect(html).toContain(badge('720'));   // soonest — must survive the cap
        expect(html).not.toContain(badge('18')); // latest — the one dropped
    });

    it('displays the survivors in route-number order, not soonest-first', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        const order = ['2', '4', '10', '14', '16', '720'].map(n => html.indexOf(badge(n)));
        expect(order.every(i => i !== -1)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('labels the count "6 of 7" when the cap truncated', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        expect(html).toContain('6 of 7');
    });

    it('lists the displayed route numbers in the collapsed summary (scent)', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        expect(html).toContain('sp-bus-summary-routes');
        expect(html).toContain('2 · 4 · 10 · 14 · 16 · 720');
    });
});
