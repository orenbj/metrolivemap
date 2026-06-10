/**
 * Tests for computeTripAdherenceOffset — the schedule-vs-arc-position
 * comparator that drives ETA adherence corrections.
 *
 * Two branches:
 *   - In-segment: elapsed ≤ scheduled gap → arc-position offset → time
 *   - Overrun:    elapsed >  scheduled gap → (elapsed - gap) + remainingArc/schedSpeed
 *     This is the 2026-05-05 cap-fix branch — previously the function silently
 *     capped at one inter-stop gap of lateness, hiding multi-minute delays.
 *
 * Diagnostic emphasis: the suite logs the resolved offset for each scenario
 * so future tuning can compare against synthetic ground truth.
 */

import { vi, describe, it, expect, afterAll } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));

import { computeTripAdherenceOffset } from '../js/predictions.js';
import { ETA_DEPARTURE_LAG_S } from '../js/config.js';
import { logMarkdownTable } from './_helpers/diagnostics.js';

const _diagLog = [];
afterAll(() => {
    logMarkdownTable('computeTripAdherenceOffset — resolved offsets', _diagLog);
});

/**
 * Build a minimal cache for testing: 3 stops at arc 0, 1000, 2000 m,
 * 100 s scheduled gap each (10 m/s scheduled speed).
 */
function makeCache() {
    return {
        stops:     ['80101', '80202', '80303'],
        times:     [0, 100, 200],
        arcMeters: [0, 1000, 2000],
    };
}

/**
 * Build a marker stub matching what the SUT reads.
 */
function makeMarkerStub({
    snapArc, devM = 30, statusChangedAt, routeCode = '801',
} = {}) {
    return {
        properties: { route_code: routeCode, statusChangedAt },
        lastSnap: snapArc != null ? { arcMeters: snapArc } : null,
        lastSnapDeviationM: devM,
    };
}

describe('computeTripAdherenceOffset — null/missing data', () => {
    it('returns 0 when cache.arcMeters is missing', () => {
        const m = makeMarkerStub({ snapArc: 500, statusChangedAt: 1000 });
        const cache = { ...makeCache() }; delete cache.arcMeters;
        expect(computeTripAdherenceOffset(m, cache, 1, 1050)).toBe(0);
    });

    it('returns 0 when marker.lastSnap is null', () => {
        const m = makeMarkerStub({ snapArc: null, statusChangedAt: 1000 });
        expect(computeTripAdherenceOffset(m, makeCache(), 1, 1050)).toBe(0);
    });

    it('returns 0 when nextIdx ≤ 0 (origin or invalid)', () => {
        const m = makeMarkerStub({ snapArc: 500, statusChangedAt: 1000 });
        expect(computeTripAdherenceOffset(m, makeCache(), 0, 1050)).toBe(0);
        expect(computeTripAdherenceOffset(m, makeCache(), -1, 1050)).toBe(0);
    });

    it('returns 0 when statusChangedAt is null', () => {
        const m = makeMarkerStub({ snapArc: 500, statusChangedAt: null });
        expect(computeTripAdherenceOffset(m, makeCache(), 1, 1050)).toBe(0);
    });

    it('returns 0 when arc-position is outside the inter-stop segment', () => {
        const m = makeMarkerStub({ snapArc: 1500, statusChangedAt: 1000 });
        // nextIdx=1 means segment is [arcMeters[0], arcMeters[1]] = [0, 1000].
        // snapArc 1500 is past the segment → 0.
        expect(computeTripAdherenceOffset(m, makeCache(), 1, 1050)).toBe(0);
    });

    it('returns 0 when snap deviation exceeds the per-mode limit', () => {
        const m = makeMarkerStub({ snapArc: 500, statusChangedAt: 1000, devM: 999 });
        expect(computeTripAdherenceOffset(m, makeCache(), 1, 1050)).toBe(0);
    });
});

describe('computeTripAdherenceOffset — in-segment branch', () => {
    it('returns ~0 when vehicle is on schedule', () => {
        // 50 s elapsed (+ lag) on a 100 s/1000m segment → schedExpectedArc ~650
        // Position vehicle exactly at schedExpectedArc → offset ≈ 0
        const elapsedRaw = 50;
        const expectedArc = ((elapsedRaw + ETA_DEPARTURE_LAG_S) / 100) * 1000;
        const m = makeMarkerStub({ snapArc: expectedArc, statusChangedAt: 1000 });
        const off = computeTripAdherenceOffset(m, makeCache(), 1, 1000 + elapsedRaw);
        expect(Math.abs(off)).toBeLessThan(1);
        _diagLog.push({ scenario: 'on-schedule mid-segment', expected: '~0', resolved: off.toFixed(1) });
    });

    it('returns positive (late) when vehicle lags expected position', () => {
        // 50s elapsed → schedExpectedArc ~650; place vehicle at arc 400 → behind → late
        const m = makeMarkerStub({ snapArc: 400, statusChangedAt: 1000 });
        const off = computeTripAdherenceOffset(m, makeCache(), 1, 1050);
        expect(off).toBeGreaterThan(0);
        _diagLog.push({ scenario: 'lagging mid-segment', expected: 'positive', resolved: off.toFixed(1) });
    });

    it('returns negative (early) when vehicle is ahead of expected position', () => {
        // 50s elapsed → schedExpectedArc ~650; place vehicle at arc 900 → ahead
        const m = makeMarkerStub({ snapArc: 900, statusChangedAt: 1000 });
        const off = computeTripAdherenceOffset(m, makeCache(), 1, 1050);
        expect(off).toBeLessThan(0);
        _diagLog.push({ scenario: 'ahead mid-segment', expected: 'negative', resolved: off.toFixed(1) });
    });
});

describe('computeTripAdherenceOffset — overrun branch (2026-05-05 cap fix)', () => {
    it('expresses lateness > 1 segment when elapsed > interStopGap', () => {
        // 250 s elapsed on a 100 s gap → 150 s overrun, vehicle still at arc 500
        // overrun = (250+15) - 100 = 165; remainingTime = (1000-500)/10 = 50; total = 215
        const m = makeMarkerStub({ snapArc: 500, statusChangedAt: 1000 });
        const off = computeTripAdherenceOffset(m, makeCache(), 1, 1250);
        expect(off).toBeGreaterThan(100);
        _diagLog.push({ scenario: '150s overrun, half-segment', expected: '>100', resolved: off.toFixed(1) });
    });

    it('clamps lateness to +600 s when overrun is huge', () => {
        // 10000 s elapsed on a 100 s gap → uncapped raw would be ~10000s
        const m = makeMarkerStub({ snapArc: 500, statusChangedAt: 1000 });
        const off = computeTripAdherenceOffset(m, makeCache(), 1, 1000 + 10_000);
        expect(off).toBe(600);
        _diagLog.push({ scenario: 'extreme overrun', expected: '600 (clamp)', resolved: off.toFixed(1) });
    });

    it('handles vehicle at end of segment in overrun (remainingTime≈0)', () => {
        // 200 s elapsed (full overrun = 100 s+lag) but vehicle at arc 990 (almost there)
        const m = makeMarkerStub({ snapArc: 990, statusChangedAt: 1000 });
        const off = computeTripAdherenceOffset(m, makeCache(), 1, 1200);
        expect(off).toBeGreaterThan(50); // overrun branch active
        expect(off).toBeLessThan(150);   // remainingTime small
        _diagLog.push({ scenario: 'overrun + near stop', expected: '50-150', resolved: off.toFixed(1) });
    });
});
