/**
 * Tests for js/vehicleState.js — the Phase 2 state container that wraps a
 * Trajectory with Kalman-style σ_arc / σ_v and identity / bookkeeping fields.
 *
 * Focus areas:
 *
 *   - createState shape + validation (every required field, range checks)
 *   - Immutability: returned state is frozen; mutation attempts no-op or throw
 *   - withUpdate: identity fields refused, invariants re-validated on patch
 *   - withTrajectory: replaces trajectory and stamps lastTrajectoryAt
 *   - VehicleStateStore: set / get / has / size / values / keys
 *   - Archival: archive moves a state out of values() but keeps it accessible
 *     via getArchived; un-archives on re-set
 *   - pruneArchived: drops only states older than the cutoff
 *   - Custom keyFn: store can key on something other than vehicleId
 *   - Integration smoke: a state created, observed (via withUpdate), and given
 *     a real Trajectory produces sensible positionAt readings
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Trajectory, fromAnchor } from '../js/trajectory.js';
import {
    createState,
    withUpdate,
    withTrajectory,
    VehicleStateStore,
} from '../js/vehicleState.js';

// Minimum valid input for createState — used by every test that doesn't care
// about specific values.
function baseFields(over = {}) {
    return {
        vehicleId:   'V-1',
        tripId:      'TR-1',
        routeId:     '801',
        directionId: 0,
        arc:         100,
        velocity:    10,
        t_now:       1_700_000_000,
        ...over,
    };
}

// ── createState ──────────────────────────────────────────────────────────────

describe('createState — happy path', () => {
    it('returns a frozen object with all fields', () => {
        const s = createState(baseFields());
        expect(Object.isFrozen(s)).toBe(true);
        expect(s.vehicleId).toBe('V-1');
        expect(s.tripId).toBe('TR-1');
        expect(s.routeId).toBe('801');
        expect(s.directionId).toBe(0);
        expect(s.arc).toBe(100);
        expect(s.velocity).toBe(10);
    });

    it('defaults σ_arc / σ_v / bias to sane positive values', () => {
        const s = createState(baseFields());
        expect(s.σ_arc).toBeGreaterThan(0);
        expect(s.σ_v).toBeGreaterThan(0);
        expect(s.bias).toBe(0);
    });

    it('accepts explicit σ / bias overrides', () => {
        const s = createState(baseFields({ σ_arc: 50, σ_v: 5, bias: -3.5 }));
        expect(s.σ_arc).toBe(50);
        expect(s.σ_v).toBe(5);
        expect(s.bias).toBe(-3.5);
    });

    it('defaults trajectory to null and lastTrajectoryAt to null when omitted', () => {
        const s = createState(baseFields());
        expect(s.trajectory).toBeNull();
        expect(s.lastTrajectoryAt).toBeNull();
    });

    it('stamps lastTrajectoryAt to t_now when trajectory is provided', () => {
        const traj = new Trajectory([]);
        const s = createState(baseFields({ trajectory: traj }));
        expect(s.trajectory).toBe(traj);
        expect(s.lastTrajectoryAt).toBe(1_700_000_000);
    });

    it('uses Date.now/1000 when t_now is omitted', () => {
        const before = Date.now() / 1000;
        const s = createState(baseFields({ t_now: undefined }));
        const after = Date.now() / 1000;
        expect(s.createdAt).toBeGreaterThanOrEqual(before);
        expect(s.createdAt).toBeLessThanOrEqual(after);
    });

    it('createdAt and lastObservedAt initialise to the same moment', () => {
        const s = createState(baseFields());
        expect(s.createdAt).toBe(s.lastObservedAt);
    });
});

describe('createState — validation', () => {
    it('throws when fields object is missing', () => {
        expect(() => createState()).toThrow();
        expect(() => createState(null)).toThrow();
    });

    it('throws on empty vehicleId / tripId / routeId', () => {
        expect(() => createState(baseFields({ vehicleId: '' }))).toThrow(/vehicleId/);
        expect(() => createState(baseFields({ tripId:    '' }))).toThrow(/tripId/);
        expect(() => createState(baseFields({ routeId:   '' }))).toThrow(/routeId/);
    });

    it('throws on non-string identity fields', () => {
        expect(() => createState(baseFields({ vehicleId: 123 }))).toThrow();
        expect(() => createState(baseFields({ tripId:    null }))).toThrow();
    });

    it('throws on directionId outside {0, 1}', () => {
        expect(() => createState(baseFields({ directionId: 2 }))).toThrow();
        expect(() => createState(baseFields({ directionId: -1 }))).toThrow();
        expect(() => createState(baseFields({ directionId: '0' }))).toThrow();
    });

    it('throws on non-finite arc', () => {
        expect(() => createState(baseFields({ arc: NaN }))).toThrow();
        expect(() => createState(baseFields({ arc: Infinity }))).toThrow();
    });

    it('throws on negative velocity', () => {
        expect(() => createState(baseFields({ velocity: -1 }))).toThrow();
    });

    it('throws on non-positive σ_arc / σ_v', () => {
        expect(() => createState(baseFields({ σ_arc: 0 }))).toThrow();
        expect(() => createState(baseFields({ σ_v:   0 }))).toThrow();
        expect(() => createState(baseFields({ σ_arc: -5 }))).toThrow();
    });

    it('throws on non-finite bias', () => {
        expect(() => createState(baseFields({ bias: NaN }))).toThrow();
    });
});

describe('createState — immutability', () => {
    it('cannot mutate fields after creation (strict frozen)', () => {
        const s = createState(baseFields());
        // Object.freeze prevents new properties; assignments to existing
        // properties silently fail in sloppy mode and throw in strict.
        // ESM is strict by default — either behaviour is acceptable, but the
        // important property is that the value doesn't change.
        try { s.arc = 999; } catch { /* strict-mode throws */ }
        expect(s.arc).toBe(100);
    });
});

// ── withUpdate ──────────────────────────────────────────────────────────────

describe('withUpdate', () => {
    it('returns a new frozen state with the patch applied', () => {
        const s1 = createState(baseFields());
        const s2 = withUpdate(s1, { arc: 250, velocity: 12 });
        expect(s2).not.toBe(s1);
        expect(Object.isFrozen(s2)).toBe(true);
        expect(s2.arc).toBe(250);
        expect(s2.velocity).toBe(12);
        // Unpatched fields carry through
        expect(s2.vehicleId).toBe('V-1');
        expect(s2.σ_arc).toBe(s1.σ_arc);
    });

    it('does not mutate the original', () => {
        const s1 = createState(baseFields());
        withUpdate(s1, { arc: 999 });
        expect(s1.arc).toBe(100);
    });

    it('refuses to reassign identity fields', () => {
        const s = createState(baseFields());
        expect(() => withUpdate(s, { vehicleId: 'V-2' })).toThrow(/identity/);
        expect(() => withUpdate(s, { tripId:    'TR-2' })).toThrow(/identity/);
        expect(() => withUpdate(s, { routeId:   '802' })).toThrow(/identity/);
        expect(() => withUpdate(s, { directionId: 1 })).toThrow(/identity/);
    });

    it('permits identity fields in patch when value is unchanged (idempotent)', () => {
        const s1 = createState(baseFields());
        const s2 = withUpdate(s1, { vehicleId: 'V-1', arc: 200 });
        expect(s2.arc).toBe(200);
    });

    it('re-validates arc and velocity invariants on patch', () => {
        const s = createState(baseFields());
        expect(() => withUpdate(s, { arc: NaN }))         .toThrow();
        expect(() => withUpdate(s, { velocity: -1 }))     .toThrow();
        expect(() => withUpdate(s, { σ_arc: 0 }))         .toThrow();
        expect(() => withUpdate(s, { σ_v: -3 }))          .toThrow();
        expect(() => withUpdate(s, { bias: Infinity }))   .toThrow();
    });

    it('requires both arguments', () => {
        const s = createState(baseFields());
        expect(() => withUpdate(null, { arc: 1 })).toThrow();
        expect(() => withUpdate(s,    null)).toThrow();
    });
});

// ── withTrajectory ──────────────────────────────────────────────────────────

describe('withTrajectory', () => {
    it('attaches a Trajectory and stamps lastTrajectoryAt', () => {
        const s1 = createState(baseFields());
        const traj = new Trajectory([]);
        const s2 = withTrajectory(s1, traj, 1_700_000_100);
        expect(s2.trajectory).toBe(traj);
        expect(s2.lastTrajectoryAt).toBe(1_700_000_100);
        expect(s1.trajectory).toBeNull(); // original unchanged
    });

    it('clears the trajectory when passed null', () => {
        const traj = new Trajectory([]);
        const s1 = createState(baseFields({ trajectory: traj }));
        const s2 = withTrajectory(s1, null, 1_700_000_200);
        expect(s2.trajectory).toBeNull();
        expect(s2.lastTrajectoryAt).toBeNull();
    });

    it('defaults t_now to wall-clock time', () => {
        const s1 = createState(baseFields());
        const before = Date.now() / 1000;
        const s2 = withTrajectory(s1, new Trajectory([]));
        const after = Date.now() / 1000;
        expect(s2.lastTrajectoryAt).toBeGreaterThanOrEqual(before);
        expect(s2.lastTrajectoryAt).toBeLessThanOrEqual(after);
    });
});

// ── VehicleStateStore ───────────────────────────────────────────────────────

describe('VehicleStateStore — core operations', () => {
    let store;
    beforeEach(() => { store = new VehicleStateStore(); });

    it('set / get / has / size on a fresh store', () => {
        const s = createState(baseFields({ vehicleId: 'V-1' }));
        store.set(s);
        expect(store.size).toBe(1);
        expect(store.has('V-1')).toBe(true);
        expect(store.get('V-1')).toBe(s);
        expect(store.get('V-XX')).toBeNull();
    });

    it('set replaces an existing state under the same key', () => {
        const s1 = createState(baseFields({ vehicleId: 'V-1' }));
        store.set(s1);
        const s2 = withUpdate(s1, { arc: 999 });
        store.set(s2);
        expect(store.size).toBe(1);
        expect(store.get('V-1')).toBe(s2);
    });

    it('refuses to store an unfrozen object (forces createState / withUpdate)', () => {
        const naked = { vehicleId: 'V-1', arc: 0, velocity: 0 };
        expect(() => store.set(naked)).toThrow(/frozen/);
    });

    it('values() and keys() iterate live states in insertion order', () => {
        const a = createState(baseFields({ vehicleId: 'V-A' }));
        const b = createState(baseFields({ vehicleId: 'V-B' }));
        store.set(a);
        store.set(b);
        expect([...store.keys()]).toEqual(['V-A', 'V-B']);
        expect([...store.values()]).toEqual([a, b]);
    });
});

describe('VehicleStateStore — archival', () => {
    let store;
    beforeEach(() => { store = new VehicleStateStore(); });

    it('archive moves a state out of values() but preserves getArchived', () => {
        const s = createState(baseFields({ vehicleId: 'V-1' }));
        store.set(s);
        expect(store.archive('V-1')).toBe(true);
        expect(store.has('V-1')).toBe(false);
        expect(store.size).toBe(0);
        expect(store.getArchived('V-1')).toBe(s);
    });

    it('archive returns false for unknown keys', () => {
        expect(store.archive('V-UNKNOWN')).toBe(false);
    });

    it('un-archives when the same key is re-set (vehicle came back)', () => {
        const s1 = createState(baseFields({ vehicleId: 'V-1' }));
        store.set(s1);
        store.archive('V-1');
        expect(store.getArchived('V-1')).toBe(s1);

        const s2 = createState(baseFields({ vehicleId: 'V-1', arc: 500 }));
        store.set(s2);
        expect(store.has('V-1')).toBe(true);
        expect(store.get('V-1')).toBe(s2);
        expect(store.getArchived('V-1')).toBeNull();
    });

    it('delete removes from both live and archived pools', () => {
        const s = createState(baseFields({ vehicleId: 'V-1' }));
        store.set(s);
        store.archive('V-1');
        expect(store.delete('V-1')).toBe(true);
        expect(store.getArchived('V-1')).toBeNull();
        expect(store.has('V-1')).toBe(false);
    });

    it('pruneArchived drops states older than the cutoff', () => {
        // Use wall-clock-relative timestamps — pruneArchived compares to
        // Date.now()/1000 internally. (A fixed t_now like 1_700_000_000 would
        // make BOTH states look ancient by 2026.)
        const nowSec = Date.now() / 1000;
        const recent = createState(baseFields({ vehicleId: 'V-RECENT', t_now: nowSec - 60 }));
        // An old state: lastObservedAt 2 hours ago.
        const oldRaw = createState(baseFields({ vehicleId: 'V-OLD', t_now: nowSec - 7200 }));
        const old = Object.freeze({ ...oldRaw, lastObservedAt: nowSec - 7200 });

        store.set(recent);
        store.set(old);
        store.archive('V-RECENT');
        store.archive('V-OLD');

        // Prune anything older than 1 hour
        const removed = store.pruneArchived(3600);
        expect(removed).toBe(1);
        expect(store.getArchived('V-OLD')).toBeNull();
        expect(store.getArchived('V-RECENT')).toBeTruthy();
    });

    it('clear empties both pools', () => {
        const a = createState(baseFields({ vehicleId: 'V-A' }));
        const b = createState(baseFields({ vehicleId: 'V-B' }));
        store.set(a);
        store.set(b);
        store.archive('V-B');
        store.clear();
        expect(store.size).toBe(0);
        expect(store.getArchived('V-A')).toBeNull();
        expect(store.getArchived('V-B')).toBeNull();
    });
});

describe('VehicleStateStore — custom keyFn', () => {
    it('can key by tripId instead of vehicleId', () => {
        const store = new VehicleStateStore({ keyFn: s => s.tripId });
        const s = createState(baseFields({ vehicleId: 'V-1', tripId: 'TR-7' }));
        store.set(s);
        expect(store.has('TR-7')).toBe(true);
        expect(store.has('V-1')).toBe(false);
    });

    it('throws when keyFn returns a falsy key', () => {
        const store = new VehicleStateStore({ keyFn: () => '' });
        const s = createState(baseFields());
        expect(() => store.set(s)).toThrow(/key/);
    });

    it('rejects a non-function keyFn at construction', () => {
        expect(() => new VehicleStateStore({ keyFn: 'not a function' })).toThrow();
    });
});

// ── Integration smoke ───────────────────────────────────────────────────────

describe('vehicleState — integration with Trajectory', () => {
    it('a state with a real fromAnchor() Trajectory yields sensible positionAt readings', () => {
        const traj = fromAnchor({
            t_now: 1_700_000_000, arc_now: 0, v_now: 10,
            stops: [{ arc: 200, dwell_s: 10 }, { arc: 400 }],
            decel_rate: 1, cruise: 10,
        });
        const s = createState(baseFields({
            arc: 0, velocity: 10, t_now: 1_700_000_000,
            trajectory: traj,
        }));

        // Trajectory should report position 0 at the start
        expect(s.trajectory.positionAt(1_700_000_000)).toBeCloseTo(0, 6);
        // …and reach 200 at the first stop's projected arrival
        const t_at_first = s.trajectory.timeAtArc(200);
        expect(s.trajectory.positionAt(t_at_first)).toBeCloseTo(200, 4);
    });

    it('observation update preserves identity and produces a new state object', () => {
        const s1 = createState(baseFields());
        const s2 = withUpdate(s1, { arc: 250, velocity: 12, lastObservedAt: 1_700_000_050 });
        expect(s2.vehicleId).toBe(s1.vehicleId);
        expect(s2.tripId).toBe(s1.tripId);
        expect(s2).not.toBe(s1);
        expect(s2.lastObservedAt).toBe(1_700_000_050);
    });

    it('store stays consistent across a sequence of observations', () => {
        const store = new VehicleStateStore();
        let s = createState(baseFields());
        store.set(s);

        // Simulate three observations
        for (let i = 1; i <= 3; i++) {
            s = withUpdate(s, { arc: 100 + i * 50, lastObservedAt: 1_700_000_000 + i * 30 });
            store.set(s);
        }

        const final = store.get('V-1');
        expect(final.arc).toBe(250);
        expect(final.lastObservedAt).toBe(1_700_000_090);
        expect(store.size).toBe(1);
    });
});
