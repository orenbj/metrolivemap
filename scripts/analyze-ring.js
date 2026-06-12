#!/usr/bin/env node
/**
 * scripts/analyze-ring.js
 *
 * Reads a feedStats ring buffer (the rolling per-minute counter snapshots
 * produced by js/feedStats.js) and prints summary stats: window covered,
 * per-feed cadence and drops, per-counter totals + hourly rates, and
 * ghost-arrival episodes.
 *
 * Two input sources:
 *
 *   1. Raw ring exported from the browser console. Open the live map, then:
 *        copy(JSON.stringify(JSON.parse(localStorage.feedStatsRing)))
 *      Paste into ring.json, then run:
 *        node scripts/analyze-ring.js ring.json
 *
 *   2. JSONL artifact from scripts/live-accuracy-headless.js. The harness
 *      appends a single tagged row (__kind === 'feedStatsRing') at the tail
 *      of the JSONL file:
 *        node scripts/analyze-ring.js path/to/run.jsonl
 *
 * Input type is auto-detected by file extension (.jsonl → harness format,
 * anything else → raw ring JSON). Pure Node script; built-ins only. Read-only.
 *
 * Counter semantics — see js/feedStats.js. Notable:
 *   spike                 — GPS fixes rejected as teleports. Low non-zero is normal.
 *   vehicleNoArrivalMatch — episode-gated per vehicle: trip_updates lost the
 *                           prediction for a live vehicle. Sustained non-zero is a signal.
 *   globalErrors          — uncaught exceptions bubbled to window. Baseline zero is healthy.
 */

import { readFileSync } from 'node:fs';

// Mirrors the marker counters declared in js/feedStats.js. Kept inline so a
// reader of the report can match each row against the source. New counters
// added there must be appended here too — unknown keys in the ring are
// silently ignored, which is fine for forward-compat but means added counters
// stay invisible until this list is updated.
const MARKER_KEYS = [
    // ingest drops
    'staleAge', 'olderTs', 'spike', 'coldStartSpike', 'preBootstrap',
    // marker hygiene + corrections
    'offRoute', 'crossLineSpike', 'popupDOMOrphan', 'stopLagReanchor',
    'backwardRelease', 'hardReanchor', 'arcSpaceReanchor', 'jRouteRetag', 'streakForceAccept', 'declaredAnchor',
    'vehicleNoArrivalMatch', 'midnightTripIdMiss',
    // global error boundary
    'globalErrors', 'unhandledRejections',
];

function main() {
    const path = process.argv[2];
    if (!path) {
        console.error('usage: node scripts/analyze-ring.js <ring.json | run.jsonl>');
        process.exit(2);
    }
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        console.error(`cannot read ${path}: ${err.message}`);
        process.exit(2);
    }
    const ring = path.endsWith('.jsonl') ? extractFromJsonl(raw, path) : parseRawRing(raw, path);
    if (!Array.isArray(ring) || ring.length === 0) {
        console.error(`no ring entries found in ${path}`);
        process.exit(1);
    }
    report(ring);
}

function parseRawRing(text, path) {
    try {
        return JSON.parse(text);
    } catch (err) {
        console.error(`${path}: not valid JSON (${err.message})`);
        process.exit(2);
    }
}

function extractFromJsonl(text, path) {
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row;
        try { row = JSON.parse(trimmed); } catch { continue; }
        if (row.__kind === 'feedStatsRing') return row.ring ?? [];
    }
    console.error(`${path}: no row with __kind === 'feedStatsRing' found`);
    process.exit(1);
}

function report(ring) {
    const t0 = ring[0].t;
    const t1 = ring[ring.length - 1].t;
    // Guard against single-entry rings — a one-tick window has 60s of real
    // accumulation but t0 === t1, so rates would divide by zero.
    const spanS = Math.max(60, t1 - t0);
    const spanH = spanS / 3600;

    console.log('feedStats ring analysis');
    console.log('=======================');
    console.log(`window:  ${new Date(t0 * 1000).toISOString()}  →  ${new Date(t1 * 1000).toISOString()}`);
    console.log(`entries: ${ring.length}   span: ${spanH.toFixed(2)} h`);
    console.log();

    reportFeeds(ring, spanS);
    reportMarkers(ring, spanH);
    reportGhosts(ring);
}

function reportFeeds(ring, spanS) {
    const feeds = new Map();
    for (const entry of ring) {
        for (const [name, f] of Object.entries(entry.feeds ?? {})) {
            let agg = feeds.get(name);
            if (!agg) { agg = { rcv: 0, acc: 0, drops: {} }; feeds.set(name, agg); }
            agg.rcv += f.rcv ?? 0;
            agg.acc += f.acc ?? 0;
            for (const [k, v] of Object.entries(f.drops ?? {})) {
                agg.drops[k] = (agg.drops[k] ?? 0) + v;
            }
        }
    }
    if (feeds.size === 0) {
        console.log('per-feed: no feed activity in window');
        console.log();
        return;
    }

    console.log('per-feed totals');
    console.log(`  ${'feed'.padEnd(18)} ${'rcv'.padStart(8)} ${'acc'.padStart(8)}  acc%   cadence/s`);
    for (const [name, f] of feeds) {
        const accPct = f.rcv > 0 ? (f.acc / f.rcv * 100).toFixed(1) : 'n/a';
        const cadence = (f.rcv / spanS).toFixed(2);
        console.log(`  ${name.padEnd(18)} ${String(f.rcv).padStart(8)} ${String(f.acc).padStart(8)}  ${String(accPct).padStart(5)}%   ${cadence}`);
    }
    console.log();

    console.log('per-feed drops (totals)');
    for (const [name, f] of feeds) {
        const parts = Object.entries(f.drops)
            .map(([k, v]) => `${k}=${v}`)
            .join('  ');
        console.log(`  ${name.padEnd(18)} ${parts || '(none)'}`);
    }
    console.log();
}

function reportMarkers(ring, spanH) {
    const totals = Object.fromEntries(MARKER_KEYS.map(k => [k, 0]));
    for (const entry of ring) {
        for (const k of MARKER_KEYS) totals[k] += entry.markers?.[k] ?? 0;
    }
    console.log('marker counters (total / per hour)');
    for (const k of MARKER_KEYS) {
        const total = totals[k];
        const ratePerH = total / spanH;
        console.log(`  ${k.padEnd(24)} ${String(total).padStart(6)}  /  ${ratePerH.toFixed(2)} per h`);
    }
    console.log();
}

function reportGhosts(ring) {
    let total = 0, ticks = 0, max = 0;
    for (const entry of ring) {
        const g = entry.ghosts ?? 0;
        if (g > 0) { total += g; ticks++; if (g > max) max = g; }
    }
    if (total === 0) {
        console.log('ghost arrivals: none');
    } else {
        console.log(`ghost arrivals: total=${total} across ${ticks} ticks (max ${max} in a single tick)`);
    }
}

main();
