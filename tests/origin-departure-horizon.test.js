/**
 * Regression: a TERMINUS row showed "—" while the next stop down the line
 * showed real ETAs for the same trains.
 *
 * Reported at Pomona North (A Line north terminus, southbound → Downtown Long
 * Beach) and Downtown Santa Monica (E Line west terminus, eastbound →
 * Atlantic): the departure row read "—", yet one stop down the line the very
 * same trips rendered as "13m / 34m" and "<1m / 21m".
 *
 * This file covers ONE of the two causes: the display filter. (The other —
 * masterArrivalsData genuinely empty at the terminus — is covered by
 * tests/derived-origin-departures.test.js.)
 *
 * When the data IS present at the terminus, `_renderRowPills` still hid it:
 * the ORIGIN-stop branch only ever considered trains inside
 * `BOARDING_MAX_HORIZON_S` (10 min). That horizon is
 * the right question for the BOARDING BADGE ("is a train physically sitting
 * here to board?") but the wrong one for the departure row ("when does the
 * next train leave?"). Between departures — off-peak, or any headway over
 * 10 min — both lists came back empty and the row fell through to the em-dash,
 * which is why it only happened SOME of the time.
 *
 * Contract pinned here: an origin row prefers boardable departures, but when
 * none are within the horizon it falls back to the next known departures
 * rather than rendering "—".
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
    getDerivedOriginDepartures: () => [],
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
