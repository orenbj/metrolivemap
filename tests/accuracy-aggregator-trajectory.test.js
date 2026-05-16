/**
 * Tests for the Phase 5.6→5.8 trajectory column added to the live-accuracy
 * aggregator. PR #173 plumbed `trajectoryEta` through getArrivalBreakdown;
 * this PR exposes it as a 4th source in `bucketByOwnHorizon`, `bucketByRoute`,
 * `summarize`, and adds a paired-comparison `headToHeadTrajectoryVsBlend`.
 *
 * The Phase 8 decision metric is whether trajectoryEta beats blendEta on
 * snapshots where both predictions exist — that's the paired comparison.
 */

import { describe, it, expect } from 'vitest';
import {
    flattenSnapshots,
    bucketByOwnHorizon,
    bucketByRoute,
    headToHeadTrajectoryVsBlend,
    summarize,
} from './_lib/accuracy-aggregator.js';

function makeResult({
    tripId = 'T-1', vehicleId = 'V-1', stopId = 'S-1', routeId = '801',
    actualUnix = 1_700_000_000, snapshots = [],
} = {}) {
    return { tripId, vehicleId, stopId, routeId, actualUnix, snapshots };
}
function makeSnap({
    recordedAt = 1_699_999_940, tripId = 'T-1',
    calcEta = null, gtfsEta = null, blendEta = null, trajectoryEta = null,
    horizonCalc = null, horizonGtfs = null, horizonBlend = null, horizonTrajectory = null,
} = {}) {
    return {
        recordedAt, tripId,
        calcEta, gtfsEta, blendEta, trajectoryEta,
        horizonCalc, horizonGtfs, horizonBlend, horizonTrajectory,
        intermediates: null, adherence: null, atOrigin: false,
        speedMult: null, capped: false, snapDevM: null, markerDistM: null,
    };
}

describe('flattenSnapshots — trajectory column', () => {
    it('passes through trajectoryEta and computes trajectoryErr', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [makeSnap({
                    trajectoryEta: 1_700_000_010,  // predicted 10s late vs actual
                    horizonTrajectory: 60,
                })],
            }),
        ]);
        expect(flat[0].trajectoryEta).toBe(1_700_000_010);
        // err sign convention: actualUnix - predicted; negative = predicted late
        expect(flat[0].trajectoryErr).toBe(-10);
        expect(flat[0].horizonTrajectory).toBe(60);
    });

    it('leaves trajectoryEta + trajectoryErr null when snapshot has none', () => {
        const flat = flattenSnapshots([
            makeResult({
                snapshots: [makeSnap({ calcEta: 1_700_000_005 })], // no trajectoryEta
            }),
        ]);
        expect(flat[0].trajectoryEta).toBeNull();
        expect(flat[0].trajectoryErr).toBeNull();
        expect(flat[0].horizonTrajectory).toBeNull();
    });
});

describe('bucketByOwnHorizon — trajectory column', () => {
    it('includes trajectory stats in each horizon bucket', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ trajectoryEta: 1_700_000_005, horizonTrajectory: 45 }),
                    makeSnap({ trajectoryEta: 1_700_000_010, horizonTrajectory: 50 }),
                ],
            }),
        ]);
        const out = bucketByOwnHorizon(flat);
        expect(out['30–60 s'].trajectory.n).toBe(2);
        expect(out['30–60 s'].trajectory.mae).toBeGreaterThan(0);
    });

    it("doesn't crash when no snapshot has trajectoryEta", () => {
        const flat = flattenSnapshots([
            makeResult({
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_005, horizonBlend: 40 }),
                ],
            }),
        ]);
        const out = bucketByOwnHorizon(flat);
        // stats() returns null for empty value sets — same behavior as the
        // existing calc/gtfs/blend columns. Consumers must handle null.
        expect(out['30–60 s'].trajectory).toBeNull();
        // Blend WAS populated in this bucket, so its stats are non-null.
        expect(out['30–60 s'].blend?.n).toBe(1);
    });
});

describe('bucketByRoute — trajectory column', () => {
    it('rolls trajectoryErr into per-route stats', () => {
        const flat = flattenSnapshots([
            makeResult({
                routeId: '801',
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ trajectoryEta: 1_700_000_005 }),
                    makeSnap({ trajectoryEta: 1_699_999_995 }),
                ],
            }),
        ]);
        const out = bucketByRoute(flat);
        expect(out['801'].trajectory.n).toBe(2);
    });
});

describe('headToHeadTrajectoryVsBlend — paired Phase 8 metric', () => {
    it('counts only snapshots where BOTH trajectory and blend predictions exist', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_005, trajectoryEta: 1_700_000_002 }), // both present
                    makeSnap({ blendEta: 1_700_000_005 }),                                // trajectory missing
                    makeSnap({ trajectoryEta: 1_700_000_010 }),                          // blend missing
                ],
            }),
        ]);
        const result = headToHeadTrajectoryVsBlend(flat);
        expect(result.n).toBe(1);
    });

    it('counts trajectory wins when |trajErr| < |blendErr|', () => {
        // trajectory predicted exactly right, blend 5s off
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_005, trajectoryEta: 1_700_000_000 }),
                ],
            }),
        ]);
        const result = headToHeadTrajectoryVsBlend(flat);
        expect(result.trajectoryWins).toBe(1);
        expect(result.blendWins).toBe(0);
        expect(result.medianDelta).toBe(-5);  // 0 (traj) - 5 (blend) = -5
    });

    it('counts ties when both predictions are equally off', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_005, trajectoryEta: 1_700_000_005 }),
                ],
            }),
        ]);
        const result = headToHeadTrajectoryVsBlend(flat);
        expect(result.ties).toBe(1);
        expect(result.trajectoryWins).toBe(0);
        expect(result.blendWins).toBe(0);
    });

    it('returns {n: 0} when no snapshot has both predictions', () => {
        const result = headToHeadTrajectoryVsBlend([]);
        expect(result.n).toBe(0);
    });
});

describe('summarize — full output includes trajectory', () => {
    it('overall stats has a trajectory entry', () => {
        const summary = summarize({
            results: [makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [makeSnap({ trajectoryEta: 1_700_000_010 })],
            })],
        });
        expect(summary.overall.trajectory).toBeDefined();
        expect(summary.overall.trajectory.n).toBe(1);
    });

    it('includes headToHeadTrajectoryVsBlend in the summary object', () => {
        const summary = summarize({
            results: [makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_005, trajectoryEta: 1_700_000_002 }),
                ],
            })],
        });
        expect(summary.headToHeadTrajectoryVsBlend).toBeDefined();
        expect(summary.headToHeadTrajectoryVsBlend.n).toBe(1);
    });
});
