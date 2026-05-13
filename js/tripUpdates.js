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
 * Last successful trip_updates frame timestamp (unix seconds) per feed.
 * Read by station popups to surface a "data may be stale" banner when the
 * feed has been silent long enough that displayed ETAs are likely wrong.
 */
const _feedLastFrameUnix = { rail: 0, bus: 0 };

/**
 * @returns {{rail:number, bus:number}} unix-seconds timestamp of the last
 * processed frame on each feed. Zero means no frame has arrived since boot.
 */
export function getTripUpdatesFeedHealth() {
    return { ..._feedLastFrameUnix };
}

/**
 * Connect to Metro GTFS-RT trip_updates WebSocket feeds (rail + all bus) and begin
 * populating window.masterArrivalsData and tripTerminusByTripId.
 * Stale entries (>60 s past their predicted arrival) are pruned every 30 seconds.
 */
let _tripUpdatesInitialized = false;

export function initTripUpdates() {
    // Allow re-init if module state was wiped (test reset path).
    if (_tripUpdatesInitialized && window.masterArrivalsData) return;
    _tripUpdatesInitialized = true;
    window.masterArrivalsData = new Map();
    connect(RAIL_WS_URL, null);
    connect(BUS_WS_URL, null);
}

// Inbound watchdog: trip_updates frames arrive at sub-30s cadence under normal
// load; 60s of silence is a reliable half-dead-connection signal. Mirrors the
// api.js liveness pattern so trip_updates can't silently hang and starve ETAs
// without anyone noticing.
const WS_INBOUND_TIMEOUT_MS    = 60_000;
const WS_WATCHDOG_INTERVAL_MS  = 15_000;
// Trigger a reconnect on tab resume if a socket has been silent longer than
// this. The api.js vehicle-positions feed uses the same threshold — symmetry
// keeps both feeds in lockstep when a backgrounded tab comes back to focus.
const WS_VISIBILITY_STALE_MS   = 30_000;

const _activeSockets = new Set();

function connect(url, routeFilter, attempt = 0) {
    const ws = new WebSocket(url);
    let currentAttempt = attempt;
    ws._lastMessageAt = Date.now();
    _activeSockets.add(ws);

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
        _activeSockets.delete(ws);
        const delay = wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        setTimeout(() => connect(url, routeFilter, currentAttempt + 1), delay);
    };

    // Tag the connection with which feed it represents so onmessage can
    // update the per-feed staleness clock without re-deriving from URL.
    const _feedKey = url === RAIL_WS_URL ? 'rail' : 'bus';

    ws.onmessage = (e) => {
        ws._lastMessageAt = Date.now();
        _feedLastFrameUnix[_feedKey] = Math.floor(Date.now() / 1000);
        try { processUpdate(JSON.parse(e.data), routeFilter); }
        catch (err) {
            // Swallow malformed JSON frames silently (expected on partial closes);
            // surface anything else so logic bugs in processUpdate aren't hidden.
            if (!(err instanceof SyntaxError)) console.warn('[tripUpdates] processUpdate error:', err);
        }
    };
}

// ── TEMPORARY INSTRUMENTATION (audit finding #5) ──────────────────────────
// Counts incoming trip_updates by raw and normalized routeId so a single CI
// cron run reveals whether D Line (805) is genuinely absent or whether our
// normalization is dropping it. Logs every 60 s. Revert after one capture.
const _rawRouteCounts        = new Map();
const _normalizedRouteCounts = new Map();
let _routeCountLogStartedAt  = 0;
function _logRouteCounts() {
    if (!_routeCountLogStartedAt) _routeCountLogStartedAt = Date.now();
    const elapsedS = Math.round((Date.now() - _routeCountLogStartedAt) / 1000);
    const raw  = [..._rawRouteCounts.entries()].sort((a, b) => b[1] - a[1]);
    const norm = [..._normalizedRouteCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`[tripUpdates audit] t+${elapsedS}s — raw routeIds:`,
        Object.fromEntries(raw));
    console.log(`[tripUpdates audit] t+${elapsedS}s — normalized:`,
        Object.fromEntries(norm));
}
setVisibleInterval(_logRouteCounts, 60_000, 'tripUpdates:audit-route-counts');

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
    // Audit instrumentation — counts every incoming routeId, pre- and post-
    // normalization. Revert when finding #5 is resolved.
    _rawRouteCounts.set(rawRouteId, (_rawRouteCounts.get(rawRouteId) || 0) + 1);
    _normalizedRouteCounts.set(routeId, (_normalizedRouteCounts.get(routeId) || 0) + 1);
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
        // Allow a 30 s grace window: a vehicle the feed says arrived 1–30 s ago may still
        // be at the platform. The downstream prune (setVisibleInterval) and getScheduledArrivals
        // both use a 60 s grace, so reject here only if clearly past.
        if (!stopId || !arrivalUnix || arrivalUnix < now - 30) return;

        if (!window.masterArrivalsData.has(stopId)) window.masterArrivalsData.set(stopId, []);

        const list     = window.masterArrivalsData.get(stopId);
        // Dedup key: prefer tripId (always unique) over vehicleId (frequently "" when
        // Metro omits vehicle.id — using it as the sole key collapses multiple trains
        // on the same route into a single entry, dropping real arrivals).
        const existing = list.findIndex(a => a.tripId === tripId);
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
}, 30000, 'tripUpdates:prune');

// Visibility-resume reconnect — mirrors api.js for the vehicle-positions feed.
// Without this, a backgrounded tab whose trip_updates socket went stale during
// the hidden window can take the full 60 s inbound-watchdog interval to notice
// and reconnect — that's up to a minute of stale arrivals after tab focus.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const nowMs = Date.now();
    for (const ws of _activeSockets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (nowMs - (ws._lastMessageAt ?? 0) > WS_VISIBILITY_STALE_MS) {
            console.log(`[tripUpdates] forcing reconnect on resume (silent ${Math.round((nowMs - ws._lastMessageAt) / 1000)}s)`);
            ws.close();
        }
    }
});
