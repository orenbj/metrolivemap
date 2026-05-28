/**
 * Tests for getPopupHTML — the function that renders the rider-facing
 * vehicle marker popup. Until this file landed, every test in the suite
 * vi.mock'd ui.js's getPopupHTML to return '', so the ETA-label cascade,
 * status-label resolution, and HTML escaping were entirely uncovered
 * despite being the most rider-visible surface in the app.
 *
 * What's exercised here:
 *   - ETA bucketing (Now / <1m / Xm) for `secToNextStop`
 *   - Boarding-departs label cascade (suppressed / 30s / Xm)
 *   - Status label cascade (Boarding / At stop / Next stop)
 *   - Last-train badge presence on `tripInfo.isLast`
 *   - Stop name lookup from window.masterStopsData
 *   - Destination resolution via resolveTripDestination
 *   - HTML escaping for vehicle label and stop name (XSS guard)
 *   - Freshness tier dot derived from timestamp age
 *
 * stations.js is mocked because it pulls in a heavy import chain (map +
 * alerts + bikeshare); getPopupHTML doesn't actually use it.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// stations.js init-time side effects pull in map / alerts / bikeshare; getPopupHTML
// doesn't actually call any of its exports, so a no-op mock keeps the import graph clean.
vi.mock('../js/stations.js', () => ({
    stationGroups:        [],
    openStationByGroup:   vi.fn(),
    closeStationPopup:    vi.fn(),
}));

import { getPopupHTML } from '../js/ui.js';
import { FRESH_STALE_S } from '../js/config.js';

const NOW_SEC = 1_700_000_000;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SEC * 1000);
    // Fresh per-test globals — the popup reads stop and trip data via window.*
    globalThis.window = globalThis.window || {};
    window.masterStopsData = {
        '80101': { name: '7th St / Metro Center Station', lat: 34.05, lon: -118.26 },
        '80201': { name: 'Hollywood/Vine Station',         lat: 34.10, lon: -118.33 },
        '80301': { name: 'Union Station',                  lat: 34.06, lon: -118.23 },
    };
    window.masterTripsData = {
        'T-NB': { dest: 'North Hollywood Station', isLast: false, stops: [] },
        'T-LAST': { dest: 'Long Beach Station', isLast: true,  stops: [] },
    };
});

// ── ETA label bucketing ───────────────────────────────────────────────

describe('getPopupHTML — secToNextStop bucketing', () => {
    const args = (secToNextStop) => [
        '801', 'V-1', 'Train ', NOW_SEC, '80101',
        'IN_TRANSIT_TO', 0, 'T-NB', 1, secToNextStop,
    ];

    it('< 30s renders the "Now" pill with the now class', () => {
        const html = getPopupHTML(...args(10));
        expect(html).toContain('arr-time-pill now');
        expect(html).toContain('>Now<');
    });

    it('exactly 29s still bucket as "Now"', () => {
        const html = getPopupHTML(...args(29));
        expect(html).toContain('>Now<');
    });

    it('exactly 30s rolls over to "<1m"', () => {
        const html = getPopupHTML(...args(30));
        expect(html).toContain('>&lt;1m<');
        expect(html).not.toContain('arr-time-pill now');
    });

    it('45s bucket renders "<1m" (avoids the "30s" / "30m" misread)', () => {
        const html = getPopupHTML(...args(45));
        expect(html).toContain('>&lt;1m<');
    });

    it('exactly 60s rolls to "1m"', () => {
        const html = getPopupHTML(...args(60));
        expect(html).toContain('>1m<');
    });

    it('180s renders "3m"', () => {
        const html = getPopupHTML(...args(180));
        expect(html).toContain('>3m<');
    });

    it('null secToNextStop suppresses the ETA pill entirely', () => {
        const html = getPopupHTML(...args(null));
        expect(html).not.toContain('arr-time-pill');
    });
});

// ── ETA-source debug tag ──────────────────────────────────────────────

describe('getPopupHTML — ETA-source debug tag', () => {
    // routeCode … secToNextStop, boardingDepSecs, etaSource
    const args = (etaSource) => [
        '801', 'V-1', 'Train ', NOW_SEC, '80101',
        'IN_TRANSIT_TO', 0, 'T-NB', 1, 180, null, etaSource,
    ];

    afterEach(() => {
        try { localStorage.removeItem('mlm_debug_eta'); } catch { /* shim */ }
    });

    it('renders no tag when the debug flag is unset (default)', () => {
        const html = getPopupHTML(...args('gtfs-rt'));
        expect(html).not.toContain('pv2-eta-src');
    });

    it('renders [RT] for gtfs-rt source when the flag is set', () => {
        localStorage.setItem('mlm_debug_eta', '1');
        const html = getPopupHTML(...args('gtfs-rt'));
        expect(html).toContain('pv2-eta-src');
        expect(html).toContain('data-src="gtfs-rt"');
        expect(html).toContain('[RT]');
    });

    it('renders [calc] for calc source when the flag is set', () => {
        localStorage.setItem('mlm_debug_eta', '1');
        const html = getPopupHTML(...args('calc'));
        expect(html).toContain('data-src="calc"');
        expect(html).toContain('[calc]');
    });

    it('renders no tag when flag is set but etaSource is null', () => {
        localStorage.setItem('mlm_debug_eta', '1');
        const html = getPopupHTML(...args(null));
        expect(html).not.toContain('pv2-eta-src');
    });
});

// ── Boarding departure label ──────────────────────────────────────────

describe('getPopupHTML — boardingDepSecs cascade', () => {
    const argsBoarding = (boardingDepSecs) => [
        '801', 'V-1', 'Train ', NOW_SEC, '80101',
        'STOPPED_AT', 0, 'T-NB', 1, null, boardingDepSecs,
    ];

    it('< 30s suppresses the pill (too close to call)', () => {
        const html = getPopupHTML(...argsBoarding(15));
        expect(html).not.toContain('arr-time-pill');
        // status label still reads "Boarding"
        expect(html).toContain('>Boarding<');
    });

    it('30–59s renders "Departs 30s"', () => {
        const html = getPopupHTML(...argsBoarding(45));
        expect(html).toContain('Departs 30s');
    });

    it('120s renders "Departs 2m"', () => {
        const html = getPopupHTML(...argsBoarding(120));
        expect(html).toContain('Departs 2m');
    });
});

// ── Status label cascade ──────────────────────────────────────────────

describe('getPopupHTML — status label cascade', () => {
    const callWith = (currentStatus, boardingDepSecs = null) => getPopupHTML(
        '801', 'V-1', 'Train ', NOW_SEC, '80101',
        currentStatus, 0, 'T-NB', 1, 60, boardingDepSecs,
    );

    it('boardingDepSecs present → "Boarding" wins over any currentStatus', () => {
        expect(callWith('IN_TRANSIT_TO', 30)).toContain('>Boarding<');
        expect(callWith('STOPPED_AT',    30)).toContain('>Boarding<');
    });

    it('STOPPED_AT (no boarding) → "At stop"', () => {
        expect(callWith('STOPPED_AT')).toContain('>At stop<');
    });

    it('IN_TRANSIT_TO → "Next stop"', () => {
        expect(callWith('IN_TRANSIT_TO')).toContain('>Next stop<');
    });
});

// ── Last-train badge ──────────────────────────────────────────────────

describe('getPopupHTML — last-train badge', () => {
    it('tripInfo.isLast → "Last Train" badge appears', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC, '80101',
            'IN_TRANSIT_TO', 0, 'T-LAST', 1, 60,
        );
        expect(html).toContain('Last Train');
        expect(html).toContain('veh-last-train');
    });

    it('regular trip → no badge', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).not.toContain('Last Train');
    });
});

// ── Stop name lookup ──────────────────────────────────────────────────

describe('getPopupHTML — stop name lookup', () => {
    it('renders the cleaned name from masterStopsData (drops "Station" suffix)', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC, '80201',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        // cleanStationName strips " Station" — Hollywood/Vine has no other suffix
        expect(html).toMatch(/Hollywood\/Vine\b/);
    });

    it('unknown stopId → no stop section', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC, '99999',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).not.toContain('pv2-stop-row');
    });

    it('null stopId → no stop section', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC, null,
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).not.toContain('pv2-stop-row');
    });
});

// ── HTML escaping (XSS guard) ─────────────────────────────────────────

describe('getPopupHTML — HTML escaping', () => {
    it('escapes a malicious vehicleId so an injected <script> cannot fire', () => {
        const html = getPopupHTML(
            '801', '<script>alert(1)</script>', 'Train ', NOW_SEC, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('escapes a malicious stop name (so a poisoned masterStopsData entry is inert)', () => {
        window.masterStopsData = {
            '80101': { name: '<img src=x onerror=alert(1)>', lat: 0, lon: 0 },
        };
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });
});

// ── Freshness tier dot ────────────────────────────────────────────────

describe('getPopupHTML — freshness dot tier', () => {
    it('fresh timestamp → live tier', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC - 5, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).toContain('data-tier="live"');
    });

    it('renders an aria-label for the freshness dot (color-only signal otherwise)', () => {
        const live = getPopupHTML('801', 'V-1', 'Train ', NOW_SEC - 5, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60);
        expect(live).toContain('role="img"');
        expect(live).toContain('aria-label="Data fresh"');

        const stale = getPopupHTML('801', 'V-1', 'Train ', NOW_SEC - FRESH_STALE_S, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60);
        expect(stale).toContain('aria-label="Data stale"');

        const expired = getPopupHTML('801', 'V-1', 'Train ', NOW_SEC - 600, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60);
        expect(expired).toContain('aria-label="Data expired"');
    });

    it(`timestamp ${FRESH_STALE_S}s old → stale tier dot`, () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC - FRESH_STALE_S, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).toContain('data-tier="stale"');
    });

    it('very old timestamp → expired tier dot', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC - 600, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).toContain('data-tier="expired"');
    });

    it('secsSince clamps at 0 for future timestamps (no negative display)', () => {
        const html = getPopupHTML(
            '801', 'V-1', 'Train ', NOW_SEC + 100, '80101',
            'IN_TRANSIT_TO', 0, 'T-NB', 1, 60,
        );
        expect(html).toContain('>0s<');
        expect(html).not.toMatch(/>-\d+s</);
    });
});
