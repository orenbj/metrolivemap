/**
 * Pins the station-popup section ORDER, specifically that the nearby-bus
 * block sits BELOW the amenity row.
 *
 * Why this is a contract and not a preference: the bus block is the popup's
 * only GROWABLE section (collapsed = a one-line <summary>; expanded = up to
 * 160 px of scrolling list). Above the amenity row, expanding it shoved
 * bike/restroom below the fold on the very tap that asked for more info —
 * and the amenity row has no collapsed fallback, so it simply vanished (the
 * "first casualty" case in the 2026-06-12 station-popup UX audit, F7).
 * Growable content last means expanding it displaces nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('../js/alerts.js', () => ({
    STRIP_EFFECT_LABELS: {},
    getActiveAlerts: () => [],
    getActiveStopAccessibilityAlerts: () => [],
    classifyAccessibilityAlert: () => 'unknown',
    effectSeverity: () => 1,
    accessibilitySeverity: () => 1,
    formatActivePeriodLine: () => '',
}));
// A bike station present ⇒ the amenity row renders.
vi.mock('../js/bikeshare.js', () => ({
    getNearbyBikeStation: () => ({ bikes: 3, ebikes: 1, docks: 5 }),
}));
vi.mock('../js/restrooms.js', () => ({
    getStationRestroom: () => null,
    RESTROOM_TYPE_LABEL: {},
}));

import { buildArrivalsHTML, stationGroups } from '../js/stations.js';

const LAT = 34.06, LON = -118.29;
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
    globalThis.window = globalThis.window || {};
    stationGroups.length = 0;
    stationGroups.push({ normName: 'test', displayName: 'Test', lat: LAT, lon: LON, stopIds: ['80001'] });
    window.masterStopsData = { 1001: { lat: LAT, lon: LON, name: 'Test / Stop' } };
    window.masterBusRoutes = { 720: { short_name: '720', long_name: 'Route 720' } };
    window.masterArrivalsData = new Map([[
        '1001',
        [{ routeId: '720', directionId: 0, tripId: 't1', vehicleId: 'v1',
           arrivalUnix: NOW + 300, lastIngestUnix: NOW, atStop: false }],
    ]]);
});

describe('station popup section order', () => {
    it('renders the growable nearby-bus block BELOW the fixed amenity row', () => {
        const html = buildArrivalsHTML(['80001'], 'Test');
        const amenityAt = html.indexOf('sp-amenity-row');
        const busAt     = html.indexOf('sp-bus-details');
        expect(amenityAt).toBeGreaterThan(-1);   // both sections present…
        expect(busAt).toBeGreaterThan(-1);
        expect(amenityAt).toBeLessThan(busAt);   // …and amenity comes first
    });
});
