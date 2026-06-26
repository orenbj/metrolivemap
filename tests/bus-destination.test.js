import { vi, describe, it, expect, afterEach } from 'vitest';

// predictions.js → snap.js → ui.js (showToast); stub ui.js so the module loads cleanly
vi.mock('../js/ui.js', () => ({
    showToast:         vi.fn(),
    updateDataPanel:   vi.fn(),
    getPopupHTML:      vi.fn(() => ''),
    cleanDestination:  s => s,
    updateUpdateTime:  vi.fn(),
    setConnectionStatus: vi.fn(),
    initUI:            vi.fn(),
}));

import { resolveBusDestination } from '../js/predictions.js';

// Mirror data/bus-destinations.json shape: dedup string table + two lookups.
const MAP = {
    dests: ['Downtown LA - 6th - Central', 'Inglewood Transit Center', 'LAX / Metro Transit Center', 'Santa Monica'],
    byRouteDir: {
        '720|0': 0,   // 720 dir 0 dominant → Downtown LA
        '720|1': 3,   // 720 dir 1 dominant → Santa Monica
        '111|1': 2,   // 111 dir 1 dominant → LAX (the branch trip below diverges)
    },
    byTrip: {
        'trip-111-ingl': 1, // a 111 dir-1 trip that actually short-turns to Inglewood
        'trip-idx0': 0,     // a byTrip override pointing at dests[0] — guards the falsy-index trap
    },
};

describe('resolveBusDestination', () => {
    afterEach(() => { delete window.masterBusDestinations; });

    it('returns the dominant destination for a clean route+direction', () => {
        window.masterBusDestinations = MAP;
        expect(resolveBusDestination('trip-720-x', '720', 1)).toBe('Santa Monica');
        expect(resolveBusDestination('trip-720-y', '720', 0)).toBe('Downtown LA - 6th - Central');
    });

    it('honors a byTrip index of 0 (must not fall through to byRouteDir)', () => {
        window.masterBusDestinations = MAP;
        // dests[0] is a valid destination; the resolver uses `!= null`, not a truthy
        // check, so index 0 must win over byRouteDir['720|1'] ('Santa Monica').
        expect(resolveBusDestination('trip-idx0', '720', 1)).toBe('Downtown LA - 6th - Central');
    });

    it('byTrip overrides byRouteDir for a branch / short-turn trip', () => {
        window.masterBusDestinations = MAP;
        // Same route+direction whose dominant is LAX, but THIS trip goes to Inglewood.
        expect(resolveBusDestination('trip-111-ingl', '111', 1)).toBe('Inglewood Transit Center');
        // A sibling trip with no byTrip entry falls back to the dominant.
        expect(resolveBusDestination('trip-111-other', '111', 1)).toBe('LAX / Metro Transit Center');
    });

    it('returns null when the route+direction is unknown (caller uses live terminus)', () => {
        window.masterBusDestinations = MAP;
        expect(resolveBusDestination('whatever', '999', 0)).toBeNull();
        expect(resolveBusDestination('whatever', '720', null)).toBeNull(); // unknown direction
    });

    it('returns null when the map is absent or malformed (no throw)', () => {
        expect(resolveBusDestination('t', '720', 1)).toBeNull();
        window.masterBusDestinations = {};
        expect(resolveBusDestination('t', '720', 1)).toBeNull();
        window.masterBusDestinations = { dests: 'nope' };
        expect(resolveBusDestination('t', '720', 1)).toBeNull();
    });
});
