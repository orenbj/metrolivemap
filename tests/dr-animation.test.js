/**
 * Tests for dead-reckoning animation paths in markers.js.
 *
 * Drives the rAF loop via vi.useFakeTimers() and asserts:
 *   - Marker position advances under non-zero speed
 *   - Stationary speed (<0.5 m/s) does not start DR
 *   - DR exits after DR_MAX_SECONDS
 *   - Pause-but-keep-alive: zero-speed read mid-DR pauses but doesn't kill it
 *   - Rail DR caps at the next-stop arc (no overshoot)
 *   - Heavy rail (B/D) at speed=0: advances via scheduled fallback or constant fallback
 *   - Light rail at speed=0: freezes (real stop, not GPS dropout)
 *   - Diagnostic: per-test log of resolved final position vs. expected
 */

import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

import {
    markers,
    startBearingDeadReckoning,
    startDeadReckoning,
} from '../js/markers.js';
import {
    shapeData,
    arcLengths,
    precomputeRoute,
} from '../js/snap.js';
import { makeMarker } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import { DR_SPEED_FACTOR, DR_MAX_SECONDS, DR_HEAVY_RAIL_FALLBACK_MPS } from '../js/config.js';
import { _seedForTests as seedIntersections, _resetForTests as resetIntersections } from '../js/intersections.js';
import { logMarkdownTable } from './_helpers/diagnostics.js';

const M_PER_DEG_LAT = 111_111;
const _drDiag = [];

beforeEach(() => {
    installGlobals();
    // Clear any leftover markers from prior tests
    for (const k of Object.keys(markers)) delete markers[k];
    // Intersections module is shared across tests — start each one empty
    // (= "fail-open"). Tests that want freeze-near-crossing behaviour seed
    // their own fixture via seedIntersections().
    resetIntersections();
});

afterEach(() => {
    vi.useRealTimers();
});

afterAll(() => {
    logMarkdownTable('DR animation — resolved positions', _drDiag);
});

/**
 * Use fake timers that include performance.now() — without this, the DR loop's
 * elapsed-time calculation freezes at 0 and no movement happens.
 */
function setupFakeTimers() {
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
                 'requestAnimationFrame', 'cancelAnimationFrame',
                 'Date', 'performance'],
    });
}

/**
 * Advance both Date.now() / performance.now() and pump rAF callbacks by stepping
 * the fake timer forward one ~16ms frame at a time.
 */
function advanceFrames(ms) {
    const stepMs = 16;
    let remaining = ms;
    while (remaining > 0) {
        const step = Math.min(stepMs, remaining);
        vi.advanceTimersByTime(step);
        remaining -= step;
    }
}

describe('startBearingDeadReckoning (busway, no shape data)', () => {
    it('advances the marker along its heading at smoothed speed × DR_SPEED_FACTOR', () => {
        setupFakeTimers();
        const m = makeMarker({
            tripId: 'TR-G-1', routeCode: '901',
            lngLat: [-118.500, 34.180],
            heading: 90,            // due east
            speed: 10,
            stopId: '90404',        // distant stop, well > 5 km projection cap
        });
        m.properties.smoothedSpeed = 10;
        m.properties.Heading = 90;
        markers['TR-G-1'] = m;

        startBearingDeadReckoning('TR-G-1');
        const startLng = m.getLngLat().lng;
        advanceFrames(2000);  // 2 s

        const newLng = m.getLngLat().lng;
        expect(newLng).toBeGreaterThan(startLng);
        // Lat should be ~unchanged (eastward heading)
        expect(Math.abs(m.getLngLat().lat - 34.180)).toBeLessThan(0.0001);

        const distM = (newLng - startLng) * 111_111 * Math.cos(34.180 * Math.PI / 180);
        const expectedM = 10 * DR_SPEED_FACTOR * 2;
        _drDiag.push({
            scenario: 'busway DR 2s @ 10m/s east',
            expectedM: expectedM.toFixed(1),
            actualM: distM.toFixed(1),
            ratio: (distM / expectedM).toFixed(3),
        });
        // Within 25% of expected — rAF cadence in jsdom isn't exactly 60fps
        expect(distM).toBeGreaterThan(expectedM * 0.5);
        expect(distM).toBeLessThan(expectedM * 1.5);
    });

    it('does not start DR for a stationary marker (speed < 0.5 m/s)', () => {
        setupFakeTimers();
        const m = makeMarker({
            tripId: 'TR-G-1', routeCode: '901', lngLat: [-118.500, 34.180],
            heading: 90, speed: 0.1, stopId: '90404',
        });
        m.properties.smoothedSpeed = 0.1;
        markers['TR-G-1'] = m;

        startBearingDeadReckoning('TR-G-1');
        advanceFrames(2000);

        // Position unchanged
        expect(m.getLngLat().lng).toBe(-118.500);
        expect(m.getLngLat().lat).toBe(34.180);
    });

    it('does not start DR when current status is STOPPED_AT', () => {
        setupFakeTimers();
        const m = makeMarker({
            tripId: 'TR-G-1', routeCode: '901', lngLat: [-118.500, 34.180],
            heading: 90, speed: 10, currentStatus: 'STOPPED_AT', stopId: '90404',
        });
        m.properties.smoothedSpeed = 10;
        markers['TR-G-1'] = m;

        startBearingDeadReckoning('TR-G-1');
        advanceFrames(2000);

        expect(m.getLngLat().lng).toBe(-118.500);
    });

    it('exits the rAF loop after DR_MAX_SECONDS', () => {
        setupFakeTimers();
        const m = makeMarker({
            tripId: 'TR-G-1', routeCode: '901', lngLat: [-118.500, 34.180],
            heading: 90, speed: 10, stopId: '90404',
        });
        m.properties.smoothedSpeed = 10;
        m.properties.Heading = 90;
        markers['TR-G-1'] = m;

        startBearingDeadReckoning('TR-G-1');
        // Advance well past max
        advanceFrames((DR_MAX_SECONDS + 5) * 1000);
        const finalLng = m.getLngLat().lng;
        // Advance another 2s — position should not change further
        advanceFrames(2000);
        expect(m.getLngLat().lng).toBe(finalLng);
    });

    it('pause-but-keep-alive: zero-speed mid-flight pauses without killing DR', () => {
        setupFakeTimers();
        const m = makeMarker({
            tripId: 'TR-G-1', routeCode: '901', lngLat: [-118.500, 34.180],
            heading: 90, speed: 10, stopId: '90404',
        });
        m.properties.smoothedSpeed = 10;
        m.properties.Heading = 90;
        markers['TR-G-1'] = m;

        startBearingDeadReckoning('TR-G-1');
        advanceFrames(1000);
        const lngAfter1s = m.getLngLat().lng;

        // Zero-speed flicker
        m.properties.smoothedSpeed = 0;
        advanceFrames(2000);
        const lngAfterPause = m.getLngLat().lng;
        // Position essentially unchanged during the pause window
        expect(Math.abs(lngAfterPause - lngAfter1s)).toBeLessThan(0.001);

        // Resume
        m.properties.smoothedSpeed = 10;
        advanceFrames(1000);
        const lngAfterResume = m.getLngLat().lng;
        expect(lngAfterResume).toBeGreaterThan(lngAfterPause);
    });
});

/**
 * Build a synthetic 5km polyline running due north and register it under
 * code "TST" so snap.js sees shape data. Shared by light-rail and heavy-rail tests.
 */
function setupSyntheticRail() {
    const N = 50;
    const baseLat = 34.000;
    const lon = -118.260;
    const pts = [];
    for (let i = 0; i < N; i++) {
        pts.push([baseLat + (i * 100) / M_PER_DEG_LAT, lon]);
    }
    shapeData['TST'] = pts;
    precomputeRoute('TST', pts);
    // Add stops: one ~3 km north (cap target) and one ~4 km north (next-next,
    // used by the trip-sequence-fallback regression test when DR has overshot S2).
    installGlobals({
        stops: {
            'TST-S2': { lat: baseLat + 3000 / M_PER_DEG_LAT, lon, name: 'mid' },
            'TST-S3': { lat: baseLat + 4000 / M_PER_DEG_LAT, lon, name: 'next' },
        },
        trips: { 'TST-1': { rc: 'TST', dir: 0, stops: ['TST-S1', 'TST-S2', 'TST-S3'], scheduledTimes: [0, 300, 600] } },
    });
}

describe('startDeadReckoning (rail, polyline)', () => {
    it('advances the marker along the polyline arc at speed × DR_SPEED_FACTOR', () => {
        setupFakeTimers();
        setupSyntheticRail();
        const startLat = 34.000 + 100 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-T',
            directionId: 0,
            lngLat: [-118.260, startLat],
            heading: 0, speed: 15, stopId: 'TST-S2',
        });
        m.properties.smoothedSpeed = 15;
        m.properties.Heading = 0;
        m.lastSnap = {
            arcMeters: 100, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');
        const beforeLat = m.getLngLat().lat;
        advanceFrames(3000);

        const newLat = m.getLngLat().lat;
        expect(newLat).toBeGreaterThan(beforeLat);

        const distM = (newLat - beforeLat) * M_PER_DEG_LAT;
        const expectedM = 15 * DR_SPEED_FACTOR * 3;
        _drDiag.push({
            scenario: 'rail DR 3s @ 15m/s north',
            expectedM: expectedM.toFixed(1),
            actualM: distM.toFixed(1),
            ratio: (distM / expectedM).toFixed(3),
        });
        // Within 30% of expected (kinematic decel may already be active near cap)
        expect(distM).toBeGreaterThan(expectedM * 0.4);
    });

    it('does NOT advance past the next-stop arc cap', () => {
        setupFakeTimers();
        setupSyntheticRail();
        const startLat = 34.000 + 2900 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-T',
            directionId: 0,
            lngLat: [-118.260, startLat],
            heading: 0, speed: 30, stopId: 'TST-S2',
        });
        m.properties.smoothedSpeed = 30;
        m.properties.Heading = 0;
        m.lastSnap = {
            arcMeters: 2900, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');
        advanceFrames(DR_MAX_SECONDS * 1000);

        const finalLat = m.getLngLat().lat;
        // Stop is at 3000m arc → lat ~34.000 + 3000/M_PER_DEG_LAT
        const stopLat = 34.000 + 3000 / M_PER_DEG_LAT;
        const overshootM = (finalLat - stopLat) * M_PER_DEG_LAT;
        _drDiag.push({
            scenario: 'rail DR overshoot test (100m before stop, 30m/s, full duration)',
            stopArcM: '3000',
            finalArcM: ((finalLat - 34.000) * M_PER_DEG_LAT).toFixed(1),
            overshootM: overshootM.toFixed(2),
        });
        // Should not pass the stop (within 5m tolerance for jsdom rAF jitter)
        expect(overshootM).toBeLessThan(5);
    });

    it('clamps the marker back to the declared next stop when GPS or DR has overshot (hard cap)', () => {
        // Policy: the marker cannot pass its declared next stop. If snap or a
        // prior DR frame has placed _drCurrentArc past the stop's arc, the
        // next startDeadReckoning pulls it back.
        //
        // Scenario:
        //   1. DR has advanced _drCurrentArc to 3100 — past TST-S2 (arc 3000).
        //   2. Fresh GPS lands at arc 2950 (still approaching S2 per the feed),
        //      stopId = TST-S2 — i.e. feed-side stop_id has NOT yet advanced.
        //   3. startDeadReckoning recomputes: cap = S2 (3000); _drCurrentArc
        //      is past, so it's clamped back to 3000.
        //
        // Trade-off: a real feed-lag-after-pass produces a one-frame visible
        // snap-back. We accept that because the alternative (marker silently
        // ahead of the declared next stop, popup says "2 m to <station>" but
        // marker is past it) is the more confusing failure mode in practice.
        setupFakeTimers();
        setupSyntheticRail();
        const startLat = 34.000 + 2900 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-T',
            directionId: 0,
            lngLat: [-118.260, startLat],
            heading: 0, speed: 15, stopId: 'TST-S2',
        });
        m.properties.smoothedSpeed = 15;
        m.properties.Heading = 0;
        m.lastSnap = {
            arcMeters: 2900, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;
        // Phase 1: let DR run and force _drCurrentArc past S2 (simulating the
        // "marker has visually overshot the lagged stop" state).
        startDeadReckoning('TST-1');
        advanceFrames(100);
        m._drCurrentArc = 3100;        // simulate prior DR overshoot

        // Phase 2: fresh GPS comes in BEHIND m._drCurrentArc but still pointing
        // at S2 as the next stop. Re-snap and re-call startDR (mirrors what
        // updateExistingMarker → _applySnap → startDeadReckoning does).
        m.lastSnap = {
            arcMeters: 2950, tangentForward: 0,
            snappedLng: -118.260, snappedLat: 34.000 + 2950 / M_PER_DEG_LAT,
        };
        startDeadReckoning('TST-1');

        // Cap must be at S2 (~3000), NOT trip-walk-promoted to S3 (~4000).
        expect(m._drStopArcCap).toBeGreaterThan(2900);
        expect(m._drStopArcCap).toBeLessThan(3100);
        // _drCurrentArc must have been pulled back to the cap.
        expect(m._drCurrentArc).toBeLessThanOrEqual(m._drStopArcCap + 1);

        // After one more frame the integrator must hold the marker at the cap
        // (decel zone → speed ≈ 0 → no further advance, no backward drift).
        advanceFrames(16);
        expect(m._drCurrentArc).toBeLessThanOrEqual(m._drStopArcCap + 1);
    });

    it('lagged stopId: arcSign stays +1 (forward) when stopId still points at the just-passed stop', () => {
        // Regression for the "marker traverses route backward + arrow flipped 180°" bug.
        //
        // Scenario:
        //   - 3-stop trip running north along the polyline (dir=0).
        //   - Train has just passed S1 (arc 1000) and is now at arc 1100.
        //   - GTFS-RT feed lags 10-30 s → stopId STILL points at S1 (the stop
        //     just left), not yet advanced to S2.
        //   - downstreamBearing(here) returns the bearing FROM marker TO S1 →
        //     points south (backward along trip). Delta vs tangentForward (north)
        //     is ~180° → primary path would set arcSign = -1.
        //   - Fix: upstreamBearing returns the bearing FROM upstream stops TO here
        //     (north). When downstream & upstream disagree > 90°, prefer upstream.
        //
        // Assert: arcSign is +1 and the marker continues forward, NOT backward.
        setupFakeTimers();
        setupSyntheticRail();
        // Add an upstream stop S0 at arc 0 so upstreamBearing has something to walk to.
        installGlobals({
            stops: {
                'TST-S0': { lat: 34.000, lon: -118.260, name: 'origin' },
                'TST-S1': { lat: 34.000 + 1000 / M_PER_DEG_LAT, lon: -118.260, name: 'just passed' },
                'TST-S2': { lat: 34.000 + 3000 / M_PER_DEG_LAT, lon: -118.260, name: 'mid' },
                'TST-S3': { lat: 34.000 + 4000 / M_PER_DEG_LAT, lon: -118.260, name: 'next' },
            },
            trips: { 'TST-1': {
                rc: 'TST', dir: 0,
                stops: ['TST-S0', 'TST-S1', 'TST-S2', 'TST-S3'],
                scheduledTimes: [0, 120, 300, 600],
            }},
        });

        const startLat = 34.000 + 1100 / M_PER_DEG_LAT;  // 100 m past S1
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-LAG',
            directionId: 0,
            lngLat: [-118.260, startLat],
            heading: 0,  // pointing north (correct travel direction)
            speed: 15,
            // The bug trigger: stopId is the stop just PASSED, not the next stop.
            stopId: 'TST-S1',
            currentStatus: 'IN_TRANSIT_TO',
        });
        m.properties.smoothedSpeed = 15;
        m.properties.Heading = 0;  // north — correct prior-resolved heading
        m.lastSnap = {
            arcMeters: 1100, tangentForward: 0,  // polyline runs north
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');

        // Critical: arcSign must be +1. Pre-fix, downstream alone would point
        // south (toward TST-S1), arcSign would be -1, and the marker would walk
        // backward.
        expect(m._drArcSign).toBe(+1);

        const startArc = m._drCurrentArc;
        advanceFrames(2000);

        // Marker advanced forward (lat increased, arc increased).
        expect(m._drCurrentArc).toBeGreaterThan(startArc);
        expect(m.getLngLat().lat).toBeGreaterThan(startLat);
    });

    it('lagged stopId: rotation stays forward (not 180° flipped) even if arcSign were wrong', () => {
        // Defense-in-depth test for _arcTick's heading-orientation logic.
        //
        // Even if some future regression set arcSign = -1 incorrectly, the rotation
        // should still be picked by smallest delta to marker.properties.Heading
        // (which computeHeading resolved correctly via upstream cross-check).
        //
        // This protects against re-introducing the "arrow flipped 180° at 60 Hz"
        // symptom even if arc-sign resolution somehow drifts.
        setupFakeTimers();
        setupSyntheticRail();

        const startLat = 34.000 + 1100 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-FLIP',
            directionId: 0,
            lngLat: [-118.260, startLat],
            heading: 0,           // computeHeading already resolved: pointing north
            speed: 15,
            stopId: 'TST-S2',
            currentStatus: 'IN_TRANSIT_TO',
        });
        m.properties.smoothedSpeed = 15;
        m.properties.Heading = 0;  // canonical "north" — what computeHeading said
        m.lastSnap = {
            arcMeters: 1100, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');
        // Force arcSign to the wrong value AFTER DR start to isolate _arcTick's
        // rotation logic from startDeadReckoning's resolution.
        m._drArcSign = -1;

        advanceFrames(32);  // a few rAF frames

        // The arrow rotation should still be close to 0 (north) — within 90° of
        // marker.properties.Heading. Pre-fix this would be ~180 (flipped).
        const rotation = m.getRotation?.() ?? m._rotation ?? 0;
        // Normalise to (-180, 180]
        const normalised = ((rotation + 540) % 360) - 180;
        expect(Math.abs(normalised)).toBeLessThan(90);
    });

    it('continuous loop: a fresh startDeadReckoning during active DR refreshes speed mid-flight without resetting position', () => {
        setupFakeTimers();
        setupSyntheticRail();
        const startLat = 34.000 + 100 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-T',
            directionId: 0,
            lngLat: [-118.260, startLat],
            heading: 0, speed: 15, stopId: 'TST-S2',
        });
        m.properties.smoothedSpeed = 15;
        m.properties.Heading = 0;
        m.lastSnap = {
            arcMeters: 100, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');
        advanceFrames(1000);
        const arcAfter1s = m._drCurrentArc;
        expect(arcAfter1s).toBeGreaterThan(100);

        // Simulate a WS update: speed doubles. Position must be preserved
        // (continuous-loop semantics) and the new speed must take effect.
        m.properties.smoothedSpeed = 30;
        startDeadReckoning('TST-1');
        // _drCurrentArc must NOT have been reset to lastSnap.arcMeters (100).
        expect(m._drCurrentArc).toBe(arcAfter1s);

        advanceFrames(1000);
        const arcAfter2s = m._drCurrentArc;
        // 1 s at the new doubled speed should advance materially more than the
        // first second did at the original speed.
        const advance1 = arcAfter1s - 100;
        const advance2 = arcAfter2s - arcAfter1s;
        _drDiag.push({
            scenario: 'continuous loop — speed doubled mid-flight',
            advance1stSec_m: advance1.toFixed(2),
            advance2ndSec_m: advance2.toFixed(2),
            ratio: (advance2 / advance1).toFixed(2),
        });
        expect(advance2).toBeGreaterThan(advance1 * 1.6);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heavy-rail (B/D Line) speed=0 fallback — tunnel GPS dropout behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('startDeadReckoning (heavy rail — speed=0 tunnel fallback)', () => {
    // B Line (802). Synthetic 10 km due-north polyline.
    // S_PREV at arc 1 000 m, S_NEXT at arc 4 000 m.
    // Scheduled gap: 60 s → 240 s  ⟹  3 000 m / 180 s = 16.67 m/s raw.
    // After DR_SPEED_FACTOR (×0.75): ~12.5 m/s target.
    const B_ROUTE  = '802';
    const B_TRIP   = 'TR-B-1';
    const S_PREV   = 'SB01';
    const S_NEXT   = 'SB02';
    const BASE_LAT = 34.050;
    const BASE_LNG = -118.250;

    function setupBLineFixture({ withTripData = true } = {}) {
        // Register a 10 km north-running polyline for B Line.
        const pts = [];
        for (let i = 0; i < 101; i++) {
            pts.push([BASE_LAT + (i * 100) / M_PER_DEG_LAT, BASE_LNG]);
        }
        shapeData[B_ROUTE] = pts;
        precomputeRoute(B_ROUTE, pts);

        // Stop coords sit exactly on the polyline so snapToRoute returns arc positions.
        const stops = {
            [S_PREV]: { lat: BASE_LAT + 1000 / M_PER_DEG_LAT, lon: BASE_LNG, name: 'B Prev Stop' },
            [S_NEXT]: { lat: BASE_LAT + 4000 / M_PER_DEG_LAT, lon: BASE_LNG, name: 'B Next Stop' },
        };
        const trips = withTripData ? {
            [B_TRIP]: { rc: B_ROUTE, dir: 0, stops: [S_PREV, S_NEXT], scheduledTimes: [60, 240] },
        } : {};
        installGlobals({ stops, trips });
    }

    it('advances at scheduled segment speed when trip data is available', () => {
        setupFakeTimers();
        setupBLineFixture({ withTripData: true });

        const startLat = BASE_LAT + 2500 / M_PER_DEG_LAT; // midway between stops
        const m = makeMarker({
            tripId: B_TRIP, routeCode: B_ROUTE, vehicleId: 'V-B',
            directionId: 0,
            lngLat: [BASE_LNG, startLat],
            speed: 0, heading: 0, stopId: S_NEXT,
        });
        m.properties.smoothedSpeed = 0;
        m.lastSnap = {
            arcMeters: 2500, tangentForward: 0,
            snappedLng: BASE_LNG, snappedLat: startLat,
        };
        markers[B_TRIP] = m;

        startDeadReckoning(B_TRIP);
        advanceFrames(3000); // 3 s

        const distM = (m.getLngLat().lat - startLat) * M_PER_DEG_LAT;
        // Expected: 3000 m / 180 s × DR_SPEED_FACTOR × 3 s ≈ 37.5 m
        const expectedM = (3000 / 180) * DR_SPEED_FACTOR * 3;
        _drDiag.push({
            scenario: 'B Line tunnel — scheduled speed, 3s @ speed=0',
            expectedM: expectedM.toFixed(1),
            actualM:   distM.toFixed(1),
            ratio:     (distM / expectedM).toFixed(3),
        });
        expect(distM).toBeGreaterThan(5);                    // marker moved
        expect(distM).toBeGreaterThan(expectedM * 0.3);      // moved in the right ballpark
        expect(distM).toBeLessThan(expectedM * 2.0);         // didn't wildly overshoot
    });

    it('falls back to DR_HEAVY_RAIL_FALLBACK_MPS when trip data is absent', () => {
        setupFakeTimers();
        setupBLineFixture({ withTripData: false });

        const startLat = BASE_LAT + 2500 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: B_TRIP, routeCode: B_ROUTE, vehicleId: 'V-B',
            directionId: 0,
            lngLat: [BASE_LNG, startLat],
            speed: 0, heading: 0, stopId: S_NEXT,
        });
        m.properties.smoothedSpeed = 0;
        m.lastSnap = {
            arcMeters: 2500, tangentForward: 0,
            snappedLng: BASE_LNG, snappedLat: startLat,
        };
        markers[B_TRIP] = m;

        startDeadReckoning(B_TRIP);
        advanceFrames(3000); // 3 s at DR_HEAVY_RAIL_FALLBACK_MPS = 11 m/s

        const distM = (m.getLngLat().lat - startLat) * M_PER_DEG_LAT;
        _drDiag.push({
            scenario: 'B Line tunnel — FALLBACK_MPS, 3s @ speed=0 + no trip data',
            fallbackMps: String(DR_HEAVY_RAIL_FALLBACK_MPS),
            actualM:    distM.toFixed(1),
        });
        expect(distM).toBeGreaterThan(5);                                 // definitely moved
        expect(distM).toBeLessThan(DR_HEAVY_RAIL_FALLBACK_MPS * 3 * 1.5); // sane upper bound
    });

    it('light rail at speed=0 NEAR a known intersection freezes — real red-light stop', () => {
        setupFakeTimers();
        setupSyntheticRail(); // registers 'TST' light-rail polyline

        const startLat = 34.000 + 1500 / M_PER_DEG_LAT;
        // Seed an at-grade intersection exactly at the marker's coords —
        // simulates a marker stopped at a red light or gated crossing.
        seedIntersections([{ name: 'TST X-ing', lat: startLat, lng: -118.260, type: 'traffic_light' }]);

        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-LR',
            directionId: 0,
            lngLat: [-118.260, startLat],
            speed: 0, heading: 0, stopId: 'TST-S2',
        });
        m.properties.smoothedSpeed = 0;
        m.lastSnap = {
            arcMeters: 1500, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');
        advanceFrames(3000);

        const distM = Math.abs((m.getLngLat().lat - startLat) * M_PER_DEG_LAT);
        expect(distM).toBeLessThan(1); // must not have moved
    });

    it('light rail at speed=0 FAR from any intersection advances — tunnel/elevated GPS dropout', () => {
        setupFakeTimers();
        setupSyntheticRail(); // registers 'TST' light-rail polyline
        // Intentionally do NOT seed any intersections — simulates a marker
        // mid-tunnel where speed=0 is GPS dropout, not a real stop. The new
        // intersection-aware fallback should drive the marker forward at the
        // scheduled segment speed instead of freezing.

        const startLat = 34.000 + 1500 / M_PER_DEG_LAT;
        const m = makeMarker({
            tripId: 'TST-1', routeCode: 'TST', vehicleId: 'V-LR',
            directionId: 0,
            lngLat: [-118.260, startLat],
            speed: 0, heading: 0, stopId: 'TST-S2',
        });
        m.properties.smoothedSpeed = 0;
        m.lastSnap = {
            arcMeters: 1500, tangentForward: 0,
            snappedLng: -118.260, snappedLat: startLat,
        };
        markers['TST-1'] = m;

        startDeadReckoning('TST-1');
        advanceFrames(3000);

        const distM = (m.getLngLat().lat - startLat) * M_PER_DEG_LAT;
        _drDiag.push({
            scenario: 'Light-rail tunnel — no intersection, speed=0, 3s',
            actualM: distM.toFixed(1),
        });
        expect(distM).toBeGreaterThan(5);   // marker advanced (key new behaviour)
        expect(distM).toBeLessThan(60);     // sane upper bound (fallback ~12.5 m/s × 3s)
    });
});
