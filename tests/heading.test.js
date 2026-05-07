/**
 * Tests for computeHeading() — the priority chain that resolves the
 * vehicle marker's display rotation.
 *
 * Order:
 *   1. Stationary hold (speed < 0.5 m/s, no fresh snap tangent)
 *   2. Final-stop hold (within 150 m of trip's terminal stop)
 *   3. Snap tangent + downstreamBearing for ±180° disambiguation
 *   4. downstreamBearing fallback (off-route, busway, first fix)
 *   5. Cold-start snap (no lastSnap, has shape data)
 *   6. prevHeading ?? 0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

import { computeHeading } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';

beforeEach(() => {
    installGlobals();
});

describe('computeHeading — stationary hold', () => {
    it('holds previous heading when speed < 0.5 m/s and no snap tangent', () => {
        const marker = makeMarker({
            heading: 90,
            lastSnap: null,
        });
        marker.properties.Heading = 90;
        const vehicle = makeFeature({ speed: 0.1 });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(90);
    });

    it('does NOT hold when a fresh snap tangent is available (snap is jitter-free)', () => {
        const marker = makeMarker({
            heading: 90,
            lastSnap: { tangentForward: 45, arcMeters: 1000 },
        });
        marker.properties.Heading = 90;
        const vehicle = makeFeature({ speed: 0.1 });
        // Tangent (45°) wins over the held heading (90°), then aligned vs downstream
        const result = computeHeading(marker, vehicle, -118.260, 34.060);
        expect([45, 225]).toContain(result);
    });
});

describe('computeHeading — final-stop hold', () => {
    it('holds heading within 150 m of the trip\'s terminal stop', () => {
        // A-Line terminus is 80404 at (34.100, -118.260). Place vehicle 50 m south of it.
        const marker = makeMarker({
            lngLat: [-118.260, 34.0995],
            heading: 270,
            lastSnap: null,
        });
        marker.properties.Heading = 270;
        const vehicle = makeFeature({ speed: 5 });
        expect(computeHeading(marker, vehicle, -118.260, 34.0995)).toBe(270);
    });

    it('does NOT hold when far from the terminal stop', () => {
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            heading: 270,
            lastSnap: null,
        });
        marker.properties.Heading = 270;
        const vehicle = makeFeature({ speed: 5, stopId: '80303' });
        // Bearing toward 80303 (lat 34.080) is ~0° (north) — should override the held 270°
        const result = computeHeading(marker, vehicle, -118.260, 34.060);
        expect(Math.abs(result)).toBeLessThan(5);
    });
});

describe('computeHeading — snap tangent + disambiguation', () => {
    it('keeps tangent forward when downstream bearing aligns within 90°', () => {
        // tangent says "north"; downstream bearing also says "north" → keep tangent
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            lastSnap: { tangentForward: 0, arcMeters: 1000 },
        });
        const vehicle = makeFeature({ speed: 5, stopId: '80303' /* lat 34.080 — north */ });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(0);
    });

    it('flips tangent by 180° when downstream bearing disagrees by >90°', () => {
        // tangent says "north" (0°); but vehicle is heading toward 80101 (south) →
        // flip to 180° so the arrow points along travel direction.
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            lastSnap: { tangentForward: 0, arcMeters: 1000 },
        });
        // Force vehicle's next stop to be the southern stop
        const vehicle = makeFeature({
            speed: 5, stopId: '80101',
            currentStatus: 'IN_TRANSIT_TO',
        });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(180);
    });

    it('keeps raw tangent when no downstream bearing is available', () => {
        // No matching trip in masterTripsData → downstreamBearing returns null
        installGlobals({ trips: {} });
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            lastSnap: { tangentForward: 45, arcMeters: 1000 },
        });
        const vehicle = makeFeature({ speed: 5, stopId: null });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(45);
    });
});

describe('computeHeading — fallback chain', () => {
    it('uses downstream bearing when no snap tangent exists', () => {
        const marker = makeMarker({
            lngLat: [-118.260, 34.060],
            lastSnap: null,
        });
        const vehicle = makeFeature({ speed: 5, stopId: '80303' });
        // Bearing 34.060 → 34.080 along same lon ≈ 0° (north)
        const result = computeHeading(marker, vehicle, -118.260, 34.060);
        expect(Math.abs(result)).toBeLessThan(5);
    });

    it('returns 0 when no signal is available and no prevHeading', () => {
        installGlobals({ trips: {}, stops: {} });
        const marker = makeMarker({ heading: undefined, lastSnap: null });
        marker.properties.Heading = undefined;
        const vehicle = makeFeature({ speed: 5, stopId: null });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(0);
    });

    it('returns prevHeading as final fallback when no other signal', () => {
        installGlobals({ trips: {}, stops: {} });
        const marker = makeMarker({ heading: 123, lastSnap: null });
        marker.properties.Heading = 123;
        const vehicle = makeFeature({ speed: 5, stopId: null });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(123);
    });
});
