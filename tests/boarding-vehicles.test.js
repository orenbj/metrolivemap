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
    // markers.js imports this for the marker accessible name (R6-02); a mock
    // missing it fails the module load, not the assertion.
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
}));

import { initPredictions, getBoardingVehicles, getNextOriginDeparture } from '../js/predictions.js';
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

    it('prefers departureUnix (real pull-out) over arrivalUnix during a layover dwell', () => {
        // Arrival already in the past (train is dwelling), departure ahead. The
        // badge must read the pull-out time, not render "Departs Now" from arrival.
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        window.vehicleMarkers['TR-A-1'] = m;
        const arr = NOW() - 30;
        const dep = NOW() + 90;
        addArrival('80101', {
            tripId: 'TR-A-1', vehicleId: 'V1', routeId: '801', directionId: 0,
            arrivalUnix: arr, departureUnix: dep, lastIngestUnix: NOW(),
        });
        expect(getBoardingVehicles(['80101'])[0].departureUnix).toBe(dep);
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

    it('keeps a dwelling entry whose arrival is past-grace but departure is ahead', () => {
        // Arrival 90 s past (beyond PAST_ARRIVAL_GRACE_S=60) but departure still
        // ahead: the train is dwelling at its origin. Liveness = max(arr, dep) keeps
        // it on the boarding badge for the whole layover instead of vanishing 60 s
        // after arrival, and it reports the pull-out time.
        const arr = NOW() - 90;
        const dep = NOW() + 120;
        addArrival('80101', {
            tripId: 'TR-A-99', vehicleId: 'V99', routeId: '801', directionId: 0,
            arrivalUnix: arr, departureUnix: dep, lastIngestUnix: NOW(),
        });
        window.masterTripsData['TR-A-99'] = { ...window.masterTripsData['TR-A-1'] };
        initPredictions();
        const result = getBoardingVehicles(['80101']);
        expect(result).toHaveLength(1);
        expect(result[0].departureUnix).toBe(dep);
    });

    it('drops an entry whose arrival AND departure are both past-grace', () => {
        // Both times well past → the train has left; must not linger as "boarding".
        addArrival('80101', {
            tripId: 'TR-A-99', vehicleId: 'V99', routeId: '801', directionId: 0,
            arrivalUnix: NOW() - 200, departureUnix: NOW() - 120, lastIngestUnix: NOW(),
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

/**
 * getNextOriginDeparture — the terminus badge's fallback when nothing is
 * "boarding".
 *
 * getBoardingVehicles answers the narrow question "is a train physically
 * sitting here?" and caps at BOARDING_MAX_HORIZON_S (10 min). That cap left the
 * badge showing an em-dash whenever the next departure was further out, which
 * at off-peak headways is most of the time. An em-dash must mean "nothing
 * known", not "nothing within ten minutes".
 */
describe('getNextOriginDeparture — no boarding horizon', () => {
    it('returns a departure well beyond BOARDING_MAX_HORIZON_S', () => {
        const dep = NOW() + 23 * 60;   // 23 min — invisible to getBoardingVehicles
        addArrival('80101', {
            tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: dep, departureUnix: dep, lastIngestUnix: NOW(),
        });
        expect(getBoardingVehicles(['80101'])).toHaveLength(0);
        expect(getNextOriginDeparture('80101', '801', 0, NOW())).toBe(dep);
    });

    it('returns the DEPARTURE, not the layover arrival', () => {
        // At a terminus the train pulls IN, sits, then pulls OUT. Only the
        // pull-out is actionable for someone on the platform.
        const arr = NOW() + 11 * 60, dep = NOW() + 15 * 60;
        addArrival('80101', {
            tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: arr, departureUnix: dep, lastIngestUnix: NOW(),
        });
        expect(getNextOriginDeparture('80101', '801', 0, NOW())).toBe(dep);
    });

    it('picks the soonest of several known departures', () => {
        const soon = NOW() + 12 * 60, later = NOW() + 40 * 60;
        addArrival('80101', { tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: later, departureUnix: later, lastIngestUnix: NOW() });
        addArrival('80101', { tripId: 'TR-A-2', routeId: '801', directionId: 0,
            arrivalUnix: soon, departureUnix: soon, lastIngestUnix: NOW() });
        window.masterTripsData['TR-A-2'] = { ...window.masterTripsData['TR-A-1'] };
        expect(getNextOriginDeparture('80101', '801', 0, NOW())).toBe(soon);
    });

    it('ignores stale entries', () => {
        addArrival('80101', {
            tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 20 * 60, departureUnix: NOW() + 20 * 60,
            lastIngestUnix: NOW() - 9999,
        });
        expect(getNextOriginDeparture('80101', '801', 0, NOW())).toBeNull();
    });

    it('ignores a departure that is already well past', () => {
        const gone = NOW() - 600;
        addArrival('80101', { tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: gone, departureUnix: gone, lastIngestUnix: NOW() });
        expect(getNextOriginDeparture('80101', '801', 0, NOW())).toBeNull();
    });

    it('does not leak another route or direction into this origin', () => {
        addArrival('80101', { tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 20 * 60, departureUnix: NOW() + 20 * 60,
            lastIngestUnix: NOW() });
        expect(getNextOriginDeparture('80101', '801', 1, NOW())).toBeNull();
        expect(getNextOriginDeparture('80101', '901', 0, NOW())).toBeNull();
    });

    it('returns null when the stop is not this route/direction origin', () => {
        addArrival('80202', { tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 20 * 60, departureUnix: NOW() + 20 * 60,
            lastIngestUnix: NOW() });
        expect(getNextOriginDeparture('80202', '801', 0, NOW())).toBeNull();
    });

    it('returns null when nothing is known — the only case that earns an em-dash', () => {
        expect(getNextOriginDeparture('80101', '801', 0, NOW())).toBeNull();
    });
});
