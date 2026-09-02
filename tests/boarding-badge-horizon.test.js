/**
 * The terminus badge must show the next DEPARTURE even when it is further out
 * than the boarding horizon.
 *
 * `getBoardingVehicles` caps at `BOARDING_MAX_HORIZON_S` (10 min) because it
 * answers "is a train physically sitting here to board?". The badge reused that
 * answer directly, so at any headway over ten minutes — most of the off-peak
 * day — it rendered an em-dash for a terminus whose next departure was perfectly
 * well known.
 *
 * This pins the WIRING specifically. The helper (`getNextOriginDeparture`) and
 * the formatter (`_formatDeparture`) each have their own tests, but neither can
 * see whether the badge builder actually consults the fallback — deleting the
 * call left both of those suites green.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());
// stations.js drags in map/alerts/bikeshare at import time.
vi.mock('../js/stations.js', () => ({
    stationGroups: [{ stopIds: ['80101'], lon: -118.23, lat: 34.05, normName: 'union station' }],
    dedupeAlertsByEffect: a => a,
    _accessFacilityLabel: () => '',
}));

import { initPredictions } from '../js/predictions.js';
import { _collectBoardingState } from '../js/boardingBadges.js';
import { installGlobals, addArrival } from './_helpers/globals.js';

const NOW = () => Math.floor(Date.now() / 1000);

/** depLabel for route 801 in the single badge the fixtures produce. */
function labelFor801() {
    const badges = _collectBoardingState();
    for (const b of badges.values()) {
        const e = b.entries.find(x => x.routeCode === '801');
        if (e) return e.depLabel;
    }
    return undefined;
}

beforeEach(() => {
    installGlobals();
    initPredictions();
});

describe('terminus badge — departures beyond the boarding horizon', () => {
    it('shows a 23-minute departure instead of an em-dash', () => {
        const dep = NOW() + 23 * 60;
        addArrival('80101', {
            tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: dep, departureUnix: dep, lastIngestUnix: NOW(),
        });
        expect(labelFor801()).toBe('23m');
    });

    it('shows the pull-OUT time during a layover, not the pull-in', () => {
        const arr = NOW() + 11 * 60, dep = NOW() + 15 * 60;
        addArrival('80101', {
            tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: arr, departureUnix: dep, lastIngestUnix: NOW(),
        });
        expect(labelFor801()).toBe('15m');
    });

    it('still renders an empty label when NOTHING is known — the only em-dash case', () => {
        expect(labelFor801()).toBe('');
    });

    it('does not show a stale entry', () => {
        addArrival('80101', {
            tripId: 'TR-A-1', routeId: '801', directionId: 0,
            arrivalUnix: NOW() + 20 * 60, departureUnix: NOW() + 20 * 60,
            lastIngestUnix: NOW() - 9999,
        });
        expect(labelFor801()).toBe('');
    });
});
