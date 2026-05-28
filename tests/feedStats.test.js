import { vi, describe, it, expect, beforeEach } from 'vitest';

import {
    scanGhostArrivals, recordMarkerDrop, recordFeedDrop, recordReceived, _report,
    readFeedStatsRing, clearFeedStatsRing, FEED_STATS_RING_KEY, FEED_STATS_RING_MAX,
} from '../js/feedStats.js';

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

    it('does NOT count synthetic block_*_schedBasedVehicle entries (schedule-derived predictions, not divergence)', () => {
        // Metro's trip_updates feed publishes entries with vehicleIds like
        // "block_459_schedBasedVehicle" for trips that haven't been assigned
        // a live vehicle yet. These are NOT feed divergence by design.
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'block_459_schedBasedVehicle', tripId: 'T1', ingestAge: 5 }),
            makeArrival({ vehicleId: 'block_414_schedBasedVehicle', tripId: 'T2', ingestAge: 5 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('still counts a genuine ghost alongside filtered schedule-based entries', () => {
        // Mixed list: one synthetic schedule-based + one real ghost. Only
        // the real ghost should count.
        window.masterArrivalsData.set('80122', [
            makeArrival({ vehicleId: 'block_459_schedBasedVehicle', tripId: 'T1', ingestAge: 5 }),
            makeArrival({ vehicleId: 'V_real', tripId: 'T_real', ingestAge: 5 }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(1);
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
    // Counters that survived the dead-reckoning removal (PR #257). The
    // watchdog/intersection/misfire/stopIdLag/clamp/race counters all went
    // away with the DR machinery they reported on. Only the snap-quality
    // counters (offRoute, noSnap) remain.
    const FREEZE_REASONS = ['offRoute', 'noSnap'];

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
        recordMarkerDrop('offRoute');
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

    it('includes preBootstrap in the ingest segment of the report line', () => {
        // Pre-bootstrap is an ingest-side drop (frame arrived before
        // masterStopsData loaded), not a freeze episode. It should appear in
        // the ingest segment alongside staleAge/olderTs/spike/coldStartSpike.
        recordMarkerDrop('preBootstrap');
        recordMarkerDrop('preBootstrap');
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        expect(line).toBeDefined();
        expect(line).toContain('preBootstrap=2');
        // And it lives inside the ingest(...) parens, not freeze(...).
        const ingestSegment = line.match(/ingest\(([^)]*)\)/)?.[1];
        expect(ingestSegment).toContain('preBootstrap=2');
    });

});

describe('localStorage ring buffer', () => {
    // Each _report() tick with activity should append one structured entry to
    // localStorage under FEED_STATS_RING_KEY. The ring is the only artifact
    // that survives the per-minute counter reset, so accuracy here directly
    // determines whether offline analysis can quantify feed quirks.
    let infoSpy;
    beforeEach(() => {
        clearFeedStatsRing();
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        // Drain any counter residue from earlier tests in this file so the
        // ring entries written here only reflect what each test recorded.
        _report();
        clearFeedStatsRing();
        infoSpy.mockClear();
    });

    it('appends one entry per tick with the snapshotted marker counters', () => {
        recordMarkerDrop('offRoute');
        recordMarkerDrop('offRoute');
        recordMarkerDrop('noSnap');
        _report();

        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(1);
        const [entry] = ring;
        expect(entry.markers.offRoute).toBe(2);
        expect(entry.markers.noSnap).toBe(1);
        // Zeros are preserved so consumers can distinguish 0 from absent.
        expect(entry.markers.staleAge).toBe(0);
        expect(entry.markers.spike).toBe(0);
        expect(typeof entry.t).toBe('number');
        expect(entry.t).toBeGreaterThan(1_600_000_000);
    });

    it('appends one entry per tick with the snapshotted feed counters', () => {
        const url = 'wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions';
        recordReceived(url); recordReceived(url); recordReceived(url);
        recordFeedDrop(url, 'jsonParse');
        _report();

        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(1);
        const feeds = ring[0].feeds;
        expect(feeds.LACMTA_Rail).toMatchObject({
            rcv: 3,
            drops: { jsonParse: 1 },
        });
        // Cadence is recorded as a number (parsed from the fixed-1 string).
        expect(typeof feeds.LACMTA_Rail.cadence).toBe('number');
    });

    it('skips silent intervals — empty ticks do NOT append an entry', () => {
        _report();
        expect(readFeedStatsRing()).toHaveLength(0);
        // And again — still empty.
        _report();
        expect(readFeedStatsRing()).toHaveLength(0);
    });

    it('preserves prior entries across ticks (ring accumulates)', () => {
        recordMarkerDrop('offRoute');
        _report();
        recordMarkerDrop('noSnap');
        _report();
        recordMarkerDrop('spike');
        _report();
        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(3);
        expect(ring[0].markers.offRoute).toBe(1);
        expect(ring[1].markers.noSnap).toBe(1);
        expect(ring[2].markers.spike).toBe(1);
    });

    it('trims to FEED_STATS_RING_MAX entries when capacity is exceeded', () => {
        // Bypass the real reporting path by writing entries directly via the
        // public storage API — the trim logic operates on whatever is in
        // localStorage at the time of write.
        const oversized = Array.from({ length: FEED_STATS_RING_MAX + 5 }, (_, i) => ({
            t: 1_000_000_000 + i,
            feeds: {},
            markers: {},
            ghosts: 0,
        }));
        localStorage.setItem(FEED_STATS_RING_KEY, JSON.stringify(oversized));
        // Trigger one more tick with activity to invoke the trim.
        recordMarkerDrop('offRoute');
        _report();
        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(FEED_STATS_RING_MAX);
        // The oldest 6 entries were dropped; the newest tick is the last one.
        expect(ring[0].t).toBe(1_000_000_000 + 6);
        expect(ring[ring.length - 1].markers.offRoute).toBe(1);
    });

    it('readFeedStatsRing handles missing / malformed storage gracefully', () => {
        clearFeedStatsRing();
        expect(readFeedStatsRing()).toEqual([]);
        localStorage.setItem(FEED_STATS_RING_KEY, '{not json');
        expect(readFeedStatsRing()).toEqual([]);
    });
});

describe('recordFeedDrop — jsonParse counter', () => {
    let infoSpy;
    beforeEach(() => {
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    });

    it('accepts jsonParse as a drop reason and surfaces it in the per-feed report', () => {
        // Pre-fix, JSON parse errors were caught and logged but never counted.
        // Persistent malformed frames produced log spam without measurable
        // signal in feedStats. New reason: jsonParse.
        const url = 'wss://api.metro.net/ws/test/vehicle_positions';
        recordReceived(url);
        recordFeedDrop(url, 'jsonParse');
        recordFeedDrop(url, 'jsonParse');
        recordFeedDrop(url, 'jsonParse');
        _report();
        const line = infoSpy.mock.calls.map(c => c[0]).find(s => s?.includes('jsonParse='));
        expect(line).toBeDefined();
        expect(line).toContain('jsonParse=3');
    });
});
