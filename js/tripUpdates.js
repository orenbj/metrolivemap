/**
 * tripUpdates.js
 * Subscribes to the Metro GTFS-RT trip_updates WebSocket feeds and builds a
 * live lookup of predicted arrivals per stop:
 *
 *   window.masterArrivalsData = Map {
 *     stopId → [ { routeId, directionId, vehicleId, tripId, arrivalUnix }, ... ]
 *   }
 *
 * Entries are sorted ascending by arrivalUnix and pruned every 30 seconds.
 * WebSocket connections reconnect automatically on drop.
 */

import { setVisibleInterval, wsBackoffDelay } from './utils.js';
import { WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS } from './config.js';

const RAIL_WS_URL = 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates';
// Unfiltered bus trip_updates feed — populates masterArrivalsData for ALL Metro
// bus stops, not just G/J/950. Used by the nearby-buses section in the station
// popup. Volume is text-only and modest; no per-route filter applied downstream.
const BUS_WS_URL  = 'wss://api.metro.net/ws/LACMTA/trip_updates';

// tripId → terminusStopId (last stop_time_update in the message). Lets the
// popup display a real destination name without needing static bus trip data.
export const tripTerminusByTripId = new Map();
window.tripTerminusByTripId = tripTerminusByTripId;

// tripId → ordered stopId array (all stop_time_update entries, future-only).
// Used by stations.js to draw bus route polylines through upcoming stop positions.
export const tripStopSeqByTripId = new Map();
window.tripStopSeqByTripId = tripStopSeqByTripId;

export function initTripUpdates() {
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    connect(BUS_WS_URL, null);
}

function connect(url, routeFilter, attempt = 0) {
    const ws = new WebSocket(url);
    let closed = false;
    let currentAttempt = attempt;

    // Keepalive: prevents NAT/proxy timeouts on idle connections (mirrors api.js behavior)
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 30_000);

    ws.onerror = (e) => { console.warn(`[tripUpdates] Error on ${url}`, e); ws.close(); };
    ws.onopen = () => { currentAttempt = 0; };
    ws.onclose = () => {
        clearInterval(pingInterval);
        if (closed) return;
        const delay = wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        setTimeout(() => connect(url, routeFilter, currentAttempt + 1), delay);
    };

    ws.onmessage = (e) => {
        try { processUpdate(JSON.parse(e.data), routeFilter); } catch { /* ignore malformed frames */ }
    };

    return { close: () => { closed = true; ws.close(); } };
}

function processUpdate(msg, routeFilter) {
    const tripUpdate = msg?.tripUpdate;
    if (!tripUpdate?.stopTimeUpdate?.length) return;

    const rawRouteId  = String(tripUpdate.trip?.routeId ?? '');
    const routeId     = rawRouteId.split('-')[0];
    const directionId = tripUpdate.trip?.directionId != null
        ? Number(tripUpdate.trip.directionId)
        : null;  // null = unknown; do NOT default to 0 (0 is a valid direction)
    const vehicleId   = String(tripUpdate.vehicle?.id ?? '');
    const tripId      = String(tripUpdate.trip?.tripId ?? '');
    const now         = Math.floor(Date.now() / 1000);

    if (routeFilter && !routeFilter.has(routeId)) return;

    // Capture the trip's terminus (last stop in the update sequence) for popup labeling.
    if (tripId && tripUpdate.stopTimeUpdate.length) {
        const lastStu = tripUpdate.stopTimeUpdate[tripUpdate.stopTimeUpdate.length - 1];
        const lastStopId = String(lastStu?.stopId ?? '');
        if (lastStopId) tripTerminusByTripId.set(tripId, lastStopId);

        // Capture full ordered stop sequence for bus route polyline rendering.
        const seq = tripUpdate.stopTimeUpdate.map(stu => String(stu.stopId ?? '')).filter(Boolean);
        if (seq.length > 1) tripStopSeqByTripId.set(tripId, seq);
    }

    tripUpdate.stopTimeUpdate.forEach(stu => {
        const stopId      = String(stu.stopId ?? '');
        const arrivalUnix = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
        if (!stopId || !arrivalUnix || arrivalUnix < now) return;

        if (!window.masterArrivalsData.has(stopId)) window.masterArrivalsData.set(stopId, []);

        const list     = window.masterArrivalsData.get(stopId);
        const existing = list.findIndex(a => a.vehicleId === vehicleId && a.routeId === routeId);
        const entry    = { routeId, directionId, vehicleId, tripId, arrivalUnix, lastIngestUnix: now };

        if (existing >= 0) list[existing] = entry;
        else list.push(entry);
    });
}

// Prune stale entries every 30 seconds
setVisibleInterval(() => {
    if (!window.masterArrivalsData) return;
    const now = Math.floor(Date.now() / 1000);
    window.masterArrivalsData.forEach((list, stopId) => {
        const fresh = list.filter(a => a.arrivalUnix > now - 60);
        if (fresh.length === 0) window.masterArrivalsData.delete(stopId);
        else window.masterArrivalsData.set(stopId, fresh);
    });
}, 30000);
