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

import { setVisibleInterval, wsBackoffDelay, normalizeTimestamp, splitRouteId } from './utils.js';
import { recordFeedDrop } from './feedStats.js';
import {
    WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS, PAST_ARRIVAL_GRACE_S,
    WS_PERIODIC_RECONNECT_MS, WS_PERIODIC_RECONNECT_JITTER_MS,
    VEHICLE_MARKER_TTL_S,
} from './config.js';

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
// Production consumers (stations.js, predictions.js) import this binding
// directly. No window mirror — the previous duplicate access pattern
// (some sites read the import, others read the window global) was a
// drift risk for no real benefit.
export const tripTerminusByTripId = new Map();
// Parallel timestamp map: tracks when each tripTerminusByTripId entry was last
// refreshed by an inbound trip_update. Pruning uses this so a terminus entry
// outlives the inbound arrivals list (which prunes at PAST_ARRIVAL_GRACE_S = 60 s)
// and stays valid for VEHICLE_MARKER_TTL_S (180 s) — matches the vehicle marker
// TTL so destination labels can't blank out while the marker is still on screen.
// Internal; not exported (consumers only need the terminus value, not its age).
const _terminusLastSeenUnix = new Map();

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
    connect(RAIL_WS_URL);
    connect(BUS_WS_URL);
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
// Reconnect delay after a deliberate watchdog- or periodic-triggered close.
// Mirrors api.js — the previous server connection wasn't unreachable, we just
// decided to refresh, so skip the exponential backoff.
const WS_FAST_RECONNECT_MS     = 1_000;

const _activeSockets = new Set();
// Pending reconnect timers, keyed by url (rail + bus = 2 entries max). Mirrors
// api.js — ensures only one reconnect is queued per URL even if multiple paths
// (watchdog + visibility-resume) somehow trigger close in quick succession.
const _pendingReconnects = new Map();

function connect(url, attempt = 0) {
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
            ws._deliberateReconnect = true;
            ws.close();
        }
    }, WS_WATCHDOG_INTERVAL_MS);

    // Periodic snapshot refresh — see api.js for the full rationale. Without
    // this, a long-running trip_updates connection can hold stale or missing
    // entries because Metro's WS sends a state snapshot only on initial
    // connect. Every WS_PERIODIC_RECONNECT_MS we deliberately rotate and
    // pick up Metro's current state.
    const _jitter = (Math.random() - 0.5) * WS_PERIODIC_RECONNECT_JITTER_MS;
    const periodicReconnectTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
            console.info(`[tripUpdates] periodic reconnect — ${url}`);
            ws._deliberateReconnect = true;
            ws.close();
        }
    }, WS_PERIODIC_RECONNECT_MS + _jitter);

    ws.onerror = (e) => { console.warn(`[tripUpdates] Error on ${url}`, e); };
    ws.onopen = () => { currentAttempt = 0; ws._lastMessageAt = Date.now(); };
    ws.onclose = () => {
        clearInterval(pingInterval);
        clearInterval(watchdogInterval);
        clearTimeout(periodicReconnectTimer);
        _activeSockets.delete(ws);
        // Skip if a reconnect is already pending for this URL — defensive
        // against any future path triggering a duplicate schedule.
        if (_pendingReconnects.has(url)) return;
        // Deliberate close (watchdog or periodic rotation) → fast reconnect
        // with no backoff; the network is fine, we just decided to refresh.
        const _wasDeliberate = !!ws._deliberateReconnect;
        const delay = _wasDeliberate
            ? WS_FAST_RECONNECT_MS
            : wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        const nextAttempt = _wasDeliberate ? 0 : currentAttempt + 1;
        const timerId = setTimeout(() => {
            _pendingReconnects.delete(url);
            connect(url, nextAttempt);
        }, delay);
        _pendingReconnects.set(url, timerId);
    };

    // Tag the connection with which feed it represents so onmessage can
    // update the per-feed staleness clock without re-deriving from URL.
    const _feedKey = url === RAIL_WS_URL ? 'rail' : 'bus';

    ws.onmessage = (e) => {
        ws._lastMessageAt = Date.now();
        _feedLastFrameUnix[_feedKey] = Math.floor(Date.now() / 1000);
        try { processUpdate(JSON.parse(e.data)); }
        catch (err) {
            // Swallow malformed JSON frames silently (expected on partial closes);
            // surface anything else so logic bugs in processUpdate aren't hidden.
            // Either way, bump the feed-stats counter so persistent parse
            // failures surface as measurable signal, not just log spam.
            if (err instanceof SyntaxError) {
                recordFeedDrop(url, 'jsonParse');
            } else {
                console.warn('[tripUpdates] processUpdate error:', err);
            }
        }
    };
}

/**
 * Parse a GTFS-RT trip_update message and upsert its arrivals into
 * window.masterArrivalsData. Exposed for unit testing — the production
 * caller is the WebSocket onmessage handler in connect().
 * @param {Object} msg          Parsed JSON frame from the WebSocket
 */
export function processUpdate(msg) {
    const tripUpdate = msg?.tripUpdate;
    if (!tripUpdate?.stopTimeUpdate?.length) return;

    // GTFS-RT schedule_relationship: CANCELED trips are not running. Without
    // this gate, their stopTimeUpdate entries would populate masterArrivalsData
    // and rider popups would show an ETA for a train that won't arrive.
    if (tripUpdate.trip?.scheduleRelationship === 'CANCELED') return;

    const routeId     = splitRouteId(tripUpdate.trip?.routeId);
    const directionId = tripUpdate.trip?.directionId != null
        ? Number(tripUpdate.trip.directionId)
        : null;  // null = unknown; do NOT default to 0 (0 is a valid direction)
    const vehicleId   = String(tripUpdate.vehicle?.id ?? '');
    const tripId      = String(tripUpdate.trip?.tripId ?? '');
    const now         = Math.floor(Date.now() / 1000);

    // Capture the trip's terminus (last stop in the update sequence) for popup labeling.
    if (tripId && tripUpdate.stopTimeUpdate.length) {
        const lastStu = tripUpdate.stopTimeUpdate[tripUpdate.stopTimeUpdate.length - 1];
        const lastStopId = String(lastStu?.stopId ?? '');
        if (lastStopId) {
            tripTerminusByTripId.set(tripId, lastStopId);
            _terminusLastSeenUnix.set(tripId, now);
        }
    }

    tripUpdate.stopTimeUpdate.forEach(stu => {
        // Skip stops the feed flags as SKIPPED — the train will pass through
        // without serving them. Riders should NOT see an arrival pill for a
        // stop the train will demonstrably skip.
        if (stu.scheduleRelationship === 'SKIPPED') return;
        const stopId    = String(stu.stopId ?? '');
        // Defensive ms-vs-seconds normalization: GTFS-RT spec is seconds, but if a
        // future feed change sends ms-since-epoch, the past-arrival prune below
        // would never fire (ms > now-in-seconds always) and entries would leak.
        // `Number()` is deliberate — GTFS-RT timestamps are numeric per spec, and
        // even if the proto deserializer hands us a string of digits we want
        // numeric semantics. Without the cast normalizeTimestamp would route a
        // string like "1700000000" through `new Date(s)`, which treats short
        // numeric strings as YEAR values and returns garbage. Alerts ingest
        // (alerts.js) does the opposite — passes ISO strings directly because
        // Metro's alert API actually emits ISO-8601.
        let arrivalUnix = normalizeTimestamp(Number(stu.arrival?.time ?? stu.departure?.time ?? 0));
        // Single past-arrival grace shared with the prune loop and the popup
        // filter — see config.PAST_ARRIVAL_GRACE_S for the rationale on why this
        // must agree everywhere.
        if (!stopId || !arrivalUnix || arrivalUnix < now - PAST_ARRIVAL_GRACE_S) return;

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

    // No per-entry animation/state update needed here: the next WS vehicle
    // fix will pick up the fresh arrivalUnix from masterArrivalsData when
    // predictions are recomputed; this writer's only job is to keep the
    // ingest map fresh.
}

/**
 * Prune stale arrivals from masterArrivalsData, and independently prune
 * tripTerminusByTripId by age. Each map has its own TTL because they serve
 * different consumers:
 *
 *   - masterArrivalsData drives the ETA pipeline; entries can't outlive their
 *     own `arrivalUnix` more than PAST_ARRIVAL_GRACE_S, otherwise riders see
 *     stale "departed already" predictions.
 *   - tripTerminusByTripId drives popup destination labels; entries must
 *     outlive the arrivals list because vehicle markers persist for
 *     VEHICLE_MARKER_TTL_S (180 s) past their last update. Pruning in lockstep
 *     with arrivals (the prior implementation) blanked destination labels
 *     during the 120 s window between PAST_ARRIVAL_GRACE_S and the marker TTL.
 *
 * Both prunes bound the map size on long-running sessions (service-date
 * rollovers can reuse tripIds for different terminuses).
 *
 * Exposed for tests; the production caller is the setVisibleInterval below.
 */
export function pruneStaleArrivals(nowSec = Math.floor(Date.now() / 1000)) {
    if (!window.masterArrivalsData) return;
    window.masterArrivalsData.forEach((list, stopId) => {
        const fresh = list.filter(a => a.arrivalUnix > nowSec - PAST_ARRIVAL_GRACE_S);
        if (fresh.length === 0) window.masterArrivalsData.delete(stopId);
        else window.masterArrivalsData.set(stopId, fresh);
    });
    // Drop terminus entries whose last refresh is older than the vehicle-marker
    // TTL — past this point the marker has been removed from the map, so the
    // destination label can never be queried for that tripId again.
    const terminusCutoff = nowSec - VEHICLE_MARKER_TTL_S;
    _terminusLastSeenUnix.forEach((lastSeen, tripId) => {
        if (lastSeen < terminusCutoff) {
            tripTerminusByTripId.delete(tripId);
            _terminusLastSeenUnix.delete(tripId);
        }
    });
}

setVisibleInterval(() => pruneStaleArrivals(), 30000, 'tripUpdates:prune');

// Visibility-resume reconnect — mirrors api.js for the vehicle-positions feed.
// Without this, a backgrounded tab whose trip_updates socket went stale during
// the hidden window can take the full 60 s inbound-watchdog interval to notice
// and reconnect — that's up to a minute of stale arrivals after tab focus.
// `force` (page reopened from bfcache) reconnects every live socket; otherwise
// only those silent past the visibility threshold.
function _reconnectOnResume(force, reason) {
    const nowMs = Date.now();
    for (const ws of _activeSockets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (force || nowMs - (ws._lastMessageAt ?? 0) > WS_VISIBILITY_STALE_MS) {
            console.info(`[tripUpdates] ${reason} — reconnecting (silent ${Math.round((nowMs - (ws._lastMessageAt ?? 0)) / 1000)}s)`);
            ws._deliberateReconnect = true;
            ws.close();
        }
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    _reconnectOnResume(false, 'visibility restore');
});

// bfcache restore: the page/browser was reopened after inactivity — force a
// fresh snapshot rather than waiting for the inbound watchdog.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) _reconnectOnResume(true, 'page reopened (bfcache)');
});
