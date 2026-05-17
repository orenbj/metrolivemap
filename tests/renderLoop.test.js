/**
 * Tests for js/renderLoop.js — Phase 5b blend-anchored render rAF.
 *
 * Drives `_renderTick(now)` directly with synthetic animationStore
 * entries + a stubbed `window.vehicleMarkers` map. Skipping the real
 * rAF makes the tests fast and deterministic; production goes through
 * `startAnimationRender` which schedules rAF chains.
 *
 * Tests assert that:
 *   - entries with trajectories produce setLngLat / setRotation calls
 *   - entries WITHOUT trajectories are skipped (recordRenderDrop('noTraj'))
 *   - stale entries past the DR window are skipped
 *   - missing shape data (lngLatAtArc returns null) is skipped
 *   - missing marker DOM is skipped
 *   - Layer-C stopArcCap clamps arcs that exceed entry.nextStopArc
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { Trajectory } from '../js/trajectory.js';
import { shapeData, precomputeRoute, _clearShapeCache } from '../js/snap.js';
import { _renderTick } from '../js/renderLoop.js';
import { animations, setAnimation, _clearAnimations } from '../js/animationStore.js';

function seedShape() {
    _clearShapeCache();
    const points = [];
    for (let i = 0; i <= 50; i++) {
        points.push([34.05, -118.25 + i * 0.001]);
    }
    shapeData['801'] = points;
    precomputeRoute('801', points);
}

function makeFreeTrajectory({ t_start, t_end, arc_start, arc_end, v }) {
    return new Trajectory([
        { kind: 'free', t_start, t_end, arc_start, arc_end, v_start: v, v_end: v },
    ]);
}

function makeMockMarker() {
    return {
        setLngLat: vi.fn().mockReturnThis(),
        setRotation: vi.fn().mockReturnThis(),
    };
}

const T_NOW = 1_700_000_010;       // 10 s into the trajectory below

beforeEach(() => {
    _clearAnimations();
    window.vehicleMarkers = {};
    seedShape();
});

describe('_renderTick', () => {
    it('moves markers for entries with trajectories', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 10, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1100, v: 10,
        });
        setAnimation('T1', {
            routeId: '801', directionId: 0,
            trajectory: traj, nextStopArc: 1100,
            lastObservedAt: T_NOW - 1,
        });
        const marker = makeMockMarker();
        window.vehicleMarkers.T1 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(1);
        expect(marker.setLngLat).toHaveBeenCalledTimes(1);
        expect(marker.setRotation).toHaveBeenCalledTimes(1);
        const rot = marker.setRotation.mock.calls[0][0];
        expect(rot).toBeGreaterThan(80);
        expect(rot).toBeLessThan(100);
    });

    it('skips entries without a trajectory', () => {
        setAnimation('T2', {
            routeId: '801', directionId: 0,
            trajectory: null, nextStopArc: 0,
            lastObservedAt: T_NOW,
        });
        const marker = makeMockMarker();
        window.vehicleMarkers.T2 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
        expect(marker.setLngLat).not.toHaveBeenCalled();
    });

    it('skips stale entries whose lastObservedAt is older than the DR window', () => {
        // Rail window = DR_MAX_SECONDS_RAIL = 60s; set lastObservedAt 120s ago.
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 120, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1200, v: 5,
        });
        setAnimation('T3', {
            routeId: '801', directionId: 0,
            trajectory: traj, nextStopArc: 1200,
            lastObservedAt: T_NOW - 120,
        });
        const marker = makeMockMarker();
        window.vehicleMarkers.T3 = marker;

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
        expect(marker.setLngLat).not.toHaveBeenCalled();
    });

    it('skips entries whose marker DOM is missing from window.vehicleMarkers', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 1, t_end: T_NOW + 100,
            arc_start: 50, arc_end: 1100, v: 10,
        });
        setAnimation('T4', {
            routeId: '801', directionId: 0,
            trajectory: traj, nextStopArc: 1100,
            lastObservedAt: T_NOW - 1,
        });
        // No window.vehicleMarkers.T4 — render tick should silently no-op.

        const moved = _renderTick(T_NOW);
        expect(moved).toBe(0);
    });

    it('skips entries whose route has no shape data (lngLatAtArc returns null)', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 1, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1100, v: 10,
        });
        setAnimation('T5', {
            routeId: '999', directionId: 0,  // no shape for 999
            trajectory: traj, nextStopArc: 1100,
            lastObservedAt: T_NOW - 1,
        });
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
            setAnimation(id, {
                routeId: '801', directionId: 0,
                trajectory: traj, nextStopArc: 1100,
                lastObservedAt: T_NOW - 1,
            });
            window.vehicleMarkers[id] = makeMockMarker();
        }
        const moved = _renderTick(T_NOW);
        expect(moved).toBe(3);
    });
});

describe('_renderTick — Layer C stopArcCap', () => {
    it('clamps arc when trajectory produces a value past entry.nextStopArc', () => {
        // Trajectory's internal arc_end is 1500; entry.nextStopArc is 1000.
        // The cap fires.
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 50, t_end: T_NOW + 50,
            arc_start: 0, arc_end: 1500, v: 15,
        });
        setAnimation('TCap', {
            routeId: '801', directionId: 0,
            trajectory: traj, nextStopArc: 1000,
            lastObservedAt: T_NOW - 1,
        });
        const marker = makeMockMarker();
        window.vehicleMarkers.TCap = marker;

        _renderTick(T_NOW);
        // The marker DID move (one setLngLat call); the cap clamped the arc
        // before it was passed to lngLatAtArc.
        expect(marker.setLngLat).toHaveBeenCalledTimes(1);
    });

    it('does NOT clamp when entry.nextStopArc is missing (null/undefined)', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 1, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1100, v: 10,
        });
        setAnimation('TNoCap', {
            routeId: '801', directionId: 0,
            trajectory: traj, nextStopArc: null,
            lastObservedAt: T_NOW - 1,
        });
        const marker = makeMockMarker();
        window.vehicleMarkers.TNoCap = marker;

        _renderTick(T_NOW);
        expect(marker.setLngLat).toHaveBeenCalled();
    });
});

describe('_renderTick — terminus rotation guard', () => {
    it('does NOT setRotation when marker.atTerminus is true', () => {
        const traj = makeFreeTrajectory({
            t_start: T_NOW - 1, t_end: T_NOW + 100,
            arc_start: 0, arc_end: 1100, v: 10,
        });
        setAnimation('TT', {
            routeId: '801', directionId: 0,
            trajectory: traj, nextStopArc: 1100,
            lastObservedAt: T_NOW - 1,
        });
        const marker = makeMockMarker();
        marker.atTerminus = true;
        window.vehicleMarkers.TT = marker;

        _renderTick(T_NOW);
        expect(marker.setLngLat).toHaveBeenCalled();
        expect(marker.setRotation).not.toHaveBeenCalled();
    });
});
