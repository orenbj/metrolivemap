/**
 * Boundary tests for the predictions blend math + adherence-EWMA convergence.
 *
 * These pin exact-threshold behavior for tunable constants the audit flagged
 * as silently retunable:
 *   - BLEND_HORIZON_NEAR_S = 60
 *   - BLEND_HORIZON_MID_S  = 300  (also used for BLEND_REPLAY_NEAR_S)
 *   - BLEND_DISAGREEMENT_SOFT_S = 60
 *   - BLEND_DISAGREEMENT_HARD_S = 180
 *   - BLEND_REPLAY_RATIO = 2, BLEND_REPLAY_PAD_S = 60
 *   - scheduleCalibration ALPHA = 0.25, MIN_OBS_FOR_USE = 5
 *
 * If anyone retunes one without updating the implicit pair (per the comment
 * block in config.js), at least one assertion below will fail.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { _blendArrivals } from '../js/predictions.js';
import {
    recordSegmentTime, getSpeedMultiplier, _resetForTest as resetCalibration,
} from '../js/scheduleCalibration.js';

const NOW = 1_000_000_000; // arbitrary fixed unix seconds for determinism

// ── Blend horizon boundaries ────────────────────────────────────────────────

describe('_blendArrivals — horizon-band boundaries', () => {
    // For these tests calcEta and gtfsEta are equal so disagreement = 0,
    // agreement = 1, and the result reflects only calcBase × 1 = calcBase.
    // Setting calcEta = gtfsEta + 0 means the blend returns gtfsEta exactly,
    // so we verify by varying the spread instead and reading the calc weight.

    /** Recover calcWeight from the blend result. */
    const calcWeight = (calcEta, gtfsEta, horizon, now) => {
        const result = _blendArrivals(calcEta, gtfsEta, horizon, now);
        // result = w*calc + (1-w)*gtfs  →  w = (result - gtfs) / (calc - gtfs)
        return (result - gtfsEta) / (calcEta - gtfsEta);
    };

    it('horizon < NEAR (59s) gives calcBase = 0.30 (full agreement)', () => {
        const calc = NOW + 50, gtfs = NOW + 60; // diff=10 < SOFT
        expect(calcWeight(calc, gtfs, 59, NOW)).toBeCloseTo(0.30, 5);
    });

    it('horizon = NEAR (60s exactly) crosses to mid band: calcBase = 0.10', () => {
        const calc = NOW + 50, gtfs = NOW + 60;
        // The < BLEND_HORIZON_NEAR_S comparison is strict, so 60 falls into mid.
        expect(calcWeight(calc, gtfs, 60, NOW)).toBeCloseTo(0.10, 5);
    });

    it('horizon = MID-1 (299s) still in mid band: calcBase = 0.10', () => {
        // calcHorizon ≥ 300 keeps the stale-replay guard out of play.
        const calc = NOW + 302, gtfs = NOW + 299;
        expect(calcWeight(calc, gtfs, 299, NOW)).toBeCloseTo(0.10, 5);
    });

    it('horizon = MID (300s exactly) crosses to far band: calcBase = 0', () => {
        const calc = NOW + 302, gtfs = NOW + 300;
        // 300 falls into the third arm: calcBase = 0 → result is pure GTFS.
        expect(calcWeight(calc, gtfs, 300, NOW)).toBeCloseTo(0, 5);
    });
});

// ── Disagreement decay boundaries ───────────────────────────────────────────

describe('_blendArrivals — disagreement-decay boundaries', () => {
    /** Pin the 60→180s linear ramp that replaced the prior step gate. */
    it('|Δ| = SOFT (60s) exactly: agreement = 1', () => {
        const calc = NOW + 100, gtfs = NOW + 160; // diff = 60
        // Use mid horizon (calcBase=0.1) so calcWeight = 0.1 × 1 = 0.1.
        const w = (_blendArrivals(calc, gtfs, 160, NOW) - gtfs) / (calc - gtfs);
        expect(w).toBeCloseTo(0.10, 5);
    });

    it('|Δ| midway (120s) with mid horizon: agreement = 0.5 → calcWeight = 0.05', () => {
        const calc = NOW + 100, gtfs = NOW + 220; // diff = 120 → halfway
        // Avoid the stale-replay guard: use a calcHorizon ≥ 300 OR ensure
        // gtfsHorizon ≤ 2*calcHorizon + 60. calcHorizon=100, gtfs=220 → guard fires
        // (220 > 2*100+60=260? No, 220<260 → guard does NOT fire). Safe.
        const w = (_blendArrivals(calc, gtfs, 220, NOW) - gtfs) / (calc - gtfs);
        expect(w).toBeCloseTo(0.05, 5); // 0.1 × 0.5
    });

    it('|Δ| = HARD (180s) exactly with no replay-guard: pure GTFS', () => {
        // calcHorizon=400 > REPLAY_NEAR_S(300) → guard cannot fire regardless of gtfsHorizon.
        const calc = NOW + 400, gtfs = NOW + 220; // diff = 180
        // |Δ| ≥ HARD → agreement=0, result = gtfsEta exactly.
        expect(_blendArrivals(calc, gtfs, 220, NOW)).toBe(gtfs);
    });
});

// ── Stale-replay guard boundary ─────────────────────────────────────────────

describe('_blendArrivals — stale-replay guard', () => {
    /**
     * Guard fires when calcHorizon < BLEND_REPLAY_NEAR_S (300, strict)
     * AND gtfsHorizon > BLEND_REPLAY_RATIO * calcHorizon + BLEND_REPLAY_PAD_S
     * (= 2 * calcHorizon + 60).
     */

    it('calcHorizon = 299s + gtfsHorizon = 2×299 + 61 = 659s: guard fires → pure calc', () => {
        const calc = NOW + 299, gtfs = NOW + 659; // 659 > 658 → fires
        expect(_blendArrivals(calc, gtfs, 659, NOW)).toBe(calc);
    });

    it('calcHorizon = 299s + gtfsHorizon = 658s exactly: does NOT fire (>= boundary)', () => {
        const calc = NOW + 299, gtfs = NOW + 658; // 658 == 2*299+60 → strict > fails
        // Falls through to normal blend. With horizon=658 >= MID(300), calcBase=0,
        // so result is pure GTFS regardless.
        expect(_blendArrivals(calc, gtfs, 658, NOW)).toBe(gtfs);
    });

    it('calcHorizon = 300s exactly: guard cannot fire (strict < 300)', () => {
        const calc = NOW + 300, gtfs = NOW + 1000;
        // Guard skipped → normal blend → far horizon (calcBase=0) → pure GTFS.
        expect(_blendArrivals(calc, gtfs, 1000, NOW)).toBe(gtfs);
    });

    it('calcHorizon < 0 (calc already in the past): guard must NOT fire', () => {
        // Bug regression: previously the guard's `RATIO * calcHorizon + PAD`
        // threshold went negative when calc thought the vehicle had already
        // passed, causing the branch to fire unconditionally and return a
        // calcEta in the past. That bubbled up to the popup as a stale
        // "Now" pill alongside the legitimate fresh GTFS arrival.
        const calc = NOW - 60;   // calc says the vehicle arrived 60 s ago
        const gtfs = NOW + 30;   // GTFS says it's still 30 s out
        // Guard must NOT fire — calcHorizon is negative. Falls through to
        // normal blend; result must not be in the past.
        const out = _blendArrivals(calc, gtfs, 30, NOW);
        expect(out).toBeGreaterThanOrEqual(NOW);
    });
});

// ── Null calcEta short-circuit ──────────────────────────────────────────────

describe('_blendArrivals — null calc handling', () => {
    it('returns gtfsEta when calcEta is null (Tier-2 origin-stop suppression path)', () => {
        const gtfs = NOW + 100;
        expect(_blendArrivals(null, gtfs, 100, NOW)).toBe(gtfs);
    });
});

// ── EWMA convergence ────────────────────────────────────────────────────────

describe('scheduleCalibration EWMA — alternating-sample convergence', () => {
    beforeEach(() => resetCalibration());

    it('alternating high/low samples converge near 1.0 (population mean)', () => {
        // Alternating 1.5 and 0.7 ratios; after enough samples EWMA centres
        // somewhere between them. With ALPHA=0.25 the steady-state oscillation
        // band is non-trivially asymmetric (clamping at 0.7 floor) but should
        // settle in the 0.9-1.3 corridor — far from either extreme.
        for (let i = 0; i < 30; i++) {
            recordSegmentTime('801', 0, 150, 100); // ratio = 1.5
            recordSegmentTime('801', 0, 70,  100); // ratio = 0.7
        }
        const m = getSpeedMultiplier('801', 0);
        expect(m).toBeGreaterThan(0.9);
        expect(m).toBeLessThan(1.3);
    });

    it('warmup gate: getSpeedMultiplier returns 1.0 until MIN_OBS_FOR_USE=5 obs', () => {
        for (let i = 1; i <= 4; i++) {
            recordSegmentTime('802', 1, 130, 100); // ratio = 1.3
            expect(getSpeedMultiplier('802', 1)).toBe(1.0);
        }
        // 5th observation flips to learned value (still close to 1.3 since EWMA
        // converges fast on consistent input).
        recordSegmentTime('802', 1, 130, 100);
        const m = getSpeedMultiplier('802', 1);
        expect(m).toBeGreaterThan(1.2);
        expect(m).toBeLessThan(1.31);
    });

    it('per-(route, direction) isolation: 801|0 update does not leak to 801|1', () => {
        for (let i = 0; i < 10; i++) recordSegmentTime('801', 0, 150, 100); // ratio 1.5
        expect(getSpeedMultiplier('801', 0)).toBeGreaterThan(1.3);
        expect(getSpeedMultiplier('801', 1)).toBe(1.0); // untouched
    });
});
