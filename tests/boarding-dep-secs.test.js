/**
 * The vehicle popup's boarding countdown (R2-01).
 *
 * `getBoardingDepSecs` was a 12-line hand-rolled copy of `getBoardingVehicles`'
 * Tier 1, and it had drifted from it in three independent ways — each of which
 * makes the vehicle popup and the station popup disagree about the same train:
 *
 *   (a) it read `arrivalUnix` instead of `departureUnix`. At a terminus the
 *       arrival is the layover pull-IN, usually already past, so the countdown
 *       computed 0 and ui.js suppressed the pill entirely: "Boarding" with no
 *       departure time, for the whole dwell.
 *   (b) it had no `lastIngestUnix` staleness gate, unlike every other consumer
 *       of masterArrivalsData. A prediction that stopped refreshing ten minutes
 *       ago still drove a confident "Departs 10m". That is the worst of the
 *       three — WRONG information rather than missing information.
 *   (c) it read `direction_id` straight off the frame instead of preferring
 *       `masterTripsData[trip].dir`, so a frame where Metro omits direction
 *       (which the marker deliberately nulls) lost the countdown entirely.
 *
 * The fix delegates to `getBoardingVehicles` rather than patching three lines,
 * so there is one implementation and the drift cannot recur. These tests assert
 * the BEHAVIOUR, so they hold whichever way a future author implements it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());

import { initPredictions } from '../js/predictions.js';
import { _getBoardingDepSecsForTest as getBoardingDepSecs } from '../js/markers.js';

const NOW = () => Math.floor(Date.now() / 1000);
const STOPS = ['s0', 's1', 's2'];

function seed() {
    window.masterStopsData = {
        s0: { name: 'Pomona North Station', lat: 34.06, lon: -117.75 },
        s1: { name: 'La Verne Station', lat: 34.09, lon: -117.77 },
        s2: { name: 'San Dimas Station', lat: 34.10, lon: -117.80 },
    };
    window.masterTripsData = {
        't1': { rc: '801', dir: 1, stops: STOPS, scheduledTimes: STOPS.map((_, i) => i * 300) },
    };
    window.masterArrivalsData = new Map();
    window.vehicleMarkers = {};
    initPredictions();
}

/** A train sitting at its origin, i.e. the boarding case. */
function boardingMarker({ dir = 1, tripId = 't1' } = {}) {
    const m = {
        properties: {
            trip_id: tripId, route_code: '801', direction_id: dir,
            stopId: 's0', vehicle_id: 'v1', currentStatus: 'STOPPED_AT',
        },
        _lastAcceptedTs: NOW(), timestamp: NOW(),
    };
    window.vehicleMarkers = { [tripId]: m };
    return m;
}

function entry(stopId, e) {
    window.masterArrivalsData.set(String(stopId), [{ lastIngestUnix: NOW(), vehicleId: 'v1', ...e }]);
}

beforeEach(() => { seed(); });

describe('boarding countdown reads the pull-OUT, not the layover pull-in', () => {
    it('counts down to departure when the two differ', () => {
        // Pulled in 3 minutes ago, leaves in 7. A rider on the platform needs 7.
        const now = NOW();
        entry('s0', { tripId: 't1', arrivalUnix: now - 180, departureUnix: now + 420 });
        expect(getBoardingDepSecs(boardingMarker())).toBeGreaterThan(400);
    });

    it('falls back to the arrival when the entry carries no departure', () => {
        // Cross-midnight-preserved entries predate the field; they must still work.
        const now = NOW();
        entry('s0', { tripId: 't1', arrivalUnix: now + 300 });
        expect(getBoardingDepSecs(boardingMarker())).toBeGreaterThan(280);
    });
});

describe('a stale prediction must not drive a confident countdown', () => {
    it('does not report a departure from an entry that stopped refreshing', () => {
        // Ten minutes without a refresh. Every other consumer of
        // masterArrivalsData gates on GTFS_ENTRY_STALENESS_S; this one did not,
        // so it presented a ten-minute-old guess as live.
        const now = NOW();
        window.masterArrivalsData.set('s0', [{
            tripId: 't1', vehicleId: 'v1',
            arrivalUnix: now + 600, departureUnix: now + 600,
            lastIngestUnix: now - 600,
        }]);
        const secs = getBoardingDepSecs(boardingMarker());
        // Boarding (0 → "Boarding", no pill) is the honest answer; a countdown
        // built on stale data is not.
        expect(secs === 0 || secs === null, `expected no live countdown, got ${secs}`).toBe(true);
    });
});

describe('direction resolution matches every other consumer', () => {
    it('still works on a frame where Metro omitted direction_id', () => {
        // markers.js deliberately nulls direction_id on a direction-less frame,
        // so reading it straight off the frame loses the countdown on roughly
        // half of all frames. masterTripsData knows the direction.
        const now = NOW();
        entry('s0', { tripId: 't1', arrivalUnix: now - 60, departureUnix: now + 300 });
        const m = boardingMarker({ dir: null });
        expect(getBoardingDepSecs(m), 'static GTFS knows this trip is dir 1').toBeGreaterThan(280);
    });
});

describe('the non-boarding cases still opt out', () => {
    it('returns null for a train in motion', () => {
        const now = NOW();
        entry('s0', { tripId: 't1', arrivalUnix: now + 300, departureUnix: now + 300 });
        const m = boardingMarker();
        m.properties.currentStatus = 'IN_TRANSIT_TO';
        expect(getBoardingDepSecs(m)).toBeNull();
    });

    it('returns null when stopped somewhere that is not an origin', () => {
        const m = boardingMarker();
        m.properties.stopId = 's1';
        expect(getBoardingDepSecs(m)).toBeNull();
    });

    it('reports boarding-with-no-time rather than null when no prediction exists', () => {
        // The train is demonstrably sitting at its origin; we just do not know
        // when it leaves. ui.js renders "Boarding" with no pill.
        expect(getBoardingDepSecs(boardingMarker())).toBe(0);
    });

    it('never returns a negative countdown', () => {
        const now = NOW();
        entry('s0', { tripId: 't1', arrivalUnix: now - 600, departureUnix: now - 300 });
        const secs = getBoardingDepSecs(boardingMarker());
        expect(secs).not.toBeLessThan(0);
    });
});

describe('the vehicle popup and the station popup agree', () => {
    it('gives the same departure the boarding badge would show', async () => {
        const now = NOW();
        entry('s0', { tripId: 't1', arrivalUnix: now - 180, departureUnix: now + 420 });
        const m = boardingMarker();
        const { getBoardingVehicles } = await import('../js/predictions.js');
        const badge = getBoardingVehicles(['s0']).find(b => b.tripId === 't1');
        expect(badge, 'the station side must see this train too').toBeTruthy();
        const fromBadge = Math.max(0, badge.departureUnix - now);
        const fromPopup = getBoardingDepSecs(m);
        // Same train, same platform, same second — the two surfaces must not
        // disagree, which is the whole reason for delegating to one source.
        expect(Math.abs(fromPopup - fromBadge)).toBeLessThanOrEqual(1);
    });
});
