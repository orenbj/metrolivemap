import { removeLoadingScreen, updateUpdateTime, setConnectionStatus } from './ui.js';
import { processVehicleData } from './markers.js';
import { WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS } from './config.js';
import { wsBackoffDelay } from './utils.js';

const connectedSockets = new Set();
// Active WebSockets keyed by URL — used by the visibility handler to immediately
// health-check every feed when the tab regains focus, and force-reconnect any
// that have gone silent. Each socket carries `_lastMessageAt` for liveness checks.
const activeSockets = new Map();
// Buffer the latest frame per vehicle while the tab is hidden so visibility
// restore replays the most recent position for every vehicle, not just the
// last one across all vehicles (which is what a scalar pendingData missed).
const pendingByVehicle = new Map();
let globalLoadingTimeout = null;

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
function _warnOnce(vid, msg) {
    const key = `${vid}:${msg}`;
    if (_warnedVehicles.has(key)) return;
    _warnedVehicles.add(key);
    console.warn(`[Metro Live Map] Vehicle ${vid ?? '(unknown)'} — ${msg}`);
}

function processAndUpdate(data, map) {
    const v = data.vehicle;
    const vid = v?.vehicle?.id ?? '(unknown)';

    // Position is required — without coordinates we have nothing to render.
    if (!v?.position) {
        _warnOnce(vid, 'dropped — no position in feed message');
        return;
    }

    const lat = v.position.latitude;
    const lng = v.position.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        _warnOnce(vid, `dropped — non-finite coordinates (lat=${lat}, lng=${lng})`);
        return;
    }

    // Trip data is required as the marker key. Vehicles without it can't be tracked.
    if (!v.trip?.tripId) {
        _warnOnce(vid, 'dropped — missing trip.tripId');
        return;
    }

    // Defensive timestamp normalization: accept ms-since-epoch and convert to seconds.
    let ts = parseInt(v.timestamp);
    if (Number.isFinite(ts) && ts > 10_000_000_000) ts = Math.floor(ts / 1000);
    if (!Number.isFinite(ts)) {
        _warnOnce(vid, `dropped — invalid timestamp (${v.timestamp})`);
        return;
    }

    // Speed sanity clamp: reject negative or implausibly fast values so legend
    // averages and downstream filters stay sane. Cap at 50 m/s (~110 mph).
    let speed = Number(v.position.speed);
    if (!Number.isFinite(speed) || speed < 0) speed = 0;
    else if (speed > 50) speed = 50;

    const feature = {
        type: 'Feature',
        properties: {
            vehicle_id:           v.vehicle?.id ?? null,
            currentStatus:        v.currentStatus ?? null,
            currentStopSequence:  v.currentStopSequence ?? null,
            stopId:               v.stopId ?? null,
            timestamp:            ts,
            route_code:           data.route_code ?? null,
            trip_id:              v.trip.tripId,
            direction_id:         v.trip.directionId ?? null,
            position_bearing:     v.position.bearing ?? null,
            position_speed:       speed,
            position_latitude:    lat,
            position_longitude:   lng,
        },
        geometry: { type: 'Point', coordinates: [lng, lat] }
    };

    try {
        const features = [feature];
        processVehicleData({ features }, features, map);
        updateUpdateTime();
    } catch (e) {
        console.error('[api] Error processing vehicle update:', e, feature.properties);
    }
}

export function setupWebSocket(url, map, _attempt = 0) {
    const socket = new WebSocket(url);
    let pingInterval;
    let watchdogInterval;
    let currentAttempt = _attempt;
    socket._lastMessageAt = Date.now();

    socket.onopen = () => {
        currentAttempt = 0; // successful connection resets backoff
        setConnectionStatus('connected');
        socket._lastMessageAt = Date.now();
        activeSockets.set(url, socket);
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
    };

    socket.onerror = (err) => console.error('WebSocket error:', err);

    socket.onclose = () => {
        clearInterval(pingInterval);
        clearInterval(watchdogInterval);
        connectedSockets.delete(url);
        activeSockets.delete(url);
        if (connectedSockets.size === 0) setConnectionStatus('offline');
        // Deliberate watchdog-triggered close: the network is fine, the server
        // just stopped sending. Skip the exponential backoff and reconnect fast.
        const delay = socket._deliberateReconnect
            ? WS_FAST_RECONNECT_MS
            : wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        const nextAttempt = socket._deliberateReconnect ? 0 : currentAttempt + 1;
        setTimeout(() => {
            setConnectionStatus('connecting');
            setupWebSocket(url, map, nextAttempt);
        }, delay);
    };

    socket.onmessage = (event) => {
        socket._lastMessageAt = Date.now();
        try {
            const data = JSON.parse(event.data);

            if (document.hidden) {
                const vid = data.vehicle?.vehicle?.id;
                if (vid != null) pendingByVehicle.set(String(vid), data);
            } else {
                processAndUpdate(data, map);
            }

            if (!connectedSockets.has(url)) {
                connectedSockets.add(url);
                if (connectedSockets.size === 2) {
                    setTimeout(() => removeLoadingScreen(), 600);
                }
            }
            if (!globalLoadingTimeout) {
                globalLoadingTimeout = setTimeout(() => {
                    removeLoadingScreen();
                    globalLoadingTimeout = null;
                }, 15000);
            }
        } catch (e) {
            if (!(e instanceof SyntaxError)) console.warn('[api] WebSocket message error:', e);
        }
    };
}

// Safari < 16 and some older browsers lack requestIdleCallback.
const rIC = typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 500 })
    : (fn) => setTimeout(fn, 1);

function drainPending(entries, map, start) {
    const end = Math.min(start + 25, entries.length);
    for (let i = start; i < end; i++) processAndUpdate(entries[i], map);
    if (end < entries.length) rIC(() => drainPending(entries, map, end));
}

export function initVisibilityHandler(map) {
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;

        // 1. Drain anything buffered while hidden.
        if (pendingByVehicle.size > 0) {
            const entries = [...pendingByVehicle.values()];
            pendingByVehicle.clear();
            drainPending(entries, map, 0);
        }

        // 2. Immediately health-check every active socket. If any has been
        // silent past the visibility threshold, force-reconnect now instead
        // of waiting for the next watchdog tick (up to 15s away).
        const now = Date.now();
        for (const [url, sock] of activeSockets) {
            if (now - sock._lastMessageAt > WS_VISIBILITY_STALE_MS
                && sock.readyState === WebSocket.OPEN) {
                console.warn(`[api] Visibility restore: ${url} silent for >${WS_VISIBILITY_STALE_MS/1000}s — forcing reconnect`);
                sock._deliberateReconnect = true;
                sock.close();
            }
        }
    });
}
