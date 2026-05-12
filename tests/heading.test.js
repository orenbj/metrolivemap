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

    it('uses tangent on cold-start when no downstream bearing is available', () => {
        // No matching trip → downstreamBearing returns null; no prevHeading → tangent is best available
        installGlobals({ trips: {} });
        const marker = makeMarker({
            heading: null,  // cold-start: no prior heading resolved
            lngLat: [-118.260, 34.060],
            lastSnap: { tangentForward: 45, arcMeters: 1000 },
        });
        const vehicle = makeFeature({ speed: 5, stopId: null });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(45);
    });

    it('holds prevHeading over ambiguous tangent when no downstream bearing is available', () => {
        // No matching trip → downstreamBearing returns null; prevHeading is a real resolved bearing —
        // prefer it over the unresolved tangent to prevent 180° flips at stops (e.g. B Line STOPPED_AT)
        installGlobals({ trips: {} });
        const marker = makeMarker({
            heading: 90,  // previously resolved east-facing heading
            lngLat: [-118.260, 34.060],
            lastSnap: { tangentForward: 45, arcMeters: 1000 },
        });
        const vehicle = makeFeature({ speed: 5, stopId: null });
        expect(computeHeading(marker, vehicle, -118.260, 34.060)).toBe(90);
    });
});

describe('computeHeading — upstream-bearing disambiguator (flip-vector fixes)', () => {
    // A-Line fixture: 4 stops south→north at lat 34.040, 34.060, 34.080, 34.100,
    // all at lng -118.260 (a straight northbound line). Direction of travel is
    // due north (0°) when in service.

    it('A. STOPPED_AT terminus, cold-start: upstream catches a reverse-tangent', () => {
        // Train is parked at the terminus with no prior heading. snap window
        // near a stub-track / loop yields tangentForward = 180° (south — wrong).
        // downstreamBearing returns null (terminus has no further stops).
        // Before the fix: returns raw tangent → marker points south.
        // After the fix: upstream from 80303→here = 0° north, disambiguates
        // the reversed tangent to 0°.
        const marker = makeMarker({
            tripId: 'TR-A-1', routeCode: '801',
            lngLat: [-118.260, 34.100],
            stopId: '80404',                       // the trip's last stop
            currentStatus: 'STOPPED_AT',
            heading: null,                         // cold start
            speed: 0,
            lastSnap: { tangentForward: 180, arcMeters: 8000 },
        });
        marker.properties.Heading = null;
        const vehicle = makeFeature({
            tripId: 'TR-A-1', routeCode: '801',
            stopId: '80404', currentStatus: 'STOPPED_AT',
            speed: 0, lngLat: [-118.260, 34.100],
        });
        expect(computeHeading(marker, vehicle, -118.260, 34.100)).toBe(0);
    });

    it('B. All downstream stops too close: upstream provides the disambiguator', () => {
        // Synthetic trip where every downstream stop sits within
        // DOWNSTREAM_MIN_METERS of the marker — downstreamBearing rejects all
        // of them and returns null. Upstream (which uses the same min-distance
        // filter but walks backward) still finds a usable reference.
        installGlobals({
            trips: {
                'TR-HUB': {
                    rc: '801', dir: 0, dest: 'Hub', total: 4,
                    stops: ['UP1', 'CUR', 'D1', 'D2'],
                    scheduledTimes: [0, 120, 240, 360],
                },
            },
            stops: {
                // UP1 is 250 m south of CUR (well outside the 100 m filter).
                'UP1': { lat: 34.07775, lon: -118.260, name: 'Upstream' },
                'CUR': { lat: 34.08000, lon: -118.260, name: 'Current' },
                // D1 and D2 are 30 m and 60 m north of CUR — both inside the filter.
                'D1':  { lat: 34.08027, lon: -118.260, name: 'D1 (close)' },
                'D2':  { lat: 34.08054, lon: -118.260, name: 'D2 (close)' },
            },
        });
        const marker = makeMarker({
            tripId: 'TR-HUB', routeCode: '801',
            lngLat: [-118.260, 34.080],
            stopId: 'CUR',
            currentStatus: 'STOPPED_AT',
            heading: null,
            speed: 0,
            // Tangent reversed (pointing south). Without upstream this branch
            // would have to fall through to `prevHeading ?? tangent` and return
            // the wrong direction.
            lastSnap: { tangentForward: 180, arcMeters: 4000 },
        });
        marker.properties.Heading = null;
        const vehicle = makeFeature({
            tripId: 'TR-HUB', routeCode: '801',
            stopId: 'CUR', currentStatus: 'STOPPED_AT',
            speed: 0, lngLat: [-118.260, 34.080],
        });
        // Upstream from UP1 (south) to here (north) = 0°. Tangent 180° vs ref 0°
        // → delta 180° → flip to 0°.
        expect(computeHeading(marker, vehicle, -118.260, 34.080)).toBe(0);
    });

    it('C. Cold-start, no lastSnap: upstream disambiguates the cold-start snap', () => {
        // The cold-start path 5 used to return snap.tangentForward directly,
        // with no disambiguation step. If shape data isn't loaded in tests
        // hasShapeData() returns false and path 5 doesn't fire — this test
        // verifies the path-5 branch is still reachable AT MOST one of two
        // ways (snap returns null OR upstream takes over). The behaviour we
        // care about: no 180° flip on cold-start at a station the train has
        // already passed multiple of.
        const marker = makeMarker({
            tripId: 'TR-A-1', routeCode: '801',
            lngLat: [-118.260, 34.085],
            stopId: '80303',                       // mid-route
            currentStatus: 'IN_TRANSIT_TO',
            heading: null,
            speed: 5,
            lastSnap: null,
        });
        marker.properties.Heading = null;
        const vehicle = makeFeature({
            tripId: 'TR-A-1', routeCode: '801',
            stopId: '80303', currentStatus: 'IN_TRANSIT_TO',
            speed: 5, lngLat: [-118.260, 34.085],
        });
        // No tangent → branch 3 skipped. downstreamBearing returns ~0° (north)
        // toward 80303 — but wait, 80303 is at 34.080 (SOUTH of marker at 34.085),
        // so bearingToStop returns 180° (south). This is exactly vector D below.
        // Result must NOT be 180° — the train can't be heading south on a
        // northbound trip with prior stops behind us at 34.040 and 34.060.
        const result = computeHeading(marker, vehicle, -118.260, 34.085);
        // Either the upstream-derived bearing (0°) wins, or some fallback —
        // but it can't be the stale southbound bearing.
        expect(Math.abs(result - 180) > 10).toBe(true);
    });

    it('D. Stale stopId points backward: upstream overrides downstream', () => {
        // Marker is at lat 34.085 — north of stop 80303 (lat 34.080) but feed
        // still says stopId='80303' IN_TRANSIT_TO (typical feed lag after a
        // station pass). bearingToStop('80303') returns 180° (south, wrong).
        // upstreamBearing from 80202 (lat 34.060) to here = 0° (north, correct).
        // They disagree by 180° → fix trusts upstream → tangent (0°) is kept.
        const marker = makeMarker({
            tripId: 'TR-A-1', routeCode: '801',
            lngLat: [-118.260, 34.085],
            stopId: '80303',
            currentStatus: 'IN_TRANSIT_TO',
            heading: null,
            speed: 5,
            lastSnap: { tangentForward: 0, arcMeters: 4500 },  // correct (northbound)
        });
        marker.properties.Heading = null;
        const vehicle = makeFeature({
            tripId: 'TR-A-1', routeCode: '801',
            stopId: '80303', currentStatus: 'IN_TRANSIT_TO',
            speed: 5, lngLat: [-118.260, 34.085],
        });
        // Without the fix: downstream=180° vs tangent=0° → delta 180° → flip to 180°. WRONG.
        // With the fix: downstream(180°) vs upstream(0°) disagree → trust upstream → tangent unchanged.
        expect(computeHeading(marker, vehicle, -118.260, 34.085)).toBe(0);
    });

    it('D2. Stale stopId, tangent ALSO reversed: upstream still resolves correctly', () => {
        // Same setup as D, but tangent is also wrong (180°). Upstream (0°) vs
        // tangent (180°) → delta 180° → flip tangent to 0°. End result: 0°.
        const marker = makeMarker({
            tripId: 'TR-A-1', routeCode: '801',
            lngLat: [-118.260, 34.085],
            stopId: '80303',
            currentStatus: 'IN_TRANSIT_TO',
            heading: null,
            speed: 5,
            lastSnap: { tangentForward: 180, arcMeters: 4500 },
        });
        marker.properties.Heading = null;
        const vehicle = makeFeature({
            tripId: 'TR-A-1', routeCode: '801',
            stopId: '80303', currentStatus: 'IN_TRANSIT_TO',
            speed: 5, lngLat: [-118.260, 34.085],
        });
        expect(computeHeading(marker, vehicle, -118.260, 34.085)).toBe(0);
    });

    it('happy path preserved: downstream and upstream both available and agree', () => {
        // Marker mid-route, stopId correct, both bearings ~north. Disambiguation
        // picks downstream (default when agreement is within 90°), tangent is
        // kept aligned. Verifies no regression on the common case.
        const marker = makeMarker({
            tripId: 'TR-A-1', routeCode: '801',
            lngLat: [-118.260, 34.070],            // between 80202 and 80303
            stopId: '80303',                       // next stop is correct
            currentStatus: 'IN_TRANSIT_TO',
            heading: 0,
            speed: 10,
            lastSnap: { tangentForward: 0, arcMeters: 3000 },
        });
        marker.properties.Heading = 0;
        const vehicle = makeFeature({
            tripId: 'TR-A-1', routeCode: '801',
            stopId: '80303', currentStatus: 'IN_TRANSIT_TO',
            speed: 10, lngLat: [-118.260, 34.070],
        });
        expect(computeHeading(marker, vehicle, -118.260, 34.070)).toBe(0);
    });

    it('endpointTangent + only upstream available: returns upstream as reference', () => {
        // Endpoint-window tangent is unreliable (loop tracks, stub spurs).
        // Existing rule: if endpointTangent, return the reference outright.
        // When downstream is null (terminus), we now return upstream — which
        // is the correct direction of travel. Before the fix this branch
        // returned `prevHeading ?? tangent` (raw tangent, possibly reversed).
        const marker = makeMarker({
            tripId: 'TR-A-1', routeCode: '801',
            lngLat: [-118.260, 34.100],            // at terminus
            stopId: '80404',
            currentStatus: 'STOPPED_AT',
            heading: null,
            speed: 0,
            lastSnap: { tangentForward: 270, arcMeters: 8000, endpointTangent: true },
        });
        marker.properties.Heading = null;
        const vehicle = makeFeature({
            tripId: 'TR-A-1', routeCode: '801',
            stopId: '80404', currentStatus: 'STOPPED_AT',
            speed: 0, lngLat: [-118.260, 34.100],
        });
        // Upstream from 80303 to here = 0° (north). Endpoint-tangent shortcut
        // returns the reference directly, ignoring the unreliable tangent.
        expect(computeHeading(marker, vehicle, -118.260, 34.100)).toBe(0);
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
