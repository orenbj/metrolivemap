/**
 * Tests for getBoardingVehicles — the boarding-badge data source.
 *
 *   Tier 1: active marker STOPPED_AT origin (idx=0)
 *   Tier 2: fresh GTFS-RT entries at an origin stop with no covering marker
 *           (bridges the layover gap when VP feed is silent)
 *   Filter: BOARDING_MAX_HORIZON_S = 600 s — only trains likely physically
 *           dwelling, not future arrivals.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));

import { initPredictions, getBoardingVehicles } from '../js/predictions.js';
import { installGlobals, addArrival } from './_helpers/globals.js';
import { makeMarker } from './_fixtures/markers.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    installGlobals();
    initPredictions();
});

describe('getBoardingVehicles — Tier 1 (active markers)', () => {
    it('returns a marker that is STOPPED_AT origin idx=0', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', vehicleId: 'V1',
            routeCode: '801', directionId: 0,
            stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        const result = getBoardingVehicles(['80101']);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            tripId: 'TR-A-1',
            vehicleId: 'V1',
            stopId: '80101',
        });
    });

    it('omits markers that are NOT at idx=0 of their route', () => {
        // Stopped at stop idx 2, not the origin
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80303', currentStatus: 'STOPPED_AT',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        expect(getBoardingVehicles(['80101'])).toHaveLength(0);
    });

    it('omits markers that are IN_TRANSIT_TO origin (not yet arrived)', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'IN_TRANSIT_TO',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        expect(getBoardingVehicles(['80101'])).toHaveLength(0);
    });

    it('attaches departureUnix from a fresh GTFS-RT entry', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        const dep = NOW() + 60;
        addArrival('80101', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: dep, lastIngestUnix: NOW(),
        });
        expect(getBoardingVehicles(['80101'])[0].departureUnix).toBe(dep);
    });

    it('returns null departureUnix when the GTFS entry is stale (>90s)', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        addArrival('80101', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 60, lastIngestUnix: NOW() - 200,
        });
        expect(getBoardingVehicles(['80101'])[0].departureUnix).toBeNull();
    });

    it('omits stale markers (timestamp older than VEHICLE_MARKER_TTL_S=180s)', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'STOPPED_AT',
            timestamp: NOW() - 200,
        });
        window.vehicleMarkers['TR-A-1'] = m;
        expect(getBoardingVehicles(['80101'])).toHaveLength(0);
    });
});

describe('getBoardingVehicles — Tier 2 (GTFS-only)', () => {
    it('surfaces a fresh GTFS-only entry at an origin stop with no covering marker', () => {
        addArrival('80101', {
            tripId: 'TR-A-99', vehicleId: 'V99', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        // The GTFS entry references an unknown trip; install matching trip metadata.
        window.masterTripsData['TR-A-99'] = { ...window.masterTripsData['TR-A-1'] };
        initPredictions();

        const result = getBoardingVehicles(['80101']);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            tripId: 'TR-A-99', vehicleId: 'V99', stopId: '80101', gtfsOnly: true,
        });
    });

    it('filters out future trains beyond BOARDING_MAX_HORIZON_S=600s', () => {
        addArrival('80101', {
            tripId: 'TR-A-99', vehicleId: 'V99', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 1500, lastIngestUnix: NOW(),
        });
        window.masterTripsData['TR-A-99'] = { ...window.masterTripsData['TR-A-1'] };
        initPredictions();
        expect(getBoardingVehicles(['80101'])).toHaveLength(0);
    });

    it('filters out stale GTFS entries', () => {
        addArrival('80101', {
            tripId: 'TR-A-99', vehicleId: 'V99', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 60, lastIngestUnix: NOW() - 200,
        });
        window.masterTripsData['TR-A-99'] = { ...window.masterTripsData['TR-A-1'] };
        initPredictions();
        expect(getBoardingVehicles(['80101'])).toHaveLength(0);
    });

    it('does not duplicate a trip already covered by Tier 1', () => {
        // Tier 1: active marker
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        // Tier 2: same trip in arrivals — shouldn't double-count
        addArrival('80101', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 60, lastIngestUnix: NOW(),
        });
        expect(getBoardingVehicles(['80101'])).toHaveLength(1);
    });

    it('does not surface entries at non-origin stops', () => {
        addArrival('80303', {
            tripId: 'TR-A-99', vehicleId: 'V99', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 60, lastIngestUnix: NOW(),
        });
        window.masterTripsData['TR-A-99'] = { ...window.masterTripsData['TR-A-1'] };
        initPredictions();
        expect(getBoardingVehicles(['80303'])).toHaveLength(0);
    });
});
