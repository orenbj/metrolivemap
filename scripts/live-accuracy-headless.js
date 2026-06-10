#!/usr/bin/env node
/**
 * Headless three-way accuracy harness.
 *
 * Spins up a static server pointed at the project root, drives a real Chromium
 * via Playwright to load the live map, triggers the existing browser harness
 * (tests/eta-live-accuracy.js), waits for it to capture for the requested
 * duration, then exports the raw `results` array via window.__etaTestExport()
 * and writes both a JSONL stream and a summary.json keyed by route × horizon
 * × source (calc / gtfs-rt / blend).
 *
 * Why headless instead of polyfilling predictions.js in Node:
 *   - Captures the **exact** code path that produces user-visible tooltips
 *     (calc, gtfs, AND the hybrid blend), not a divergent re-implementation.
 *   - Uses real GTFS-RT WebSocket feeds, real shape data, real station merging.
 *   - Zero polyfills for window.* globals.
 *
 * CLI:
 *   node scripts/live-accuracy-headless.js                   # 30 min default
 *   node scripts/live-accuracy-headless.js --duration=15m
 *   node scripts/live-accuracy-headless.js --routes=801,802 --out=peak-am
 *   node scripts/live-accuracy-headless.js --port=4173
 *
 * Output (relative to repo root):
 *   scripts/live-accuracy-{tag}.jsonl        — flat snapshots, one per line
 *   scripts/live-accuracy-{tag}.summary.json — three-way summary
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { extname, normalize } from 'node:path';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { chromium } from 'playwright';

import {
    summarize, flattenSnapshots, consoleTablePlus,
} from '../tests/_lib/accuracy-aggregator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const DEFAULT_DURATION_MS = 60 * 60 * 1000; // 60 min — matches the in-page default
const POLL_STATUS_MS      = 30_000;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        duration: DEFAULT_DURATION_MS,
        routes:   null,
        port:     4173,
        out:      null,
        tag:      null,
    };
    for (const a of argv.slice(2)) {
        if      (a.startsWith('--duration=')) args.duration = parseDuration(a.slice(11)) ?? DEFAULT_DURATION_MS;
        else if (a.startsWith('--routes='))   args.routes   = a.slice(9).split(',').map(s => s.trim()).filter(Boolean);
        else if (a.startsWith('--port='))     args.port     = Number(a.slice(7)) || 4173;
        else if (a.startsWith('--out='))      args.out      = a.slice(6);
        else if (a.startsWith('--tag='))      args.tag      = a.slice(6);
    }
    return args;
}

function parseDuration(v) {
    const m = v.match(/^(\d+)(s|m|min|h)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2] ?? 'm';
    return n * (unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000);
}

// ── Tiny static server (no devDeps; mirrors `npx serve`) ────────────────────

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.woff2':'font/woff2',
    '.txt':  'text/plain; charset=utf-8',
};

function startStaticServer(port) {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            try {
                const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
                const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/\\/g, '/');
                let fsPath = join(REPO_ROOT, safe === '/' ? 'index.html' : safe);
                if (existsSync(fsPath) && statSync(fsPath).isDirectory()) fsPath = join(fsPath, 'index.html');
                if (!existsSync(fsPath)) { res.statusCode = 404; res.end('not found'); return; }
                res.setHeader('Content-Type', MIME[extname(fsPath).toLowerCase()] ?? 'application/octet-stream');
                createReadStream(fsPath).pipe(res);
            } catch (e) {
                res.statusCode = 500; res.end(String(e));
            }
        });
        server.on('error', reject);
        server.listen(port, () => resolve(server));
    });
}

// ── Output helpers ──────────────────────────────────────────────────────────

function ensureDir(path) {
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* exists */ }
}

function makeJsonl(prefix) {
    const path = `${prefix}.jsonl`;
    ensureDir(path);
    writeFileSync(path, '');
    return { path, write(obj) { appendFileSync(path, JSON.stringify(obj) + '\n'); } };
}

function log(msg) { console.log(`[headless ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv);
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const tag  = args.tag ?? ts;
    const prefix = args.out ?? join(__dirname, `live-accuracy-${tag}`);
    const jsonl  = makeJsonl(prefix);

    log(`starting headless capture — ${(args.duration / 60_000).toFixed(1)} min`);
    if (args.routes) log(`route filter: ${args.routes.join(', ')}`);

    log(`starting static server on :${args.port}`);
    const server = await startStaticServer(args.port);

    log(`launching chromium`);
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext({ permissions: [] });
    const page    = await context.newPage();

    // Surface page console/errors into our log so CI can see them.
    page.on('console',     m => { if (['error','warning'].includes(m.type())) console.log(`[page ${m.type()}] ${m.text()}`); });
    page.on('pageerror',   e => console.log(`[page error] ${e.message}`));

    // Inject overrides BEFORE the IIFE evaluates.
    await page.addInitScript(({ durationMin, routes }) => {
        window.__etaTestDuration = durationMin;
        if (routes) window.__etaTestRoutes = new Set(routes);
    }, { durationMin: args.duration / 60_000, routes: args.routes });

    await page.goto(`http://localhost:${args.port}/`, { waitUntil: 'load', timeout: 60_000 });
    log(`page loaded; waiting for vehicleMarkers to populate`);

    // Wait until the WebSocket feeds have produced at least one marker.
    await page.waitForFunction(
        () => Object.keys(window.vehicleMarkers ?? {}).length > 0,
        null,
        { timeout: 120_000 }
    ).catch(() => log('warn: no markers within 2 min; continuing — feed may be quiet'));

    // Clear any prior session's feedStats ring so the captured artifact only
    // contains entries from this run. feedStatsReporter ticks every 60 s and
    // appends one entry per non-silent interval into localStorage.feedStatsRing.
    await page.evaluate(() => { try { localStorage.removeItem('feedStatsRing'); } catch { /* noop */ } });

    // Trigger the in-page harness.
    log(`triggering eta-live-accuracy harness`);
    await page.evaluate(async () => {
        await import('/tests/eta-live-accuracy.js');
    });

    // Poll status until done or timeout.
    const deadline = Date.now() + args.duration + 60_000; // small safety margin
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_STATUS_MS));
        const status = await page.evaluate(() => window.__etaTestStatus?.() ?? null);
        if (!status) { log('status hook missing — harness may not have started'); continue; }
        log(`elapsed=${status.elapsedMin}m / ${status.durationMin}m  arrivals=${status.arrivals}  snapshots=${status.snapshots}`);
        if (Number(status.elapsedMin) >= status.durationMin) break;
    }

    // Stop and export.
    await page.evaluate(() => window.__etaTestStop?.());
    const captured = await page.evaluate(() => window.__etaTestExport?.());
    if (!captured) { log('error: __etaTestExport returned null'); process.exit(2); }

    // Read the feedStats ring (rolling per-minute counter snapshots) before
    // tearing down the page. Empty if the run was shorter than one report
    // interval or if every interval was silent.
    const feedStatsRing = await page.evaluate(() => {
        try {
            const raw = localStorage.getItem('feedStatsRing');
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    });
    log(`captured ${feedStatsRing.length} feedStats entries`);

    log(`closing browser`);
    await browser.close();
    server.close();

    log(`captured ${captured.results.length} arrivals`);
    if (!captured.results.length) {
        log('warn: 0 arrivals — likely a quiet window or filter too narrow');
    }

    // Write JSONL stream (one row per snapshot).
    const flat = flattenSnapshots(captured.results);
    for (const row of flat) jsonl.write(row);

    // Append the feedStats ring as a single tagged row at the tail so the JSONL
    // self-describes the feed-health context of the same window the accuracy
    // rows were captured in. Consumers detect via row.__kind === 'feedStatsRing'.
    if (feedStatsRing.length > 0) {
        jsonl.write({ __kind: 'feedStatsRing', count: feedStatsRing.length, ring: feedStatsRing });
    }

    // Build the three-way summary.
    const summary = {
        meta: {
            ...captured.meta,
            snapshotsTotal: flat.length,
            feedStatsEntries: feedStatsRing.length,
            tag,
            runStarted: ts,
        },
        ...summarize({ results: captured.results }),
    };
    const summaryPath = `${prefix}.summary.json`;
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    log(`wrote ${jsonl.path}`);
    log(`wrote ${summaryPath}`);

    // Print a compact peek to stdout for CI logs.
    if (summary.meta.arrivals > 0) {
        console.log('\nThree-way accuracy by horizon (each source bucketed by its own horizon):');
        const flatRows = {};
        for (const [bucket, sources] of Object.entries(summary.byHorizon)) {
            flatRows[bucket] = {
                'calc.n':       sources.calc?.n        ?? 0,
                'calc.mae':     sources.calc?.mae      ?? null,
                'gtfs.n':       sources.gtfs?.n        ?? 0,
                'gtfs.mae':     sources.gtfs?.mae      ?? null,
                'blend.n':      sources.blend?.n       ?? 0,
                'blend.mae':    sources.blend?.mae     ?? null,
            };
        }
        consoleTablePlus(flatRows);

        console.log('\nHead-to-head (snapshots with both calc and gtfs):');
        consoleTablePlus({ headToHead: summary.headToHead });

        // gtfs-implausible substitution — did rejecting GTFS-RT and showing
        // calc instead help or hurt? Positive avgDeltaS means the gate's
        // substitution made things worse on average.
        if (summary.substitutionImpact) {
            console.log('\nGate substitution impact (rows where gtfsLooksPlausible rejected GTFS-RT):');
            consoleTablePlus({ substitutionImpact: summary.substitutionImpact });
        }
    }
}

main().catch(err => {
    console.error('[headless] fatal:', err);
    process.exit(1);
});
