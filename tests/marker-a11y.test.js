/**
 * Vehicle-marker accessibility: the accessible name, and the focus contract
 * around the popup's live refresh.
 *
 * These tests deliberately load the REAL vendored MapLibre bundle rather than
 * the simplified `maplibregl` stand-ins used by tests/marker-lifecycle.test.js
 * and friends. That is the whole point: both defects pinned here live in
 * MapLibre's own behaviour —
 *
 *   - `Marker.setPopup()` stamps `tabindex=0`, `role=button`,
 *     `aria-label="Map marker"` and a keypress handler on the element;
 *   - `Popup.setDOMContent()` (which `setHTML` calls) unconditionally runs
 *     `_focusFirstElement()`, dragging focus into the popup on every refresh.
 *
 * The existing mocks reproduce neither, so the suite was structurally incapable
 * of catching either one. Asserting against the real library is what makes
 * these regression-proof.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

let maplibregl;

beforeAll(() => {
    // jsdom lacks a few browser APIs the bundle touches at module scope. Stub
    // only what it needs to LOAD — Marker and Popup themselves are plain DOM.
    window.URL.createObjectURL ??= () => 'blob:stub';
    window.URL.revokeObjectURL ??= () => {};
    globalThis.URL.createObjectURL ??= window.URL.createObjectURL;
    window.matchMedia ??= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

    // Load the vendored UMD bundle into this jsdom realm, the way index.html's
    // <script> tag does. Canvas/WebGL are absent under jsdom, but Marker and
    // Popup are plain DOM classes and work without a live map.
    const src = readFileSync('vendor/maplibre-gl/maplibre-gl.js', 'utf8');
    new Function('window', 'document', 'self', `${src}\n;window.__mlgl = maplibregl;`)(
        globalThis.window, globalThis.document, globalThis.window,
    );
    maplibregl = globalThis.window.__mlgl;
    expect(maplibregl?.Marker, 'vendored MapLibre must expose Marker').toBeTruthy();
});

/**
 * Fake map for Marker/Popup attachment.
 *
 * Marker.addTo() and Popup.addTo() reach for a scattering of incidental map
 * internals (`_getUIString`, `loaded`, `transform.getCoveringTilesDetailsProvider`,
 * …) that have nothing to do with what is under test and that change between
 * MapLibre versions. Rather than chase each one — and re-chase them on every
 * vendor bump — unknown members resolve to no-op functions through a Proxy, so
 * the DOM behaviour we DO care about (attributes, focus) runs against the real
 * library while the rendering plumbing quietly does nothing.
 */
/** Chainable Point stand-in — MapLibre does `project(...)._add(...)` etc. */
function point(x = 0, y = 0) {
    const p = { x, y };
    for (const m of ['add', '_add', 'sub', '_sub', 'mult', '_mult', 'div', '_div',
                     'round', '_round', 'rotate', '_rotate', 'matMult', 'unit', 'perp']) {
        p[m] = () => p;
    }
    p.clone = () => point(p.x, p.y);
    return p;
}

function fakeMap() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const noop = () => undefined;
    const proxy = (base) => new Proxy(base, {
        get: (t, k) => (k in t ? t[k] : noop),
        has: () => true,
    });
    return proxy({
        getContainer: () => container,
        getCanvasContainer: () => container,
        _getUIString: (k) => String(k),
        loaded: () => true,
        project: () => point(0, 0),
        unproject: () => ({ lng: 0, lat: 0 }),
        getBearing: () => 0,
        getPitch: () => 0,
        on: noop, off: noop, once: noop,
        _requestDomTask: (fn) => fn(),
        // Unknown members of `transform` return a Point rather than undefined:
        // MapLibre chains `.locationPoint(...)._add(...)`-style calls through
        // several of them, so a bare no-op yields "cannot read '_add' of
        // undefined". Points are chainable, so any depth of chaining works.
        transform: new Proxy({
            locationPoint: () => point(0, 0),
            getCoveringTilesDetailsProvider: () => proxy({}),
        }, { get: (t, k) => (k in t ? t[k] : () => point(0, 0)), has: () => true }),
    });
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('MapLibre really does make markers focusable and generically named (the premise)', () => {
    it('stamps tabindex/role/aria-label when a popup is attached', () => {
        // Guards the guard: if a MapLibre upgrade ever stopped doing this, the
        // tests below would pass for the wrong reason and the docs would drift
        // back. docs/HANDOFF.md §5 asserted the opposite of this for months.
        const el = document.createElement('div');
        const marker = new maplibregl.Marker({ element: el })
            .setLngLat([-118, 34])
            .setPopup(new maplibregl.Popup().setHTML('<p>x</p>'))
            .addTo(fakeMap());
        expect(el.getAttribute('tabindex')).toBe('0');
        expect(el.getAttribute('role')).toBe('button');
        marker.remove();
    });

    it('does NOT overwrite an aria-label that is already set', () => {
        // This is what makes the fix possible at all: set the name before
        // addTo() and MapLibre leaves it alone.
        const el = document.createElement('div');
        el.setAttribute('aria-label', 'A Line train to Downtown Long Beach');
        new maplibregl.Marker({ element: el })
            .setLngLat([-118, 34])
            .setPopup(new maplibregl.Popup().setHTML('<p>x</p>'))
            .addTo(fakeMap());
        expect(el.getAttribute('aria-label')).toBe('A Line train to Downtown Long Beach');
    });
});

describe('vehicleAriaLabel — the accessible name riders hear (R6-02)', () => {
    let vehicleAriaLabel;
    beforeAll(async () => { ({ vehicleAriaLabel } = await import('../js/ui.js')); });

    beforeEach(() => {
        // resolveTripDestination has several tiers; the route-cache tier needs
        // initPredictions(), which these tests deliberately avoid — the subject
        // here is the LABEL, not destination resolution (that is R3a-01's
        // territory, in a later batch). Seeding `stops` + masterStopsData
        // exercises its last-stop tier, which is enough to prove the label
        // renders a destination when one is resolvable.
        window.masterTripsData = {
            't-a-0': { rc: '801', dir: 0, stops: ['80101', '80139'] },
            't-j':   { rc: '910', dir: 0, stops: ['15568', '80201'] },
        };
        window.masterStopsData = {
            80101: { name: 'Union Station', lat: 34, lon: -118 },
            80139: { name: 'Downtown Long Beach Station', lat: 33.7, lon: -118.1 },
            15568: { name: 'Harbor Gateway Transit Center', lat: 33.9, lon: -118.2 },
            80201: { name: 'El Monte Station', lat: 34.07, lon: -118.02 },
        };
    });

    it('names the line, the mode and where it is going', () => {
        const label = vehicleAriaLabel({ properties: { route_code: '801', direction_id: 0, trip_id: 't-a-0' } });
        expect(label).toMatch(/^A Line train to /);
        expect(label).not.toMatch(/Map marker/);
        // The middot from the search sublabel is a visual separator; spoken
        // aloud it is noise, so the marker name must not carry it.
        expect(label).not.toContain('·');
    });

    it('says "bus" for a BRT route', () => {
        const label = vehicleAriaLabel({ properties: { route_code: '910', direction_id: 0, trip_id: 't-j' } });
        expect(label).toMatch(/^J Line bus/);
    });

    it('degrades to the line alone rather than throwing before GTFS loads', () => {
        // Runs inside createNewMarker, on every cold start — a throw here would
        // abort marker creation for the whole frame.
        window.masterTripsData = undefined;
        expect(() => vehicleAriaLabel({ properties: { route_code: '801', direction_id: null, trip_id: 'x' } })).not.toThrow();
        expect(vehicleAriaLabel({ properties: { route_code: '801', direction_id: null, trip_id: 'x' } })).toMatch(/A Line/);
    });

    it('never returns the generic name, even with nothing to work from', () => {
        expect(vehicleAriaLabel({})).not.toMatch(/Map marker/);
        expect(vehicleAriaLabel(null)).not.toMatch(/Map marker/);
    });
});

describe('a popup refresh must not steal focus from the rest of the page (R6-01)', () => {
    /**
     * Reproduces the reported sequence with the real Popup: focus something
     * outside the popup (the search box), refresh the popup the way
     * updatePopup() does, and assert focus did not move.
     */
    function setHtmlPreservingFocus(popup, html) {
        // Mirrors the guard in markers.js updatePopup().
        const prevFocus = document.activeElement;
        popup.setHTML(html);
        const popupEl = popup.getElement();
        if (prevFocus && prevFocus !== document.body && prevFocus.isConnected
            && !popupEl?.contains(prevFocus) && document.activeElement !== prevFocus) {
            prevFocus.focus?.({ preventScroll: true });
        }
    }

    function openPopupWithButton() {
        const map = fakeMap();
        const popup = new maplibregl.Popup({ closeButton: false })
            .setLngLat([-118, 34])
            .setHTML('<button class="pv2-follow-btn">Follow</button>')
            .addTo(map);
        return popup;
    }

    it('MapLibre steals focus on a bare setHTML (the defect)', () => {
        // Pinning the mechanism, so the fix below is provably load-bearing
        // rather than defending against something that no longer happens.
        const search = document.createElement('input');
        search.id = 'station-search';
        document.body.appendChild(search);
        const popup = openPopupWithButton();
        search.focus();
        expect(document.activeElement).toBe(search);

        popup.setHTML('<button class="pv2-follow-btn">Follow</button>');
        expect(document.activeElement, 'MapLibre focuses the first element on every setHTML').not.toBe(search);
    });

    it('focus stays in the search box across a refresh', () => {
        const search = document.createElement('input');
        search.id = 'station-search';
        document.body.appendChild(search);
        const popup = openPopupWithButton();
        search.focus();

        setHtmlPreservingFocus(popup, '<button class="pv2-follow-btn">Follow</button>');
        expect(document.activeElement, 'a live update must not eject a keyboard rider').toBe(search);
    });

    it('survives repeated refreshes — the popup ticks every ~5 s while open', () => {
        const search = document.createElement('input');
        search.id = 'station-search';
        document.body.appendChild(search);
        const popup = openPopupWithButton();
        search.focus();
        for (let i = 0; i < 3; i++) setHtmlPreservingFocus(popup, `<button class="pv2-follow-btn">Follow ${i}</button>`);
        expect(document.activeElement).toBe(search);
    });

    it('leaves focus alone when the rider is genuinely inside the popup', () => {
        // Tabbing to Follow and having a refresh land: the element they were on
        // has just been replaced, so MapLibre's own focus is the right answer.
        const popup = openPopupWithButton();
        const btn = popup.getElement().querySelector('.pv2-follow-btn');
        btn.focus();
        expect(popup.getElement().contains(document.activeElement)).toBe(true);
        setHtmlPreservingFocus(popup, '<button class="pv2-follow-btn">Follow again</button>');
        expect(popup.getElement().contains(document.activeElement), 'focus should remain within the popup').toBe(true);
    });

    it('does not resurrect focus onto an element removed mid-refresh', () => {
        const doomed = document.createElement('input');
        document.body.appendChild(doomed);
        const popup = openPopupWithButton();
        doomed.focus();
        doomed.remove();               // e.g. the station popup was torn down
        expect(() => setHtmlPreservingFocus(popup, '<button>x</button>')).not.toThrow();
    });
});

describe('markers.js wires the label at creation and refreshes it (R6-02 wiring)', () => {
    // The helper being correct says nothing about it being CALLED — the class
    // of gap the review found three times over.
    const src = readFileSync('js/markers.js', 'utf8');

    it('sets aria-label before addTo() in createNewMarker', () => {
        const create = src.slice(src.indexOf('const el = document.createElement'), src.indexOf('.addTo(map)'));
        expect(create).toMatch(/setAttribute\('aria-label', vehicleAriaLabel\(/);
    });

    it('refreshes it on update, once the destination resolves', () => {
        const update = src.slice(src.indexOf('function updateExistingMarker'), src.indexOf('function updatePopup'));
        expect(update).toMatch(/setAttribute\('aria-label', vehicleAriaLabel\(/);
    });

    it('preserves focus around the popup rebuild', () => {
        const upd = src.slice(src.indexOf('function updatePopup'));
        expect(upd).toMatch(/const prevFocus = document\.activeElement/);
        expect(upd).toMatch(/prevFocus\.focus\?\.\(\{ preventScroll: true \}\)/);
    });
});
