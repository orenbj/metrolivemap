/**
 * Unit tests for cleanDestination — the GTFS destination-text cleaner in ui.js.
 *
 * ui.js imports stations.js which has heavy init-time side effects (map, alerts,
 * bikeshare). cleanDestination doesn't use any of those exports, so stations.js
 * is mocked here to keep the import graph clean — the same pattern used in
 * popup-html.test.js.
 */

import { vi, describe, it, expect } from 'vitest';

// stations.js pulls in map / alerts / bikeshare at import time; mock it out
// so the heavy chain doesn't run. cleanDestination uses none of its exports.
vi.mock('../js/stations.js', () => ({
    stationGroups:      [],
    openStationByGroup: vi.fn(),
    closeStationPopup:  vi.fn(),
}));

import { cleanDestination } from '../js/ui.js';

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
