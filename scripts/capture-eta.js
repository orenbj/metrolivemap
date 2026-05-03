/**
 * capture-eta.js
 * Standalone Node.js script that monitors Metro GTFS-RT feeds and captures
 * a comparison of our schedule-based ETA calc vs the live GTFS-RT predictions.
 *
 * Usage:  node scripts/capture-eta.js
 * Output: scripts/eta-capture-<timestamp>.jsonl   (one JSON object per line)
 *
 * Each row:
 *   sampledAt    ISO timestamp of this sample
 *   routeId      e.g. "801"
 *   directionId  0 or 1
 *   stopId       GTFS stop ID
 *   stopName     human-readable stop name
 *   vehicleId    vehicle/train ID
 *   tripId       GTFS trip ID
 *   dest         trip destination string (raw)
 *   gtfsEta      seconds from now per GTFS-RT feed  (null = no feed data)
 *   calcEta      seconds from now per our calc       (null = not matched)
 *   deltaSeconds calcEta - gtfsEta                   (null if either missing)
 *   onlyCalc     true if we have calc but GTFS has nothing for this vehicle
 *   onlyGtfs     true if GTFS has data but we have no calc match
 */

import { readFileSync, appendFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DURATION_MIN    = 10;
const SAMPLE_INTERVAL = 10_000;  // ms between samples
const WARMUP_MS       = 15_000;  // wait for initial data before first sample

const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_FILE   = join(__dirname, `eta-capture-${timestamp}.jsonl`);
const STALE_VEH  = 180;  // seconds — matches predictions.js STALE_THRESHOLD_SEC

// ── Load static data ──────────────────────────────────────────────────────────

const stops = JSON.parse(readFileSync(join(__dirname, '../data/stops.json'), 'utf8'));
const trips = JSON.parse(readFileSync(join(__dirname, '../data/trips.json'), 'utf8'));

// ── Build schedule cache (mirrors predictions.js initPredictions) ─────────────

const routeStops = {};
{
    const best = {};
    for (const [tripId, trip] of Object.entries(trips)) {
        const { rc, dir, stops: s, scheduledTimes: t } = trip;
        if (rc == null || dir == null || !s?.length || !t?.length) continue;
        const key = `${rc}|${dir}`;
        if (!best[key] || s.length > best[key].stops.length) best[key] = { ...trip, tripId };
    }
    for (const [key, trip] of Object.entries(best)) {
        if (trip.stops.length !== trip.scheduledTimes.length) continue;
        routeStops[key] = { stops: trip.stops.map(String), times: trip.scheduledTimes };
    }
}
console.log(`[init] Schedule cache: ${Object.keys(routeStops).length} route-dirs`);

// ── Live state ────────────────────────────────────────────────────────────────

const vehicles = {};           // tripId → { timestamp, properties }
const arrivalsData = new Map(); // stopId → [{ routeId, directionId, vehicleId, tripId, arrivalUnix }]

// ── Prediction logic (mirrors predictions.js) ─────────────────────────────────

function findIdx(arr, targetId) {
    const t = String(targetId);
    let i = arr.indexOf(t);
    if (i !== -1) return i;
    const stripped = t.replace(/_[NSEW]$/i, '');
    if (stripped !== t) {
        i = arr.indexOf(stripped);
        if (i !== -1) return i;
        i = arr.findIndex(s => s.replace(/_[NSEW]$/i, '') === stripped);
        if (i !== -1) return i;
    }
    const noTrail = t.replace(/\D+$/, '');
    if (noTrail && noTrail !== t && noTrail !== stripped) {
        i = arr.indexOf(noTrail);
        if (i !== -1) return i;
    }
    if (t.length >= 5) {
        i = arr.findIndex(s => {
            const [longer, shorter] = s.length >= t.length ? [s, t] : [t, s];
            return longer.startsWith(shorter) && !/\d/.test(longer.slice(shorter.length));
        });
        if (i !== -1) return i;
    }
    return -1;
}

function getScheduledArrivals(targetStopId) {
    const sid = String(targetStopId);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    for (const marker of Object.values(vehicles)) {
        const { vehicle_id, trip_id, route_code } = marker.properties;
        if (!trip_id || !route_code) continue;
        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;
        if (now - (marker.timestamp ?? 0) > STALE_VEH) continue;

        const tripMeta    = trips[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        const dirsToTry   = preferredDir != null ? [preferredDir] : [0, 1];

        for (const dir of dirsToTry) {
            const cache = routeStops[`${route_code}|${dir}`];
            if (!cache) continue;

            const status      = marker.properties.currentStatus;
            const isStoppedAt = status === 1 || status === 'STOPPED_AT';
            const nextIdx     = findIdx(cache.stops, vehicleNextStop);
            if (isStoppedAt && nextIdx === 0) continue;

            const targetIdx = findIdx(cache.stops, sid);
            if (nextIdx === -1 || targetIdx === -1 || targetIdx < nextIdx) continue;

            let arrivalUnix;
            const statusChangedAt = marker.properties.statusChangedAt;

            if (nextIdx === targetIdx) {
                if (isStoppedAt) {
                    arrivalUnix = now;
                } else if (statusChangedAt != null && nextIdx > 0) {
                    const gap = cache.times[nextIdx] - cache.times[nextIdx - 1];
                    arrivalUnix = gap > 0
                        ? now + Math.max(0, gap - Math.min((now - statusChangedAt) + 30, gap))
                        : now;
                } else {
                    arrivalUnix = now;
                }
            } else {
                const gap = cache.times[targetIdx] - cache.times[nextIdx];
                if (gap < 0) continue;
                if (isStoppedAt) {
                    arrivalUnix = now + Math.max(0, gap);
                } else if (statusChangedAt != null && nextIdx > 0) {
                    const interStopGap = cache.times[nextIdx] - cache.times[nextIdx - 1];
                    if (interStopGap <= 0) {
                        arrivalUnix = now + Math.max(0, gap - 30);
                    } else {
                        const timeInTransit    = Math.min((now - statusChangedAt) + 30, interStopGap);
                        const remainingToNext  = Math.max(0, interStopGap - timeInTransit);
                        arrivalUnix = now + Math.max(0, remainingToNext + gap);
                    }
                } else {
                    arrivalUnix = now + Math.max(0, gap - 30);
                }
            }

            results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id, arrivalUnix });
            break;
        }
    }

    results.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
    const countPerDir = {};
    return results.filter(a => {
        const k = `${a.routeId}|${a.directionId}`;
        countPerDir[k] = (countPerDir[k] ?? 0) + 1;
        return countPerDir[k] <= 2;
    });
}

// ── Feed processors ───────────────────────────────────────────────────────────

function processVehicleMessage(msg) {
    // WS sends one vehicle at a time: { route_code, vehicle: { vehicle: {id}, trip: {tripId, directionId}, ... } }
    const v = msg?.vehicle;
    if (!v?.trip?.tripId) return;

    let ts = parseInt(v.timestamp);
    if (Number.isFinite(ts) && ts > 10_000_000_000) ts = Math.floor(ts / 1000);

    const trip_id    = String(v.trip.tripId);
    const route_code = String(msg.route_code ?? '');
    const key        = trip_id;
    const prev       = vehicles[key];
    if (prev && ts <= prev.timestamp) return;

    const prevStopId = prev?.properties?.stopId;
    const stopId     = v.stopId != null ? String(v.stopId) : null;

    vehicles[key] = {
        timestamp: ts,
        properties: {
            vehicle_id:      String(v.vehicle?.id ?? ''),
            trip_id,
            route_code,
            direction_id:    v.trip.directionId != null ? Number(v.trip.directionId) : null,
            currentStatus:   v.currentStatus ?? null,
            stopId,
            statusChangedAt: stopId !== prevStopId ? ts : (prev?.properties?.statusChangedAt ?? ts),
        },
    };
}

function processTripUpdate(msg) {
    const tu = msg?.tripUpdate;
    if (!tu?.stopTimeUpdate?.length) return;

    const routeId     = String(tu.trip?.routeId ?? '').split('-')[0];
    const directionId = Number(tu.trip?.directionId ?? 0);
    const vehicleId   = String(tu.vehicle?.id ?? '');
    const tripId      = String(tu.trip?.tripId ?? '');
    const now         = Math.floor(Date.now() / 1000);

    tu.stopTimeUpdate.forEach(stu => {
        const stopId      = String(stu.stopId ?? '');
        const arrivalUnix = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
        if (!stopId || !arrivalUnix || arrivalUnix < now) return;

        if (!arrivalsData.has(stopId)) arrivalsData.set(stopId, []);
        const list     = arrivalsData.get(stopId);
        const existing = list.findIndex(a => a.vehicleId === vehicleId && a.routeId === routeId);
        const entry    = { routeId, directionId, vehicleId, tripId, arrivalUnix };
        if (existing >= 0) list[existing] = entry; else list.push(entry);
        list.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
    });
}

// ── Sampling ──────────────────────────────────────────────────────────────────

let totalRows = 0;

const PROX_SEC = 90; // max seconds gap to consider a proximity match

function groupByDir(list) {
    const m = new Map();
    list.forEach(a => {
        const k = `${a.routeId}|${a.directionId}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(a);
    });
    return m;
}

function sample() {
    const now        = Math.floor(Date.now() / 1000);
    const sampledAt  = new Date().toISOString();
    let written      = 0;

    const allStopIds = new Set(arrivalsData.keys());

    allStopIds.forEach(stopId => {
        const gtfsList = (arrivalsData.get(stopId) ?? []).filter(a => a.arrivalUnix >= now - 30);
        const calcList = getScheduledArrivals(stopId);

        const stopInfo = stops[stopId];
        const stopName = stopInfo?.name ?? stopId;

        const gtfsDir = groupByDir(gtfsList);
        const calcDir = groupByDir(calcList);
        const allDirKeys = new Set([...gtfsDir.keys(), ...calcDir.keys()]);

        allDirKeys.forEach(dirKey => {
            const gList = gtfsDir.get(dirKey) ?? [];
            const cList = calcDir.get(dirKey) ?? [];
            const [routeId, dirStr] = dirKey.split('|');
            const directionId = Number(dirStr);

            const usedCalc = new Set();

            // Match each GTFS entry to nearest calc entry within PROX_SEC
            gList.forEach(gtfs => {
                let bestIdx = -1, bestDist = Infinity;
                cList.forEach((c, i) => {
                    if (usedCalc.has(i)) return;
                    const d = Math.abs(c.arrivalUnix - gtfs.arrivalUnix);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                });

                const calc = bestIdx >= 0 && bestDist <= PROX_SEC ? cList[bestIdx] : null;
                if (calc) usedCalc.add(bestIdx);

                const tripId    = gtfs.tripId ?? calc?.tripId ?? null;
                const vehicleId = gtfs.vehicleId ?? calc?.vehicleId ?? null;
                const tripInfo  = tripId ? trips[tripId] : null;
                const gtfsEta   = gtfs.arrivalUnix - now;
                const calcEta   = calc ? calc.arrivalUnix - now : null;

                appendFileSync(OUT_FILE, JSON.stringify({
                    sampledAt, routeId, directionId, stopId, stopName,
                    vehicleId, tripId, dest: tripInfo?.dest ?? null,
                    gtfsEta, calcEta,
                    deltaSeconds: calc ? calcEta - gtfsEta : null,
                    onlyCalc: false,
                    onlyGtfs: calc == null,
                }) + '\n');
                written++;
            });

            // Unmatched calc entries → onlyCalc
            cList.forEach((c, i) => {
                if (usedCalc.has(i)) return;
                const tripInfo = c.tripId ? trips[c.tripId] : null;
                appendFileSync(OUT_FILE, JSON.stringify({
                    sampledAt, routeId, directionId, stopId, stopName,
                    vehicleId: c.vehicleId, tripId: c.tripId, dest: tripInfo?.dest ?? null,
                    gtfsEta: null, calcEta: c.arrivalUnix - now,
                    deltaSeconds: null,
                    onlyCalc: true,
                    onlyGtfs: false,
                }) + '\n');
                written++;
            });
        });
    });

    totalRows += written;
    return written;
}

// ── WebSocket connections ─────────────────────────────────────────────────────

function connectWS(url, onMessage) {
    const attempt = () => {
        const ws = new WebSocket(url);
        ws.addEventListener('open',    () => console.log(`[ws] ✓ ${url}`));
        ws.addEventListener('message', e => { try { onMessage(JSON.parse(e.data)); } catch {} });
        ws.addEventListener('close',   () => { console.log(`[ws] ↺ ${url}`); setTimeout(attempt, 5000); });
        ws.addEventListener('error',   () => ws.close());
    };
    attempt();
}

connectWS('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', processVehicleMessage);
connectWS('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901', processVehicleMessage);

connectWS('wss://api.metro.net/ws/LACMTA_Rail/trip_updates',    processTripUpdate);
connectWS('wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950', processTripUpdate);

// Prune stale GTFS entries every 30s
setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    arrivalsData.forEach((list, stopId) => {
        const fresh = list.filter(a => a.arrivalUnix > now - 60);
        if (!fresh.length) arrivalsData.delete(stopId); else arrivalsData.set(stopId, fresh);
    });
}, 30_000);

// ── Main loop ─────────────────────────────────────────────────────────────────

const startTime = Date.now();
writeFileSync(OUT_FILE, ''); // ensure file exists

console.log(`[capture] Output → ${OUT_FILE}`);
console.log(`[capture] Warming up ${WARMUP_MS / 1000}s…`);

setTimeout(() => {
    console.log('[capture] Sampling started.');

    const interval = setInterval(() => {
        const rows    = sample();
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const mins    = Math.floor(elapsed / 60);
        const secs    = elapsed % 60;
        const vehCount  = Object.values(vehicles).filter(v => Math.floor(Date.now()/1000) - v.timestamp <= STALE_VEH).length;
        console.log(`  ${mins}m${secs}s | +${rows} rows (${totalRows} total) | ${arrivalsData.size} GTFS stops | ${vehCount} live vehicles`);
    }, SAMPLE_INTERVAL);

    setTimeout(() => {
        clearInterval(interval);
        sample(); // final sample
        console.log(`\n[capture] Done — ${totalRows} rows saved to:\n  ${OUT_FILE}`);
        process.exit(0);
    }, DURATION_MIN * 60 * 1000);

}, WARMUP_MS);
