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
const BUS_WS_URL       = 'wss://api.metro.net/ws/LACMTA/trip_updates/910,901';
const BUS_WS_FALLBACK  = 'wss://api.metro.net/ws/LACMTA/trip_updates';
const BUS_ROUTE_FILTER = new Set(['901', '910']);
const RECONNECT_DELAY_MS = 5000;

let ws = null;

// Pending batch: routeId → Map<vehicleId, stopTimeUpdate[]>
// We accumulate updates between WS messages and merge all at once.
const pending = new Map();

export function initTripUpdates() {
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    connect(BUS_WS_URL, BUS_ROUTE_FILTER);

    // If the filtered URL yields nothing after 15s, also try unfiltered + client-side filter
    setTimeout(() => {
        const hasGJData = [...(window.masterArrivalsData?.keys() ?? [])].length === 0;
        if (hasGJData) {
            console.log('[tripUpdates] BUS feed may be empty — trying fallback URL');
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

    const routeId     = String(tripUpdate.trip?.routeId     ?? '');
    const directionId = Number(tripUpdate.trip?.directionId ?? 0);
    const vehicleId   = String(tripUpdate.vehicle?.id       ?? '');
    const now         = Math.floor(Date.now() / 1000);

    // If a route filter is set, skip updates that don't match
    if (routeFilter && !routeFilter.has(routeId)) return;

    tripUpdate.stopTimeUpdate.forEach(stu => {
        const stopId     = String(stu.stopId ?? '');
        const arrivalUnix = Number(stu.arrival?.time ?? 0);

        // Skip stops already passed or with no valid time
        if (!stopId || !arrivalUnix || arrivalUnix < now) return;

        if (!window.masterArrivalsData.has(stopId)) {
            window.masterArrivalsData.set(stopId, []);
        }

        const list = window.masterArrivalsData.get(stopId);

        // Replace existing entry for same vehicle at this stop, or append
        const existing = list.findIndex(a => a.vehicleId === vehicleId && a.routeId === routeId);
        const entry = { routeId, directionId, vehicleId, tripId: String(tripUpdate.trip?.tripId ?? ''), arrivalUnix };
        if (existing >= 0) {
            list[existing] = entry;
        } else {
            list.push(entry);
        }
    });

    // Prune expired entries and sort (do this lazily — only for affected stops)
    const now2 = Math.floor(Date.now() / 1000);
    window.masterArrivalsData.forEach((list, stopId) => {
        const fresh = list.filter(a => a.arrivalUnix > now2);
        if (fresh.length === 0) {
            window.masterArrivalsData.delete(stopId);
        } else {
            fresh.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
            window.masterArrivalsData.set(stopId, fresh);
        }
    });
}
