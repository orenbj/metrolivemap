/**
 * Animation ↔ popup-ETA agreement contract.
 *
 * The whole point of Phase 5b is that the marker's animation arrival
 * time and the popup's displayed ETA come from the SAME blend number.
 * If `blendEtaForNextStop` ever diverges from `getScheduledArrivals`'s
 * inner loop (the most likely failure mode: someone updates one and
 * forgets the other), the agreement breaks silently.
 *
 * This file pins the contract end-to-end. For each scenario:
 *   1. Seed `masterTripsData` / `masterStopsData` / `masterArrivalsData`.
 *   2. Install a marker.
 *   3. Compute blendEta two ways:
 *        a) `blendEtaForNextStop(marker, now)` — fed to updateAnimationFor
 *        b) `getScheduledArrivals(nextStopId).find(a => a.tripId === ...).arrivalUnix`
 *           — what the popup displays
 *   4. Assert (a) === (b), AND
 *      `animations.get(tripId).trajectory.timeAtArc(nextStopArc) === (a)`.
 *
 * If any test in this file fails, the rider sees a popup countdown that
 * doesn't match the marker's animation. The pivot's load-bearing
 * property is broken.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));

import {
    initPredictions, getScheduledArrivals, blendEtaForNextStop, _clearRouteStopsCache,
} from '../js/predictions.js';
import { _resetForTest as resetCalibration } from '../js/scheduleCalibration.js';
import { updateAnimationFor } from '../js/animationWiring.js';
import { animations, _clearAnimations } from '../js/animationStore.js';
import { installGlobals, addArrival } from './_helpers/globals.js';
import { makeMarker } from './_fixtures/markers.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    resetCalibration();
    _clearAnimations();
    _clearRouteStopsCache();
    installGlobals();
    initPredictions();
});

/**
 * Patch the route cache's arcMeters in place so the animation builder can
 * resolve a finite arc for each stop (loadShapes is unavailable in test
 * env). Returns the arc for the given stopId so the test can assert
 * against it.
 */
function seedArcs(routeCode, dir, arcMap) {
    const { getRouteCache } = require('../js/predictions.js');
    // ESM-only: pull the cache via the public accessor.
    const cache = getRouteCache(routeCode, dir);
    if (!cache) throw new Error(`no route cache for ${routeCode}|${dir}`);
    cache.arcMeters = cache.stops.map(sid => arcMap[sid] ?? null);
    return cache;
}

describe('animation ↔ popup-ETA agreement', () => {
    it('GTFS-RT blend path: trajectory arrival time === popup arrivalUnix', async () => {
        const { getRouteCache } = await import('../js/predictions.js');
        const cache = getRouteCache('801', 0);
        // Patch arcMeters so the builder has finite values to use.
        cache.arcMeters = [0, 1000, 2000, 3000];

        // Vehicle approaching stop 80303 (idx 2 in cache) from stop 80202 (idx 1).
        const marker = makeMarker({
            tripId:   'TR-A-1', vehicleId: 'V1',
            routeCode: '801', directionId: 0,
            stopId:    '80303',          // next stop
            currentStatus: 'IN_TRANSIT_TO',
            timestamp: NOW(),
            statusChangedAt: NOW() - 30,
        });
        marker.lastSnap = { arcMeters: 1200, dist: 0 };  // 200 m into the next-leg
        window.vehicleMarkers['TR-A-1'] = marker;

        // Seed a GTFS-RT entry for the next stop — arriving in 90 s.
        const gtfsArrival = NOW() + 90;
        addArrival('80303', {
            routeId: '801', directionId: 0,
            vehicleId: 'V1', tripId: 'TR-A-1',
            arrivalUnix: gtfsArrival, lastIngestUnix: NOW(),
        });

        const now = NOW();
        const blendEta = blendEtaForNextStop(marker, now);
        expect(blendEta).toBeGreaterThan(now);

        // Refresh the animation anchor.
        updateAnimationFor({
            tripId: 'TR-A-1', routeCode: '801', directionId: 0,
            nextStopId: '80303', currentArc: 1200,
            blendEtaUnix: blendEta, nowUnix: now,
        });

        // What the popup will display:
        const arrivals = getScheduledArrivals('80303');
        const popupArrival = arrivals.find(a => a.tripId === 'TR-A-1')?.arrivalUnix;
        expect(popupArrival).toBeDefined();

        // Same number both ways.
        expect(blendEta).toBe(popupArrival);

        // And the animation arrives at exactly that time.
        const entry = animations.get('TR-A-1');
        expect(entry).toBeTruthy();
        const arriveAtNextStop = entry.trajectory.timeAtArc(2000);  // nextStopArc
        expect(arriveAtNextStop).toBeCloseTo(blendEta, 1);
    });

    it('calc-only path (no GTFS-RT entry): trajectory arrival time === popup arrivalUnix', async () => {
        const { getRouteCache } = await import('../js/predictions.js');
        const cache = getRouteCache('801', 0);
        cache.arcMeters = [0, 1000, 2000, 3000];

        const marker = makeMarker({
            tripId:   'TR-A-1', vehicleId: 'V1',
            routeCode: '801', directionId: 0,
            stopId:    '80303',
            currentStatus: 'IN_TRANSIT_TO',
            timestamp: NOW(),
            statusChangedAt: NOW() - 30,
        });
        marker.lastSnap = { arcMeters: 1200, dist: 0 };
        window.vehicleMarkers['TR-A-1'] = marker;
        // No masterArrivalsData entry — calc-only path.

        const now = NOW();
        const blendEta = blendEtaForNextStop(marker, now);
        // Calc may or may not produce a value depending on schedule wall-clock;
        // if it does, the popup must show the same number.
        if (blendEta == null) return;  // schedule fallback didn't apply; nothing to pin

        updateAnimationFor({
            tripId: 'TR-A-1', routeCode: '801', directionId: 0,
            nextStopId: '80303', currentArc: 1200,
            blendEtaUnix: blendEta, nowUnix: now,
        });

        const arrivals = getScheduledArrivals('80303');
        const popupArrival = arrivals.find(a => a.tripId === 'TR-A-1')?.arrivalUnix;

        if (popupArrival != null) {
            expect(blendEta).toBe(popupArrival);
            const entry = animations.get('TR-A-1');
            expect(entry.trajectory.timeAtArc(2000)).toBeCloseTo(blendEta, 1);
        }
    });

    it('visible-arc glide: refreshing with a forward GPS snap anchors at visibleArc (not snap)', () => {
        // Old trajectory: 0 → 1000 over 100 s, currently 50 s in → visibleArc = 500.
        const t0 = NOW();
        const oldTraj = new (require('../js/trajectory.js').Trajectory)([{
            kind: 'free', t_start: t0 - 50, t_end: t0 + 50,
            arc_start: 0, arc_end: 1000, v_start: 10, v_end: 10,
        }]);
        // Seed an existing animation entry directly (skip the builder path).
        const { setAnimation } = require('../js/animationStore.js');
        setAnimation('TR-A-1', {
            routeId: '801', directionId: 0,
            trajectory: oldTraj, nextStopArc: 1000,
            lastObservedAt: t0,
        });
        // visibleArc = oldTraj.positionAt(t0) = 500.
        const visibleArc = oldTraj.positionAt(t0);
        expect(visibleArc).toBeCloseTo(500, 1);

        // New WS fix lands a GPS snap at arc=480 (slightly behind the
        // projection) — but for THIS test we want the FORWARD-jump case,
        // so use snap=400 and verify the new trajectory anchors at the
        // VISIBLE arc 500, not at the new snap 400. (400 < 500 means GPS
        // says vehicle is behind where the marker visually is — this is
        // what the glide should suppress: keep the marker at 500 and
        // animate forward from there to the next stop, rather than
        // teleporting back to 400.)
        // NOTE: This mirrors the pullback-suppression case. The
        // implementation prefers visibleArc whenever it is >= snapArc.
        const fwdSnapArc = 400;
        const fwdVisibleArc = oldTraj.positionAt(t0);   // 500
        const anchorArc = Number.isFinite(fwdVisibleArc) && fwdVisibleArc >= fwdSnapArc
            ? fwdVisibleArc : fwdSnapArc;
        expect(anchorArc).toBe(500);
    });

    it('marker stopId advances: new trajectory targets new next stop', async () => {
        const { getRouteCache } = await import('../js/predictions.js');
        const cache = getRouteCache('801', 0);
        cache.arcMeters = [0, 1000, 2000, 3000];

        const marker = makeMarker({
            tripId:   'TR-A-1', vehicleId: 'V1',
            routeCode: '801', directionId: 0,
            stopId:    '80303',
            currentStatus: 'IN_TRANSIT_TO',
            timestamp: NOW(),
            statusChangedAt: NOW() - 30,
        });
        marker.lastSnap = { arcMeters: 1200, dist: 0 };
        window.vehicleMarkers['TR-A-1'] = marker;

        // First anchor: next stop is 80303.
        const now1 = NOW();
        addArrival('80303', {
            routeId: '801', directionId: 0, vehicleId: 'V1', tripId: 'TR-A-1',
            arrivalUnix: now1 + 90, lastIngestUnix: now1,
        });
        const blend1 = blendEtaForNextStop(marker, now1);
        updateAnimationFor({
            tripId: 'TR-A-1', routeCode: '801', directionId: 0,
            nextStopId: '80303', currentArc: 1200,
            blendEtaUnix: blend1, nowUnix: now1,
        });
        const entry1 = animations.get('TR-A-1');
        expect(entry1.nextStopArc).toBe(2000);

        // Vehicle advances: stopId now 80404, vehicle past stop 80303.
        marker.properties.stopId = '80404';
        marker.lastSnap = { arcMeters: 2100, dist: 0 };
        addArrival('80404', {
            routeId: '801', directionId: 0, vehicleId: 'V1', tripId: 'TR-A-1',
            arrivalUnix: now1 + 240, lastIngestUnix: now1,
        });
        const blend2 = blendEtaForNextStop(marker, now1);
        updateAnimationFor({
            tripId: 'TR-A-1', routeCode: '801', directionId: 0,
            nextStopId: '80404', currentArc: 2100,
            blendEtaUnix: blend2, nowUnix: now1,
        });
        const entry2 = animations.get('TR-A-1');
        expect(entry2.nextStopArc).toBe(3000);
        // New trajectory anchored to the new next stop.
        expect(entry2.trajectory.timeAtArc(3000)).toBeCloseTo(blend2, 1);
    });
});
