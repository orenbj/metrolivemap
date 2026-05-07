/**
 * Tests for js/utils.js — pure math, string, and routing helpers used across
 * the codebase. No globals or DOM needed (escHtml uses simple string ops).
 */

import { describe, it, expect } from 'vitest';
import {
    planarMeters, computeBearing, cleanStationName, normalizeStopId,
    isStoppedAt, isArrivingAt, wsBackoffDelay, isBusRoute, isHeavyRail, escHtml,
    M_PER_DEG_LAT,
} from '../js/utils.js';

describe('planarMeters', () => {
    it('returns ~100m for 100m of latitude', () => {
        const d = planarMeters(34.0, -118.2, 34.0 + (100 / M_PER_DEG_LAT), -118.2);
        expect(d).toBeCloseTo(100, 0);
    });

    it('returns ~100m for 100m of longitude at LA latitude', () => {
        // Use the M_PER_DEG_LNG_LA constant value (92630) to construct a 100m offset
        const d = planarMeters(34.0, -118.2, 34.0, -118.2 + (100 / 92630));
        expect(d).toBeCloseTo(100, 0);
    });

    it('is symmetric', () => {
        const a = planarMeters(34.0, -118.2, 34.05, -118.15);
        const b = planarMeters(34.05, -118.15, 34.0, -118.2);
        expect(a).toBeCloseTo(b, 6);
    });

    it('returns 0 for identical points', () => {
        expect(planarMeters(34.0, -118.2, 34.0, -118.2)).toBe(0);
    });
});

describe('computeBearing', () => {
    it('returns ~0 for due north', () => {
        const b = computeBearing(-118.2, 34.0, -118.2, 34.1);
        expect(b).toBeCloseTo(0, 1);
    });

    it('returns ~90 for due east', () => {
        const b = computeBearing(-118.2, 34.0, -118.1, 34.0);
        expect(b).toBeCloseTo(90, 0);
    });

    it('returns ~180 for due south', () => {
        const b = computeBearing(-118.2, 34.0, -118.2, 33.9);
        expect(b).toBeCloseTo(180, 1);
    });

    it('returns ~270 for due west', () => {
        const b = computeBearing(-118.2, 34.0, -118.3, 34.0);
        expect(b).toBeCloseTo(270, 0);
    });

    it('returns a value in [0, 360)', () => {
        const b = computeBearing(-118.2, 34.0, -118.3, 33.9);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(360);
    });
});

describe('cleanStationName', () => {
    it('strips "- A Line" suffix', () => {
        expect(cleanStationName('Pico - A Line', false)).toBe('Pico');
    });

    it('strips " Station" suffix when result is ≥5 chars', () => {
        expect(cleanStationName('Sierra Madre Villa Station')).toBe('Sierra Madre Villa');
    });

    it('preserves " Station" when stripping would leave a too-short name', () => {
        // "Pico" is only 4 chars — below the 5-char guard, so " Station" stays.
        expect(cleanStationName('Pico Station')).toBe('Pico Station');
    });

    it('preserves "Union Station"', () => {
        expect(cleanStationName('Union Station')).toBe('Union Station');
    });

    it('replaces "Transit Center" with "TC"', () => {
        expect(cleanStationName('El Monte Transit Center', false)).toBe('El Monte TC');
    });

    it('handles null/undefined gracefully', () => {
        expect(cleanStationName(null)).toBe('');
        expect(cleanStationName(undefined)).toBe('');
    });
});

describe('normalizeStopId', () => {
    it('strips _N directional suffix', () => {
        expect(normalizeStopId('80101_N')).toBe('80101');
    });

    it('strips _S/_E/_W directional suffixes', () => {
        expect(normalizeStopId('80101_S')).toBe('80101');
        expect(normalizeStopId('80101_E')).toBe('80101');
        expect(normalizeStopId('80101_W')).toBe('80101');
    });

    it('does NOT strip a single-letter suffix without underscore', () => {
        // Stops like 80101S exist as separate entries (entrance variants).
        expect(normalizeStopId('80101S')).toBe('80101S');
    });

    it('coerces non-string inputs', () => {
        expect(normalizeStopId(80101)).toBe('80101');
    });
});

describe('isStoppedAt / isArrivingAt', () => {
    it('isStoppedAt accepts numeric 1 and string "STOPPED_AT"', () => {
        expect(isStoppedAt(1)).toBe(true);
        expect(isStoppedAt('STOPPED_AT')).toBe(true);
    });

    it('isStoppedAt rejects other values', () => {
        expect(isStoppedAt(0)).toBe(false);
        expect(isStoppedAt(2)).toBe(false);
        expect(isStoppedAt(null)).toBe(false);
        expect(isStoppedAt('IN_TRANSIT_TO')).toBe(false);
    });

    it('isArrivingAt accepts numeric 0 and string "INCOMING_AT"', () => {
        expect(isArrivingAt(0)).toBe(true);
        expect(isArrivingAt('INCOMING_AT')).toBe(true);
    });
});

describe('wsBackoffDelay', () => {
    it('returns ~base on attempt=0 (within jitter range)', () => {
        const d = wsBackoffDelay(0, 5000, 300_000);
        expect(d).toBeGreaterThanOrEqual(5000 * 0.8);
        expect(d).toBeLessThanOrEqual(5000 * 1.2);
    });

    it('doubles on attempt=1', () => {
        const d = wsBackoffDelay(1, 5000, 300_000);
        expect(d).toBeGreaterThanOrEqual(10_000 * 0.8);
        expect(d).toBeLessThanOrEqual(10_000 * 1.2);
    });

    it('caps at max (with jitter)', () => {
        const d = wsBackoffDelay(20, 5000, 300_000);
        expect(d).toBeLessThanOrEqual(300_000 * 1.2);
        expect(d).toBeGreaterThanOrEqual(300_000 * 0.8);
    });
});

describe('isBusRoute / isHeavyRail', () => {
    it('isBusRoute true for 901 and 910', () => {
        expect(isBusRoute('901')).toBe(true);
        expect(isBusRoute('910')).toBe(true);
    });

    it('isBusRoute false for rail routes', () => {
        expect(isBusRoute('801')).toBe(false);
        expect(isBusRoute('802')).toBe(false);
    });

    it('isHeavyRail true for B (802) and D (805)', () => {
        expect(isHeavyRail('802')).toBe(true);
        expect(isHeavyRail('805')).toBe(true);
    });

    it('isHeavyRail false for light rail and bus', () => {
        expect(isHeavyRail('801')).toBe(false);
        expect(isHeavyRail('803')).toBe(false);
        expect(isHeavyRail('901')).toBe(false);
    });
});

describe('escHtml', () => {
    it('escapes HTML metacharacters', () => {
        expect(escHtml('<script>alert("x")</script>'))
            .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    });

    it('escapes ampersand and apostrophe', () => {
        expect(escHtml(`Tom & Jerry's`)).toBe('Tom &amp; Jerry&#39;s');
    });

    it('returns empty string for null/undefined', () => {
        expect(escHtml(null)).toBe('');
        expect(escHtml(undefined)).toBe('');
    });

    it('coerces non-strings', () => {
        expect(escHtml(42)).toBe('42');
    });
});
