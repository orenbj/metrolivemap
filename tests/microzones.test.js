/**
 * Tests for js/microzones.js — popup-contract stable-reference invariant.
 *
 * CLAUDE.md invariant: "any new popup type MUST use a stable fn reference in
 * both setActivePopup and notifyPopupClosed".  In microzones.js this means
 * _closeMicroPopup (a module-level function) is the value passed to BOTH
 * setActivePopup (immediately after creating the popup) and notifyPopupClosed
 * (inside the popup's 'close' event handler).  If the caller ever switches to
 * a fresh lambda for one of the two calls, the identity guard in popups.js
 * breaks and overlapping-tooltip bugs re-appear.
 *
 * Two test strategies run in the same file:
 *
 *   1. Static-source assertion — grep the module source for the exact call-
 *      site text.  Fragile against refactors that preserve semantics but
 *      rename things; robust against JSDOM import failures.
 *
 *   2. Runtime integration test — actually loads microzones.js (with mocked
 *      dependencies) and fires a map 'click' event to verify that the fn
 *      reference captured by setActivePopup === the one later passed to
 *      notifyPopupClosed when the popup 'close' fires.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

// ─── Static-source assertions ────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const src   = readFileSync(resolve(__dir, '../js/microzones.js'), 'utf8');

describe('microzones — stable-reference static-source pins', () => {
    it('setActivePopup is called with the stable _closeMicroPopup reference (not a lambda)', () => {
        // The close fn (first arg) must be the stable module-level reference —
        // catches accidental "setActivePopup(() => …)". A pinned predicate may
        // follow as the second arg.
        expect(src).toMatch(/setActivePopup\(_closeMicroPopup\b/);
    });

    it('notifyPopupClosed is called with _closeMicroPopup (not a lambda)', () => {
        expect(src).toContain('notifyPopupClosed(_closeMicroPopup)');
    });

    it('_closeMicroPopup is a module-level named function (not a const arrow)', () => {
        // Stable reference requires it to be declared as `function _closeMicroPopup`
        // (or reassigned at module scope).  An arrow stored in `const` at block scope
        // would create a new closure each time and break identity checks.
        expect(src).toMatch(/^function _closeMicroPopup\b/m);
    });
});

// ─── Runtime integration test ─────────────────────────────────────────────────

// Capture setActivePopup / notifyPopupClosed calls before the module loads
const _seenOpen  = [];
const _seenClose = [];

vi.mock('../js/popups.js', () => ({
    setActivePopup:    vi.fn(fn => _seenOpen.push(fn)),
    notifyPopupClosed: vi.fn(fn => _seenClose.push(fn)),
}));

// Minimal maplibregl.Popup mock — capture the 'close' handler so we can
// fire it synthetically.
let _popupCloseHandler = null;
const mockPopupInstance = {
    setLngLat: vi.fn().mockReturnThis(),
    setHTML:   vi.fn().mockReturnThis(),
    addTo:     vi.fn().mockReturnThis(),
    on:        vi.fn((event, cb) => {
        if (event === 'close') _popupCloseHandler = cb;
        return mockPopupInstance;
    }),
    remove: vi.fn(),
};
global.maplibregl = { Popup: vi.fn(() => mockPopupInstance) };

// Silence fetch — initMicroZones always fetches GeoJSON on first call.
global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ type: 'FeatureCollection', features: [
        { id: 0, type: 'Feature',
          geometry: { type: 'Polygon', coordinates: [[[-118.24, 34.05], [-118.23, 34.05], [-118.23, 34.06], [-118.24, 34.06], [-118.24, 34.05]]] },
          properties: { Name: 'Test Zone', hours: '8am–8pm' } },
    ] }),
});

/**
 * Build a minimal MapLibre-like map object that records event listeners.
 * The handler store uses `event:layer` keys so tests can look up and invoke them.
 */
function makeMap() {
    const _handlers = {};
    return {
        on(event, layerOrCb, cb) {
            const key = cb ? `${event}:${layerOrCb}` : event;
            _handlers[key] = cb ?? layerOrCb;
        },
        queryRenderedFeatures: vi.fn(() => []),
        getCanvas:    ()   => ({ style: {} }),
        setFeatureState: vi.fn(),
        getFeatureState: vi.fn(() => ({})),
        addSource:    vi.fn(),
        addLayer:     vi.fn(),
        getSource:    vi.fn(() => null),
        getLayer:     vi.fn(() => null),
        setLayoutProperty: vi.fn(),
        setPaintProperty:  vi.fn(),
        _handlers,
    };
}

// document.getElementById returns null by default (jsdom doesn't have our HTML);
// that's fine — microzones.js guards every getElementById call with `if (row)`.

import { initMicroZones } from '../js/microzones.js';

describe('microzones — popup-contract stable-reference (runtime)', () => {
    beforeEach(() => {
        _seenOpen.length  = 0;
        _seenClose.length = 0;
        _popupCloseHandler = null;
        vi.clearAllMocks();
        // Restore the Popup mock after clearAllMocks (which resets .mockReturnThis)
        mockPopupInstance.setLngLat.mockReturnThis();
        mockPopupInstance.setHTML.mockReturnThis();
        mockPopupInstance.addTo.mockReturnThis();
        mockPopupInstance.on.mockImplementation((event, cb) => {
            if (event === 'close') _popupCloseHandler = cb;
            return mockPopupInstance;
        });
        global.maplibregl = { Popup: vi.fn(() => mockPopupInstance) };
    });

    it('setActivePopup and notifyPopupClosed receive the same fn reference', async () => {
        const map = makeMap();
        await initMicroZones(map);

        // Simulate a click on the hover layer
        const clickHandler = map._handlers['click:micro-zones-hover'];
        // Assert registration rather than silently returning — a missing handler
        // means _attachListeners never ran and the runtime contract is untested.
        expect(clickHandler, 'click:micro-zones-hover handler must be registered').toBeTruthy();

        clickHandler({
            lngLat: { lng: -118.24, lat: 34.05 },
            point:  {},
            features: [{ id: 0, properties: { Name: 'Test Zone', hours: '8am–8pm' } }],
        });

        // setActivePopup must have been called with the stable closer
        expect(_seenOpen).toHaveLength(1);

        // Fire the popup 'close' event (simulates × button or map-click dismiss)
        if (_popupCloseHandler) _popupCloseHandler();
        expect(_seenClose).toHaveLength(1);

        // The CRITICAL invariant: same function reference for both calls
        expect(_seenOpen[0]).toBe(_seenClose[0]);
    });
});
