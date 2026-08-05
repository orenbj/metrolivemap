/**
 * Regression for the J Line "wrong-side terminus" station-popup bug.
 *
 * The J Line is two overlaid routes sharing the letter "J": 910 (El Monte ⟷
 * Harbor Gateway, terminates there) and 950 (El Monte ⟷ San Pedro, through-runs
 * past Harbor Gateway). Direction (N/S) and terminus come verbatim from the
 * feed and are NOT sanity-checked against geometry.
 *
 * During a detour the feed reported a 910 (Harbor-Gateway-bound) arrival at
 * Harbor Fwy / Carson — a 950-only stop SOUTH of Harbor Gateway. The popup
 * rendered "Harbor Gateway TC · S": a southbound bus heading to a place NORTH
 * of the rider.
 *
 * _renderRailRouteBlocks now RE-ATTRIBUTES such an off-route arrival onto the
 * same-line route that actually serves the stop in that direction (950 → San
 * Pedro at Carson), so the rider keeps the arrival time under the only
 * destination that direction can physically reach. When no same-line route
 * serves the stop (or the choice is ambiguous), the arrival is left off-route
 * and the geometric guard suppresses the impossible row instead.
 */

import { describe, it, expect, vi } from 'vitest';

// Static (route|dir) stop sequences, mirroring data/trips.json: 910 terminates
// at Harbor Gateway and never serves Carson (14073); 950 through-runs and does.
const CACHE = {
    '910|0': { stops: ['30005', '2321', '30019'] },           // SB→NB to El Monte (no Carson)
    '910|1': { stops: ['30019', '2321', '30005'] },           // NB→SB to Harbor Gateway (no Carson)
    '950|0': { stops: ['141012', '14073', '2321', '30019'] }, // San Pedro → El Monte (has Carson)
    '950|1': { stops: ['30019', '2321', '14073', '141012'] }, // El Monte → San Pedro (has Carson)
};

vi.mock('../js/predictions.js', () => ({
    getScheduledArrivals: () => [],
    getBoardingVehicles: () => [],
    getRouteCache: (rc, dir) => CACHE[`${rc}|${dir}`],
    getTerminalName: (rc, dir) =>
        rc === '910' ? (dir === 1 ? 'Harbor Gateway TC' : 'El Monte')
                     : (dir === 1 ? 'San Pedro' : 'El Monte'),
    // Northbound (dir 0) → El Monte for both routes (the shared direction that
    // the merged block collapses); southbound (dir 1) splits 910→HGTC, 950→SP.
    resolveTripDestination: (rc, dir, _tid, _info, _cleaned) =>
        dir === 0 ? 'El Monte' : (rc === '910' ? 'Harbor Gateway TC' : 'San Pedro'),
    isOriginStop: () => false,
    isTerminalStop: () => false,
    isNearTerminalStop: () => false,
}));

import { _renderRailRouteBlocks } from '../js/stations.js';

const NOW = 1_700_000_000;

// renderRow looks up masterTripsData[tripId]; leave empty so tripInfo is
// undefined and the resolveTripDestination mock supplies the label.
globalThis.window = globalThis.window || {};
window.masterTripsData = {};

// A live southbound (dir=1) arrival tagged to route 910, with 950 present but
// empty — mirrors the real Carson feed where only the 910-tagged time existed.
const routeMapWith910SbArrival = () => new Map([
    ['910', { 0: [], 1: [{ tripId: 't910', arrivalUnix: NOW + 1200, atStop: false }] }],
    ['950', { 0: [], 1: [] }],
]);

describe('_renderRailRouteBlocks — geometric terminus guard + re-attribution', () => {
    it('re-attributes a 910 (Harbor Gateway) southbound arrival at Carson onto the 950 → San Pedro row', () => {
        const html = _renderRailRouteBlocks(routeMapWith910SbArrival(), ['14073'], [], NOW);
        // The geometrically impossible "southbound → Harbor Gateway" row is gone.
        expect(html).not.toContain('Harbor Gateway');
        // …but the arrival TIME is preserved under San Pedro (not dropped, not "—").
        expect(html).toContain('San Pedro');
        expect(html).toContain('arr-time-pill');
    });

    it('keeps the 910 southbound → Harbor Gateway row at Rosecrans, which 910 actually serves (north of Harbor Gateway)', () => {
        const html = _renderRailRouteBlocks(routeMapWith910SbArrival(), ['2321'], [], NOW);
        // Rosecrans is on 910's path, so the arrival is legit and shows as-is.
        expect(html).toContain('Harbor Gateway');
        expect(html).toContain('arr-time-pill');
    });

    it('drops an off-route arrival when NO same-line route serves the stop (re-attribution impossible)', () => {
        // Stop 99999 is in neither 910 nor 950's sequence — nothing to move the
        // arrival onto, so the geometric guard suppresses the impossible row.
        const html = _renderRailRouteBlocks(routeMapWith910SbArrival(), ['99999'], [], NOW);
        expect(html).not.toContain('Harbor Gateway');
        expect(html).not.toContain('arr-time-pill');
    });
});

describe('_renderRailRouteBlocks — merged J Line block (910 + 950 → one section)', () => {
    // Rosecrans (2321) is north of Harbor Gateway: both routes serve it. NB both
    // head to El Monte; SB splits 910→Harbor Gateway TC, 950→San Pedro.
    const rosecransBothRoutes = () => new Map([
        ['910', { 0: [{ tripId: 'n910', arrivalUnix: NOW + 300 }], 1: [{ tripId: 's910', arrivalUnix: NOW + 600 }] }],
        ['950', { 0: [{ tripId: 'n950', arrivalUnix: NOW + 480 }], 1: [{ tripId: 's950', arrivalUnix: NOW + 900 }] }],
    ]);
    const count = (html, re) => (html.match(re) || []).length;

    it('renders 910 + 950 as a SINGLE .sp-route block with one J icon', () => {
        const html = _renderRailRouteBlocks(rosecransBothRoutes(), ['2321'], [], NOW);
        expect(count(html, /class="sp-route"/g)).toBe(1);
        expect(count(html, /sp-route-icon/g)).toBe(1);
    });

    it('collapses the shared El Monte northbound direction into ONE row (no duplicate)', () => {
        const html = _renderRailRouteBlocks(rosecransBothRoutes(), ['2321'], [], NOW);
        expect(count(html, /El Monte/g)).toBe(1);
        // El Monte row combines both NB times (2 pills) + 1 each for HGTC & SP = 4.
        expect(count(html, /arr-time-pill/g)).toBe(4);
    });

    it('keeps BOTH southbound destinations as distinct rows (Harbor Gateway 910 + San Pedro 950)', () => {
        const html = _renderRailRouteBlocks(rosecransBothRoutes(), ['2321'], [], NOW);
        expect(html).toContain('Harbor Gateway TC');
        expect(html).toContain('San Pedro');
    });

    it('shows the San Pedro southbound row even with NO live 950 arrival (north of Harbor Gateway)', () => {
        // 910 has SB data, 950 southbound is empty — San Pedro must still appear.
        const map = new Map([
            ['910', { 0: [], 1: [{ tripId: 's910', arrivalUnix: NOW + 600 }] }],
            ['950', { 0: [], 1: [] }],
        ]);
        const html = _renderRailRouteBlocks(map, ['2321'], [], NOW);
        expect(html).toContain('San Pedro');
        expect(html).toContain('Harbor Gateway TC');
        expect(count(html, /class="sp-route"/g)).toBe(1);
    });
});
