/**
 * audit-feeds.js
 * 10-minute reliability audit across all Metro GTFS-RT feeds.
 *
 * Usage:  node scripts/audit-feeds.js
 *
 * Reports:
 *   - Message rate per feed (msgs/min)
 *   - Reconnect count per feed
 *   - Vehicle staleness distribution (gap between updates per vehicle)
 *   - Feed agreement: vehicles in positions-only vs trip_updates-only vs both
 *   - Trip ID coverage: % of live trip IDs found in static trips.json
 *   - Per-route vehicle count and avg update gap
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DURATION_MIN  = 10;
const REPORT_EVERY  = 60_000; // ms

const trips = JSON.parse(readFileSync(join(__dirname, '../data/trips.json'), 'utf8'));

// ── Feed stats ────────────────────────────────────────────────────────────────

const feeds = {
    rail_pos:    { url: 'wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions',      msgs: 0, reconnects: 0, lastMsg: null },
    bus_pos:     { url: 'wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901',   msgs: 0, reconnects: 0, lastMsg: null },
    rail_trips:  { url: 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates',           msgs: 0, reconnects: 0, lastMsg: null },
    bus_trips:   { url: 'wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950',    msgs: 0, reconnects: 0, lastMsg: null },
};

// ── Vehicle tracking ──────────────────────────────────────────────────────────

// positions feed: tripId → { vehicleId, routeCode, lastTs, gaps[], tripIdInStatic }
const posVehicles  = new Map();
// trip_updates feed: vehicleId → { routeId, lastTs }
const tupVehicles  = new Map();

function recordPos(msg) {
    const v = msg?.vehicle;
    if (!v?.trip?.tripId) return;

    let ts = parseInt(v.timestamp);
    if (Number.isFinite(ts) && ts > 10_000_000_000) ts = Math.floor(ts / 1000);
    if (!Number.isFinite(ts)) ts = Math.floor(Date.now() / 1000);

    const tripId    = String(v.trip.tripId);
    const vehicleId = String(v.vehicle?.id ?? '');
    const routeCode = String(msg.route_code ?? '');

    const prev = posVehicles.get(tripId);
    if (prev) {
        const gap = ts - prev.lastTs;
        if (gap > 0 && gap < 3600) prev.gaps.push(gap);
        prev.lastTs = ts;
    } else {
        posVehicles.set(tripId, {
            vehicleId, routeCode, lastTs: ts, gaps: [],
            tripIdInStatic: !!trips[tripId],
        });
    }
}

function recordTup(msg) {
    const tu = msg?.tripUpdate;
    if (!tu?.stopTimeUpdate?.length) return;
    const vehicleId = String(tu.vehicle?.id ?? '');
    const routeId   = String(tu.trip?.routeId ?? '').split('-')[0];
    const now       = Math.floor(Date.now() / 1000);
    tupVehicles.set(vehicleId, { routeId, lastTs: now });
}

// ── WebSocket connections ─────────────────────────────────────────────────────

function connectWS(feedKey, onMessage) {
    const feed = feeds[feedKey];
    const attempt = () => {
        const ws = new WebSocket(feed.url);
        ws.addEventListener('open',    () => { feed.lastMsg = Date.now(); console.log(`[ws] ✓ ${feedKey}`); });
        ws.addEventListener('message', e => {
            feed.msgs++;
            feed.lastMsg = Date.now();
            try { onMessage(JSON.parse(e.data)); } catch {}
        });
        ws.addEventListener('close', () => {
            feed.reconnects++;
            console.log(`[ws] ↺ ${feedKey} (reconnect #${feed.reconnects})`);
            setTimeout(attempt, 5000);
        });
        ws.addEventListener('error', () => ws.close());
    };
    attempt();
}

connectWS('rail_pos',   msg => recordPos(msg));
connectWS('bus_pos',    msg => recordPos(msg));
connectWS('rail_trips', msg => recordTup(msg));
connectWS('bus_trips',  msg => recordTup(msg));

// ── Reporting ─────────────────────────────────────────────────────────────────

const startTime = Date.now();
let reportNum = 0;

function printReport(final = false) {
    reportNum++;
    const elapsed   = (Date.now() - startTime) / 1000;
    const elMin     = (elapsed / 60).toFixed(1);
    const header    = final ? '═══ FINAL REPORT' : `── ${elMin}m interim`;

    console.log(`\n${header} ────────────────────────────────────────────────────`);

    // Feed message rates
    console.log('\n┌ Feed message rates');
    for (const [key, f] of Object.entries(feeds)) {
        const rate   = (f.msgs / (elapsed / 60)).toFixed(1);
        const silenceMs = f.lastMsg ? Math.round((Date.now() - f.lastMsg) / 1000) : null;
        const silence = silenceMs != null ? `last msg ${silenceMs}s ago` : 'no messages';
        console.log(`│  ${key.padEnd(12)} ${String(f.msgs).padStart(6)} msgs  ${rate.padStart(6)}/min  reconnects=${f.reconnects}  ${silence}`);
    }

    // Positions vehicles
    const allPos    = [...posVehicles.values()];
    const withGaps  = allPos.filter(v => v.gaps.length > 0);
    const allGaps   = withGaps.flatMap(v => v.gaps).sort((a, b) => a - b);
    const inStatic  = allPos.filter(v => v.tripIdInStatic).length;

    console.log('\n┌ Vehicle positions feed');
    console.log(`│  Unique vehicles seen : ${allPos.length}`);
    console.log(`│  Trip IDs in static   : ${inStatic} / ${allPos.length}  (${pct(inStatic, allPos.length)})`);
    if (allGaps.length) {
        console.log(`│  Update gap (p50/p90) : ${percentile(allGaps, 50).toFixed(0)}s / ${percentile(allGaps, 90).toFixed(0)}s`);
        console.log(`│  Gaps > 60s           : ${allGaps.filter(g => g > 60).length} / ${allGaps.length}  (${pct(allGaps.filter(g=>g>60).length, allGaps.length)})`);
        console.log(`│  Gaps > 120s          : ${allGaps.filter(g => g > 120).length} / ${allGaps.length}  (${pct(allGaps.filter(g=>g>120).length, allGaps.length)})`);
    }

    // Trip updates vehicles
    console.log('\n┌ Trip updates feed');
    console.log(`│  Unique vehicles seen : ${tupVehicles.size}`);

    // Feed agreement
    const posVehicleIds  = new Set(allPos.map(v => v.vehicleId));
    const tupVehicleIds  = new Set(tupVehicles.keys());
    const both           = [...posVehicleIds].filter(id => tupVehicleIds.has(id));
    const posOnly        = [...posVehicleIds].filter(id => !tupVehicleIds.has(id));
    const tupOnly        = [...tupVehicleIds].filter(id => !posVehicleIds.has(id));

    console.log('\n┌ Feed agreement (vehicleId overlap)');
    console.log(`│  In both feeds        : ${both.length}`);
    console.log(`│  Positions-only       : ${posOnly.length}  ${posOnly.slice(0,3).join(', ')}`);
    console.log(`│  Trip-updates-only    : ${tupOnly.length}  ${tupOnly.slice(0,3).join(', ')}`);

    // Per-route breakdown
    const byRoute = new Map();
    for (const v of allPos) {
        if (!byRoute.has(v.routeCode)) byRoute.set(v.routeCode, { count: 0, gaps: [] });
        const r = byRoute.get(v.routeCode);
        r.count++;
        r.gaps.push(...v.gaps);
    }
    const LETTER = { '801':'A','802':'B','803':'C','804':'E','805':'D','806':'L','807':'K','901':'G','910':'J','950':'J' };

    console.log('\n┌ Per-route (positions feed)');
    [...byRoute.entries()]
        .sort(([a],[b]) => (LETTER[a]??a).localeCompare(LETTER[b]??b))
        .forEach(([rc, r]) => {
            const avgGap = r.gaps.length ? (r.gaps.reduce((s,x)=>s+x,0)/r.gaps.length).toFixed(0) : '—';
            const p90g   = r.gaps.length ? percentile([...r.gaps].sort((a,b)=>a-b), 90).toFixed(0) : '—';
            const letter = LETTER[rc] ?? rc;
            console.log(`│  Line ${letter}  vehicles=${String(r.count).padStart(3)}  avg_gap=${String(avgGap).padStart(4)}s  p90_gap=${String(p90g).padStart(4)}s`);
        });

    if (final) {
        console.log('\n════════════════════════════════════════════════════════════════');
    }
}

const reportInterval = setInterval(() => printReport(false), REPORT_EVERY);

setTimeout(() => {
    clearInterval(reportInterval);
    printReport(true);
    process.exit(0);
}, DURATION_MIN * 60 * 1000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n, total) { return total ? `${Math.round(n/total*100)}%` : '0%'; }
function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(i);
    return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}
