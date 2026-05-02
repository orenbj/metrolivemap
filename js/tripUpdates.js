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

const RAIL_WS_URL      = 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates';
const BUS_WS_URL       = 'wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950';
const BUS_WS_FALLBACK  = 'wss://api.metro.net/ws/LACMTA/trip_updates';
const BUS_ROUTE_FILTER = new Set(['901', '910', '950']);
const RECONNECT_DELAY_MS = 5000;

export function initTripUpdates() {
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    const busConn = connect(BUS_WS_URL, BUS_ROUTE_FILTER);

    // If the filtered bus URL yields no G/J arrivals after 15 s, close it and
    // try the unfiltered fallback. The filtered URL occasionally returns nothing
    // for busway routes even when service is running.
    setTimeout(() => {
        const hasGJArrivals = [...(window.masterArrivalsData?.values() ?? [])]
            .some(list => list.some(a => BUS_ROUTE_FILTER.has(a.routeId)));
        if (!hasGJArrivals) {
            console.log('[tripUpdates] No G/J arrivals — closing filtered WS, trying fallback');
            busConn.close();
            connect(BUS_WS_FALLBACK, BUS_ROUTE_FILTER);
        }
    }, 15000);
}

function connect(url, routeFilter) {
    const ws = new WebSocket(url);
    let closed = false;

    ws.onopen  = () => console.log(`[tripUpdates] Connected: ${url}`);
    ws.onerror = (e) => { console.warn(`[tripUpdates] Error on ${url}`, e); ws.close(); };
    ws.onclose = () => {
        if (closed) return;
        console.log(`[tripUpdates] Reconnecting: ${url}`);
        setTimeout(() => connect(url, routeFilter), RECONNECT_DELAY_MS);
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
    const directionId = Number(tripUpdate.trip?.directionId ?? 0);
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
setInterval(() => {
    if (!window.masterArrivalsData) return;
    const now = Math.floor(Date.now() / 1000);
    window.masterArrivalsData.forEach((list, stopId) => {
        const fresh = list.filter(a => a.arrivalUnix > now - 60);
        if (fresh.length === 0) window.masterArrivalsData.delete(stopId);
        else window.masterArrivalsData.set(stopId, fresh);
    });
}, 30000);
