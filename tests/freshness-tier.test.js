/**
 * Tests for getFreshnessTier / getFreshnessTierFromAge in markers.js.
 *
 * The freshness tier is the single source of truth for per-vehicle VISUAL
 * state (opacity, popup status dot color, data-stale attribute). All
 * boundaries pinned to make tier transitions intentional, not accidental.
 *
 * Boundaries: 30s (live → aging), 90s (aging → stale), 300s (stale → expired).
 */

import { vi, describe, it, expect } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

import { getFreshnessTier, getFreshnessTierFromAge } from '../js/markers.js';
import { FRESH_LIVE_S, FRESH_AGING_S, FRESH_EXPIRE_S } from '../js/config.js';

describe('getFreshnessTierFromAge — boundary table', () => {
    const cases = [
        [0,                     'live'],
        [FRESH_LIVE_S - 1,      'live'],
        [FRESH_LIVE_S,          'aging'],   // inclusive at lower bound
        [FRESH_LIVE_S + 1,      'aging'],
        [FRESH_AGING_S - 1,     'aging'],
        [FRESH_AGING_S,         'stale'],   // inclusive at lower bound
        [FRESH_AGING_S + 1,     'stale'],
        [FRESH_EXPIRE_S - 1,    'stale'],
        [FRESH_EXPIRE_S,        'expired'], // inclusive at lower bound
        [FRESH_EXPIRE_S + 100,  'expired'],
    ];
    for (const [age, expected] of cases) {
        it(`age=${age}s → ${expected}`, () => {
            expect(getFreshnessTierFromAge(age)).toBe(expected);
        });
    }
});

describe('getFreshnessTier — reads marker.timestamp', () => {
    it('returns live for a marker with timestamp == now', () => {
        const nowSec = 1_000_000;
        expect(getFreshnessTier({ timestamp: nowSec }, nowSec)).toBe('live');
    });

    it('returns aging for a marker 45s behind now', () => {
        const nowSec = 1_000_000;
        expect(getFreshnessTier({ timestamp: nowSec - 45 }, nowSec)).toBe('aging');
    });

    it('returns stale for a marker 120s behind now', () => {
        const nowSec = 1_000_000;
        expect(getFreshnessTier({ timestamp: nowSec - 120 }, nowSec)).toBe('stale');
    });

    it('returns expired for a marker > 5min behind now', () => {
        const nowSec = 1_000_000;
        expect(getFreshnessTier({ timestamp: nowSec - 400 }, nowSec)).toBe('expired');
    });

    it('handles missing timestamp gracefully (treats as age = nowSec → expired)', () => {
        // A marker without a timestamp has age ≈ now (a huge number) → expired.
        // This is the safe default — predictions/cleanup should not treat
        // unknown-age markers as live.
        expect(getFreshnessTier({}, 1_000_000)).toBe('expired');
    });
});
