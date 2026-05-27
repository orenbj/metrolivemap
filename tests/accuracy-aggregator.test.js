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
    bucketByTier,
    tierCounts,
    headToHead,
    substitutionImpact,
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
    markerDistM = null, blendTier = null, gtfsAgeS = null,
} = {}) {
    return {
        recordedAt, tripId, calcEta, gtfsEta, blendEta,
        horizonCalc, horizonGtfs, horizonBlend, markerDistM,
        blendTier, gtfsAgeS,
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


describe("bucketByTier — per-tier blend error breakdown", () => {
    it("groups rows by blendTier and reports MAE + pctOfTotal per tier", () => {
        const flat = flattenSnapshots([
            makeResult({
                snapshots: [
                    // 6 GTFS-tier rows with mean |err|=10
                    ...Array.from({ length: 6 }, () => makeSnap({
                        blendEta: 1_700_000_010, blendTier: "gtfs",
                    })),
                    // 4 calc-tier rows with mean |err|=20
                    ...Array.from({ length: 4 }, () => makeSnap({
                        blendEta: 1_700_000_020, blendTier: "calc",
                    })),
                ],
            }),
        ]);
        const out = bucketByTier(flat);
        expect(out.gtfs.n).toBe(6);
        expect(out.gtfs.mae).toBe(10);
        expect(out.gtfs.pctOfTotal).toBe(60);
        expect(out.calc.n).toBe(4);
        expect(out.calc.mae).toBe(20);
        expect(out.calc.pctOfTotal).toBe(40);
    });

    it("returns an empty object when no rows have blendTier set", () => {
        const flat = flattenSnapshots([
            makeResult({ snapshots: [makeSnap({ blendEta: 1_700_000_005 })] }),
        ]);
        expect(bucketByTier(flat)).toEqual({});
    });

    it("handles all six tier values without crashing", () => {
        const tiers = ["gtfs", "gtfs-stale", "gtfs-implausible", "origin-suppressed", "calc", "no-data"];
        const flat = flattenSnapshots([
            makeResult({
                snapshots: tiers.map(t => makeSnap({ blendEta: 1_700_000_010, blendTier: t })),
            }),
        ]);
        const out = bucketByTier(flat);
        for (const t of tiers) expect(out[t]).toBeDefined();
    });
});

describe("tierCounts — lightweight tier mix", () => {
    it("counts each tier and uses untagged bucket for null", () => {
        const flat = flattenSnapshots([
            makeResult({
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_010, blendTier: "gtfs" }),
                    makeSnap({ blendEta: 1_700_000_010, blendTier: "gtfs" }),
                    makeSnap({ blendEta: 1_700_000_010, blendTier: "calc" }),
                    makeSnap({ blendEta: 1_700_000_010 }), // no tier
                ],
            }),
        ]);
        const counts = tierCounts(flat);
        expect(counts.gtfs).toBe(2);
        expect(counts.calc).toBe(1);
        expect(counts.untagged).toBe(1);
    });
});

describe("flattenSnapshots — blendTier + gtfsAgeS passthrough", () => {
    it("preserves the new tier visibility fields on every row", () => {
        const flat = flattenSnapshots([
            makeResult({
                snapshots: [
                    makeSnap({ blendEta: 1_700_000_010, blendTier: "gtfs", gtfsAgeS: 12 }),
                    makeSnap({ blendEta: 1_700_000_020, blendTier: "calc", gtfsAgeS: null }),
                ],
            }),
        ]);
        expect(flat[0].blendTier).toBe("gtfs");
        expect(flat[0].gtfsAgeS).toBe(12);
        expect(flat[1].blendTier).toBe("calc");
        expect(flat[1].gtfsAgeS).toBeNull();
    });
});

describe('headToHead — 2-way calc vs gtfs', () => {
    it('counts strict wins on the overlap set; blend is not compared', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    // gtfs closer: |g|=5 vs |c|=10
                    makeSnap({ calcEta: 1_700_000_010, gtfsEta: 1_700_000_005, blendEta: 1_700_000_005 }),
                    // calc closer: |c|=2 vs |g|=8
                    makeSnap({ calcEta: 1_699_999_998, gtfsEta: 1_700_000_008, blendEta: 1_700_000_008 }),
                    // tie: |c|=|g|=3
                    makeSnap({ calcEta: 1_700_000_003, gtfsEta: 1_699_999_997, blendEta: 1_699_999_997 }),
                ],
            }),
        ]);
        const h2h = headToHead(flat);
        expect(h2h.n).toBe(3);
        expect(h2h.calcWins).toBe(1);
        expect(h2h.gtfsWins).toBe(1);
        expect(h2h.ties).toBe(1);
        expect(h2h).not.toHaveProperty('blendWins');
    });

    it('ignores rows missing either source', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({ calcEta: 1_700_000_010, gtfsEta: null }),       // calc-only
                    makeSnap({ calcEta: null,         gtfsEta: 1_700_000_005 }), // gtfs-only
                    makeSnap({ calcEta: 1_700_000_002, gtfsEta: 1_700_000_005 }), // both
                ],
            }),
        ]);
        expect(headToHead(flat).n).toBe(1);
    });

    it('returns {n: 0} when no overlap rows exist', () => {
        const flat = flattenSnapshots([
            makeResult({ snapshots: [makeSnap({ calcEta: 1_700_000_010 })] }),
        ]);
        expect(headToHead(flat)).toEqual({ n: 0 });
    });
});

describe('substitutionImpact — did the gate help or hurt?', () => {
    it('counts helped/hurt over gtfs-implausible rows only', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    // implausible + calc closer to actual than suppressed gtfs → HELPED
                    // |calcErr|=5, |gtfsErr|=20 (we showed calc, which was closer)
                    makeSnap({
                        calcEta: 1_699_999_995, gtfsEta: 1_700_000_020,
                        blendEta: 1_699_999_995, blendTier: 'gtfs-implausible',
                    }),
                    // implausible + calc further than suppressed gtfs → HURT
                    // |calcErr|=30, |gtfsErr|=5
                    makeSnap({
                        calcEta: 1_700_000_030, gtfsEta: 1_700_000_005,
                        blendEta: 1_700_000_030, blendTier: 'gtfs-implausible',
                    }),
                    // gtfs tier — substitution didn't happen, excluded from impact
                    makeSnap({
                        calcEta: 1_700_000_010, gtfsEta: 1_700_000_005,
                        blendEta: 1_700_000_005, blendTier: 'gtfs',
                    }),
                ],
            }),
        ]);
        const imp = substitutionImpact(flat);
        expect(imp.n).toBe(2);
        expect(imp.helped).toBe(1);
        expect(imp.hurt).toBe(1);
        expect(imp.neutral).toBe(0);
        // (|calcErr| - |gtfsErr|) summed: (5-20) + (30-5) = +10; /2 = 5
        expect(imp.avgDeltaS).toBe(5);
    });

    it('returns null when no gtfs-implausible rows exist', () => {
        const flat = flattenSnapshots([
            makeResult({
                snapshots: [
                    makeSnap({ calcEta: 1_700_000_010, gtfsEta: 1_700_000_005, blendTier: 'gtfs' }),
                    makeSnap({ calcEta: 1_700_000_010, gtfsEta: 1_700_000_005, blendTier: 'calc' }),
                ],
            }),
        ]);
        expect(substitutionImpact(flat)).toBeNull();
    });

    it('counts a tie as neutral, not hurt', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    makeSnap({
                        calcEta: 1_700_000_005, gtfsEta: 1_699_999_995,
                        blendTier: 'gtfs-implausible',
                    }),
                ],
            }),
        ]);
        const imp = substitutionImpact(flat);
        expect(imp.helped).toBe(0);
        expect(imp.hurt).toBe(0);
        expect(imp.neutral).toBe(1);
        expect(imp.avgDeltaS).toBe(0);
    });

    it('reports positive avgDeltaS when substitution hurt on average', () => {
        const flat = flattenSnapshots([
            makeResult({
                actualUnix: 1_700_000_000,
                snapshots: [
                    // 3 rows of "hurt by ~20s each"
                    makeSnap({
                        calcEta: 1_700_000_025, gtfsEta: 1_700_000_005,
                        blendTier: 'gtfs-implausible',
                    }),
                    makeSnap({
                        calcEta: 1_700_000_028, gtfsEta: 1_700_000_008,
                        blendTier: 'gtfs-implausible',
                    }),
                    makeSnap({
                        calcEta: 1_700_000_022, gtfsEta: 1_700_000_002,
                        blendTier: 'gtfs-implausible',
                    }),
                ],
            }),
        ]);
        const imp = substitutionImpact(flat);
        expect(imp.n).toBe(3);
        expect(imp.hurt).toBe(3);
        expect(imp.avgDeltaS).toBe(20); // gate degraded accuracy by ~20s/row on average
    });
});
