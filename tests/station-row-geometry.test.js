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
 * of the rider. _renderRailRouteBlocks now drops any row (live OR empty) whose
 * route+direction static stop sequence doesn't contain the station's stop, so a
 * route that can't physically reach a stop never renders a destination there.
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

// Build a routeMap with a live southbound (dir=1) arrival on BOTH 910 and 950.
const routeMapWithSbArrivals = () => new Map([
    ['910', { 0: [], 1: [{ tripId: 't910', arrivalUnix: NOW + 1200, atStop: false }] }],
    ['950', { 0: [], 1: [{ tripId: 't950', arrivalUnix: NOW + 1500, atStop: false }] }],
]);

describe('_renderRailRouteBlocks — geometric terminus guard', () => {
    it('drops a 910 (Harbor Gateway) southbound row at Carson, a 950-only stop south of Harbor Gateway', () => {
        const html = _renderRailRouteBlocks(routeMapWithSbArrivals(), ['14073'], [], NOW);
        // The geometrically impossible "southbound → Harbor Gateway" row is gone.
        expect(html).not.toContain('Harbor Gateway');
        // The real southbound service (950 → San Pedro) still renders.
        expect(html).toContain('San Pedro');
    });

    it('keeps the 910 southbound → Harbor Gateway row at Rosecrans, which 910 actually serves (north of Harbor Gateway)', () => {
        const html = _renderRailRouteBlocks(routeMapWithSbArrivals(), ['2321'], [], NOW);
        // Rosecrans is on 910's path, so the row is legitimate and must show.
        expect(html).toContain('Harbor Gateway');
        expect(html).toContain('San Pedro');
    });
});
