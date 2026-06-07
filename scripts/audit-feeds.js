/**
 * audit-feeds.js
 * Reliability + field-coverage audit across all Metro GTFS-RT feeds.
 *
 * Usage:  node scripts/audit-feeds.js [--duration=<spec>] [--out=<path>]
 *
 *   --duration=<spec>   How long to capture. Default 60m. Accepts Ns / Nm / Nh
 *                       (e.g. --duration=20m for the CI default).
 *   --out=<path>        Where to write the final JSON report. Default
 *                       scripts/audit-feeds-report.json (gitignored).
 *
 * Reports:
 *   ── Original (preserved) ──
 *   - Message rate per feed (msgs/min)
 *   - Reconnect count per feed
 *   - Vehicle staleness distribution (gap between updates per vehicle)
 *   - Feed agreement: vehicles in positions-only vs trip_updates-only vs both
 *   - Trip ID coverage: % of live trip IDs found in static trips.json
 *   - Per-route vehicle count and avg update gap
 *
 *   ── New (2026-05-05) ──
 *   - Per-field coverage for every vehicle.* and tripUpdate.* path:
 *       % populated, distinct value count, top values, numeric percentiles,
 *       per-route bucket
 *   - Cross-feed correlation: tripId / vehicleId overlap, static-trip presence
 *   - EWMA-feasibility diagnostic: stopId-based vs sequence-based gate firing
 *     rates for the segment-recording hook in markers.js (validates Fix 1
 *     from the 2026-05-05 ETA audit)
 *
 * CI integration (2026-05-26):
 *   .github/workflows/feed-reliability.yml runs this script on a schedule
 *   (2x/week) and uploads the JSON report as a 30-day artifact. The same
 *   stdout that prints the per-field tables is teed into $GITHUB_STEP_SUMMARY
 *   so reviewers see top-line presence percentages in the run page without
 *   downloading the artifact.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI ──────────────────────────────────────────────────────────────────────
// Hand-rolled to match the pattern in scripts/live-accuracy-headless.js (no
// node:util import needed; arg surface is intentionally small).

function parseDuration(v) {
    const m = v?.match?.(/^(\d+)(s|m|min|h)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2] ?? 'm';
    return n * (unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000);
}

function parseArgs(argv) {
    const args = { durationMs: 60 * 60 * 1000, out: null };
    for (const a of argv.slice(2)) {
        if      (a.startsWith('--duration=')) {
            const d = parseDuration(a.slice('--duration='.length));
            if (d != null) args.durationMs = d;
        } else if (a.startsWith('--out=')) {
            args.out = a.slice('--out='.length);
        }
    }
    return args;
}

const _cli = parseArgs(process.argv);
const DURATION_MS  = _cli.durationMs;
const REPORT_EVERY = Math.min(600_000, Math.max(60_000, Math.floor(DURATION_MS / 4))); // ms — interim cadence, capped at 10m / floored at 1m so short CI runs still report once
const REPORT_FILE  = _cli.out ?? join(__dirname, 'audit-feeds-report.json');

const trips = JSON.parse(readFileSync(join(__dirname, '../data/trips.json'), 'utf8'));

// ── Feed stats ────────────────────────────────────────────────────────────────

const feeds = {
    rail_pos:    { url: 'wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions',      msgs: 0, reconnects: 0, lastMsg: null },
    bus_pos:     { url: 'wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901,950', msgs: 0, reconnects: 0, lastMsg: null },
    rail_trips:  { url: 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates',           msgs: 0, reconnects: 0, lastMsg: null },
    bus_trips:   { url: 'wss://api.metro.net/ws/LACMTA/trip_updates',                msgs: 0, reconnects: 0, lastMsg: null },
};

// ── Vehicle tracking (original) ───────────────────────────────────────────────

// positions feed: tripId → { vehicleId, routeCode, lastTs, gaps[], tripIdInStatic }
const posVehicles  = new Map();
// trip_updates feed: vehicleId → { routeId, lastTs }
const tupVehicles  = new Map();

// ── Field coverage tracker ────────────────────────────────────────────────────

class FieldTracker {
    constructor(path) {
        this.path = path;
        this.total = 0;       // messages observed
        this.nonNull = 0;     // present + not null/undefined/empty
        this.values = new Map(); // value → count (capped via TOP_K)
        this.numeric = { count: 0, sum: 0, min: Infinity, max: -Infinity, samples: [] };
        this.byRoute = new Map(); // routeCode → { total, nonNull }
    }
    observe(value, routeCode = null) {
        this.total++;
        if (routeCode) {
            const r = this.byRoute.get(routeCode) ?? { total: 0, nonNull: 0 };
            r.total++;
            this.byRoute.set(routeCode, r);
        }
        if (value === null || value === undefined || value === '') return;
        this.nonNull++;
        if (routeCode) this.byRoute.get(routeCode).nonNull++;

        // Track distinct values (capped to keep memory bounded)
        const key = typeof value === 'object' ? JSON.stringify(value) : String(value);
        if (this.values.size < 200 || this.values.has(key)) {
            this.values.set(key, (this.values.get(key) ?? 0) + 1);
        }

        // Track numeric stats if value parses as a finite number
        const num = Number(value);
        if (Number.isFinite(num)) {
            this.numeric.count++;
            this.numeric.sum += num;
            if (num < this.numeric.min) this.numeric.min = num;
            if (num > this.numeric.max) this.numeric.max = num;
            // Reservoir-ish: keep up to 5000 samples for percentiles
            if (this.numeric.samples.length < 5000) this.numeric.samples.push(num);
        }
    }
    coverage() { return this.total ? this.nonNull / this.total : 0; }
    topValues(k = 5) {
        return [...this.values.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, k);
    }
    summary() {
        const top = this.topValues(5);
        const out = {
            path: this.path,
            total: this.total,
            nonNull: this.nonNull,
            coverage: this.coverage(),
            distinctValues: this.values.size,
            topValues: top.map(([v, c]) => ({ value: v.length > 30 ? v.slice(0, 30) + '…' : v, count: c })),
        };
        if (this.numeric.count >= 5) {
            const sorted = [...this.numeric.samples].sort((a, b) => a - b);
            out.numeric = {
                count: this.numeric.count,
                min: this.numeric.min,
                max: this.numeric.max,
                mean: this.numeric.sum / this.numeric.count,
                p10: percentile(sorted, 10),
                p50: percentile(sorted, 50),
                p90: percentile(sorted, 90),
            };
        }
        return out;
    }
}

// Helper: safely walk a dotted path through an object.
// Supports paths like "vehicle.label" or "trip.directionId".
function getPath(obj, path) {
    if (obj == null) return undefined;
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
        if (cur == null) return undefined;
        cur = cur[p];
    }
    return cur;
}

// Vehicle position field paths (rooted at msg.vehicle, except route_code which is on msg)
const VEHICLE_FIELDS = [
    'vehicle.id',
    'vehicle.label',
    'vehicle.licensePlate',
    'currentStatus',
    'currentStopSequence',
    'stopId',
    'timestamp',
    'congestionLevel',
    'occupancyStatus',
    'trip.tripId',
    'trip.routeId',
    'trip.directionId',
    'trip.startDate',
    'trip.startTime',
    'trip.scheduleRelationship',
    'position.latitude',
    'position.longitude',
    'position.bearing',
    'position.speed',
    'position.odometer',
];
const ENVELOPE_FIELDS = ['route_code']; // top-level on message

// Trip update field paths (rooted at msg.tripUpdate)
const TRIPUPDATE_FIELDS = [
    'trip.tripId',
    'trip.routeId',
    'trip.directionId',
    'trip.startDate',
    'trip.startTime',
    'trip.scheduleRelationship',
    'vehicle.id',
    'vehicle.label',
    'vehicle.licensePlate',
    'timestamp',
    'delay',
];
// Per-stop_time_update paths
const STU_FIELDS = [
    'stopId',
    'stopSequence',
    'arrival.time',
    'arrival.delay',
    'arrival.uncertainty',
    'departure.time',
    'departure.delay',
    'departure.uncertainty',
    'scheduleRelationship',
];

const vehicleFieldTrackers   = new Map(VEHICLE_FIELDS.map(p => [p, new FieldTracker(p)]));
const envelopeFieldTrackers  = new Map(ENVELOPE_FIELDS.map(p => [p, new FieldTracker(p)]));
const tripUpdateFieldTrackers = new Map(TRIPUPDATE_FIELDS.map(p => [p, new FieldTracker(p)]));
const stuFieldTrackers       = new Map(STU_FIELDS.map(p => [p, new FieldTracker(p)]));

// ── Alert field coverage ──────────────────────────────────────────────────────

const RAIL_ALERTS_URL = 'https://5cgdcfl7csnoiymgfhjp5bqgii0yxifx.lambda-url.us-west-1.on.aws/';
const BUS_ALERTS_URL  = 'https://lbwlhl4z4pktjvxw3tm6emxfui0kwjiv.lambda-url.us-west-1.on.aws/';
const ALERTS_POLL_MS  = 120_000;

// Top-level alert fields (rooted at each entity)
const ALERT_FIELDS = [
    'id',
    'effect',
    'cause',
    'severity',
    'url',
    'headerText',
    'descriptionText',
    'activePeriods[].start',
    'activePeriods[].end',
];
// Per-informedEntity fields
const ALERT_IE_FIELDS = [
    'routeId',
    'stopId',
    'directionId',
    'tripId',
    'routeType',
];

const alertFieldTrackers   = new Map(ALERT_FIELDS.map(p => [p, new FieldTracker(p)]));
const alertIeFieldTrackers = new Map(ALERT_IE_FIELDS.map(p => [p, new FieldTracker(p)]));

// Distinct effect and cause values seen
const alertEffects = new Map(); // value → count
const alertCauses  = new Map();

let alertFetchCount = 0;

// ── Cross-feed correlation ────────────────────────────────────────────────────

const posTripIds = new Set();
const tupTripIds = new Set();
const posVehicleIds = new Set();
const tupVehicleIdsOnly = new Set();

// stopId membership check: how often the position-feed stopId matches an entry
// in the static trips.json[tripId].stops list (validates the Fix 1 lookup path).
let stopIdInStaticStops_total = 0;
let stopIdInStaticStops_match = 0;

// ── EWMA-feasibility diagnostic ───────────────────────────────────────────────
// Per (tripId, vehicleId) running tuple. On every message where the stopId
// changes, evaluate both the old gate (currentStopSequence-based) and the
// new gate (stopId-based against trips.json[tripId].stops) to compare firing
// rates head-to-head.

const ewmaState = new Map(); // key → { lastStopId, lastSequence }
const ewmaCounts = {
    transitions:        0, // stopId actually changed
    gateA_fires:        0, // stopId-based gate (Fix 1)
    gateB_fires:        0, // sequence-based gate (original)
    bothAgree:          0, // both fire on the same transition
    gateA_only:         0, // Fix 1 captured what Fix 0 missed
    gateB_only:         0, // Fix 0 would have caught what Fix 1 misses
    neither:            0, // stopId moved but not adjacent in static + sequence didn't increment
    skippedNoTripData:  0, // tripId not in static trips.json
};

// Missing tripIds — IDs observed in live positions feed but absent from trips.json.
// Captured for post-hoc analysis (e.g., do they cluster on a route or time-of-day?).
// Map<tripId, { count, routeCode, firstSeenTs }> capped at 500 entries.
const missingTripIds = new Map();

function recordPos(msg) {
    const v = msg?.vehicle;
    if (!v) return;

    // ── Original tracking ──────────────────────────────────────
    if (v?.trip?.tripId) {
        let ts = parseInt(v.timestamp, 10);
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

        posTripIds.add(tripId);
        if (vehicleId) posVehicleIds.add(vehicleId);
    }

    // ── Field coverage ─────────────────────────────────────────
    const routeCode = msg?.route_code != null ? String(msg.route_code) : null;
    for (const [path, tracker] of vehicleFieldTrackers) {
        tracker.observe(getPath(v, path), routeCode);
    }
    for (const [path, tracker] of envelopeFieldTrackers) {
        tracker.observe(getPath(msg, path), routeCode);
    }

    // ── stopId-in-static-stops check ───────────────────────────
    const tripId = v?.trip?.tripId ? String(v.trip.tripId) : null;
    const stopId = v?.stopId != null ? String(v.stopId) : null;
    if (tripId && stopId) {
        const trip = trips[tripId];
        if (trip?.stops?.length) {
            stopIdInStaticStops_total++;
            if (trip.stops.includes(stopId)) stopIdInStaticStops_match++;
        }
    }

    // ── EWMA-feasibility diagnostic ────────────────────────────
    if (tripId && stopId) {
        const vehicleId = String(v.vehicle?.id ?? '');
        const key = `${tripId}|${vehicleId}`;
        const seqRaw = v?.currentStopSequence;
        const seqNum = (seqRaw != null && Number.isFinite(Number(seqRaw))) ? Number(seqRaw) : null;
        const prev = ewmaState.get(key);
        if (prev && prev.lastStopId !== stopId) {
            ewmaCounts.transitions++;

            const trip = trips[tripId];
            if (!trip?.stops?.length) {
                ewmaCounts.skippedNoTripData++;
                const entry = missingTripIds.get(tripId);
                if (entry) {
                    entry.count++;
                } else if (missingTripIds.size < 500) {
                    missingTripIds.set(tripId, {
                        count: 1,
                        routeCode: String(msg.route_code ?? ''),
                        firstSeenTs: Math.floor(Date.now() / 1000),
                    });
                }
            } else {
                // Gate A: stopId-based (Fix 1) — new stopId is the next entry in trip.stops
                const prevIdx = trip.stops.indexOf(prev.lastStopId);
                const newIdx  = trip.stops.indexOf(stopId);
                const gateA = prevIdx >= 0 && newIdx === prevIdx + 1;

                // Gate B: sequence-based (original) — currentStopSequence increments by 1
                const gateB = (prev.lastSequence != null && seqNum != null
                               && seqNum === prev.lastSequence + 1);

                if (gateA) ewmaCounts.gateA_fires++;
                if (gateB) ewmaCounts.gateB_fires++;
                if (gateA && gateB) ewmaCounts.bothAgree++;
                if (gateA && !gateB) ewmaCounts.gateA_only++;
                if (gateB && !gateA) ewmaCounts.gateB_only++;
                if (!gateA && !gateB) ewmaCounts.neither++;
            }
        }
        ewmaState.set(key, { lastStopId: stopId, lastSequence: seqNum });
    }
}

function recordTup(msg) {
    const tu = msg?.tripUpdate;
    if (!tu) return;

    // ── Original tracking ──────────────────────────────────────
    if (tu.stopTimeUpdate?.length) {
        const vehicleId = String(tu.vehicle?.id ?? '');
        const routeId   = String(tu.trip?.routeId ?? '').split('-')[0];
        const now       = Math.floor(Date.now() / 1000);
        if (vehicleId) {
            tupVehicles.set(vehicleId, { routeId, lastTs: now });
            tupVehicleIdsOnly.add(vehicleId);
        }
        if (tu.trip?.tripId) tupTripIds.add(String(tu.trip.tripId));
    }

    // ── Field coverage ─────────────────────────────────────────
    const routeCode = String(tu.trip?.routeId ?? '').split('-')[0] || null;
    for (const [path, tracker] of tripUpdateFieldTrackers) {
        tracker.observe(getPath(tu, path), routeCode);
    }
    if (Array.isArray(tu.stopTimeUpdate)) {
        for (const stu of tu.stopTimeUpdate) {
            for (const [path, tracker] of stuFieldTrackers) {
                tracker.observe(getPath(stu, path), routeCode);
            }
        }
    }
}

// ── Alert REST polling ────────────────────────────────────────────────────────

function recordAlert(alert) {
    // Top-level scalar fields
    for (const path of ALERT_FIELDS) {
        if (path.includes('[]')) {
            // Array field — e.g. activePeriods[].start
            const [arrKey, subKey] = path.replace('[]', '').split('.');
            const arr = alert[arrKey];
            if (Array.isArray(arr) && arr.length > 0) {
                for (const item of arr) {
                    alertFieldTrackers.get(path).observe(item[subKey] ?? null);
                }
            } else {
                alertFieldTrackers.get(path).observe(null);
            }
        } else {
            alertFieldTrackers.get(path).observe(alert[path] ?? null);
        }
    }

    // Per-informedEntity fields
    const ies = Array.isArray(alert.informedEntities) ? alert.informedEntities : [];
    if (ies.length === 0) {
        for (const path of ALERT_IE_FIELDS) {
            alertIeFieldTrackers.get(path).observe(null);
        }
    } else {
        for (const ie of ies) {
            for (const path of ALERT_IE_FIELDS) {
                alertIeFieldTrackers.get(path).observe(ie[path] ?? null);
            }
        }
    }

    // Track distinct effect / cause values
    if (alert.effect != null) alertEffects.set(String(alert.effect), (alertEffects.get(String(alert.effect)) ?? 0) + 1);
    if (alert.cause  != null) alertCauses.set(String(alert.cause),  (alertCauses.get(String(alert.cause))  ?? 0) + 1);
}

async function fetchAndRecordAlerts() {
    try {
        const [rail, bus] = await Promise.all([
            fetch(RAIL_ALERTS_URL, { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
            fetch(BUS_ALERTS_URL,  { signal: AbortSignal.timeout(10_000) }).then(r => r.json()),
        ]);
        const all = [...(Array.isArray(rail) ? rail : []), ...(Array.isArray(bus) ? bus : [])];
        for (const alert of all) recordAlert(alert);
        alertFetchCount++;
        console.log(`[alerts] poll #${alertFetchCount} — ${all.length} entities`);
    } catch (err) {
        console.warn(`[alerts] fetch failed: ${err.message}`);
    }
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
        // Log the error but do NOT call ws.close() here — Node 22's native
        // WebSocket (undici) re-fires `error` after a synchronous close from
        // the error path, causing stack-overflow recursion when the handshake
        // itself fails. The 'close' event will fire regardless of whether we
        // close explicitly; the reconnect happens there.
        ws.addEventListener('error', e => {
            console.warn(`[ws] ✗ ${feedKey}: ${e?.message ?? 'connect error'}`);
        });
    };
    attempt();
}

connectWS('rail_pos',   msg => recordPos(msg));
connectWS('bus_pos',    msg => recordPos(msg));
connectWS('rail_trips', msg => recordTup(msg));
connectWS('bus_trips',  msg => recordTup(msg));

// Fetch alerts immediately and then every 2 minutes (matches live app cadence)
fetchAndRecordAlerts();
setInterval(fetchAndRecordAlerts, ALERTS_POLL_MS);

// ── Reporting ─────────────────────────────────────────────────────────────────

const startTime = Date.now();
let reportNum = 0;

function printReport(final = false) {
    reportNum++;
    const elapsed   = (Date.now() - startTime) / 1000;
    const elMin     = (elapsed / 60).toFixed(1);
    const header    = final ? '═══ FINAL REPORT' : `── ${elMin}m interim`;

    console.log(`\n${header} ────────────────────────────────────────────────────`);

    // ── Section: feed message rates (always printed) ──
    console.log('\n┌ Feed message rates');
    for (const [key, f] of Object.entries(feeds)) {
        const rate   = (f.msgs / (elapsed / 60)).toFixed(1);
        const silenceMs = f.lastMsg ? Math.round((Date.now() - f.lastMsg) / 1000) : null;
        const silence = silenceMs != null ? `last msg ${silenceMs}s ago` : 'no messages';
        console.log(`│  ${key.padEnd(12)} ${String(f.msgs).padStart(6)} msgs  ${rate.padStart(6)}/min  reconnects=${f.reconnects}  ${silence}`);
    }

    // ── Section: positions vehicles + per-route + agreement (always) ──
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

    console.log('\n┌ Trip updates feed');
    console.log(`│  Unique vehicles seen : ${tupVehicles.size}`);

    const posVids  = new Set(allPos.map(v => v.vehicleId));
    const tupVids  = new Set(tupVehicles.keys());
    const both           = [...posVids].filter(id => tupVids.has(id));
    const posOnly        = [...posVids].filter(id => !tupVids.has(id));
    const tupOnly        = [...tupVids].filter(id => !posVids.has(id));

    console.log('\n┌ Feed agreement (vehicleId overlap)');
    console.log(`│  In both feeds        : ${both.length}`);
    console.log(`│  Positions-only       : ${posOnly.length}  ${posOnly.slice(0,3).join(', ')}`);
    console.log(`│  Trip-updates-only    : ${tupOnly.length}  ${tupOnly.slice(0,3).join(', ')}`);

    // ── Section: per-route (always) ──
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

    // ── Section: cross-feed correlation summary (always; full only on final) ──
    const tripIntersect = [...posTripIds].filter(t => tupTripIds.has(t)).length;
    const tripUnion     = new Set([...posTripIds, ...tupTripIds]).size;
    console.log('\n┌ Cross-feed correlation');
    console.log(`│  Position tripIds        : ${posTripIds.size}`);
    console.log(`│  Trip-update tripIds     : ${tupTripIds.size}`);
    console.log(`│  Intersection            : ${tripIntersect}  (${pct(tripIntersect, tripUnion)} of union)`);
    console.log(`│  stopId in trip.stops[]  : ${stopIdInStaticStops_match} / ${stopIdInStaticStops_total}  (${pct(stopIdInStaticStops_match, stopIdInStaticStops_total)})`);

    // ── Section: EWMA-feasibility diagnostic (always) ──
    const e = ewmaCounts;
    console.log('\n┌ EWMA segment-recording feasibility');
    console.log(`│  Stop transitions observed     : ${e.transitions}`);
    console.log(`│  Gate A fires (stopId-based)   : ${e.gateA_fires}  (${pct(e.gateA_fires, e.transitions)})`);
    console.log(`│  Gate B fires (sequence-based) : ${e.gateB_fires}  (${pct(e.gateB_fires, e.transitions)})`);
    console.log(`│  Both gates agree              : ${e.bothAgree}`);
    console.log(`│  A-only (Fix 1 captured)       : ${e.gateA_only}`);
    console.log(`│  B-only (Fix 1 missed)         : ${e.gateB_only}`);
    console.log(`│  Neither (skip-stop / glitch)  : ${e.neither}`);
    console.log(`│  Skipped (no static trip data) : ${e.skippedNoTripData}`);

    // ── Missing tripIds (live IDs absent from trips.json) ──
    if (missingTripIds.size > 0) {
        const sorted = [...missingTripIds.entries()].sort(([,a],[,b]) => b.count - a.count);
        const sample = sorted.slice(0, 10);
        console.log('\n┌ Missing tripIds (live → not in trips.json)');
        console.log(`│  Distinct missing tripIds : ${missingTripIds.size}`);
        console.log(`│  Top by hit count:`);
        for (const [tid, info] of sample) {
            const letter = LETTER[info.routeCode] ?? info.routeCode ?? '?';
            console.log(`│    ${tid.padEnd(12)}  hits=${String(info.count).padStart(4)}  Line ${letter}`);
        }
    }

    // ── Final-only sections: full per-field tables + JSON dump ──
    if (final) {
        printFieldTable('Vehicle positions — field coverage', vehicleFieldTrackers);
        printFieldTable('Vehicle positions — envelope fields', envelopeFieldTrackers);
        printFieldTable('Trip updates — top-level fields',     tripUpdateFieldTrackers);
        printFieldTable('Trip updates — stop_time_update[]',   stuFieldTrackers);
        printFieldTable('Alerts — top-level fields',           alertFieldTrackers);
        printFieldTable('Alerts — informedEntities[] fields',  alertIeFieldTrackers);

        // Print distinct effect / cause values
        if (alertEffects.size) {
            console.log('\n┌ Alert effect values seen');
            [...alertEffects.entries()].sort((a, b) => b[1] - a[1])
                .forEach(([v, c]) => console.log(`│  ${String(c).padStart(5)}x  ${v}`));
        }
        if (alertCauses.size) {
            console.log('\n┌ Alert cause values seen');
            [...alertCauses.entries()].sort((a, b) => b[1] - a[1])
                .forEach(([v, c]) => console.log(`│  ${String(c).padStart(5)}x  ${v}`));
        }

        // Dump JSON for further analysis
        const report = {
            generatedAt:    new Date().toISOString(),
            durationMin:    elapsed / 60,
            feeds:          Object.fromEntries(Object.entries(feeds).map(([k, f]) => [k, { msgs: f.msgs, reconnects: f.reconnects }])),
            crossFeed:      {
                posTripIds: posTripIds.size,
                tupTripIds: tupTripIds.size,
                tripIntersect, tripUnion,
                stopIdInStaticStops_match, stopIdInStaticStops_total,
            },
            ewma:           e,
            missingTripIds: [...missingTripIds.entries()]
                .sort(([,a],[,b]) => b.count - a.count)
                .slice(0, 100)
                .map(([tripId, info]) => ({ tripId, ...info })),
            vehicleFields:  Object.fromEntries([...vehicleFieldTrackers.entries()].map(([k, t]) => [k, t.summary()])),
            envelopeFields: Object.fromEntries([...envelopeFieldTrackers.entries()].map(([k, t]) => [k, t.summary()])),
            tripUpdateFields: Object.fromEntries([...tripUpdateFieldTrackers.entries()].map(([k, t]) => [k, t.summary()])),
            stuFields:      Object.fromEntries([...stuFieldTrackers.entries()].map(([k, t]) => [k, t.summary()])),
            alertFields:    Object.fromEntries([...alertFieldTrackers.entries()].map(([k, t]) => [k, t.summary()])),
            alertIeFields:  Object.fromEntries([...alertIeFieldTrackers.entries()].map(([k, t]) => [k, t.summary()])),
            alertEffects:   Object.fromEntries([...alertEffects.entries()].sort((a, b) => b[1] - a[1])),
            alertCauses:    Object.fromEntries([...alertCauses.entries()].sort((a, b) => b[1] - a[1])),
            alertFetchCount,
        };
        try {
            writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
            console.log(`\n[report] Full JSON written to ${REPORT_FILE}`);
        } catch (err) {
            console.warn(`\n[report] Failed to write JSON: ${err.message}`);
        }

        console.log('\n════════════════════════════════════════════════════════════════');
    }
}

function printFieldTable(label, trackers) {
    console.log(`\n┌ ${label}`);
    console.log('│  ' + 'field'.padEnd(34) + 'cov%   nonNull   distinct   top values');
    console.log('│  ' + '─'.repeat(90));
    for (const [path, tracker] of trackers) {
        const cov  = (tracker.coverage() * 100).toFixed(0).padStart(3) + '%';
        const nn   = String(tracker.nonNull).padStart(7);
        const dist = String(tracker.values.size).padStart(8);
        const top  = tracker.topValues(3).map(([v, c]) => {
            const short = v.length > 18 ? v.slice(0, 18) + '…' : v;
            return `${short}(${c})`;
        }).join(', ');
        console.log(`│  ${path.padEnd(34)}${cov}  ${nn}  ${dist}   ${top}`);
        // Numeric stats line for fields with enough samples
        if (tracker.numeric.count >= 5) {
            const sorted = [...tracker.numeric.samples].sort((a, b) => a - b);
            const n = tracker.numeric;
            console.log(`│  ${''.padEnd(34)}     min=${n.min.toFixed(1)}  p10=${percentile(sorted,10).toFixed(1)}  p50=${percentile(sorted,50).toFixed(1)}  p90=${percentile(sorted,90).toFixed(1)}  max=${n.max.toFixed(1)}  mean=${(n.sum/n.count).toFixed(1)}`);
        }
    }
}

const reportInterval = setInterval(() => printReport(false), REPORT_EVERY);

const stopAndReport = () => {
    clearInterval(reportInterval);
    printReport(true);
    const passed = evaluateThresholds();
    process.exit(passed ? 0 : 1);
};

setTimeout(stopAndReport, DURATION_MS);

// Allow Ctrl+C to print the final report instead of dying silently
process.on('SIGINT', () => {
    console.log('\n[audit] Caught SIGINT — emitting final report');
    stopAndReport();
});

// ── Threshold evaluation ─────────────────────────────────────────────────────
// Pass/fail criteria for CI / on-demand health checks. Defaults are calibrated
// for a normal weekday daytime window. Override by environment variable —
// `AUDIT_FEED_RECONNECT_MAX=10 node scripts/audit-feeds.js`.
//
// Each check returns a row: { name, value, threshold, status }
// Final summary: PASS if all rows are 'ok', FAIL otherwise. Exit code reflects.
function evaluateThresholds() {
    const elapsedMin = (Date.now() - startTime) / 60_000;
    const allPos     = [...posVehicles.values()];
    const allGaps    = allPos.flatMap(v => v.gaps).sort((a, b) => a - b);

    const T = {
        // Feeds: at least 1 message and ≤ 4 reconnects per hour per feed
        msgsMinPerHour:  Number(process.env.AUDIT_FEED_MIN_MSGS_HR  ?? 60),
        reconnectsMax:   Number(process.env.AUDIT_FEED_RECONNECT_MAX ?? 4),
        // Vehicle freshness
        gapP50MaxS:      Number(process.env.AUDIT_GAP_P50_MAX ?? 30),
        gapP95MaxS:      Number(process.env.AUDIT_GAP_P95_MAX ?? 300),
        // Tripability of live feed against static trips.json
        tripIdCoverageMinPct: Number(process.env.AUDIT_TRIP_COVERAGE_MIN ?? 70),
        // Field coverage minimums (essential fields must be > 95% populated)
        fieldCoverageMinPct: Number(process.env.AUDIT_FIELD_COVERAGE_MIN ?? 95),
    };
    const ESSENTIAL_VEHICLE_FIELDS = ['vehicle.id', 'trip.tripId', 'position.latitude', 'position.longitude', 'timestamp'];

    const rows = [];
    const ok = (name, val, threshold) =>
        rows.push({ name, value: String(val), threshold: String(threshold), status: 'ok' });
    const fail = (name, val, threshold, reason) =>
        rows.push({ name, value: String(val), threshold: String(threshold), status: `FAIL — ${reason}` });

    // Feed message rates
    for (const [key, f] of Object.entries(feeds)) {
        const ratePerHour = (f.msgs / elapsedMin) * 60;
        if (ratePerHour < T.msgsMinPerHour) {
            fail(`feed:${key}:msgs/h`, ratePerHour.toFixed(0), `≥${T.msgsMinPerHour}`, 'feed silent or starved');
        } else {
            ok(`feed:${key}:msgs/h`, ratePerHour.toFixed(0), `≥${T.msgsMinPerHour}`);
        }
        const reconnectsPerHour = (f.reconnects / elapsedMin) * 60;
        if (reconnectsPerHour > T.reconnectsMax) {
            fail(`feed:${key}:reconnects/h`, reconnectsPerHour.toFixed(1), `≤${T.reconnectsMax}`, 'unstable connection');
        } else {
            ok(`feed:${key}:reconnects/h`, reconnectsPerHour.toFixed(1), `≤${T.reconnectsMax}`);
        }
    }

    // Vehicle update freshness
    if (allGaps.length) {
        const p50 = percentile(allGaps, 50);
        const p95 = percentile(allGaps, 95);
        if (p50 > T.gapP50MaxS) fail('freshness:p50', `${p50.toFixed(0)}s`, `≤${T.gapP50MaxS}s`, 'median update gap too long');
        else                    ok('freshness:p50', `${p50.toFixed(0)}s`, `≤${T.gapP50MaxS}s`);
        if (p95 > T.gapP95MaxS) fail('freshness:p95', `${p95.toFixed(0)}s`, `≤${T.gapP95MaxS}s`, 'tail gaps too long');
        else                    ok('freshness:p95', `${p95.toFixed(0)}s`, `≤${T.gapP95MaxS}s`);
    } else {
        fail('freshness', 'no vehicle data', 'any', 'no positions captured');
    }

    // Static trip coverage
    if (allPos.length > 0) {
        const inStatic = allPos.filter(v => v.tripIdInStatic).length;
        const cov = (inStatic / allPos.length) * 100;
        if (cov < T.tripIdCoverageMinPct) {
            fail('static-trip-coverage', `${cov.toFixed(0)}%`, `≥${T.tripIdCoverageMinPct}%`, 'static data may be stale');
        } else {
            ok('static-trip-coverage', `${cov.toFixed(0)}%`, `≥${T.tripIdCoverageMinPct}%`);
        }
    }

    // Essential vehicle field coverage
    for (const path of ESSENTIAL_VEHICLE_FIELDS) {
        const tracker = vehicleFieldTrackers.get(path);
        if (!tracker || tracker.total === 0) continue;
        const cov = tracker.coverage() * 100;
        if (cov < T.fieldCoverageMinPct) {
            fail(`field:${path}`, `${cov.toFixed(0)}%`, `≥${T.fieldCoverageMinPct}%`, 'field underpopulated');
        } else {
            ok(`field:${path}`, `${cov.toFixed(0)}%`, `≥${T.fieldCoverageMinPct}%`);
        }
    }

    // Print summary
    console.log('\n┌ Threshold evaluation');
    for (const r of rows) {
        const tag = r.status === 'ok' ? '✓ OK' : '✗ FAIL';
        console.log(`│  ${tag.padEnd(8)} ${r.name.padEnd(36)} ${r.value.padStart(8)}  threshold=${r.threshold}`);
        if (r.status !== 'ok') console.log(`│           └─ ${r.status.replace('FAIL — ', '')}`);
    }
    const failures = rows.filter(r => r.status !== 'ok').length;
    const overall = failures === 0 ? '✓ PASS' : `✗ FAIL (${failures} of ${rows.length} checks)`;
    console.log(`└ ${overall}\n`);
    return failures === 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n, total) { return total ? `${Math.round(n/total*100)}%` : '0%'; }
function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const i = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(i);
    return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
}
