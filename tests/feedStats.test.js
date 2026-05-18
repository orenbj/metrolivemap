import { vi, describe, it, expect, beforeEach } from 'vitest';

import { scanGhostArrivals, recordMarkerDrop, _report } from '../js/feedStats.js';

const NOW = 1_700_000_000;  // fixed reference clock

function makeMarker({ vehicle_id, trip_id }) {
    return { properties: { vehicle_id, trip_id } };
}

function makeArrival({ vehicleId = '', tripId = '', ingestAge = 5 }) {
    return {
        routeId: '801',
        directionId: 0,
        vehicleId,
        tripId,
        arrivalUnix: NOW + 120,
        lastIngestUnix: NOW - ingestAge,
    };
}

beforeEach(() => {
    window.vehicleMarkers = {};
    window.masterArrivalsData = new Map();
});

describe('scanGhostArrivals', () => {
    it('returns 0 when arrivals + markers are both empty', () => {
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('returns 0 when masterArrivalsData is missing entirely', () => {
        window.masterArrivalsData = null;
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('counts an arrival with a vehicleId that has no matching marker', () => {
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'V1', tripId: 'T1', ingestAge: 5 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(1);
    });

    it('does NOT count when a marker exists with matching vehicle_id', () => {
        window.vehicleMarkers.T1 = makeMarker({ vehicle_id: 'V1', trip_id: 'T1' });
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'V1', tripId: 'T1', ingestAge: 5 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('does NOT count when a marker exists with matching trip_id but different vehicle_id', () => {
        // Metro can re-assign vehicles between trips — tripId fallback prevents
        // a re-assigned vehicle from being flagged as a ghost.
        window.vehicleMarkers.T1 = makeMarker({ vehicle_id: 'V_new', trip_id: 'T1' });
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'V_old', tripId: 'T1', ingestAge: 5 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('does NOT count arrivals with empty vehicleId (Metro frequently omits vehicle.id)', () => {
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: '', tripId: 'T1', ingestAge: 5 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('does NOT count arrivals whose ingest is older than 60s', () => {
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'V1', tripId: 'T1', ingestAge: 120 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('counts multiple ghosts across different stops', () => {
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'V1', tripId: 'T1', ingestAge: 5 }),
            makeArrival({ vehicleId: 'V2', tripId: 'T2', ingestAge: 10 }),
        ]);
        window.masterArrivalsData.set('80401', [
            makeArrival({ vehicleId: 'V3', tripId: 'T3', ingestAge: 20 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(3);
    });

    it('mixes counted and skipped entries correctly', () => {
        window.vehicleMarkers.T1 = makeMarker({ vehicle_id: 'V1', trip_id: 'T1' });
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'V1', tripId: 'T1', ingestAge: 5 }),    // has marker — skip
            makeArrival({ vehicleId: 'V2', tripId: 'T2', ingestAge: 5 }),    // ghost — count
            makeArrival({ vehicleId: '',   tripId: 'T3', ingestAge: 5 }),    // empty vehicleId — skip
            makeArrival({ vehicleId: 'V4', tripId: 'T4', ingestAge: 120 }),  // stale ingest — skip
        ]);
        expect(scanGhostArrivals(NOW)).toBe(1);
    });

    it('handles missing lastIngestUnix defensively', () => {
        const stale = {
            routeId: '801', directionId: 0,
            vehicleId: 'V1', tripId: 'T1',
            arrivalUnix: NOW + 120,
            // lastIngestUnix deliberately omitted
        };
        window.masterArrivalsData.set('80122', [stale]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });
});

// ── recordMarkerDrop: freeze-episode counters added by the freeze audit ──
describe('recordMarkerDrop — freeze counters', () => {
    // Each reason added in the freeze-audit Piece A. Validated by triggering
    // _report and inspecting the log line; the report also resets counters so
    // the next test starts clean.
    const FREEZE_REASONS = [
        'watchdogRail', 'watchdogBus', 'offRoute', 'coldStartStationary',
        'noSnap', 'intersectionPause', 'bearingBudgetExhausted',
        'stoppedAtMisfire', 'animateMarkerRace',
    ];

    let infoSpy;
    beforeEach(() => {
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    it('accepts each new freeze reason and includes it in the report', () => {
        for (const reason of FREEZE_REASONS) recordMarkerDrop(reason);
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        expect(line).toBeDefined();
        for (const reason of FREEZE_REASONS) {
            expect(line).toContain(`${reason}=1`);
        }
    });

    it('resets counters to 0 after _report', () => {
        recordMarkerDrop('watchdogRail');
        _report();
        infoSpy.mockClear();
        // Trigger again with no new drops — no markers: line should be emitted
        // because the counters are all zero (the guard `some(v => v > 0)` is false).
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'));
        expect(line).toBeUndefined();
    });

    it('silently ignores unknown reasons (no throw, no side effect)', () => {
        expect(() => recordMarkerDrop('madeUpReason')).not.toThrow();
        _report();
        // The line is only emitted when SOME counter is non-zero. An unknown
        // reason mustn't bump any known counter, so no line should appear.
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'));
        expect(line).toBeUndefined();
    });
});
