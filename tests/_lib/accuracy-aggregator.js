/**
 * Accuracy aggregator — pure data-transformation helpers shared between
 * the browser harness (tests/eta-live-accuracy.js) and the Node harness
 * (scripts/live-accuracy-harness.js).
 *
 * Exports nothing that touches the DOM, fetches network data, or mutates
 * window globals. Both harnesses maintain their own capture state (pending
 * / arrived) and feed the closing dataset through these helpers.
 */

// ── Sort + percentile helpers ────────────────────────────────────────────────

export function median(sorted) {
    const n = sorted.length;
    if (!n) return null;
    const mid = Math.floor(n / 2);
    return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Linear-interpolation percentile on a pre-sorted array.
 * Returns null for empty input or when n < 5 (sample too small for reliable quantiles).
 */
function _percentile(sortedArr, p) {
    const n = sortedArr.length;
    if (n === 0) return null;
    if (n < 5) return null;
    const idx = p * (n - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sortedArr[lo];
    return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

/**
 * Compute distribution stats for an array of signed errors. Returns null on
 * empty input. n / mean / median use signed values; mae / rmse / within use
 * absolute values.
 */
export function stats(values) {
    const v = values.filter(x => x != null);
    if (!v.length) return null;
    const sortedAbs = [...v].map(Math.abs).sort((a, b) => a - b);
    const sortedSigned = [...v].sort((a, b) => a - b);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    const mae  = sortedAbs.reduce((a, b) => a + b, 0) / sortedAbs.length;
    const rmse = Math.sqrt(sortedAbs.map(e => e * e).reduce((a, b) => a + b, 0) / sortedAbs.length);
    // median uses signed values to detect systematic bias (early vs. late)
    const med  = median(sortedSigned);
    const w30  = sortedAbs.filter(e => e <= 30).length / sortedAbs.length * 100;
    const w60  = sortedAbs.filter(e => e <= 60).length / sortedAbs.length * 100;
    const p10  = _percentile(sortedSigned, 0.10);
    const p50  = _percentile(sortedSigned, 0.50);
    const p90  = _percentile(sortedSigned, 0.90);
    return {
        n:         v.length,
        mean:      +mean.toFixed(1),
        median:    med != null ? +med.toFixed(1) : null,
        mae:       +mae.toFixed(1),
        rmse:      +rmse.toFixed(1),
        within30s: `${w30.toFixed(0)}%`,
        within60s: `${w60.toFixed(0)}%`,
        p10:       p10 != null ? +p10.toFixed(1) : null,
        p50:       p50 != null ? +p50.toFixed(1) : null,
        p90:       p90 != null ? +p90.toFixed(1) : null,
    };
}

/**
 * Flatten the nested capture (results → snapshots) into one row per snapshot
 * with computed signed errors (calcErr / gtfsErr) and pass-through diagnostics.
 *
 * Sign convention: error = actualUnix - predictedEta
 *   negative → arrived earlier than predicted (pessimistic)
 *   positive → arrived later   than predicted (optimistic)
 */
export function flattenSnapshots(results) {
    const flat = [];
    for (const r of results) {
        for (const s of r.snapshots) {
            flat.push({
                // Cluster key: (tripId, targetStopId) groups snapshots that are
                // not independent observations. bootstrapMaeCI uses this to
                // resample clusters rather than rows — otherwise CIs are 5-10x
                // narrower than they should be.
                tripId:        r.tripId,
                vehicleId:     r.vehicleId,
                targetStopId:  r.stopId,
                routeId:       r.routeId,
                actualUnix:    r.actualUnix,
                recordedAt:    s.recordedAt,
                horizonCalc:   s.horizonCalc,
                horizonGtfs:   s.horizonGtfs,
                horizonBlend:  s.horizonBlend ?? null,
                calcEta:       s.calcEta  ?? null,
                gtfsEta:       s.gtfsEta  ?? null,
                blendEta:      s.blendEta ?? null,
                calcErr:       s.calcEta  != null ? r.actualUnix - s.calcEta  : null,
                gtfsErr:       s.gtfsEta  != null ? r.actualUnix - s.gtfsEta  : null,
                blendErr:      s.blendEta != null ? r.actualUnix - s.blendEta : null,
                intermediates: s.intermediates,
                adherence:     s.adherence,
                atOrigin:      s.atOrigin,
                speedMult:     s.speedMult,
                capped:        s.capped,
                snapDevM:      s.snapDevM ?? null,
                markerDistM:   s.markerDistM ?? null,
            });
        }
    }
    return flat;
}

// ── Horizon buckets ──────────────────────────────────────────────────────────

export const DEFAULT_BUCKETS = [
    { label: '< 30 s',    min: 0,   max: 30   },
    { label: '30–60 s',   min: 30,  max: 60   },
    { label: '1–2 min',   min: 60,  max: 120  },
    { label: '2–5 min',   min: 120, max: 300  },
    { label: '5–10 min',  min: 300, max: 600  },
    { label: '10–15 min', min: 600, max: 900  },
    { label: '15+ min',   min: 900, max: 1800 },
];

export const COARSE_BUCKETS = [
    { label: '< 60 s',    min: 0,   max: 60   },
    { label: '1–5 min',   min: 60,  max: 300  },
    { label: '5+ min',    min: 300, max: 1800 },
];

/**
 * Bucket flattened snapshots by horizon and emit per-bucket calc / gtfs stats
 * plus diagnostic averages (avg intermediates, % atOrigin, % capped).
 *
 * @param {Array} flat        flattenSnapshots() output
 * @param {Array} [buckets]   horizon bucket definitions
 * @param {string} [horizonField] "horizonCalc" or "horizonGtfs"
 * @returns {Object} keyed by bucket label
 */
export function bucketResults(flat, buckets = DEFAULT_BUCKETS, horizonField = 'horizonCalc') {
    const out = {};
    for (const bucket of buckets) {
        const inBucket = flat.filter(f => {
            const h = f[horizonField];
            return h != null && h >= bucket.min && h < bucket.max;
        });
        const calcStats = stats(inBucket.map(f => f.calcErr));
        const gtfsStats = stats(inBucket.map(f => f.gtfsErr));
        const inter     = inBucket.map(f => f.intermediates).filter(v => v != null);
        const orig      = inBucket.filter(f => f.atOrigin).length;
        const capped    = inBucket.filter(f => f.capped).length;
        out[bucket.label] = {
            calc:      calcStats,
            gtfs:      gtfsStats,
            blend:     stats(inBucket.map(f => f.blendErr)),
            avgInter:  inter.length ? +(inter.reduce((a, b) => a + b, 0) / inter.length).toFixed(2) : null,
            pctOrig:   inBucket.length ? `${Math.round(orig / inBucket.length * 100)}%` : '0%',
            pctCap:    inBucket.length ? `${Math.round(capped / inBucket.length * 100)}%` : '0%',
        };
    }
    return out;
}

/**
 * Three-way bucketing: each source (calc / gtfs / blend) is bucketed by
 * **its own** horizon, then stats are computed for each. This is the right
 * shape for asking "how accurate is the blend at the 2-5 min mark?" because
 * a single snapshot can have calcHorizon=120s, gtfsHorizon=140s, blendHorizon=132s
 * — each prediction owns its own horizon and should be evaluated against it.
 *
 * Returned shape: { '2–5 min': { calc: {…}, gtfs: {…}, blend: {…} }, … }
 *
 * Where the original `bucketResults(flat, buckets, 'horizonCalc')` puts every
 * source into the calc-horizon bucket — useful as a comparison fixed at one
 * horizon definition, but not what you want for per-source accuracy.
 */
export function bucketByOwnHorizon(flat, buckets = DEFAULT_BUCKETS) {
    const out = {};
    for (const b of buckets) {
        const calc  = flat.filter(f => f.horizonCalc  != null && f.horizonCalc  >= b.min && f.horizonCalc  < b.max);
        const gtfs  = flat.filter(f => f.horizonGtfs  != null && f.horizonGtfs  >= b.min && f.horizonGtfs  < b.max);
        const blend = flat.filter(f => f.horizonBlend != null && f.horizonBlend >= b.min && f.horizonBlend < b.max);
        out[b.label] = {
            calc:  stats(calc.map(f  => f.calcErr)),
            gtfs:  stats(gtfs.map(f  => f.gtfsErr)),
            blend: stats(blend.map(f => f.blendErr)),
        };
    }
    return out;
}

/**
 * Head-to-head: of the snapshots that have all three sources, how often does
 * each one win (smallest absolute error). Useful to validate blend > both raw
 * sources — the whole point of the hybrid is to be best-of-both.
 */
export function headToHead(flat) {
    const all3 = flat.filter(f => f.calcErr != null && f.gtfsErr != null && f.blendErr != null);
    if (!all3.length) return { n: 0 };
    let calcW = 0, gtfsW = 0, blendW = 0, ties = 0;
    for (const f of all3) {
        const c = Math.abs(f.calcErr), g = Math.abs(f.gtfsErr), b = Math.abs(f.blendErr);
        const min = Math.min(c, g, b);
        if (min === b && b < c && b < g)      blendW++;
        else if (min === c && c < g && c < b) calcW++;
        else if (min === g && g < c && g < b) gtfsW++;
        else                                  ties++;
    }
    const pct = n => `${Math.round(n / all3.length * 100)}%`;
    return {
        n:      all3.length,
        calcWins:  calcW,  calcPct:  pct(calcW),
        gtfsWins:  gtfsW,  gtfsPct:  pct(gtfsW),
        blendWins: blendW, blendPct: pct(blendW),
        ties,              tiePct:   pct(ties),
    };
}

/**
 * Bucket flattened snapshots by routeId and emit per-route calc / gtfs stats.
 */
export function bucketByRoute(flat) {
    const byRoute = {};
    for (const f of flat) {
        const k = f.routeId ?? 'unknown';
        if (!byRoute[k]) byRoute[k] = [];
        byRoute[k].push(f);
    }
    const out = {};
    for (const [route, rows] of Object.entries(byRoute)) {
        out[route] = {
            n:     rows.length,
            calc:  stats(rows.map(f => f.calcErr)),
            gtfs:  stats(rows.map(f => f.gtfsErr)),
            blend: stats(rows.map(f => f.blendErr)),
        };
    }
    return out;
}

// ── Transit-data-aware metrics ──────────────────────────────────────────────
//
// The classic MAE / ±30 s view doesn't capture three things that matter for
// transit ETAs:
//   1. Errors aren't symmetric — telling a rider "soon" when the train isn't
//      coming is much worse than telling them "later" when it's already here.
//   2. The rider sees minutes, not seconds. A 75-s prediction shown as "1m"
//      with an actual arrival of 35 s reads as "off by 30s"; a 65-s prediction
//      shown as "1m" with actual 45 s reads as "accurate."
//   3. Heavy-tailed distributions — MAE is dominated by the long right tail.
//      Median absolute error (MdAE) and p95 abs error describe the typical and
//      worst-case experience separately.

/**
 * Mean of one-sided overshoot: how badly we tell users "soon" when it wasn't.
 *   loss = mean( max(0, predicted - actual) )         in seconds
 * (Equivalent to mean(max(0, -err)) under our sign convention err=actual-pred.)
 * Sensitive only to the wrong-side errors — the costly ones for users.
 */
export function asymmetricEarlyLoss(errors) {
    const v = errors.filter(x => x != null);
    if (!v.length) return null;
    const sum = v.reduce((acc, e) => acc + Math.max(0, -e), 0);
    return +(sum / v.length).toFixed(2);
}

/**
 * Fraction of predictions whose minute bucket matches the actual minute bucket.
 * Mirrors the user-perceived "the app said 3 min and it was 3 min" check —
 * the only accuracy claim that survives the display rounding.
 *
 *   bucket(secs) = secs < 30 ? 0 : round(secs / 60)
 *
 * @param {Array<{predEta:number|null, actualUnix:number, recordedAt:number}>} rows
 * @returns {number|null} 0..1, or null if no eligible rows
 */
export function minuteBucketAccuracy(rows) {
    const elig = rows.filter(r => r.predEta != null && r.actualUnix != null && r.recordedAt != null);
    if (!elig.length) return null;
    const bucket = secs => secs < 30 ? 0 : Math.round(secs / 60);
    let match = 0;
    for (const r of elig) {
        const predSec   = r.predEta    - r.recordedAt;
        const actualSec = r.actualUnix - r.recordedAt;
        if (bucket(predSec) === bucket(actualSec)) match++;
    }
    return +(match / elig.length).toFixed(3);
}

/**
 * Median absolute error in seconds — robust to long right-tail.
 */
export function mdae(errors) {
    const v = errors.filter(x => x != null).map(Math.abs).sort((a, b) => a - b);
    if (!v.length) return null;
    return +median(v).toFixed(2);
}

// ── Cluster bootstrap ───────────────────────────────────────────────────────
//
// Snapshots within the same (tripId, targetStopId) are nearly perfectly
// correlated — two readings 30 s apart of the same vehicle approaching the
// same stop carry almost identical information. Treating them as independent
// inflates effective n by ~10× and produces CIs 3-5× too narrow.
//
// The standard fix is the cluster bootstrap: resample CLUSTERS (with
// replacement), not rows. Each bootstrap replicate keeps the original
// within-cluster correlation structure intact.

function _splitMix32(seed) {
    // Tiny deterministic PRNG so test runs are reproducible. Sufficient
    // statistical quality for bootstrap resampling (we don't need crypto).
    let s = seed | 0;
    return () => {
        s = (s + 0x9E3779B9) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 16), 0x85ebca6b);
        t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35);
        return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
    };
}

function _clusterKey(row) {
    // tripId + targetStopId is the natural unit. Falls back to row index when
    // either is missing so legacy data still passes through without crashing.
    if (row.tripId != null && row.targetStopId != null) {
        return `${row.tripId}|${row.targetStopId}`;
    }
    return null;
}

/**
 * Group rows by their cluster key. Rows with no cluster key get their own
 * singleton cluster (worst case: equivalent to row-level bootstrap).
 */
function _groupClusters(rows) {
    const clusters = new Map();
    let i = 0;
    for (const r of rows) {
        const k = _clusterKey(r) ?? `_singleton_${i++}`;
        if (!clusters.has(k)) clusters.set(k, []);
        clusters.get(k).push(r);
    }
    return [...clusters.values()];
}

/**
 * Generic cluster bootstrap.
 *
 *   bootstrapCI(rows, statFn, { iters, seed, quantiles })
 *
 * Resamples clusters (with replacement) `iters` times. For each replicate,
 * concatenates the resampled clusters and calls `statFn(replicate) → number`.
 * Returns the percentile interval over the resulting `iters` statistics.
 *
 * @param {Array<Object>} rows         flattenSnapshots() output
 * @param {Function}      statFn       (rows) → number; returns the statistic to bootstrap
 * @param {Object}        [options]
 * @param {number}        [options.iters=1000]   bootstrap replicates
 * @param {number}        [options.seed=42]      PRNG seed (reproducibility)
 * @param {Array<number>} [options.quantiles=[0.025, 0.975]]  CI percentiles (default 95%)
 * @returns {{ point: number|null, lo: number|null, hi: number|null, iters: number, clusters: number }}
 */
export function bootstrapCI(rows, statFn, { iters = 1000, seed = 42, quantiles = [0.025, 0.975] } = {}) {
    if (!rows.length) return { point: null, lo: null, hi: null, iters: 0, clusters: 0 };
    const clusters = _groupClusters(rows);
    if (!clusters.length) return { point: null, lo: null, hi: null, iters: 0, clusters: 0 };

    const point = statFn(rows);
    if (point == null || !Number.isFinite(point)) {
        return { point: null, lo: null, hi: null, iters: 0, clusters: clusters.length };
    }

    const rng = _splitMix32(seed);
    const reps = [];
    for (let it = 0; it < iters; it++) {
        const replicate = [];
        for (let i = 0; i < clusters.length; i++) {
            const pick = Math.floor(rng() * clusters.length);
            for (const r of clusters[pick]) replicate.push(r);
        }
        const s = statFn(replicate);
        if (s != null && Number.isFinite(s)) reps.push(s);
    }
    reps.sort((a, b) => a - b);
    const at = q => {
        if (!reps.length) return null;
        const idx = q * (reps.length - 1);
        const lo = Math.floor(idx), hi = Math.ceil(idx);
        return lo === hi ? reps[lo] : reps[lo] + (reps[hi] - reps[lo]) * (idx - lo);
    };
    return {
        point:    +point.toFixed(3),
        lo:       at(quantiles[0]) != null ? +at(quantiles[0]).toFixed(3) : null,
        hi:       at(quantiles[1]) != null ? +at(quantiles[1]).toFixed(3) : null,
        iters:    reps.length,
        clusters: clusters.length,
    };
}

/**
 * Convenience: MAE in seconds with cluster-bootstrap 95% CI.
 *   field = 'calcErr' | 'gtfsErr' | 'blendErr' (or any error column)
 */
export function bootstrapMaeCI(rows, field, options) {
    const stat = subset => {
        const errs = subset.map(r => r[field]).filter(x => x != null);
        if (!errs.length) return null;
        return errs.reduce((a, e) => a + Math.abs(e), 0) / errs.length;
    };
    return bootstrapCI(rows, stat, options);
}

/**
 * Convenience: within-Xs hit rate (0..1) with cluster-bootstrap 95% CI.
 */
export function bootstrapWithinCI(rows, field, thresholdSec, options) {
    const stat = subset => {
        const errs = subset.map(r => r[field]).filter(x => x != null);
        if (!errs.length) return null;
        return errs.filter(e => Math.abs(e) <= thresholdSec).length / errs.length;
    };
    return bootstrapCI(rows, stat, options);
}

/**
 * Paired bootstrap on the difference of two predictors' MAEs on the SAME rows.
 * Use this to ask "does predictor A beat predictor B?" with statistical rigor.
 * If the CI on the difference excludes 0, the difference is significant.
 *
 *   bootstrapMaeDiffCI(rows, 'blendErr', 'gtfsErr')
 *   // → { point: -3.2, lo: -5.1, hi: -1.4, iters: 1000, clusters: 412 }
 *   // Negative means fieldA has lower MAE (better).
 */
export function bootstrapMaeDiffCI(rows, fieldA, fieldB, options) {
    const stat = subset => {
        const paired = subset.filter(r => r[fieldA] != null && r[fieldB] != null);
        if (!paired.length) return null;
        const maeA = paired.reduce((a, r) => a + Math.abs(r[fieldA]), 0) / paired.length;
        const maeB = paired.reduce((a, r) => a + Math.abs(r[fieldB]), 0) / paired.length;
        return maeA - maeB;
    };
    return bootstrapCI(rows, stat, options);
}

// ── Console output helpers ──────────────────────────────────────────────────

/**
 * Wrap console.table with a markdown-table dump so output survives copy-paste
 * into chat without column-merging. Logs both the table object and the
 * markdown — same behavior as the original harness's consoleTablePlus.
 */
export function consoleTablePlus(rows) {
    if (typeof console.table === 'function') console.table(rows);
    const entries = Object.entries(rows);
    if (!entries.length) return;
    const keys = Object.keys(entries[0][1] ?? {});
    if (!keys.length) return;
    const fmt = v => (v == null ? '' : (typeof v === 'number' ? +v.toFixed(1) : v));
    const header = '| label | ' + keys.join(' | ') + ' |';
    const sep    = '|' + Array(keys.length + 1).fill(' --- ').join('|') + '|';
    const body   = entries.map(([k, v]) =>
        '| ' + k + ' | ' + keys.map(kk => fmt(v[kk])).join(' | ') + ' |'
    ).join('\n');
    console.log('\n```md\n' + [header, sep, body].join('\n') + '\n```');
}

// ── Capture state helpers ────────────────────────────────────────────────────

/**
 * Create a fresh capture state object. Both harnesses use this shape so the
 * aggregator helpers above can produce the same summary regardless of source.
 */
export function createCapture() {
    return {
        pending: new Map(), // predKey → entry
        arrived: new Set(),
        results: [],        // finalized arrivals
    };
}

/**
 * Push a prediction snapshot for the given (vehicleId, tripId, stopId) tuple.
 * Caller is responsible for picking the predKey scheme. Returns the entry so
 * callers can inspect its snapshot count.
 */
export function pushSnapshot(capture, predKey, entryFields, snapshotFields) {
    let entry = capture.pending.get(predKey);
    if (!entry) {
        entry = { ...entryFields, snapshots: [] };
        capture.pending.set(predKey, entry);
    }
    entry.snapshots.push(snapshotFields);
    return entry;
}

/**
 * Finalize the entry for predKey as having "arrived" at actualUnix. Snapshots
 * with a different tripId than the locked entry.tripId are filtered out (vehicle
 * was reassigned mid-approach).
 */
export function recordArrival(capture, predKey, actualUnix) {
    if (capture.arrived.has(predKey)) return;
    const entry = capture.pending.get(predKey);
    if (!entry || entry.snapshots.length === 0) {
        capture.arrived.add(predKey);
        return;
    }
    capture.arrived.add(predKey);
    const cleanSnapshots = entry.snapshots.filter(s => s.tripId === entry.tripId);
    if (!cleanSnapshots.length) return;
    capture.results.push({
        vehicleId:    entry.vehicleId,
        tripId:       entry.tripId,
        stopId:       entry.targetStopId,
        routeId:      entry.routeId,
        actualUnix,
        snapshots:    cleanSnapshots,
    });
}

/**
 * Build a structured summary object suitable for writing to summary.json or
 * feeding into the existing scripts/analyze-eta.js dev utility.
 */
export function summarize(capture, { buckets = DEFAULT_BUCKETS } = {}) {
    const flat = flattenSnapshots(capture.results);
    return {
        meta: {
            arrivals:  capture.results.length,
            snapshots: flat.length,
            generated: new Date().toISOString(),
        },
        // Each source bucketed by its own horizon (the right shape for "how
        // accurate is the blend at the 2-5 min mark?"). The legacy
        // bucketResults/horizonCalc view is preserved under byHorizonCalc for
        // backwards-compat with existing analyzer scripts.
        byHorizon:     bucketByOwnHorizon(flat, buckets),
        byHorizonCalc: bucketResults(flat, buckets, 'horizonCalc'),
        byRoute:       bucketByRoute(flat),
        headToHead:    headToHead(flat),
        overall: {
            calc:  stats(flat.map(f => f.calcErr)),
            gtfs:  stats(flat.map(f => f.gtfsErr)),
            blend: stats(flat.map(f => f.blendErr)),
        },
    };
}
