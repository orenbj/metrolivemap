import { vi, describe, it, expect, beforeEach } from 'vitest';

import {
    scanGhostArrivals, recordMarkerDrop, recordFeedDrop, recordReceived, _report,
    readFeedStatsRing, clearFeedStatsRing, FEED_STATS_RING_KEY, FEED_STATS_RING_MAX,
    _resetFeedStatsForTest,
} from '../js/feedStats.js';

const NOW = 1_700_000_000;  // fixed reference clock

function makeMarker({ vehicle_id, trip_id }) {
    return { properties: { vehicle_id, trip_id } };
}

function makeArrival({ vehicleId = '', tripId = '', ingestAge = 5, routeId = '801' }) {
    return {
        routeId,
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

    it('does NOT count city-bus routes (no vehicle_positions subscription → no marker by design)', () => {
        // trip_updates covers the whole bus network, but markers come only from
        // rail + BRT 901/910. A local bus like the 212 has predictions but never
        // a marker — counting it swamped the genuine rail/BRT divergence signal.
        window.masterArrivalsData.set('15045', [
            makeArrival({ vehicleId: 'BUS1', tripId: 'TB1', ingestAge: 5, routeId: '212' }),
            makeArrival({ vehicleId: 'BUS2', tripId: 'TB2', ingestAge: 5, routeId: '20' }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(0);
    });

    it('DOES count route 950 ghosts (now subscribed to vehicle_positions, so missing markers are genuine ghosts)', () => {
        window.masterArrivalsData.set('80999', [
            makeArrival({ vehicleId: 'V950', tripId: 'T950', ingestAge: 5, routeId: '950' }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(1);
    });

    it('DOES count BRT 901/910 ghosts (these are rendered as markers)', () => {
        window.masterArrivalsData.set('60100', [
            makeArrival({ vehicleId: 'V901', tripId: 'T901', ingestAge: 5, routeId: '901' }),
            makeArrival({ vehicleId: 'V910', tripId: 'T910', ingestAge: 5, routeId: '910' }),
        ]);
        expect(scanGhostArrivals(NOW)).toBe(2);
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
    // away with the DR machinery they reported on. The hygiene counters
    // (offRoute, popupDOMOrphan) remain.
    const FREEZE_REASONS = ['offRoute', 'popupDOMOrphan'];

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

    it('prints the new correction counters in the corrections segment', () => {
        recordMarkerDrop('hardReanchor');
        recordMarkerDrop('streakForceAccept');
        recordMarkerDrop('declaredAnchor');
        recordMarkerDrop('backwardRelease');
        recordMarkerDrop('stopLagReanchor');
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        expect(line).toBeDefined();
        const corr = line.match(/corrections\(([^)]*)\)/)?.[1];
        expect(corr).toContain('hardReanchor=1');
        expect(corr).toContain('streakForceAccept=1');
        expect(corr).toContain('declaredAnchor=1');
        expect(corr).toContain('backwardRelease=1');
        expect(corr).toContain('stopLagReanchor=1');
    });

    it('prints crossLineSpike in the ingest segment (lockstep with the registry)', () => {
        recordMarkerDrop('crossLineSpike');
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        const ingestSegment = line.match(/ingest\(([^)]*)\)/)?.[1];
        expect(ingestSegment).toContain('crossLineSpike=1');
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

    it('midnightTripIdMiss accepts a batch count and prints in the hygiene segment (#246)', () => {
        // The rollover instrumentation fires ONCE per service-date swap with
        // the whole vehicle count, via recordMarkerDrop's count parameter —
        // not once per affected vehicle.
        recordMarkerDrop('midnightTripIdMiss', 3);
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        expect(line).toBeDefined();
        const hygieneSegment = line.match(/hygiene\(([^)]*)\)/)?.[1];
        expect(hygieneSegment).toContain('midnightTripIdMiss=3');
    });

    it('recordMarkerDrop count defaults to 1 (existing call sites unchanged)', () => {
        recordMarkerDrop('midnightTripIdMiss');
        recordMarkerDrop('midnightTripIdMiss');
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        expect(line).toContain('midnightTripIdMiss=2');
    });

});

describe('clock-skew blank-map alarm', () => {
    let warnSpy;
    beforeEach(() => {
        _resetFeedStatsForTest();   // clean session: counters + one-shot skew guard
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});  // silence the report line
    });

    const URL = 'wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions';
    const pump = (received, futureTs) => {
        for (let i = 0; i < received; i++) recordReceived(URL);
        for (let i = 0; i < futureTs; i++) recordFeedDrop(URL, 'futureTs');
    };

    it('warns once when ≥50% of frames drop as future-stamped on non-trivial volume', () => {
        pump(40, 30);   // 75% futureTs, 40 ≥ 20 received
        _report();
        const warn = warnSpy.mock.calls.find(c => /CLOCK SKEW SUSPECTED/.test(c[0]));
        expect(warn).toBeDefined();
        expect(warn[0]).toContain('30/40');
    });

    it('does NOT warn on low volume (< 20 received), even at 100% futureTs', () => {
        pump(10, 10);
        _report();
        expect(warnSpy.mock.calls.find(c => /CLOCK SKEW/.test(c[0]))).toBeUndefined();
    });

    it('does NOT warn when the future-stamp fraction is below 50%', () => {
        pump(100, 10);  // 10%
        _report();
        expect(warnSpy.mock.calls.find(c => /CLOCK SKEW/.test(c[0]))).toBeUndefined();
    });

    it('fires at most once per session', () => {
        pump(40, 40);
        _report();
        warnSpy.mockClear();
        pump(40, 40);   // still skewed next interval
        _report();
        expect(warnSpy.mock.calls.find(c => /CLOCK SKEW/.test(c[0]))).toBeUndefined();
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
        recordMarkerDrop('popupDOMOrphan');
        _report();

        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(1);
        const [entry] = ring;
        expect(entry.markers.offRoute).toBe(2);
        expect(entry.markers.popupDOMOrphan).toBe(1);
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
        recordMarkerDrop('popupDOMOrphan');
        _report();
        recordMarkerDrop('spike');
        _report();
        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(3);
        expect(ring[0].markers.offRoute).toBe(1);
        expect(ring[1].markers.popupDOMOrphan).toBe(1);
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

    // ── In-memory mirror (perf #254) — the append path no longer re-parses the
    // whole ring from localStorage every tick. These pin the behavior that the
    // optimization must preserve: persisted state is still authoritative, the
    // cap still holds, and an external writer is still honored.
    it('append still reflects in localStorage (in-memory mirror is persisted, not just cached)', () => {
        recordMarkerDrop('offRoute');
        _report();
        // Read the raw string directly — bypasses readFeedStatsRing — to prove
        // the in-memory ring was actually written through to storage.
        const raw = localStorage.getItem(FEED_STATS_RING_KEY);
        const parsed = JSON.parse(raw);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].markers.offRoute).toBe(1);
    });

    it('honors an external writer that replaces the ring between ticks', () => {
        // Tick 1 seeds the in-memory mirror.
        recordMarkerDrop('offRoute');
        _report();
        expect(readFeedStatsRing()).toHaveLength(1);
        // An external writer (debugger / test harness) overwrites storage with a
        // different array. The next append must pick THIS up, not the stale
        // in-memory cache.
        localStorage.setItem(FEED_STATS_RING_KEY, JSON.stringify([
            { t: 1_000_000_001, feeds: {}, markers: {}, ghosts: 0 },
            { t: 1_000_000_002, feeds: {}, markers: {}, ghosts: 0 },
        ]));
        recordMarkerDrop('spike');
        _report();
        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(3);
        expect(ring[0].t).toBe(1_000_000_001);
        expect(ring[1].t).toBe(1_000_000_002);
        expect(ring[ring.length - 1].markers.spike).toBe(1);
    });

    it('caps at FEED_STATS_RING_MAX across many sequential appends (in-memory trim)', () => {
        // Seed near the cap directly, then drive a handful of real ticks so the
        // trim runs on the in-memory array rather than a freshly-parsed one.
        const seed = Array.from({ length: FEED_STATS_RING_MAX - 2 }, (_, i) => ({
            t: 1_000_000_000 + i, feeds: {}, markers: {}, ghosts: 0,
        }));
        localStorage.setItem(FEED_STATS_RING_KEY, JSON.stringify(seed));
        for (let i = 0; i < 5; i++) {
            recordMarkerDrop('offRoute');
            _report();
        }
        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(FEED_STATS_RING_MAX);
        // Last five entries are the live ticks; oldest seed rows were dropped.
        expect(ring[ring.length - 1].markers.offRoute).toBe(1);
    });

    it('clearFeedStatsRing invalidates the cache so the next append starts fresh', () => {
        recordMarkerDrop('offRoute');
        _report();
        expect(readFeedStatsRing()).toHaveLength(1);
        clearFeedStatsRing();
        recordMarkerDrop('spike');
        _report();
        const ring = readFeedStatsRing();
        expect(ring).toHaveLength(1);
        expect(ring[0].markers.spike).toBe(1);
        expect(ring[0].markers.offRoute).toBe(0);
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

    it('registers the #253 defensive counters (oversizeFrame feed-drop + popupDOMOrphan marker)', () => {
        // Guard against forgetting to register a counter: recordFeedDrop /
        // recordMarkerDrop silently no-op on an unknown key (Object.hasOwn gate),
        // so an unregistered counter would never increment. Assert both surface.
        const url = 'wss://api.metro.net/ws/test/vehicle_positions';
        recordReceived(url);
        recordFeedDrop(url, 'oversizeFrame');
        recordFeedDrop(url, 'oversizeFrame');
        recordMarkerDrop('popupDOMOrphan');
        _report();
        const lines = infoSpy.mock.calls.map(c => c[0]).filter(Boolean);
        expect(lines.find(s => s.includes('oversize='))).toContain('oversize=2');
        expect(lines.find(s => s.includes('popupDOMOrphan='))).toContain('popupDOMOrphan=1');
    });
});
