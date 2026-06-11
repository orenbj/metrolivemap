#!/usr/bin/env node
/**
 * replay-taper.js — offline A/B replay of the adherence-taper constant
 * (ADHERENCE_TAPER_K) against a captured live-accuracy JSONL.
 *
 * WHY THIS EXISTS (issue #236)
 * ----------------------------
 * The calc-only ETA bias is horizon-dependent and flips sign between short
 * and long horizons, so no single static offset corrects it. Hypothesis #1
 * from the issue is that the adherence-offset taper undercorrects late trains
 * at long horizons because it caps the applied offset at
 * `ADHERENCE_TAPER_K × remainingTime`. The issue's stated method is to
 * "replay the captured JSONLs offline BEFORE shipping any tuning change."
 * This is that replayer.
 *
 * WHAT IT CAN AND CANNOT REPLAY
 * -----------------------------
 * The live-accuracy snapshot already records everything needed to recompute
 * the TAPER under a different K WITHOUT re-capturing:
 *   - `recordedAt` (now), `calcEta`  → the tapered output that shipped
 *   - `adherence`   = the RAW, pre-taper signed offset (predictions.js:803,
 *                     `_adherenceOffsetS = Math.round(adherenceOffset)`)
 *   - `capped`      = whether the taper bit (predictions.js:805)
 *   - `actualUnix`  = ground-truth arrival
 * From those we reconstruct `schedEta` per row (see _reconstruct) and re-run
 * `_applyTaperedOffset` for any K. Raising K only ever LOOSENS the cap, so it
 * changes ONLY the rows that were `capped` — the long-horizon late-train
 * population the issue's bias table is about.
 *
 * It CANNOT replay hypothesis #2 (the `Math.min(elapsedWithLag, interStopGap)`
 * clamp in `interStopRemainingSeconds`): that needs `statusChangedAt`,
 * `times[idx]`, `times[idx-1]` and `nextIdx`, none of which are in the
 * snapshot schema. Testing #2 requires a snapshot-schema extension and a
 * FRESH capture — out of scope here.
 *
 * SELF-VALIDATION (and its one blind spot)
 * -----------------------------------------
 * `schedEta` is reconstructed from the SHIPPED K (`--baseline-k`, default =
 * the current config value). The replayer recomputes calcEta at that same K
 * and compares against the captured `calcEta`; the residual should be ~0
 * (±1–2 s from the integer rounding of `adherence` and unix-second fields).
 *
 * Blind spot: a CAPPED row (H, adh, capped=true) is consistent with a whole
 * family of (K, r) pairs — r = H / (1 + sign(adh)·K) — so its round-trip is
 * self-consistent at ANY claimed baseline K. The residual therefore canNOT
 * detect a baseline-K set too HIGH from capped rows. It DOES catch a
 * baseline-K set too LOW: that re-caps rows the capture recorded as UNCAPPED
 * (whose r = H − adh is K-independent), producing a non-zero residual. So the
 * residual is a one-sided guard against fabricated caps, not a full K recovery.
 *
 * AUTHORITATIVE baseline-K: read it from `js/config.js` at the capture's commit
 * — every artifact's `workflow_run.head_sha` pins the exact source the capture
 * ran against. Don't guess; the residual is only a secondary sanity check.
 *
 * USAGE
 * -----
 *   node scripts/replay-taper.js <capture.jsonl> [options]
 *
 *   --k=0.35,0.5,0.7,1.0   comma list of K values to sweep (default below)
 *   --baseline-k=0.35      the K the capture was SHIPPED under (default: current config)
 *   --route=804            restrict to one routeId (repeatable via comma list)
 *   --json                 emit machine-readable JSON instead of tables
 *
 * Note: this sandbox's network policy blocks the artifact blob host, so the
 * capture file must be supplied locally (download the live-accuracy artifact
 * where network access exists, unzip, and point this at the .jsonl).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stats, DEFAULT_BUCKETS } from '../tests/_lib/accuracy-aggregator.js';
import { ADHERENCE_TAPER_K } from '../js/config.js';

// ── The taper under test (mirrors predictions.js _applyTaperedOffset, but
// parameterised on K and operating on reconstructed schedEta). Kept in lockstep
// with js/predictions.js:176 — if that formula changes, change this too. ──────
export function taperedCalcEta(schedEta, adherenceOffset, now, k) {
    const remainingTime = Math.max(0, schedEta - now);
    const maxOffset     = k * remainingTime;
    const cappedOffset  = Math.sign(adherenceOffset) * Math.min(Math.abs(adherenceOffset), maxOffset);
    return Math.max(now, schedEta + cappedOffset);
}

/**
 * Reconstruct the row's scheduled ETA (and remaining-time r = schedEta - now)
 * from the captured taper OUTPUT, using the algebra of _applyTaperedOffset at
 * the shipped baseline K. Returns null when the row is floored at `now`
 * (horizon 0 — the offset can't be inverted) or otherwise un-invertible.
 *
 * Let H = calcEta - now, s = sign(adherence), r = max(0, schedEta - now).
 *   capped=false: cappedOffset = adherence    → H = r + adherence
 *                                              → r = H - adherence
 *   capped=true : cappedOffset = s·K·r        → H = r·(1 + s·K)
 *                                              → r = H / (1 + s·K)
 */
export function _reconstruct(row, baselineK) {
    const now = row.recordedAt;
    const adh = row.adherence;
    const H   = row.calcEta - now;
    if (!(H > 0)) return null;                 // floored at now / arrival row
    const s = Math.sign(adh);
    let r;
    if (!row.capped) {
        r = H - adh;
    } else {
        const denom = 1 + s * baselineK;
        if (denom <= 0) return null;           // K≥1 & early & capped → floored elsewhere
        r = H / denom;
    }
    if (!(r >= 0)) return null;                // rounding anomaly — drop the row
    return { now, r, schedEta: now + r, adh };
}

// ── Arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = { file: null, ks: null, baselineK: ADHERENCE_TAPER_K, routes: null, json: false };
    for (const a of argv.slice(2)) {
        if      (a.startsWith('--k='))          args.ks        = a.slice(4).split(',').map(Number).filter(n => Number.isFinite(n));
        else if (a.startsWith('--baseline-k=')) args.baselineK = Number(a.slice(13));
        else if (a.startsWith('--route='))      args.routes    = new Set(a.slice(8).split(',').map(s => s.trim()).filter(Boolean));
        else if (a === '--json')                args.json      = true;
        else if (!a.startsWith('--'))           args.file      = a;
    }
    // Default sweep: baseline + the issue's candidate values, de-duped & sorted.
    if (!args.ks || !args.ks.length) {
        args.ks = [...new Set([args.baselineK, 0.5, 0.7, 1.0])].sort((x, y) => x - y);
    }
    return args;
}

export function readSnapshots(path, routes) {
    const raw = readFileSync(path, 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.__kind === 'feedStatsRing') continue;          // tagged tail row
        // Require the fields the taper replay depends on.
        if (obj.calcEta == null || obj.adherence == null || obj.capped == null) continue;
        if (obj.actualUnix == null || obj.recordedAt == null) continue;
        if (routes && !routes.has(String(obj.routeId))) continue;
        rows.push(obj);
    }
    return rows;
}

// ── Core replay ──────────────────────────────────────────────────────────────
export function replay(rows, ks, baselineK) {
    const residuals = [];   // reconstructed calcEta@baselineK − captured calcEta
    // For each row, keep the baseline horizon (for bucketing — held fixed across
    // K so the same rows stay in the same bucket) and the recomputed error per K.
    const enriched = [];
    let invertFail = 0;
    for (const row of rows) {
        const rec = _reconstruct(row, baselineK);
        if (!rec) { invertFail++; continue; }
        const { now, schedEta, adh } = rec;
        // Self-check: recompute at the baseline K and compare to the capture.
        const calc0 = taperedCalcEta(schedEta, adh, now, baselineK);
        residuals.push(calc0 - row.calcEta);
        const baselineHorizon = row.calcEta - now;     // bucket key, fixed across K
        const errByK = {};
        for (const k of ks) {
            const calcK = taperedCalcEta(schedEta, adh, now, k);
            errByK[k] = row.actualUnix - calcK;        // signed: +late / -early
        }
        enriched.push({ routeId: row.routeId, capped: row.capped, baselineHorizon, errByK });
    }
    return { enriched, residuals, invertFail };
}

export function bucketTable(enriched, ks, baselineK) {
    const out = [];
    for (const b of DEFAULT_BUCKETS) {
        const inB = enriched.filter(e => e.baselineHorizon >= b.min && e.baselineHorizon < b.max);
        if (!inB.length) continue;
        const cappedN = inB.filter(e => e.capped).length;
        const rowOut = {
            bucket: b.label,
            n: inB.length,
            capped: `${Math.round(100 * cappedN / inB.length)}%`,
        };
        for (const k of ks) {
            const st = stats(inB.map(e => e.errByK[k]));
            const tag = k === baselineK ? `K=${k}*` : `K=${k}`;
            rowOut[`${tag} bias`] = st ? st.mean   : null;
            rowOut[`${tag} mae`]  = st ? st.mae    : null;
        }
        out.push(rowOut);
    }
    return out;
}

export function residualSummary(residuals) {
    if (!residuals.length) return { n: 0 };
    const abs = residuals.map(Math.abs).sort((a, b) => a - b);
    const mean = abs.reduce((a, b) => a + b, 0) / abs.length;
    return {
        n: residuals.length,
        meanAbs: +mean.toFixed(2),
        p50Abs: +abs[Math.floor(abs.length * 0.5)].toFixed(2),
        maxAbs: +abs[abs.length - 1].toFixed(2),
    };
}

function printTable(table) {
    if (!table.length) { console.log('(no rows in any horizon bucket)'); return; }
    const cols = Object.keys(table[0]);
    const widths = cols.map(c => Math.max(c.length, ...table.map(r => String(r[c] ?? '').length)));
    const fmt = (v, i) => String(v ?? '').padStart(widths[i]);
    console.log(cols.map((c, i) => c.padStart(widths[i])).join('  '));
    console.log(widths.map(w => '─'.repeat(w)).join('  '));
    for (const r of table) console.log(cols.map((c, i) => fmt(r[c], i)).join('  '));
}

function main() {
    const args = parseArgs(process.argv);
    if (!args.file) {
        console.error('usage: node scripts/replay-taper.js <capture.jsonl> [--k=0.35,0.5,0.7,1.0] [--baseline-k=0.35] [--route=804] [--json]');
        process.exit(2);
    }
    const rows = readSnapshots(args.file, args.routes);
    if (!rows.length) {
        console.error(`no usable snapshot rows in ${args.file} (need calcEta/adherence/capped/actualUnix/recordedAt)`);
        process.exit(1);
    }
    const { enriched, residuals, invertFail } = replay(rows, args.ks, args.baselineK);
    const resid = residualSummary(residuals);
    const table = bucketTable(enriched, args.ks, args.baselineK);

    if (args.json) {
        console.log(JSON.stringify({
            meta: { file: args.file, rows: rows.length, replayed: enriched.length, invertFail, baselineK: args.baselineK, ks: args.ks },
            residual: resid,
            byHorizon: table,
        }, null, 2));
        return;
    }

    console.log(`\nreplay-taper — ${args.file}`);
    console.log(`rows=${rows.length} replayed=${enriched.length} invert-fail=${invertFail} (floored/uninvertible)`);
    console.log(`baseline K=${args.baselineK}  sweep=[${args.ks.join(', ')}]   (* marks the baseline column)\n`);
    console.log(`self-check — |reconstructed calcEta@baseline − captured calcEta|:`);
    console.log(`  n=${resid.n}  mean=${resid.meanAbs}s  p50=${resid.p50Abs}s  max=${resid.maxAbs}s`);
    if (resid.meanAbs > 3) {
        console.log(`  ⚠ mean residual > 3 s — --baseline-k=${args.baselineK} likely does NOT match the K this`);
        console.log(`    capture shipped under. Re-run with the correct baseline before trusting the sweep.`);
    }
    console.log(`\nsigned bias (+late / −early) and MAE by baseline horizon, per K:\n`);
    printTable(table);
    console.log(`\nReading: a less-negative bias at long horizons (2–5 min, 5–10 min) as K rises`);
    console.log(`means a higher taper corrects the late-train undercorrection (#236 hypothesis #1).`);
    console.log(`Watch the short buckets (<30 s, 30–60 s) for a regression in the other direction.`);
}

// Run only when invoked directly (not when imported by the test).
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) main();
