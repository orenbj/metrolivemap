/**
 * Unit tests for cleanDestination — the GTFS destination-text cleaner in ui.js.
 *
 * ui.js imports stations.js which has heavy init-time side effects (map, alerts,
 * bikeshare). cleanDestination doesn't use any of those exports, so stations.js
 * is mocked here to keep the import graph clean — the same pattern used in
 * popup-html.test.js.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// stations.js pulls in map / alerts / bikeshare at import time; mock it out
// so the heavy chain doesn't run. cleanDestination uses none of its exports.
vi.mock('../js/stations.js', () => ({
    stationGroups:      [],
    openStationByGroup: vi.fn(),
    closeStationPopup:  vi.fn(),
}));

import { cleanDestination, nextActiveIndex, updateUpdateTime } from '../js/ui.js';

// Regression coverage for the whole-app-audit LOW: updateUpdateTime() is called on
// EVERY accepted vehicle frame (~170/s), but the "Updated at HH:MM:SS" label only
// changes once per second. It now gates on the epoch-second so the ~169 redundant
// calls each second skip the getElementById + Intl format + DOM write entirely.
describe('updateUpdateTime — epoch-second throttle', () => {
    // The throttle's gate (_lastUpdateTimeSec) is module state with no test-reset
    // export, so each test uses its OWN starting second (far apart) — a shared
    // literal time across tests could let one test's leftover gate value
    // coincidentally throttle-skip another test's first call.
    beforeEach(() => {
        document.body.innerHTML = '<div id="update-time"></div>';
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // Format is TZ-dependent (the test runner's local zone, not the ISO offset
    // below — toLocaleTimeString formats in the system zone), so assertions use
    // a zone-agnostic shape check + equality/inequality, not literal HH:MM:SS.
    const TIME_LABEL = /^Updated at \d{1,2}:\d{2}:\d{2}/;

    it('repeat calls within the same second skip the DOM lookup entirely', () => {
        vi.setSystemTime(new Date('2026-01-01T12:00:00.000-08:00'));
        const el = document.getElementById('update-time');   // grab BEFORE spying
        const spy = vi.spyOn(document, 'getElementById');
        updateUpdateTime();
        expect(spy).toHaveBeenCalledTimes(1);
        const text = el.textContent;
        expect(text).toMatch(TIME_LABEL);

        vi.setSystemTime(new Date('2026-01-01T12:00:00.500-08:00'));  // +500ms, same second
        updateUpdateTime();
        expect(spy).toHaveBeenCalledTimes(1);   // no second lookup — throttled
        expect(el.textContent).toBe(text);
    });

    it('crossing a second boundary updates the label again', () => {
        vi.setSystemTime(new Date('2026-01-01T15:30:10.000-08:00'));   // distinct from the test above
        updateUpdateTime();
        const first = document.getElementById('update-time').textContent;
        expect(first).toMatch(TIME_LABEL);

        vi.setSystemTime(new Date('2026-01-01T15:30:11.000-08:00'));  // +1s — new second
        updateUpdateTime();
        const second = document.getElementById('update-time').textContent;
        expect(second).toMatch(TIME_LABEL);
        expect(second).not.toBe(first);
    });
});

describe('cleanDestination', () => {
    it('preserves "Union Station" as a special case', () => {
        expect(cleanDestination('Union Station')).toBe('Union Station');
    });

    it('preserves "Union Station" case-insensitively', () => {
        expect(cleanDestination('union station')).toBe('Union Station');
        expect(cleanDestination('UNION STATION')).toBe('Union Station');
    });

    it('strips dash-suffix and "Station" (El Monte pattern)', () => {
        expect(cleanDestination('El Monte Station - Downtown LA / J Line')).toBe('El Monte');
    });

    it('strips line-letter suffix and "Station" (North Hollywood pattern)', () => {
        expect(cleanDestination('North Hollywood Station G Line')).toBe('North Hollywood');
    });

    it('strips plain "Station" suffix (Norwalk pattern)', () => {
        expect(cleanDestination('Norwalk Station')).toBe('Norwalk');
    });

    it('preserves slash-in-name while stripping "Station"', () => {
        expect(cleanDestination('LAX/Aviation Station')).toBe('LAX/Aviation');
    });

    it('returns empty string for empty input', () => {
        expect(cleanDestination('')).toBe('');
    });

    it('returns empty string for null (coerced via String)', () => {
        expect(cleanDestination(null)).toBe('');
    });

    it('returns empty string for undefined (coerced via String)', () => {
        expect(cleanDestination(undefined)).toBe('');
    });

    it('strips trailing " /" left after other replacements', () => {
        // e.g. a destination whose only slash is the trailing separator
        expect(cleanDestination('Pomona /')).toBe('Pomona');
    });

    it('trims surrounding whitespace', () => {
        expect(cleanDestination('  Culver City Station  ')).toBe('Culver City');
    });

    it('strips "J Line" variant (letter + "Line") suffix', () => {
        expect(cleanDestination('Azusa Station J Line')).toBe('Azusa');
    });

    it('strips dash-suffix when no "Station" present', () => {
        // Some destinations may carry a dash-suffix without the word Station
        expect(cleanDestination('Expo Park - Extra text')).toBe('Expo Park');
    });
});

describe('nextActiveIndex (search-results keyboard nav)', () => {
    it('returns -1 when there are no options', () => {
        expect(nextActiveIndex(-1, 0, 1)).toBe(-1);
        expect(nextActiveIndex(-1, 0, -1)).toBe(-1);
        expect(nextActiveIndex(2, 0, 1)).toBe(-1);
    });

    it('ArrowDown from no active option lands on the first', () => {
        expect(nextActiveIndex(-1, 5, 1)).toBe(0);
    });

    it('ArrowUp from no active option lands on the last', () => {
        expect(nextActiveIndex(-1, 5, -1)).toBe(4);
    });

    it('ArrowDown advances one and wraps last → first', () => {
        expect(nextActiveIndex(0, 5, 1)).toBe(1);
        expect(nextActiveIndex(3, 5, 1)).toBe(4);
        expect(nextActiveIndex(4, 5, 1)).toBe(0);
    });

    it('ArrowUp retreats one and wraps first → last', () => {
        expect(nextActiveIndex(4, 5, -1)).toBe(3);
        expect(nextActiveIndex(1, 5, -1)).toBe(0);
        expect(nextActiveIndex(0, 5, -1)).toBe(4);
    });

    it('handles a single option (wraps to itself)', () => {
        expect(nextActiveIndex(0, 1, 1)).toBe(0);
        expect(nextActiveIndex(0, 1, -1)).toBe(0);
        expect(nextActiveIndex(-1, 1, 1)).toBe(0);
        expect(nextActiveIndex(-1, 1, -1)).toBe(0);
    });
});
