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

/**
 * Normalize a timestamp to unix seconds (accepts both ms and s).
 * Mirrors api.js._normalizeTimestamp — duplicated here to avoid a circular import.
 * @param {number} ts
 * @returns {number}
 */
function _normalizeTimestamp(ts) {
    return ts > 1e10 ? Math.floor(ts / 1000) : ts;
}

const RAIL_WS_URL = 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates';
// Unfiltered bus trip_updates feed — populates masterArrivalsData for ALL Metro
// bus stops, not just G/J/950. Used by the nearby-buses section in the station
// popup. Volume is text-only and modest; no per-route filter applied downstream.
const BUS_WS_URL  = 'wss://api.metro.net/ws/LACMTA/trip_updates';

/**
 * Maps tripId → terminusStopId (the last stop in the trip's stop_time_update sequence).
 * Populated in real time from the WebSocket feeds; used by station popups to display
 * destination names for bus trips that lack static trip data.
 * @type {Map<string, string>}
 */
export const tripTerminusByTripId = new Map();
window.tripTerminusByTripId = tripTerminusByTripId;

/**
 * Connect to Metro GTFS-RT trip_updates WebSocket feeds (rail + all bus) and begin
 * populating window.masterArrivalsData and tripTerminusByTripId.
 * Stale entries (>60 s past their predicted arrival) are pruned every 30 seconds.
 */
export function initTripUpdates() {
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    connect(BUS_WS_URL, null);
}

// Inbound watchdog: trip_updates frames arrive at sub-30s cadence under normal
// load; 60s of silence is a reliable half-dead-connection signal. Mirrors the
// api.js liveness pattern so trip_updates can't silently hang and starve ETAs
// without anyone noticing.
const WS_INBOUND_TIMEOUT_MS   = 60_000;
const WS_WATCHDOG_INTERVAL_MS = 15_000;

function connect(url, routeFilter, attempt = 0) {
    const ws = new WebSocket(url);
    let currentAttempt = attempt;
    ws._lastMessageAt = Date.now();

    // Keepalive: prevents NAT/proxy timeouts on idle connections (mirrors api.js behavior)
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 30_000);

    // Inbound watchdog: force-close if no message in WS_INBOUND_TIMEOUT_MS so
    // onclose fires and the reconnect path runs.
    const watchdogInterval = setInterval(() => {
        if (Date.now() - ws._lastMessageAt > WS_INBOUND_TIMEOUT_MS
            && ws.readyState === WebSocket.OPEN) {
            console.warn(`[tripUpdates] WebSocket ${url} silent for >${WS_INBOUND_TIMEOUT_MS/1000}s — forcing reconnect`);
            ws.close();
        }
    }, WS_WATCHDOG_INTERVAL_MS);

    ws.onerror = (e) => { console.warn(`[tripUpdates] Error on ${url}`, e); };
    ws.onopen = () => { currentAttempt = 0; ws._lastMessageAt = Date.now(); };
    ws.onclose = () => {
        clearInterval(pingInterval);
        clearInterval(watchdogInterval);
        const delay = wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        setTimeout(() => connect(url, routeFilter, currentAttempt + 1), delay);
    };

    ws.onmessage = (e) => {
        ws._lastMessageAt = Date.now();
        try { processUpdate(JSON.parse(e.data), routeFilter); }
        catch (err) {
            // Swallow malformed JSON frames silently (expected on partial closes);
            // surface anything else so logic bugs in processUpdate aren't hidden.
            if (!(err instanceof SyntaxError)) console.warn('[tripUpdates] processUpdate error:', err);
        }
    };
}

/**
 * Parse a GTFS-RT trip_update message and upsert its arrivals into
 * window.masterArrivalsData. Exposed for unit testing — the production
 * caller is the WebSocket onmessage handler in connect().
 * @param {Object} msg          Parsed JSON frame from the WebSocket
 * @param {Set<string>|null} routeFilter  Optional route-code allowlist
 */
export function processUpdate(msg, routeFilter) {
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
    }

    tripUpdate.stopTimeUpdate.forEach(stu => {
        const stopId    = String(stu.stopId ?? '');
        // Defensive ms-vs-seconds normalization: GTFS-RT spec is seconds, but if a
        // future feed change sends ms-since-epoch, the past-arrival prune below
        // would never fire (ms > now-in-seconds always) and entries would leak.
        let arrivalUnix = _normalizeTimestamp(Number(stu.arrival?.time ?? stu.departure?.time ?? 0));
        if (!stopId || !arrivalUnix || arrivalUnix < now) return;

        if (!window.masterArrivalsData.has(stopId)) window.masterArrivalsData.set(stopId, []);

        const list     = window.masterArrivalsData.get(stopId);
        // key: vehicleId + tripId — one entry per active vehicle-trip pair
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
