/**
 * Tests for tests/_lib/accuracy-aggregator.js — the shared aggregator used by
 * the browser harness, Node harness, and headless CI capture.
 *
 * Focus areas:
 *   - flattenSnapshots passes through cluster keys (tripId, targetStopId) and
 *     the new markerDistM field so cluster-bootstrap and dot-arrival analysis
 *     have what they need
 *   - new transit-aware metrics (asymmetricEarlyLoss, minuteBucketAccuracy, mdae)
 *   - cluster bootstrap produces reproducible results given a fixed seed,
 *     resamples whole clusters (not rows), and CIs widen when within-cluster
 *     correlation is high
 *   - paired bootstrapMaeDiffCI flags real differences and abstains on noise
 */

import { describe, it, expect } from 'vitest';
import {
    flattenSnapshots,
    asymmetricEarlyLoss,
    minuteBucketAccuracy,
    mdae,
    bootstrapCI,
    bootstrapMaeCI,
    bootstrapWithinCI,
    bootstrapMaeDiffCI,
} from './_lib/accuracy-aggregator.js';

// Small builder so tests stay readable.
function makeResult({
    tripId = 'T-1', vehicleId = 'V-1', stopId = 'S-1', routeId = '801',
    actualUnix = 1_700_000_000, snapshots = [],
} = {}) {
    return { tripId, vehicleId, stopId, routeId, actualUnix, snapshots };
}
function makeSnap({
    recordedAt = 1_699_999_940, tripId = 'T-1',
    calcEta = null, gtfsEta = null, blendEta = null,
    horizonCalc = null, horizonGtfs = null, horizonBlend = null,
    markerDistM = null,
} = {}) {
    return {
        recordedAt, tripId, calcEta, gtfsEta, blendEta,
        horizonCalc, horizonGtfs, horizonBlend, markerDistM,
        intermediates: null, adherence: null, atOrigin: false,
        speedMult: null, capped: false, snapDevM: null,
    };
}

describe('flattenSnapshots — cluster keys and dot-arrival passthrough', () => {
    it('attaches tripId, targetStopId, actualUnix, recordedAt to every row', () => {
        const results = [makeResult({
            tripId: 'T-7', stopId: 'STOP-A', actualUnix: 1_700_000_000,
            snapshots: [
                makeSnap({ recordedAt: 1_699_999_940, calcEta: 1_700_000_005 }),
                makeSnap({ recordedAt: 1_699_999_955, calcEta: 1_700_000_002 }),
            ],
        })];
        const flat = flattenSnapshots(results);
        expect(flat).toHaveLength(2);
        for (const row of flat) {
            expect(row.tripId).toBe('T-7');
            expect(row.targetStopId).toBe('STOP-A');
            expect(row.actualUnix).toBe(1_700_000_000);
            expect(row.recordedAt).toBeDefined();
        }
    });

    it('passes through markerDistM (default null when missing)', () => {
        const results = [makeResult({
            snapshots: [
                makeSnap({ markerDistM: 287.4 }),
                makeSnap({ markerDistM: null }),
                makeSnap({}), // markerDistM omitted entirely
            ],
        })];
        const flat = flattenSnapshots(results);
        expect(flat[0].markerDistM).toBe(287.4);
        expect(flat[1].markerDistM).toBe(null);
        expect(flat[2].markerDistM).toBe(null);
    });

    it('also keeps raw ETAs so offline replay can recompute the blend', () => {
        const results = [makeResult({
            actualUnix: 1_700_000_000,
            snapshots: [makeSnap({ calcEta: 1_700_000_010, gtfsEta: 1_700_000_005, blendEta: 1_700_000_006 })],
        })];
        const row = flattenSnapshots(results)[0];
        expect(row.calcEta).toBe(1_700_000_010);
        expect(row.gtfsEta).toBe(1_700_000_005);
        expect(row.blendEta).toBe(1_700_000_006);
        // Errors derived as actualUnix - eta — negative = arrived earlier than predicted
        expect(row.calcErr).toBe(-10);
        expect(row.gtfsErr).toBe(-5);
        expect(row.blendErr).toBe(-6);
    });
});

describe('asymmetricEarlyLoss — one-sided overshoot cost', () => {
    it('ignores late-arrivals and only counts early predictions', () => {
        // Sign convention: err = actual - predicted; negative = arrived early
        // (i.e. predicted "later than reality" → overshoot, not the costly side).
        // The costly side is err > 0 in OUR sign? No — err > 0 means actual was
        // LATER than predicted, i.e. we said "soon" when it wasn't. That's the
        // wrong-side. So asymmetricEarlyLoss = mean(max(0, -err)) where -err > 0
        // means actual was later than predicted (predicted too soon).
        //
        // The implementation uses max(0, -err); verify two cases:
        const errs = [-10, +20, -30, +5, 0];  // mix: 3 early, 2 late, 1 on time
        // For err = -10: max(0, -(-10)) = max(0, 10) = 10  ← predicted too soon
        // For err = +20: max(0, -20) = 0                    ← predicted too late, free
        // For err = -30: max(0, 30) = 30
        // For err = +5:  max(0, -5) = 0
        // For err = 0:   0
        // Mean: (10 + 0 + 30 + 0 + 0) / 5 = 8.0
        expect(asymmetricEarlyLoss(errs)).toBe(8);
    });

    it('returns null on empty', () => {
        expect(asymmetricEarlyLoss([])).toBeNull();
        expect(asymmetricEarlyLoss([null, null])).toBeNull();
    });
});

describe('minuteBucketAccuracy — user-perceived rounding match', () => {
    const rows = [
        // predEta=now+45s (bucket 1), actual=now+45s (bucket 1) → match
        { predEta: 1_000_000_045, recordedAt: 1_000_000_000, actualUnix: 1_000_000_045 },
        // predEta=now+65s (bucket 1), actual=now+50s (bucket 1) → match
        { predEta: 1_000_000_065, recordedAt: 1_000_000_000, actualUnix: 1_000_000_050 },
        // predEta=now+75s (bucket 1), actual=now+95s (bucket 2) → MISS
        { predEta: 1_000_000_075, recordedAt: 1_000_000_000, actualUnix: 1_000_000_095 },
        // < 30 s both → bucket 0
        { predEta: 1_000_000_015, recordedAt: 1_000_000_000, actualUnix: 1_000_000_010 },
    ];

    it('counts the fraction of predictions whose minute bucket matches actual', () => {
        // 3 of 4 match → 0.75
        expect(minuteBucketAccuracy(rows)).toBe(0.75);
    });

    it('treats < 30 s predictions as the "Now" bucket (0)', () => {
        const closeRows = [
            { predEta: 1_000_000_020, recordedAt: 1_000_000_000, actualUnix: 1_000_000_010 }, // both 0
            { predEta: 1_000_000_015, recordedAt: 1_000_000_000, actualUnix: 1_000_000_035 }, // 0 vs 1 → miss
        ];
        expect(minuteBucketAccuracy(closeRows)).toBe(0.5);
    });

    it('skips rows missing any required field', () => {
        const mixed = [
            { predEta: null, recordedAt: 1_000_000_000, actualUnix: 1_000_000_050 },
            { predEta: 1_000_000_050, recordedAt: null, actualUnix: 1_000_000_050 },
            { predEta: 1_000_000_050, recordedAt: 1_000_000_000, actualUnix: 1_000_000_050 }, // match
        ];
        expect(minuteBucketAccuracy(mixed)).toBe(1);
    });

    it('returns null on empty input', () => {
        expect(minuteBucketAccuracy([])).toBeNull();
    });
});

describe('mdae — median absolute error', () => {
    it('is robust to one wild outlier vs. MAE', () => {
        const errs = [-2, -1, 0, 1, 2, 600];  // one bad observation
        // MAE = (2+1+0+1+2+600)/6 = 101
        // MdAE = median of [0, 1, 1, 2, 2, 600] = (1+2)/2 = 1.5
        expect(mdae(errs)).toBe(1.5);
    });

    it('returns null on empty', () => {
        expect(mdae([])).toBeNull();
        expect(mdae([null])).toBeNull();
    });
});

describe('bootstrapCI — cluster resampling, reproducibility', () => {
    // Build rows where 10 clusters each contribute 3 highly-correlated snapshots
    function buildCorrelatedRows() {
        const rows = [];
        // Each cluster has a different "true error" but all 3 snapshots are nearly
        // identical (correlation ≈ 1) — the cluster bootstrap should treat them
        // as 10 effective observations, not 30.
        const clusterMeans = [-50, -40, -20, -10, 0, 5, 10, 15, 30, 50];
        clusterMeans.forEach((mean, i) => {
            for (let j = 0; j < 3; j++) {
                rows.push({
                    tripId:       `T-${i}`,
                    targetStopId: 'STOP-X',
                    calcErr:      mean + (j - 1) * 0.5, // tiny within-cluster noise
                });
            }
        });
        return rows;
    }

    it('is deterministic given a fixed seed', () => {
        const rows = buildCorrelatedRows();
        const a = bootstrapMaeCI(rows, 'calcErr', { iters: 200, seed: 7 });
        const b = bootstrapMaeCI(rows, 'calcErr', { iters: 200, seed: 7 });
        expect(a).toEqual(b);
    });

    it('produces different CIs for different seeds (sanity)', () => {
        const rows = buildCorrelatedRows();
        const a = bootstrapMaeCI(rows, 'calcErr', { iters: 200, seed: 1 });
        const b = bootstrapMaeCI(rows, 'calcErr', { iters: 200, seed: 999 });
        expect(a.lo).not.toBe(b.lo); // very high probability with N=200, K=10
    });

    it('reports the correct cluster count, not row count', () => {
        const rows = buildCorrelatedRows(); // 30 rows in 10 clusters
        const ci = bootstrapMaeCI(rows, 'calcErr', { iters: 50, seed: 1 });
        expect(ci.clusters).toBe(10);
    });

    it('cluster CI is WIDER than row-bootstrap CI when within-cluster correlation is high', () => {
        const rows = buildCorrelatedRows();
        // Cluster bootstrap: resamples 10 trip-stop groups
        const cluster = bootstrapMaeCI(rows, 'calcErr', { iters: 500, seed: 11 });
        const clusterWidth = cluster.hi - cluster.lo;
        // "Row" bootstrap: strip the cluster keys so each row is its own cluster
        const rowsNoCluster = rows.map(r => ({ calcErr: r.calcErr })); // no tripId/targetStopId
        const row = bootstrapMaeCI(rowsNoCluster, 'calcErr', { iters: 500, seed: 11 });
        const rowWidth = row.hi - row.lo;
        // Cluster CI should be meaningfully wider since correlated rows don't
        // independently inform the mean. Expect at least 20% wider.
        expect(clusterWidth).toBeGreaterThan(rowWidth * 1.2);
    });

    it('returns null point/lo/hi gracefully on empty input', () => {
        const ci = bootstrapMaeCI([], 'calcErr', { iters: 10 });
        expect(ci.point).toBeNull();
        expect(ci.clusters).toBe(0);
    });

    it('bootstrapWithinCI reports a fraction with CI bounds in [0, 1]', () => {
        const rows = [];
        for (let i = 0; i < 50; i++) rows.push({
            tripId: `T-${i}`, targetStopId: 'S',
            // half within ±30 s, half outside
            calcErr: i < 25 ? 15 : 90,
        });
        const ci = bootstrapWithinCI(rows, 'calcErr', 30, { iters: 300, seed: 3 });
        expect(ci.point).toBeCloseTo(0.5, 1);
        expect(ci.lo).toBeGreaterThanOrEqual(0);
        expect(ci.hi).toBeLessThanOrEqual(1);
    });
});

describe('bootstrapMaeDiffCI — paired comparison', () => {
    it('detects a real difference when A is consistently better', () => {
        // 20 paired observations, A's error always strictly closer to zero
        const rows = [];
        for (let i = 0; i < 20; i++) rows.push({
            tripId: `T-${i}`, targetStopId: 'S',
            errA: 5,    // |err| = 5
            errB: 30,   // |err| = 30
        });
        const ci = bootstrapMaeDiffCI(rows, 'errA', 'errB', { iters: 500, seed: 5 });
        // A's MAE − B's MAE = 5 − 30 = -25
        expect(ci.point).toBeCloseTo(-25, 1);
        // Both bounds should be strictly negative — A is significantly better
        expect(ci.hi).toBeLessThan(0);
    });

    it('CI contains zero when the two predictors are equivalent', () => {
        // Errors identical except sign — same |err|, no systematic difference
        const rows = [];
        for (let i = 0; i < 30; i++) rows.push({
            tripId: `T-${i}`, targetStopId: 'S',
            errA: i % 2 ? 10 : -10,
            errB: i % 2 ? -10 : 10,
        });
        const ci = bootstrapMaeDiffCI(rows, 'errA', 'errB', { iters: 500, seed: 9 });
        // Both have MAE = 10 → diff = 0
        expect(ci.point).toBeCloseTo(0, 6);
        expect(ci.lo).toBeLessThanOrEqual(0);
        expect(ci.hi).toBeGreaterThanOrEqual(0);
    });

    it('drops rows where either field is null (paired requirement)', () => {
        const rows = [
            { tripId: 'T-1', targetStopId: 'S', errA: 10,   errB: 20   }, // counts
            { tripId: 'T-2', targetStopId: 'S', errA: null, errB: 30   }, // skip
            { tripId: 'T-3', targetStopId: 'S', errA: 5,    errB: null }, // skip
        ];
        const ci = bootstrapMaeDiffCI(rows, 'errA', 'errB', { iters: 100, seed: 1 });
        // Only one paired row — diff = 10 - 20 = -10
        expect(ci.point).toBe(-10);
    });
});

describe('bootstrapCI — generic statFn', () => {
    it('works with arbitrary statistics (e.g. mean signed error)', () => {
        const rows = [];
        for (let i = 0; i < 30; i++) rows.push({
            tripId: `T-${i}`, targetStopId: 'S',
            calcErr: -5, // every prediction is 5s early
        });
        const ci = bootstrapCI(rows, subset => {
            const v = subset.map(r => r.calcErr).filter(x => x != null);
            return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
        }, { iters: 200, seed: 13 });
        expect(ci.point).toBe(-5);
        expect(ci.lo).toBeCloseTo(-5, 5);
        expect(ci.hi).toBeCloseTo(-5, 5);
    });
});
