/**
 * Pins the map.js north-up lock contract (CLAUDE.md "Map is locked north-up"):
 * the map is a 2D transit overview — rotation/pitch are disabled at every
 * entry point, and because bearing is always 0, NO overlay in the codebase
 * does getBearing() counter-rotation. A one-line `dragRotate: true` (or a
 * re-added compass) would silently misalign every north-up overlay — the
 * boarding/departure pills, directional arrows, and the 8-cardinal
 * boarding-slot geometry — while the whole suite stayed green. This file is
 * the tripwire.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Minimal maplibregl mock ──────────────────────────────────────────────────
// Captures constructor options and the handler-disable calls; addControl
// records the control instances WITHOUT running their onAdd (the DOM side of
// the custom controls is not under test here).
class MockMap {
    constructor(opts) {
        this.opts = opts;
        this.touchZoomRotate = { disableRotation: vi.fn() };
        this.keyboard = { disableRotation: vi.fn() };
        this.controls = [];
    }
    addControl(control, position) { this.controls.push({ control, position }); return this; }
    on() { return this; }
    once() { return this; }
    getZoom() { return 10; }
    getLayer() { return undefined; }
    getSource() { return undefined; }
    addLayer() { return this; }
    addSource() { return this; }
    setStyle() { return this; }
    flyTo() { return this; }
}
class MockNavigationControl { constructor(opts) { this.opts = opts; } }
class MockAttributionControl { constructor(opts) { this.opts = opts; } }

let initMap;

beforeEach(async () => {
    vi.stubGlobal('maplibregl', {
        Map: MockMap,
        NavigationControl: MockNavigationControl,
        AttributionControl: MockAttributionControl,
    });
    ({ initMap } = await import('../js/map.js'));
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.classList.remove('dark-mode');
});

describe('initMap — north-up lock contract', () => {
    it('constructs the map with rotation and pitch disabled and bearing/pitch 0', () => {
        const map = initMap();
        expect(map.opts.dragRotate).toBe(false);
        expect(map.opts.touchPitch).toBe(false);
        expect(map.opts.bearing).toBe(0);
        expect(map.opts.pitch).toBe(0);
    });

    it('strips the rotation component from pinch-zoom and keyboard handlers', () => {
        const map = initMap();
        expect(map.touchZoomRotate.disableRotation).toHaveBeenCalledTimes(1);
        expect(map.keyboard.disableRotation).toHaveBeenCalledTimes(1);
    });

    it('adds the NavigationControl with NO compass (nothing to reset when rotation is locked)', () => {
        const map = initMap();
        const nav = map.controls.find(c => c.control instanceof MockNavigationControl);
        expect(nav).toBeDefined();
        expect(nav.control.opts.showCompass).toBe(false);
    });

    it('keeps the legally-required attribution via an explicit compact AttributionControl', () => {
        // attributionControl:false in the ctor is ONLY because an explicit
        // compact control is added — the © OSM / © CARTO credit must stay.
        const map = initMap();
        expect(map.opts.attributionControl).toBe(false);
        const attr = map.controls.find(c => c.control instanceof MockAttributionControl);
        expect(attr).toBeDefined();
        expect(attr.control.opts.compact).toBe(true);
        expect(attr.position).toBe('bottom-right');
    });

    it('bounds the camera to the LA service area (maxBounds present, SW < NE)', () => {
        const map = initMap();
        const [[swLng, swLat], [neLng, neLat]] = map.opts.maxBounds;
        expect(swLng).toBeLessThan(neLng);
        expect(swLat).toBeLessThan(neLat);
        // Sanity: downtown LA is inside the box.
        expect(swLat).toBeLessThan(34.05);
        expect(neLat).toBeGreaterThan(34.05);
        expect(swLng).toBeLessThan(-118.25);
        expect(neLng).toBeGreaterThan(-118.25);
    });

    it('no module in js/ counter-rotates against map bearing (bearing is always 0)', async () => {
        // CLAUDE.md: "no overlay needs getBearing() counter-rotation (there is
        // none in the codebase — keep it that way)." Enforce textually.
        const { readdirSync, readFileSync } = await import('node:fs');
        const offenders = readdirSync('js')
            .filter(f => f.endsWith('.js'))
            .filter(f => /getBearing\s*\(/.test(readFileSync(`js/${f}`, 'utf8')));
        expect(offenders).toEqual([]);
    });
});

describe('initMap — initial view contract (network centered on every screen shape)', () => {
    afterEach(() => {
        window.history.replaceState({}, '', '/');
    });

    it('default view fits the network extent via bounds, not a fixed center+zoom', () => {
        const map = initMap();
        expect(map.opts.center).toBeUndefined();
        expect(map.opts.zoom).toBeUndefined();
        const [[w, s], [e, n]] = map.opts.bounds;
        // Must cover the active network corners: G Line Chatsworth
        // (-118.60, 34.25), A Line Pomona (-117.75), A Line Long Beach /
        // J Line San Pedro (~33.73).
        expect(w).toBeLessThanOrEqual(-118.60);
        expect(e).toBeGreaterThanOrEqual(-117.75);
        expect(s).toBeLessThanOrEqual(33.73);
        expect(n).toBeGreaterThanOrEqual(34.25);
        expect(map.opts.fitBoundsOptions?.padding).toBeDefined();
    });

    it('pan-clamp box is centered on the network centroid (the soft-clamp recenter target)', () => {
        // maxBounds RECENTERS on its box center whenever the viewport outgrows
        // the box (every phone at zoom 8). If this box drifts north of the
        // network centroid again, phones get desert on top / network at the
        // bottom — the exact production bug this pins.
        const map = initMap();
        const [[w, s], [e, n]] = map.opts.maxBounds;
        const midLat = (s + n) / 2;
        const midLng = (w + e) / 2;
        expect(midLat).toBeGreaterThan(33.9);
        expect(midLat).toBeLessThan(34.1);
        expect(midLng).toBeGreaterThan(-118.3);
        expect(midLng).toBeLessThan(-118.0);
        // And it must still contain the whole fit extent (pan margin > 0).
        const [[fw, fs], [fe, fn]] = map.opts.bounds;
        expect(w).toBeLessThan(fw);
        expect(s).toBeLessThan(fs);
        expect(e).toBeGreaterThan(fe);
        expect(n).toBeGreaterThan(fn);
    });

    it('?zoom=N deep link keeps the fixed-center form with the zoom clamped to [8,20]', () => {
        window.history.replaceState({}, '', '/?zoom=22');
        const map = initMap();
        expect(map.opts.bounds).toBeUndefined();
        expect(map.opts.zoom).toBe(20);
        expect(Array.isArray(map.opts.center)).toBe(true);
    });
});
