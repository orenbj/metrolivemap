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
import { WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS, WS_BUS_FALLBACK_MS } from './config.js';

const RAIL_WS_URL      = 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates';
const BUS_WS_URL       = 'wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950';
const BUS_WS_FALLBACK  = 'wss://api.metro.net/ws/LACMTA/trip_updates';
const BUS_ROUTE_FILTER = new Set(['901', '910', '950']);

export function initTripUpdates() {
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    const busConn = connect(BUS_WS_URL, BUS_ROUTE_FILTER);

    // If the filtered bus URL yields no G/J arrivals after WS_BUS_FALLBACK_MS, close it and
    // try the unfiltered fallback. The filtered URL occasionally returns nothing
    // for busway routes even when service is running.
    setTimeout(() => {
        const hasGJArrivals = [...(window.masterArrivalsData?.values() ?? [])]
            .some(list => list.some(a => BUS_ROUTE_FILTER.has(a.routeId)));
        if (!hasGJArrivals) {
            busConn.close();
            connect(BUS_WS_FALLBACK, BUS_ROUTE_FILTER);
        }
    }, WS_BUS_FALLBACK_MS);
}

function connect(url, routeFilter, attempt = 0) {
    const ws = new WebSocket(url);
    let closed = false;
    let currentAttempt = attempt;

    ws.onerror = (e) => { console.warn(`[tripUpdates] Error on ${url}`, e); ws.close(); };
    ws.onopen = () => { currentAttempt = 0; };
    ws.onclose = () => {
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

    tripUpdate.stopTimeUpdate.forEach(stu => {
        const stopId      = String(stu.stopId ?? '');
        const arrivalUnix = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);
        if (!stopId || !arrivalUnix || arrivalUnix < now) return;

        if (!window.masterArrivalsData.has(stopId)) window.masterArrivalsData.set(stopId, []);

        const list     = window.masterArrivalsData.get(stopId);
        const existing = list.findIndex(a => a.vehicleId === vehicleId && a.routeId === routeId);
        const entry    = { routeId, directionId, vehicleId, tripId, arrivalUnix };

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
