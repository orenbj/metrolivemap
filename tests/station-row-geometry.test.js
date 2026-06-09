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
    resolveTripDestination: (rc, _dir, _tid, _info, _cleaned) =>
        rc === '910' ? 'Harbor Gateway TC' : 'San Pedro',
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
