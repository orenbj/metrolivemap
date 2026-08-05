/**
 * Coverage for the station popup's on-screen correction (`_keepPopupOnScreen`)
 * and the pan-on-expand wiring.
 *
 * These exist because EVERY bug this code has had was a SILENT-failure bug —
 * nothing threw, nothing looked wrong in a diff, the behaviour just quietly
 * stopped or quietly fired too often:
 *
 *  - PR #616 pinned the popup below the dot with `anchor: 'top'`, giving up
 *    MapLibre's auto-anchor, and added a map.panBy() to compensate. That panBy
 *    then fired on unpinned HOVER previews (grazing a station dot dragged the
 *    map) and cancelled the in-flight flyTo from a search-result click
 *    (leaving the map short of the station the rider just picked).
 *  - The pan-on-expand listener was bound to the <details>, which the ~5 s
 *    refresh destroys via replaceWith — so it worked exactly once, then never
 *    again.
 *  - Once delegated, it fired on the refresh's own `open = true` state
 *    restore, panning the rider's map back every 5 s.
 *
 * A stub map records panBy calls; a stub element supplies getBoundingClientRect.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/snap.js', () => ({
    snapToRoute: () => null, hasShapeData: () => false, resolveShapeKey: () => null,
}));
vi.mock('../js/tripUpdates.js', () => ({
    tripTerminusByTripId: new Map(),
    getTripUpdatesFeedHealth: () => ({}),   // popup renders a staleness banner from this
}));

import { _keepPopupOnScreen, openStationByGroup, closeStationPopup } from '../js/stations.js';

const VW = 1280, VH = 900;

/** Map stub: records panBy, and can pretend the camera is animating. */
function stubMap({ easing = false, moving = false } = {}) {
    return {
        panBy: vi.fn(),
        isEasing: () => easing,
        isMoving: () => moving,
        // showArrivalsPopup touches these on the integration path.
        getZoom: () => 14, getCenter: () => ({ lng: -118, lat: 34 }),
        on: vi.fn(), off: vi.fn(),
        // Records 'moveend' handlers so a test can land the camera.
        once: vi.fn(function (ev, fn) { (this._once[ev] ??= []).push(fn); }),
        _once: {},
        land() { (this._once.moveend ?? []).splice(0).forEach(fn => fn()); },
    };
}

/** Element stub with a fixed rect. */
const rectEl = (r) => ({
    getBoundingClientRect: () => ({
        top: 0, left: 0, right: 0, bottom: 0, width: 300, height: 200, ...r,
    }),
});

beforeEach(() => {
    globalThis.window = globalThis.window || {};
    window.innerWidth = VW;
    window.innerHeight = VH;
});

describe('_keepPopupOnScreen — geometry', () => {
    it('does nothing when the popup already fits', () => {
        const map = stubMap();
        _keepPopupOnScreen(map, rectEl({ top: 300, bottom: 500, left: 400, right: 700 }));
        expect(map.panBy).not.toHaveBeenCalled();
    });

    it('pans down by the overflow when the popup runs off the bottom', () => {
        const map = stubMap();
        // bottom 950 on a 900 viewport, 12px margin → shortfall 62.
        _keepPopupOnScreen(map, rectEl({ top: 600, bottom: 950, left: 400, right: 700 }));
        expect(map.panBy).toHaveBeenCalledTimes(1);
        expect(map.panBy.mock.calls[0][0]).toEqual([0, 62]);
    });

    it('pans horizontally when the popup runs off an edge', () => {
        const map = stubMap();
        _keepPopupOnScreen(map, rectEl({ top: 300, bottom: 500, left: -50, right: 250 }));
        expect(map.panBy.mock.calls[0][0]).toEqual([-62, 0]);
    });

    it('clamps to aligning the TOP when the popup is taller than the viewport', () => {
        const map = stubMap();
        // Taller than 900: pin the top at the 12px margin rather than chasing
        // the bottom, since the name + next arrivals are what matter.
        _keepPopupOnScreen(map, rectEl({ top: 200, bottom: 1400, height: 1200,
                                        left: 400, right: 700 }));
        expect(map.panBy.mock.calls[0][0]).toEqual([0, 188]);
    });

    it('is a no-op for a detached / unlaid-out element', () => {
        const map = stubMap();
        _keepPopupOnScreen(map, rectEl({ height: 0 }));
        _keepPopupOnScreen(map, null);
        expect(map.panBy).not.toHaveBeenCalled();
    });
});

describe('_keepPopupOnScreen — camera guard (the flyTo-abort regression)', () => {
    const overflowing = () => rectEl({ top: 600, bottom: 950, left: 400, right: 700 });

    it('does NOT pan while a flyTo/easing is in flight', () => {
        // js/ui.js calls map.flyTo(...) then opens the popup synchronously.
        // A panBy here cancels the flyTo and strands the map short of the
        // station the rider just searched for.
        const map = stubMap({ easing: true });
        _keepPopupOnScreen(map, overflowing());
        expect(map.panBy).not.toHaveBeenCalled();
    });

    it('does NOT pan while the map is otherwise moving', () => {
        const map = stubMap({ moving: true });
        _keepPopupOnScreen(map, overflowing());
        expect(map.panBy).not.toHaveBeenCalled();
    });

    it('pans once the camera is settled', () => {
        const map = stubMap();
        _keepPopupOnScreen(map, overflowing());
        expect(map.panBy).toHaveBeenCalledTimes(1);
    });

    it('tolerates a map without isEasing/isMoving', () => {
        const map = { panBy: vi.fn() };
        expect(() => _keepPopupOnScreen(map, overflowing())).not.toThrow();
        expect(map.panBy).toHaveBeenCalledTimes(1);
    });
});

/**
 * Integration: drive the real showArrivalsPopup through its exported entry
 * point with a stubbed global maplibregl, and assert the camera is only ever
 * moved for a PINNED popup.
 */
describe('showArrivalsPopup — only a pinned popup may move the camera', () => {
    let popupEl;

    beforeEach(() => {
        // MUST reset module state between cases. __hoverStationByGroup bails
        // early when a PINNED popup is already active, so without this the
        // hover test passes for the wrong reason — showArrivalsPopup is never
        // even reached, and deleting the `if (pinned)` gate keeps it green.
        // (Caught by mutation-testing this file.)
        closeStationPopup();
        document.body.innerHTML = '';
        popupEl = document.createElement('div');
        // Low on screen and overflowing, so a pan WOULD be warranted.
        popupEl.getBoundingClientRect = () => ({
            top: 600, bottom: 950, left: 400, right: 700, width: 300, height: 350,
        });
        document.body.appendChild(popupEl);

        class StubPopup {
            constructor() { this._handlers = {}; }
            setLngLat() { return this; }
            setHTML() { return this; }
            addTo() { return this; }
            getElement() { return popupEl; }
            on(ev, fn) { (this._handlers[ev] ??= []).push(fn); return this; }
            remove() { return this; }
        }
        globalThis.maplibregl = { Popup: StubPopup };

        window.masterArrivalsData = new Map();
        window.masterTripsData = {};
        window.masterStopsData = { 80139: { lat: 34, lon: -118, name: 'DTSM' } };
        window.masterAlertsData = new Map();
        window.masterStopAlertsData = new Map();
        window.masterStopAccessibilityAlertsData = new Map();
        window.masterBikeStations = new Map();
        window.vehicleMarkers = {};
        window.stationGroups = [];
    });

    const group = { lon: -118, lat: 34, stopIds: ['80139'], displayName: 'DTSM' };

    it('pans for a pinned popup opened by a tap or a search result', () => {
        const map = stubMap();
        openStationByGroup(map, group);
        expect(map.panBy).toHaveBeenCalledTimes(1);
    });

    it('does NOT pan for an unpinned hover preview', () => {
        // Grazing a station dot or a bike pin must never drag the map — the
        // preview then closes on pointer-out and the rider is left somewhere
        // they never asked to be.
        const map = stubMap();
        window.__hoverStationByGroup(map, group);
        expect(map.panBy).not.toHaveBeenCalled();
    });

    it('re-checks on expand via a DELEGATED listener, so it survives the 5 s refresh', () => {
        // The refresh does currentWrap.replaceWith(fresh), destroying the
        // original <details>. Delegation on the popup element is what keeps
        // pan-on-expand working past the first refresh tick.
        const map = stubMap();
        openStationByGroup(map, group);
        map.panBy.mockClear();

        // Simulate the post-refresh DOM: a BRAND NEW details element, i.e. not
        // the one that existed when the popup opened.
        const fresh = document.createElement('details');
        fresh.className = 'sp-bus-details';
        popupEl.appendChild(fresh);
        fresh.dispatchEvent(new Event('toggle'));

        return new Promise(resolve => requestAnimationFrame(() => {
            expect(map.panBy).toHaveBeenCalledTimes(1);
            resolve();
        }));
    });

    it('defers the correction instead of dropping it when opened mid-flyTo', () => {
        // js/ui.js flies to the searched station and opens the popup
        // synchronously, so the camera guard fires on exactly the case it was
        // written to protect. Returning early there left the pinned popup
        // off-screen with no correction ever applied.
        const map = stubMap({ easing: true });
        openStationByGroup(map, group);
        expect(map.panBy).not.toHaveBeenCalled();
        expect(map.once).toHaveBeenCalledWith('moveend', expect.any(Function));

        map.isEasing = () => false;
        map.isMoving = () => false;
        map.land();                       // flyTo finishes
        expect(map.panBy).toHaveBeenCalledTimes(1);
    });

    it('does NOT pan when the popup was closed mid-flight', () => {
        const map = stubMap({ easing: true });
        openStationByGroup(map, group);
        closeStationPopup();              // rider dismissed it while flying

        map.isEasing = () => false;
        map.isMoving = () => false;
        map.land();
        expect(map.panBy).not.toHaveBeenCalled();
    });

    it('registers only ONE retry however many times it is called', () => {
        // A <details> toggle can re-enter while the camera is still flying;
        // stacked handlers would pan once per call after it lands.
        const map = stubMap({ easing: true });
        openStationByGroup(map, group);
        const fresh = document.createElement('details');
        fresh.className = 'sp-bus-details';
        popupEl.appendChild(fresh);
        fresh.dispatchEvent(new Event('toggle'));

        return new Promise(resolve => requestAnimationFrame(() => {
            expect(map.once).toHaveBeenCalledTimes(1);
            map.isEasing = () => false;
            map.isMoving = () => false;
            map.land();
            expect(map.panBy).toHaveBeenCalledTimes(1);
            resolve();
        }));
    });

    it('ignores toggles from elements that are not the bus section', () => {
        const map = stubMap();
        openStationByGroup(map, group);
        map.panBy.mockClear();

        const banner = document.createElement('details');
        banner.className = 'sp-banner';           // an expanded service alert
        popupEl.appendChild(banner);
        banner.dispatchEvent(new Event('toggle'));

        return new Promise(resolve => requestAnimationFrame(() => {
            expect(map.panBy).not.toHaveBeenCalled();
            resolve();
        }));
    });
});
