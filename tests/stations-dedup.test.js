/**
 * Tests for the dedupeAlertsByEffect helper in stations.js.
 *
 * Regression for the badge-side alert dedup bug: two alerts with the same
 * effect code but different descriptions used to drop the earlier one
 * silently via `new Map(alerts.map(a => [a.effect, a]))`. The helper now
 * preserves every distinct description so the badge tooltip + popup both
 * render the full content.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock MapLibre and predictions so stations.js can be imported without a
// live map. We don't need them for the pure helper test.
vi.mock('../js/predictions.js', () => ({
    getActiveAlerts: () => [],
    getActiveStopAccessibilityAlerts: () => [],
    resolveTripDestination: () => null,
    getRouteCache: () => null,
}));

import { dedupeAlertsByEffect, _mergedPeriodLines, _isJLineOnly, BRT_INFRA_NAME_RE } from '../js/stations.js';

describe('dedupeAlertsByEffect', () => {
    it('returns [] for empty input', () => {
        expect(dedupeAlertsByEffect([])).toEqual([]);
    });

    it('passes a single alert through with _count=1 and one _descriptions entry', () => {
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Northbound trains rerouted via Long Beach.' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].effect).toBe('DETOUR');
        expect(out[0]._count).toBe(1);
        expect(out[0]._descriptions).toEqual(['Northbound trains rerouted via Long Beach.']);
    });

    it('merges two alerts with the same effect AND identical description into one entry', () => {
        // Same effect, same description → one entry, _count=2, one description.
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Trains rerouted.' },
            { id: 'a-2', effect: 'DETOUR', description: 'Trains rerouted.' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._count).toBe(2);
        expect(out[0]._descriptions).toEqual(['Trains rerouted.']);
    });

    it('preserves BOTH descriptions when same effect carries distinct text', () => {
        // The bug: pre-fix, the badge path used `new Map([effect, alert])`
        // and only the last alert survived. Now both descriptions are
        // preserved in _descriptions[].
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'SIGNIFICANT_DELAYS', description: 'A Line: 15-min delays northbound.' },
            { id: 'a-2', effect: 'SIGNIFICANT_DELAYS', description: 'A Line: 10-min delays southbound.' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._count).toBe(2);
        expect(out[0]._descriptions).toHaveLength(2);
        expect(out[0]._descriptions).toContain('A Line: 15-min delays northbound.');
        expect(out[0]._descriptions).toContain('A Line: 10-min delays southbound.');
    });

    it('carries each description\'s OWN activePeriod, index-aligned in _periods', () => {
        // The ×2-banner period bug: the merged entry inherited only the FIRST
        // alert's activePeriod, so a banner could read "– Jun 30" while its
        // second body said "ends December 31".
        const p1 = { start: 1000, end: 2000 };
        const p2 = { start: 1500, end: 9000 };
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Detour A.', activePeriod: p1 },
            { id: 'a-2', effect: 'DETOUR', description: 'Detour B.', activePeriod: p2 },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._descriptions).toEqual(['Detour A.', 'Detour B.']);
        expect(out[0]._periods).toEqual([p1, p2]);
        // Group-level activePeriod stays the first alert's (legacy field).
        expect(out[0].activePeriod).toEqual(p1);
    });

    it('carries each description\'s OWN routes, index-aligned in _routes, and unions group routes', () => {
        // The line-logo sibling of the _periods bug: a B Line detour and a
        // D Line detour at a shared station (same effect) merged into one
        // entry that inherited only the FIRST alert's routes — so the D Line
        // description rendered under the B Line logo in the badge tooltip.
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'B Line detour.', routes: ['802'] },
            { id: 'a-2', effect: 'DETOUR', description: 'D Line detour.', routes: ['805'] },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._routes).toEqual([['802'], ['805']]);       // per-description attribution
        expect(out[0].routes).toEqual(['802', '805']);            // group union for merged banners
    });

    it('skipping a duplicate description also skips its routes (arrays stay aligned)', () => {
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Same text.',  routes: ['801'] },
            { id: 'a-2', effect: 'DETOUR', description: 'Same text.',  routes: ['804'] },  // dup text → dropped
            { id: 'a-3', effect: 'DETOUR', description: 'Other text.', routes: ['804'] },
        ]);
        expect(out[0]._routes).toEqual([['801'], ['804']]);
        // Union still counts the dropped duplicate's routes — its line is affected.
        expect(out[0].routes).toEqual(['801', '804']);
    });

    it('tolerates alerts with no routes field (pre-#608 shape, accessibility alerts)', () => {
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'One.' },
            { id: 'a-2', effect: 'DETOUR', description: 'Two.', routes: ['802'] },
        ]);
        expect(out[0]._routes).toEqual([[], ['802']]);
        expect(out[0].routes).toEqual(['802']);
    });

    it('skipping a duplicate description also skips its period (arrays stay aligned)', () => {
        const p1 = { start: 1000, end: 2000 };
        const p2 = { start: 3000, end: 4000 };
        const p3 = { start: 5000, end: 6000 };
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Same text.',  activePeriod: p1 },
            { id: 'a-2', effect: 'DETOUR', description: 'Same text.',  activePeriod: p2 },  // dup text → dropped
            { id: 'a-3', effect: 'DETOUR', description: 'Other text.', activePeriod: p3 },
        ]);
        expect(out[0]._descriptions).toEqual(['Same text.', 'Other text.']);
        expect(out[0]._periods).toEqual([p1, p3]);
    });

    it('keeps distinct effects as separate entries', () => {
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR',             description: 'Detour A.' },
            { id: 'a-2', effect: 'SIGNIFICANT_DELAYS', description: 'Delays B.' },
            { id: 'a-3', effect: 'DETOUR',             description: 'Detour C.' },
        ]);
        expect(out).toHaveLength(2);
        const detour = out.find(a => a.effect === 'DETOUR');
        const delays = out.find(a => a.effect === 'SIGNIFICANT_DELAYS');
        expect(detour._count).toBe(2);
        expect(detour._descriptions).toEqual(['Detour A.', 'Detour C.']);
        expect(delays._count).toBe(1);
        expect(delays._descriptions).toEqual(['Delays B.']);
    });

    it('handles missing / empty description gracefully (no empty strings in array)', () => {
        // Alerts without descriptions should not contribute an empty string —
        // _descriptions starts empty and stays empty.
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'NO_SERVICE', description: '' },
            { id: 'a-2', effect: 'NO_SERVICE' },  // no description field
            { id: 'a-3', effect: 'NO_SERVICE', description: '   ' },  // whitespace-only
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._count).toBe(3);
        expect(out[0]._descriptions).toEqual([]);
    });

    it('preserves alert metadata from the first alert seen per effect', () => {
        // Future-proofing: if downstream code reads a.id or a.header from the
        // deduped output, it should get the first alert's metadata, not the
        // last. The first one wins because it's spread first into the Map.
        const out = dedupeAlertsByEffect([
            { id: 'first',  effect: 'DETOUR', header: 'First',  description: 'Desc A.' },
            { id: 'second', effect: 'DETOUR', header: 'Second', description: 'Desc B.' },
        ]);
        expect(out[0].id).toBe('first');
        expect(out[0].header).toBe('First');
        expect(out[0]._descriptions).toEqual(['Desc A.', 'Desc B.']);
    });
});

describe('_isJLineOnly (zoom-gating classification)', () => {
    // buswayStation mirrors the flag set by addToRegistry from the stop name.
    const grp = (stopIds, routes, buswayStation = false) => ({ stopIds, routes: new Set(routes), buswayStation });

    it('gates a pure J Line street stop (950 only, no rail platform)', () => {
        // Pacific / 17th — San Pedro street-running, served only by 950.
        expect(_isJLineOnly(grp(['5397', '13804'], ['950']))).toBe(true);
    });

    it('gates a J Line surface street stop served by 910+950 (DTLA one-way corridor)', () => {
        // Figueroa / Pico — on-street, no dedicated busway; name has no
        // "Transitway"/"Station"/etc. so buswayStation is false.
        expect(_isJLineOnly(grp(['5041', '5049'], ['910', '950']))).toBe(true);
    });

    it('does NOT gate a J Line BRT busway station (Harbor Transitway, buswayStation=true)', () => {
        // Harbor Transitway / Rosecrans — dedicated busway infrastructure.
        // Name contains "Transitway" → buswayStation true → appears at overview
        // zoom like rail, so click target must use STATION_CLICK_MINZOOM.
        expect(_isJLineOnly(grp(['10846', '2321'], ['910', '950'], true))).toBe(false);
    });

    it('does NOT gate a J Line named BRT station (El Monte Station, buswayStation=true)', () => {
        expect(_isJLineOnly(grp(['30019'], ['910', '950'], true))).toBe(false);
    });

    it('does NOT gate a stop with a rail platform (8xxxxx) even if J Line also serves it', () => {
        // 7th St / Metro Center — J Line passes through a rail station; stays
        // clickable at overview zoom.
        expect(_isJLineOnly(grp(['80122', '10848'], ['910']))).toBe(false);
    });

    it('does NOT gate a G Line (901) busway station', () => {
        expect(_isJLineOnly(grp(['15568'], ['901']))).toBe(false);
    });

    it('does NOT gate a stop with no busway routes (plain rail group)', () => {
        expect(_isJLineOnly(grp(['80101'], []))).toBe(false);
    });

    it('does NOT gate a mixed J Line + G Line group (defensive — routes not all 910/950)', () => {
        expect(_isJLineOnly(grp(['99999'], ['901', '950']))).toBe(false);
    });

    it('does NOT gate Harbor Fwy / Carson — HOV-lane busway station south of Harbor Gateway TC', () => {
        // "Harbor Fwy" in stop name → buswayStation true (same HOV-lane infrastructure
        // as "Harbor Transitway" stops north of Harbor Gateway TC, just named differently).
        expect(_isJLineOnly(grp(['14073', '141080'], ['950'], true))).toBe(false);
    });

    it('does NOT gate Harbor Beacon Park and Ride — freeway P&R facility on the HOV lanes', () => {
        expect(_isJLineOnly(grp(['378', '3124'], ['950'], true))).toBe(false);
    });
});

describe('BRT_INFRA_NAME_RE — name-matching step that sets buswayStation', () => {
    // These tests exercise the regex directly so a regression in the pattern
    // (e.g. harbor\s+fwy → harbor\s+freeway) is caught independently of the
    // _isJLineOnly gate tests, which hardcode buswayStation=true.
    const yes = name => expect(BRT_INFRA_NAME_RE.test(name)).toBe(true);
    const no  = name => expect(BRT_INFRA_NAME_RE.test(name)).toBe(false);

    it('matches "Transitway" stops (Harbor Transitway / Rosecrans)', () => yes('Harbor Transitway / Rosecrans'));
    it('matches "Station" stops (El Monte Station, Cal State LA Busway Station)', () => {
        yes('El Monte Station - Upper Level');
        yes('Cal State LA Busway Station');
    });
    it('matches "Transit Center" stops (Harbor Gateway Transit Center)', () => yes('Harbor Gateway Transit Center'));
    it('matches "Harbor Fwy" HOV-lane stops south of Harbor Gateway TC', () => {
        yes('Harbor Fwy / Carson');
        yes('Harbor Fwy / Pacific Coast Highway');
    });
    it('matches "Park and Ride" facility stops (Harbor Beacon Park and Ride)', () => {
        yes('Harbor Beacon Park and Ride');
        yes('Harbor Beacon Park-and-Ride'); // hyphenated variant
    });
    it('does NOT match street-running J Line stops', () => {
        no('Figueroa / 23rd');
        no('Flower / Pico');
        no('Pacific / 17th');
        no('Figueroa / Washington');
    });
});

describe('_mergedPeriodLines — per-alert "Active:" attribution in merged banners', () => {
    // Unix helpers: LA is UTC-7 in June (PDT). Format output is pinned to
    // America/Los_Angeles by formatActivePeriodLine, so these are
    // deterministic regardless of host timezone.
    const t = (m, d, hUTC) => Math.floor(Date.UTC(2026, m, d, hUTC) / 1000);
    const pJun = { start: t(5, 10, 15), end: t(5, 30, 23) };   // Jun 10 8am – Jun 30 4pm PDT
    const pDec = { start: t(5, 11, 15), end: t(11, 31, 21) };  // Jun 11 8am – Dec 31 1pm PST

    it('single window (×1 banner, or all members share one window) → header only, no per-body lines', () => {
        const res = _mergedPeriodLines({
            activePeriod: pJun,
            _periods: [pJun, pJun],
        });
        expect(res.perBody).toBeNull();
        expect(res.header).toContain('Active:');
        expect(res.header).toContain('Jun 10');
        expect(res.header).toContain('Jun 30');
    });

    it('two distinct windows → each body gets its OWN line and NO header period (would be redundant/phantom)', () => {
        const res = _mergedPeriodLines({
            activePeriod: pJun,           // group-level = first alert's (legacy)
            _periods: [pJun, pDec],
        });
        // Per-body attribution — the ×2 banner bug: body 2 must show Dec 31,
        // not inherit body 1's June window.
        expect(res.perBody).toHaveLength(2);
        expect(res.perBody[0]).toContain('Jun 30');
        expect(res.perBody[1]).toContain('Dec 31');
        // No header period: the per-body lines are the complete story, and an
        // envelope here matched neither body (the phantom-third-window report).
        expect(res.header).toBe('');
    });

    it('a null period among distinct windows renders an empty line for that body only', () => {
        const res = _mergedPeriodLines({
            activePeriod: pJun,
            _periods: [pJun, null],
        });
        expect(res.perBody).toHaveLength(2);
        expect(res.perBody[0]).toContain('Jun 30');
        expect(res.perBody[1]).toBe('');
    });

    it('headers from the RENDERED description\'s period when the group\'s first alert had no body', () => {
        // Group = [A(desc:'', P_A), B(desc:'x', P_B)]. A's period seeds the
        // group-level activePeriod ({...a}) but contributes no body, so the
        // only visible paragraph is B's — the header must show B's window,
        // not invisibly attribute A's (audit fix, 2026-06-11).
        const t = (m, d, hUTC) => Math.floor(Date.UTC(2026, m, d, hUTC) / 1000);
        const pA = { start: t(5, 1, 15), end: t(5, 2, 15) };    // Jun 1–2
        const pB = { start: t(5, 10, 15), end: t(5, 30, 23) };  // Jun 10–30
        const merged = dedupeAlertsByEffect([
            { id: 'a', effect: 'DETOUR', description: '',   activePeriod: pA },
            { id: 'b', effect: 'DETOUR', description: 'x.', activePeriod: pB },
        ]);
        const res = _mergedPeriodLines(merged[0]);
        expect(res.perBody).toBeNull();          // one distinct window
        expect(res.header).toContain('Jun 10');  // B's window, not A's
        expect(res.header).not.toContain('Jun 1,');
    });

    it('degrades to empty header for a fully open-ended group (start 0, end Infinity)', () => {
        const res = _mergedPeriodLines({ activePeriod: null, _periods: [] });
        expect(res.perBody).toBeNull();
        expect(res.header).toBe('');
    });
});
