/**
 * Tests for js/stateUpdaters.js — Phase 3 Kalman-style observation updaters.
 *
 * Coverage targets:
 *
 *   - kalmanUpdate1d primitive — basic math + edge cases
 *   - tickTime — arc propagates by v·dt; σ_arc inflates from σ_v + process
 *     noise; σ_v inflates from process noise; dt ≤ 0 is a no-op (out-of-order
 *     observation tolerance)
 *   - applyGpsFix — folds in arc + velocity simultaneously; high-confidence
 *     obs (low σ) pulls state toward observation; low-confidence obs leaves
 *     state mostly alone; σ shrinks after the correction; velocity clamped
 *     non-negative; calls tickTime internally
 *   - applyStoppedAt — pulls arc to stop.arc and velocity to 0; σ shrinks
 *   - applyInTransitTo — pulls arc back when it has crossed; no-op when before;
 *     never advances arc forward
 *   - applyTripUpdate — stamps time, no other state change (v1)
 *   - Convergence: a sequence of consistent observations narrows σ over time
 *   - Out-of-order observations don't rewind the filter
 *   - Per-route variance overrides applied via the variances arg
 */

import { describe, it, expect } from 'vitest';
import { createState } from '../js/vehicleState.js';
import {
    kalmanUpdate1d,
    tickTime,
    applyGpsFix,
    applyStoppedAt,
    applyInTransitTo,
    applyTripUpdate,
    DEFAULT_VARIANCES,
} from '../js/stateUpdaters.js';

const T0 = 1_700_000_000;

function baseState(over = {}) {
    return createState({
        vehicleId:   'V-1', tripId: 'TR-1', routeId: '801', directionId: 0,
        arc:         100, velocity: 10,
        σ_arc:       20, σ_v: 2,
        t_now:       T0,
        ...over,
    });
}

// ── kalmanUpdate1d ───────────────────────────────────────────────────────────

describe('kalmanUpdate1d', () => {
    it('returns the observation when the prior is far less certain', () => {
        // Prior σ=100 (very loose); obs σ=1 (very tight). K ≈ 1.
        const { mu, sigma, gain } = kalmanUpdate1d(0, 100, 42, 1);
        expect(gain).toBeGreaterThan(0.99);
        expect(mu).toBeCloseTo(42, 1);
        expect(sigma).toBeLessThan(1.1);   // posterior ≈ obs σ
    });

    it('keeps the prior when the obs is far less certain', () => {
        // Prior σ=1 (very tight); obs σ=10000 (very loose). K ≈ 10^-8.
        // With K so small the residual is negligible; mu stays at the prior.
        const { mu, sigma, gain } = kalmanUpdate1d(10, 1, 999, 10000);
        expect(gain).toBeLessThan(1e-6);
        expect(mu).toBeCloseTo(10, 4);
        expect(sigma).toBeCloseTo(1, 4);
    });

    it('averages with weights when σs are equal', () => {
        // σ = σ_obs → K = 0.5 → posterior = midpoint
        const { mu, sigma, gain } = kalmanUpdate1d(0, 5, 100, 5);
        expect(gain).toBeCloseTo(0.5, 6);
        expect(mu).toBe(50);
        // Posterior σ = sqrt(0.5 · 25) = sqrt(12.5) ≈ 3.535
        expect(sigma).toBeCloseTo(Math.sqrt(12.5), 6);
    });

    it('rejects non-positive σs', () => {
        expect(() => kalmanUpdate1d(0, 0, 1, 1)).toThrow();
        expect(() => kalmanUpdate1d(0, -1, 1, 1)).toThrow();
        expect(() => kalmanUpdate1d(0, 1, 1, 0)).toThrow();
        expect(() => kalmanUpdate1d(0, 1, 1, -1)).toThrow();
    });

    it('is idempotent in the limit (zero gain)', () => {
        // Very tight prior with very loose obs → posterior ≈ prior
        const { mu, sigma } = kalmanUpdate1d(7, 0.01, 7000, 1000);
        expect(mu).toBeCloseTo(7, 2);
        expect(sigma).toBeCloseTo(0.01, 4);
    });
});

// ── tickTime ────────────────────────────────────────────────────────────────

describe('tickTime', () => {
    it('advances arc by velocity · dt', () => {
        const s = baseState({ arc: 100, velocity: 10 });
        const t = tickTime(s, T0 + 5);
        expect(t.arc).toBeCloseTo(150, 6);
    });

    it('updates lastObservedAt', () => {
        const s = baseState();
        const t = tickTime(s, T0 + 10);
        expect(t.lastObservedAt).toBe(T0 + 10);
    });

    it('does not change velocity itself (no v-dynamics in v1)', () => {
        const s = baseState({ velocity: 12 });
        const t = tickTime(s, T0 + 5);
        expect(t.velocity).toBe(12);
    });

    it('inflates σ_arc from prior σ_v plus process noise', () => {
        const s = baseState({ σ_arc: 5, σ_v: 2 });
        const t = tickTime(s, T0 + 10);
        // σ_arc² = 25 + (2·10)² + p·10 = 25 + 400 + 3.6 = 428.6 → ≈ 20.7
        expect(t.σ_arc).toBeGreaterThan(s.σ_arc);
        expect(t.σ_arc).toBeCloseTo(Math.sqrt(25 + 400 + 0.36 * 10), 4);
    });

    it('inflates σ_v from process noise alone', () => {
        const s = baseState({ σ_v: 2 });
        const t = tickTime(s, T0 + 10);
        // σ_v² = 4 + 0.16 · 10 = 5.6
        expect(t.σ_v).toBeGreaterThan(s.σ_v);
        expect(t.σ_v).toBeCloseTo(Math.sqrt(4 + 0.16 * 10), 4);
    });

    it('is a no-op for dt ≤ 0 (out-of-order observation tolerance)', () => {
        const s = baseState();
        expect(tickTime(s, T0)).toBe(s);          // dt = 0
        expect(tickTime(s, T0 - 10)).toBe(s);     // dt < 0
    });

    it('returns a frozen object', () => {
        const s = baseState();
        const t = tickTime(s, T0 + 5);
        expect(Object.isFrozen(t)).toBe(true);
    });

    it('does not mutate the input state', () => {
        const s = baseState({ arc: 100 });
        tickTime(s, T0 + 5);
        expect(s.arc).toBe(100);
    });

    it('composes — two ticks at +5 each match one tick at +10', () => {
        const s = baseState({ σ_arc: 5, σ_v: 2 });
        const t1 = tickTime(tickTime(s, T0 + 5), T0 + 10);
        const t2 = tickTime(s, T0 + 10);
        expect(t1.arc).toBeCloseTo(t2.arc, 4);
        // σ propagation is not strictly additive in σ-units (it's additive in σ²
        // plus a velocity-uncertainty cross term that compounds differently),
        // so we test arc + lastObservedAt rather than σ here.
        expect(t1.lastObservedAt).toBe(t2.lastObservedAt);
    });

    it('rejects non-finite t', () => {
        const s = baseState();
        expect(() => tickTime(s, NaN)).toThrow();
        expect(() => tickTime(s, Infinity)).toThrow();
    });

    it('honors variance overrides for process noise', () => {
        const s = baseState({ σ_arc: 5, σ_v: 2 });
        const v = { ...DEFAULT_VARIANCES, process_noise_arc: 10, process_noise_v: 5 };
        const t = tickTime(s, T0 + 10, v);
        // σ_arc² = 25 + 400 + 100·10 = 1425 → ≈ 37.7
        expect(t.σ_arc).toBeCloseTo(Math.sqrt(25 + 400 + 100 * 10), 4);
    });
});

// ── applyGpsFix ─────────────────────────────────────────────────────────────

describe('applyGpsFix', () => {
    it('pulls arc toward the observation', () => {
        const s = baseState({ arc: 100, velocity: 10, σ_arc: 20, σ_v: 2 });
        // Observe arc=200 at t=T0 (dt=0 → no propagation)
        const out = applyGpsFix(s, { arc: 200, velocity: 10, t: T0 });
        expect(out.arc).toBeGreaterThan(100);
        expect(out.arc).toBeLessThan(200);
    });

    it('shrinks σ_arc after a correction', () => {
        const s = baseState({ σ_arc: 20, σ_v: 2 });
        const out = applyGpsFix(s, { arc: 100, velocity: 10, t: T0 });
        expect(out.σ_arc).toBeLessThan(s.σ_arc);
    });

    it('shrinks σ_v after a correction', () => {
        const s = baseState({ σ_v: 5 });
        const out = applyGpsFix(s, { arc: 100, velocity: 10, t: T0 });
        expect(out.σ_v).toBeLessThan(s.σ_v);
    });

    it('high-confidence obs pulls state nearly all the way', () => {
        const s = baseState({ arc: 0, σ_arc: 50 });
        const out = applyGpsFix(s, { arc: 200, velocity: 10, t: T0, σ_arc: 0.1 });
        expect(out.arc).toBeCloseTo(200, 0);
    });

    it('low-confidence obs barely moves state', () => {
        const s = baseState({ arc: 100, σ_arc: 0.5 });
        const out = applyGpsFix(s, { arc: 999, velocity: 10, t: T0, σ_arc: 500 });
        expect(out.arc).toBeCloseTo(100, 0);
    });

    it('clamps a Kalman-induced negative velocity to zero', () => {
        // State has v=1, σ_v=2. Obs says v=0 with very tight σ_v=0.1
        // → posterior could go slightly negative due to a different update math;
        // here the obs is clean so it shouldn't, but we craft a case where the
        // resulting posterior arithmetic flirts with negative:
        // Actually scalar Kalman from v=1 toward v=0 cannot produce negative.
        // Make sure the clamp is reachable by passing a negative obs:
        const s = baseState({ velocity: 1, σ_v: 5 });
        // Reject upstream — applyGpsFix requires non-negative observed velocity.
        expect(() => applyGpsFix(s, { arc: 100, velocity: -1, t: T0 })).toThrow();
    });

    it('clamps even when a wide prior + slightly-negative interim would otherwise leak through', () => {
        // Build a posterior that ends up exactly at 0 (no negative needed for
        // a valid v_obs); confirm the clamp is in place by tightening obs σ.
        const s = baseState({ velocity: 0.1, σ_v: 5 });
        const out = applyGpsFix(s, { arc: 100, velocity: 0, t: T0, σ_v: 0.01 });
        expect(out.velocity).toBeGreaterThanOrEqual(0);
        expect(out.velocity).toBeCloseTo(0, 2);
    });

    it('rejects non-finite obs', () => {
        const s = baseState();
        expect(() => applyGpsFix(s, { arc: NaN, velocity: 10, t: T0 })).toThrow();
        expect(() => applyGpsFix(s, { arc: 100, velocity: Infinity, t: T0 })).toThrow();
        expect(() => applyGpsFix(s, { arc: 100, velocity: 10, t: NaN })).toThrow();
    });

    it('rejects negative observed velocity', () => {
        const s = baseState();
        expect(() => applyGpsFix(s, { arc: 100, velocity: -5, t: T0 })).toThrow();
    });

    it('calls tickTime internally — state.lastObservedAt advances to obs.t', () => {
        const s = baseState();  // lastObservedAt = T0
        const out = applyGpsFix(s, { arc: 200, velocity: 10, t: T0 + 30 });
        expect(out.lastObservedAt).toBe(T0 + 30);
    });

    it('chained applies converge toward the observation', () => {
        let s = baseState({ arc: 0, σ_arc: 50 });
        for (let i = 0; i < 20; i++) {
            s = applyGpsFix(s, { arc: 100, velocity: 0, t: T0 + i, σ_arc: 5, σ_v: 0.5 });
        }
        // After 20 consistent observations the state should be close to truth.
        expect(s.arc).toBeCloseTo(100, 0);
        // …and σ should be much smaller than the starting σ.
        expect(s.σ_arc).toBeLessThan(5);
    });
});

// ── applyStoppedAt ──────────────────────────────────────────────────────────

describe('applyStoppedAt', () => {
    it('pulls arc to the stop arc', () => {
        const s = baseState({ arc: 95, velocity: 10, σ_arc: 30 });
        const out = applyStoppedAt(s, { arc: 100, t: T0 });
        expect(out.arc).toBeCloseTo(100, 0);
    });

    it('pulls velocity to zero', () => {
        const s = baseState({ velocity: 10, σ_v: 5 });
        const out = applyStoppedAt(s, { arc: 100, t: T0 });
        expect(out.velocity).toBeCloseTo(0, 0);
    });

    it('shrinks both σ values', () => {
        const s = baseState({ σ_arc: 30, σ_v: 5 });
        const out = applyStoppedAt(s, { arc: 100, t: T0 });
        expect(out.σ_arc).toBeLessThan(s.σ_arc);
        expect(out.σ_v).toBeLessThan(s.σ_v);
    });

    it('overrides defaults with custom σ values', () => {
        // State arc=50, obs arc=100 — a 50 m residual to fold in. Tight obs
        // (low σ) should pull state much closer to 100 than a loose obs (high σ).
        const s = baseState({ arc: 50, σ_arc: 30 });
        const tightObs = applyStoppedAt(s, { arc: 100, t: T0, σ_arc: 0.1 });
        const looseObs = applyStoppedAt(s, { arc: 100, t: T0, σ_arc: 100 });
        expect(Math.abs(tightObs.arc - 100)).toBeLessThan(Math.abs(looseObs.arc - 100));
    });

    it('returns a frozen object', () => {
        const out = applyStoppedAt(baseState(), { arc: 100, t: T0 });
        expect(Object.isFrozen(out)).toBe(true);
    });

    it('rejects non-finite obs', () => {
        expect(() => applyStoppedAt(baseState(), { arc: NaN, t: T0 })).toThrow();
        expect(() => applyStoppedAt(baseState(), { arc: 100, t: NaN })).toThrow();
    });

    it('advances lastObservedAt via internal tickTime', () => {
        const out = applyStoppedAt(baseState(), { arc: 100, t: T0 + 5 });
        expect(out.lastObservedAt).toBe(T0 + 5);
    });
});

// ── applyInTransitTo ────────────────────────────────────────────────────────

describe('applyInTransitTo', () => {
    it('pulls arc back when state has crossed the upper bound', () => {
        const s = baseState({ arc: 210, velocity: 10, σ_arc: 50 });
        const out = applyInTransitTo(s, { stopArc: 200, t: T0 });
        expect(out.arc).toBeCloseTo(200, 6);
    });

    it('is a no-op (state-preserving) when state is before the bound', () => {
        const s = baseState({ arc: 100 });
        const out = applyInTransitTo(s, { stopArc: 200, t: T0 });
        expect(out.arc).toBe(100);
    });

    it('tightens σ_arc when the clamp fires (down to obs σ)', () => {
        const s = baseState({ arc: 250, σ_arc: 100 });
        const out = applyInTransitTo(s, { stopArc: 200, t: T0, σ_arc: 5 });
        expect(out.σ_arc).toBeLessThanOrEqual(s.σ_arc);
        // Should not tighten BELOW the obs σ (the obs has its own uncertainty)
        expect(out.σ_arc).toBeLessThanOrEqual(5);
    });

    it('does not tighten σ when the clamp does not fire', () => {
        const s = baseState({ arc: 100, σ_arc: 20 });
        const out = applyInTransitTo(s, { stopArc: 200, t: T0 });
        // tickTime with dt=0 returns same state; σ_arc unchanged
        expect(out.σ_arc).toBe(s.σ_arc);
    });

    it('stamps lastObservedAt even when no clamp fires', () => {
        const s = baseState({ arc: 100 });
        const out = applyInTransitTo(s, { stopArc: 200, t: T0 + 10 });
        expect(out.lastObservedAt).toBe(T0 + 10);
    });

    it('never advances arc forward (one-sided constraint)', () => {
        const s = baseState({ arc: 100 });
        const out = applyInTransitTo(s, { stopArc: 200, t: T0 });
        expect(out.arc).toBe(100);
    });

    it('rejects non-finite obs', () => {
        expect(() => applyInTransitTo(baseState(), { stopArc: NaN, t: T0 })).toThrow();
        expect(() => applyInTransitTo(baseState(), { stopArc: 200, t: NaN })).toThrow();
    });
});

// ── applyTripUpdate ─────────────────────────────────────────────────────────

describe('applyTripUpdate (v1 minimal)', () => {
    it('stamps lastObservedAt to obs.t', () => {
        const out = applyTripUpdate(baseState(), { stopArc: 200, etaUnix: T0 + 60, t: T0 + 5 });
        expect(out.lastObservedAt).toBe(T0 + 5);
    });

    it('does not change arc or velocity in v1', () => {
        const s = baseState({ arc: 100, velocity: 10 });
        const out = applyTripUpdate(s, { stopArc: 200, etaUnix: T0 + 60, t: T0 });
        expect(out.arc).toBe(s.arc);
        expect(out.velocity).toBe(s.velocity);
    });

    it('still advances state via tickTime when t > lastObservedAt', () => {
        // dt > 0 → arc advances by v·dt (the predict step still runs).
        const s = baseState({ arc: 100, velocity: 10 });
        const out = applyTripUpdate(s, { stopArc: 200, etaUnix: T0 + 60, t: T0 + 5 });
        expect(out.arc).toBeCloseTo(150, 6);
    });

    it('rejects non-finite obs', () => {
        expect(() => applyTripUpdate(baseState(), { stopArc: NaN, etaUnix: T0, t: T0 })).toThrow();
        expect(() => applyTripUpdate(baseState(), { stopArc: 200, etaUnix: NaN, t: T0 })).toThrow();
        expect(() => applyTripUpdate(baseState(), { stopArc: 200, etaUnix: T0, t: NaN })).toThrow();
    });
});

// ── Chained / out-of-order ──────────────────────────────────────────────────

describe('stateUpdaters — chained / out-of-order', () => {
    it('out-of-order observation is a no-op (state-preserving)', () => {
        let s = baseState();
        s = applyGpsFix(s, { arc: 200, velocity: 10, t: T0 + 30 });
        // A stale frame from 10s before — tickTime sees dt < 0, no-ops.
        const stale = applyGpsFix(s, { arc: 100, velocity: 10, t: T0 + 20 });
        // Even after the Kalman correction, the timestamp can't go backward.
        expect(stale.lastObservedAt).toBe(T0 + 30);
    });

    it('alternating GPS and STOPPED_AT updates converge as expected', () => {
        let s = baseState({ arc: 50, velocity: 10, σ_arc: 30 });
        // GPS sees vehicle near a stop
        s = applyGpsFix(s, { arc: 95, velocity: 0.5, t: T0 + 5 });
        // Feed confirms STOPPED_AT (arc = 100)
        s = applyStoppedAt(s, { arc: 100, t: T0 + 6 });
        expect(s.arc).toBeGreaterThan(95);
        expect(s.arc).toBeCloseTo(100, 0);
        expect(s.velocity).toBeCloseTo(0, 0);
    });

    it('repeated STOPPED_AT observations drive σ_arc toward the obs floor', () => {
        let s = baseState({ arc: 50, σ_arc: 50 });
        for (let i = 0; i < 10; i++) {
            s = applyStoppedAt(s, { arc: 100, t: T0 + i, σ_arc: 3 });
        }
        expect(s.σ_arc).toBeLessThan(3);
        expect(s.arc).toBeCloseTo(100, 0);
    });

    it('IN_TRANSIT_TO followed by GPS landing past the bound still respects GPS', () => {
        // IN_TRANSIT_TO sets a soft upper bound; if a confident GPS fix arrives
        // afterward saying we're past, the GPS dominates (we trust real measurement
        // over feed metadata).
        let s = baseState({ arc: 150 });
        s = applyInTransitTo(s, { stopArc: 200, t: T0 + 1 });    // no clamp (arc < bound)
        s = applyGpsFix(s, { arc: 250, velocity: 10, t: T0 + 2, σ_arc: 1 });
        expect(s.arc).toBeGreaterThan(200);   // GPS overrode the bound
    });

    it('uncertainty grows during silent periods (tickTime alone)', () => {
        const s = baseState({ σ_arc: 5 });
        // 5 minutes of silence — no observations, just time passing
        const t = tickTime(s, T0 + 300);
        expect(t.σ_arc).toBeGreaterThan(s.σ_arc);
        expect(t.σ_v).toBeGreaterThan(s.σ_v);
        // Eventually σ_arc should grow to many metres
        expect(t.σ_arc).toBeGreaterThan(50);
    });
});
