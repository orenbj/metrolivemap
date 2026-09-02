#!/usr/bin/env node
/**
 * Visual + behavioural snapshot of the LIVE deployed site, on demand.
 *
 * Drives real Chromium via Playwright against the deployed URL under several
 * emulated devices (real touch / DPR / colour-scheme, so the `pointer: coarse`
 * and dark-mode CSS actually apply), waits for the live feeds to populate,
 * screenshots the map and the main rider interactions, and records what a
 * human reviewer cannot see in a screenshot: console errors, failed requests,
 * marker freshness, the feedStats report, nav timing / LCP / long tasks, JS
 * heap, and an axe-core accessibility scan. A separate boot tees the raw
 * WebSocket frames from Metro's feeds to gzipped JSONL so the same run can be
 * REPLAYED offline (see the review harness) with the real inter-fix gaps.
 *
 * Why CI, not a laptop: the sandboxed review environment cannot reach the WS
 * feeds at all (proxy has no WebSocket support), while GitHub runners can — the
 * same reason live-accuracy.yml runs there. Outputs are committed back to the
 * branch by the workflow because Actions artifacts are not fetchable from that
 * sandbox but `git fetch` is.
 *
 * CLI:
 *   node scripts/review-live-snapshot.js [--url=https://…] [--out=review-out/tag]
 *        [--feed-seconds=25] [--vp-seconds=30] [--tu-seconds=5] [--no-record]
 *        [--contexts=phone-light,desktop-light]
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { chromium, devices } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const a = {
        url: 'https://orenbj.github.io/metrolivemap/',
        out: null,
        feedSeconds: 25,
        vpSeconds: 30,
        tuSeconds: 5,
        record: true,
        contexts: null,
    };
    for (const s of argv.slice(2)) {
        if      (s.startsWith('--url='))          a.url = s.slice(6);
        else if (s.startsWith('--out='))          a.out = s.slice(6);
        else if (s.startsWith('--feed-seconds=')) a.feedSeconds = Number(s.slice(15)) || a.feedSeconds;
        else if (s.startsWith('--vp-seconds='))   a.vpSeconds = Number(s.slice(13)) || a.vpSeconds;
        else if (s.startsWith('--tu-seconds='))   a.tuSeconds = Number(s.slice(13)) || a.tuSeconds;
        else if (s === '--no-record')             a.record = false;
        else if (s.startsWith('--contexts='))     a.contexts = s.slice(11).split(',').map(x => x.trim()).filter(Boolean);
    }
    if (!a.out) a.out = join(REPO_ROOT, 'review-out', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
    return a;
}

const log = (m) => console.log(`[snapshot ${new Date().toISOString().slice(11, 19)}] ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Contexts ────────────────────────────────────────────────────────────────
// Real device descriptors: hasTouch / isMobile / deviceScaleFactor come with
// them, which is what makes the app's `(hover: none) and (pointer: coarse)`
// CSS blocks apply. A bare 390×844 desktop viewport matches none of them.

const CONTEXTS = {
    'phone-light':      { ...devices['iPhone 13'], colorScheme: 'light' },
    'phone-dark':       { ...devices['iPhone 13'], colorScheme: 'dark' },
    'phone-standalone': { ...devices['iPhone 13'], colorScheme: 'light', standalone: true },
    'tablet-light':     { ...devices['iPad (gen 7)'], colorScheme: 'light' },
    'desktop-light':    { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'light' },
    'desktop-dark':     { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, colorScheme: 'dark' },
};

// Injected before any page script: buffers perf entries the page never exposes.
const INIT_SCRIPT = `
window.__perf = { longtasks: [], lcp: null };
try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__perf.longtasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true }); } catch {}
try { new PerformanceObserver(l => { const es = l.getEntries(); const last = es[es.length - 1]; if (last) window.__perf.lcp = Math.round(last.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
`;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function tapAt(page, ctxOpts, x, y) {
    if (ctxOpts.hasTouch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
}

async function shot(page, dir, name) {
    const path = join(dir, `${name}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 80 });
    return path;
}

async function safe(label, fn, outcomes) {
    try {
        const r = await fn();
        outcomes.push({ step: label, ok: true, detail: r ?? null });
        return r;
    } catch (e) {
        outcomes.push({ step: label, ok: false, error: String(e?.message ?? e).slice(0, 300) });
        return null;
    }
}

function pageState() {
    // Runs in the page. Everything here is read-only.
    const now = Date.now();
    const markers = Object.values(window.vehicleMarkers ?? {});
    const tiers = { live: 0, stale: 0, expired: 0, noReceipt: 0 };
    const byRoute = {};
    let sampleVehicleId = null;
    for (const m of markers) {
        const rc = m?.properties?.route_code ?? '?';
        byRoute[rc] = (byRoute[rc] ?? 0) + 1;
        const w = m?._lastAcceptedWallMs;
        if (!Number.isFinite(w)) { tiers.noReceipt++; continue; }
        const age = (now - w) / 1000;
        if (age < 90) tiers.live++; else if (age < 300) tiers.stale++; else tiers.expired++;
        if (!sampleVehicleId && m?.properties?.vehicle_id) sampleVehicleId = String(m.properties.vehicle_id).split('-')[0];
    }
    let ring = null;
    try { const r = JSON.parse(localStorage.getItem('feedStatsRing') || '[]'); ring = r[r.length - 1] ?? null; } catch {}
    const nav = performance.getEntriesByType('navigation')[0];
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map(p => [p.name, Math.round(p.startTime)]));
    return {
        markers: markers.length, tiers, byRoute, sampleVehicleId,
        stops: Object.keys(window.masterStopsData ?? {}).length,
        trips: Object.keys(window.masterTripsData ?? {}).length,
        arrivalsStops: window.masterArrivalsData?.size ?? 0,
        alertsRoutes: window.masterAlertsData?.size ?? 0,
        bikeStations: window.masterBikeStations?.size ?? 0,
        stationGroups: (window.stationGroups ?? []).length,
        feedStatsRingLast: ring,
        nav: nav ? {
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
            load: Math.round(nav.loadEventEnd),
            transferSize: nav.transferSize,
        } : null,
        paint,
        lcp: window.__perf?.lcp ?? null,
        longtasks: window.__perf?.longtasks ?? [],
        resources: performance.getEntriesByType('resource').length,
        darkMode: document.body.classList.contains('dark-mode'),
        loadingPresent: !!document.getElementById('loading'),
        zoom: window.map?.getZoom?.(),
        center: window.map?.getCenter?.(),
    };
}

// ── One emulated boot ───────────────────────────────────────────────────────

async function runContext(browser, name, ctxOpts, args, outRoot) {
    const dir = join(outRoot, name);
    mkdirSync(dir, { recursive: true });
    const { standalone, ...playwrightOpts } = ctxOpts;
    const context = await browser.newContext({ ...playwrightOpts, permissions: [] });
    await context.addInitScript(INIT_SCRIPT);
    const page = await context.newPage();

    const consoleErrors = [], consoleWarnings = [], pageErrors = [], failedRequests = [], badResponses = [];
    page.on('console', m => {
        const t = m.type();
        const entry = { text: m.text().slice(0, 400), loc: m.location()?.url?.slice(-80) };
        if (t === 'error') consoleErrors.push(entry); else if (t === 'warning') consoleWarnings.push(entry);
    });
    page.on('pageerror', e => pageErrors.push(String(e?.message ?? e).slice(0, 400)));
    page.on('requestfailed', r => failedRequests.push({ url: r.url().slice(0, 160), err: r.failure()?.errorText }));
    page.on('response', r => { if (r.status() >= 400) badResponses.push({ url: r.url().slice(0, 160), status: r.status() }); });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    if (standalone) {
        await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'display-mode', value: 'standalone' }] });
    }

    const outcomes = [];
    const t0 = Date.now();
    log(`[${name}] goto ${args.url}`);
    await page.goto(args.url, { waitUntil: 'load', timeout: 60_000 });

    // Splash removal = 2nd WS connect or the 15 s fallback (ui.js removeLoadingScreen).
    let splashMs = null;
    try { await page.waitForSelector('#loading', { state: 'detached', timeout: 25_000 }); splashMs = Date.now() - t0; }
    catch { splashMs = -1; }
    log(`[${name}] splash gone: ${splashMs} ms; feeding ${args.feedSeconds}s`);
    await sleep(args.feedSeconds * 1000);

    const heap = async () => {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const g = (k) => metrics.find(m => m.name === k)?.value ?? null;
        return { jsHeapUsedMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), jsHeapTotalMB: +(g('JSHeapTotalSize') / 1048576).toFixed(1), nodes: g('Nodes'), listeners: g('JSEventListeners') };
    };

    const stateA = await page.evaluate(pageState);
    const heapA = await heap();
    await shot(page, dir, '01-map');

    const vp = ctxOpts.viewport;
    const inView = (p) => p && p.x > 8 && p.y > 8 && p.x < vp.width - 8 && p.y < vp.height - 8;

    // 1. Station popup (+ expand nearby buses).
    await safe('station-popup', async () => {
        const pt = await page.evaluate(() => {
            const map = window.map; const groups = window.stationGroups ?? [];
            const w = innerWidth, h = innerHeight;
            // Prefer a station near the centre so the popup has room to render below the dot.
            const scored = groups.map(g => { const p = map.project([g.lon, g.lat]); return { g, p, d: Math.hypot(p.x - w / 2, p.y - h * 0.4) }; })
                .filter(s => s.p.x > 20 && s.p.y > 80 && s.p.x < w - 20 && s.p.y < h * 0.6)
                .sort((a, b) => a.d - b.d);
            const s = scored[0]; return s ? { x: s.p.x, y: s.p.y, name: s.g.displayName } : null;
        });
        if (!pt) throw new Error('no station in view');
        await tapAt(page, ctxOpts, pt.x, pt.y);
        await sleep(1500);
        const opened = await page.evaluate(() => !!document.querySelector('.maplibregl-popup'));
        await shot(page, dir, '02-station-popup');
        let expanded = false;
        const det = await page.$('.sp-bus-details');
        if (det) {
            const summary = await det.$('summary');
            if (summary) { const b = await summary.boundingBox(); if (b) { await tapAt(page, ctxOpts, b.x + b.width / 2, b.y + b.height / 2); await sleep(900); expanded = true; await shot(page, dir, '03-station-buses'); } }
        }
        await page.keyboard.press('Escape');
        await sleep(400);
        return { station: pt.name, opened, expanded };
    }, outcomes);

    // 2. Vehicle popup + follow.
    await safe('vehicle-popup', async () => {
        const boxes = await page.$$eval('.marker', els => els.map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; }));
        const cand = boxes.filter(b => inView(b) && b.w > 4).sort((a, b) => Math.hypot(a.x - vp.width / 2, a.y - vp.height / 2) - Math.hypot(b.x - vp.width / 2, b.y - vp.height / 2))[0];
        if (!cand) throw new Error(`no vehicle marker in view (${boxes.length} total)`);
        await tapAt(page, ctxOpts, cand.x, cand.y);
        await sleep(1200);
        const opened = await page.evaluate(() => !!document.querySelector('.vehicle-popup'));
        await shot(page, dir, '04-vehicle-popup');
        let followed = false;
        const fb = await page.$('.pv2-follow-btn');
        if (fb) {
            const b = await fb.boundingBox();
            if (b) { await tapAt(page, ctxOpts, b.x + b.width / 2, b.y + b.height / 2); await sleep(2500); followed = true; await shot(page, dir, '05-follow'); }
            const stop = await page.$('.follow-chip-stop');
            if (stop) { const s = await stop.boundingBox(); if (s) await tapAt(page, ctxOpts, s.x + s.width / 2, s.y + s.height / 2); }
        }
        await page.keyboard.press('Escape');
        await sleep(400);
        return { markerSize: { w: cand.w, h: cand.h }, opened, followed };
    }, outcomes);

    // 3. Search: station, then a live vehicle id.
    await safe('search', async () => {
        const input = await page.$('#station-search');
        if (!input) throw new Error('#station-search missing');
        await input.click();
        await page.keyboard.type('Union', { delay: 40 });
        await sleep(700);
        const n1 = await page.$$eval('#search-results [role="option"], #search-results li, #search-results button', els => els.length);
        await shot(page, dir, '06-search-station');
        await input.fill('');
        const vid = stateA.sampleVehicleId;
        let n2 = null;
        if (vid) {
            await page.keyboard.type(vid, { delay: 40 });
            await sleep(700);
            n2 = await page.$$eval('#search-results [role="option"], #search-results li, #search-results button', els => els.length);
            await shot(page, dir, '07-search-vehicle');
        }
        await input.fill('');
        await page.keyboard.press('Escape');
        return { stationResults: n1, vehicleQuery: vid, vehicleResults: n2 };
    }, outcomes);

    // 4. Alerts panel.
    await safe('alerts-panel', async () => {
        const btn = await page.$('button[aria-label*="lert" i], .maplibregl-ctrl button[title*="lert" i]');
        if (!btn) throw new Error('alerts control not found');
        const b = await btn.boundingBox();
        await tapAt(page, ctxOpts, b.x + b.width / 2, b.y + b.height / 2);
        await sleep(1000);
        const open = await page.evaluate(() => !document.getElementById('alerts-panel')?.classList.contains('hidden'));
        const count = await page.$eval('#alerts-panel-count', e => e.textContent.trim()).catch(() => null);
        await shot(page, dir, '08-alerts-panel');
        const close = await page.$('#alerts-panel-close');
        if (close) { const c = await close.boundingBox(); if (c) await tapAt(page, ctxOpts, c.x + c.width / 2, c.y + c.height / 2); }
        await sleep(400);
        return { open, count };
    }, outcomes);

    // 5. Legend: desktop rows filter; phone uses the mini legend / sheet.
    await safe('legend', async () => {
        const mini = await page.$('#legend-mini');
        const miniVisible = mini ? await mini.isVisible() : false;
        if (miniVisible) {
            const b = await mini.boundingBox();
            await tapAt(page, ctxOpts, b.x + b.width / 2, b.y + b.height / 2);
            await sleep(900);
            await shot(page, dir, '09-legend-sheet');
            await page.keyboard.press('Escape');
            const closeBtn = await page.$('#sheet-close-btn, #legend-close-btn');
            if (closeBtn && await closeBtn.isVisible()) { const c = await closeBtn.boundingBox(); await tapAt(page, ctxOpts, c.x + c.width / 2, c.y + c.height / 2); }
            return { mode: 'sheet' };
        }
        const row = await page.$('.legend-row');
        if (!row) throw new Error('no legend row');
        const b = await row.boundingBox();
        await tapAt(page, ctxOpts, b.x + b.width / 2, b.y + b.height / 2);
        await sleep(700);
        const hidden = await page.evaluate(() => [...document.body.classList].filter(c => c.startsWith('hide-route-')));
        await shot(page, dir, '09-legend-filter');
        await tapAt(page, ctxOpts, b.x + b.width / 2, b.y + b.height / 2);
        await sleep(400);
        return { mode: 'rows', hiddenAfterClick: hidden };
    }, outcomes);

    // 6. axe-core (evaluate the source string — addScriptTag is blocked by script-src 'self').
    let axe = null;
    await safe('axe', async () => {
        const axePath = require.resolve('axe-core/axe.min.js');
        const src = readFileSync(axePath, 'utf8');
        await page.evaluate(src);
        axe = await page.evaluate(async () => {
            // `preload: false` — do NOT drop this without reading why.
            //
            // axe's CSSOM preload XHRs every cross-origin stylesheet so it can
            // analyse it. An XHR is governed by `connect-src`, and the app's
            // CSP correctly does NOT list fonts.googleapis.com there (nothing
            // in the app fetches that origin; the sheet loads under style-src
            // as a <link>). So axe's fetch is refused, and the capture recorded
            // a `connect-src` violation plus a failed request for the Google
            // Fonts URL in EVERY context — an artifact of the scan itself that
            // reads exactly like the live site failing to load its font. It
            // cost a full investigation before the "Couldn't load preload
            // assets" warning traced it back to axe.
            //
            // Nothing is given up: the only cross-origin sheet is Google Fonts,
            // which contains @font-face rules and no colour information, so the
            // colour-contrast rule is unaffected. preloadMedia is moot too —
            // the app has no <video>/<audio>.
            const r = await window.axe.run(document, { resultTypes: ['violations'], preload: false });
            return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => n.target.join(' ')) }));
        });
        return { violations: axe.length };
    }, outcomes);

    const stateB = await page.evaluate(pageState);
    const heapB = await heap();

    const metrics = {
        context: name, url: args.url, capturedAt: new Date().toISOString(),
        device: { viewport: vp, deviceScaleFactor: ctxOpts.deviceScaleFactor, hasTouch: !!ctxOpts.hasTouch, isMobile: !!ctxOpts.isMobile, colorScheme: ctxOpts.colorScheme, standalone: !!standalone, userAgent: ctxOpts.userAgent?.slice(0, 80) },
        splashMs, feedSeconds: args.feedSeconds,
        afterFeed: { state: stateA, heap: heapA },
        afterInteractions: { state: stateB, heap: heapB },
        outcomes,
        consoleErrors, consoleWarnings: consoleWarnings.slice(0, 50), pageErrors, failedRequests, badResponses,
        axeViolations: axe,
    };
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
    await context.close();
    log(`[${name}] done — markers ${stateA.markers}, console errors ${consoleErrors.length}, axe ${axe?.length ?? 'n/a'}`);
    return metrics;
}

// ── Raw frame recording (separate boot) ─────────────────────────────────────

async function recordFrames(browser, args, outRoot) {
    const dir = join(outRoot, 'frames');
    mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: [] });
    const page = await context.newPage();
    const feeds = {};            // key → { url, frames: [], budgetMs, first: null, sample: null }
    const budgetFor = (url) => (url.includes('trip_updates') ? args.tuSeconds : args.vpSeconds) * 1000;
    const keyFor = (url) => {
        const m = url.match(/\/ws\/([^/]+)\/([^/?]+)/); const op = m?.[1] ?? 'x', ep = m?.[2] ?? 'y';
        return `${op}.${ep.replace('vehicle_positions', 'vp').replace('trip_updates', 'tu')}`;
    };
    const captureStart = Date.now();

    await page.routeWebSocket(/api\.metro\.net/, ws => {
        const server = ws.connectToServer();
        const key = keyFor(ws.url());
        const rec = (feeds[key] ??= { url: ws.url(), frames: [], budgetMs: budgetFor(ws.url()), first: null, sample: null, dropped: 0 });
        server.onMessage(msg => {
            const now = Date.now();
            if (rec.first == null) rec.first = now;
            if (now - rec.first <= rec.budgetMs) {
                const data = typeof msg === 'string' ? msg : msg.toString('utf8');
                rec.frames.push({ t: now - captureStart, d: data });
                if (!rec.sample && data.length < 4000) rec.sample = data;
            } else rec.dropped++;
            ws.send(msg);
        });
        ws.onMessage(msg => server.send(msg));   // client → server ('ping' keepalives)
    });

    log(`[frames] goto ${args.url}; VP ${args.vpSeconds}s, TU ${args.tuSeconds}s`);
    await page.goto(args.url, { waitUntil: 'load', timeout: 60_000 });
    await sleep((Math.max(args.vpSeconds, args.tuSeconds) + 8) * 1000);

    const meta = { captureStartMs: captureStart, capturedAt: new Date(captureStart).toISOString(), url: args.url, feeds: {} };
    for (const [key, rec] of Object.entries(feeds)) {
        const body = rec.frames.map(f => JSON.stringify(f)).join('\n') + '\n';
        writeFileSync(join(dir, `${key}.jsonl.gz`), gzipSync(Buffer.from(body)));
        meta.feeds[key] = { url: rec.url, frames: rec.frames.length, budgetMs: rec.budgetMs, firstFrameOffsetMs: rec.first ? rec.first - captureStart : null, droppedAfterBudget: rec.dropped, bytes: body.length };
        if (rec.sample) writeFileSync(join(dir, `${key}.sample.json`), rec.sample);
        log(`[frames] ${key}: ${rec.frames.length} frames (${(body.length / 1024).toFixed(0)} KB raw)`);
    }
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    await context.close();
    return meta;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv);
    mkdirSync(args.out, { recursive: true });
    const names = args.contexts ?? Object.keys(CONTEXTS);
    log(`out: ${args.out}; contexts: ${names.join(', ')}`);
    // REVIEW_CHROMIUM_PATH: point at a pre-installed Chromium when the local
    // Playwright cache has no matching build (the CI image never needs it).
    const executablePath = process.env.REVIEW_CHROMIUM_PATH || undefined;
    const browser = await chromium.launch({ args: ['--no-sandbox'], executablePath });
    const results = [];
    try {
        for (const name of names) {
            if (!CONTEXTS[name]) { log(`unknown context ${name} — skipping`); continue; }
            try { results.push(await runContext(browser, name, CONTEXTS[name], args, args.out)); }
            catch (e) { log(`[${name}] FAILED: ${e.message}`); results.push({ context: name, failed: String(e.message).slice(0, 300) }); }
        }
        let frames = null;
        if (args.record) {
            try { frames = await recordFrames(browser, args, args.out); }
            catch (e) { log(`[frames] FAILED: ${e.message}`); frames = { failed: String(e.message).slice(0, 300) }; }
        }
        const lines = [
            `# review-live-snapshot — ${new Date().toISOString()}`, '', `URL: ${args.url}`, '',
            '| context | splash ms | markers | live/stale/exp | trips | console err | page err | failed req | axe | heap MB |', '|---|---|---|---|---|---|---|---|---|---|',
            ...results.map(r => r.failed ? `| ${r.context} | FAILED: ${r.failed} |` :
                `| ${r.context} | ${r.splashMs} | ${r.afterFeed.state.markers} | ${r.afterFeed.state.tiers.live}/${r.afterFeed.state.tiers.stale}/${r.afterFeed.state.tiers.expired} | ${r.afterFeed.state.trips} | ${r.consoleErrors.length} | ${r.pageErrors.length} | ${r.failedRequests.length} | ${r.axeViolations?.length ?? 'n/a'} | ${r.afterFeed.heap.jsHeapUsedMB}→${r.afterInteractions.heap.jsHeapUsedMB} |`),
            '',
            ...(frames?.feeds ? ['## Frames', ...Object.entries(frames.feeds).map(([k, v]) => `- ${k}: ${v.frames} frames in ${v.budgetMs / 1000}s`)] : ['## Frames', `- ${frames?.failed ?? 'not recorded'}`]),
            '', '## Interaction outcomes',
            ...results.filter(r => !r.failed).flatMap(r => r.outcomes.map(o => `- ${r.context} / ${o.step}: ${o.ok ? 'ok ' + JSON.stringify(o.detail) : 'FAIL ' + o.error}`)),
        ];
        writeFileSync(join(args.out, 'summary.md'), lines.join('\n') + '\n');
        console.log('\n' + lines.join('\n'));
    } finally {
        await browser.close();
    }
}

main().catch(e => { console.error(e); process.exit(1); });
