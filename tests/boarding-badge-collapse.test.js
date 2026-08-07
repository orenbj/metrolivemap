/**
 * _collectBoardingState same-brand-color collapse (910/950 share J Line gray).
 *
 * Found by the dual-agent hunt. The collapse's tiebreak compared depLabel
 * against '—' — a string that only exists at RENDER time (_entryHTML); at the
 * data layer unknown is '' (_formatDeparture(null)). The preference therefore
 * never fired, and because origins are sorted by route code, 910 always arrived
 * first: at El Monte a known 950 departure deterministically LOST to an empty
 * 910 entry and the J badge showed a dash despite a known time. The #621
 * fallback made that state common, since it fills the two J route codes
 * independently.
 *
 * The collapse now compares raw depUnix (null = Infinity), which also picks the
 * SOONER of two real times — what a "next departure" badge means.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({
    stationGroups: [{ stopIds: ['91001'], lon: -118.10, lat: 34.07, normName: 'el monte' }],
    dedupeAlertsByEffect: a => a,
    _accessFacilityLabel: () => '',
}));

import { initPredictions } from '../js/predictions.js';
import { _collectBoardingState } from '../js/boardingBadges.js';
import { installGlobals, addArrival } from './_helpers/globals.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    installGlobals({
        trips: {
            'TR-910-1': { rc: '910', dir: 0, dest: 'Downtown LA', total: 3,
                stops: ['91001', '91002', '91003'], scheduledTimes: [0, 120, 240] },
            'TR-950-1': { rc: '950', dir: 0, dest: 'San Pedro via Downtown', total: 3,
                stops: ['91001', '91002', '91004'], scheduledTimes: [0, 120, 300] },
        },
        stops: {
            '91001': { lat: 34.07, lon: -118.10, name: 'El Monte Station' },
            '91002': { lat: 34.06, lon: -118.15, name: 'Cal State LA' },
            '91003': { lat: 34.05, lon: -118.25, name: 'Downtown' },
            '91004': { lat: 33.74, lon: -118.29, name: 'San Pedro' },
        },
    });
    initPredictions();
});

describe('J badge collapse (910 no data, 950 known departure)', () => {
    it('shows the 950 departure, not an empty label', () => {
        const dep = NOW() + 13 * 60;
        // Only the 950 trip has a known departure.
        addArrival('91001', {
            tripId: 'TR-950-1', routeId: '950', directionId: 0,
            arrivalUnix: dep, departureUnix: dep, lastIngestUnix: NOW(),
        });
        const badges = _collectBoardingState();
        const all = [...badges.values()].flatMap(b => b.entries);
        // What the comment in the code promises:
        expect(all.some(e => e.depLabel === '13m')).toBe(true);
    });

    it('control: reversed (910 known, 950 unknown) keeps the 910 time', () => {
        const dep = NOW() + 13 * 60;
        addArrival('91001', {
            tripId: 'TR-910-1', routeId: '910', directionId: 0,
            arrivalUnix: dep, departureUnix: dep, lastIngestUnix: NOW(),
        });
        const badges = _collectBoardingState();
        const all = [...badges.values()].flatMap(b => b.entries);
        expect(all.some(e => e.depLabel === '13m')).toBe(true);
    });

    it('keeps the SOONER of two real J departures', () => {
        addArrival('91001', { tripId: 'TR-910-1', routeId: '910', directionId: 0,
            arrivalUnix: NOW() + 20 * 60, departureUnix: NOW() + 20 * 60, lastIngestUnix: NOW() });
        addArrival('91001', { tripId: 'TR-950-1', routeId: '950', directionId: 0,
            arrivalUnix: NOW() + 5 * 60, departureUnix: NOW() + 5 * 60, lastIngestUnix: NOW() });
        const badges = _collectBoardingState();
        const all = [...badges.values()].flatMap(b => b.entries);
        // One collapsed J entry, showing the next departure — not 910's later one.
        expect(all.filter(e => ['910', '950'].includes(e.routeCode))).toHaveLength(1);
        expect(all.some(e => e.depLabel === '5m')).toBe(true);
    });
});
