/**
 * Tests for marker lifecycle helpers in markers.js:
 *   - applyOriginVisibility hides/shows the DOM element when STOPPED_AT idx=0
 *   - initMarkerCleanup applies the freshness tier (live/aging/stale) and
 *     removes markers at FRESH_EXPIRE_S
 *   - restoreMarkerOpacity restores tier-appropriate opacity (not always 1)
 *   - _applySnap: snap-to-polyline and off-route detection
 *   - _applyVelocityCorrections: GPS pullback suppression
 *   - _applyTerminusHeading: heading override at terminal holds
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

import {
    markers,
    applyOriginVisibility,
    initMarkerCleanup,
    restoreMarkerOpacity,
    _applySnap,
    _applyVelocityCorrections,
    _applyTerminusHeading,
} from '../js/markers.js';
import { initPredictions } from '../js/predictions.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import {
    FRESH_LIVE_S, FRESH_AGING_S, FRESH_EXPIRE_S,
} from '../js/config.js';
import { shapeData, arcLengths, precomputeRoute } from '../js/snap.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    installGlobals();
    initPredictions();
    for (const k of Object.keys(markers)) delete markers[k];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('applyOriginVisibility', () => {
    it('hides the marker element when STOPPED_AT idx=0 of own route', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', routeCode: '801', directionId: 0,
            stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('hidden');
        expect(m.getElement().style.pointerEvents).toBe('none');
    });

    it('shows the marker element when not at origin', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80303', currentStatus: 'STOPPED_AT',
        });
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('visible');
        expect(m.getElement().style.pointerEvents).toBe('');
    });

    it('shows the marker when IN_TRANSIT_TO origin (not yet arrived)', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'IN_TRANSIT_TO',
        });
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('visible');
    });

    it('is route-aware: a route\'s origin is not necessarily another route\'s origin', () => {
        // 80101 is origin for route 801 only. Pretend a 901 vehicle is at 80101 STOPPED_AT —
        // it should NOT be hidden.
        const m = makeMarker({
            tripId: 'TR-A-1',
            routeCode: '901',     // bus route, different origin set
            directionId: 0,
            stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        // Note: the trip TR-A-1 has rc=801 in masterTripsData, so isAtOwnOriginStop
        // looks up dir/origin for 901|0 — 80101 isn't 901's origin.
        m.properties.route_code = '901';
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('visible');
    });
});

describe('restoreMarkerOpacity', () => {
    it('restores live tier to opacity 1', () => {
        const m = makeMarker({ tripId: 'TR-A-1' });
        m._tier = 'live';
        m.getElement().style.opacity = '0.3';
        markers['TR-A-1'] = m;
        restoreMarkerOpacity('TR-A-1');
        expect(Number(m.getElement().style.opacity)).toBe(1);
    });

    it('restores aging tier to opacity 1.0 (same as live)', () => {
        const m = makeMarker({ tripId: 'TR-A-2' });
        m._tier = 'aging';
        m.getElement().style.opacity = '0.3';
        markers['TR-A-2'] = m;
        restoreMarkerOpacity('TR-A-2');
        expect(Number(m.getElement().style.opacity)).toBe(1);
    });

    it('restores stale tier to opacity 0.5 (not 1)', () => {
        const m = makeMarker({ tripId: 'TR-A-3' });
        m._tier = 'stale';
        m.getElement().style.opacity = '0.3';
        markers['TR-A-3'] = m;
        restoreMarkerOpacity('TR-A-3');
        expect(Number(m.getElement().style.opacity)).toBe(0.5);
    });

    it('is a no-op for an unknown markerKey', () => {
        // No throw, no side effect
        restoreMarkerOpacity('does-not-exist');
    });
});

describe('initMarkerCleanup', () => {
    it('keeps "live" markers at full opacity with no data-stale attribute', () => {
        vi.useFakeTimers();
        // Cleanup interval is 5000ms, so the marker ages by ~6s during the test.
        // Start the timestamp well within the live window even after that drift.
        const live = makeMarker({ tripId: 'L1', timestamp: NOW() - 5 });
        markers['L1'] = live;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(live.getElement().hasAttribute('data-stale')).toBe(false);
        expect(Number(live.getElement().style.opacity)).toBe(1);
    });

    it('applies "aging" tier (opacity 1.0, data-stale="aging") between FRESH_LIVE_S and FRESH_AGING_S', () => {
        vi.useFakeTimers();
        // Mid-band age (~60s) so the +6s drift can't push us into either neighbour tier.
        const aging = makeMarker({ tripId: 'A1', timestamp: NOW() - 60 });
        markers['A1'] = aging;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(aging.getElement().getAttribute('data-stale')).toBe('aging');
        expect(Number(aging.getElement().style.opacity)).toBe(1);
    });

    it('regression for <30s-fade bug: a marker at age 60s is "aging" (1.0), NOT "stale" (0.5)', () => {
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'R1', timestamp: NOW() - 60 });
        markers['R1'] = m;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(Number(m.getElement().style.opacity)).toBe(1);
        expect(m.getElement().getAttribute('data-stale')).toBe('aging');
    });

    it('applies "stale" tier (opacity 0.5, data-stale="1") past FRESH_AGING_S', () => {
        vi.useFakeTimers();
        const stale = makeMarker({ tripId: 'S1', timestamp: NOW() - (FRESH_AGING_S + 5) });
        markers['S1'] = stale;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(stale.getElement().getAttribute('data-stale')).toBe('1');
        expect(Number(stale.getElement().style.opacity)).toBe(0.5);
    });

    it('removes markers older than FRESH_EXPIRE_S (gracefully fades, then removes)', () => {
        vi.useFakeTimers();
        const dead = makeMarker({ tripId: 'D1', timestamp: NOW() - (FRESH_EXPIRE_S + 10) });
        const removeSpy = vi.fn();
        dead.remove = removeSpy;
        markers['D1'] = dead;

        initMarkerCleanup();
        // Cleanup interval fires at 5000ms — marker is detached from `markers` synchronously
        // and a fade transition begins. The DOM .remove() call is deferred until the fade
        // completes (~1200ms after detection).
        vi.advanceTimersByTime(5500);
        expect(markers['D1']).toBeUndefined();              // logical removal: immediate
        expect(Number(dead.getElement().style.opacity)).toBe(0); // visual fade started
        expect(removeSpy).not.toHaveBeenCalled();           // DOM still present
        vi.advanceTimersByTime(1500);
        expect(removeSpy).toHaveBeenCalled();               // DOM removed after fade
    });

    it('does not remove markers without timestamps', () => {
        vi.useFakeTimers();
        const noTs = makeMarker({ tripId: 'N1' });
        delete noTs.timestamp;
        const removeSpy = vi.fn();
        noTs.remove = removeSpy;
        markers['N1'] = noTs;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(removeSpy).not.toHaveBeenCalled();
        expect(markers['N1']).toBeDefined();
    });
});

// ── Helper: build a N-S synthetic route for snap tests ──────────────────────
function buildSnapRoute(code, n = 10, baseLat = 34.0, baseLng = -118.2) {
    const DEG_PER_100M = 100 / 110_540;
    const pts = Array.from({ length: n }, (_, i) => [baseLat + i * DEG_PER_100M, baseLng]);
    shapeData[code] = pts;
    precomputeRoute(code, pts);
    return pts;
}

describe('_applySnap — snap to polyline', () => {
    const RC = 'SNAP_LIFECYCLE_TEST';

    beforeEach(() => {
        installGlobals();
        buildSnapRoute(RC);
    });

    it('snaps marker._targetLng/_targetLat to the polyline when within RAIL_SNAP_MAX_M', () => {
        // Point on the route line (baseLng, mid-lat)
        const midLat = 34.0 + 5 * (100 / 110_540);
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [-118.2, midLat], currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [-118.2, midLat] });

        _applySnap(marker, vehicle);

        // Snapped position should be on the line (baseLng = -118.2)
        expect(marker._targetLng).toBeCloseTo(-118.2, 4);
        expect(marker._targetLat).toBeCloseTo(midLat, 4);
        // lastSnap must be populated
        expect(marker.lastSnap).not.toBeNull();
        expect(marker.lastSnap.tangentForward).toBeGreaterThanOrEqual(0);
        // data-off-route attribute must be absent
        expect(marker.getElement().hasAttribute('data-off-route')).toBe(false);
    });

    it('sets data-off-route and clears lastSnap when GPS is far off the polyline', () => {
        // Place vehicle 2 km east of the route — beyond RAIL_SNAP_MAX_M
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [-118.18, 34.0], currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [-118.18, 34.0] });

        _applySnap(marker, vehicle);

        expect(marker.lastSnap).toBeNull();
        expect(marker.getElement().getAttribute('data-off-route')).toBe('true');
    });

    it('snaps to stop coordinates when STOPPED_AT a known stop', () => {
        // Stop 80303 is at lat 34.080, lon -118.260 (from fixtures)
        const vehicle = makeFeature({
            routeCode: RC,
            lngLat: [-118.200, 34.081], // slightly off stop position
            stopId: '80303',
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [-118.200, 34.081] });

        _applySnap(marker, vehicle);

        // Final target should be the stop's known coordinates
        expect(marker._targetLng).toBeCloseTo(-118.260, 3);
        expect(marker._targetLat).toBeCloseTo(34.080, 3);
    });

    it('stores _terminusNow = false for a mid-route vehicle', () => {
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [-118.2, 34.0], stopId: '80202',
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [-118.2, 34.0] });

        _applySnap(marker, vehicle);

        expect(marker._terminusNow).toBe(false);
    });
});

describe('_applyVelocityCorrections — pullback suppression', () => {
    const RC = 'VEL_LIFECYCLE_TEST';

    beforeEach(() => {
        installGlobals();
        buildSnapRoute(RC);
    });

    it('suppresses a small backward move when lastSnap is set (rail, on-route)', () => {
        // Marker is heading north (heading ~0°). New GPS fix is ~10m south — backward.
        const midLat = 34.0 + 5 * (100 / 110_540);
        const backLat = midLat - (10 / 110_540); // 10m south = backward

        const snapResult = { snappedLat: midLat, snappedLng: -118.2, arcMeters: 500, tangentForward: 0 };

        const marker = makeMarker({
            routeCode: RC, lngLat: [-118.2, midLat],
            heading: 0,
            lastSnap: snapResult,
            validFixCount: 2,
        });
        // Seed velocity so the pullback gate can fire
        marker.lastVelocity = { dLng: 0, dLat: 0.0001, speedMps: 10 };
        markers[marker.properties.trip_id] = marker;

        const vehicle = makeFeature({
            routeCode: RC, lngLat: [-118.2, backLat], speed: 10,
        });
        // Pre-fill snap intermediates as _applySnap would
        marker._targetLng = -118.2;
        marker._targetLat = backLat;
        marker._terminusNow = false;

        const nowTs = Math.floor(Date.now() / 1000);
        _applyVelocityCorrections(marker, vehicle, marker.properties.trip_id, nowTs - 5, false, false);

        // Pullback suppressed: marker position stays near midLat (not moved to backLat)
        const { lat } = marker.getLngLat();
        expect(lat).toBeGreaterThan(backLat); // held in place
        expect(marker._pullbackRun).toBeGreaterThan(0);

        // Cleanup
        delete markers[marker.properties.trip_id];
    });

    it('does NOT suppress pullback when terminusNow is true (legitimate reversal)', () => {
        const midLat = 34.0 + 5 * (100 / 110_540);
        const backLat = midLat - (10 / 110_540);

        const snapResult = { snappedLat: midLat, snappedLng: -118.2, arcMeters: 500, tangentForward: 0 };

        const marker = makeMarker({
            routeCode: RC, lngLat: [-118.2, midLat],
            heading: 0,
            lastSnap: snapResult,
            validFixCount: 2,
        });
        markers[marker.properties.trip_id] = marker;

        const vehicle = makeFeature({ routeCode: RC, lngLat: [-118.2, backLat], speed: 10 });
        marker._targetLng = -118.2;
        marker._targetLat = backLat;
        marker._terminusNow = true; // terminus — no suppression

        const nowTs = Math.floor(Date.now() / 1000);
        _applyVelocityCorrections(marker, vehicle, marker.properties.trip_id, nowTs - 5, false, false);

        // Without suppression the marker animates toward backLat — _pullbackRun stays 0
        expect(marker._pullbackRun).toBe(0);

        delete markers[marker.properties.trip_id];
    });
});

describe('_applyTerminusHeading — heading override at terminal holds', () => {
    beforeEach(() => {
        installGlobals();
    });

    it('sets rotation to 0 and swaps SVG when marker enters terminus state', () => {
        const marker = makeMarker({ routeCode: '801', heading: 90, atTerminus: false });
        // _terminusNow set by _applySnap — simulate here
        marker._terminusNow = true;

        const vehicle = makeFeature({ routeCode: '801' });
        const setRotSpy = vi.spyOn(marker, 'setRotation');

        _applyTerminusHeading(marker, vehicle);

        expect(setRotSpy).toHaveBeenCalledWith(0);
        expect(marker.atTerminus).toBe(true);
        // SVG backgroundImage should now be the terminus (square-icon) URL
        expect(marker.getElement().style.backgroundImage).toContain('svg');
    });

    it('is a no-op when terminus state has not changed', () => {
        const marker = makeMarker({ routeCode: '801', heading: 90, atTerminus: true });
        marker._terminusNow = true; // same as atTerminus → no change

        const vehicle = makeFeature({ routeCode: '801' });
        const setRotSpy = vi.spyOn(marker, 'setRotation');
        const origBg = marker.getElement().style.backgroundImage;

        _applyTerminusHeading(marker, vehicle);

        expect(setRotSpy).not.toHaveBeenCalled();
        expect(marker.getElement().style.backgroundImage).toBe(origBg);
    });

    it('removes rotation lock when marker leaves terminus state', () => {
        const marker = makeMarker({ routeCode: '801', heading: 90, atTerminus: true });
        marker._terminusNow = false; // was terminus, now not

        const vehicle = makeFeature({ routeCode: '801' });
        const setRotSpy = vi.spyOn(marker, 'setRotation');

        _applyTerminusHeading(marker, vehicle);

        // setRotation(0) should NOT be called on exit (only on entry)
        expect(setRotSpy).not.toHaveBeenCalled();
        expect(marker.atTerminus).toBe(false);
    });
});
