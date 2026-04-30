/**
 * tripUpdates.js
 * Subscribes to the Metro GTFS-RT trip_updates WebSocket and builds a live
 * lookup of predicted arrivals per stop:
 *
 *   window.masterArrivalsData = Map {
 *     stopId → [ { routeId, directionId, vehicleId, arrivalUnix }, ... ]
 *   }
 *
 * Entries are sorted ascending by arrivalUnix and pruned every cycle.
 * The WebSocket reconnects automatically on drop.
 */

const RAIL_WS_URL      = 'wss://api.metro.net/ws/LACMTA_Rail/trip_updates';
const BUS_WS_URL       = 'wss://api.metro.net/ws/LACMTA/trip_updates/910,901,950';
const BUS_WS_FALLBACK  = 'wss://api.metro.net/ws/LACMTA/trip_updates';
const BUS_ROUTE_FILTER = new Set(['901', '910', '950']);
const RECONNECT_DELAY_MS = 5000;

let ws = null;

// Pending batch: routeId → Map<vehicleId, stopTimeUpdate[]>
// We accumulate updates between WS messages and merge all at once.
const pending = new Map();

export function initTripUpdates() {
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    connect(BUS_WS_URL, BUS_ROUTE_FILTER);

    // If the filtered bus URL yields no G/J arrivals after 15s, try the
    // unfiltered fallback URL. The previous check tested overall map size,
    // which was always non-zero because rail data arrives first — so the
    // fallback never triggered even when G/J data was absent.
    setTimeout(() => {
        const hasGJArrivals = [...(window.masterArrivalsData?.values() ?? [])]
            .some(list => list.some(a => BUS_ROUTE_FILTER.has(a.routeId)));
        if (!hasGJArrivals) {
            console.log('[tripUpdates] No G/J arrivals received — trying fallback URL');
            connect(BUS_WS_FALLBACK, BUS_ROUTE_FILTER);
        }
    }, 15000);
}

function connect(url, routeFilter) {
    const ws = new WebSocket(url);

    ws.onopen  = () => console.log(`[tripUpdates] Connected: ${url}`);
    ws.onerror = (e) => { console.warn(`[tripUpdates] Error on ${url}`, e); ws.close(); };
    ws.onclose = () => {
        console.log(`[tripUpdates] Reconnecting: ${url}`);
        setTimeout(() => connect(url, routeFilter), RECONNECT_DELAY_MS);
    };

    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            processUpdate(msg, routeFilter);
        } catch (err) {
            // ignore malformed frames
        }
    };
}

function processUpdate(msg, routeFilter) {
    const tripUpdate = msg?.tripUpdate;
    if (!tripUpdate?.stopTimeUpdate?.length) return;

    const rawRouteId  = String(tripUpdate.trip?.routeId ?? '');
    const routeId     = rawRouteId.split('-')[0];
    const directionId = Number(tripUpdate.trip?.directionId ?? 0);
    const vehicleId   = String(tripUpdate.vehicle?.id       ?? '');
    const now         = Math.floor(Date.now() / 1000);

    // If a route filter is set, skip updates that don't match
    if (routeFilter && !routeFilter.has(routeId)) return;

    const touchedStopIds = new Set();
    tripUpdate.stopTimeUpdate.forEach(stu => {
        const stopId      = String(stu.stopId ?? '');
        const arrivalUnix = Number(stu.arrival?.time ?? stu.departure?.time ?? 0);

        if (!stopId || !arrivalUnix || arrivalUnix < now) return;

        if (!window.masterArrivalsData.has(stopId)) {
            window.masterArrivalsData.set(stopId, []);
        }

        const list = window.masterArrivalsData.get(stopId);
        const existing = list.findIndex(a => a.vehicleId === vehicleId && a.routeId === routeId);
        const entry = { routeId, directionId, vehicleId, tripId: String(tripUpdate.trip?.tripId ?? ''), arrivalUnix };
        
        if (existing >= 0) {
            list[existing] = entry;
        } else {
            list.push(entry);
        }
        touchedStopIds.add(stopId);
    });

    // Only sort the stops that were actually updated in this message
    touchedStopIds.forEach(stopId => {
        const list = window.masterArrivalsData.get(stopId);
        if (list) {
            list.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
        }
    });
}

// Global pruning runs every 30 seconds to keep memory usage low
setInterval(() => {
    if (!window.masterArrivalsData) return;
    const now = Math.floor(Date.now() / 1000);
    window.masterArrivalsData.forEach((list, stopId) => {
        // Keep arrivals up to 60 seconds AFTER they reach 'Now'
        const fresh = list.filter(a => a.arrivalUnix > now - 60);
        if (fresh.length === 0) {
            window.masterArrivalsData.delete(stopId);
        } else {
            window.masterArrivalsData.set(stopId, fresh);
        }
    });
}, 30000);
