/**
 * Tests for js/stations.js exports: compute8Cardinal (the pure helper that
 * powers the "Nearby buses" direction suffix), _alertRouteChips (line-letter
 * chips on station service-alert banners), _isRedundantStationName (dedupe
 * check for alert headers that just repeat the station name), and
 * _formatArrivalPill (arrival/departure pill bucketing on the station
 * board). Other stations.js surface area (popup rendering, station merging)
 * is exercised end-to-end via the live app rather than unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { compute8Cardinal, _alertRouteChips, _isRedundantStationName, _formatArrivalPill } from '../js/stations.js';

// LA basin reference latitude — used so the cos(lat) longitude scaling kicks in
// like it does in production. At 34°N, 1° of longitude ≈ 83% of 1° of latitude
// in metres; the helper corrects for this internally.
const LAT = 34.05;
const LON = -118.25;

// One degree of latitude ≈ 111 km, so 0.01° ≈ 1.1 km — well outside the ~50 m
// null zone the helper applies for "too close to label".
const STEP = 0.01;

describe('compute8Cardinal', () => {
    it('returns N for a terminus due north', () => {
        expect(compute8Cardinal(LAT, LON, LAT + STEP, LON)).toBe('N');
    });

    it('returns S for a terminus due south', () => {
        expect(compute8Cardinal(LAT, LON, LAT - STEP, LON)).toBe('S');
    });

    it('returns E for a terminus due east', () => {
        expect(compute8Cardinal(LAT, LON, LAT, LON + STEP)).toBe('E');
    });

    it('returns W for a terminus due west', () => {
        expect(compute8Cardinal(LAT, LON, LAT, LON - STEP)).toBe('W');
    });

    it('returns NE for a terminus equally north and east (after cos-lat scaling)', () => {
        // dLat = +STEP, dLon scaled by cos(lat) ≈ 0.829 ⇒ supply dLon = STEP / cos(lat)
        // so that the cos-corrected magnitudes match.
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT + STEP, LON + dLonRaw)).toBe('NE');
    });

    it('returns SE for a terminus south + east', () => {
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT - STEP, LON + dLonRaw)).toBe('SE');
    });

    it('returns SW for a terminus south + west', () => {
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT - STEP, LON - dLonRaw)).toBe('SW');
    });

    it('returns NW for a terminus north + west', () => {
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT + STEP, LON - dLonRaw)).toBe('NW');
    });

    it('classifies a westbound trip slightly south as W (the bug-class fix)', () => {
        // The old 4-bucket magnitude test would return Southbound here because
        // |dLat| in degrees is bigger than |dLon|, even though after the cos(lat)
        // scaling the eastbound component dominates. 8-bucket bearing classification
        // resolves it to the closer cardinal — W when dLon ≫ dLat in metres.
        // dLat = -0.002° (~ 220 m south), dLon = -0.02° unscaled (~ 1850 m west).
        expect(compute8Cardinal(LAT, LON, LAT - 0.002, LON - 0.02)).toBe('W');
    });

    it('returns null inside the ~50 m null zone (terminus too close)', () => {
        expect(compute8Cardinal(LAT, LON, LAT + 0.0001, LON + 0.0001)).toBeNull();
    });

    it('returns null when station coords are not finite', () => {
        expect(compute8Cardinal(NaN, LON, LAT + STEP, LON)).toBeNull();
        expect(compute8Cardinal(LAT, undefined, LAT + STEP, LON)).toBeNull();
    });

    it('returns null when terminus coords are not finite', () => {
        expect(compute8Cardinal(LAT, LON, NaN, LON)).toBeNull();
        expect(compute8Cardinal(LAT, LON, LAT + STEP, null)).toBeNull();
    });
});

describe('_alertRouteChips — line chips on station service-alert banners', () => {
    it('returns empty string for no routes', () => {
        expect(_alertRouteChips(undefined)).toBe('');
        expect(_alertRouteChips(new Set())).toBe('');
    });

    it('renders a single line letter with an aria-label', () => {
        const html = _alertRouteChips(new Set(['802'])); // B Line
        expect(html).toContain('aria-label="Affects B Line"');
        expect(html).toContain('B'); // letter via icon alt or fallback pill
        expect(html).not.toContain('Lines'); // singular for one route
    });

    it('renders multiple lines sorted by letter with a pluralized label', () => {
        const html = _alertRouteChips(new Set(['805', '802'])); // D + B → sorted B, D
        expect(html).toContain('aria-label="Affects B, D Lines"');
    });

    it('collapses the J Line 910/950 split into a single chip', () => {
        const html = _alertRouteChips(new Set(['910', '950'])); // both → J
        expect(html).toContain('aria-label="Affects J Line"');
        // Exactly one chip element (icon or fallback pill) — the regex matches
        // class="sp-alert-chip" / "sp-alert-chip-icon" but NOT the "sp-alert-chips" wrapper.
        expect((html.match(/class="sp-alert-chip(-icon)?"/g) || []).length).toBe(1);
    });
});


describe('_isRedundantStationName — drop alert headers that just repeat the station', () => {
    it('drops an exact (normalized) match', () => {
        expect(_isRedundantStationName('Hollywood/Vine Station', 'Hollywood / Vine')).toBe(true);
        expect(_isRedundantStationName('WILSHIRE/NORMANDIE', 'Wilshire / Normandie')).toBe(true);
    });

    it('drops a per-line header that is a SUBSET of a merged station name', () => {
        // The reported bug: merged busway+rail station, alert names one component.
        expect(_isRedundantStationName('37TH ST/USC STATION', 'Harbor Transitway / 37th St / USC')).toBe(true);
    });

    it('matches across the st↔street / blvd↔boulevard abbreviation', () => {
        // Reported "name dupe": title "7th Street / Metro Center", escalator
        // alert header "7TH ST/METRO STATION" — must collapse st↔street to match.
        expect(_isRedundantStationName('7TH ST/METRO STATION', '7th Street / Metro Center')).toBe(true);
        expect(_isRedundantStationName('7TH STREET/METRO STATION', '7th St / Metro Center')).toBe(true);
        // Avenue + Boulevard collapse both directions.
        expect(_isRedundantStationName('Atlantic Ave Station', 'Atlantic Avenue')).toBe(true);
        expect(_isRedundantStationName('LONG BEACH BLVD STATION', 'Long Beach Boulevard')).toBe(true);
    });

    it('KEEPS a header that adds info beyond the station name', () => {
        expect(_isRedundantStationName('37th St/USC — elevator to platform', 'Harbor Transitway / 37th St / USC')).toBe(false);
        expect(_isRedundantStationName('Use Wilshire/Western instead', 'Wilshire / Normandie')).toBe(false);
    });

    it('returns false for empty header or station name', () => {
        expect(_isRedundantStationName('', 'Union Station')).toBe(false);
        expect(_isRedundantStationName('Union Station', '')).toBe(false);
        expect(_isRedundantStationName(null, 'Union Station')).toBe(false);
    });
});

// ── Arrival / departure pill bucketing ────────────────────────────────────
// "Now" is reserved for an arrived/departing event (secAway <= 0); the whole
// final minute reads "<1m" so a prediction that leaps from >=60s into the
// sub-minute range still passes through "<1m" instead of jumping to "Now".

describe('_formatArrivalPill', () => {
    it('null secAway → "Now" (missing departureUnix collapses to Now)', () => {
        expect(_formatArrivalPill(null)).toEqual({ label: 'Now', isNow: true });
    });

    it('arrived/past (secAway <= 0) → "Now"', () => {
        expect(_formatArrivalPill(0)).toEqual({ label: 'Now', isNow: true });
        expect(_formatArrivalPill(-15)).toEqual({ label: 'Now', isNow: true });
    });

    it('1s inbound → "<1m" (no longer "Now")', () => {
        expect(_formatArrivalPill(1)).toEqual({ label: '<1m', isNow: false });
    });

    it('29s inbound → "<1m" (the old "Now" band is now "<1m")', () => {
        expect(_formatArrivalPill(29)).toEqual({ label: '<1m', isNow: false });
    });

    it('59s inbound → "<1m"', () => {
        expect(_formatArrivalPill(59)).toEqual({ label: '<1m', isNow: false });
    });

    it('exactly 60s → "1m"', () => {
        expect(_formatArrivalPill(60)).toEqual({ label: '1m', isNow: false });
    });

    it('185s → "3m"', () => {
        expect(_formatArrivalPill(185)).toEqual({ label: '3m', isNow: false });
    });

    // Minutes round to NEAREST (not floor) to match Metro's platform countdowns;
    // floor read ~1 min early. The boundary is the half-minute.
    it('rounds to nearest minute, not floor', () => {
        expect(_formatArrivalPill(89)).toEqual({ label: '1m', isNow: false });   // 1.48 → 1
        expect(_formatArrivalPill(90)).toEqual({ label: '2m', isNow: false });   // 1.50 → 2
        expect(_formatArrivalPill(110)).toEqual({ label: '2m', isNow: false });  // 1.83 → 2 (floor gave "1m")
        expect(_formatArrivalPill(149)).toEqual({ label: '2m', isNow: false });  // 2.48 → 2
        expect(_formatArrivalPill(150)).toEqual({ label: '3m', isNow: false });  // 2.50 → 3
    });
});

describe('_formatArrivalPill — atStop (station-board ↔ vehicle-popup parity)', () => {
    // The vehicle popup gates "Now" on STOPPED_AT. The station board must agree:
    // when the contributing marker's status is known, "Now" is driven by atStop,
    // not by secAway<=0 — otherwise the same train showed "Now" on the board and
    // "<1m" in the popup once it reached its predicted time but wasn't here yet.
    it('atStop=true → "Now" regardless of secAway', () => {
        expect(_formatArrivalPill(8, true)).toEqual({ label: 'Now', isNow: true });
        expect(_formatArrivalPill(0, true)).toEqual({ label: 'Now', isNow: true });
    });

    it('atStop=false → never "Now"; a reached-but-not-stopped train reads "<1m" (the fix)', () => {
        expect(_formatArrivalPill(0, false)).toEqual({ label: '<1m', isNow: false });
        expect(_formatArrivalPill(-3, false)).toEqual({ label: '<1m', isNow: false });
        expect(_formatArrivalPill(45, false)).toEqual({ label: '<1m', isNow: false });
        expect(_formatArrivalPill(120, false)).toEqual({ label: '2m', isNow: false });
    });

    it('atStop=undefined falls back to the secAway proxy (GTFS-only / bus rows)', () => {
        expect(_formatArrivalPill(0, undefined)).toEqual({ label: 'Now', isNow: true });
        expect(_formatArrivalPill(30, undefined)).toEqual({ label: '<1m', isNow: false });
        expect(_formatArrivalPill(null, undefined)).toEqual({ label: 'Now', isNow: true });
    });
});
