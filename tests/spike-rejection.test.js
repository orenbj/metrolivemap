/**
 * Tests for isGpsSpike() — the multi-gate GPS spike filter in markers.js.
 *
 * Three independent gates fire (in order):
 *   1. Rail arc-distance jump (only when shape data is loaded)
 *   2. Implausible straight-line speed (>50 m/s) with stop-radius bypass
 *   3. Predict-then-validate against last known velocity
 *
 * Each test isolates one gate by setting up the marker / fixture so the
 * other gates would otherwise pass.
 *
 * Diagnostic emphasis: this suite logs which gate fires per scenario so
 * future tuning of GPS_SPIKE_STOP_RADIUS_M / RAIL_ARC_SPIKE_NOISE_M / etc.
 * has a paper trail.
 */

import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

import { isGpsSpike } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals, resetGlobals } from './_helpers/globals.js';
import { logMarkdownTable } from './_helpers/diagnostics.js';
import { MAX_PLAUSIBLE_SPEED_MPS } from '../js/config.js';

const M_PER_DEG_LAT = 111_111;

const _gateLog = [];

beforeEach(() => {
    installGlobals();
});
afterAll(() => {
    logMarkdownTable('isGpsSpike — gate firings', _gateLog);
});

function record(scenario, expected, gate) {
    _gateLog.push({ scenario, expected, gate });
}

describe('isGpsSpike — accept paths', () => {
    it('accepts a small displacement at normal speed', () => {
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature({ lngLat: [-118.260, 34.0605] });
        const result = isGpsSpike(marker, vehicle, -118.260, 34.0605, 1000, 990);
        expect(result).toBe(false);
        record('5m displacement, 10s elapsed', false, 'none');
    });

    it('accepts a fix below MAX_PLAUSIBLE_SPEED_MPS', () => {
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature();
        // 100 m in 10 s = 10 m/s — well under 50 m/s
        const newLat = 34.060 + 100 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1000, 990)).toBe(false);
        record('100m / 10s', false, 'none');
    });
});

describe('isGpsSpike — implausible speed gate', () => {
    it('rejects a fix exceeding MAX_PLAUSIBLE_SPEED_MPS with no nearby stop', () => {
        installGlobals({ stops: {} }); // no stops → no rescue
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature({ stopId: null });
        // 2 km in 1 s = 2000 m/s
        const newLat = 34.060 + 2000 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1001, 1000)).toBe(true);
        record('2km/1s, no stop data', true, 'speed');
    });

    it('rejects implausible speed when stop is far (>5 km)', () => {
        installGlobals({
            stops: { '80202': { lat: 34.060, lon: -118.260, name: 's' } },
        });
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature({ stopId: '80202' });
        // Jump 100 km away; stop is at the original position → distToStop > 5km → reject
        const newLat = 34.060 + 100_000 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1001, 1000)).toBe(true);
        record('100km jump, stop far away', true, 'speed');
    });

    it('accepts implausible speed when fix lands near (<1.5 km of) the next stop', () => {
        // Vehicle at lat 34.060; "true" stop is 1 km north. Big GPS jump that
        // happens to land near the stop → rescued (1 km < GPS_SPIKE_STOP_RADIUS_M=1500).
        const stopLat = 34.060 + 1000 / M_PER_DEG_LAT;
        installGlobals({
            stops: { '80202': { lat: stopLat, lon: -118.260, name: 's' } },
        });
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature({ stopId: '80202' });
        // 1 km in 1s = 1000 m/s — implausible — but lands near stop
        expect(isGpsSpike(marker, vehicle, -118.260, stopLat, 1001, 1000)).toBe(false);
        record('teleport to stop within 5km', false, 'stop-radius bypass');
    });
});

describe('isGpsSpike — predict-then-validate gate', () => {
    it('rejects when actual fix diverges from predicted by more than tolerance + stop is far', () => {
        // Marker has a westward velocity; new fix lands far east → prediction error large
        installGlobals({ stops: {} });
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            // ~1 m/s westward
            lastVelocity: { dLng: -0.000_009, dLat: 0, speedMps: 1 },
        });
        const vehicle = makeFeature({ stopId: null });
        // Jump 500 m east (away from prediction; >GPS_SPIKE_MIN_DIST_M=200m)
        const newLng = -118.260 + 500 / (M_PER_DEG_LAT * Math.cos(34.060 * Math.PI / 180));
        expect(isGpsSpike(marker, vehicle, newLng, 34.060, 1010, 1000)).toBe(true);
        record('predicted west, actual 500m east, no stop', true, 'predict');
    });

    it('does not invoke predict gate on cold-start (no lastVelocity)', () => {
        const marker  = makeMarker({ lngLat: [-118.260, 34.060], lastVelocity: null });
        const vehicle = makeFeature();
        // Same fix → distMeters = 0 → still passes
        expect(isGpsSpike(marker, vehicle, -118.260, 34.060, 1010, 1000)).toBe(false);
        record('cold-start, no velocity reference', false, 'none');
    });

    it('rescues a predict-failure when fix lands within GPS_SPIKE_STOP_RADIUS of the next stop', () => {
        const stopLat = 34.060 + 200 / M_PER_DEG_LAT;
        installGlobals({
            stops: { '80202': { lat: stopLat, lon: -118.260, name: 's' } },
        });
        const marker  = makeMarker({
            lngLat: [-118.260, 34.060],
            lastVelocity: { dLng: -0.000_009, dLat: 0, speedMps: 1 },
        });
        const vehicle = makeFeature({ stopId: '80202' });
        // Jump 200 m north (towards stop) — sub-MAX_PLAUSIBLE_SPEED so speed gate passes,
        // but predict-validate would fail; stop rescue applies.
        expect(isGpsSpike(marker, vehicle, -118.260, stopLat, 1011, 1000)).toBe(false);
        record('predict-fail near stop', false, 'stop-radius bypass');
    });

    it('does not flag tiny displacements even when prediction errs', () => {
        // distMeters < GPS_SPIKE_MIN_DIST_M → predict gate is bypassed
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            lastVelocity: { dLng: -0.000_009, dLat: 0, speedMps: 1 },
        });
        const vehicle = makeFeature();
        // 10 m east displacement — tiny
        const newLng = -118.260 + 10 / (M_PER_DEG_LAT * Math.cos(34.060 * Math.PI / 180));
        expect(isGpsSpike(marker, vehicle, newLng, 34.060, 1010, 1000)).toBe(false);
        record('10m displacement (sub-min)', false, 'none');
    });
});

describe('isGpsSpike — elapsed measured from last accepted fix', () => {
    // After a rejection streak, marker.timestamp (passed as prevTs) is bumped
    // forward each frame while the reference position (lastSnap / lastVelocity)
    // stays at the last ACCEPTED fix. The spike budget must scale with the time
    // since that accepted fix (_lastAcceptedTs), not the one-cycle prevTs gap, or
    // a legitimate multi-cycle catch-up reads as faster-than-possible and the
    // marker stays frozen stops behind its own next-stop label (the D/E/K bug).

    it('accepts a multi-cycle catch-up when budgeted from _lastAcceptedTs', () => {
        installGlobals({ stops: {} }); // no stop rescue — isolate the time budget
        const marker = makeMarker({ lngLat: [-118.260, 34.060] });
        // Reference position last accepted 90 s ago; prevTs was bumped to 9 s ago
        // by intervening rejected frames.
        marker._lastAcceptedTs = 1000;
        const vehicle = makeFeature({ stopId: null });
        // 1000 m north. Over the bumped 9 s gap that's 111 m/s (would reject);
        // over the true 90 s since the accepted fix it's 11 m/s (accept).
        const newLat = 34.060 + 1000 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1090, 1081)).toBe(false);
        record('1000m, prevTs 9s but accepted 90s ago', false, 'none');
    });

    it('still rejects a genuine far spike even over the larger budget', () => {
        installGlobals({ stops: {} });
        const marker = makeMarker({ lngLat: [-118.260, 34.060] });
        marker._lastAcceptedTs = 1000;
        const vehicle = makeFeature({ stopId: null });
        // 100 km north: 1111 m/s even over the full 90 s → real spike, reject.
        const newLat = 34.060 + 100_000 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1090, 1081)).toBe(true);
        record('100km over 90s accepted-budget', true, 'speed');
    });

    it('falls back to prevTs when _lastAcceptedTs is absent (unchanged steady state)', () => {
        installGlobals({ stops: {} });
        const marker = makeMarker({ lngLat: [-118.260, 34.060] }); // no _lastAcceptedTs
        const vehicle = makeFeature({ stopId: null });
        // 1000 m in the 9 s prevTs gap = 111 m/s → reject, exactly as before.
        const newLat = 34.060 + 1000 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1090, 1081)).toBe(true);
        record('no _lastAcceptedTs → prevTs budget', true, 'speed');
    });
});

describe('isGpsSpike — sanity bounds', () => {
    it('handles zero elapsed time without dividing by zero', () => {
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature();
        // Same timestamp — elapsed = 0; speed gate skipped
        expect(isGpsSpike(marker, vehicle, -118.260, 34.0605, 1000, 1000)).toBe(false);
    });

    it(`rejects when straight-line speed > ${MAX_PLAUSIBLE_SPEED_MPS} m/s exactly`, () => {
        installGlobals({ stops: {} });
        const marker  = makeMarker({ lngLat: [-118.260, 34.060] });
        const vehicle = makeFeature({ stopId: null });
        // Just over 50 m/s: 51 m in 1 s
        const newLat = 34.060 + 51 / M_PER_DEG_LAT;
        expect(isGpsSpike(marker, vehicle, -118.260, newLat, 1001, 1000)).toBe(true);
    });
});
