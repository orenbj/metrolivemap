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
import { recordFeedDrop, recordReceived, recordAccepted, recordMarkerDrop } from './feedStats.js';
import {
    WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS, PAST_ARRIVAL_GRACE_S,
    MAX_ARRIVAL_HORIZON_S,
    WS_PERIODIC_RECONNECT_MS, WS_PERIODIC_RECONNECT_JITTER_MS,
    WS_INBOUND_TIMEOUT_MS, WS_WATCHDOG_INTERVAL_MS, WS_PING_INTERVAL_MS,
    WS_VISIBILITY_STALE_MS, WS_FAST_RECONNECT_MS, WS_HIDDEN_SUSPEND_MS,
    VEHICLE_MARKER_TTL_S, WS_MAX_FRAME_BYTES, METRO_WS_FEEDS,
} from './config.js';

const RAIL_WS_URL = METRO_WS_FEEDS.RAIL_TU;
// Unfiltered bus trip_updates feed — populates masterArrivalsData for ALL Metro
// bus stops, not just G/J/950. Used by the nearby-buses section in the station
// popup. Volume is text-only and modest; no per-route filter applied downstream.
const BUS_WS_URL  = METRO_WS_FEEDS.BUS_TU;

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

// WebSocket liveness tunables (WS_INBOUND_TIMEOUT_MS, WS_WATCHDOG_INTERVAL_MS,
// WS_VISIBILITY_STALE_MS, WS_FAST_RECONNECT_MS) are centralized in config.js and
// shared with the api.js vehicle-positions feed so both stay in lockstep.

const _activeSockets = new Set();
// Pending reconnect timers, keyed by url (rail + bus = 2 entries max). Mirrors
// api.js — ensures only one reconnect is queued per URL even if multiple paths
// (watchdog + visibility-resume) somehow trigger close in quick succession.
const _pendingReconnects = new Map();
// True between a hidden-tab suspend and the next resume (D1) — blocks onclose
// from reconnecting a socket we closed deliberately to save battery. The
// trip_updates feed is the bigger firehose (~850 frames/s on bus) and, unlike
// api.js, processes EVERY frame while hidden, so suspending it is the larger win.
let _feedsSuspended = false;

function connect(url, attempt = 0) {
    const ws = new WebSocket(url);
    let currentAttempt = attempt;
    ws._lastMessageAt = Date.now();
    _activeSockets.add(ws);

    // Keepalive: prevents NAT/proxy timeouts on idle connections (mirrors api.js behavior)
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, WS_PING_INTERVAL_MS);

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
    // Backoff resets on the first received MESSAGE (in onmessage), not on open —
    // an accept-then-close server flap would otherwise pin the reconnect delay at
    // the floor forever. See the matching note in api.js.
    ws.onopen = () => { ws._lastMessageAt = Date.now(); };
    ws._url = url;   // for resume-time dedup
    ws.onclose = () => {
        clearInterval(pingInterval);
        clearInterval(watchdogInterval);
        clearTimeout(periodicReconnectTimer);
        _activeSockets.delete(ws);
        // Hidden-tab suspend (D1): closed deliberately to stop the firehose —
        // tear down timers but don't reconnect; resumeFeeds() re-opens on return.
        if (ws._suspendClose || _feedsSuspended) return;
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
        // Instrument received/accepted like api.js. The two trip_updates URLs were
        // never recorded at all, so they always showed received=0/accepted=0 and
        // were skipped by _report — a trip_updates outage or corruption was
        // invisible in feedStats. recordReceived BEFORE parse so a malformed-only
        // feed still surfaces (with its jsonParse drops) instead of reading silent.
        recordReceived(url);
        currentAttempt = 0; // a real frame arrived → healthy connection, reset backoff
        // Bound the parse: reject an oversized frame BEFORE JSON.parse locks the
        // main thread on it (mirrors api.js). Per-trip frames are a few KB, so the
        // 256 KB cap only ever catches a pathological/corrupt blob.
        const frameLen = typeof e.data === 'string' ? e.data.length : (e.data?.byteLength ?? 0);
        if (frameLen > WS_MAX_FRAME_BYTES) {
            console.warn(`[tripUpdates] oversized WS frame (${frameLen} B) from ${url} — rejected before parse`);
            recordFeedDrop(url, 'oversizeFrame');
            return;
        }
        try {
            processUpdate(JSON.parse(e.data));
            recordAccepted(url);
        } catch (err) {
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
// J Line route-tag correction. Metro's trip_updates feed tags EVERY J Line trip
// as 910 — even the 950 San Pedro through-runs (verified live: zero 950-tagged
// predictions network-wide while 950 buses are clearly running). Our static GTFS
// keys trips by the SAME trip_id the feed sends and knows the real route, so for
// the J pair we trust it over the feed tag. Without this, a San-Pedro-bound trip
// renders under "Harbor Gateway TC" at stops NORTH of Harbor Gateway — where 910
// legitimately serves, so the popup's off-route re-attribution can't catch it
// (south of Harbor Gateway it can, because 910 doesn't serve there). Scoped to
// 910<->950 so no other route is ever touched; falls back to the feed tag when
// the trip isn't in static GTFS (owl/just-added trips).
// @param {string} feedRoute  route code from splitRouteId(trip.routeId)
// @param {string} tripId     feed trip_id (matches a masterTripsData key)
// @returns {string} the corrected route code (unchanged unless a J mis-tag)
export function correctJLineRouteTag(feedRoute, tripId) {
    if (feedRoute !== '910' && feedRoute !== '950') return feedRoute;
    const trueRc = window.masterTripsData?.[tripId]?.rc;
    if ((trueRc === '910' || trueRc === '950') && trueRc !== feedRoute) {
        recordMarkerDrop('jRouteRetag');   // a correction count, not a drop
        return trueRc;
    }
    return feedRoute;
}

export function processUpdate(msg) {
    const tripUpdate = msg?.tripUpdate;
    if (!tripUpdate) return;

    // GTFS-RT schedule_relationship: CANCELED trips are not running. Beyond
    // gating ingestion, actively purge any arrivals already ingested for this
    // trip in earlier (SCHEDULED) frames — otherwise a trip pulled mid-route
    // leaves phantom ETAs at its downstream stops until each predicted time
    // individually passes. CANCELED is 2–5% of Metro's trip-update volume
    // (measured in the feed-reliability audit), so this is a daily occurrence.
    // Checked BEFORE the empty-stopTimeUpdate return because real CANCELED frames
    // frequently carry no stop list at all — that path must still short-circuit.
    // The purge is best-effort over the stops THIS frame lists; the lastIngestUnix
    // staleness gate in every consumer is the guaranteed backstop (≤ 90 s) for
    // stops a CANCELED frame omits.
    if (tripUpdate.trip?.scheduleRelationship === 'CANCELED') {
        _purgeTripArrivals(String(tripUpdate.trip?.tripId ?? ''), tripUpdate.stopTimeUpdate);
        return;
    }

    if (!tripUpdate.stopTimeUpdate?.length) return;

    const routeId     = correctJLineRouteTag(splitRouteId(tripUpdate.trip?.routeId), String(tripUpdate.trip?.tripId ?? ''));
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
        // arrival drives the "next arrival" pill; departure is when the vehicle
        // actually LEAVES (the meaningful field at a trip's first/layover stop,
        // where arrival is the layover-arrival and departure is the scheduled pull-
        // out). Keep both: arrivalUnix falls back to departure (the common case —
        // ~7-8% of Metro STUs are departure-only first stops, per the feed audit),
        // and departureUnix is stored separately for boarding consumers.
        let _arr = stu.arrival?.time   != null ? normalizeTimestamp(Number(stu.arrival.time))   : null;
        let _dep = stu.departure?.time != null ? normalizeTimestamp(Number(stu.departure.time)) : null;
        // normalizeTimestamp returns NaN for a malformed/negative value. Null it
        // out so the `??` fallbacks below actually fire — `NaN ?? _dep` keeps NaN
        // (?? only catches null/undefined), which would drop a stop that has a
        // garbage arrival but a perfectly valid departure (and vice versa).
        if (!Number.isFinite(_arr)) _arr = null;
        if (!Number.isFinite(_dep)) _dep = null;
        const arrivalUnix   = _arr ?? _dep ?? 0;
        const departureUnix = _dep ?? _arr ?? 0;
        // Liveness uses the LATER of the two. A train dwelling at a layover stop —
        // arrival already minutes past, departure still ahead — would otherwise be
        // pruned mid-dwell by an arrival-only check, blanking its boarding badge for
        // the rest of the layover. For normal mid-route stops (departure null) this
        // is exactly arrivalUnix, so behavior there is unchanged.
        const livenessUnix = Math.max(arrivalUnix, departureUnix);
        // Single past-arrival grace shared with the prune loop and the popup
        // filter — see config.PAST_ARRIVAL_GRACE_S for the rationale on why this
        // must agree everywhere.
        if (!stopId || !arrivalUnix || livenessUnix < now - PAST_ARRIVAL_GRACE_S) return;
        // Symmetric upper horizon — mirrors api.js's FUTURE_TS_GRACE_MS future-frame
        // gate. A glitched or unit-mismatched arrival.time wildly in the future would
        // otherwise persist as a never-pruning "boarding in 3 hours" pill.
        if (arrivalUnix > now + MAX_ARRIVAL_HORIZON_S) return;

        if (!window.masterArrivalsData.has(stopId)) window.masterArrivalsData.set(stopId, []);

        const list     = window.masterArrivalsData.get(stopId);
        // Dedup key: prefer tripId (always unique) over vehicleId (frequently "" when
        // Metro omits vehicle.id — using it as the sole key collapses multiple trains
        // on the same route into a single entry, dropping real arrivals).
        const existing = list.findIndex(a => a.tripId === tripId);
        const entry    = { routeId, directionId, vehicleId, tripId, arrivalUnix, departureUnix, lastIngestUnix: now };

        if (existing >= 0) list[existing] = entry;
        else list.push(entry);
    });

    // No per-entry animation/state update needed here: the next WS vehicle
    // fix will pick up the fresh arrivalUnix from masterArrivalsData when
    // predictions are recomputed; this writer's only job is to keep the
    // ingest map fresh.
}

/**
 * Remove every arrival belonging to `tripId` from the stops listed in `stus`.
 * Called when a trip flips to CANCELED so its previously-ingested ETAs don't
 * linger as phantom arrivals. Bounded by the trip's own stop count (cheap) — a
 * full-fleet scan would be too costly at Metro's CANCELED rate (~34/s), so stops
 * a CANCELED frame omits are left to each consumer's lastIngestUnix staleness
 * gate. Exposed for unit testing.
 * @param {string} tripId  Canceled trip id (empty string is a no-op).
 * @param {Array}  stus    The CANCELED frame's stopTimeUpdate array (may be empty/undefined).
 */
export function _purgeTripArrivals(tripId, stus) {
    if (!tripId || !window.masterArrivalsData || !Array.isArray(stus)) return;
    for (const stu of stus) {
        const stopId = String(stu?.stopId ?? '');
        const list = stopId ? window.masterArrivalsData.get(stopId) : null;
        if (!list) continue;
        const filtered = list.filter(a => a.tripId !== tripId);
        if (filtered.length === 0) window.masterArrivalsData.delete(stopId);
        else if (filtered.length !== list.length) window.masterArrivalsData.set(stopId, filtered);
    }
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
        // Match the ingest liveness model: keep an entry alive until the LATER of
        // its arrival/departure is past-grace, so a layover entry that survived
        // ingest isn't pruned mid-dwell here 30 s later. departureUnix is absent on
        // older entries (defaults to arrivalUnix via ??), so mid-route stops are
        // unaffected.
        const fresh = list.filter(a => Math.max(a.arrivalUnix, a.departureUnix ?? a.arrivalUnix) > nowSec - PAST_ARRIVAL_GRACE_S);
        if (fresh.length === 0) window.masterArrivalsData.delete(stopId);
        // Nothing expired this tick (the common case) → leave the existing array
        // in place; only re-set when entries were actually dropped (mirrors
        // _purgeTripArrivals). Avoids reallocating every stop's array every 30 s.
        else if (fresh.length !== list.length) window.masterArrivalsData.set(stopId, fresh);
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

// Hidden-tab suspend (D1) — mirrors api.js. Close both feeds while hidden so the
// trip_updates firehose stops; re-open fresh on return.
export function suspendFeeds() {
    if (_feedsSuspended) return;
    _feedsSuspended = true;
    for (const tid of _pendingReconnects.values()) clearTimeout(tid);
    _pendingReconnects.clear();
    for (const ws of _activeSockets) {
        ws._suspendClose = true;
        try { ws.close(); } catch { /* already closing */ }
    }
    console.info(`[tripUpdates] feeds suspended — tab hidden >${WS_HIDDEN_SUSPEND_MS / 1000}s`);
}

export function resumeFeeds() {
    if (!_feedsSuspended) return;
    _feedsSuspended = false;
    // Reset the staleness clock so the *deliberate* hidden-tab suspend gap isn't
    // rendered as a "Live feed delayed (Nm)" banner on return — N would be the
    // whole time the user was away (a power-save we chose), not a Metro feed
    // problem. Anchoring to NOW gives the reconnect below a fresh
    // FEED_STALE_THRESHOLD_S grace; if it genuinely fails to deliver a frame the
    // clock ages normally and the banner correctly re-fires after that window.
    const _nowS = Math.floor(Date.now() / 1000);
    _feedLastFrameUnix.rail = _nowS;
    _feedLastFrameUnix.bus = _nowS;
    const activeUrls = new Set([..._activeSockets].map(ws => ws._url));
    for (const url of [RAIL_WS_URL, BUS_WS_URL]) {
        if (activeUrls.has(url) || _pendingReconnects.has(url)) continue;
        connect(url);
    }
    console.info('[tripUpdates] feeds resumed — tab visible');
}

let _suspendTimer = null;
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (_suspendTimer == null) _suspendTimer = setTimeout(suspendFeeds, WS_HIDDEN_SUSPEND_MS);
        return;
    }
    clearTimeout(_suspendTimer);
    _suspendTimer = null;
    resumeFeeds();                                    // re-open if suspended
    _reconnectOnResume(false, 'visibility restore');  // sub-grace: refresh silent sockets
});

// bfcache restore: the page/browser was reopened after inactivity — force a
// fresh snapshot rather than waiting for the inbound watchdog.
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    clearTimeout(_suspendTimer);
    _suspendTimer = null;
    resumeFeeds();
    _reconnectOnResume(true, 'page reopened (bfcache)');
});
