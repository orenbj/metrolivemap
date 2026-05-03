/**
 * analyze-eta.js
 * Analyzes a capture file produced by capture-eta.js.
 *
 * Usage:  node scripts/analyze-eta.js scripts/eta-capture-<timestamp>.jsonl
 *
 * Outlier filtering strategy:
 *   Only rows where BOTH gtfsEta and calcEta exist (matched rows) are used for
 *   bias/accuracy analysis. Within that set, we apply IQR filtering on deltaSeconds
 *   to remove true outliers — these are usually trains the GTFS feed sporadically
 *   loses then rediscovers (huge jumps), not prediction errors.
 *   Threshold: |delta| > Q3 + 1.5 * IQR  (standard Tukey fence).
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

const file = process.argv[2];
if (!file) { console.error('Usage: node analyze-eta.js <capture.jsonl>'); process.exit(1); }

const rows = readFileSync(file, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l));

console.log(`\n═══ ETA Capture Analysis: ${basename(file)} ═══`);
console.log(`Total rows: ${rows.length.toLocaleString()}\n`);

// ── Coverage breakdown ────────────────────────────────────────────────────────

const matched   = rows.filter(r => r.gtfsEta != null && r.calcEta != null);
const onlyCalc  = rows.filter(r => r.onlyCalc);
const onlyGtfs  = rows.filter(r => r.onlyGtfs);

console.log('── Coverage ──────────────────────────────────────');
console.log(`  Both sources matched : ${matched.length.toLocaleString()} rows (${pct(matched.length, rows.length)})`);
console.log(`  Calc only (GTFS miss): ${onlyCalc.length.toLocaleString()} rows (${pct(onlyCalc.length, rows.length)})`);
console.log(`  GTFS only (no calc)  : ${onlyGtfs.length.toLocaleString()} rows (${pct(onlyGtfs.length, rows.length)})`);

// ── Outlier detection (IQR on deltaSeconds) ───────────────────────────────────

const deltas = matched.map(r => r.deltaSeconds).sort((a, b) => a - b);
const q1     = percentile(deltas, 25);
const q3     = percentile(deltas, 75);
const iqr    = q3 - q1;
const fence  = 1.5 * iqr;
const lo     = q1 - fence;
const hi     = q3 + fence;

const inliers  = matched.filter(r => r.deltaSeconds >= lo && r.deltaSeconds <= hi);
const outliers = matched.filter(r => r.deltaSeconds < lo || r.deltaSeconds > hi);

console.log('\n── Outlier Filtering (IQR, Tukey fence) ──────────────────────────────────────');
console.log(`  Q1=${q1}s  Q3=${q3}s  IQR=${iqr}s  Fence=[${Math.round(lo)}s, ${Math.round(hi)}s]`);
console.log(`  Inliers : ${inliers.length.toLocaleString()}  Outliers removed: ${outliers.length.toLocaleString()} (${pct(outliers.length, matched.length)})`);

// ── Accuracy stats on inliers ─────────────────────────────────────────────────

const d = inliers.map(r => r.deltaSeconds);

console.log('\n── Accuracy (calc − GTFS, inliers only) ──────────────────────────────────────');
console.log(`  Mean bias   : ${mean(d).toFixed(1)}s  (+ = our calc later than GTFS)`);
console.log(`  Median bias : ${median(d).toFixed(1)}s`);
console.log(`  MAE         : ${mae(d).toFixed(1)}s  (mean absolute error)`);
console.log(`  RMSE        : ${rmse(d).toFixed(1)}s`);
console.log(`  Std dev     : ${std(d).toFixed(1)}s`);

// ── By ETA bucket (how accuracy changes as train approaches) ──────────────────

console.log('\n── Accuracy by ETA bucket (GTFS eta) ─────────────────────────────────────────');
const buckets = [
    { label: '0–1 min',   min: 0,   max: 60  },
    { label: '1–3 min',   min: 60,  max: 180 },
    { label: '3–5 min',   min: 180, max: 300 },
    { label: '5–10 min',  min: 300, max: 600 },
    { label: '10–20 min', min: 600, max: 1200},
    { label: '20+ min',   min: 1200, max: Infinity },
];

buckets.forEach(b => {
    const subset = inliers.filter(r => r.gtfsEta >= b.min && r.gtfsEta < b.max).map(r => r.deltaSeconds);
    if (!subset.length) return;
    console.log(`  ${b.label.padEnd(10)}  n=${String(subset.length).padStart(5)}  bias=${mean(subset).toFixed(1).padStart(6)}s  MAE=${mae(subset).toFixed(1).padStart(5)}s  p90err=${p90err(subset).toFixed(0).padStart(4)}s`);
});

// ── By route ──────────────────────────────────────────────────────────────────

const LETTER = { '801':'A','802':'B','803':'C','804':'E','805':'D','806':'L','807':'K','901':'G','910':'J','950':'J' };

console.log('\n── Accuracy by route ─────────────────────────────────────────────────────────');
const byRoute = groupBy(inliers, r => r.routeId);
Object.entries(byRoute)
    .sort(([a],[b]) => (LETTER[a]??a).localeCompare(LETTER[b]??b))
    .forEach(([routeId, rrows]) => {
        const rd = rrows.map(r => r.deltaSeconds);
        const letter = LETTER[routeId] ?? routeId;
        console.log(`  Line ${letter}  n=${String(rd.length).padStart(5)}  bias=${mean(rd).toFixed(1).padStart(6)}s  MAE=${mae(rd).toFixed(1).padStart(5)}s`);
    });

// ── Outlier inspection ────────────────────────────────────────────────────────

if (outliers.length) {
    const worstPos = outliers.filter(r=>r.deltaSeconds > 0).sort((a,b)=>b.deltaSeconds-a.deltaSeconds).slice(0,5);
    const worstNeg = outliers.filter(r=>r.deltaSeconds < 0).sort((a,b)=>a.deltaSeconds-b.deltaSeconds).slice(0,5);
    console.log('\n── Top outliers removed (our calc vs GTFS) ───────────────────────────────────');
    console.log('  (calc too late):');
    worstPos.forEach(r => console.log(`    Δ=+${r.deltaSeconds}s  route=${LETTER[r.routeId]??r.routeId}  gtfsEta=${r.gtfsEta}s  stop=${r.stopName}`));
    console.log('  (calc too early):');
    worstNeg.forEach(r => console.log(`    Δ=${r.deltaSeconds}s  route=${LETTER[r.routeId]??r.routeId}  gtfsEta=${r.gtfsEta}s  stop=${r.stopName}`));
}

console.log('');

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n, total) { return total ? `${Math.round(n/total*100)}%` : '0%'; }
function mean(arr) { return arr.reduce((s,x)=>s+x,0)/arr.length; }
function median(arr) { const s=[...arr].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function mae(arr) { return mean(arr.map(Math.abs)); }
function rmse(arr) { return Math.sqrt(mean(arr.map(x=>x*x))); }
function std(arr) { const m=mean(arr); return Math.sqrt(mean(arr.map(x=>(x-m)**2))); }
function p90err(arr) { return percentile(arr.map(Math.abs).sort((a,b)=>a-b), 90); }
function percentile(sorted, p) { const i=(p/100)*(sorted.length-1); const lo=Math.floor(i); return sorted[lo]+(sorted[Math.ceil(i)]-sorted[lo])*(i-lo); }
function groupBy(arr, fn) { return arr.reduce((m,x)=>{ const k=fn(x); (m[k]??=[]).push(x); return m; }, {}); }
