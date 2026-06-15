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
 * getPopupHTML takes a single options object (#250); the `mk(overrides)`
 * helper below fills sensible defaults so each test overrides only the
 * field it's exercising.
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

// Default opts for a mid-route IN_TRANSIT_TO train; spread overrides on top.
const BASE = {
    routeCode: '801', vehicleId: 'V-1', vehicleLabel: 'Train ',
    timestamp: NOW_SEC, stopId: '80101', currentStatus: 'IN_TRANSIT_TO',
    directionId: 0, tripId: 'T-NB', currentStopSequence: 1,
    secToNextStop: 60, boardingDepSecs: null, etaSource: null,
};
const mk = (over = {}) => getPopupHTML({ ...BASE, ...over });

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
    // "Now" is reserved for a vehicle actually AT the stop (STOPPED_AT); an
    // in-transit vehicle reads "<1m" for the whole final minute so the rider
    // always sees the sub-minute state instead of "1m" jumping to "Now".
    it('STOPPED_AT renders the "Now" pill with the now class', () => {
        const html = mk({ currentStatus: 'STOPPED_AT', secToNextStop: 0 });
        expect(html).toContain('arr-time-pill now');
        expect(html).toContain('>Now<');
    });

    it('in-transit and 10s out renders "<1m" (not "Now")', () => {
        const html = mk({ secToNextStop: 10 });
        expect(html).toContain('>&lt;1m<');
        expect(html).not.toContain('arr-time-pill now');
    });

    it('in-transit and 29s out renders "<1m" (the old "Now" band is now "<1m")', () => {
        expect(mk({ secToNextStop: 29 })).toContain('>&lt;1m<');
    });

    it('exactly 30s renders "<1m"', () => {
        const html = mk({ secToNextStop: 30 });
        expect(html).toContain('>&lt;1m<');
        expect(html).not.toContain('arr-time-pill now');
    });

    it('45s bucket renders "<1m" (avoids the "30s" / "30m" misread)', () => {
        expect(mk({ secToNextStop: 45 })).toContain('>&lt;1m<');
    });

    it('exactly 60s rolls to "1m"', () => {
        expect(mk({ secToNextStop: 60 })).toContain('>1m<');
    });

    it('180s renders "3m"', () => {
        expect(mk({ secToNextStop: 180 })).toContain('>3m<');
    });

    it('null secToNextStop suppresses the ETA pill entirely', () => {
        expect(mk({ secToNextStop: null })).not.toContain('arr-time-pill');
    });
});

// ── Accessibility / clarity (audit V1, V2, V3, V5) ────────────────────

describe('getPopupHTML — a11y + footer clarity', () => {
    it('route icon has a meaningful alt — "E Line" for rail (V3)', () => {
        expect(mk({ routeCode: '804' })).toContain('alt="E Line"');
    });

    it('route icon alt falls back to "Route N" for buses (V3)', () => {
        expect(mk({ routeCode: '720' })).toContain('alt="Route 720"');
    });

    it('ETA pill carries an aria-label + title phrase (V2)', () => {
        const html = mk({ secToNextStop: 180 });
        expect(html).toContain('aria-label="in 3 minutes"');
        expect(html).toContain('title="in 3 minutes"');
    });

    it('boarding ETA pill speaks the "departs" phrase (V2)', () => {
        const html = mk({ boardingDepSecs: 300, secToNextStop: null });
        expect(html).toContain('aria-label="departs in 5 minutes"');
    });

    it('destination renders as an <h3> heading (V5)', () => {
        expect(mk()).toContain('<h3 class="pv2-dest">');
    });

    it('long destination name is wrapped so the cardinal stays pinned (truncation fix)', () => {
        // The name lives in its own .pv2-dest-name span (the only ellipsizing
        // element); the cardinal suffix sits OUTSIDE it so a long terminus
        // truncates the name instead of swallowing the direction cue.
        const html = mk({ routeCode: '804', directionId: 1 });  // E Line, has a cardinal
        const nameIdx = html.indexOf('class="pv2-dest-name"');
        const cardIdx = html.indexOf('class="pv2-cardinal"');
        expect(nameIdx).toBeGreaterThan(-1);
        expect(cardIdx).toBeGreaterThan(nameIdx);   // cardinal after the name span
        // The cardinal span is a sibling of the name span, not nested inside it.
        expect(html).toMatch(/<\/span><span class="pv2-cardinal"/);
    });

    it('footer age reads "Ns ago", not a bare "Ns" (V1)', () => {
        expect(mk({ timestamp: NOW_SEC - 47 })).toContain('>47s ago<');
    });
});

// ── ETA-source debug tag ──────────────────────────────────────────────

describe('getPopupHTML — ETA-source debug tag', () => {
    afterEach(() => {
        try { localStorage.removeItem('mlm_debug_eta'); } catch { /* shim */ }
    });

    it('renders no tag when the debug flag is unset (default)', () => {
        expect(mk({ secToNextStop: 180, etaSource: 'gtfs-rt' })).not.toContain('pv2-eta-src');
    });

    it('renders [RT] for gtfs-rt source when the flag is set', () => {
        localStorage.setItem('mlm_debug_eta', '1');
        const html = mk({ secToNextStop: 180, etaSource: 'gtfs-rt' });
        expect(html).toContain('pv2-eta-src');
        expect(html).toContain('data-src="gtfs-rt"');
        expect(html).toContain('[RT]');
    });

    it('renders [calc] for calc source when the flag is set', () => {
        localStorage.setItem('mlm_debug_eta', '1');
        const html = mk({ secToNextStop: 180, etaSource: 'calc' });
        expect(html).toContain('data-src="calc"');
        expect(html).toContain('[calc]');
    });

    it('renders no tag when flag is set but etaSource is null', () => {
        localStorage.setItem('mlm_debug_eta', '1');
        expect(mk({ secToNextStop: 180, etaSource: null })).not.toContain('pv2-eta-src');
    });
});

// ── Boarding departure label ──────────────────────────────────────────

describe('getPopupHTML — boardingDepSecs cascade', () => {
    const boarding = (boardingDepSecs) =>
        mk({ currentStatus: 'STOPPED_AT', secToNextStop: null, boardingDepSecs });

    it('< 30s suppresses the pill (too close to call)', () => {
        const html = boarding(15);
        expect(html).not.toContain('arr-time-pill');
        // status label still reads "Boarding"
        expect(html).toContain('>Boarding<');
    });

    it('30–59s renders "Departs <1m" (no "30s" token — matches every other ETA surface)', () => {
        expect(boarding(45)).toContain('Departs &lt;1m');
    });

    it('120s renders "Departs 2m"', () => {
        expect(boarding(120)).toContain('Departs 2m');
    });
});

// ── Status label cascade ──────────────────────────────────────────────

describe('getPopupHTML — status label cascade', () => {
    const callWith = (currentStatus, boardingDepSecs = null) =>
        mk({ currentStatus, secToNextStop: 60, boardingDepSecs });

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
        const html = mk({ tripId: 'T-LAST' });
        expect(html).toContain('Last Train');
        expect(html).toContain('veh-last-train');
    });

    it('regular trip → no badge', () => {
        expect(mk({ tripId: 'T-NB' })).not.toContain('Last Train');
    });
});

// ── Stop name lookup ──────────────────────────────────────────────────

describe('getPopupHTML — stop name lookup', () => {
    it('renders the cleaned name from masterStopsData (drops "Station" suffix)', () => {
        // cleanStationName strips " Station" — Hollywood/Vine has no other suffix
        expect(mk({ stopId: '80201' })).toMatch(/Hollywood\/Vine\b/);
    });

    it('unknown stopId → no stop section', () => {
        expect(mk({ stopId: '99999' })).not.toContain('pv2-stop-row');
    });

    it('null stopId → no stop section', () => {
        expect(mk({ stopId: null })).not.toContain('pv2-stop-row');
    });
});

// ── HTML escaping (XSS guard) ─────────────────────────────────────────

describe('getPopupHTML — HTML escaping', () => {
    it('escapes a malicious vehicleId so an injected <script> cannot fire', () => {
        const html = mk({ vehicleId: '<script>alert(1)</script>' });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('escapes a malicious stop name (so a poisoned masterStopsData entry is inert)', () => {
        window.masterStopsData = {
            '80101': { name: '<img src=x onerror=alert(1)>', lat: 0, lon: 0 },
        };
        const html = mk();
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img');
    });
});

// ── Freshness tier dot ────────────────────────────────────────────────

describe('getPopupHTML — freshness dot tier', () => {
    it('fresh timestamp → live tier', () => {
        expect(mk({ timestamp: NOW_SEC - 5 })).toContain('data-tier="live"');
    });

    it('renders an aria-label for the freshness dot (color-only signal otherwise)', () => {
        const live = mk({ timestamp: NOW_SEC - 5 });
        expect(live).toContain('role="img"');
        expect(live).toContain('aria-label="Data fresh"');

        const stale = mk({ timestamp: NOW_SEC - FRESH_STALE_S });
        expect(stale).toContain('aria-label="Data stale"');

        const expired = mk({ timestamp: NOW_SEC - 600 });
        expect(expired).toContain('aria-label="Data expired"');
    });

    it(`timestamp ${FRESH_STALE_S}s old → stale tier dot`, () => {
        expect(mk({ timestamp: NOW_SEC - FRESH_STALE_S })).toContain('data-tier="stale"');
    });

    it('very old timestamp → expired tier dot', () => {
        expect(mk({ timestamp: NOW_SEC - 600 })).toContain('data-tier="expired"');
    });

    it('secsSince clamps at 0 for future timestamps (no negative display)', () => {
        const html = mk({ timestamp: NOW_SEC + 100 });
        expect(html).toContain('>0s ago<');
        expect(html).not.toMatch(/>-\d+s/);
    });

    // The popup footer number AND its freshness dot both count from RECEIPT time
    // — the wall-clock moment we last ACCEPTED a fix (`marker._lastAcceptedWallMs`)
    // — so they read "how long since the last fresh update," resetting to ~0 on
    // each accepted frame instead of carrying the GPS fix's own feed latency.
    // markers.js updatePopup feeds `Math.floor(_lastAcceptedWallMs/1000)` as the
    // timestamp arg. A spike-rejected frame does NOT advance _lastAcceptedWallMs
    // (only accepted fixes do), so a frozen marker's receipt age still climbs and
    // its dot grays — never a green "live" dot on a stuck marker.
    it('dot reflects receipt time (_lastAcceptedWallMs), so a frozen marker grays', () => {
        // Frozen marker: last accepted fix was received 400s ago (rejected frames
        // since then did not advance _lastAcceptedWallMs). Reproduce updatePopup's
        // arg selection.
        const marker = { timestamp: NOW_SEC, _lastAcceptedWallMs: (NOW_SEC - 400) * 1000 };
        const recvTs = Math.floor(marker._lastAcceptedWallMs / 1000);
        const html = mk({ timestamp: recvTs });
        expect(html).toContain('data-tier="expired"');
        expect(html).not.toContain('data-tier="live"');
        expect(html).toContain('aria-label="Data expired"');
    });

    it('dot falls back to _lastAcceptedTs/timestamp when _lastAcceptedWallMs is absent', () => {
        // Cold-start / legacy path: no receipt stamp yet → updatePopup falls back
        // to `_lastAcceptedTs ?? marker.timestamp`.
        const marker = { timestamp: NOW_SEC - 5, _lastAcceptedTs: undefined, _lastAcceptedWallMs: undefined };
        const recvTs = marker._lastAcceptedWallMs != null
            ? Math.floor(marker._lastAcceptedWallMs / 1000)
            : (marker._lastAcceptedTs ?? marker.timestamp);
        const html = mk({ timestamp: recvTs });
        expect(html).toContain('data-tier="live"');
    });
});
