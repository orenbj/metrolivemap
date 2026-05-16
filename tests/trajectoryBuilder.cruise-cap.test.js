/**
 * Tests for the Phase 5.7 GPS-spike velocity cap in `buildTrajectoryFor`.
 *
 * `fromAnchor` uses `Math.max(v_now, cruise_v_raw)` for the free-segment
 * speed — a GPS noise spike (e.g. 50 m/s when true is 8 m/s) would project
 * the trajectory at the inflated speed until the next fix, producing
 * "rocket-and-snap" animation and biased ETA captures in the A/B harness.
 *
 * The builder caps `v_now` before passing it to `fromAnchor`:
 *     cap = min( HARD_MAX, max( 1.5 × schedule_cruise, TYPICAL_FAST ) )
 *     v_capped = min( v_now, cap )
 *
 * Test setup: vehicle is mid-segment between stops A and B. The "first
 * upcoming stop" in the trajectory is B. cruiseFn(0) inside the builder
 * looks at the A→B schedule pair (prevIdx = nextStopIdx - 1) and returns
 * a finite cruise — so the cap formula has a schedule reference to use.
 */

import { describe, it, expect } from 'vitest';
import { buildTrajectoryFor } from '../js/trajectoryBuilder.js';

const NOW_SEC = 1_700_000_000;
const SERVICE_MIDNIGHT_UNIX = NOW_SEC - 21600;  // 06:00 anchor

function makeStubDwell({ defaultS = 0 } = {}) {
    return { get: () => defaultS };
}

// Mid-segment scenario:
//   stops:     ['A', 'B', 'C']
//   arcMeters: [0,    1000, 2000]
//   times:     [21600, 21720, 21840]   ← 120s gaps, schedule cruise = 8.33 m/s
// Vehicle is mid-A→B at arc=500. nextStopIdx=1 (B is the next stop).
// cruiseFn(0) for the trajectory looks up A→B = 8.33 m/s.
function makeSlowCache() {
    return {
        stops:     ['A', 'B', 'C'],
        arcMeters: [0, 1000, 2000],
        times:     [21600, 21720, 21840],
    };
}

// Fast-segment variant: A→B is 1000 m in 50 s = 20 m/s schedule cruise.
// 1.5 × 20 = 30 — equal to RAIL_HARD_MAX, so the cap is exactly 30.
function makeFastCache() {
    return {
        stops:     ['A', 'B', 'C'],
        arcMeters: [0, 1000, 2000],
        times:     [21600, 21650, 21770],
    };
}

function firstFreeSegmentSpeed(traj) {
    const free = traj?.segments.find(s => s.kind === 'free');
    return free?.v_start;
}

describe('buildTrajectoryFor — GPS-spike velocity cap', () => {
    it('caps a wild GPS spike against the slow-segment schedule', () => {
        // v_now = 50 (spike). Schedule cruise = 8.33 m/s.
        //   cap = min(RAIL_HARD_MAX=30, max(1.5×8.33, RAIL_TYPICAL_FAST=22))
        //       = min(30, 22) = 22
        //   v_capped = min(50, 22) = 22
        // Inside fromAnchor: Math.max(22, 8.33) → 22 used as free-segment speed.
        const traj = buildTrajectoryFor({
            t_now: NOW_SEC, arc_now: 500, v_now: 50,
            cache: makeSlowCache(), nextStopIdx: 1,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(firstFreeSegmentSpeed(traj)).toBeCloseTo(22, 1);
    });

    it('caps to 1.5× schedule cruise when schedule is fast', () => {
        // v_now = 35. Schedule cruise = 20 m/s (fast). 1.5× = 30 m/s.
        //   cap = min(30, max(30, 22)) = 30
        //   v_capped = min(35, 30) = 30
        // Inside fromAnchor: Math.max(30, 20) = 30.
        const traj = buildTrajectoryFor({
            t_now: NOW_SEC, arc_now: 500, v_now: 35,
            cache: makeFastCache(), nextStopIdx: 1,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(firstFreeSegmentSpeed(traj)).toBeCloseTo(30, 1);
    });

    it('leaves a reasonable v_now alone (no cap fires)', () => {
        // v_now = 10. cap = 22.
        //   v_capped = min(10, 22) = 10
        // Inside fromAnchor: Math.max(10, 8.33) = 10.
        const traj = buildTrajectoryFor({
            t_now: NOW_SEC, arc_now: 500, v_now: 10,
            cache: makeSlowCache(), nextStopIdx: 1,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(firstFreeSegmentSpeed(traj)).toBeCloseTo(10, 1);
    });

    it('applies the bus-mode hard ceiling for bus routes', () => {
        // Bus route 910. Schedule cruise = 8.33 m/s.
        //   cap = min(BUS_HARD_MAX=25, max(1.5×8.33, BUS_TYPICAL_FAST=17))
        //       = min(25, 17) = 17
        //   v_capped = min(50, 17) = 17
        // Inside fromAnchor: Math.max(17, 8.33) = 17.
        const traj = buildTrajectoryFor({
            t_now: NOW_SEC, arc_now: 500, v_now: 50,
            cache: makeSlowCache(), nextStopIdx: 1,
            routeId: '910', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(firstFreeSegmentSpeed(traj)).toBeCloseTo(17, 1);
    });

    it('falls back to TYPICAL_FAST when no schedule cruise reference is available', () => {
        // nextStopIdx=0 → cruiseFn(0) looks at prevIdx=-1 → returns null.
        // No schedule reference for the cap formula → cap = TYPICAL_FAST = 22.
        //   v_capped = min(40, 22) = 22
        // Inside fromAnchor: cruise_v_raw = null → falls back to v → Math.max(22, 22) = 22.
        // We construct a cache whose first stop is at arc=500 (vehicle at 0 is
        // before it), so the cruise function's cache lookup is the one that
        // returns null, not the "vehicle is AT the stop" degenerate case.
        const cache = {
            stops:     ['B', 'C'],
            arcMeters: [500, 1500],
            times:     [21600, 21720],
        };
        const traj = buildTrajectoryFor({
            t_now: NOW_SEC, arc_now: 0, v_now: 40,
            cache, nextStopIdx: 0,
            routeId: '801', directionId: 0,
            dwellModel: makeStubDwell(),
            serviceDateMidnightUnix: SERVICE_MIDNIGHT_UNIX,
        });
        expect(firstFreeSegmentSpeed(traj)).toBeCloseTo(22, 1);
    });
});
