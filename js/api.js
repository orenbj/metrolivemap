import { removeLoadingScreen, updateUpdateTime, setConnectionStatus } from './ui.js';
import { processVehicleData } from './markers.js';
import {
    WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS,
    WS_PERIODIC_RECONNECT_MS, WS_PERIODIC_RECONNECT_JITTER_MS,
    MAX_PLAUSIBLE_SPEED_MPS,
    FRESH_EXPIRE_S,
    FUTURE_TS_GRACE_MS,
} from './config.js';

// Hidden-tab buffer cap. Each entry represents one vehicle's latest frame;
// Map iteration order is insertion order, so eviction at this cap drops
// the vehicle whose update is oldest in queue position. ~200 active fleet
// at peak + headroom for hidden-tab edge cases.
const PENDING_VEHICLE_CAP = 250;
import { wsBackoffDelay, normalizeTimestamp } from './utils.js';
import {
    recordReceived, recordAccepted, recordFeedDrop,
} from './feedStats.js';

const _connectedSockets = new Set();
// Active WebSockets keyed by URL — used by the visibility handler to immediately
// health-check every feed when the tab regains focus, and force-reconnect any
// that have gone silent. Each socket carries `_lastMessageAt` for liveness checks.
const _activeSockets = new Map();
// Pending reconnect timers, keyed by url. Tracked so a second onclose or a
// future external setupWebSocket(url) call can't accidentally schedule two
// reconnects for the same URL — would leak watchdog intervals on the orphan
// socket. The spec says onclose fires once per socket, but the explicit
// invariant is cheap and protects against future call paths that don't yet
// exist.
const _pendingReconnects = new Map();
// Buffer the latest frame per vehicle while the tab is hidden so visibility
// restore replays the most recent position for every vehicle, not just the
// last one across all vehicles (which is what a scalar pendingData missed).
const _pendingByVehicle = new Map();
let _globalLoadingTimeout = null;

// ── WebSocket liveness tunables ──────────────────────────────────────────────
// Force-close a socket if no inbound message arrives within this window. Metro
// vehicle position feeds emit at sub-30s cadence under normal load, so 60s of
// total silence is a reliable "half-dead connection" signal. Tighter than the
// default backoff window so we recover within a minute instead of waiting for
// the OS-level TCP timeout (often 5+ min).
const WS_INBOUND_TIMEOUT_MS = 60_000;
// How often the watchdog tick checks each socket's lastMessageAt.
const WS_WATCHDOG_INTERVAL_MS = 15_000;
// Visibility-restore staleness threshold — when the tab regains focus, any
// socket that hasn't received a message in this long is force-reconnected
// immediately rather than waiting for the next watchdog tick.
const WS_VISIBILITY_STALE_MS = 30_000;
// Reconnect delay after a deliberate watchdog-triggered close. Skips the normal
// exponential backoff because we already know the network/client is fine —
// the previous server connection was unresponsive, not unreachable.
const WS_FAST_RECONNECT_MS = 1_000;

// Track vehicle IDs that have been warned about missing data, so we don't spam the console.
const _warnedVehicles = new Set();
// `level` lets EXPECTED drops (e.g. a layover/deadheading vehicle with no
// assigned trip) log at 'debug' — visible when a dev opts into verbose output,
// silent in the default console — while genuinely anomalous drops stay at
// 'warn'. The drop rate is always tracked precisely by the feedStats counters
// regardless of log level.
function _warnOnce(vid, msg, level = 'warn') {
    const key = `${vid}:${msg}`;
    if (_warnedVehicles.has(key)) return;
    _warnedVehicles.add(key);
    if (_warnedVehicles.size > 500) {
        _warnedVehicles.delete(_warnedVehicles.values().next().value);
    }
    (console[level] ?? console.warn)(`[Metro Live Map] Vehicle ${vid ?? '(unknown)'} — ${msg}`);
}

/**
 * Validate, snap, and apply a vehicle position update to the live marker.
 * @param {object} data  Raw GTFS-RT entity wrapping the vehicle position.
 * @param {maplibregl.Map} map MapLibre map instance.
 * @param {string} [feedUrl] Source WebSocket URL — used by feedStats to attribute
 *                           drops/accepts to a specific feed. Optional so callers
 *                           predating instrumentation continue to work.
 */
export function processAndUpdate(data, map, feedUrl) {
    const v = data.vehicle;
    const vid = v?.vehicle?.id ?? '(unknown)';

    // Position is required — without coordinates we have nothing to render.
    if (!v?.position) {
        _warnOnce(vid, 'dropped — no position in feed message');
        if (feedUrl) recordFeedDrop(feedUrl, 'noPosition');
        return;
    }

    const lat = v.position.latitude;
    const lng = v.position.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        _warnOnce(vid, `dropped — non-finite coordinates (lat=${lat}, lng=${lng})`);
        if (feedUrl) recordFeedDrop(feedUrl, 'nonFinite');
        return;
    }

    // Trip data is required as the marker key. Vehicles without it can't be
    // tracked. This is EXPECTED, high-volume, and benign — layover and
    // deadheading vehicles routinely report a position with no assigned trip
    // (~60/min on rail). Log at 'debug' (the noTripId counter carries the rate);
    // warn-level here flooded the console on every load.
    if (!v.trip?.tripId) {
        _warnOnce(vid, 'dropped — missing trip.tripId', 'debug');
        if (feedUrl) recordFeedDrop(feedUrl, 'noTripId');
        return;
    }

    // Defensive timestamp normalization: accept ms-since-epoch and convert to seconds.
    // Number() (vs parseInt) handles both numeric and string inputs without radix
    // concerns and preserves NaN for non-numeric values.
    let ts = Number(v.timestamp);
    if (Number.isFinite(ts)) ts = normalizeTimestamp(ts);
    if (!Number.isFinite(ts)) {
        _warnOnce(vid, `dropped — invalid timestamp (${v.timestamp})`);
        if (feedUrl) recordFeedDrop(feedUrl, 'invalidTs');
        return;
    }
    // Reject frames timestamped in the future beyond a small clock-skew grace
    // (FUTURE_TS_GRACE_MS in config.js). Without this gate, downstream age
    // checks (now - ts) go negative, freshness tiers collapse to 0, and the
    // marker happily DR-extrapolates a phantom train forward until the frame
    // ages out. Rider-visible: a vehicle appears further along its track than
    // it actually is.
    if (ts * 1000 > Date.now() + FUTURE_TS_GRACE_MS) {
        _warnOnce(vid, `dropped — timestamp in future (ts=${ts})`);
        if (feedUrl) recordFeedDrop(feedUrl, 'futureTs');
        return;
    }

    // Speed sanity clamp: reject negative or implausibly fast values so legend
    // averages and downstream filters stay sane. Single source of truth lives in
    // config.js (MAX_PLAUSIBLE_SPEED_MPS) so it cannot drift away from the
    // spike-rejection threshold downstream.
    let speed = Number(v.position.speed);
    if (!Number.isFinite(speed) || speed < 0) speed = 0;
    else if (speed > MAX_PLAUSIBLE_SPEED_MPS) speed = MAX_PLAUSIBLE_SPEED_MPS;

    const feature = {
        type: 'Feature',
        properties: {
            // All IDs String-cast at the boundary. The GTFS-RT proto declares
            // these as strings, but feed implementations occasionally emit
            // numerics; downstream code (markers.js, predictions.js, stations.js,
            // tripUpdates.js) does strict-equality lookups (vehicleId === a.vehicleId,
            // tripId === entry.tripId, stopId === expected) and on cross-feed
            // paths the trip_updates side IS String-cast (tripUpdates.js:196-197).
            // Without the same cast here, a number-vs-string mismatch would
            // silently drop matches across the two feeds — exactly the kind of
            // bug the route_code cast below already guards against for bus IDs.
            vehicle_id:           v.vehicle?.id != null ? String(v.vehicle.id) : null,
            currentStatus:        v.currentStatus ?? null,
            currentStopSequence:  v.currentStopSequence ?? null,
            stopId:               v.stopId != null ? String(v.stopId) : null,
            timestamp:            ts,
            // route_code String-cast covers the 910/950 bus-vs-rail dispatch:
            // utils.isBusRoute does `routeCode === '910'`, which would silently
            // route the whole bus fleet through rail physics if the feed ever
            // sent a numeric route_code.
            route_code:           data.route_code != null ? String(data.route_code) : null,
            trip_id:              v.trip.tripId != null ? String(v.trip.tripId) : null,
            direction_id:         v.trip.directionId != null ? Number(v.trip.directionId) : null,
            position_bearing:     v.position.bearing ?? null,
            position_speed:       speed,
            position_latitude:    lat,
            position_longitude:   lng,
        },
        geometry: { type: 'Point', coordinates: [lng, lat] }
    };

    try {
        const features = [feature];
        processVehicleData({ features }, map);
        if (feedUrl) recordAccepted(feedUrl);
        updateUpdateTime();
    } catch (e) {
        console.error('[api] Error processing vehicle update:', e, feature.properties);
    }
}

/**
 * Open a Metro GTFS-RT vehicle-positions WebSocket feed and begin routing updates
 * through processVehicleData. Automatically reconnects with exponential backoff on
 * close, and uses a 60-second inbound watchdog to detect half-dead connections.
 * @param {string} url     WebSocket endpoint URL
 * @param {maplibregl.Map} map MapLibre map instance
 * @param {number} [_attempt=0] Internal reconnect attempt counter
 */
export function setupWebSocket(url, map, _attempt = 0) {
    const socket = new WebSocket(url);
    let pingInterval;
    let watchdogInterval;
    let periodicReconnectTimer;
    let currentAttempt = _attempt;
    socket._lastMessageAt = Date.now();

    socket.onopen = () => {
        currentAttempt = 0; // successful connection resets backoff
        setConnectionStatus('connected');
        socket._lastMessageAt = Date.now();
        _activeSockets.set(url, socket);
        // Metro WS server expects a text-frame "ping" (not an RFC 6455 protocol ping).
        // Confirmed from the official LACMTA/livemap repo — same pattern in production.
        pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send('ping');
        }, 30000);
        // Inbound watchdog: if no message arrives within WS_INBOUND_TIMEOUT_MS,
        // assume the connection is half-dead and force-close to trigger reconnect.
        // Vehicle position updates from Metro arrive at sub-30s cadence under
        // normal load, so 60s of total silence is a reliable dead-connection signal.
        watchdogInterval = setInterval(() => {
            if (Date.now() - socket._lastMessageAt > WS_INBOUND_TIMEOUT_MS
                && socket.readyState === WebSocket.OPEN) {
                console.warn(`[api] WebSocket ${url} silent for >${WS_INBOUND_TIMEOUT_MS/1000}s — forcing reconnect`);
                socket._deliberateReconnect = true;
                socket.close();
            }
        }, WS_WATCHDOG_INTERVAL_MS);
        // Periodic snapshot refresh: force a clean reconnect every
        // ~WS_PERIODIC_RECONNECT_MS so Metro re-sends its current snapshot.
        // Without this, a long-running session whose connection has stayed
        // "live" can drift from real state — Metro's WS only sends a snapshot
        // on initial connect, so vehicles that updated during a transient gap
        // (too short to trip the 60s watchdog) never recover until refresh.
        // Jittered ±half-window so rail + bus + trip_updates feeds don't all
        // reconnect at the same instant. Uses the same _deliberateReconnect
        // flag as the watchdog → fast reconnect (WS_FAST_RECONNECT_MS) with no
        // exponential backoff and no connection-status flicker. The flag-set
        // is idempotent so a near-simultaneous watchdog fire is harmless.
        const _jitter = (Math.random() - 0.5) * WS_PERIODIC_RECONNECT_JITTER_MS;
        periodicReconnectTimer = setTimeout(() => {
            if (socket.readyState === WebSocket.OPEN) {
                console.info(`[api] periodic reconnect — ${url}`);
                socket._deliberateReconnect = true;
                socket.close();
            }
        }, WS_PERIODIC_RECONNECT_MS + _jitter);
    };

    socket.onerror = (err) => console.error('WebSocket error:', err);

    socket.onclose = () => {
        clearInterval(pingInterval);
        clearInterval(watchdogInterval);
        clearTimeout(periodicReconnectTimer);
        _connectedSockets.delete(url);
        _activeSockets.delete(url);
        // Don't flash "offline" on a deliberate reconnect — we know the
        // network is healthy and the gap is sub-second. Only show offline
        // when an unexpected close drops us to zero live sockets.
        if (_connectedSockets.size === 0 && !socket._deliberateReconnect) {
            setConnectionStatus('offline');
        }
        // Skip if a reconnect is already in flight for this URL — the spec
        // says onclose fires once per socket, but the guard is defensive
        // against any future path that could trigger a redundant schedule.
        if (_pendingReconnects.has(url)) return;
        // Deliberate watchdog/periodic close: the network is fine, the server
        // just stopped sending or we're rotating for a fresh snapshot. Skip
        // the exponential backoff and reconnect fast.
        const _wasDeliberate = !!socket._deliberateReconnect;
        const delay = _wasDeliberate
            ? WS_FAST_RECONNECT_MS
            : wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        const nextAttempt = _wasDeliberate ? 0 : currentAttempt + 1;
        const timerId = setTimeout(() => {
            _pendingReconnects.delete(url);
            // Suppress the "connecting" status flicker on deliberate
            // reconnects — they happen every ~5 min in steady state and
            // would otherwise produce a visible status blip with no
            // user-meaningful event behind it.
            if (!_wasDeliberate) setConnectionStatus('connecting');
            setupWebSocket(url, map, nextAttempt);
        }, delay);
        _pendingReconnects.set(url, timerId);
    };

    socket.onmessage = (event) => {
        socket._lastMessageAt = Date.now();
        try {
            const data = JSON.parse(event.data);
            recordReceived(url);

            if (document.hidden) {
                // Metro frequently omits vehicle.id — fall back to tripId so vehicles
                // without an id are buffered and replayed on tab restore rather than dropped.
                const vid = data.vehicle?.vehicle?.id ?? data.vehicle?.trip?.tripId;
                if (vid != null) {
                    const key = String(vid);
                    // Bounded buffer with LRU-by-update-recency eviction. Map
                    // preserves first-insertion order, so a plain re-`set` on
                    // an existing key leaves the entry at its original position
                    // in the iteration order. That's wrong for our purpose: an
                    // active vehicle whose FIRST hidden-tab frame queued early
                    // would otherwise be the eviction target on overflow even
                    // though its latest update just landed. Delete-then-set
                    // moves the key to the tail so the oldest-touched vehicle
                    // is dropped instead — preserving fresh data for vehicles
                    // that are still receiving updates.
                    if (_pendingByVehicle.has(key)) {
                        _pendingByVehicle.delete(key);
                    } else if (_pendingByVehicle.size >= PENDING_VEHICLE_CAP) {
                        const oldest = _pendingByVehicle.keys().next().value;
                        if (oldest !== undefined) _pendingByVehicle.delete(oldest);
                    }
                    // Tag with the wall-clock ingest time so drainPending can
                    // skip entries that aged past FRESH_EXPIRE_S during a long
                    // hidden-tab session (saves a processAndUpdate call that
                    // would be rejected at the freshness gate anyway).
                    _pendingByVehicle.set(key, { data, url, queuedAtMs: Date.now() });
                }
            } else {
                processAndUpdate(data, map, url);
            }

            if (!_connectedSockets.has(url)) {
                _connectedSockets.add(url);
                if (_connectedSockets.size === 2) {
                    setTimeout(() => removeLoadingScreen(), 600);
                }
            }
            if (!_globalLoadingTimeout) {
                _globalLoadingTimeout = setTimeout(() => {
                    removeLoadingScreen();
                    _globalLoadingTimeout = null;
                }, 15000);
            }
        } catch (e) {
            // SyntaxError = malformed JSON frame. Demote to debug instead of
            // discarding silently so devtools can still surface feed corruption
            // when the user explicitly enables verbose logging.
            // Also bump the feed-stats counter so persistent malformed frames
            // surface as measurable signal in the per-minute report, not just
            // as log spam (audit finding).
            if (e instanceof SyntaxError) {
                console.debug('[api] Malformed JSON frame from', url);
                recordFeedDrop(url, 'jsonParse');
            } else {
                console.warn('[api] WebSocket message error:', e);
            }
        }
    };
}

// Safari < 16 and some older browsers lack requestIdleCallback.
const _rIC = typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 1);

function drainPending(entries, map, start, ctx) {
    const end = Math.min(start + 25, entries.length);
    const freshnessCutoffMs = Date.now() - (FRESH_EXPIRE_S * 1000);
    for (let i = start; i < end; i++) {
        // Skip entries queued more than FRESH_EXPIRE_S ago — processAndUpdate
        // would reject them at the freshness gate downstream. Saves the call,
        // and (paired with the buffer cap above) bounds the visibility-restore
        // stall when a tab has been hidden for hours.
        if ((entries[i].queuedAtMs ?? freshnessCutoffMs) < freshnessCutoffMs) {
            ctx.skipped = (ctx.skipped ?? 0) + 1;
            continue;
        }
        processAndUpdate(entries[i].data, map, entries[i].url);
    }
    ctx.batches++;
    if (end < entries.length) {
        _rIC(() => drainPending(entries, map, end, ctx));
    } else {
        const skipped = ctx.skipped ? ` (skipped ${ctx.skipped} stale)` : '';
        console.info(`[visibility] restore: ${entries.length} buffered (drained ${Date.now() - ctx.startedAt}ms across ${ctx.batches} batches)${skipped}`);
    }
}

/**
 * Register a visibilitychange listener that drains buffered vehicle updates
 * (queued while the tab was hidden) and force-reconnects any WebSocket that
 * has been silent longer than WS_VISIBILITY_STALE_MS.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export function initVisibilityHandler(map) {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;

        // 1. Drain anything buffered while hidden. (No-drain case is silent —
        // the `[visibility] restore:` log only fires when there's real work.)
        if (_pendingByVehicle.size > 0) {
            const entries = [..._pendingByVehicle.values()];
            _pendingByVehicle.clear();
            drainPending(entries, map, 0, { startedAt: Date.now(), batches: 0 });
        }

        // 2. Immediately health-check every active socket. If any has been
        // silent past the visibility threshold, force-reconnect now instead
        // of waiting for the next watchdog tick (up to 15s away).
        const now = Date.now();
        for (const [url, sock] of _activeSockets) {
            if (now - sock._lastMessageAt > WS_VISIBILITY_STALE_MS
                && sock.readyState === WebSocket.OPEN) {
                console.warn(`[api] Visibility restore: ${url} silent for >${WS_VISIBILITY_STALE_MS/1000}s — forcing reconnect`);
                sock._deliberateReconnect = true;
                sock.close();
            }
        }
    });
}
