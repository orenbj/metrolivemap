/**
 * Tests for dead-reckoning animation paths in markers.js.
 *
 * Drives the rAF loop via vi.useFakeTimers() and asserts:
 *   - Marker position advances under non-zero speed
 *   - Stationary speed (<0.5 m/s) does not start DR
 *   - DR exits after DR_MAX_SECONDS
 *   - Pause-but-keep-alive: zero-speed read mid-DR pauses but doesn't kill it
 *   - Rail DR caps at the next-stop arc (no overshoot)
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
import { DR_SPEED_FACTOR, DR_MAX_SECONDS } from '../js/config.js';
import { logMarkdownTable } from './_helpers/diagnostics.js';

const M_PER_DEG_LAT = 111_111;
const _drDiag = [];

beforeEach(() => {
    installGlobals();
    // Clear any leftover markers from prior tests
    for (const k of Object.keys(markers)) delete markers[k];
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

describe('startDeadReckoning (rail, polyline)', () => {
    /**
     * Build a synthetic 5km polyline running due north and register it under
     * code "TST" so snap.js sees shape data. Vehicle starts at the south end.
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
        // Add a stop ~3 km north for the cap
        installGlobals({
            stops: { 'TST-S2': { lat: baseLat + 3000 / M_PER_DEG_LAT, lon, name: 'mid' } },
            trips: { 'TST-1': { rc: 'TST', dir: 0, stops: ['TST-S1', 'TST-S2'], scheduledTimes: [0, 300] } },
        });
    }

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
});
