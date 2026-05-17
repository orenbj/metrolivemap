/**
 * Tests for js/animationBuilder.js — the heart of the Phase 5b pivot.
 *
 * The load-bearing contract: given a blend ETA at the next stop, the
 * resulting trajectory's `timeAtArc(nextStopArc)` must equal that blend
 * ETA (within the operational-envelope clamp). When it doesn't, the
 * marker animates to a different arrival time than the popup advertises —
 * the exact failure the pivot exists to prevent.
 */

import { describe, it, expect } from 'vitest';
import { buildAnimationTrajectory, _BOUNDS } from '../js/animationBuilder.js';

const RAIL_ROUTE = '801';  // B Line — rail
const BUS_ROUTE  = '901';  // G Line — bus

describe('buildAnimationTrajectory — anchor contract', () => {
    it('produces a trajectory whose arrival time matches blend ETA exactly (plausible inputs)', () => {
        // 500 m to next stop, blend says arrive in 60 s ⇒ 8.33 m/s, in envelope.
        const t_now = 1_700_000_000;
        const blendEta = t_now + 60;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1000, nextStopArc: 1500,
            blendEtaUnix: blendEta, fallbackSpeedMps: null,
        });
        expect(traj).not.toBeNull();
        const arriveTime = traj.timeAtArc(1500);
        expect(arriveTime).toBeCloseTo(blendEta, 1);  // within 0.1 s
    });

    it('uses fallback speed when blend ETA is null', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 0, nextStopArc: 500,
            blendEtaUnix: null, fallbackSpeedMps: 10,
        });
        expect(traj).not.toBeNull();
        // 500 m / 10 m/s = 50 s.
        const arriveTime = traj.timeAtArc(500);
        expect(arriveTime).toBeCloseTo(t_now + 50, 1);
    });

    it('returns null when both blend and fallback are missing', () => {
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: 1_700_000_000,
            currentArc: 0, nextStopArc: 500,
            blendEtaUnix: null, fallbackSpeedMps: null,
        });
        expect(traj).toBeNull();
    });

    it('returns null when arcs are non-finite', () => {
        expect(buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: 1_700_000_000,
            currentArc: NaN, nextStopArc: 500,
            blendEtaUnix: 1_700_000_060, fallbackSpeedMps: null,
        })).toBeNull();
        expect(buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: 1_700_000_000,
            currentArc: 0, nextStopArc: Infinity,
            blendEtaUnix: 1_700_000_060, fallbackSpeedMps: null,
        })).toBeNull();
    });
});

describe('buildAnimationTrajectory — speed envelope clamps (Layer A)', () => {
    it('clamps speed to MAX when blend implies impossible cruise', () => {
        // 1000 m to next stop, blend says arrive in 1 s ⇒ 1000 m/s.
        // Should clamp to MAX_ANIM_MPS_RAIL = 22, arrive ~45 s out.
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 0, nextStopArc: 1000,
            blendEtaUnix: t_now + 1, fallbackSpeedMps: null,
        });
        const arriveTime = traj.timeAtArc(1000);
        const horizon = arriveTime - t_now;
        const expectedHorizon = 1000 / _BOUNDS.MAX_ANIM_MPS_RAIL;
        expect(horizon).toBeCloseTo(expectedHorizon, 1);
        // And the marker visibly arrives LATER than blend predicted.
        expect(arriveTime).toBeGreaterThan(t_now + 1);
    });

    it('clamps speed to MIN when blend implies impossibly slow cruise', () => {
        // 100 m to next stop, blend says arrive in 3600 s ⇒ 0.0278 m/s.
        // Should clamp to MIN_ANIM_MPS_RAIL = 1.0, arrive ~100 s out.
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 0, nextStopArc: 100,
            blendEtaUnix: t_now + 3600, fallbackSpeedMps: null,
        });
        const arriveTime = traj.timeAtArc(100);
        const expectedHorizon = 100 / _BOUNDS.MIN_ANIM_MPS_RAIL;
        expect(arriveTime - t_now).toBeCloseTo(expectedHorizon, 1);
        // And the marker arrives EARLIER than blend predicted.
        expect(arriveTime).toBeLessThan(t_now + 3600);
    });

    it('applies bus envelope for bus routes', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: BUS_ROUTE, nowUnix: t_now,
            currentArc: 0, nextStopArc: 1000,
            blendEtaUnix: t_now + 1, fallbackSpeedMps: null,
        });
        const horizon = traj.timeAtArc(1000) - t_now;
        expect(horizon).toBeCloseTo(1000 / _BOUNDS.MAX_ANIM_MPS_BUS, 1);
    });
});

describe('buildAnimationTrajectory — GPS speed=0 honors vehicle truth', () => {
    it('emits dwell-only trajectory when GPS reports speed=0 with fresh timestamp', () => {
        // Vehicle is stopped at current arc; blend says arrive in 60 s, but
        // GPS truth wins because vehicle just reported it's stopped.
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1000, nextStopArc: 1500,
            blendEtaUnix: t_now + 60, fallbackSpeedMps: null,
            gpsSpeedMps: 0, gpsTimestamp: t_now - 10,
        });
        expect(traj).not.toBeNull();
        // Position stays at currentArc for the dwell duration.
        expect(traj.positionAt(t_now)).toBe(1000);
        expect(traj.positionAt(t_now + 30)).toBe(1000);
    });

    it('reverts to blend-anchored motion when GPS speed=0 report is stale', () => {
        // Last speed=0 fix is 90 s old; treat as lost-GPS, not a real stop.
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1000, nextStopArc: 1500,
            blendEtaUnix: t_now + 60, fallbackSpeedMps: null,
            gpsSpeedMps: 0, gpsTimestamp: t_now - 90,
        });
        // Stale → falls through to blend-anchored free segment.
        expect(traj.positionAt(t_now + 30)).toBeGreaterThan(1000);
    });
});

describe('buildAnimationTrajectory — already-at-stop edge case', () => {
    it('emits dwell-only trajectory when currentArc === nextStopArc', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1500, nextStopArc: 1500,
            blendEtaUnix: t_now + 30, fallbackSpeedMps: null,
        });
        expect(traj).not.toBeNull();
        expect(traj.positionAt(t_now + 10)).toBe(1500);
        expect(traj.positionAt(t_now + 30)).toBe(1500);
    });

    it('dwells at currentArc (NOT nextStopArc) when currentArc > nextStopArc — no pull-backward', () => {
        // GTFS-RT lag: vehicle has physically moved past its declared next stop
        // but marker.properties.stopId hasn't updated yet. The marker must NOT
        // snap backward; it stays at currentArc until the next WS fix updates
        // stopId and rebuilds forward.
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1550, nextStopArc: 1500,  // vehicle is 50 m past
            blendEtaUnix: t_now + 30, fallbackSpeedMps: null,
        });
        expect(traj).not.toBeNull();
        // Marker stays at where the vehicle actually is, not where the
        // (now-stale) next-stop arc says.
        expect(traj.positionAt(t_now)).toBe(1550);
        expect(traj.positionAt(t_now + 10)).toBe(1550);
        expect(traj.positionAt(t_now + 60)).toBe(1550);
    });
});

describe('buildAnimationTrajectory — terminal-arc clamp (Layer B)', () => {
    it('does NOT animate past nextStopArc even when t > arriveUnix', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 0, nextStopArc: 500,
            blendEtaUnix: t_now + 50, fallbackSpeedMps: null,
        });
        // At arrival time, marker is exactly at nextStopArc.
        expect(traj.positionAt(t_now + 50)).toBeCloseTo(500, 1);
        // Well past arrival, marker is STILL at nextStopArc (dwell + clamp).
        expect(traj.positionAt(t_now + 1000)).toBe(500);
        expect(traj.positionAt(t_now + 100000)).toBe(500);
    });

    it('returns currentArc for t before nowUnix (no rewind)', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1000, nextStopArc: 1500,
            blendEtaUnix: t_now + 60, fallbackSpeedMps: null,
        });
        expect(traj.positionAt(t_now - 100)).toBe(1000);
    });
});

describe('buildAnimationTrajectory — single-segment shape (no trailing dwell on the cruise path)', () => {
    it('emits exactly one free segment for the normal cruise-to-stop path', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 0, nextStopArc: 500,
            blendEtaUnix: t_now + 60, fallbackSpeedMps: null,
        });
        expect(traj.segments.length).toBe(1);
        expect(traj.segments[0].kind).toBe('free');
    });

    it('emits a single dwell segment for the at-stop edge case', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 500, nextStopArc: 500,
            blendEtaUnix: t_now + 60, fallbackSpeedMps: null,
        });
        expect(traj.segments.length).toBe(1);
        expect(traj.segments[0].kind).toBe('dwell');
    });

    it('emits a single dwell segment for the GPS-stopped-fresh case', () => {
        const t_now = 1_700_000_000;
        const traj = buildAnimationTrajectory({
            routeCode: RAIL_ROUTE, nowUnix: t_now,
            currentArc: 1000, nextStopArc: 1500,
            blendEtaUnix: t_now + 60, fallbackSpeedMps: null,
            gpsSpeedMps: 0, gpsTimestamp: t_now - 5,
        });
        expect(traj.segments.length).toBe(1);
        expect(traj.segments[0].kind).toBe('dwell');
    });
});
