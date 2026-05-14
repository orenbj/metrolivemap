#!/usr/bin/env node
/**
 * Headless rendering-perf baseline harness.
 *
 * Boots the live map under Playwright Chromium, pins a representative
 * viewport (zoom level + region with the largest typical vehicle count),
 * runs for N seconds, and captures:
 *
 *   - per-frame rAF intervals (ms) → median, p95, p99, longest stall
 *   - count of frames > 16.7 ms (target 60 fps budget overruns)
 *   - count of long tasks (>50 ms, per the LongTask API)
 *   - approximate marker count at capture-start and capture-end
 *
 * Output goes to a summary.json the next run can diff against. This is the
 * regression yardstick for Phase 5: today's `_arcTick` integrator runs once
 * per active marker per frame, so the per-frame cost scales with fleet
 * size. Phase 5's single render loop reading `Trajectory.positionAt(t_now)`
 * should be at least as fast, ideally a bit cheaper — this script proves it.
 *
 * Usage:
 *   node scripts/perf-baseline.js                          # 2 min default
 *   node scripts/perf-baseline.js --duration=5m --tag=pre-phase5
 *   node scripts/perf-baseline.js --port=4173 --zoom=12
 *
 * Output (relative to repo root):
 *   artifacts/perf-baseline-{tag}.summary.json
 *
 * Compare runs by diffing two summaries:
 *   jq '{median, p95, p99, longestStall, overBudgetFrames, markerCount}' \
 *     artifacts/perf-baseline-pre.summary.json \
 *     artifacts/perf-baseline-post.summary.json
 *
 * Targets (current default zoom 12, central LA):
 *   median ≤ 16.7 ms        — at 60 fps budget
 *   p95    ≤ 33   ms        — at 30 fps minimum
 *   p99    ≤ 50   ms        — Long-Task threshold
 *   overBudgetFrames < 10%  — frame budget overruns
 *   longestStall    < 200 ms — any pause longer than this is a problem
 *
 * Why not test:
 *   - Vitest runs in jsdom; rAF doesn't actually tick at display rate.
 *   - The numbers we care about are CSS-transform + MapLibre projection
 *     cost, which only mean anything in a real renderer.
 *   - Playwright drives real Chromium, so the perf trace is representative.
 */

import { writeFileSync, mkdirSync, existsSync, statSync, createReadStream } from 'node:fs';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath }                     from 'node:url';
import { createServer }                      from 'node:http';
import { chromium }                          from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const DEFAULT_DURATION_MS = 2 * 60 * 1000;
const WARMUP_MS           = 5_000;             // skip first 5 s so we're not measuring map-load + first WS-frame burst

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = {
        duration: DEFAULT_DURATION_MS,
        zoom:     12,
        port:     4173,
        tag:      null,
    };
    for (const a of argv.slice(2)) {
        if      (a.startsWith('--duration=')) args.duration = parseDuration(a.slice(11)) ?? DEFAULT_DURATION_MS;
        else if (a.startsWith('--zoom='))     args.zoom     = Number(a.slice(7)) || 12;
        else if (a.startsWith('--port='))     args.port     = Number(a.slice(7)) || 4173;
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

// ── Static server (mirrors live-accuracy-headless.js) ──────────────────────

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
                const safe    = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/\\/g, '/');
                let fsPath    = join(REPO_ROOT, safe === '/' ? 'index.html' : safe);
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

// ── In-page instrumentation ────────────────────────────────────────────────
// Injected via page.evaluate before the warmup window starts. Records every
// rAF frame's interval (ms since previous frame) and every Long Task (>50 ms).
// Returns the captured arrays on demand.

const INSTRUMENT_SRC = `
(() => {
    const frames = [];
    const longTasks = [];
    let prev = performance.now();

    const tick = (t) => {
        frames.push(t - prev);
        prev = t;
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    if (typeof PerformanceObserver === 'function') {
        try {
            new PerformanceObserver(list => {
                for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration });
            }).observe({ entryTypes: ['longtask'] });
        } catch { /* longtask not supported in this env — skip */ }
    }

    window.__perfBaseline = {
        snapshot: () => ({
            frames:    frames.slice(),
            longTasks: longTasks.slice(),
            markerCount: Object.keys(window.vehicleMarkers ?? {}).length,
        }),
        reset: () => { frames.length = 0; longTasks.length = 0; prev = performance.now(); },
    };
})();
`;

// ── Summarise frame intervals ──────────────────────────────────────────────

function summarise(frames, longTasks, markerCountStart, markerCountEnd) {
    const sorted = frames.slice().sort((a, b) => a - b);
    const n      = sorted.length;
    const pct    = (p) => sorted[Math.min(n - 1, Math.floor(n * p))];

    const overBudget = frames.filter(f => f > 16.7).length;

    return {
        meta: {
            framesCaptured: n,
            durationApproxS: Math.round(frames.reduce((s, f) => s + f, 0) / 1000),
            timestamp: new Date().toISOString(),
        },
        rafFrameMs: {
            median:        n ? pct(0.5)  : null,
            p95:           n ? pct(0.95) : null,
            p99:           n ? pct(0.99) : null,
            max:           n ? sorted[n - 1] : null,
            mean:          n ? (frames.reduce((s, f) => s + f, 0) / n) : null,
            overBudgetCount: overBudget,
            overBudgetPct:   n ? +(overBudget * 100 / n).toFixed(2) : null,
        },
        longTasks: {
            count:        longTasks.length,
            longestMs:    longTasks.length ? Math.max(...longTasks.map(t => t.duration)) : 0,
            totalMs:      longTasks.reduce((s, t) => s + t.duration, 0),
        },
        markers: {
            atStart: markerCountStart,
            atEnd:   markerCountEnd,
        },
    };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const args   = parseArgs(process.argv);
    const tag    = args.tag ?? `manual-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const outDir = join(REPO_ROOT, 'artifacts');
    const outPath = join(outDir, `perf-baseline-${tag}.summary.json`);

    const server = await startStaticServer(args.port);
    const browser = await chromium.launch();
    const ctx     = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page    = await ctx.newPage();

    try {
        console.log(`[perf] loading http://localhost:${args.port}/`);
        await page.goto(`http://localhost:${args.port}/`, { waitUntil: 'load' });

        // Wait for the live feed to populate at least some markers — without
        // this the warmup measures the empty-map idle rAF, which is misleading.
        await page.waitForFunction(
            () => Object.keys(window.vehicleMarkers ?? {}).length >= 5,
            null,
            { timeout: 60_000 },
        );

        await page.evaluate(zoom => window.map.setZoom(zoom), args.zoom);

        // Inject instrumentation, let it warm up, then reset so the captured
        // window excludes the first-paint + first-batch-of-frames burst.
        await page.evaluate(INSTRUMENT_SRC);
        await page.waitForTimeout(WARMUP_MS);
        const markerCountStart = await page.evaluate(() => window.__perfBaseline.snapshot().markerCount);
        await page.evaluate(() => window.__perfBaseline.reset());

        console.log(`[perf] capturing for ${args.duration / 1000}s …`);
        await page.waitForTimeout(args.duration);

        const snap = await page.evaluate(() => window.__perfBaseline.snapshot());
        const summary = summarise(snap.frames, snap.longTasks, markerCountStart, snap.markerCount);

        mkdirSync(outDir, { recursive: true });
        writeFileSync(outPath, JSON.stringify(summary, null, 2));
        console.log(`[perf] wrote ${outPath}`);
        console.log(`        rAF median=${summary.rafFrameMs.median?.toFixed(2)}ms p95=${summary.rafFrameMs.p95?.toFixed(2)}ms p99=${summary.rafFrameMs.p99?.toFixed(2)}ms max=${summary.rafFrameMs.max?.toFixed(2)}ms`);
        console.log(`        overBudget ${summary.rafFrameMs.overBudgetCount}/${summary.meta.framesCaptured} (${summary.rafFrameMs.overBudgetPct}%) longestStall ${summary.rafFrameMs.max?.toFixed(2)}ms`);
        console.log(`        longTasks  ${summary.longTasks.count} longest=${summary.longTasks.longestMs.toFixed(2)}ms total=${summary.longTasks.totalMs.toFixed(2)}ms`);
        console.log(`        markers    ${summary.markers.atStart} → ${summary.markers.atEnd}`);
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
