#!/usr/bin/env node
/**
 * Node-runnable live-accuracy harness.
 *
 * Connects to all 4 Metro GTFS-RT WebSocket feeds (rail+bus vehicle_positions,
 * rail+bus trip_updates) and captures actual-vs-predicted arrival errors over
 * a configurable duration. Output is structured JSONL + a summary.json file
 * for offline inspection.
 *
 * Scope (pragmatic):
 *   This harness measures **GTFS-RT prediction accuracy** end-to-end. It
 *   tracks vehicles by trip_id, snapshots each stop's predicted arrival every
 *   SNAPSHOT_INTERVAL_S, and records the actual arrival as the moment a
 *   vehicle goes STOPPED_AT that stop. It does NOT run the full hybrid
 *   calc-blend pipeline (predictions.js requires shape data + window globals
 *   that are awkward to polyfill server-side); calc-accuracy is covered by
 *   the synthetic unit suite.
 *
 * Output:
 *   - scripts/live-accuracy-{ISO}.jsonl       — one event per line
 *     events: 'snapshot' | 'arrival' | 'feed-stat'
 *   - scripts/live-accuracy-{ISO}.summary.json — aggregated by-route /
 *     by-horizon stats produced via tests/_lib/accuracy-aggregator.js
 *
 * CLI flags:
 *   --quick=5min|10min|30min   shorthand duration (default 60min)
 *   --duration=Nm | Ns         explicit duration
 *   --route=801,802            limit to a route allowlist
 *   --out=path                 override output prefix
 *   --buckets=auto|coarse      horizon bucket scheme
 *
 * Uses:
 *   - Native Node 22+ WebSocket (no extra deps)
 *   - tests/_lib/accuracy-aggregator.js for stats and summarize()
 *
 * Run:
 *   npm run test:live              # 60-minute capture
 *   npm run test:live -- --quick=5min --route=801
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    consoleTablePlus, flattenSnapshots, stats, bucketByRoute,
    DEFAULT_BUCKETS, COARSE_BUCKETS,
} from '../tests/_lib/accuracy-aggregator.js';
import { parseDuration } from '../tests/_lib/cli-utils.js';
import { METRO_WS_FEEDS } from '../js/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──────────────────────────────────────────────────────────

// Shared with production (js/config.js) so the capture can't drift from what
// the app actually subscribes to. The previous hand-copied list HAD drifted:
// busVp was '901,910' — route 950 (J Line express) was silently absent from
// every Node-harness capture — and busTu was route-filtered where production
// is unfiltered.
const FEEDS = {
    railVp: METRO_WS_FEEDS.RAIL_VP,
    busVp:  METRO_WS_FEEDS.BUS_VP,
    railTu: METRO_WS_FEEDS.RAIL_TU,
    busTu:  METRO_WS_FEEDS.BUS_TU,
};

const DEFAULT_DURATION_MS    = 60 * 60 * 1000;  // 60 min
const SNAPSHOT_INTERVAL_S    = 15;
const MIN_HORIZON_S          = 10;
const MAX_HORIZON_S          = 1800;
const PING_INTERVAL_MS       = 30_000;
const RECONNECT_BASE_MS      = 5_000;
const RECONNECT_MAX_MS       = 60_000;
const EXCLUDE_ROUTES         = new Set(['805']); // D Line pre-revenue

// ── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const args = { duration: DEFAULT_DURATION_MS, routes: null, out: null, buckets: 'auto' };
    for (const a of argv.slice(2)) {
        if (a.startsWith('--quick=')) {
            const v = a.slice(8);
            args.duration = parseDuration(v) ?? DEFAULT_DURATION_MS;
        } else if (a.startsWith('--duration=')) {
            args.duration = parseDuration(a.slice(11)) ?? DEFAULT_DURATION_MS;
        } else if (a.startsWith('--route=')) {
            args.routes = new Set(a.slice(8).split(',').map(s => s.trim()).filter(Boolean));
        } else if (a.startsWith('--out=')) {
            args.out = a.slice(6);
        } else if (a.startsWith('--buckets=')) {
            args.buckets = a.slice(10);
        }
    }
    return args;
}

// ── Capture state ──────────────────────────────────────────────────────────

const state = {
    vehicles: new Map(),        // tripId → latest vehicle snapshot
    arrivals: new Map(),        // stopId → Map<tripId, {arrivalUnix, lastIngest}>
    pending:  new Map(),        // predKey → entry with snapshots[]
    arrived:  new Set(),
    results:  [],               // finalized arrivals
    feedStats: {                // per-feed health counters
        railVp: { msgs: 0, lastAt: 0, reconnects: 0 },
        busVp:  { msgs: 0, lastAt: 0, reconnects: 0 },
        railTu: { msgs: 0, lastAt: 0, reconnects: 0 },
        busTu:  { msgs: 0, lastAt: 0, reconnects: 0 },
    },
};

// ── WebSocket lifecycle ────────────────────────────────────────────────────

function connect(name, url, onMessage, attempt = 0) {
    const ws = new WebSocket(url);
    let pingTimer;

    ws.addEventListener('open', () => {
        attempt = 0;
        state.feedStats[name].lastAt = Date.now();
        pingTimer = setInterval(() => {
            try { ws.send('ping'); } catch { /* readyState bounce */ }
        }, PING_INTERVAL_MS);
        log(`[${name}] connected`);
    });

    ws.addEventListener('message', (ev) => {
        state.feedStats[name].msgs++;
        state.feedStats[name].lastAt = Date.now();
        try { onMessage(JSON.parse(ev.data)); } catch { /* malformed frame */ }
    });

    ws.addEventListener('close', () => {
        clearInterval(pingTimer);
        const delay = Math.min(RECONNECT_BASE_MS * (2 ** attempt), RECONNECT_MAX_MS);
        state.feedStats[name].reconnects++;
        log(`[${name}] closed — reconnecting in ${(delay / 1000).toFixed(0)}s`);
        setTimeout(() => connect(name, url, onMessage, attempt + 1), delay);
    });

    ws.addEventListener('error', () => { /* close handler will reconnect */ });
}

// ── Message handlers ───────────────────────────────────────────────────────

function handleVp(name, msg, args, jsonl) {
    const v = msg.vehicle;
    if (!v?.position || !v?.trip?.tripId) return;

    const lat = v.position.latitude, lng = v.position.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    let routeCode = String(msg.route_code ?? v.trip?.routeId ?? '').split('-')[0];
    if (EXCLUDE_ROUTES.has(routeCode)) return;
    if (args.routes && !args.routes.has(routeCode)) return;

    const tripId        = String(v.trip.tripId);
    const vehicleId     = String(v.vehicle?.id ?? '');
    const stopId        = v.stopId != null ? String(v.stopId) : null;
    const currentStatus = v.currentStatus;
    let ts = parseInt(v.timestamp, 10);
    if (Number.isFinite(ts) && ts > 10_000_000_000) ts = Math.floor(ts / 1000);

    state.vehicles.set(tripId, { tripId, vehicleId, routeCode, stopId, currentStatus, lat, lng, ts });

    const stopped = currentStatus === 'STOPPED_AT' || currentStatus === 1;

    // Arrival via STOPPED_AT: mark every pending predKey for this (vehicle, trip, stopId).
    if (stopped && stopId) {
        const predKey = `${vehicleId}:${tripId}:${stopId}`;
        const entry = state.pending.get(predKey);
        if (entry && !state.arrived.has(predKey)) {
            state.arrived.add(predKey);
            const cleanSnaps = entry.snapshots.filter(s => s.tripId === entry.tripId);
            if (cleanSnaps.length) {
                const result = {
                    vehicleId: entry.vehicleId, tripId: entry.tripId,
                    stopId: entry.targetStopId, routeId: entry.routeId,
                    actualUnix: ts, snapshots: cleanSnaps,
                };
                state.results.push(result);
                jsonl.write({ kind: 'arrival', ...result });
            }
        }
    }

    // Snapshot the *current next stop* prediction every SNAPSHOT_INTERVAL_S.
    if (!stopped && stopId) {
        const predKey = `${vehicleId}:${tripId}:${stopId}`;
        let entry = state.pending.get(predKey);
        if (!entry) {
            entry = {
                targetStopId: stopId, vehicleId, tripId, routeId: routeCode,
                snapshots: [],
            };
            state.pending.set(predKey, entry);
        }
        const last = entry.snapshots[entry.snapshots.length - 1];
        const nowSec = Math.floor(Date.now() / 1000);
        if (last && nowSec - last.recordedAt < SNAPSHOT_INTERVAL_S) return;

        // Look up GTFS-RT prediction for this (stopId, tripId)
        const stopMap = state.arrivals.get(stopId);
        const gtfsEntry = stopMap?.get(tripId);
        const gtfsEta = gtfsEntry?.arrivalUnix ?? null;
        if (gtfsEta == null) return;
        const horizon = gtfsEta - nowSec;
        if (horizon < MIN_HORIZON_S || horizon > MAX_HORIZON_S) return;

        const snap = {
            recordedAt: nowSec,
            tripId,
            calcEta: null,    // not computed in Node harness — see header
            gtfsEta,
            horizonCalc: null,
            horizonGtfs: horizon,
            intermediates: 0,
            adherence: null,
            atOrigin: false,
            speedMult: null,
            capped: false,
        };
        entry.snapshots.push(snap);
        jsonl.write({ kind: 'snapshot', predKey, ...snap, routeId: routeCode });
    }
}

function handleTu(name, msg, args, jsonl) {
    const tu = msg.tripUpdate;
    if (!tu?.stopTimeUpdate?.length) return;
    const tripId = String(tu.trip?.tripId ?? '');
    const routeId = String(tu.trip?.routeId ?? '').split('-')[0];
    if (EXCLUDE_ROUTES.has(routeId)) return;
    if (args.routes && !args.routes.has(routeId)) return;

    const vehicleId = String(tu.vehicle?.id ?? '');
    const directionId = tu.trip?.directionId != null ? Number(tu.trip.directionId) : null;
    const now = Math.floor(Date.now() / 1000);

    for (const stu of tu.stopTimeUpdate) {
        const stopId = String(stu.stopId ?? '');
        const arrivalUnix = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
        if (!stopId || !arrivalUnix || arrivalUnix < now) continue;

        if (!state.arrivals.has(stopId)) state.arrivals.set(stopId, new Map());
        state.arrivals.get(stopId).set(tripId, {
            arrivalUnix, vehicleId, routeId, directionId, lastIngest: now,
        });
    }
}

// ── Output ─────────────────────────────────────────────────────────────────

function ensureDir(path) {
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* exists */ }
}

function makeJsonl(prefix) {
    const path = `${prefix}.jsonl`;
    ensureDir(path);
    writeFileSync(path, '');
    return {
        path,
        write(obj) { appendFileSync(path, JSON.stringify(obj) + '\n'); },
    };
}

function writeSummary(prefix, args) {
    const buckets = args.buckets === 'coarse' ? COARSE_BUCKETS : DEFAULT_BUCKETS;
    const flat = flattenSnapshots(state.results);
    const summary = {
        meta: {
            duration_min: args.duration / 60_000,
            routes:       args.routes ? [...args.routes] : 'all',
            arrivals:     state.results.length,
            snapshots:    flat.length,
            generated:    new Date().toISOString(),
        },
        feedStats: state.feedStats,
        // Use the shared summarize helper for byRoute / byHorizon / overall —
        // but only over GTFS error since the Node harness doesn't compute calc.
        byHorizon: bucketByRouteHorizon(flat, buckets),
        byRoute:   bucketByRoute(flat),
        overall:   { gtfs: stats(flat.map(f => f.gtfsErr)) },
    };
    const path = `${prefix}.summary.json`;
    writeFileSync(path, JSON.stringify(summary, null, 2));
    return { path, summary };
}

// Custom horizon bucketing that only cares about gtfsErr (calcErr is null in
// this harness — see header).
function bucketByRouteHorizon(flat, buckets) {
    const out = {};
    for (const b of buckets) {
        const inBucket = flat.filter(f => {
            const h = f.horizonGtfs;
            return h != null && h >= b.min && h < b.max;
        });
        out[b.label] = {
            n: inBucket.length,
            gtfs: stats(inBucket.map(f => f.gtfsErr)),
        };
    }
    return out;
}

// ── Main loop ──────────────────────────────────────────────────────────────

function log(msg) { console.log(`[harness ${new Date().toISOString().slice(11, 19)}] ${msg}`); }

async function main() {
    const args = parseArgs(process.argv);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = args.out ?? join(__dirname, `live-accuracy-${ts}`);
    const jsonl = makeJsonl(prefix);

    log(`starting capture — ${(args.duration / 60_000).toFixed(1)} min, output: ${prefix}.{jsonl,summary.json}`);
    if (args.routes) log(`route filter: ${[...args.routes].join(', ')}`);

    connect('railVp', FEEDS.railVp, (m) => handleVp('railVp', m, args, jsonl));
    connect('busVp',  FEEDS.busVp,  (m) => handleVp('busVp',  m, args, jsonl));
    connect('railTu', FEEDS.railTu, (m) => handleTu('railTu', m, args, jsonl));
    connect('busTu',  FEEDS.busTu,  (m) => handleTu('busTu',  m, args, jsonl));

    // Periodic feed-stat tick into the JSONL for post-hoc reliability analysis.
    const statTimer = setInterval(() => {
        const tick = { kind: 'feed-stat', ts: Date.now(), stats: structuredClone(state.feedStats) };
        jsonl.write(tick);
    }, 60_000);

    setTimeout(() => {
        clearInterval(statTimer);
        log(`stopping — ${state.results.length} arrivals captured`);
        const { path, summary } = writeSummary(prefix, args);
        log(`summary written: ${path}`);
        if (summary.meta.arrivals) {
            consoleTablePlus(summary.byHorizon);
        } else {
            console.warn('No arrivals captured — try a busier window or longer duration.');
        }
        process.exit(0);
    }, args.duration);
}

main().catch(err => {
    console.error('[harness] fatal:', err);
    process.exit(1);
});
