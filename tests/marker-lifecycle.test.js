/**
 * Tests for marker lifecycle helpers in markers.js:
 *   - applyOriginVisibility hides/shows the DOM element when STOPPED_AT idx=0
 *   - initMarkerCleanup applies the freshness tier (live/aging/stale) and
 *     removes markers at FRESH_EXPIRE_S
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
    processVehicleData,
    _applySnap,
    _applyVelocityCorrections,
    _applyTerminusHeading,
    getVehicleEtaSecs,
} from '../js/markers.js';
import { _report } from '../js/feedStats.js';
import { initPredictions } from '../js/predictions.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals, addArrival } from './_helpers/globals.js';
import {
    FRESH_STALE_S, FRESH_EXPIRE_S, SPIKE_REANCHOR_STREAK,
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

describe('initMarkerCleanup', () => {
    it('keeps "live" markers at full opacity with tier "live"', () => {
        vi.useFakeTimers();
        // Cleanup interval is 5000ms, so the marker ages by ~6s during the test.
        // Start the timestamp well within the live window even after that drift.
        const live = makeMarker({ tripId: 'L1', timestamp: NOW() - 5 });
        markers['L1'] = live;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(live._tier).toBe('live');
        expect(Number(live.getElement().style.opacity)).toBe(1);
    });

    it('regression for <90s-fade bug: a marker at age 60s is "live" (1.0), NOT "stale" (0.5)', () => {
        // The KISS pass (2026-05-27) collapsed the old 30-90s `aging` band
        // into `live` — opacity was already 1.0 there anyway. This test
        // pins the under-90s region as live so a future tier reshuffle
        // can't accidentally re-introduce an under-90s fade.
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'R1', timestamp: NOW() - 60 });
        markers['R1'] = m;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(Number(m.getElement().style.opacity)).toBe(1);
        expect(m._tier).toBe('live');
    });

    it('applies "stale" tier (opacity 0.5) past FRESH_STALE_S', () => {
        vi.useFakeTimers();
        const stale = makeMarker({ tripId: 'S1', timestamp: NOW() - (FRESH_STALE_S + 5) });
        markers['S1'] = stale;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(stale._tier).toBe('stale');
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

    it('STOPPED_AT with stop coord far from polyline (>RAIL_SNAP_MAX_M) falls back to published coord', () => {
        // Stop 80303 is at lat 34.080, lon -118.260 (from fixtures); synthetic
        // polyline runs at lng -118.200 (~5.4 km from the stop). The off-by
        // gate must reject the polyline projection and fall back to the
        // published coord — otherwise the marker would teleport ~5 km onto
        // the wrong line. speed=0 is just a plain stationary STOPPED_AT.
        const vehicle = makeFeature({
            routeCode: RC,
            lngLat: [-118.200, 34.081],
            speed: 0,
            stopId: '80303',
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [-118.200, 34.081] });

        _applySnap(marker, vehicle);

        expect(marker._targetLng).toBeCloseTo(-118.260, 3);
        expect(marker._targetLat).toBeCloseTo(34.080, 3);
    });

    it('STOPPED_AT with stop coord ON polyline projects onto the line', () => {
        // Add a stop that sits exactly on the synthetic polyline (lng -118.2,
        // mid-route lat). When STOPPED_AT, the marker must snap to the
        // polyline-projected position — same as the published coord here, but
        // exercised through the snap path so a future fixture/polyline drift
        // would surface immediately. speed=0 is just a plain stationary
        // STOPPED_AT.
        const midLat = 34.0 + 5 * (100 / 110_540);
        window.masterStopsData['SNAP_ON_LINE'] = { lat: midLat, lon: -118.200, name: 'On Line' };
        const vehicle = makeFeature({
            routeCode: RC,
            lngLat: [-118.2001, midLat + 0.00001], // slight GPS jitter off the line
            speed: 0,
            stopId: 'SNAP_ON_LINE',
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [-118.2001, midLat + 0.00001] });

        _applySnap(marker, vehicle);

        // Target must land on the polyline (lng = -118.200 exact), at the stop's lat.
        expect(marker._targetLng).toBeCloseTo(-118.200, 5);
        expect(marker._targetLat).toBeCloseTo(midLat, 5);
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




describe('_applyVelocityCorrections — re-anchor (teleport) vs glide', () => {
    // The glide duration tracks the inter-fix gap so on-screen speed ≈ real
    // speed. But some moves must NOT glide — they'd "zoom across the line".
    // Those re-anchor (teleport synchronously to the new snapped position).
    // These assertions exercise the synchronous teleport path only (no rAF).
    const RC = 'REANCHOR_TEST';

    beforeEach(() => {
        installGlobals();
        buildSnapRoute(RC); // ~900 m N-S synthetic route at lng -118.2
        for (const k of Object.keys(markers)) delete markers[k];
    });

    // Place the vehicle near the far (north) end of the synthetic route.
    const farLat = 34.0 + 8 * (100 / 110_540);

    function setup({ isStaleRef, fromArc, gap }) {
        const tripId = 'RA-1';
        const marker = makeMarker({ tripId, routeCode: RC, lngLat: [-118.2, 34.0] });
        marker._currentArc = fromArc;
        markers[tripId] = marker;
        const newTs = Math.floor(Date.now() / 1000);
        const vehicle = makeFeature({
            tripId, routeCode: RC, lngLat: [-118.2, farLat],
            currentStatus: 'IN_TRANSIT_TO', timestamp: newTs,
        });
        _applySnap(marker, vehicle);                      // sets lastSnap + _targetLng/_targetLat
        const prevTs = newTs - gap;
        _applyVelocityCorrections(marker, vehicle, tripId, prevTs, /*isFirstFix*/ false, isStaleRef);
        return { marker };
    }

    it('teleports to the new snapped position when the reference is stale', () => {
        // isStaleRef → re-anchor regardless of distance.
        const { marker } = setup({ isStaleRef: true, fromArc: 0, gap: 5 });
        const pos = marker.getLngLat();
        expect(pos.lng).toBeCloseTo(marker._targetLng, 4);
        expect(pos.lat).toBeCloseTo(marker._targetLat, 4);
    });

    it('teleports when the arc jump implies an impossible on-screen speed', () => {
        // fromArc=0, toArc≈800 m, gap=1 s ⇒ 800 m/s ≫ RAIL_MAX×1.5 ⇒ re-anchor.
        const { marker } = setup({ isStaleRef: false, fromArc: 0, gap: 1 });
        const pos = marker.getLngLat();
        expect(pos.lng).toBeCloseTo(marker._targetLng, 4);
        expect(pos.lat).toBeCloseTo(marker._targetLat, 4);
        // _currentArc must be synced to the destination arc after a teleport.
        expect(marker._currentArc).toBeCloseTo(marker.lastSnap.arcMeters, 3);
    });

    it('does NOT teleport for a plausible move — leaves the marker at its start to glide', () => {
        // fromArc≈760 m (close to toArc≈800 m), gap=5 s ⇒ ~8 m/s ⇒ glide.
        // No rAF advanced, so a started glide leaves the marker at its start
        // position — proving the synchronous teleport branch did NOT run.
        const startLat = 34.0 + 7 * (100 / 110_540);
        const tripId = 'RA-2';
        const marker = makeMarker({ tripId, routeCode: RC, lngLat: [-118.2, startLat] });
        markers[tripId] = marker;
        const newTs = Math.floor(Date.now() / 1000);
        const vehicle = makeFeature({
            tripId, routeCode: RC, lngLat: [-118.2, farLat],
            currentStatus: 'IN_TRANSIT_TO', timestamp: newTs,
        });
        _applySnap(marker, vehicle);
        marker._currentArc = marker.lastSnap.arcMeters - 40; // 40 m behind target
        _applyVelocityCorrections(marker, vehicle, tripId, newTs - 5, false, false);
        const pos = marker.getLngLat();
        // Still at (or essentially at) the start lat — not snapped to farLat.
        expect(pos.lat).toBeLessThan(farLat - 0.0005);
    });
});


describe('getVehicleEtaSecs — vehicleNoArrivalMatch observability counter', () => {
    // Reverse-ghost counter: fires when a live IN_TRANSIT_TO marker's
    // declared next stop has trip_updates predictions for OTHER vehicles
    // but none for THIS vehicle. Indicates trip_updates lost the prediction
    // for an active vehicle, and the popup will silently fall back to a
    // schedule-based ETA. Episode-gated via marker._noArrivalMatchRecorded.
    const STOP_ID = '80202';
    const NOW = () => Math.floor(Date.now() / 1000);

    let infoSpy;
    beforeEach(() => {
        installGlobals();
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        // Drain any counter residue from prior describe blocks before each test.
        _report();
        infoSpy.mockClear();
    });

    function reportLine() {
        _report();
        return infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
    }

    it('fires when IN_TRANSIT_TO marker has no matching trip_updates arrival but others exist', () => {
        // Marker is V1 / TR-A-1. Stop 80202 has a prediction for a DIFFERENT
        // vehicle V2 / TR-OTHER. Counter must fire — the feed is alive on this
        // stop but doesn't know about our vehicle.
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V2', tripId: 'TR-OTHER',
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, currentStatus: 'IN_TRANSIT_TO' });
        getVehicleEtaSecs(marker);
        expect(marker._noArrivalMatchRecorded).toBe(true);
        expect(reportLine()).toContain('vehicleNoArrivalMatch=1');
    });

    it('does NOT fire when arrivals list is empty (absence, not divergence)', () => {
        // No predictions exist for this stop at all. That's "feed silent on
        // this stop" — could be a quiet window, an unstaffed route, an owl
        // trip without trip_updates coverage. NOT a divergence signal.
        const marker = makeMarker({ stopId: STOP_ID, currentStatus: 'IN_TRANSIT_TO' });
        getVehicleEtaSecs(marker);
        expect(marker._noArrivalMatchRecorded).toBeFalsy();
        expect(reportLine()).toBeUndefined();
    });

    it('does NOT fire when a matching arrival exists by trip_id', () => {
        // V1 / TR-A-1. The arrival matches by tripId — happy path, popup
        // gets a real ETA, no counter event.
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V_OTHER', tripId: 'TR-A-1',
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, currentStatus: 'IN_TRANSIT_TO' });
        getVehicleEtaSecs(marker);
        expect(marker._noArrivalMatchRecorded).toBeFalsy();
    });

    it('does NOT fire when a matching arrival exists by vehicle_id', () => {
        // V1 matches by vehicleId even though tripIds differ.
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V1', tripId: 'TR-OTHER',
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, currentStatus: 'IN_TRANSIT_TO' });
        getVehicleEtaSecs(marker);
        expect(marker._noArrivalMatchRecorded).toBeFalsy();
    });

    it('does NOT fire when STOPPED_AT (boarding/dwell has its own gating elsewhere)', () => {
        // STOPPED_AT vehicles are handled by the boarding/dwell path
        // (getBoardingDepSecs). The reverse-ghost counter is scoped to
        // IN_TRANSIT_TO so it doesn't double-count those windows.
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V2', tripId: 'TR-OTHER',
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, currentStatus: 'STOPPED_AT', speed: 0 });
        getVehicleEtaSecs(marker);
        expect(marker._noArrivalMatchRecorded).toBeFalsy();
    });

    it('is episode-gated: second call with same state does not double-count', () => {
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V2', tripId: 'TR-OTHER',
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, currentStatus: 'IN_TRANSIT_TO' });
        getVehicleEtaSecs(marker);
        getVehicleEtaSecs(marker);
        expect(reportLine()).toContain('vehicleNoArrivalMatch=1');
    });
});

describe('getVehicleEtaSecs — arrival join key + _etaSource tier tag', () => {
    const STOP_ID = '80202';
    const NOW = () => Math.floor(Date.now() / 1000);
    beforeEach(() => installGlobals());

    it('null vehicle_id does NOT cross-match a foreign empty-vehicleId arrival', () => {
        // A different trip's arrival, sooner, with an empty vehicleId. Pre-fix,
        // `a.vehicleId === vehicle_id` matched ''/null and this vehicle's popup
        // adopted the foreign ETA. Now the id clause is skipped for a null id.
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: '', tripId: 'TR-FOREIGN',
            arrivalUnix: NOW() + 30, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, vehicleId: null, tripId: 'TR-A-1', currentStatus: 'IN_TRANSIT_TO' });
        const eta = getVehicleEtaSecs(marker);
        // Did NOT adopt the foreign GTFS arrival → falls through to calc.
        expect(marker._etaSource).toBe('calc');
        expect(eta).not.toBe(30);
    });

    it('empty-string vehicle_id also does NOT cross-match a foreign empty-vehicleId arrival', () => {
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: '', tripId: 'TR-FOREIGN',
            arrivalUnix: NOW() + 30, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, vehicleId: '', tripId: 'TR-A-1', currentStatus: 'IN_TRANSIT_TO' });
        expect(getVehicleEtaSecs(marker)).not.toBe(30);
        expect(marker._etaSource).toBe('calc');
    });

    it('still matches by a real vehicle_id and tags _etaSource = gtfs-rt', () => {
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V1', tripId: 'TR-OTHER',
            arrivalUnix: NOW() + 120, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, vehicleId: 'V1', tripId: 'TR-A-1', currentStatus: 'IN_TRANSIT_TO' });
        const eta = getVehicleEtaSecs(marker);
        expect(marker._etaSource).toBe('gtfs-rt');
        expect(eta).toBeGreaterThan(60); // ~120 s
    });

    it('matches by tripId even when vehicle_id is null, tagging _etaSource = gtfs-rt', () => {
        addArrival(STOP_ID, {
            routeId: '801', directionId: 0,
            vehicleId: 'V_OTHER', tripId: 'TR-A-1',
            arrivalUnix: NOW() + 90, lastIngestUnix: NOW(),
        });
        const marker = makeMarker({ stopId: STOP_ID, vehicleId: null, tripId: 'TR-A-1', currentStatus: 'IN_TRANSIT_TO' });
        const eta = getVehicleEtaSecs(marker);
        expect(marker._etaSource).toBe('gtfs-rt');
        expect(eta).toBeGreaterThan(30); // ~90 s
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

// ── Long-session hygiene: cleanup loop hardening ──────────────────────────────

describe('initMarkerCleanup hygiene', () => {
    it('force-removes a marker whose timestamp is undefined after the grace period', () => {
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'NT1' });
        m.timestamp = undefined;
        m.remove = vi.fn();
        markers['NT1'] = m;

        initMarkerCleanup();
        // First cleanup tick at 5000ms — registers _noTimestampSinceMs.
        vi.advanceTimersByTime(5000);
        expect(markers['NT1']).toBeDefined();
        // Second tick at 10000ms — grace (15s) has not elapsed yet.
        vi.advanceTimersByTime(5000);
        expect(markers['NT1']).toBeDefined();
        // Fourth tick at 25000ms — grace (15s) clearly exceeded → fade-and-remove.
        vi.advanceTimersByTime(15000);
        expect(markers['NT1']).toBeUndefined();
    });

    it('clears _noTimestampSinceMs once timestamp is set again (recovery path)', () => {
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'NT2' });
        m.timestamp = undefined;
        markers['NT2'] = m;

        initMarkerCleanup();
        vi.advanceTimersByTime(5000);
        expect(m._noTimestampSinceMs).toBeGreaterThan(0);

        m.timestamp = NOW();
        vi.advanceTimersByTime(5000);
        expect(m._noTimestampSinceMs).toBe(null);
        expect(markers['NT2']).toBeDefined();
    });

    it('removes a marker whose wall-clock age exceeds MARKER_HARD_TTL_MS even when timestamp is fresh', () => {
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'HARD', timestamp: NOW() });
        // Just over the 3-hour cap. The cap was raised from 30 min after the
        // A Line end-to-end run (over 2 hours one-way) was considered — a
        // legitimate vehicle has to be allowed to persist for its full trip.
        m._createdAtMs = Date.now() - (3 * 60 * 60 * 1000 + 60_000);
        markers['HARD'] = m;

        initMarkerCleanup();
        vi.advanceTimersByTime(5000);
        expect(markers['HARD']).toBeUndefined();
    });

    it('does NOT remove a marker still within MARKER_HARD_TTL_MS even on a long A-Line run', () => {
        // A real A Line train can be alive for 2+ hours. Regression for the
        // earlier 30-min cap that force-removed legit vehicles mid-trip.
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'LONG_ALINE', timestamp: NOW() });
        m._createdAtMs = Date.now() - (2 * 60 * 60 * 1000);  // 2 hours ago
        markers['LONG_ALINE'] = m;

        initMarkerCleanup();
        vi.advanceTimersByTime(5000);
        expect(markers['LONG_ALINE']).toBeDefined();
    });

    // The legacy DR watchdog was deleted with the Phase 5b pivot; under the
    // new model there is no per-marker rAF to "restart," so the watchdog
    // case it guarded no longer exists.
});

describe('processVehicleData — pre-bootstrap guard', () => {
    let infoSpy;

    beforeEach(() => {
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        for (const k of Object.keys(markers)) delete markers[k];
    });

    afterEach(() => {
        infoSpy?.mockRestore();
    });

    it('drops frames and increments preBootstrap when masterStopsData is empty', () => {
        window.masterStopsData = {};
        const data = {
            features: [
                makeFeature({ tripId: 'PB1', vehicleId: 'V1', routeCode: '801', lngLat: [-118.26, 34.04] }),
                makeFeature({ tripId: 'PB2', vehicleId: 'V2', routeCode: '801', lngLat: [-118.26, 34.05] }),
            ],
        };

        processVehicleData(data, null);

        // No markers created — early return fired before the per-feature loop.
        expect(markers['PB1']).toBeUndefined();
        expect(markers['PB2']).toBeUndefined();

        // The drop is recorded in the per-minute report line. Trigger _report
        // and assert the counter showed up.
        _report();
        const line = infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
        expect(line).toBeDefined();
        expect(line).toContain('preBootstrap=2');
    });

    it('drops frames when masterStopsData is missing entirely (null)', () => {
        window.masterStopsData = null;
        const data = {
            features: [
                makeFeature({ tripId: 'PB3', vehicleId: 'V3', routeCode: '801', lngLat: [-118.26, 34.04] }),
            ],
        };

        expect(() => processVehicleData(data, null)).not.toThrow();
        expect(markers['PB3']).toBeUndefined();
    });

    // Sanity check that the guard reverts to passive once bootstrap completes
    // would need a full fixture setup; covered indirectly by the existing
    // marker-creation tests in this file (those don't trip the guard).
});


describe('updateExistingMarker — consecutive-spike re-anchor', () => {
    // Regression: a B/D train emerging from a tunnel far ahead of its last
    // surface fix gets its emergence fix rejected as an arc/speed spike. Each
    // rejection bumps marker.timestamp, so the SPIKE_BYPASS_S staleness bypass
    // never fires while the feed keeps sending — the marker stays frozen until
    // the page is refreshed (a fresh marker skips the spike check). The
    // SPIKE_REANCHOR_STREAK escape hatch force-accepts after a streak.
    beforeEach(() => {
        installGlobals();
        for (const k of Object.keys(markers)) delete markers[k];
    });

    function feed(tripId, lng, lat, ts) {
        // Drive the real ingest path → updateExistingMarker (marker exists).
        processVehicleData({
            features: [makeFeature({ tripId, routeCode: '801', lngLat: [lng, lat], timestamp: ts })],
        }, null);
    }

    it(`force-re-anchors after ${SPIKE_REANCHOR_STREAK} consecutive rejected fixes`, () => {
        const tripId = 'SPK-1';
        const baseLng = -118.26, baseLat = 34.06;
        const t0 = NOW();   // realistic ts so the FRESH_EXPIRE_S ingest gate doesn't drop it

        // Pre-seed an established marker (stub — no MapLibre needed). validFixCount>0
        // so isFirstFix is false and the spike check is live.
        const m = makeMarker({ tripId, routeCode: '801', lngLat: [baseLng, baseLat], timestamp: t0 });
        m.validFixCount = 1;
        m._consecutiveSpikes = 0;
        markers[tripId] = m;

        // A position absurdly far from every Metro stop (no near-stop bypass)
        // and from base — every fix here trips the implausible-speed gate.
        const farLng = -118.26, farLat = 35.5;   // ~160 km north

        for (let i = 1; i <= SPIKE_REANCHOR_STREAK; i++) {
            feed(tripId, farLng, farLat, t0 + i * 5);
        }
        // All rejected: streak maxed, marker held at base.
        expect(m._consecutiveSpikes).toBe(SPIKE_REANCHOR_STREAK);
        expect(m.getLngLat().lat).toBeCloseTo(baseLat, 2);

        // One more fix → forceReanchor short-circuits the spike check → accepted.
        feed(tripId, farLng, farLat, t0 + (SPIKE_REANCHOR_STREAK + 1) * 5);
        expect(m._consecutiveSpikes).toBe(0);            // streak reset on accept
        expect(m.getLngLat().lat).toBeCloseTo(farLat, 1); // re-anchored (teleport >5km)
    });

    it('a one-off spike between good fixes never reaches the streak (still rejected)', () => {
        const tripId = 'SPK-2';
        const baseLng = -118.26, baseLat = 34.06;
        const t0 = NOW();
        const m = makeMarker({ tripId, routeCode: '801', lngLat: [baseLng, baseLat], timestamp: t0 });
        m.validFixCount = 1;
        m._consecutiveSpikes = 0;
        markers[tripId] = m;

        // Single spike → rejected, streak = 1, marker held.
        feed(tripId, -118.26, 35.5, t0 + 5);
        expect(m._consecutiveSpikes).toBe(1);
        expect(m.getLngLat().lat).toBeCloseTo(baseLat, 2);

        // A plausible nearby fix → accepted, streak resets to 0 (so a later
        // lone spike starts the count over and is still rejected).
        feed(tripId, -118.26, 34.061, t0 + 10);
        expect(m._consecutiveSpikes).toBe(0);
    });
});

