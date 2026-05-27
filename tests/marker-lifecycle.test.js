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
    _effectiveNextStopId,
    getVehicleEtaSecs,
} from '../js/markers.js';
import { _report } from '../js/feedStats.js';
import { initPredictions } from '../js/predictions.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals, addArrival } from './_helpers/globals.js';
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

    it('applies "aging" tier (opacity 1.0) between FRESH_LIVE_S and FRESH_AGING_S', () => {
        vi.useFakeTimers();
        // Mid-band age (~60s) so the +6s drift can't push us into either neighbour tier.
        const aging = makeMarker({ tripId: 'A1', timestamp: NOW() - 60 });
        markers['A1'] = aging;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(aging._tier).toBe('aging');
        expect(Number(aging.getElement().style.opacity)).toBe(1);
    });

    it('regression for <30s-fade bug: a marker at age 60s is "aging" (1.0), NOT "stale" (0.5)', () => {
        vi.useFakeTimers();
        const m = makeMarker({ tripId: 'R1', timestamp: NOW() - 60 });
        markers['R1'] = m;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(Number(m.getElement().style.opacity)).toBe(1);
        expect(m._tier).toBe('aging');
    });

    it('applies "stale" tier (opacity 0.5) past FRESH_AGING_S', () => {
        vi.useFakeTimers();
        const stale = makeMarker({ tripId: 'S1', timestamp: NOW() - (FRESH_AGING_S + 5) });
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
        // the wrong line. speed=0 to keep this a legitimate STOPPED_AT
        // (otherwise the misfire predicate would skip the pin entirely).
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
        // would surface immediately. speed=0 to keep this a legitimate
        // STOPPED_AT (otherwise the misfire predicate would skip the pin).
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

describe('_applySnap — declared-stop clamp (user-invariant: marker never past the stop it is AT)', () => {
    // The declared-stop clamp pulls a marker back to its declared stop's arc
    // when GPS projects it past that stop. Scope (2026-05-21): the clamp
    // engages ONLY when the feed reports STOPPED_AT ("At stop" in the popup).
    // For IN_TRANSIT_TO ("Next stop") the marker follows GPS freely — clamping
    // a moving train to a lagged stopId yanked it backward onto a platform it
    // had already left ("too aggressively pulled to the next stop", user
    // feedback 2026-05-21). These tests exercise the clamp (STOPPED_AT) and
    // its deliberate absence (IN_TRANSIT_TO).
    const RC = 'CLAMP_TEST';
    const BASE_LAT = 34.0;
    const BASE_LNG = -118.2;
    const DEG_PER_M = 1 / 110_540;
    // 10-point N-S route at -118.2; arc 0..900 in 100m steps.
    // Stops placed at arc 300 (mid) and arc 600 (mid-late).
    const STOP_MID_ARC  = 300;
    const STOP_LATE_ARC = 600;

    function setup() {
        installGlobals({
            trips: {
                'TR-CLAMP-OUT': {
                    rc: RC, dir: 0,
                    stops: ['CLAMP_S0', 'CLAMP_S_MID', 'CLAMP_S_LATE', 'CLAMP_S_END'],
                    scheduledTimes: [0, 60, 120, 180],
                },
                // dir=1 trip uses the same physical stops in reverse order,
                // so cache.arcMeters for dir=1 will descend (highest first).
                'TR-CLAMP-RET': {
                    rc: RC, dir: 1,
                    stops: ['CLAMP_S_END', 'CLAMP_S_LATE', 'CLAMP_S_MID', 'CLAMP_S0'],
                    scheduledTimes: [0, 60, 120, 180],
                },
            },
            stops: {
                'CLAMP_S0':     { lat: BASE_LAT,                            lon: BASE_LNG, name: 'S0' },
                'CLAMP_S_MID':  { lat: BASE_LAT + STOP_MID_ARC * DEG_PER_M,  lon: BASE_LNG, name: 'S-MID'  },
                'CLAMP_S_LATE': { lat: BASE_LAT + STOP_LATE_ARC * DEG_PER_M, lon: BASE_LNG, name: 'S-LATE' },
                'CLAMP_S_END':  { lat: BASE_LAT + 900 * DEG_PER_M,           lon: BASE_LNG, name: 'S-END'  },
            },
        });
        buildSnapRoute(RC);
        initPredictions();
    }

    it('STOPPED_AT: GPS past the declared stop is clamped BACK to the stop\'s arc', () => {
        setup();
        // Train STOPPED_AT S-MID (stopId=CLAMP_S_MID), but GPS lands at arc 400
        // — 100 m PAST the declared stop's arc (300). The popup says "At stop:
        // S-MID", so the marker must be pulled back to the platform. speed=0
        // so the STOPPED_AT misfire predicate doesn't fire (which would skip
        // the clamp on the grounds that the vehicle is actually moving).
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            speed: 0,
            stopId: 'CLAMP_S_MID',
            directionId: 0,
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);

        // Snap arc clamped to the declared stop's arc (~300), NOT the raw GPS arc (~400).
        expect(marker.lastSnap.arcMeters).toBeCloseTo(STOP_MID_ARC, -1);
        // Target lat re-projected to the clamped arc.
        const expectedLat = BASE_LAT + STOP_MID_ARC * DEG_PER_M;
        expect(marker._targetLat).toBeCloseTo(expectedLat, 4);
        expect(marker._targetLng).toBeCloseTo(BASE_LNG, 4);
    });

    it('IN_TRANSIT_TO: GPS past the declared stop is NOT clamped (moving train)', () => {
        setup();
        // Same overshoot as the STOPPED_AT case above, but the feed reports
        // IN_TRANSIT_TO ("Next stop: S-MID"). A moving train whose stopId lags
        // a stop behind must follow GPS, not snap back to the platform —
        // the clamp is deliberately gated off for in-transit vehicles.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            stopId: 'CLAMP_S_MID', directionId: 0,
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);

        // Snap arc preserved at the true GPS arc (~400) — no clamp engaged.
        expect(marker.lastSnap.arcMeters).toBeCloseTo(400, -1);
        expect(marker._targetLat).toBeCloseTo(gpsLat, 4);
    });

    it('dir=1 (descending arcs): STOPPED_AT past declared stop in trip-seq order is clamped back', () => {
        // Same physical route, but the returning trip lists stops in reverse —
        // cache.arcMeters for dir=1 descends along trip sequence. The clamp's
        // direction check is driven by adjacent-arc comparison, not by
        // direction_id alone, so this validates the ascends=false branch.
        setup();
        // dir=1 train STOPPED_AT S_MID (arc 300). Train "past" S_MID in
        // trip-sequence means SOUTH of arc 300, i.e., at a smaller arc. Use
        // arc 200 (100 m past S_MID, going south). speed=0 keeps this a
        // genuine STOPPED_AT (not a misfire that would skip the clamp).
        const gpsLat = BASE_LAT + 200 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            speed: 0,
            stopId: 'CLAMP_S_MID', directionId: 1,
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);

        // Snap arc clamped UP to S_MID's arc (~300), since for dir=1 the
        // "behind in trip sequence" direction is the larger arc.
        expect(marker.lastSnap.arcMeters).toBeCloseTo(STOP_MID_ARC, -1);
    });

    it('no clamp when stopId is missing (terminus, owl service)', () => {
        setup();
        // STOPPED_AT + speed=0 so the status and misfire gates are both
        // satisfied — this isolates the missing-stopId branch as the reason
        // the clamp returns null.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            speed: 0,
            stopId: null, directionId: 0,
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);

        // Without a declared stopId we cannot enforce the invariant — snap
        // preserves the raw GPS arc and the scan-first-ahead fallback in
        // startDeadReckoning is what guards the integrator.
        expect(marker.lastSnap.arcMeters).toBeCloseTo(400, -1);
    });

    it('no clamp when stopId is not present in the trip\'s stop cache', () => {
        setup();
        // STOPPED_AT + speed=0 so the status and misfire gates are both
        // satisfied — isolates the unknown-stopId branch as the reason the
        // clamp returns null.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            speed: 0,
            stopId: 'STOP_NOT_IN_TRIP', directionId: 0,
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);

        // Unknown stopId → fallback path. The scan in startDeadReckoning will
        // handle it; _applySnap leaves the raw snap intact.
        expect(marker.lastSnap.arcMeters).toBeCloseTo(400, -1);
    });

    it('STOPPED_AT misfire: clamp does NOT engage (feed says stopped, vehicle is moving)', () => {
        setup();
        // Feed reports STOPPED_AT but the vehicle's speed is well above the
        // misfire threshold — observed motion contradicts the "at stop" flag.
        // The misfire bypass must keep the marker following GPS rather than
        // pinning it at the (stale) declared stop arc.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            speed: 12,
            stopId: 'CLAMP_S_MID',
            directionId: 0,
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);

        // Clamp is bypassed by the misfire gate — snap stays at raw GPS arc.
        expect(marker.lastSnap.arcMeters).toBeCloseTo(400, -1);
    });
});

describe('_applySnap — stopIdLag observability counter', () => {
    // Pure observability counter (no behavior change). Fires when the feed
    // says IN_TRANSIT_TO but the marker's snap arc has already moved past
    // the declared next stop's arc by >= STOP_ID_LAG_MARGIN_M. Episode-gated
    // via marker._stopIdLagRecorded so a sustained lag doesn't flood the
    // 60s report tick. Mirrors the synthetic N-S route from the declared-
    // stop clamp tests above: stops at arc 300 and arc 600.
    const RC = 'STOPIDLAG_TEST';
    const BASE_LAT = 34.0;
    const BASE_LNG = -118.2;
    const DEG_PER_M = 1 / 110_540;
    const STOP_MID_ARC = 300;

    let infoSpy;
    beforeEach(() => {
        installGlobals({
            trips: {
                'TR-LAG-OUT': {
                    rc: RC, dir: 0,
                    stops: ['LAG_S0', 'LAG_S_MID', 'LAG_S_LATE', 'LAG_S_END'],
                    scheduledTimes: [0, 60, 120, 180],
                },
                'TR-LAG-RET': {
                    rc: RC, dir: 1,
                    stops: ['LAG_S_END', 'LAG_S_LATE', 'LAG_S_MID', 'LAG_S0'],
                    scheduledTimes: [0, 60, 120, 180],
                },
            },
            stops: {
                'LAG_S0':     { lat: BASE_LAT,                            lon: BASE_LNG, name: 'S0' },
                'LAG_S_MID':  { lat: BASE_LAT + STOP_MID_ARC * DEG_PER_M,  lon: BASE_LNG, name: 'S-MID'  },
                'LAG_S_LATE': { lat: BASE_LAT + 600 * DEG_PER_M,           lon: BASE_LNG, name: 'S-LATE' },
                'LAG_S_END':  { lat: BASE_LAT + 900 * DEG_PER_M,           lon: BASE_LNG, name: 'S-END'  },
            },
        });
        buildSnapRoute(RC);
        initPredictions();
        infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
        // Drain counters leaked from prior describe blocks (snap, clamp, etc.).
        // Marker counters are module-global and only reset inside _report() —
        // tests that don't inspect the report leave residue. Drain + clear so
        // each stopIdLag assertion starts from zero.
        _report();
        infoSpy.mockClear();
    });

    function reportLine() {
        _report();
        return infoSpy.mock.calls.find(c => c[0]?.startsWith('[feed-stats] markers:'))?.[0];
    }

    it('fires once when IN_TRANSIT_TO marker has passed declared stop by >= 30m', () => {
        // Marker snaps to arc ~400 (100m past STOP_MID_ARC=300). The feed still
        // points stopId at S-MID — classic lag. Counter should record one event.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            stopId: 'LAG_S_MID', directionId: 0,
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);
        expect(marker._stopIdLagRecorded).toBe(true);
        expect(reportLine()).toContain('stopIdLag=1');
    });

    it('does NOT fire when overshoot is below the 30m margin (snap noise floor)', () => {
        // Marker snaps to arc ~320 — only 20m past STOP_MID_ARC=300, well within
        // the snap noise floor. Counter must NOT fire to avoid noise pollution.
        const gpsLat = BASE_LAT + 320 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            stopId: 'LAG_S_MID', directionId: 0,
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);
        expect(marker._stopIdLagRecorded).toBeFalsy();
        expect(reportLine()).toBeUndefined();
    });

    it('does NOT fire for STOPPED_AT (that case belongs to stoppedAtMisfire / declaredStopClamp)', () => {
        // Same overshoot, but currentStatus=STOPPED_AT. Counter must skip —
        // STOPPED_AT-overshoot already has its own handlers (the clamp pulls
        // the snap back, or the misfire predicate flags genuinely-moving
        // vehicles). Routing it through stopIdLag too would double-count.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            speed: 0,
            stopId: 'LAG_S_MID', directionId: 0,
            currentStatus: 'STOPPED_AT',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);
        expect(marker._stopIdLagRecorded).toBeFalsy();
    });

    it('episode-gated: a second _applySnap with same stopId does not double-count', () => {
        // First frame records the event. Second frame at the same overshoot
        // must not produce another record — the flag stays sticky until the
        // feed advances its stopId.
        const gpsLat = BASE_LAT + 400 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            stopId: 'LAG_S_MID', directionId: 0,
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);
        _applySnap(marker, vehicle);
        expect(reportLine()).toContain('stopIdLag=1');
    });

    it('dir=1 (descending arcs): IN_TRANSIT_TO past declared stop in trip order still fires', () => {
        // Returning trip: cache.arcMeters descends in trip-sequence order.
        // Train is heading south, currently past S-LATE (arc 600) heading
        // toward S-MID. Marker's snap arc 500 is 100m past S-LATE in trip
        // order (because arc 500 < 600 in the dir=1 ascends=false convention).
        const gpsLat = BASE_LAT + 500 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            stopId: 'LAG_S_LATE', directionId: 1,
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);
        expect(marker._stopIdLagRecorded).toBe(true);
    });


    it('dir=1 with degenerate cache (all adjacent arcs null): direction_id fallback still triggers', async () => {
        // Pathological case: the cache has the declared stop's arc populated
        // but its adjacent arcs are null (snap shape didn't cover those
        // stops). The adjacent-arc scan finds no unequal pair, so the code
        // falls back to direction_id-based ascends. Without the fallback,
        // ascends defaults to `true` and dir=1 lag silently misdetects.
        const { getRouteCache } = await import('../js/predictions.js');
        const cache = getRouteCache(RC, 1);
        // Replace with all-null adjacent pairs except the declared stop's arc.
        // S-MID sits at index 2 in the dir=1 trip sequence (END, LATE, MID, S0).
        const idx = cache.stops.findIndex(s => s === 'LAG_S_MID');
        cache.arcMeters = cache.arcMeters.map((a, i) => i === idx ? 300 : null);

        // Marker is past S-MID in dir=1 (arc 200 < 300, i.e. closer to S0).
        const gpsLat = BASE_LAT + 200 * DEG_PER_M;
        const vehicle = makeFeature({
            routeCode: RC, lngLat: [BASE_LNG, gpsLat],
            stopId: 'LAG_S_MID', directionId: 1,
            currentStatus: 'IN_TRANSIT_TO',
        });
        const marker = makeMarker({ routeCode: RC, lngLat: [BASE_LNG, gpsLat] });

        _applySnap(marker, vehicle);
        expect(marker._stopIdLagRecorded).toBe(true);
    });
});

describe('createNewMarker — defensive flag init for observability gates', () => {
    // Every episode-gated observability flag (`_stopIdLagRecorded`,
    // `_noArrivalMatchRecorded`) is read via `!flag` today, so undefined
    // works. Initializing to `false` explicitly future-proofs against a
    // gate tightening to `=== true` that would silently drop frame-1
    // counter emission.
    const RC = '801';

    // Minimal maplibregl stub — createNewMarker constructs a real Popup and
    // Marker, but for property-init coverage we only need the no-op surface.
    beforeEach(() => {
        installGlobals();
        const noop = () => ({});
        const chainable = { setHTML: () => chainable, on: () => chainable, getElement: () => null };
        const markerStub = {
            setLngLat: () => markerStub,
            setRotation: () => markerStub,
            setPopup: () => markerStub,
            addTo: () => markerStub,
            getElement: () => ({
                setAttribute: noop, removeAttribute: noop,
                addEventListener: noop, style: {},
            }),
            getPopup: () => null,
            remove: noop,
        };
        vi.stubGlobal('maplibregl', {
            Popup:  function () { return chainable; },
            Marker: function () { return markerStub; },
        });
        for (const k of Object.keys(markers)) delete markers[k];
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('marker exposes _stopIdLagRecorded === false (not undefined) after creation', () => {
        const feature = makeFeature({ routeCode: RC });
        processVehicleData({ features: [feature] }, null);
        const m = markers[feature.properties.trip_id];
        expect(m).toBeTruthy();
        expect(m._stopIdLagRecorded).toBe(false);
    });

    it('marker exposes _noArrivalMatchRecorded === false (not undefined) after creation', () => {
        const feature = makeFeature({ routeCode: RC, vehicleId: 'V_INIT', tripId: 'TR_INIT' });
        processVehicleData({ features: [feature] }, null);
        const m = markers[feature.properties.trip_id];
        expect(m).toBeTruthy();
        expect(m._noArrivalMatchRecorded).toBe(false);
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
        // STOPPED_AT vehicles already have getBoardingDepSecs and the misfire
        // detector. The reverse-ghost counter is scoped to IN_TRANSIT_TO so
        // it doesn't double-count those windows.
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

describe('_applyVelocityCorrections — pullback suppression', () => {
    const RC = 'VEL_LIFECYCLE_TEST';

    beforeEach(() => {
        // Clear the default A-Line trip fixture: its stops live at lng -118.260
        // while these tests' markers sit at -118.200 (on the synthetic route),
        // so a trip-stop bearing would resolve to a meaningless direction.
        // Without trip data, computeHeading falls back cleanly to the marker's
        // explicit tangentForward, which is what these tests are exercising.
        installGlobals({ trips: {}, stops: {} });
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

describe('_effectiveNextStopId — GPS-inferred next-stop override (popup label)', () => {
    // The override returns a forward-looking stopId when the marker's snap
    // arc has demonstrably moved past the feed's declared next stop. Lets
    // the popup label match the visual position (the "B Line past Civic
    // Center" complaint) without resorting to clamping the marker.
    const RC = 'EFF_TEST';
    const BASE_LAT = 34.0;
    const BASE_LNG = -118.2;
    const DEG_PER_M = 1 / 110_540;

    function setup() {
        installGlobals({
            trips: {
                'TR-EFF': {
                    rc: RC, dir: 0,
                    stops: ['EFF_S0', 'EFF_S1', 'EFF_S2', 'EFF_S3'],
                    scheduledTimes: [0, 60, 120, 180],
                },
            },
            stops: {
                'EFF_S0': { lat: BASE_LAT,                       lon: BASE_LNG, name: 'S0' },
                'EFF_S1': { lat: BASE_LAT + 300 * DEG_PER_M,     lon: BASE_LNG, name: 'S1' },
                'EFF_S2': { lat: BASE_LAT + 600 * DEG_PER_M,     lon: BASE_LNG, name: 'S2' },
                'EFF_S3': { lat: BASE_LAT + 900 * DEG_PER_M,     lon: BASE_LNG, name: 'S3' },
            },
        });
        buildSnapRoute(RC);
        initPredictions();
    }

    it('returns the declared stopId when the marker has NOT passed it', () => {
        setup();
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S2', currentStatus: 'IN_TRANSIT_TO',
        });
        marker.lastSnap = { arcMeters: 500, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 500 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe('EFF_S2');
    });

    it('returns the next-ahead stopId when the marker is past the declared by ≥ margin (and moving)', () => {
        setup();
        // Declared next stop = S1 (arc 300). Snap landed at arc 400 → 100m
        // past, well beyond STOP_ID_LAG_MARGIN_M (30m). Marker is moving
        // (speed=10 m/s), so the override fires. Should advance the
        // displayed label to S2 (arc 600).
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S1', currentStatus: 'IN_TRANSIT_TO',
            speed: 10,
        });
        marker.properties.smoothedSpeed = 10;
        marker.lastSnap = { arcMeters: 400, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 400 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe('EFF_S2');
    });

    it('does NOT override when the marker is stationary (platform overshoot guard)', () => {
        // Critical guard: a stopped 3-car train (~82 m long) reports a GPS
        // position ~25-40 m past the platform centroid because the antenna
        // sits mid-car. Without the speed gate the override would fire
        // here — the popup would flip to the NEXT stop while the rider
        // can see the train sitting at the current platform. With the
        // gate, the override only fires when the train is actually moving
        // past the stop.
        setup();
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S1', currentStatus: 'IN_TRANSIT_TO',
            speed: 0,
        });
        marker.properties.smoothedSpeed = 0;
        // 40 m past S1 (arc 300) — clearly beyond STOP_ID_LAG_MARGIN_M
        // (30 m) but speed=0 should suppress the override.
        marker.lastSnap = { arcMeters: 340, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 340 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe('EFF_S1');
    });

    it('returns the declared stopId when overshoot is under STOP_ID_LAG_MARGIN_M (GPS noise)', () => {
        setup();
        // Declared next stop = S1 (arc 300). Snap landed at arc 310 — only
        // 10m past, well under the 30m margin. Don't flip the label early
        // on platform-level GPS jitter.
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S1', currentStatus: 'IN_TRANSIT_TO',
        });
        marker.lastSnap = { arcMeters: 310, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 310 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe('EFF_S1');
    });

    it('returns the declared stopId when STOPPED_AT (override is IN_TRANSIT_TO-only)', () => {
        setup();
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S1', currentStatus: 'STOPPED_AT',
        });
        marker.lastSnap = { arcMeters: 400, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 400 * DEG_PER_M };
        // Even though the marker is past S1, STOPPED_AT belongs to the
        // declared-stop clamp / misfire detector — not this override.
        expect(_effectiveNextStopId(marker)).toBe('EFF_S1');
    });

    it('skips multi-stop overshoots correctly (declared S1, marker past S2 too)', () => {
        setup();
        // Marker arc 700 — past S1 (300) and past S2 (600). Declared stopId
        // is the stale S1. Marker is moving. Should return S3 (the first
        // stop still ahead), not S2 (also already passed).
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S1', currentStatus: 'IN_TRANSIT_TO',
            speed: 10,
        });
        marker.properties.smoothedSpeed = 10;
        marker.lastSnap = { arcMeters: 700, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 700 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe('EFF_S3');
    });

    it('returns the declared stopId when marker is past every remaining stop (end of trip)', () => {
        setup();
        // Marker past S3 (900) too — no stop ahead. Fall back to the
        // declared stopId rather than returning null so callers always
        // get a usable identifier.
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S2', currentStatus: 'IN_TRANSIT_TO',
        });
        marker.lastSnap = { arcMeters: 950, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 950 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe('EFF_S2');
    });

    it('returns null when no stopId is declared (terminus / owl service)', () => {
        setup();
        const marker = makeMarker({ routeCode: RC, directionId: 0, stopId: null });
        marker.lastSnap = { arcMeters: 100, snappedLng: BASE_LNG, snappedLat: BASE_LAT + 100 * DEG_PER_M };
        expect(_effectiveNextStopId(marker)).toBe(null);
    });

    it('returns the declared stopId when no snap is available (off-route)', () => {
        setup();
        const marker = makeMarker({
            routeCode: RC, directionId: 0,
            stopId: 'EFF_S1', currentStatus: 'IN_TRANSIT_TO',
        });
        marker.lastSnap = null;
        expect(_effectiveNextStopId(marker)).toBe('EFF_S1');
    });
});
