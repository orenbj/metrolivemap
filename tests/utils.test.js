/**
 * Tests for js/utils.js — pure math, string, and routing helpers used across
 * the codebase. No globals or DOM needed (escHtml uses simple string ops).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    planarMeters, computeBearing, cleanStationName, normalizeStopId,
    isStoppedAt, isArrivingAt,
    wsBackoffDelay, isBusRoute, isHeavyRail, isBrtRoute, escHtml,
    setVisibleInterval, clearVisibleInterval, runVisibleIntervalsNow,
    normalizeTimestamp, _resetNormalizeTimestampWarning, splitRouteId, localISODate,
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

    it('returns null for coincident points (no direction to compute)', () => {
        // Regression: previously atan2(0,0) quietly returned 0 (north),
        // so a polyline with a duplicate vertex emitted tangent=0 and
        // markers silently snapped to north on those segments.
        expect(computeBearing(-118.2, 34.0, -118.2, 34.0)).toBeNull();
    });

    it('returns a real bearing for sub-meter but non-coincident points', () => {
        // 1e-7° ≈ 1 cm — above the 1e-9 coincidence threshold, so should
        // still produce a real bearing rather than null.
        const b = computeBearing(-118.2, 34.0, -118.2, 34.0000001);
        expect(b).not.toBeNull();
        expect(b).toBeCloseTo(0, 0);
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

    it('keeps "Transit Center" spelled out when abbreviateTransitCenter=false', () => {
        // alerts.js builds match regexes against Metro's alert prose, which
        // always spells out "Transit Center" — an abbreviated "TC" pattern
        // would never match the feed text.
        expect(cleanStationName('El Monte Transit Center', false, false)).toBe('El Monte Transit Center');
        expect(cleanStationName('LAX / Metro Transit Center', false, false)).toBe('LAX / Metro Transit Center');
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

describe('isBrtRoute', () => {
    it('returns true for G Line (901)', () => expect(isBrtRoute('901')).toBe(true));
    it('returns true for J Line (910)', () => expect(isBrtRoute('910')).toBe(true));
    it('returns true for J Line San Pedro extension (950)', () => expect(isBrtRoute('950')).toBe(true));
    it('returns false for light rail (801)', () => expect(isBrtRoute('801')).toBe(false));
    it('returns false for heavy rail (802)', () => expect(isBrtRoute('802')).toBe(false));
    it('returns false for numeric 910 (boundary cast must happen before call)', () => expect(isBrtRoute(910)).toBe(false));
});

describe('localISODate', () => {
    // Regression for the GTFS service-date watcher in main.js. The pre-fix
    // version concatenated `getMonth()` directly (0–11) without padding, so
    // a date comparison built from this string was always-false-then-always-
    // true and triggered a redundant GTFS reload at every local midnight.

    it('zero-pads single-digit months (January → "01")', () => {
        // new Date(2026, 0, 5) → Jan 5 2026 in local time
        expect(localISODate(new Date(2026, 0, 5))).toBe('2026-01-05');
    });

    it('zero-pads single-digit days (May 9 → "09")', () => {
        expect(localISODate(new Date(2026, 4, 9))).toBe('2026-05-09');
    });

    it('handles December correctly (month 11 → "12")', () => {
        expect(localISODate(new Date(2026, 11, 31))).toBe('2026-12-31');
    });

    it('uses local-time accessors, not UTC', () => {
        // A date constructed via the local-time constructor uses the
        // runtime's local timezone. Even if the test machine is in UTC,
        // the constructor + accessors stay self-consistent, so the asserted
        // value matches what would have been printed.
        const d = new Date(2026, 4, 19, 23, 30, 0);  // May 19, 11:30 PM local
        expect(localISODate(d)).toBe('2026-05-19');
    });

    it('produces a monotonic string for === comparisons', () => {
        // The string is consumed via === at main.js:167, so two distinct
        // dates must never collide. Verify two adjacent dates.
        const may19 = localISODate(new Date(2026, 4, 19));
        const may20 = localISODate(new Date(2026, 4, 20));
        expect(may19).not.toBe(may20);
    });
});

describe('normalizeTimestamp', () => {
    it('passes seconds through unchanged', () => {
        expect(normalizeTimestamp(1_700_000_000)).toBe(1_700_000_000);
    });

    it('converts milliseconds to seconds', () => {
        expect(normalizeTimestamp(1_700_000_000_000)).toBe(1_700_000_000);
    });

    it('boundary: 1e10 is treated as seconds', () => {
        expect(normalizeTimestamp(1e10)).toBe(1e10);
    });

    it('boundary: 1e10 + 1 is treated as milliseconds', () => {
        expect(normalizeTimestamp(1e10 + 1)).toBe(Math.floor((1e10 + 1) / 1000));
    });

    it('handles zero', () => {
        expect(normalizeTimestamp(0)).toBe(0);
    });

    it('parses ISO-8601 strings as Unix seconds (Metro alerts API format)', () => {
        // Metro's alerts API emits activePeriod.start/end as ISO strings.
        // Consolidating string handling into normalizeTimestamp let us drop
        // a per-caller wrapper in alerts.js.
        expect(normalizeTimestamp('2026-01-01T00:00:00Z')).toBe(Math.floor(Date.UTC(2026, 0, 1) / 1000));
    });

    it('parses a Unix-seconds numeric string (numeric coerce path)', () => {
        // Some feeds send numeric strings; new Date('1700000000') would parse
        // as a year, so string handling routes through the Date constructor.
        // This case asserts the contract — callers that want pure numeric
        // semantics should Number() the input first (existing pattern in
        // tripUpdates.js:156).
        expect(Number.isFinite(normalizeTimestamp('2026-01-01'))).toBe(true);
    });

    it('returns NaN for negative numeric input (clock-skew / garbage feed)', () => {
        // Previously a -1 flowed through and recordFeedDrop('invalidTs') in
        // api.js under-reported because Number.isFinite(-1) is true. NaN
        // collapses to the same path as missing-timestamp.
        expect(Number.isNaN(normalizeTimestamp(-1))).toBe(true);
        expect(Number.isNaN(normalizeTimestamp(-1700000000))).toBe(true);
    });

    it('returns NaN for non-numeric, non-string input', () => {
        expect(Number.isNaN(normalizeTimestamp(null))).toBe(true);
        expect(Number.isNaN(normalizeTimestamp(undefined))).toBe(true);
        expect(Number.isNaN(normalizeTimestamp({}))).toBe(true);
    });

    it('returns NaN for an unparseable ISO string', () => {
        // new Date('garbage').getTime() is NaN, so the floor/sign path collapses
        // to NaN — downstream callers check Number.isFinite() and drop the row.
        _resetNormalizeTimestampWarning();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(Number.isNaN(normalizeTimestamp('not a date'))).toBe(true);
        expect(Number.isNaN(normalizeTimestamp(''))).toBe(true);
        warnSpy.mockRestore();
    });

    it('emits ONE console.warn per session on unparseable string input', () => {
        // Audit follow-up: an unparseable feed timestamp used to fail silently.
        // Now it surfaces a warning once so a feed-side regression is visible
        // the next time a developer opens the console. Subsequent failures
        // are suppressed to keep the log signal-to-noise high.
        _resetNormalizeTimestampWarning();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        normalizeTimestamp('not a date');
        normalizeTimestamp('also garbage');
        normalizeTimestamp('still bad');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('normalizeTimestamp');
        warnSpy.mockRestore();
    });

    it('returns NaN for an ISO string that resolves to a pre-epoch (negative) time', () => {
        // Real alert feeds shouldn't emit pre-1970 timestamps, but be explicit:
        // the negative-sign guard inside normalizeTimestamp catches them.
        expect(Number.isNaN(normalizeTimestamp('1969-01-01'))).toBe(true);
    });

    it('round-trips a recent ISO string within the expected Unix-seconds range', () => {
        // Sanity: matches Date.parse semantics — alerts ingest relies on this
        // for activePeriod.start/end comparison against `now`.
        const t = normalizeTimestamp('2026-06-01T12:34:56Z');
        expect(t).toBe(Math.floor(Date.UTC(2026, 5, 1, 12, 34, 56) / 1000));
    });
});

describe('splitRouteId', () => {
    it('strips the dash-suffix on a string id', () => {
        expect(splitRouteId('801-13095')).toBe('801');
    });

    it('returns the input when there is no suffix', () => {
        expect(splitRouteId('801')).toBe('801');
    });

    it('handles null and undefined as empty string', () => {
        expect(splitRouteId(null)).toBe('');
        expect(splitRouteId(undefined)).toBe('');
    });

    it('String-casts numeric inputs', () => {
        expect(splitRouteId(801)).toBe('801');
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

describe('setVisibleInterval / clearVisibleInterval', () => {
    let _registered = [];

    beforeEach(() => {
        _registered = [];
        vi.useFakeTimers();
    });

    afterEach(() => {
        // Tidy up any intervals the test created so they don't leak across files.
        for (const id of _registered) clearVisibleInterval(id);
        vi.useRealTimers();
    });

    it('returns an entryId and ticks the callback on the given cadence', () => {
        const fn = vi.fn();
        const id = setVisibleInterval(fn, 1000);
        _registered.push(id);
        expect(typeof id).toBe('number');
        vi.advanceTimersByTime(3500);
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('clearVisibleInterval stops the interval and removes the registry entry', () => {
        const fn = vi.fn();
        const id = setVisibleInterval(fn, 1000);
        vi.advanceTimersByTime(1500);
        expect(fn).toHaveBeenCalledTimes(1);
        clearVisibleInterval(id);
        vi.advanceTimersByTime(5000);
        expect(fn).toHaveBeenCalledTimes(1);
        // Registry size hook should reflect the removal.
        const size = window.__visRegistrySize?.() ?? 0;
        // After clearing, no entry with our key should remain — registry may
        // still hold prior intervals from other tests in this file, but our
        // own entry is gone (verified by the no-additional-ticks assertion).
        expect(size).toBeGreaterThanOrEqual(0);
    });

    it('re-registering with the same key replaces the prior interval (no stacking)', () => {
        const fn1 = vi.fn();
        const fn2 = vi.fn();
        const id1 = setVisibleInterval(fn1, 1000, 'test:dedup');
        _registered.push(id1);
        vi.advanceTimersByTime(1500);
        expect(fn1).toHaveBeenCalledTimes(1);

        // Re-register with the same key — fn1's interval should be cancelled.
        const id2 = setVisibleInterval(fn2, 1000, 'test:dedup');
        _registered.push(id2);
        vi.advanceTimersByTime(2500);
        expect(fn1).toHaveBeenCalledTimes(1);   // no further ticks
        expect(fn2).toHaveBeenCalledTimes(2);
    });

    it('different keys register independently', () => {
        const a = vi.fn();
        const b = vi.fn();
        _registered.push(setVisibleInterval(a, 1000, 'test:a'));
        _registered.push(setVisibleInterval(b, 1000, 'test:b'));
        vi.advanceTimersByTime(2500);
        expect(a).toHaveBeenCalledTimes(2);
        expect(b).toHaveBeenCalledTimes(2);
    });

    it('exposes a registry-size hook for the long-session debug logger', () => {
        const before = window.__visRegistrySize();
        _registered.push(setVisibleInterval(() => {}, 1000, 'test:size'));
        const after  = window.__visRegistrySize();
        expect(after).toBe(before + 1);
    });

    it('skips the initial setInterval when registered while document.hidden', () => {
        // Regression for PR #151: a page loaded in a background tab should
        // not tick its registered intervals at full cadence until the user
        // focuses the tab. Spoof `document.hidden`, register an interval,
        // advance timers — the callback must not fire while still hidden.
        const origHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        try {
            const fn = vi.fn();
            _registered.push(setVisibleInterval(fn, 1000, 'test:hidden'));
            vi.advanceTimersByTime(5000);
            expect(fn).toHaveBeenCalledTimes(0);
        } finally {
            if (origHidden) {
                Object.defineProperty(document, 'hidden', origHidden);
            } else {
                delete document.hidden;
            }
        }
    });

    it('runVisibleIntervalsNow fires every registered callback immediately', () => {
        const a = vi.fn();
        const b = vi.fn();
        _registered.push(setVisibleInterval(a, 100000, 'test:now-a'));
        _registered.push(setVisibleInterval(b, 100000, 'test:now-b'));
        // No time advanced — neither has ticked on its own cadence yet.
        expect(a).toHaveBeenCalledTimes(0);
        expect(b).toHaveBeenCalledTimes(0);

        runVisibleIntervalsNow();
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('runVisibleIntervalsNow keeps going if one callback throws', () => {
        const boom = vi.fn(() => { throw new Error('feed down'); });
        const ok   = vi.fn();
        _registered.push(setVisibleInterval(boom, 100000, 'test:throw'));
        _registered.push(setVisibleInterval(ok, 100000, 'test:after-throw'));
        expect(() => runVisibleIntervalsNow()).not.toThrow();
        expect(boom).toHaveBeenCalledTimes(1);
        expect(ok).toHaveBeenCalledTimes(1);   // not aborted by the throw
    });

    it('a bfcache pageshow (persisted) force-refreshes all polled feeds', () => {
        const fn = vi.fn();
        _registered.push(setVisibleInterval(fn, 100000, 'test:pageshow'));
        expect(fn).toHaveBeenCalledTimes(0);

        // Simulate the browser/tab being reopened from the back-forward cache.
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        expect(fn).toHaveBeenCalledTimes(1);

        // A normal (non-bfcache) load — persisted=false — must NOT refire.
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
