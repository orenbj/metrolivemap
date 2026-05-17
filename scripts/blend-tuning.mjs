#!/usr/bin/env node
/**
 * scripts/blend-tuning.mjs
 *
 * Offline sweep of the six blend constants in js/config.js against captured
 * live-accuracy artifacts. For each constant, holds the other five at
 * production values and varies the target across a candidate list; computes
 * predicted blend ETA for every captured snapshot and aggregates MAE / RMSE /
 * within30s / within60s overall and per horizon bucket.
 *
 * Usage (assumes artifacts have been downloaded via `gh run download` into
 * a temp directory):
 *
 *   node scripts/blend-tuning.mjs --input /tmp/blend-tuning \
 *                                 --output docs/blend-tuning-2026-05.md
 *
 * The script walks `--input` recursively for `.jsonl` files (one per captured
 * run) and parses every row. Rows without BOTH `calcEta` and `gtfsEta` are
 * skipped — blend has no meaningful choice to make in those cases.
 *
 * Pure Node script. Built-ins only. No npm deps added.
 *
 * Does NOT modify js/config.js. The recommended config (if any) is written
 * to the output report only; applying it is a follow-up decision PR.
 */

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

// ── Production blend constants (mirrors js/config.js, kept inline so the
//    script is self-contained and reproducible from git history alone). ─────
const PRODUCTION = Object.freeze({
    horizonNearS:        60,
    horizonMidS:         300,
    weightNear:          0.7,
    weightMid:           0.9,
    disagreementSoftS:   60,
    disagreementHardS:   180,
    replayNearS:         300,
    replayRatio:         2,
    replayPadS:          60,
});

// ── Candidate sweep ranges per constant. ────────────────────────────────────
const SWEEPS = {
    horizonNearS:       [30, 45, 60, 75, 90, 120],
    horizonMidS:        [180, 240, 300, 420, 600],
    weightNear:         [0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
    weightMid:          [0.8, 0.85, 0.9, 0.95, 1.0],
    disagreementSoftS:  [30, 45, 60, 90, 120],
    disagreementHardS:  [120, 150, 180, 240, 300],
};

const REPLAY_SWEEPS = {
    replayNearS:  [150, 300, 600],
    replayRatio:  [1.5, 2, 3],
};

// ── Horizon buckets (mirrors DEFAULT_BUCKETS in tests/_lib/accuracy-aggregator.js). ─
const BUCKETS = [
    { label: '< 30 s',    min: 0,   max: 30   },
    { label: '30-60 s',   min: 30,  max: 60   },
    { label: '1-2 min',   min: 60,  max: 120  },
    { label: '2-5 min',   min: 120, max: 300  },
    { label: '5-10 min',  min: 300, max: 600  },
    { label: '10-15 min', min: 600, max: 900  },
    { label: '15+ min',   min: 900, max: 1800 },
];

// ── Parameterized blend (mirrors js/predictions.js _blendArrivals). ─────────
function blendWith(calcEtaS, gtfsEtaS, horizonSec, nowS, K) {
    if (calcEtaS == null) return gtfsEtaS;
    const calcHorizon = calcEtaS - nowS;
    if (calcHorizon >= 0 && calcHorizon < K.replayNearS
        && horizonSec > K.replayRatio * calcHorizon + K.replayPadS) return calcEtaS;
    const calcBase = horizonSec < K.horizonNearS ? (1 - K.weightNear)
                   : horizonSec < K.horizonMidS  ? (1 - K.weightMid)
                   : 0;
    const dAbs = Math.abs(gtfsEtaS - calcEtaS);
    const agreement = dAbs <= K.disagreementSoftS ? 1
                    : dAbs >= K.disagreementHardS ? 0
                    : (K.disagreementHardS - dAbs) / (K.disagreementHardS - K.disagreementSoftS);
    const calcWeight = calcBase * agreement;
    return calcWeight * calcEtaS + (1 - calcWeight) * gtfsEtaS;
}

// Count how many rows trigger the replay-guard branch.
function replayFires(calcEtaS, gtfsEtaS, horizonSec, nowS, K) {
    if (calcEtaS == null) return false;
    const calcHorizon = calcEtaS - nowS;
    return calcHorizon >= 0 && calcHorizon < K.replayNearS
        && horizonSec > K.replayRatio * calcHorizon + K.replayPadS;
}

// ── Aggregation helpers. ────────────────────────────────────────────────────
function stats(errs) {
    if (!errs.length) return { n: 0, mae: null, rmse: null, within30s: null, within60s: null };
    let abs = 0, sq = 0, w30 = 0, w60 = 0;
    for (const e of errs) {
        const a = Math.abs(e);
        abs += a; sq += e * e;
        if (a <= 30) w30++;
        if (a <= 60) w60++;
    }
    return {
        n: errs.length,
        mae:  +(abs / errs.length).toFixed(2),
        rmse: +(Math.sqrt(sq / errs.length)).toFixed(2),
        within30s: +(100 * w30 / errs.length).toFixed(1),
        within60s: +(100 * w60 / errs.length).toFixed(1),
    };
}

function bucketize(rows, K) {
    const out = {};
    for (const b of BUCKETS) {
        const errs = [];
        for (const r of rows) {
            const h = r.horizonGtfs;
            if (h == null || h < b.min || h >= b.max) continue;
            const blend = blendWith(r.calcEta, r.gtfsEta, r.horizonGtfs, r.recordedAt, K);
            errs.push(r.actualUnix - blend);
        }
        out[b.label] = stats(errs);
    }
    return out;
}

// ── I/O + sweep driver. ─────────────────────────────────────────────────────
async function walkJsonl(dir) {
    const out = [];
    const entries = await readdir(dir);
    for (const name of entries) {
        const p = join(dir, name);
        const s = await stat(p);
        if (s.isDirectory()) out.push(...await walkJsonl(p));
        else if (name.endsWith('.jsonl')) out.push(p);
    }
    return out;
}

async function loadRows(inputDir) {
    const files = await walkJsonl(inputDir);
    const rows = [];
    for (const f of files) {
        const text = await readFile(f, 'utf8');
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const r = JSON.parse(line);
                // Defensive: only keep rows with the fields we need.
                if (r.calcEta == null || r.gtfsEta == null) continue;
                if (r.actualUnix == null || r.recordedAt == null) continue;
                rows.push(r);
            } catch { /* skip malformed lines */ }
        }
    }
    return { rows, fileCount: files.length };
}

function sweepConstant(rows, name, candidates) {
    const results = [];
    for (const v of candidates) {
        const K = { ...PRODUCTION, [name]: v };
        const errs = [];
        for (const r of rows) {
            const blend = blendWith(r.calcEta, r.gtfsEta, r.horizonGtfs, r.recordedAt, K);
            errs.push(r.actualUnix - blend);
        }
        results.push({ value: v, ...stats(errs) });
    }
    return results;
}

function combinedBest(rows, sweepResults) {
    // For each constant, pick the value with the lowest overall MAE.
    const best = {};
    for (const [name, results] of Object.entries(sweepResults)) {
        let bestRow = results[0];
        for (const r of results) {
            if (r.mae != null && (bestRow.mae == null || r.mae < bestRow.mae)) bestRow = r;
        }
        best[name] = bestRow.value;
    }
    const K = { ...PRODUCTION, ...best };
    const errs = [];
    for (const r of rows) {
        const blend = blendWith(r.calcEta, r.gtfsEta, r.horizonGtfs, r.recordedAt, K);
        errs.push(r.actualUnix - blend);
    }
    return { config: best, stats: stats(errs) };
}

function productionBaseline(rows) {
    const errs = [];
    for (const r of rows) {
        const blend = blendWith(r.calcEta, r.gtfsEta, r.horizonGtfs, r.recordedAt, PRODUCTION);
        errs.push(r.actualUnix - blend);
    }
    return stats(errs);
}

// ── Markdown rendering. ─────────────────────────────────────────────────────
function fmtDelta(maeNow, maeBaseline) {
    if (maeNow == null || maeBaseline == null) return '—';
    const d = maeNow - maeBaseline;
    if (Math.abs(d) < 0.005) return '(current)';
    const sign = d < 0 ? '' : '+';
    return `${sign}${d.toFixed(2)}s`;
}

function tableForSweep(name, results, baselineMae, currentValue) {
    const lines = [];
    lines.push(`| Value | n | MAE | RMSE | within30s | within60s | Δ vs current |`);
    lines.push(`|------:|--:|----:|-----:|----------:|----------:|-------------:|`);
    let bestIdx = -1, bestMae = Infinity;
    for (let i = 0; i < results.length; i++) {
        if (results[i].mae != null && results[i].mae < bestMae) {
            bestMae = results[i].mae; bestIdx = i;
        }
    }
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const isCurrent = r.value === currentValue;
        const isBest    = i === bestIdx;
        const tag = isCurrent ? ' ←current' : isBest ? ' ←best' : '';
        lines.push(`| ${r.value}${tag} | ${r.n} | ${r.mae ?? '—'} | ${r.rmse ?? '—'} | ${r.within30s ?? '—'}% | ${r.within60s ?? '—'}% | ${fmtDelta(r.mae, baselineMae)} |`);
    }
    return lines.join('\n');
}

function bucketTable(buckets) {
    const lines = [];
    lines.push(`| Bucket | n | MAE | within60s |`);
    lines.push(`|--------|--:|----:|----------:|`);
    for (const b of BUCKETS) {
        const s = buckets[b.label];
        lines.push(`| ${b.label} | ${s.n} | ${s.mae ?? '—'} | ${s.within60s ?? '—'}% |`);
    }
    return lines.join('\n');
}

function describeConfidence(deltaMae, withinDeltas) {
    if (deltaMae == null) return 'inconclusive';
    const abs = Math.abs(deltaMae);
    // Check if any near-horizon within60s% bucket regressed by > 0.5 pp.
    const within60sNearRegress = (withinDeltas['< 30 s']  != null && withinDeltas['< 30 s']  < -0.5)
                              || (withinDeltas['30-60 s'] != null && withinDeltas['30-60 s'] < -0.5);
    if (abs < 0.5) return 'not worth the change — improvement below 0.5 s MAE is within run-to-run noise';
    if (deltaMae > 0) return 'current config is best — sweep favored it';
    if (within60sNearRegress) {
        return `mixed signal — MAE improves by ${abs.toFixed(2)} s but the within60s% rate at <60 s horizon degrades. The MAE win comes from tighter mean error on accurate-GTFS rows; the within60s loss is wider tails on edge-case rows. Rider-perception tradeoff — depends on whether "popup is right within a minute" matters more than "popup is right on average"`;
    }
    if (abs < 1.5) return 'marginal, optional — a fraction of a second per row, no near-horizon within60s regression';
    return 'ship it — meaningful MAE improvement, no near-horizon within60s regression';
}

async function main() {
    const argv = process.argv.slice(2);
    let input = '/tmp/blend-tuning';
    let output = 'docs/blend-tuning-2026-05.md';
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--input' && argv[i + 1]) input = argv[++i];
        else if (argv[i] === '--output' && argv[i + 1]) output = argv[++i];
    }

    process.stderr.write(`[blend-tuning] reading ${input} ...\n`);
    const { rows, fileCount } = await loadRows(input);
    process.stderr.write(`[blend-tuning] ${rows.length} usable rows across ${fileCount} files\n`);

    if (rows.length === 0) {
        process.stderr.write(`[blend-tuning] no rows — aborting\n`);
        process.exit(1);
    }

    // Per-row date range (recordedAt is unix seconds).
    let minTs = Infinity, maxTs = -Infinity;
    for (const r of rows) {
        if (r.recordedAt < minTs) minTs = r.recordedAt;
        if (r.recordedAt > maxTs) maxTs = r.recordedAt;
    }
    const fromIso = new Date(minTs * 1000).toISOString().slice(0, 10);
    const toIso   = new Date(maxTs * 1000).toISOString().slice(0, 10);

    // Baseline.
    const baseline = productionBaseline(rows);
    process.stderr.write(`[blend-tuning] baseline MAE ${baseline.mae}s n=${baseline.n}\n`);

    // OAT sweep.
    const sweeps = {};
    for (const [name, candidates] of Object.entries(SWEEPS)) {
        sweeps[name] = sweepConstant(rows, name, candidates);
        process.stderr.write(`[blend-tuning] swept ${name} (${candidates.length} values)\n`);
    }

    // Combined-best.
    const combined = combinedBest(rows, sweeps);
    process.stderr.write(`[blend-tuning] combined-best MAE ${combined.stats.mae}s\n`);

    // Replay-guard sanity.
    let replayCount = 0;
    for (const r of rows) {
        if (replayFires(r.calcEta, r.gtfsEta, r.horizonGtfs, r.recordedAt, PRODUCTION)) replayCount++;
    }

    // Per-bucket cross-tab for production + combined-best.
    const bucketsProd = bucketize(rows, PRODUCTION);
    const bucketsCombined = bucketize(rows, { ...PRODUCTION, ...combined.config });

    // ── Markdown output. ────────────────────────────────────────────────────
    const md = [];
    md.push('# Blend-constant tuning sweep — 2026-05');
    md.push('');
    md.push(`Generated 2026-05-17 from \`scripts/blend-tuning.mjs\`. Offline replay of`);
    md.push(`captured live-accuracy artifacts against varied blend constants. **No`);
    md.push(`production code change in this PR.** Applying any recommendation below is`);
    md.push(`a follow-up decision PR.`);
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Methodology');
    md.push('');
    md.push(`- **Source:** ${fileCount} \`.jsonl\` artifacts downloaded from the`);
    md.push(`  \`live-accuracy.yml\` GitHub Actions workflow (run IDs span ${fromIso} to ${toIso}).`);
    md.push(`- **Rows analyzed:** ${rows.length} snapshots where BOTH \`calcEta\` and \`gtfsEta\` are non-null`);
    md.push(`  (the only rows where blend has a meaningful choice to make).`);
    md.push(`- **Replay:** for each row we call a script-local copy of \`_blendArrivals\` with`);
    md.push(`  varied constants and compute \`blendErr = actualUnix - blend\`.`);
    md.push(`- **One-at-a-time (OAT) sweep:** five constants held at production values, the`);
    md.push(`  sixth varied across the candidate list. Reported per-value: n, MAE, RMSE,`);
    md.push(`  within30s%, within60s%, delta vs production-baseline MAE.`);
    md.push(`- **Combined-best:** the best OAT value for each constant taken together as`);
    md.push(`  one config, scored against production. If the combined improvement exceeds`);
    md.push(`  the sum of OAT improvements, the constants interact (expected).`);
    md.push('');
    md.push('### Limitations');
    md.push('');
    md.push(`- Offline replay only. No second-order effects — riders don't see the`);
    md.push(`  proposed blend, so we have no rider-perception measurement.`);
    md.push(`- Mixed weekday/weekend pooling. Metro service is structurally different on`);
    md.push(`  weekends (lighter headways, less rush-recovery operator pressure); a`);
    md.push(`  constant optimal on one may not be optimal on the other.`);
    md.push(`- \`calcEta\` in the captures was produced by the calc pipeline AT CAPTURE TIME`);
    md.push(`  with whatever \`scheduleCalibration\` multiplier was learned then. Re-running`);
    md.push(`  with a different multiplier would change \`calcEta\` upstream — but that's a`);
    md.push(`  separate tuning surface and outside this sweep.`);
    md.push(`- Sample size per bucket varies. The <30s and 15+ min buckets are thinner`);
    md.push(`  than the 1-2 min and 2-5 min buckets; small absolute MAE deltas in the`);
    md.push(`  thin buckets shouldn't be over-read.`);
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Production baseline');
    md.push('');
    md.push(`Production blend constants today:`);
    md.push('');
    md.push('```js');
    md.push(`BLEND_HORIZON_NEAR_S       = ${PRODUCTION.horizonNearS}`);
    md.push(`BLEND_HORIZON_MID_S        = ${PRODUCTION.horizonMidS}`);
    md.push(`BLEND_WEIGHT_NEAR          = ${PRODUCTION.weightNear}`);
    md.push(`BLEND_WEIGHT_MID           = ${PRODUCTION.weightMid}`);
    md.push(`BLEND_DISAGREEMENT_SOFT_S  = ${PRODUCTION.disagreementSoftS}`);
    md.push(`BLEND_DISAGREEMENT_HARD_S  = ${PRODUCTION.disagreementHardS}`);
    md.push('```');
    md.push('');
    md.push(`**Baseline error stats on the analyzed subset:** n=${baseline.n}, MAE=${baseline.mae}s,`);
    md.push(`RMSE=${baseline.rmse}s, within30s=${baseline.within30s}%, within60s=${baseline.within60s}%.`);
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Per-constant OAT sweeps');
    md.push('');
    for (const [name, results] of Object.entries(sweeps)) {
        md.push(`### \`${name}\` (production = ${PRODUCTION[name]})`);
        md.push('');
        md.push(tableForSweep(name, results, baseline.mae, PRODUCTION[name]));
        md.push('');
        let best = results[0];
        for (const r of results) {
            if (r.mae != null && (best.mae == null || r.mae < best.mae)) best = r;
        }
        const delta = best.mae - baseline.mae;
        md.push(`**Best OAT value:** \`${name} = ${best.value}\` (MAE Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}s vs production).`);
        md.push('');
    }
    md.push('---');
    md.push('');
    md.push('## Combined-best config');
    md.push('');
    md.push('Taking the OAT-best value for each constant simultaneously:');
    md.push('');
    md.push('| Constant | Production | Combined-best |');
    md.push('|----------|-----------:|--------------:|');
    for (const name of Object.keys(SWEEPS)) {
        md.push(`| \`${name}\` | ${PRODUCTION[name]} | ${combined.config[name]} |`);
    }
    md.push('');
    md.push(`**Combined-best error stats:** n=${combined.stats.n}, MAE=${combined.stats.mae}s,`);
    md.push(`RMSE=${combined.stats.rmse}s, within30s=${combined.stats.within30s}%, within60s=${combined.stats.within60s}%.`);
    md.push('');
    md.push(`**Overall MAE delta vs production:** ${fmtDelta(combined.stats.mae, baseline.mae)} `);
    md.push(`(${baseline.mae - combined.stats.mae >= 0 ? 'improvement' : 'regression'}).`);
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Per-bucket cross-tab (production vs combined-best)');
    md.push('');
    md.push('Same data, bucketed by GTFS horizon. A combined-best that improves overall');
    md.push(`MAE but regresses a specific bucket should be looked at carefully — rider`);
    md.push(`perception is bucket-local (the <60 s bucket is when riders are watching the`);
    md.push(`countdown most intently).`);
    md.push('');
    md.push('### Production');
    md.push('');
    md.push(bucketTable(bucketsProd));
    md.push('');
    md.push('### Combined-best');
    md.push('');
    md.push(bucketTable(bucketsCombined));
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Replay-guard sanity');
    md.push('');
    md.push(`The stale-replay heuristic (\`replayNearS=${PRODUCTION.replayNearS}\`,`);
    md.push(`\`replayRatio=${PRODUCTION.replayRatio}\`, \`replayPadS=${PRODUCTION.replayPadS}\`)`);
    md.push(`fires when \`calcHorizon < replayNearS\` AND \`gtfsHorizon > replayRatio × calcHorizon + replayPadS\`.`);
    md.push('');
    md.push(`**Fired on ${replayCount} of ${rows.length} rows (${(100 * replayCount / rows.length).toFixed(2)}%).**`);
    md.push('');
    if (replayCount === 0) {
        md.push(`Never fires. The guard is dead code on this dataset; whether to keep it`);
        md.push(`is a judgment call (it's belt-and-braces against WS-reconnect payload`);
        md.push(`artifacts which may not have happened in this window). No tuning recommended.`);
    } else if (replayCount / rows.length < 0.005) {
        md.push(`Fires on under 0.5% of rows. Effect on overall stats is small either way.`);
        md.push(`Leave the constants alone; revisit only if a captured WS-reconnect window`);
        md.push(`shows the guard mis-firing.`);
    } else {
        md.push(`Fires on a non-trivial fraction of rows. Worth running a dedicated sweep`);
        md.push(`on \`replayNearS\` / \`replayRatio\` in a follow-up; OAT done here was a sanity`);
        md.push(`check, not a serious tune.`);
    }
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Recommendation');
    md.push('');
    const overallDelta = combined.stats.mae - baseline.mae;
    // Per-bucket within60s deltas (combined - production), positive = improvement.
    const withinDeltas = {};
    for (const b of BUCKETS) {
        const p = bucketsProd[b.label].within60s;
        const c = bucketsCombined[b.label].within60s;
        withinDeltas[b.label] = (p != null && c != null) ? +(c - p).toFixed(2) : null;
    }
    md.push(`**Confidence call:** ${describeConfidence(overallDelta, withinDeltas)}.`);
    md.push('');
    const within60sNearRegress = (withinDeltas['< 30 s']  != null && withinDeltas['< 30 s']  < -0.5)
                              || (withinDeltas['30-60 s'] != null && withinDeltas['30-60 s'] < -0.5);
    if (overallDelta < -0.5 && !within60sNearRegress) {
        md.push(`Apply the combined-best config above in a follow-up PR. Expected MAE`);
        md.push(`improvement: ${Math.abs(overallDelta).toFixed(2)} s with no near-horizon`);
        md.push(`within60s% regression.`);
    } else if (overallDelta < -0.5 && within60sNearRegress) {
        md.push(`The combined-best config improves MAE by ${Math.abs(overallDelta).toFixed(2)} s but`);
        md.push(`degrades within60s% in the <30 s or 30-60 s buckets. Two reasonable choices:`);
        md.push('');
        md.push(`1. **Apply only the constants whose individual sweep cleanly helped without`);
        md.push(`   bucket regression** — see the per-constant tables above and the bucket`);
        md.push(`   cross-tab for which constants drive the within60s loss.`);
        md.push(`2. **Keep production as-is.** within60s% (\"popup is right within a minute\")`);
        md.push(`   is closer to what riders actually perceive than MAE — degrading it for`);
        md.push(`   a sub-1 s mean improvement is probably the wrong trade.`);
        md.push('');
        md.push(`The data does NOT support an "auto-apply combined-best" decision. Worth a`);
        md.push(`human read of the bucket cross-tab before any constants are changed.`);
    } else if (overallDelta < 0) {
        md.push(`Combined-best is marginally better than production but not by enough to`);
        md.push(`be confident the improvement isn't from sample noise. Either run another`);
        md.push(`sweep in a month with a larger window, or apply individual OAT-best`);
        md.push(`changes only for the constants whose sweep showed a clean trend.`);
    } else {
        md.push(`Production config is at or near the local optimum on this dataset. Leave`);
        md.push(`the constants alone. Revisit if Metro changes the GTFS-RT publish cadence`);
        md.push(`or if the calc-pipeline calibration drifts significantly.`);
    }
    md.push('');
    md.push('---');
    md.push('');
    md.push('## Reproducing');
    md.push('');
    md.push('```bash');
    md.push('# Download recent live-accuracy artifacts:');
    md.push(`gh run list --workflow=live-accuracy.yml --limit 30 \\`);
    md.push(`  --json databaseId,createdAt,conclusion \\`);
    md.push(`  --jq '.[] | select(.conclusion=="success") | .databaseId' \\`);
    md.push(`  | while read id; do`);
    md.push(`      gh run download "$id" --dir "/tmp/blend-tuning/$id"`);
    md.push(`    done`);
    md.push('');
    md.push('# Run the sweep:');
    md.push(`node scripts/blend-tuning.mjs \\`);
    md.push(`  --input /tmp/blend-tuning \\`);
    md.push(`  --output docs/blend-tuning-2026-05.md`);
    md.push('```');
    md.push('');

    await writeFile(output, md.join('\n'), 'utf8');
    process.stderr.write(`[blend-tuning] wrote ${output}\n`);
}

main().catch(err => {
    process.stderr.write(`[blend-tuning] failed: ${err.stack || err.message}\n`);
    process.exit(1);
});
