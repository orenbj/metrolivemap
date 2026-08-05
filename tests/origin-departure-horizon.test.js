/**
 * Regression: a TERMINUS row showed "—" while the next stop down the line
 * showed real ETAs for the same trains.
 *
 * Reported at Pomona North (A Line north terminus, southbound → Downtown Long
 * Beach) and Downtown Santa Monica (E Line west terminus, eastbound →
 * Atlantic): the departure row read "—", yet one stop down the line the very
 * same trips rendered as "13m / 34m" and "<1m / 21m".
 *
 * TWO defects stacked, both in the origin-stop branch of `_renderRowPills`,
 * and the data was present at the terminus the whole time:
 *
 *  1. The branch only considered trains inside `BOARDING_MAX_HORIZON_S`
 *     (10 min), then fell through to the em-dash. That horizon is
 *     the right question for the BOARDING BADGE ("is a train physically
 *     sitting here to board?") and the wrong one for the departure row
 *     ("when does the next train leave?"). Any headway over 10 min emptied
 *     both lists — which is why it only happened SOME of the time.
 *
 *  2. It overwrote each entry's real `departureUnix` with `arrivalUnix`. At a
 *     terminus those genuinely differ: arrival is when the train pulls IN to
 *     lay over, departure is when it pulls OUT. So the row measured the wrong
 *     event — both for the horizon test and for the time it displayed.
 *
 * Pomona North fits exactly: a train pulling in at ~11 min sits past the
 * 10-minute cutoff, so the row showed "—" while La Verne one stop down showed
 * the same train at 13m.
 *
 * Contract pinned here: an origin row prefers boardable departures; when none
 * are within the horizon it shows the next known DEPARTURES rather than "—".
 */

import { describe, it, expect, vi } from 'vitest';

const CACHE = {
    // 801|1 = A Line southbound: Pomona North (origin) → La Verne → …
    '801|1': { stops: ['80140', '80141', '80142'] },
    '801|0': { stops: ['80142', '80141', '80140'] },
};

vi.mock('../js/predictions.js', () => ({
    getScheduledArrivals: () => [],
    getBoardingVehicles: () => [],
    getRouteCache: (rc, dir) => CACHE[`${rc}|${dir}`],
    getTerminalName: () => 'Downtown Long Beach',
    resolveTripDestination: () => 'Downtown Long Beach',
    // 80140 is idx 0 of 801|1 → the southbound row takes the ORIGIN branch.
    isOriginStop: (stopIds, rc, dir) =>
        rc === '801' && dir === 1 && stopIds.includes('80140'),
    isTerminalStop: () => false,
    isNearTerminalStop: () => false,
}));

import { _renderRailRouteBlocks } from '../js/stations.js';

const NOW = 1_700_000_000;
globalThis.window = globalThis.window || {};
window.masterTripsData = {};

/** Southbound departures from the terminus at the given minute offsets. */
const routeMapAt = (...mins) => new Map([
    ['801', {
        0: [],
        1: mins.map((m, i) => ({ tripId: `t${i}`, arrivalUnix: NOW + m * 60, atStop: false })),
    }],
]);

describe('origin/terminus departure row — beyond the boarding horizon', () => {
    it('shows the next departure even when it is past BOARDING_MAX_HORIZON_S (the bug)', () => {
        // 13 min and 34 min out — exactly the Pomona North case. Both sit
        // beyond the 10-minute boarding horizon, so pre-fix this rendered "—".
        const html = _renderRailRouteBlocks(routeMapAt(13, 34), ['80140'], [], NOW);
        expect(html).toContain('arr-time-pill');
        expect(html).toContain('13m');
        // (The opposite-direction row legitimately renders "—" here — this
        // station group has no northbound arrivals in the fixture — so we
        // assert on the southbound times rather than the absence of any dash.)
    });

    it('still prefers boardable trains when something IS within the horizon', () => {
        // A 2-minute departure and a 34-minute one: the imminent train leads.
        const html = _renderRailRouteBlocks(routeMapAt(2, 34), ['80140'], [], NOW);
        const pills = [...html.matchAll(/class="arr-time-pill[^"]*"[^>]*>([^<]*)/g)].map(m => m[1]);
        expect(pills[0]).toContain('2m');
    });

    it('renders the em-dash only when there is genuinely nothing to show', () => {
        const html = _renderRailRouteBlocks(routeMapAt(), ['80140'], [], NOW);
        expect(html).toContain('sp-no-data');
        expect(html).not.toContain('arr-time-pill');
    });

    it('drops departures already in the past (they are not "next")', () => {
        const html = _renderRailRouteBlocks(routeMapAt(-20, 25), ['80140'], [], NOW);
        expect(html).toContain('arr-time-pill');
        expect(html).toContain('25m');
    });
});

describe('origin row — departure time, not the layover arrival', () => {
    it('shows when the train LEAVES, not when it pulls in', () => {
        // The bug underneath the reported "—". At a terminus the feed carries
        // BOTH times and they differ: the train pulls IN at 11 min and pulls
        // OUT at 15. The row was overwriting departureUnix with arrivalUnix,
        // so a rider on the platform was told "11m" for a train that does not
        // leave for 15 — and the 10-min horizon then hid it entirely.
        const map = new Map([['801', { 0: [], 1: [
            { tripId: 't0', arrivalUnix: NOW + 11 * 60, departureUnix: NOW + 15 * 60 },
        ] }]]);
        const html = _renderRailRouteBlocks(map, ['80140'], [], NOW);
        expect(html).toContain('15m');
        expect(html).not.toContain('11m');
    });

    it('falls back to the arrival when the entry carries no departure', () => {
        const map = new Map([['801', { 0: [], 1: [
            { tripId: 't0', arrivalUnix: NOW + 11 * 60 },
        ] }]]);
        expect(_renderRailRouteBlocks(map, ['80140'], [], NOW)).toContain('11m');
    });

    it('marks the final departure of the night with the LAST tag', () => {
        window.masterTripsData = { t0: { isLast: true } };
        const html = _renderRailRouteBlocks(routeMapAt(22), ['80140'], [], NOW);
        expect(html).toContain('pill-last');
        window.masterTripsData = {};
    });
});
