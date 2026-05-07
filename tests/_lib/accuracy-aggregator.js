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
                routeId:       r.routeId,
                horizonCalc:   s.horizonCalc,
                horizonGtfs:   s.horizonGtfs,
                horizonBlend:  s.horizonBlend ?? null,
                calcErr:       s.calcEta  != null ? r.actualUnix - s.calcEta  : null,
                gtfsErr:       s.gtfsEta  != null ? r.actualUnix - s.gtfsEta  : null,
                blendErr:      s.blendEta != null ? r.actualUnix - s.blendEta : null,
                intermediates: s.intermediates,
                adherence:     s.adherence,
                atOrigin:      s.atOrigin,
                speedMult:     s.speedMult,
                capped:        s.capped,
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
        byHorizon: bucketResults(flat, buckets, 'horizonCalc'),
        byRoute:   bucketByRoute(flat),
        overall: {
            calc:  stats(flat.map(f => f.calcErr)),
            gtfs:  stats(flat.map(f => f.gtfsErr)),
            blend: stats(flat.map(f => f.blendErr)),
        },
    };
}
