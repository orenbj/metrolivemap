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

const STORAGE_KEY = 'metro-livemap.scheduleSpeedV2';
const V1_KEY      = 'metro-livemap.scheduleSpeedV1';

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

    it('applies EWMA blend on second observation: m = 0.25*r + 0.75*prev', () => {
        recordSegmentTime('801', 0, 120, 100);   // seed at 1.20
        recordSegmentTime('801', 0, 100, 100);   // ratio 1.00 → m = 0.25*1 + 0.75*1.20 = 1.15
        const entry = getCalibrationSnapshot()['801|0'];
        expect(entry.multiplier).toBeCloseTo(0.25 * 1.0 + 0.75 * 1.20, 5);
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

describe('variance tracking (m2)', () => {
    it('m2 stays near zero when observed ratios are identical (no dispersion)', () => {
        // 10 identical samples — ratio 1.2 every time, no spread.
        for (let i = 0; i < 10; i++) recordSegmentTime('801', 0, 120, 100);
        const entry = getCalibrationSnapshot()['801|0'];
        // Mean is locked at 1.2; squared residuals are all 0 → m2 stays at 0.
        expect(entry.m2).toBeLessThan(0.001);
    });

    it('m2 grows when observed ratios swing between extremes (high dispersion)', () => {
        // Alternating max-ratio / min-ratio samples — pathological noise.
        // observed=170/scheduled=100 → ratio 1.7; observed=70/scheduled=100 → ratio 0.7.
        for (let i = 0; i < 12; i++) {
            const obs = i % 2 === 0 ? 170 : 70;
            recordSegmentTime('801', 0, obs, 100);
        }
        const entry = getCalibrationSnapshot()['801|0'];
        // sqrt(m2) should be well above the MAX_STDDEV (0.18) threshold for
        // this pathological input — alternating ±0.5 around any mean produces
        // a steady-state stddev near 0.5.
        expect(Math.sqrt(entry.m2)).toBeGreaterThan(0.18);
    });
});

describe('getSpeedMultiplier — variance gate', () => {
    it('returns 1.0 when stddev exceeds MAX_STDDEV even with sufficient observations', () => {
        // Feed the same pathological alternating sequence as the variance
        // dispersion test. N quickly exceeds MIN_OBS_FOR_USE (5), but the
        // route is too noisy for its mean multiplier to be trustworthy —
        // the variance gate should fall back to 1.0 (raw schedule).
        for (let i = 0; i < 12; i++) {
            const obs = i % 2 === 0 ? 170 : 70;
            recordSegmentTime('801', 0, obs, 100);
        }
        const entry = getCalibrationSnapshot()['801|0'];
        expect(entry.observations).toBeGreaterThanOrEqual(5);
        expect(Math.sqrt(entry.m2)).toBeGreaterThan(0.18);
        expect(getSpeedMultiplier('801', 0)).toBe(1.0);
    });

    it('returns the learned multiplier when stddev stays within MAX_STDDEV', () => {
        // Tight cluster around ratio 1.2 — small jitter, well within the
        // variance gate. Multiplier should be applied normally.
        const obs = [122, 118, 120, 119, 121, 120, 122, 118];
        for (const o of obs) recordSegmentTime('801', 0, o, 100);
        const entry = getCalibrationSnapshot()['801|0'];
        expect(Math.sqrt(entry.m2)).toBeLessThan(0.18);
        const m = getSpeedMultiplier('801', 0);
        expect(m).toBeGreaterThan(1.0);
        expect(m).toBeLessThan(1.7);
    });
});

describe('storage schema (V1 → V2 transition)', () => {
    // jsdom localStorage is the real DOM storage here; we seed the V1 key
    // directly and assert the module doesn't read or migrate it on the
    // next write cycle — the key bump is the migration.
    afterEach(() => {
        try { localStorage.removeItem(V1_KEY); } catch { /* ignore */ }
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    });

    it('ignores V1-shaped entries persisted under the old storage key', () => {
        // V1 had no m2. After the key bump, V1 data sits under the old key
        // and is never read; the module's in-memory state stays empty
        // until V2 observations accumulate.
        localStorage.setItem(V1_KEY, JSON.stringify({
            '801|0': { multiplier: 1.5, observations: 100, updatedAt: Date.now() },
        }));
        // _resetForTest clears in-memory state and the V2 key; V1 key is
        // left untouched. getCalibrationSnapshot should not see the V1 data
        // because the module reads only from STORAGE_KEY (V2).
        _resetForTest();
        const snap = getCalibrationSnapshot();
        expect(snap['801|0']).toBeUndefined();
    });

    it('loadState rejects V2 entries missing the m2 field (corrupt / partial write)', async () => {
        // Defensive: even under the V2 key, an entry without m2 is invalid
        // and should be dropped on load — guards against future schema
        // slip-ups or partial-write corruption.
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            '801|0': { multiplier: 1.5, observations: 100, updatedAt: Date.now() },
            '802|0': { multiplier: 1.2, m2: 0.01, observations: 50, updatedAt: Date.now() },
        }));
        // Force a re-import so loadState runs against the seeded storage.
        vi.resetModules();
        const { getCalibrationSnapshot: getSnap } = await import('../js/scheduleCalibration.js');
        const snap = getSnap();
        // Missing m2 → dropped.
        expect(snap['801|0']).toBeUndefined();
        // Has m2 → retained.
        expect(snap['802|0']).toBeDefined();
        expect(snap['802|0'].multiplier).toBe(1.2);
    });
});
