/**
 * Tests for the EWMA-based schedule speed calibrator.
 *
 * Goals:
 *  - Verify the bounded EWMA math (ALPHA=0.15, ratio clamp [0.7, 1.7])
 *  - Verify the cold-start gate (multiplier=1.0 until MIN_OBS_FOR_USE)
 *  - Verify staleness gate (entry expires after MAX_AGE_MS)
 *  - Verify outlier rejection (rawRatio < 0.3 or > 3.0 skipped pre-EWMA)
 *  - Verify localStorage persistence + 30s save throttle
 *  - Verify input-validation guards (route/dir nullables, observed range)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
    recordSegmentTime,
    getSpeedMultiplier,
    getCalibrationSnapshot,
    _resetForTest,
} from '../js/scheduleCalibration.js';

const STORAGE_KEY = 'metro-livemap.scheduleSpeedV1';

beforeEach(() => {
    _resetForTest();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('recordSegmentTime — input validation', () => {
    it('skips when routeCode is empty', () => {
        recordSegmentTime('', 0, 120, 100);
        expect(getCalibrationSnapshot()).toEqual({});
    });

    it('skips when directionId is null', () => {
        recordSegmentTime('801', null, 120, 100);
        expect(getCalibrationSnapshot()).toEqual({});
    });

    it('skips non-finite observed/scheduled', () => {
        recordSegmentTime('801', 0, NaN, 100);
        recordSegmentTime('801', 0, 120, Infinity);
        expect(getCalibrationSnapshot()).toEqual({});
    });

    it('skips implausibly short scheduled gap (<10s)', () => {
        recordSegmentTime('801', 0, 100, 5);
        expect(getCalibrationSnapshot()).toEqual({});
    });

    it('skips observed values outside [15s, 600s]', () => {
        recordSegmentTime('801', 0, 10, 100);   // too short
        recordSegmentTime('801', 0, 700, 100);  // too long
        expect(getCalibrationSnapshot()).toEqual({});
    });

    it('skips ratio outliers (raw ratio < 0.3 or > 3.0)', () => {
        recordSegmentTime('801', 0, 16, 100);   // ratio 0.16 — too small
        recordSegmentTime('801', 0, 350, 100);  // ratio 3.5 — too big
        expect(getCalibrationSnapshot()).toEqual({});
    });
});

describe('recordSegmentTime — EWMA math', () => {
    it('seeds the multiplier directly on first observation', () => {
        recordSegmentTime('801', 0, 120, 100);  // ratio 1.20
        const entry = getCalibrationSnapshot()['801|0'];
        expect(entry.multiplier).toBeCloseTo(1.20, 5);
        expect(entry.observations).toBe(1);
    });

    it('applies EWMA blend on second observation: m = 0.15*r + 0.85*prev', () => {
        recordSegmentTime('801', 0, 120, 100);   // seed at 1.20
        recordSegmentTime('801', 0, 100, 100);   // ratio 1.00 → m = 0.15*1 + 0.85*1.20 = 1.17
        const entry = getCalibrationSnapshot()['801|0'];
        expect(entry.multiplier).toBeCloseTo(0.15 * 1.0 + 0.85 * 1.20, 5);
        expect(entry.observations).toBe(2);
    });

    it('clamps post-EWMA multiplier at MAX_RATIO=1.7', () => {
        // Seed at the cap; subsequent extreme observations stay clamped.
        recordSegmentTime('801', 0, 170, 100);  // ratio 1.70 — at cap
        recordSegmentTime('801', 0, 170, 100);  // ratio 1.70 again
        const entry = getCalibrationSnapshot()['801|0'];
        expect(entry.multiplier).toBeLessThanOrEqual(1.7);
    });

    it('clamps post-EWMA multiplier at MIN_RATIO=0.7', () => {
        // ratio = 0.5 (under MIN), but raw 0.5 ≥ 0.3 so it survives the outlier gate
        // and gets clamped post-EWMA to 0.7.
        recordSegmentTime('801', 0, 50, 100);
        const entry = getCalibrationSnapshot()['801|0'];
        expect(entry.multiplier).toBeGreaterThanOrEqual(0.7);
    });

    it('keys observations separately by direction', () => {
        recordSegmentTime('801', 0, 120, 100);
        recordSegmentTime('801', 1, 100, 100);
        const snap = getCalibrationSnapshot();
        expect(snap['801|0'].observations).toBe(1);
        expect(snap['801|1'].observations).toBe(1);
    });
});

describe('getSpeedMultiplier — gating logic', () => {
    it('returns 1.0 for unknown route+dir', () => {
        expect(getSpeedMultiplier('999', 0)).toBe(1.0);
    });

    it('returns 1.0 until MIN_OBS_FOR_USE (5) observations have accumulated', () => {
        for (let i = 0; i < 4; i++) recordSegmentTime('801', 0, 120, 100);
        expect(getSpeedMultiplier('801', 0)).toBe(1.0);
    });

    it('returns the learned multiplier once warm (≥5 observations)', () => {
        for (let i = 0; i < 5; i++) recordSegmentTime('801', 0, 120, 100);
        const m = getSpeedMultiplier('801', 0);
        expect(m).toBeGreaterThan(1.0);
        expect(m).toBeLessThanOrEqual(1.7);
    });

    it('returns 1.0 when entry has aged past MAX_AGE_MS (7 days)', () => {
        for (let i = 0; i < 5; i++) recordSegmentTime('801', 0, 120, 100);
        // Travel forward 8 days
        const now = Date.now();
        const eightDays = 8 * 24 * 60 * 60 * 1000;
        const orig = Date.now;
        Date.now = () => now + eightDays;
        try {
            expect(getSpeedMultiplier('801', 0)).toBe(1.0);
        } finally {
            Date.now = orig;
        }
    });

    it('returns 1.0 when routeCode is falsy', () => {
        expect(getSpeedMultiplier('', 0)).toBe(1.0);
    });

    it('returns 1.0 when directionId is null', () => {
        expect(getSpeedMultiplier('801', null)).toBe(1.0);
    });
});

describe('getCalibrationSnapshot — isolation', () => {
    it('returns a deep copy (mutations do not affect internal state)', () => {
        recordSegmentTime('801', 0, 120, 100);
        const snap = getCalibrationSnapshot();
        snap['801|0'].multiplier = 99;
        expect(getCalibrationSnapshot()['801|0'].multiplier).not.toBe(99);
    });
});

describe('localStorage persistence (throttled write)', () => {
    // jsdom wraps localStorage in a Proxy that rejects direct property assignment,
    // so we replace the whole object via defineProperty for the duration of these
    // tests and restore afterward.
    let writes;
    let originalDescriptor;

    beforeEach(() => {
        writes = [];
        originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
        const fake = {
            store: {},
            getItem(k)        { return this.store[k] ?? null; },
            setItem(k, v)     { this.store[k] = v; writes.push([k, v]); },
            removeItem(k)     { delete this.store[k]; },
            clear()           { this.store = {}; },
        };
        Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
    });
    afterEach(() => {
        if (originalDescriptor) Object.defineProperty(window, 'localStorage', originalDescriptor);
    });

    it('writes state to localStorage after the throttle interval fires', () => {
        vi.useFakeTimers();
        try {
            recordSegmentTime('801', 0, 120, 100);
            expect(writes).toHaveLength(0);   // throttled
            vi.advanceTimersByTime(31_000);
            const ours = writes.filter(([k]) => k === STORAGE_KEY);
            expect(ours).toHaveLength(1);
            const stored = JSON.parse(ours[0][1]);
            expect(stored['801|0'].observations).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('coalesces multiple updates within the throttle window into one write', () => {
        vi.useFakeTimers();
        try {
            recordSegmentTime('801', 0, 120, 100);
            recordSegmentTime('801', 0, 110, 100);
            recordSegmentTime('801', 0, 100, 100);
            vi.advanceTimersByTime(31_000);
            const ours = writes.filter(([k]) => k === STORAGE_KEY);
            expect(ours).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
