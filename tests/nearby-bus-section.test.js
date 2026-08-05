/**
 * Pins the nearby-bus section's list contract (UX audit F2 + the follow-up
 * cap removal).
 *
 * History: the section originally capped at 6 routes. The cap's selection
 * sort regressed from "soonest arrival" to "route number" in #409 (so the
 * soonest bus at a >6-route hub was silently dropped — audit F2), was fixed,
 * and then the cap itself was REMOVED (owner call, 2026-06-12): popup height
 * is bounded by the .sp-bus-list internal scroll, not by hiding routes.
 *
 * Contract pinned here:
 *   - UNCAPPED: every route within the radius renders — nothing is dropped.
 *   - DISPLAY: route-number order (stable across the 5 s refresh; a
 *     soonest-first sort would reshuffle rows on every tick).
 *   - The collapsed summary lists the route numbers (scent) and the count.
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
    resolveBusDestination: () => null,
    isOriginStop: () => false,
    isTerminalStop: () => false,
    isNearTerminalStop: () => false,
}));

import { _renderNearbyBusSection, stationGroups } from '../js/stations.js';

const NOW = 1_700_000_000;
const LAT = 34.06, LON = -118.29;

// Seven bus routes at one stop next to the station group — more than the old
// 6-route cap, so this set would have been truncated pre-removal. Route 720
// (highest number) arrives soonest; route 18 arrives last (the one the old
// numeric-sort cap kept while dropping 720, and the one the fixed cap dropped).
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

describe('_renderNearbyBusSection — uncapped list + display order', () => {
    it('renders EVERY nearby route — no cap drops the soonest or the latest', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        for (const { routeId } of ROUTES) expect(html).toContain(badge(routeId));
    });

    it('displays routes in route-number order, not soonest-first', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        const order = ['2', '4', '10', '14', '16', '18', '720'].map(n => html.indexOf(badge(n)));
        expect(order.every(i => i !== -1)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('shows the plain route count (no "X of Y" truncation label)', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        expect(html).toContain('<span class="sp-bus-count">7</span>');
        expect(html).not.toContain(' of ');
    });

    it('lists all route numbers in the collapsed summary (scent)', () => {
        const html = _renderNearbyBusSection(['80001'], NOW, new Map());
        expect(html).toContain('sp-bus-summary-routes');
        expect(html).toContain('2 · 4 · 10 · 14 · 16 · 18 · 720');
    });
});
