/**
 * Tests for js/dwellModel.js — Phase 4 per-stop dwell learner.
 *
 * Coverage targets:
 *   - Constructor validation (alpha range, warmup gate, bounds sanity)
 *   - record(): bounds, first-obs seed, EWMA on subsequent obs, clamp, rejection
 *     of sub-min/over-max observations
 *   - get(): warmup gate falls back to default until N obs, age gate falls back
 *     after maxAgeMs, per-mode default (rail vs bus)
 *   - getEntry(): raw introspection
 *   - Timepoint flag: set/get/clear
 *   - seedFromGtfs(): bulk seed without overwriting observed data
 *   - localStorage persistence: round-trips, throttled writes, malformed
 *     state handling
 *   - Instance isolation: two DwellModels in the same process don't leak
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DwellModel } from '../js/dwellModel.js';

// jsdom wraps window.localStorage in a Proxy that rejects direct property
// assignment, so we swap in a plain stub for the persistence tests. Same
// pattern as tests/scheduleCalibration.test.js.
let originalLocalStorageDescriptor;
let _storageStore;
beforeEach(() => {
    originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    _storageStore = {};
    Object.defineProperty(window, 'localStorage', {
        value: {
            getItem(k)    { return _storageStore[k] ?? null; },
            setItem(k, v) { _storageStore[k] = String(v); },
            removeItem(k) { delete _storageStore[k]; },
            clear()       { _storageStore = {}; },
        },
        configurable: true,
    });
});
afterEach(() => {
    if (originalLocalStorageDescriptor) {
        Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor);
    }
});

// ── Constructor ─────────────────────────────────────────────────────────────

describe('DwellModel — constructor validation', () => {
    it('builds with defaults', () => {
        const m = new DwellModel();
        expect(m.snapshot().numEntries).toBe(0);
        expect(m.snapshot().numTimepoints).toBe(0);
    });

    it('rejects ewmaAlpha outside (0, 1]', () => {
        expect(() => new DwellModel({ ewmaAlpha: 0 })).toThrow(/ewmaAlpha/);
        expect(() => new DwellModel({ ewmaAlpha: -0.1 })).toThrow();
        expect(() => new DwellModel({ ewmaAlpha: 1.5 })).toThrow();
    });

    it('rejects minObsForUse < 1', () => {
        expect(() => new DwellModel({ minObsForUse: 0 })).toThrow(/minObsForUse/);
    });

    it('rejects inverted observation bounds', () => {
        expect(() => new DwellModel({ minObservedSec: 100, maxObservedSec: 50 })).toThrow();
    });

    it('rejects inverted dwell bounds', () => {
        expect(() => new DwellModel({ minDwellSec: 200, maxDwellSec: 100 })).toThrow();
    });
});

// ── record / get ────────────────────────────────────────────────────────────

describe('DwellModel — record + get (EWMA learning)', () => {
    let m;
    beforeEach(() => { m = new DwellModel({ minObsForUse: 3 }); });

    it('first observation seeds the mean directly', () => {
        const ok = m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 20 });
        expect(ok).toBe(true);
        const e = m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 });
        expect(e.mean).toBe(20);
        expect(e.n).toBe(1);
        expect(e.isWarm).toBe(false);
    });

    it('subsequent observations apply EWMA blend', () => {
        // α = 0.20 by default → second obs: 0.20·40 + 0.80·20 = 24
        m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 20 });
        m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 40 });
        const e = m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 });
        expect(e.mean).toBeCloseTo(24, 6);
        expect(e.n).toBe(2);
    });

    it('rejects observations below minObservedSec (pass-through)', () => {
        const ok = m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 2 });
        expect(ok).toBe(false);
        expect(m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 })).toBeNull();
    });

    it('rejects observations above maxObservedSec (terminus layover)', () => {
        const ok = m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 9999 });
        expect(ok).toBe(false);
    });

    it('clamps the learned mean to the [minDwell, maxDwell] band', () => {
        const m2 = new DwellModel({ minObsForUse: 1, minDwellSec: 5, maxDwellSec: 60 });
        // Feed huge but in-range observations; result mean should clamp at 60.
        for (let i = 0; i < 50; i++) {
            m2.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 290 });
        }
        const e = m2.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 });
        expect(e.mean).toBeLessThanOrEqual(60);
    });

    it('keys are per-(stop, route, direction); same stop in different directions is separate', () => {
        m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 20 });
        m.record({ stopId: 'S1', routeId: '801', directionId: 1, observedSec: 40 });
        const a = m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 });
        const b = m.getEntry({ stopId: 'S1', routeId: '801', directionId: 1 });
        expect(a.mean).toBe(20);
        expect(b.mean).toBe(40);
    });

    it('returns false (and does not record) on missing identity fields', () => {
        expect(m.record({ stopId: '', routeId: '801', directionId: 0, observedSec: 20 })).toBe(false);
        expect(m.record({ stopId: 'S1', routeId: null, directionId: 0, observedSec: 20 })).toBe(false);
        expect(m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: NaN })).toBe(false);
    });
});

describe('DwellModel — get with warmup and age gates', () => {
    it('returns the rail default until N observations warm the entry', () => {
        const m = new DwellModel({ minObsForUse: 3, defaultRailDwellS: 30 });
        const key = { stopId: 'S1', routeId: '801', directionId: 0 };
        expect(m.get(key)).toBe(30);
        m.record({ ...key, observedSec: 60 });
        expect(m.get(key)).toBe(30); // n=1, still warming
        m.record({ ...key, observedSec: 60 });
        expect(m.get(key)).toBe(30); // n=2, still warming
        m.record({ ...key, observedSec: 60 });
        // n=3 — now warm. Learned value (EWMA from seed 60 to repeated 60) = 60.
        expect(m.get(key)).toBeCloseTo(60, 6);
    });

    it('returns the bus default for isBus=true', () => {
        const m = new DwellModel({ defaultBusDwellS: 15, defaultRailDwellS: 30 });
        expect(m.get({ stopId: 'B1', routeId: '901', directionId: 0, isBus: true })).toBe(15);
        expect(m.get({ stopId: 'R1', routeId: '801', directionId: 0, isBus: false })).toBe(30);
    });

    it('falls back to default after maxAgeMs without an observation', () => {
        const m = new DwellModel({ minObsForUse: 1, maxAgeMs: 60_000, defaultRailDwellS: 30 });
        const key = { stopId: 'S1', routeId: '801', directionId: 0 };
        // Record with an ancient `t` so the entry is born stale.
        m.record({ ...key, observedSec: 50, t: 1_000_000 });
        // First test at the recorded time → warm, returns learned value.
        expect(m.get({ ...key, t: 1_000_000 })).toBeCloseTo(50, 6);
        // Test much later — past maxAgeMs → falls back to default.
        expect(m.get({ ...key, t: 1_000_000 + 120 })).toBe(30);
    });

    it('unknown key returns default with no side effects', () => {
        const m = new DwellModel();
        const before = m.snapshot();
        m.get({ stopId: 'UNKNOWN', routeId: '801', directionId: 0 });
        expect(m.snapshot().numEntries).toBe(before.numEntries);
    });
});

// ── Timepoint flag ──────────────────────────────────────────────────────────

describe('DwellModel — timepoint flag', () => {
    it('set / get / clear', () => {
        const m = new DwellModel();
        const key = { stopId: 'S1', routeId: '801', directionId: 0 };
        expect(m.isTimepoint(key)).toBe(false);
        m.setTimepoint({ ...key, value: true });
        expect(m.isTimepoint(key)).toBe(true);
        m.setTimepoint({ ...key, value: false });
        expect(m.isTimepoint(key)).toBe(false);
    });

    it('keys timepoints by (stop, route, direction) tuple', () => {
        const m = new DwellModel();
        m.setTimepoint({ stopId: 'S1', routeId: '801', directionId: 0, value: true });
        expect(m.isTimepoint({ stopId: 'S1', routeId: '801', directionId: 1 })).toBe(false);
        expect(m.isTimepoint({ stopId: 'S2', routeId: '801', directionId: 0 })).toBe(false);
    });
});

// ── seedFromGtfs ────────────────────────────────────────────────────────────

describe('DwellModel — seedFromGtfs', () => {
    it('imports dwell + timepoint rows in bulk', () => {
        const m = new DwellModel();
        const seeded = m.seedFromGtfs([
            { stopId: 'S1', routeId: '801', directionId: 0, dwellSec: 20, isTimepoint: false },
            { stopId: 'S2', routeId: '801', directionId: 0, dwellSec: 60, isTimepoint: true },
            { stopId: 'S3', routeId: '801', directionId: 0, dwellSec: 10 },
        ]);
        expect(seeded).toBe(3);
        expect(m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 }).mean).toBe(20);
        expect(m.isTimepoint({ stopId: 'S2', routeId: '801', directionId: 0 })).toBe(true);
    });

    it('seeded entries have n=0 so warmup still falls back to default', () => {
        const m = new DwellModel({ minObsForUse: 3 });
        m.seedFromGtfs([{ stopId: 'S1', routeId: '801', directionId: 0, dwellSec: 45 }]);
        // get() falls back because n=0 (schedule is a coarse baseline)
        expect(m.get({ stopId: 'S1', routeId: '801', directionId: 0 })).not.toBe(45);
        // …but getEntry shows the seed is there
        expect(m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 }).mean).toBe(45);
    });

    it('does NOT overwrite existing observed entries', () => {
        const m = new DwellModel();
        m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 25 });
        m.seedFromGtfs([{ stopId: 'S1', routeId: '801', directionId: 0, dwellSec: 99 }]);
        expect(m.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 }).mean).toBe(25);
    });

    it('skips rows with missing fields or out-of-range dwell', () => {
        const m = new DwellModel({ minDwellSec: 0, maxDwellSec: 60 });
        const seeded = m.seedFromGtfs([
            { stopId: '',   routeId: '801', directionId: 0, dwellSec: 20 },   // bad stop
            { stopId: 'S1', routeId: null,  directionId: 0, dwellSec: 20 },   // bad route
            { stopId: 'S2', routeId: '801', directionId: 0, dwellSec: 999 },  // out of range
            { stopId: 'S3', routeId: '801', directionId: 0, dwellSec: 30 },   // good
        ]);
        expect(seeded).toBe(1);
    });

    it('accepts an empty array', () => {
        const m = new DwellModel();
        expect(m.seedFromGtfs([])).toBe(0);
        expect(m.seedFromGtfs(null)).toBe(0);
    });
});

// ── Persistence ─────────────────────────────────────────────────────────────

describe('DwellModel — localStorage persistence', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('round-trips entries across instances when a storageKey is set', () => {
        const m1 = new DwellModel({ storageKey: 'test-dwell-1' });
        m1.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 30 });
        m1.setTimepoint({ stopId: 'S1', routeId: '801', directionId: 0, value: true });
        m1.flush();

        const m2 = new DwellModel({ storageKey: 'test-dwell-1' });
        expect(m2.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 }).mean).toBe(30);
        expect(m2.isTimepoint({ stopId: 'S1', routeId: '801', directionId: 0 })).toBe(true);
    });

    it('does NOT persist when storageKey is null (no localStorage write)', () => {
        const m = new DwellModel(); // no storageKey
        m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 30 });
        m.flush();
        expect(localStorage.getItem('test-dwell-2')).toBeNull();
    });

    it('coalesces multiple records into one write via the throttle', () => {
        vi.useFakeTimers();
        const m = new DwellModel({ storageKey: 'test-dwell-3', saveThrottleMs: 5_000 });
        const writes = vi.spyOn(localStorage, 'setItem');
        for (let i = 0; i < 5; i++) {
            m.record({ stopId: `S${i}`, routeId: '801', directionId: 0, observedSec: 20 });
        }
        expect(writes).not.toHaveBeenCalled(); // throttled, nothing yet
        vi.advanceTimersByTime(6_000);
        expect(writes).toHaveBeenCalledTimes(1);
        writes.mockRestore();
    });

    it('handles malformed localStorage on load (starts clean)', () => {
        localStorage.setItem('test-dwell-4', 'not valid json');
        const m = new DwellModel({ storageKey: 'test-dwell-4' });
        expect(m.snapshot().numEntries).toBe(0);
    });

    it('rejects entries with non-finite numbers when loading', () => {
        localStorage.setItem('test-dwell-5', JSON.stringify({
            entries: {
                'good|801|0': { mean: 30, n: 5, lastUpdated: 1_700_000_000 },
                'bad|801|0':  { mean: 'NaN', n: 2, lastUpdated: 0 },
                'partial|801|0': { mean: 25 },
            },
            timepoints: ['good|801|0', 42, null],
        }));
        const m = new DwellModel({ storageKey: 'test-dwell-5' });
        const snap = m.snapshot();
        expect(Object.keys(snap.entries)).toEqual(['good|801|0']);
        expect(snap.timepoints).toEqual(['good|801|0']);
    });

    it('flush forces an immediate write (cancels pending throttle)', () => {
        vi.useFakeTimers();
        const m = new DwellModel({ storageKey: 'test-dwell-6', saveThrottleMs: 5_000 });
        m.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 30 });
        m.flush();
        expect(localStorage.getItem('test-dwell-6')).toBeTruthy();
    });
});

// ── Instance isolation ──────────────────────────────────────────────────────

describe('DwellModel — instance isolation', () => {
    it('two models with different storageKeys do not leak state', () => {
        const a = new DwellModel({ storageKey: 'isolation-a' });
        const b = new DwellModel({ storageKey: 'isolation-b' });
        a.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 20 });
        a.flush();
        b.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 60 });
        b.flush();
        expect(a.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 }).mean).toBe(20);
        expect(b.getEntry({ stopId: 'S1', routeId: '801', directionId: 0 }).mean).toBe(60);
    });

    it('clear empties all state without affecting other instances', () => {
        const a = new DwellModel();
        const b = new DwellModel();
        a.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 25 });
        b.record({ stopId: 'S1', routeId: '801', directionId: 0, observedSec: 25 });
        a.clear();
        expect(a.snapshot().numEntries).toBe(0);
        expect(b.snapshot().numEntries).toBe(1);
    });
});
