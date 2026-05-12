/**
 * Tests for js/trajectory.js — the Phase 1 trajectory primitive.
 *
 * The Trajectory class is a piecewise function from time → arc-meters with
 * three evaluators (positionAt, velocityAt, timeAtArc). These tests cover:
 *
 *   - Constructor invariants (contiguity, monotonicity)
 *   - Each segment kind in isolation (free, decel, dwell, hold)
 *   - Chained kinds (free → decel → dwell, dwell → free → decel, etc.)
 *   - Inverse-function property: positionAt ∘ timeAtArc = identity
 *   - Boundary behaviour (t before / after / on segment boundaries)
 *   - Builder edge cases (anchor past stop, anchor in decel zone, at-stop start,
 *     horizon cap, missing optional inputs)
 *
 * Numerical tolerance: arc-meters tested to within 1e-6 (sub-micron is fine
 * for our use), times to within 1e-6 s. Both are well below any physical
 * effect we'd care about.
 */

import { describe, it, expect } from 'vitest';
import { Trajectory, fromAnchor } from '../js/trajectory.js';

// Small helper to build a segment object with sensible defaults.
function freeSeg({ t_start = 0, dur, arc_start = 0, v }) {
    return {
        kind:    'free',
        t_start, t_end:   t_start + dur,
        arc_start, arc_end: arc_start + v * dur,
        v_start: v, v_end: v,
    };
}
function decelSeg({ t_start = 0, arc_start = 0, v, a }) {
    const dur = v / a;
    return {
        kind:    'decel',
        t_start, t_end: t_start + dur,
        arc_start, arc_end: arc_start + (v * v) / (2 * a),
        v_start: v, v_end: 0,
        a,
    };
}
function dwellSeg({ t_start = 0, dur, arc_start = 0 }) {
    return {
        kind:    'dwell',
        t_start, t_end: t_start + dur,
        arc_start, arc_end: arc_start,
        v_start: 0, v_end: 0,
    };
}
function holdSeg({ t_start = 0, scheduled_time, arc_start = 0 }) {
    return {
        kind:    'hold',
        t_start, t_end: scheduled_time,
        arc_start, arc_end: arc_start,
        v_start: 0, v_end: 0,
        scheduled_time,
    };
}

// ── Constructor ──────────────────────────────────────────────────────────────

describe('Trajectory — constructor', () => {
    it('accepts an empty segment list', () => {
        const traj = new Trajectory([]);
        expect(traj.segments).toEqual([]);
        expect(traj.positionAt(0)).toBeNull();
        expect(traj.velocityAt(0)).toBeNull();
        expect(traj.timeAtArc(0)).toBeNull();
    });

    it('accepts a single segment', () => {
        const traj = new Trajectory([freeSeg({ t_start: 100, dur: 10, arc_start: 0, v: 5 })]);
        expect(traj.segments).toHaveLength(1);
    });

    it('rejects time gaps between adjacent segments', () => {
        const segs = [
            freeSeg({ t_start: 0,  dur: 10, arc_start: 0,  v: 5 }),  // ends at t=10, arc=50
            freeSeg({ t_start: 15, dur: 5,  arc_start: 50, v: 5 }),  // gap of 5 s
        ];
        expect(() => new Trajectory(segs)).toThrow(/discontinuous t/);
    });

    it('rejects arc gaps between adjacent segments', () => {
        const segs = [
            freeSeg({ t_start: 0,  dur: 10, arc_start: 0,   v: 5 }), // ends at arc=50
            freeSeg({ t_start: 10, dur: 5,  arc_start: 100, v: 5 }), // gap of 50 m
        ];
        expect(() => new Trajectory(segs)).toThrow(/discontinuous arc/);
    });

    it('accepts contiguous chained segments', () => {
        const segs = [
            freeSeg ({ t_start: 0,  dur: 10, arc_start: 0,   v: 5 }),
            decelSeg({ t_start: 10, arc_start: 50, v: 5, a: 1 }),    // ends at t=15, arc=62.5
            dwellSeg({ t_start: 15, dur: 30, arc_start: 62.5 }),     // ends at t=45
        ];
        const traj = new Trajectory(segs);
        expect(traj.segments).toHaveLength(3);
    });

    it('segments getter returns a defensive copy', () => {
        const traj = new Trajectory([freeSeg({ dur: 10, v: 5 })]);
        const segs = traj.segments;
        segs.push('mutation attempt');
        expect(traj.segments).toHaveLength(1);
    });
});

// ── positionAt ───────────────────────────────────────────────────────────────

describe('Trajectory — positionAt', () => {
    it('clamps to arc_start before the trajectory begins', () => {
        const traj = new Trajectory([freeSeg({ t_start: 100, dur: 10, arc_start: 50, v: 5 })]);
        expect(traj.positionAt(50)).toBe(50);
        expect(traj.positionAt(99.9)).toBe(50);
    });

    it('clamps to arc_end after the trajectory ends', () => {
        const traj = new Trajectory([freeSeg({ t_start: 100, dur: 10, arc_start: 0, v: 5 })]);
        expect(traj.positionAt(110)).toBe(50);
        expect(traj.positionAt(1000)).toBe(50);
    });

    it('linearly interpolates inside a free segment', () => {
        const traj = new Trajectory([freeSeg({ t_start: 0, dur: 10, arc_start: 0, v: 5 })]);
        expect(traj.positionAt(0)).toBe(0);
        expect(traj.positionAt(2)).toBe(10);
        expect(traj.positionAt(5)).toBe(25);
        expect(traj.positionAt(10)).toBe(50);
    });

    it('uses quadratic profile inside a decel segment', () => {
        // v=10 m/s, a=2 m/s² → stops at t=5, arc-traversed = 25 m
        const traj = new Trajectory([decelSeg({ t_start: 0, arc_start: 0, v: 10, a: 2 })]);
        // At t=0: arc=0
        expect(traj.positionAt(0)).toBeCloseTo(0, 10);
        // At t=2.5: arc = 10*2.5 - 0.5*2*2.5² = 25 - 6.25 = 18.75
        expect(traj.positionAt(2.5)).toBeCloseTo(18.75, 10);
        // At t=5: arc = 25 (stopped)
        expect(traj.positionAt(5)).toBeCloseTo(25, 10);
    });

    it('decel position is monotonically increasing', () => {
        const traj = new Trajectory([decelSeg({ t_start: 0, arc_start: 100, v: 20, a: 1 })]);
        let prev = traj.positionAt(0);
        for (let t = 0.1; t <= 20; t += 0.1) {
            const cur = traj.positionAt(t);
            expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = cur;
        }
    });

    it('returns arc_start throughout a dwell', () => {
        const traj = new Trajectory([dwellSeg({ t_start: 0, dur: 30, arc_start: 100 })]);
        for (const t of [0, 5, 15, 29.99, 30]) {
            expect(traj.positionAt(t)).toBe(100);
        }
    });

    it('returns arc_start throughout a hold', () => {
        const traj = new Trajectory([holdSeg({ t_start: 0, scheduled_time: 60, arc_start: 250 })]);
        for (const t of [0, 10, 30, 59.99, 60]) {
            expect(traj.positionAt(t)).toBe(250);
        }
    });

    it('is continuous at segment boundaries (free → decel)', () => {
        const segs = [
            freeSeg ({ t_start: 0,  dur: 10, arc_start: 0,  v: 10 }), // ends at t=10, arc=100
            decelSeg({ t_start: 10, arc_start: 100, v: 10, a: 2 }),   // ends at t=15, arc=125
        ];
        const traj = new Trajectory(segs);
        // At the exact boundary, both segments agree on position
        expect(traj.positionAt(10)).toBeCloseTo(100, 10);
        // Just before
        expect(traj.positionAt(9.999)).toBeCloseTo(99.99, 6);
        // Just after — decel curve from arc=100
        expect(traj.positionAt(10.001)).toBeCloseTo(100 + 10 * 0.001 - 0.5 * 2 * 0.001 * 0.001, 6);
    });

    it('returns null for an empty trajectory', () => {
        expect(new Trajectory([]).positionAt(42)).toBeNull();
    });
});

// ── velocityAt ───────────────────────────────────────────────────────────────

describe('Trajectory — velocityAt', () => {
    it('returns 0 before the trajectory starts', () => {
        const traj = new Trajectory([freeSeg({ t_start: 100, dur: 10, v: 5 })]);
        expect(traj.velocityAt(50)).toBe(0);
    });

    it('returns 0 after the trajectory ends', () => {
        const traj = new Trajectory([freeSeg({ t_start: 0, dur: 10, v: 5 })]);
        expect(traj.velocityAt(20)).toBe(0);
    });

    it('returns constant v inside a free segment', () => {
        const traj = new Trajectory([freeSeg({ t_start: 0, dur: 10, v: 7.5 })]);
        for (const t of [0.1, 5, 9.9]) {
            expect(traj.velocityAt(t)).toBe(7.5);
        }
    });

    it('returns linearly decreasing v inside a decel segment', () => {
        // v=12 m/s, a=2 m/s² → at t=3 should be v=6
        const traj = new Trajectory([decelSeg({ t_start: 0, v: 12, a: 2 })]);
        expect(traj.velocityAt(0)).toBeCloseTo(12, 10);
        expect(traj.velocityAt(3)).toBeCloseTo(6, 10);
        expect(traj.velocityAt(6)).toBeCloseTo(0, 10);
    });

    it('returns 0 throughout dwell and hold', () => {
        const dwell = new Trajectory([dwellSeg({ t_start: 0, dur: 60, arc_start: 0 })]);
        const hold  = new Trajectory([holdSeg({ t_start: 0, scheduled_time: 120, arc_start: 0 })]);
        for (const t of [0, 1, 30, 60]) {
            expect(dwell.velocityAt(t)).toBe(0);
        }
        for (const t of [0, 1, 60, 120]) {
            expect(hold.velocityAt(t)).toBe(0);
        }
    });

    it('decel velocity never goes negative even at numerical edge', () => {
        const traj = new Trajectory([decelSeg({ t_start: 0, v: 5, a: 1 })]); // stops at t=5
        // Float drift past t_end is clamped to 0 by the caller (t after end returns 0).
        // Within the segment, the Math.max(0, ...) guard prevents -ε velocities.
        expect(traj.velocityAt(4.9999)).toBeGreaterThanOrEqual(0);
    });
});

// ── timeAtArc ────────────────────────────────────────────────────────────────

describe('Trajectory — timeAtArc', () => {
    it('clamps to t_start before the trajectory arc-range', () => {
        const traj = new Trajectory([freeSeg({ t_start: 1000, dur: 10, arc_start: 50, v: 5 })]);
        expect(traj.timeAtArc(0)).toBe(1000);
        expect(traj.timeAtArc(50)).toBe(1000);
        expect(traj.timeAtArc(49.999)).toBe(1000);
    });

    it('clamps to t_end after the trajectory arc-range', () => {
        const traj = new Trajectory([freeSeg({ t_start: 0, dur: 10, arc_start: 0, v: 5 })]);
        expect(traj.timeAtArc(50)).toBe(10);
        expect(traj.timeAtArc(9999)).toBe(10);
    });

    it('inverts a free segment exactly', () => {
        const traj = new Trajectory([freeSeg({ t_start: 100, dur: 10, arc_start: 0, v: 5 })]);
        expect(traj.timeAtArc(0)).toBe(100);
        expect(traj.timeAtArc(25)).toBe(105);
        expect(traj.timeAtArc(50)).toBe(110);
    });

    it('inverts a decel segment (smaller root of the kinematic quadratic)', () => {
        // v=10, a=2 → stops at t=5, arc=25
        // At arc=18.75 we should be at t=2.5 (forward pass), NOT at the other
        // root (which would be after stopping — unphysical).
        const traj = new Trajectory([decelSeg({ t_start: 0, arc_start: 0, v: 10, a: 2 })]);
        expect(traj.timeAtArc(0)).toBeCloseTo(0, 10);
        expect(traj.timeAtArc(18.75)).toBeCloseTo(2.5, 10);
        expect(traj.timeAtArc(25)).toBeCloseTo(5, 10);
    });

    it('returns earliest t inside a dwell (constant-arc segment)', () => {
        // Dwell at arc=100 from t=20 to t=80
        const traj = new Trajectory([dwellSeg({ t_start: 20, dur: 60, arc_start: 100 })]);
        // arc=100 throughout — earliest time reaching it is t=20
        expect(traj.timeAtArc(100)).toBe(20);
    });

    it('returns earliest t inside a hold', () => {
        const traj = new Trajectory([holdSeg({ t_start: 50, scheduled_time: 110, arc_start: 75 })]);
        expect(traj.timeAtArc(75)).toBe(50);
    });

    it('inverse property: positionAt(timeAtArc(x)) ≈ x across a chained trajectory', () => {
        const segs = [
            freeSeg ({ t_start: 0,  dur: 10, arc_start: 0,  v: 10 }),   // 0→100
            decelSeg({ t_start: 10, arc_start: 100, v: 10, a: 2 }),     // 100→125
            dwellSeg({ t_start: 15, dur: 30, arc_start: 125 }),         // dwell @ 125
            holdSeg ({ t_start: 45, scheduled_time: 60, arc_start: 125 }), // hold @ 125
            freeSeg ({ t_start: 60, dur: 10, arc_start: 125, v: 5 }),   // 125→175
        ];
        const traj = new Trajectory(segs);
        // Test across arcs that fall in each kind:
        for (const arc of [0, 25, 50, 99, 100, 110, 125, 150, 175]) {
            const t = traj.timeAtArc(arc);
            const reArc = traj.positionAt(t);
            // For constant-arc segments (dwell, hold), positionAt at the
            // earliest-time returns arc_start, which IS the queried arc.
            expect(reArc).toBeCloseTo(arc, 6);
        }
    });

    it('returns null for an empty trajectory', () => {
        expect(new Trajectory([]).timeAtArc(0)).toBeNull();
    });
});

// ── fromAnchor builder ───────────────────────────────────────────────────────

describe('fromAnchor — single-stop trajectories', () => {
    it('emits free + decel for an anchor outside the decel zone', () => {
        // 100m to stop, v=10 m/s, a=1 → decel zone = v²/(2a) = 50m → free dist = 50m
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 100 }],
            decel_rate: 1,
            cruise: 10,
        });
        const segs = traj.segments;
        expect(segs.map(s => s.kind)).toEqual(['free', 'decel']);
        expect(segs[0].arc_end).toBeCloseTo(50, 6);     // free covers 50m
        expect(segs[1].arc_end).toBeCloseTo(100, 6);    // decel ends at stop
        expect(segs[1].v_end).toBe(0);
    });

    it('emits decel-only when anchor is already inside the decel zone', () => {
        // 20m to stop, v=10 m/s, a=1 → decel zone @ v=10 is 50m > 20m
        // Builder back-computes v_eff = sqrt(2 * 1 * 20) ≈ 6.32 m/s
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 20 }],
            decel_rate: 1,
            cruise: 10,
        });
        const segs = traj.segments;
        expect(segs.map(s => s.kind)).toEqual(['decel']);
        expect(segs[0].v_start).toBeCloseTo(Math.sqrt(40), 6);
        expect(segs[0].arc_end).toBeCloseTo(20, 6);
    });

    it('appends a dwell when stop.dwell_s > 0', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 100, dwell_s: 30 }],
            decel_rate: 1, cruise: 10,
        });
        expect(traj.segments.map(s => s.kind)).toEqual(['free', 'decel', 'dwell']);
        expect(traj.segments[2].t_end - traj.segments[2].t_start).toBe(30);
    });

    it('appends a hold when scheduled_time is later than projected arrival', () => {
        // free 5s + decel 10s = 15s to reach stop. Schedule says 60.
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 100, scheduled_time: 60 }],
            decel_rate: 1, cruise: 10,
        });
        const kinds = traj.segments.map(s => s.kind);
        expect(kinds).toEqual(['free', 'decel', 'hold']);
        const holdSeg = traj.segments[2];
        expect(holdSeg.t_start).toBeCloseTo(15, 6);
        expect(holdSeg.t_end).toBe(60);
    });

    it('skips the hold when the model is already at or past schedule', () => {
        // arrival at t=15; schedule=10 → vehicle is late, no hold
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 100, scheduled_time: 10 }],
            decel_rate: 1, cruise: 10,
        });
        expect(traj.segments.map(s => s.kind)).toEqual(['free', 'decel']);
    });

    it('emits dwell then hold when both apply', () => {
        // arrival at t=15, dwell 5 → at t=20. Schedule 60 → hold to 60.
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 100, dwell_s: 5, scheduled_time: 60 }],
            decel_rate: 1, cruise: 10,
        });
        const kinds = traj.segments.map(s => s.kind);
        expect(kinds).toEqual(['free', 'decel', 'dwell', 'hold']);
        const dwell = traj.segments[2];
        const hold = traj.segments[3];
        expect(dwell.t_start).toBeCloseTo(15, 6);
        expect(dwell.t_end).toBeCloseTo(20, 6);
        expect(hold.t_start).toBeCloseTo(20, 6);
        expect(hold.t_end).toBe(60);
    });
});

describe('fromAnchor — multi-stop trajectories', () => {
    it('chains free+decel+dwell across consecutive stops', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [
                { arc: 200, dwell_s: 10 },
                { arc: 400, dwell_s: 10 },
                { arc: 600, dwell_s: 0 },
            ],
            decel_rate: 1, cruise: 10,
        });
        const kinds = traj.segments.map(s => s.kind);
        // free, decel, dwell, free, decel, dwell, free, decel (no final dwell)
        expect(kinds).toEqual(['free','decel','dwell','free','decel','dwell','free','decel']);
        // Final arc reached
        const last = traj.segments[traj.segments.length - 1];
        expect(last.arc_end).toBeCloseTo(600, 6);
        expect(last.v_end).toBe(0);
    });

    it('skips a stop already behind the anchor', () => {
        // arc_now=150, first stop is at 100 (behind), second at 300
        const traj = fromAnchor({
            t_now: 0, arc_now: 150, v_now: 10,
            stops: [
                { arc: 100, dwell_s: 30 },  // behind us
                { arc: 300 },
            ],
            decel_rate: 1, cruise: 10,
        });
        const last = traj.segments[traj.segments.length - 1];
        expect(last.arc_end).toBeCloseTo(300, 6);
        // First stop's dwell is not emitted
        expect(traj.segments.some(s => s.kind === 'dwell')).toBe(false);
    });

    it('uses per-stop cruise function when provided', () => {
        // Cruise alternates 20 m/s on segment 0 and 10 m/s on segment 1
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 20,
            stops: [
                { arc: 1000 },
                { arc: 2000 },
            ],
            decel_rate: 1,
            cruise: (i) => i === 0 ? 20 : 10,
        });
        const free0 = traj.segments.find(s => s.kind === 'free' && Math.abs(s.v_start - 20) < 1e-6);
        const free1 = traj.segments.find(s => s.kind === 'free' && Math.abs(s.v_start - 10) < 1e-6);
        expect(free0).toBeDefined();
        expect(free1).toBeDefined();
    });
});

describe('fromAnchor — edge cases', () => {
    it('emits an empty trajectory when stops are empty', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [], decel_rate: 1, cruise: 10,
        });
        expect(traj.segments).toEqual([]);
    });

    it('emits an empty trajectory when v_now is 0 and not at any stop', () => {
        // Vehicle stalled between stops — nothing meaningful to project in v1
        const traj = fromAnchor({
            t_now: 0, arc_now: 50, v_now: 0,
            stops: [{ arc: 100 }],
            decel_rate: 1, cruise: 0,
        });
        expect(traj.segments).toEqual([]);
    });

    it('starts with dwell when v_now=0 exactly at a stop arc', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 100, v_now: 0,
            stops: [{ arc: 100, dwell_s: 30 }, { arc: 200 }],
            decel_rate: 1, cruise: 10,
        });
        expect(traj.segments[0].kind).toBe('dwell');
        // After dwell, free+decel toward next stop
        expect(traj.segments.map(s => s.kind)).toEqual(['dwell', 'free', 'decel']);
    });

    it('clamps cruise to at least v_now to avoid arbitrary mid-segment slowdowns', () => {
        // Pass cruise=5 but v_now=10 — the builder should use 10 (anchor speed)
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 200 }],
            decel_rate: 1, cruise: 5,
        });
        const freeSeg = traj.segments.find(s => s.kind === 'free');
        expect(freeSeg.v_start).toBeGreaterThanOrEqual(10);
    });

    it('respects horizon_s by not emitting segments past it', () => {
        // Without horizon, 3 stops at 200/400/600 with cruise=10 would project
        // well past 30 s. With horizon_s=30 we should stop early.
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 200, dwell_s: 5 }, { arc: 400, dwell_s: 5 }, { arc: 600 }],
            decel_rate: 1, cruise: 10, horizon_s: 30,
        });
        for (const seg of traj.segments) {
            expect(seg.t_start).toBeLessThan(30);
        }
    });

    it('rejects non-positive decel_rate', () => {
        expect(() => fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10, stops: [{ arc: 100 }],
            decel_rate: 0, cruise: 10,
        })).toThrow();
        expect(() => fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10, stops: [{ arc: 100 }],
            decel_rate: -1, cruise: 10,
        })).toThrow();
    });

    it('rejects negative v_now', () => {
        expect(() => fromAnchor({
            t_now: 0, arc_now: 0, v_now: -5, stops: [{ arc: 100 }],
            decel_rate: 1, cruise: 10,
        })).toThrow();
    });

    it('rejects non-finite t_now / arc_now / v_now', () => {
        expect(() => fromAnchor({
            t_now: NaN, arc_now: 0, v_now: 10, stops: [{ arc: 100 }],
            decel_rate: 1, cruise: 10,
        })).toThrow();
        expect(() => fromAnchor({
            t_now: 0, arc_now: Infinity, v_now: 10, stops: [{ arc: 100 }],
            decel_rate: 1, cruise: 10,
        })).toThrow();
    });
});

// ── End-to-end physical sanity ───────────────────────────────────────────────

describe('Trajectory — physical sanity checks via fromAnchor', () => {
    it('decel-to-stop produces zero velocity exactly at the stop arc', () => {
        // Anchor exactly inside the decel zone: dist == v²/(2a) = 32 m.
        // Builder takes the decel-only branch with v_eff = sqrt(2·1·32) = 8.
        // Trajectory ends at t = 8 s, arc = 32 m, v = 0.
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 8,
            stops: [{ arc: 32 }],
            decel_rate: 1, cruise: 8,
        });
        const last = traj.segments[traj.segments.length - 1];
        expect(last.kind).toBe('decel');
        expect(last.arc_end).toBeCloseTo(32, 6);
        expect(last.v_end).toBe(0);
        expect(traj.velocityAt(8)).toBe(0);
        expect(traj.positionAt(8)).toBeCloseTo(32, 6);
    });

    it('free + decel: velocity profile is v_cruise until decel zone, then linearly to 0', () => {
        // 64 m to stop, v=8, cruise=8, a=1 → free covers 32 m in 4 s; decel
        // covers 32 m in 8 s. Total duration = 12 s.
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 8,
            stops: [{ arc: 64 }],
            decel_rate: 1, cruise: 8,
        });
        // During free (t ∈ [0, 4)): v = 8 throughout.
        expect(traj.velocityAt(0)).toBeCloseTo(8, 6);
        expect(traj.velocityAt(2)).toBeCloseTo(8, 6);
        expect(traj.velocityAt(3.99)).toBeCloseTo(8, 6);
        // During decel (t ∈ [4, 12]): v = 8 - (t-4) at a=1.
        expect(traj.velocityAt(4)).toBeCloseTo(8, 6);
        expect(traj.velocityAt(8)).toBeCloseTo(4, 6);
        expect(traj.velocityAt(12)).toBeCloseTo(0, 6);
        // Final position at trajectory end.
        expect(traj.positionAt(12)).toBeCloseTo(64, 6);
    });

    it('hold extends t_end without advancing arc', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 100, scheduled_time: 60, dwell_s: 5 }],
            decel_rate: 1, cruise: 10,
        });
        // Dwell from t=15 to t=20; hold from t=20 to t=60. Arc stays at 100.
        expect(traj.positionAt(20)).toBeCloseTo(100, 6);
        expect(traj.positionAt(40)).toBeCloseTo(100, 6);
        expect(traj.positionAt(60)).toBeCloseTo(100, 6);
        expect(traj.velocityAt(40)).toBe(0);
    });

    it('multi-stop trajectory is monotonic non-decreasing in arc over time', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 12,
            stops: [
                { arc: 300, dwell_s: 10, scheduled_time: 60 },
                { arc: 700, dwell_s: 5 },
                { arc: 1000 },
            ],
            decel_rate: 1.5,
            cruise: 12,
        });
        let prev = 0;
        for (let t = 0; t < 300; t += 1) {
            const arc = traj.positionAt(t);
            expect(arc).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = arc;
        }
    });

    it('timeAtArc is monotonic non-decreasing in arc', () => {
        const traj = fromAnchor({
            t_now: 0, arc_now: 0, v_now: 10,
            stops: [{ arc: 250, dwell_s: 15 }, { arc: 500 }],
            decel_rate: 1, cruise: 10,
        });
        let prev = 0;
        for (let arc = 0; arc <= 500; arc += 5) {
            const t = traj.timeAtArc(arc);
            expect(t).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = t;
        }
    });

    it('inverse property holds across an end-to-end realistic trajectory', () => {
        const traj = fromAnchor({
            t_now: 1_700_000_000, arc_now: 50, v_now: 15,
            stops: [
                { arc: 400, dwell_s: 30, scheduled_time: 1_700_000_120 },
                { arc: 900, dwell_s: 30 },
                { arc: 1500 },
            ],
            decel_rate: 1, cruise: 15,
        });
        for (const arc of [50, 75, 200, 400, 401, 800, 900, 1200, 1500]) {
            const t = traj.timeAtArc(arc);
            const reArc = traj.positionAt(t);
            expect(reArc).toBeCloseTo(arc, 4);
        }
    });
});
