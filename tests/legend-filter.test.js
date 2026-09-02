/**
 * Legend route filter — side effects beyond the CSS class.
 *
 * The filter hides markers with a body class (`body.hide-route-<rc>`) and
 * nothing else. That is deliberate and cheap, but it means anything anchored to
 * the MAP rather than to the marker element survives the hide. A vehicle popup
 * is exactly that: MapLibre anchors it to a LngLat, so filtering a route left
 * its open popup floating over empty basemap, still ticking, still tracking a
 * dot the rider could no longer see (R8-04, confirmed in a real browser).
 *
 * The J Line pairing is the trap here: 910 and 950 share ONE legend row, so a
 * fix that compares raw route codes closes the 910 popup and leaves the 950
 * (San Pedro through-run) one open — the same class of bug the
 * `legendRouteFor` alias exists to prevent elsewhere.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _applyRowVisible } from '../js/ui.js';
import { setActivePopup, _resetActivePopup } from '../js/popups.js';

/** Minimal stand-in for a MapLibre marker with a popup, as markers.js builds it. */
function stubMarker(routeCode, { open = true } = {}) {
    const popup = { _open: open, isOpen: () => popup._open, remove: vi.fn(() => { popup._open = false; }) };
    return { properties: { route_code: routeCode }, getPopup: () => popup, _popup: popup };
}

function row() {
    const el = document.createElement('div');
    el.className = 'legend-row';
    return el;
}

beforeEach(() => {
    _resetActivePopup();
    document.body.className = '';
    window.vehicleMarkers = {};
});

describe('hiding a route closes that route\'s open vehicle popup', () => {
    it('closes it through the registry, not with a bare popup.remove()', () => {
        // Going through the registry is what runs the per-type teardown (the
        // _openVehiclePopups counter, follow-state cleanup). A bare remove()
        // drifts that counter — the documented marker-remove contract.
        const m = stubMarker('801');
        window.vehicleMarkers = { t1: m };
        const closeFn = vi.fn(() => { m._popup._open = false; });
        setActivePopup(closeFn, () => true);

        _applyRowVisible(row(), '801', false);

        expect(closeFn, 'must close via the registry close fn').toHaveBeenCalledTimes(1);
        expect(m._popup.remove, 'must not bypass the registry').not.toHaveBeenCalled();
    });

    it('leaves a popup for a route that is still visible alone', () => {
        window.vehicleMarkers = { t1: stubMarker('802') };
        const closeFn = vi.fn();
        setActivePopup(closeFn, () => true);
        _applyRowVisible(row(), '801', false);
        expect(closeFn).not.toHaveBeenCalled();
    });

    it('closes a 950 popup when the J row (910) is hidden', () => {
        // 950 has no legend row of its own; it rides the 910 row via
        // legendRouteFor. Comparing raw codes would miss it.
        window.vehicleMarkers = { t1: stubMarker('950') };
        const closeFn = vi.fn();
        setActivePopup(closeFn, () => true);
        _applyRowVisible(row(), '910', false);
        expect(closeFn, '950 rides the 910 legend row').toHaveBeenCalledTimes(1);
    });

    it('does nothing when the popup for that route is already closed', () => {
        window.vehicleMarkers = { t1: stubMarker('801', { open: false }) };
        const closeFn = vi.fn();
        setActivePopup(closeFn, () => true);
        _applyRowVisible(row(), '801', false);
        expect(closeFn).not.toHaveBeenCalled();
    });

    it('showing a route never closes anything', () => {
        window.vehicleMarkers = { t1: stubMarker('801') };
        const closeFn = vi.fn();
        setActivePopup(closeFn, () => true);
        _applyRowVisible(row(), '801', true);
        expect(closeFn).not.toHaveBeenCalled();
    });

    it('survives markers with no popup or no route_code', () => {
        window.vehicleMarkers = {
            a: { properties: {} },
            b: { properties: { route_code: '801' }, getPopup: () => null },
            c: stubMarker('801'),
        };
        const closeFn = vi.fn();
        setActivePopup(closeFn, () => true);
        expect(() => _applyRowVisible(row(), '801', false)).not.toThrow();
        expect(closeFn).toHaveBeenCalledTimes(1);
    });
});
