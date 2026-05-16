/**
 * Tests for js/trajectoryBuilder.js — Phase 5.2 trajectory builder.
 *
 * Lightweight integration test of the builder against a known route cache
 * and a stubbed DwellModel. The Trajectory class itself has its own deep
 * unit tests; here we only verify that:
 *   - the cache → fromAnchor translation produces a valid Trajectory
 *   - cruise speed is derived from the schedule (not v_now)
 *   - dwellModel is consulted per stop
 *   - missing/non-finite arcs are skipped
 *   - service-date midnight conversion is deterministic
 */

import { describe, it, expect } from 'vitest';

import { buildTrajectoryFor, serviceDateMidnightUnixFor } from '../js/trajectoryBuilder.js';
import { Trajectory } from '../js/trajectory.js';

// Stub a minimal DwellModel-shaped object. We deliberately don't import the
// real class here — the builder only calls .get(); decoupling lets us
// assert which keys were requested without spying through localStorage.
function makeStubDwell({ defaultS = 20, perKey = {} } = {}) {
    const seen = [];
    return {
        seen,
        get({ stopId, routeId, directionId }) {
            seen.push({ stopId, routeId, directionId });
            return perKey[stopId] ?? defaultS;
        },
    };
}

// Sample route cache: 4 stops, evenly spaced 1000 m apart, 120 s between
// scheduled times (schedule cruise = 1000/120 ≈ 8.33 m/s).
function makeCache() {
    return {
        stops:     ['S1', 'S2', 'S3', 'S4'],
        arcMeters: [0, 1000, 2000, 3000],
        // seconds since midnight, chosen so the first stop is at 06:00
        times:     [21600, 21720, 21840, 21960],
    };
}

const SERVICE_MIDNIGHT_UNIX = 1_700_000_000;     // arbitrary fixed unix
const T_NOW                  = SERVICE_MIDNIGHT_UNIX + 21600 - 30;  // 30 s before S1

describe('buildTrajectoryFor', () => {
    it('returns a Trajectory when the cache has arc data', () => {
        const traj = buildTrajectoryFor({
            t_now: T_NOW, arc_now: 0, v_now: 0,
            cache: makeCache(),
            nextStopIdx: 0,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(traj).toBeInstanceOf(Trajectory);
        expect(traj.segments.length).toBeGreaterThan(0);
    });

    it('returns null when the cache has no arc data (route has no shape)', () => {
        const traj = buildTrajectoryFor({
            t_now: T_NOW, arc_now: 0, v_now: 5,
            cache: { stops: ['S1', 'S2'], times: [21600, 21720] },  // no arcMeters
            nextStopIdx: 0,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(traj).toBeNull();
    });

    it('returns null when nextStopIdx is out of range', () => {
        const traj = buildTrajectoryFor({
            t_now: T_NOW, arc_now: 0, v_now: 5,
            cache: makeCache(),
            nextStopIdx: 99,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(traj).toBeNull();
    });

    it('consults dwellModel for each upcoming stop', () => {
        const dwell = makeStubDwell();
        buildTrajectoryFor({
            t_now: T_NOW, arc_now: 0, v_now: 5,
            cache: makeCache(),
            nextStopIdx: 0,
            routeId: '801', directionId: 0,
            dwellModel: dwell,
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        // Builder asked for dwell of every stop from idx 0 forward.
        expect(dwell.seen.map(s => s.stopId)).toEqual(['S1', 'S2', 'S3', 'S4']);
        expect(dwell.seen[0]).toMatchObject({ routeId: '801', directionId: 0 });
    });

    it('skips stops with non-finite arcs but builds a partial trajectory', () => {
        const cache = makeCache();
        cache.arcMeters[1] = null;  // S2 unresolved
        const traj = buildTrajectoryFor({
            t_now: T_NOW, arc_now: 0, v_now: 5,
            cache,
            nextStopIdx: 0,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        // Still builds (S1, S3, S4 are valid).
        expect(traj).toBeInstanceOf(Trajectory);
    });

    it('derives cruise speed from schedule, not from v_now', () => {
        // Construct two cache rows with very different schedule speeds so the
        // resulting trajectory's free-segment v_start is observable.
        const cache = {
            stops:     ['A', 'B'],
            arcMeters: [0, 1000],
            times:     [10000, 10100],  // 100 s for 1000 m → 10 m/s
        };
        const traj = buildTrajectoryFor({
            t_now: SERVICE_MIDNIGHT_UNIX + 9000, arc_now: 0, v_now: 1, // v_now intentionally tiny
            cache, nextStopIdx: 0,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell({ defaultS: 0 }),  // no dwell so the free seg is observable
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        // First segment should cruise at the schedule speed (~10 m/s), well above v_now=1.
        const free = traj.segments.find(s => s.kind === 'free');
        expect(free).toBeTruthy();
        expect(free.v_start).toBeCloseTo(10, 0);
    });
});

describe('serviceDateMidnightUnixFor', () => {
    it('rounds to local midnight (zero hours/minutes/seconds)', () => {
        // Pick a known instant; computing it twice should be stable.
        const a = serviceDateMidnightUnixFor(new Date(2026, 4, 15, 14, 30, 45));
        const b = serviceDateMidnightUnixFor(new Date(2026, 4, 15, 22, 59, 59));
        // Same calendar day → same midnight.
        expect(a).toBe(b);
    });

    it('different calendar days yield different midnights', () => {
        const a = serviceDateMidnightUnixFor(new Date(2026, 4, 15, 12, 0, 0));
        const b = serviceDateMidnightUnixFor(new Date(2026, 4, 16, 12, 0, 0));
        // Exactly 86400 seconds apart in standard time; ±3600 for DST transitions
        // which aren't in play between mid-May days. Use an order-of-magnitude
        // assertion that survives if test machine is in a DST locale.
        expect(b - a).toBeGreaterThan(80_000);
        expect(b - a).toBeLessThan(90_000);
    });
});
