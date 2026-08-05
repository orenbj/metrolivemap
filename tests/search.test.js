/**
 * Search: stations + live vehicles.
 *
 * Before this feature, search matched stations only and had NO jsdom coverage —
 * every path lived in closures inside `initUI`, so the only tested piece was the
 * `nextActiveIndex` arrow-key helper. The matcher and the landing action are now
 * exported and pinned here.
 *
 * Vehicles are matched on `vehicle_id`, which is the number physically printed
 * on the car (owner-confirmed) and the same number the vehicle popup shows as
 * "Train Car #…".
 *
 * The vehicle landing sequence has four ordering constraints, each of which is a
 * silent failure if broken — no throw, nothing odd in a diff:
 *   1. `mlm:camera-takeover` must fire BEFORE `toggleFollow`, or followVehicle's
 *      listener pauses the follow we just started.
 *   2. The route must be un-hidden BEFORE the fly, or the rider lands on an
 *      invisible dot and the follow aborts ~280 ms later.
 *   3. Popup + follow must wait for `moveend`, or the 280 ms follow chase fights
 *      the in-flight flyTo.
 *   4. The marker must be RE-RESOLVED after the flight — trip_ids are reassigned
 *      mid-run, so a key captured at render time can be stale.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock factories are hoisted above module-level consts, so the shared
// fixture array must be created with vi.hoisted or the factory throws.
const { groups } = vi.hoisted(() => ({ groups: [] }));
vi.mock('../js/stations.js', () => ({
    stationGroups: groups,
    openStationByGroup: vi.fn(),
    closeStationPopup: vi.fn(),
}));
vi.mock('../js/followVehicle.js', () => ({
    toggleFollow: vi.fn(),
    isFollowingKey: vi.fn(() => false),
}));
vi.mock('../js/predictions.js', () => ({
    resolveTripDestination: () => 'Downtown Long Beach',
}));

import { matchSearch, findMarkerByVehicleId, ensureRouteVisible, initUI } from '../js/ui.js';
import { openStationByGroup } from '../js/stations.js';
import { toggleFollow, isFollowingKey } from '../js/followVehicle.js';

const NOW = 1_700_000_000;

/** Minimal marker double: only what the matcher and landing action touch. */
function vehicle(vehicleId, routeCode = '801', extra = {}) {
    return {
        properties: {
            vehicle_id: vehicleId, route_code: routeCode,
            trip_id: extra.tripId ?? `trip-${vehicleId}`,
            direction_id: 0,
        },
        // getFreshnessTier reads the receipt clock; default to "just heard from".
        _lastAcceptedWallMs: (extra.ageSec != null ? NOW - extra.ageSec : NOW) * 1000,
        timestamp: NOW,
        getLngLat: () => ({ lng: -118.25, lat: 34.05 }),
        getPopup: () => extra.popup ?? null,
        togglePopup: extra.togglePopup ?? vi.fn(),
        ...extra.markerProps,
    };
}

const station = (displayName, normName = displayName.toLowerCase()) =>
    ({ displayName, normName, lat: 34, lon: -118 });

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    groups.length = 0;
    window.vehicleMarkers = {};
    document.body.className = '';
});

describe('matchSearch — vehicles', () => {
    it('finds a vehicle by the car number printed on it', () => {
        const markers = { t1: vehicle('1234') };
        const { results } = matchSearch('1234', { markers, nowSec: NOW });
        expect(results).toHaveLength(1);
        expect(results[0].kind).toBe('vehicle');
        expect(results[0].label).toBe('Train Car #1234');
    });

    it('ranks an EXACT car-number hit above a station whose name contains it', () => {
        groups.push(station('17th Street / SMC'));
        const markers = { t1: vehicle('17') };
        const { results } = matchSearch('17', { groups, markers, nowSec: NOW });
        expect(results[0].kind).toBe('vehicle');
        expect(results[1].kind).toBe('station');
    });

    it('still ranks stations first for an ordinary name query', () => {
        groups.push(station('Union Station'));
        const markers = { t1: vehicle('9union9') };
        const { results } = matchSearch('union', { groups, markers, nowSec: NOW });
        expect(results[0].kind).toBe('station');
    });

    it('returns BOTH vehicles when one number exists on two routes', () => {
        // vehicle ids are unique only within a mode — a rail car and a BRT coach
        // can share one, so the UI must offer both rather than pick.
        const markers = { a: vehicle('55', '801'), b: vehicle('55', '910') };
        const { results } = matchSearch('55', { markers, nowSec: NOW });
        expect(results).toHaveLength(2);
        expect(results.map(r => r.routeCode).sort()).toEqual(['801', '910']);
    });

    it('skips markers that have no vehicle_id yet', () => {
        const markers = { t1: vehicle(null), t2: vehicle('1234') };
        const { results } = matchSearch('1', { markers, nowSec: NOW });
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('1234');
    });

    it('skips an EXPIRED marker (it is about to be faded and removed)', () => {
        const markers = { t1: vehicle('1234', '801', { ageSec: 9999 }) };
        expect(matchSearch('1234', { markers, nowSec: NOW }).results).toEqual([]);
    });

    it('still matches a vehicle whose route is hidden by the legend filter', () => {
        // Excluding it would tell a rider "not found" for a train that is
        // plainly running; ensureRouteVisible un-hides it on select instead.
        document.body.classList.add('hide-route-801');
        const markers = { t1: vehicle('1234', '801') };
        expect(matchSearch('1234', { markers, nowSec: NOW }).results).toHaveLength(1);
    });

    it('caps results and reports the overflow', () => {
        const markers = {};
        for (let i = 0; i < 9; i++) markers[`t${i}`] = vehicle(`90${i}`);
        const { results, overflow } = matchSearch('90', { markers, nowSec: NOW });
        expect(results).toHaveLength(5);
        expect(overflow).toBe(4);
    });

    it('returns nothing for an empty query', () => {
        groups.push(station('Union Station'));
        expect(matchSearch('   ', { groups, markers: {}, nowSec: NOW }).results).toEqual([]);
    });
});

describe('findMarkerByVehicleId', () => {
    it('scopes by route so a rail car and a BRT coach sharing an id do not collide', () => {
        window.vehicleMarkers = { a: vehicle('55', '801'), b: vehicle('55', '910') };
        expect(findMarkerByVehicleId('55', '910').properties.route_code).toBe('910');
    });

    it('returns null for a vehicle that has left the feed', () => {
        window.vehicleMarkers = {};
        expect(findMarkerByVehicleId('55', '801')).toBeNull();
    });
});

describe('ensureRouteVisible', () => {
    it('is a no-op when no legend filter is active', () => {
        expect(ensureRouteVisible('801')).toBe(false);
    });
});

/** Drives the real search UI with the index.html markup and a stub map. */
describe('search UI — vehicle landing sequence', () => {
    let map, order, togglePopup, popup;

    const stubMap = () => ({
        flyTo: vi.fn(() => order.push('flyTo')),
        panBy: vi.fn(), isEasing: () => false, isMoving: () => false,
        getZoom: () => 14, getCenter: () => ({ lng: -118, lat: 34 }),
        on: vi.fn(), off: vi.fn(),
        once: vi.fn(function (ev, fn) { (this._once[ev] ??= []).push(fn); }),
        _once: {},
        land() { (this._once.moveend ?? []).splice(0).forEach(fn => fn()); },
    });

    const type = (q) => {
        const input = document.getElementById('station-search');
        input.value = q;
        input.dispatchEvent(new Event('input'));
    };
    const clickFirstOption = () => {
        const opt = document.querySelector('#search-results [role="option"]');
        opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return opt;
    };

    beforeEach(() => {
        order = [];
        document.body.innerHTML = `
            <input id="station-search" role="combobox" aria-expanded="false">
            <button id="search-clear-btn"></button>
            <div id="search-results" class="hidden" role="listbox"></div>
            <span id="search-announce"></span>
            <div id="legend">
              <div class="legend-row" data-route="801"><img alt="A Line icon"></div>
              <div class="legend-row" data-route="802"><img alt="B Line icon"></div>
            </div>`;
        document.addEventListener('mlm:camera-takeover', () => order.push('takeover'));
        toggleFollow.mockImplementation(() => order.push('toggleFollow'));
        popup = { isOpen: () => false };
        togglePopup = vi.fn(() => order.push('togglePopup'));
        map = stubMap();
        window.map = map;
        window.vehicleMarkers = {
            t1: vehicle('1234', '801', { popup, togglePopup }),
        };
        initUI();
    });

    it('renders a vehicle row with its car number and route badge', () => {
        type('1234');
        const opt = document.querySelector('#search-results [role="option"]');
        expect(opt.getAttribute('data-kind')).toBe('vehicle');
        expect(opt.getAttribute('data-id')).toBe('1234');
        expect(opt.textContent).toContain('Train Car #1234');
    });

    it('flies to the vehicle, then follows it only after the camera lands', () => {
        type('1234');
        clickFirstOption();
        // Follow must NOT have started yet — it would fight the in-flight flyTo.
        expect(map.flyTo).toHaveBeenCalledTimes(1);
        expect(toggleFollow).not.toHaveBeenCalled();

        map.land();
        expect(togglePopup).toHaveBeenCalledTimes(1);
        expect(toggleFollow).toHaveBeenCalledWith('trip-1234');
        // Camera takeover must precede the follow, or followVehicle pauses it.
        // Assert it FIRED before comparing positions: indexOf returns -1 when
        // absent, and -1 < anything, so an order-only check passes when the
        // event is missing entirely. (Caught by mutation-testing this file.)
        expect(order).toContain('takeover');
        expect(order).toContain('toggleFollow');
        expect(order.indexOf('takeover')).toBeLessThan(order.indexOf('toggleFollow'));
    });

    it('does NOT un-follow a vehicle that is already being followed', () => {
        isFollowingKey.mockReturnValue(true);
        type('1234');
        clickFirstOption();
        map.land();
        expect(toggleFollow).not.toHaveBeenCalled();
    });

    it('re-resolves the marker after the flight, and reports one that vanished', () => {
        type('1234');
        clickFirstOption();
        window.vehicleMarkers = {};       // trip reassigned / went out of service
        map.land();
        expect(togglePopup).not.toHaveBeenCalled();
        expect(toggleFollow).not.toHaveBeenCalled();
    });

    it('does not move the camera for a vehicle already gone at click time', () => {
        type('1234');
        window.vehicleMarkers = {};
        clickFirstOption();
        expect(map.flyTo).not.toHaveBeenCalled();
    });

    it('un-hides a route the rider had filtered out, so the dot is visible on arrival', () => {
        // Entering filter mode on the B Line hides the A Line. Landing on an
        // A Line car would otherwise fly to an invisible dot AND followVehicle
        // would abort ~280 ms later with "that route is now hidden".
        document.querySelector('.legend-row[data-route="802"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(document.body.classList.contains('hide-route-801')).toBe(true);

        type('1234');                       // an 801 vehicle
        clickFirstOption();
        expect(document.body.classList.contains('hide-route-801')).toBe(false);
        // The legend row must agree with the map, not just the body class.
        expect(document.querySelector('.legend-row[data-route="801"]')
            .getAttribute('aria-checked')).toBe('true');
    });

    it('leaves the station path unchanged', () => {
        groups.push(station('Union Station', 'union station'));
        type('union');
        clickFirstOption();
        expect(openStationByGroup).toHaveBeenCalledTimes(1);
        expect(map.flyTo).toHaveBeenCalledTimes(1);
        expect(toggleFollow).not.toHaveBeenCalled();
    });

    it('announces result counts to screen readers', () => {
        type('1234');
        expect(document.getElementById('search-announce').textContent).toContain('1 result');
        type('zzzzzz');
        expect(document.getElementById('search-announce').textContent).toBe('No matches');
    });
});
