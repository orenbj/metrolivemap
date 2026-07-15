/**
 * Pins STATUS.md's now-resolved "Deferred design decisions" item #2 ("Two
 * popup-refresh tickers (1s + 5s)"): markers.js used to register two
 * independent setVisibleInterval callbacks (1000ms age-text/tier-dot patch,
 * 5000ms full popup rebuild). They're now ONE setVisibleInterval(fn, 1000)
 * that does the 1s work every tick and, via a module-level tick counter,
 * also does the 5s work (updatePopup rebuild) on every 5th tick.
 *
 * This drives a REAL vehicle popup open (cold-start spawn via
 * processVehicleData, with a minimal maplibregl.Marker/Popup mock — no test
 * in the suite exercises that spawn path yet, see the note in
 * marker-lifecycle.test.js's cross-line-guard describe block) and asserts
 * both cadences fire at their original frequencies with no behavior change:
 * the age text updates every second, but the full rebuild (getPopupHTML
 * called again) only happens on the 5th tick.
 *
 * markers.js registers its ticker at MODULE TOP LEVEL, so the module must be
 * imported (dynamically, after vi.useFakeTimers() + vi.resetModules()) for
 * that setInterval to be created under the fake-timer clock — a static
 * top-of-file import would register it against the real clock before fake
 * timers exist, and vi.advanceTimersByTime would never fire it.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';

// getPopupHTML is mocked so the test controls exactly what a "full rebuild"
// writes, and can prove a rebuild happened via a call counter baked into the
// markup (a `data-rebuild-seq` the 1s-only DOM patch never touches).
let popupHtmlCallCount = 0;
vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), initUI: vi.fn(),
    removeLoadingScreen: vi.fn(), setConnectionStatus: vi.fn(),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    getPopupHTML: vi.fn((opts) => {
        popupHtmlCallCount++;
        return (
            `<div class="pv2-time" data-ts="${opts.timestamp}">` +
            `<span class="pv2-secs">0s ago</span>` +
            `<span class="pv2-dot" role="img" data-tier="live"></span>` +
            `</div>` +
            `<span class="pv2-rebuild-seq" data-seq="${popupHtmlCallCount}"></span>`
        );
    }),
}));

// Minimal maplibregl.Marker/Popup mock — just enough surface for
// createNewMarker's cold-start spawn (setLngLat/setPopup/addTo chain,
// setRotation, getPopup/togglePopup/remove) and the popup lifecycle
// (setHTML/on/getElement/isOpen/remove). The popup's element is attached to
// document.body on creation — mirroring a real MapLibre popup once open —
// so the ticker's global `document.querySelectorAll('.pv2-time[data-ts]')`
// scan finds it.
function installMaplibreMock() {
    class MockPopup {
        constructor() {
            this._el = document.createElement('div');
            document.body.appendChild(this._el);
            this._handlers = {};
            this._open = false;
        }
        setHTML(html) { this._el.innerHTML = html; return this; }
        on(evt, cb) { (this._handlers[evt] ??= []).push(cb); return this; }
        getElement() { return this._el; }
        isOpen() { return this._open; }
        remove() {
            if (!this._open) return this;
            this._open = false;
            (this._handlers.close ?? []).forEach(cb => cb());
            return this;
        }
        _fireOpen() {
            this._open = true;
            (this._handlers.open ?? []).forEach(cb => cb());
        }
    }
    class MockMarker {
        constructor() { this._popup = null; this._lngLat = [0, 0]; }
        setLngLat(ll) { this._lngLat = ll; return this; }
        getLngLat() { return { lng: this._lngLat[0], lat: this._lngLat[1] }; }
        setPopup(p) { this._popup = p; return this; }
        getPopup() { return this._popup; }
        addTo() { return this; }
        setRotation() { return this; }
        getElement() { return document.createElement('div'); }
        togglePopup() {
            if (!this._popup) return;
            if (this._popup.isOpen()) this._popup.remove();
            else this._popup._fireOpen();
        }
        remove() {}
    }
    vi.stubGlobal('maplibregl', { Marker: MockMarker, Popup: MockPopup });
}

describe('vehicle popup — merged 1s/5s refresh ticker (STATUS.md deferred item #2)', () => {
    let markers, processVehicleData;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        popupHtmlCallCount = 0;
        document.body.innerHTML = '';
        installGlobals();          // sets window.masterStopsData/masterTripsData/etc.
        installMaplibreMock();
        // jsdom doesn't implement CSS.escape — createNewMarker's orphan-DOM
        // sweep uses it to build an attribute selector. No test fixture ids
        // used here need real escaping, so identity is sufficient.
        if (typeof globalThis.CSS === 'undefined' || typeof globalThis.CSS.escape !== 'function') {
            vi.stubGlobal('CSS', { escape: (s) => String(s) });
        }
        ({ markers, processVehicleData } = await import('../js/markers.js'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('updates age text every 1s tick, and does the full popup rebuild only on every 5th tick', () => {
        const T0 = Math.floor(Date.now() / 1000);
        processVehicleData({
            features: [makeFeature({ tripId: 'TR-A-1', routeCode: '801', timestamp: T0 })],
        }, null);

        const marker = markers['TR-A-1'];
        expect(marker).toBeDefined();

        const popup = marker.getPopup();
        popup._fireOpen();   // mirrors a rider tapping the marker

        const secsEl        = () => popup.getElement().querySelector('.pv2-secs');
        const rebuildSeqEl   = () => popup.getElement().querySelector('.pv2-rebuild-seq');

        const callsAfterOpen  = popupHtmlCallCount;
        const seqAfterOpen    = rebuildSeqEl().dataset.seq;

        // Ticks 1-4 (1s, 2s, 3s, 4s): age text advances every second, but the
        // popup content is NOT rebuilt (no new getPopupHTML call, rebuild-seq
        // marker unchanged) — matches the old 5000ms-only ETA ticker.
        for (let s = 1; s <= 4; s++) {
            vi.advanceTimersByTime(1000);
            expect(secsEl().textContent).toBe(`${s}s ago`);
            expect(popupHtmlCallCount).toBe(callsAfterOpen);
            expect(rebuildSeqEl().dataset.seq).toBe(seqAfterOpen);
        }

        // Tick 5 (5s mark): the full rebuild fires — getPopupHTML is called
        // again (rebuild-seq marker advances) — matches the old independent
        // 5000ms ticker's cadence, now folded into the same 1s interval.
        vi.advanceTimersByTime(1000);
        expect(popupHtmlCallCount).toBe(callsAfterOpen + 1);
        expect(rebuildSeqEl().dataset.seq).not.toBe(seqAfterOpen);
        // The 1s age-text cadence still holds even on a rebuild tick.
        expect(secsEl().textContent).toBe('5s ago');

        // Ticks 6-9: back to age-only updates, no further rebuild.
        for (let s = 6; s <= 9; s++) {
            vi.advanceTimersByTime(1000);
            expect(secsEl().textContent).toBe(`${s}s ago`);
        }
        expect(popupHtmlCallCount).toBe(callsAfterOpen + 1);

        // Tick 10: second 5th-tick boundary — rebuilds again.
        vi.advanceTimersByTime(1000);
        expect(popupHtmlCallCount).toBe(callsAfterOpen + 2);
    });
});
