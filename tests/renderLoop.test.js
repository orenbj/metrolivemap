/**
 * Tests for js/renderLoop.js — Phase 5.4 trajectory-driven render rAF.
 *
 * Strategy: drive `_renderTick(now)` directly with synthetic state + a stubbed
 * `window.vehicleMarkers` map of mock MapLibre Markers. Skipping the real rAF
 * makes the tests fast and deterministic; production goes through
 * `startTrajectoryRender` which schedules rAF chains.
 *
 * Tests assert that:
 *   - states with trajectories produce setLngLat / setRotation calls
 *   - states WITHOUT trajectories (cold start) are skipped
 *   - stale states past the DR window are skipped
 *   - missing snap.shape data (lngLatAtArc returns null) is skipped
 *   - missing marker DOM (state present but no window.vehicleMarkers entry)
 *     is skipped
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { vehicleStateStore } from '../js/phase5State.js';
import { createState, withTrajectory } from '../js/vehicleState.js';
import { Trajectory } from '../js/trajectory.js';
import { shapeData, precomputeRoute, _clearShapeCache } from '../js/snap.js';
import { _renderTick } from '../js/renderLoop.js';

// One straight east-west polyline as our synthetic route. 5 km long, 100 m
// per shape-vertex so `lngLatAtArc` interpolates a non-trivial number of
// segments. Lat 34.05 (around DTLA) — picks up the local longitude scale
// that snap.js uses.
function seedShape() {
    _clearShapeCache();
    const points = [];
    for (let i = 0; i <= 50; i++) {
        // [lat, lng] pairs per snap.js convention (note: pts are [lat, lng])
        points.push([34.05, -118.25 + i * 0.001]);
    }
    shapeData['801'] = points;
    precomputeRoute('801', points);
}

// Build a no-op trajectory: a single 'free' segment of fixed duration.
// We can drive positionAt(t) to any arc inside the segment by choosing t.
function makeFreeTrajectory({ t_start, t_end, arc_start, arc_end, v }) {
    return new Trajectory([
        { kind: 'free', t_start, t_end, arc_start, arc_end, v_start: v, v_end: v },
    ]);
}

// Build a mock MapLibre Marker with vi.fn() setLngLat / setRotation so we can
// assert what the render tick did.
function makeMockMarker() {
    return {
        setLngLat: vi.fn().mockReturnThis(),
        setRotation: vi.fn().mockReturnThis(),
    };
}

const T_NOW = 1_700_000_010;       // 10 s into the trajectory below

beforeEach(() => {
    vehicleStateStore.clear();
    window.vehicleMarkers = {};
    seedShape();
});

describe('_renderTick', () => {
    it('moves markers for states with trajectories', () => {
        // State at arc=0 moving 10 m/s; at t+10s, projected arc = 100m.
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 10, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1100, v: 10,
        });
        let state = createState({
            vehicleId: 'V', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 10, t_now: T_NOW - 10,
        });
        state = withTrajectory(state, traj, T_NOW - 10);
        vehicleStateStore.set(state);

        const marker = makeMockMarker();
        window.vehicleMarkers.T1 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(1);
        expect(marker.setLngLat).toHaveBeenCalledTimes(1);
        // Tangent on an east-pointing polyline is ~90° (clockwise from north).
        // Allow a wide tolerance — snap.js's bearing uses asymmetric tangent
        // windows and the exact value depends on the interpolation slot.
        expect(marker.setRotation).toHaveBeenCalledTimes(1);
        const rot = marker.setRotation.mock.calls[0][0];
        expect(rot).toBeGreaterThan(80);
        expect(rot).toBeLessThan(100);
    });

    it('skips states without a trajectory (cold start)', () => {
        const state = createState({
            vehicleId: 'V', tripId: 'T2', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: T_NOW,
        });
        vehicleStateStore.set(state);
        const marker = makeMockMarker();
        window.vehicleMarkers.T2 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
        expect(marker.setLngLat).not.toHaveBeenCalled();
    });

    it('skips stale states whose lastObservedAt is older than the DR window', () => {
        // Rail DR window is DR_MAX_SECONDS_RAIL = 60s; set lastObservedAt 120s ago.
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 120, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1200, v: 5,
        });
        let state = createState({
            vehicleId: 'V', tripId: 'T3', routeId: '801', directionId: 0,
            arc: 0, velocity: 5, t_now: T_NOW - 120,
        });
        state = withTrajectory(state, traj, T_NOW - 120);
        vehicleStateStore.set(state);
        const marker = makeMockMarker();
        window.vehicleMarkers.T3 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
        expect(marker.setLngLat).not.toHaveBeenCalled();
    });

    it('skips states whose marker DOM is missing from window.vehicleMarkers', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 1, t_end: T_NOW + 100,
            arc_start: 50, arc_end: 1100, v: 10,
        });
        let state = createState({
            vehicleId: 'V', tripId: 'T4', routeId: '801', directionId: 0,
            arc: 50, velocity: 10, t_now: T_NOW - 1,
        });
        state = withTrajectory(state, traj, T_NOW - 1);
        vehicleStateStore.set(state);
        // No window.vehicleMarkers.T4 — render tick should silently no-op.

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
    });

    it('skips states whose route has no shape data (lngLatAtArc returns null)', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 1, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1100, v: 10,
        });
        let state = createState({
            vehicleId: 'V', tripId: 'T5', routeId: '999', directionId: 0,  // no shape for 999
            arc: 0, velocity: 10, t_now: T_NOW - 1,
        });
        state = withTrajectory(state, traj, T_NOW - 1);
        vehicleStateStore.set(state);
        const marker = makeMockMarker();
        window.vehicleMarkers.T5 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
        expect(marker.setLngLat).not.toHaveBeenCalled();
    });

    it('moves multiple vehicles in one tick', () => {
        for (const id of ['V1', 'V2', 'V3']) {
            const traj = makeFreeTrajectory({
                t_start: T_NOW - 1, t_end: T_NOW + 100,
                arc_start: 0, arc_end: 1100, v: 10,
            });
            let state = createState({
                vehicleId: id, tripId: id, routeId: '801', directionId: 0,
                arc: 0, velocity: 10, t_now: T_NOW - 1,
            });
            state = withTrajectory(state, traj, T_NOW - 1);
            vehicleStateStore.set(state);
            window.vehicleMarkers[id] = makeMockMarker();
        }
        const moved = _renderTick(T_NOW);
        expect(moved).toBe(3);
    });
});
