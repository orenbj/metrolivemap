import { removeLoadingScreen, updateUpdateTime, setConnectionStatus } from './ui.js';
import { processVehicleData } from './markers.js';
import { WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS } from './config.js';
import { wsBackoffDelay } from './utils.js';

const connectedSockets = new Set();
// Buffer the latest frame per vehicle while the tab is hidden so visibility
// restore replays the most recent position for every vehicle, not just the
// last one across all vehicles (which is what a scalar pendingData missed).
const pendingByVehicle = new Map();
let globalLoadingTimeout = null;

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
    let socket = new WebSocket(url);
    let pingInterval;
    let currentAttempt = _attempt;

    socket.onopen = () => {
        currentAttempt = 0; // successful connection resets backoff
        setConnectionStatus('connected');
        // Metro WS server expects a text-frame "ping" (not an RFC 6455 protocol ping).
        // Confirmed from the official LACMTA/livemap repo — same pattern in production.
        pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send('ping');
        }, 30000);
    };

    socket.onerror = (err) => console.error('WebSocket error:', err);

    socket.onclose = () => {
        clearInterval(pingInterval);
        connectedSockets.delete(url);
        if (connectedSockets.size === 0) setConnectionStatus('offline');
        const delay = wsBackoffDelay(currentAttempt, WS_BASE_RECONNECT_MS, WS_MAX_RECONNECT_MS);
        setTimeout(() => {
            setConnectionStatus('connecting');
            setupWebSocket(url, map, currentAttempt + 1);
        }, delay);
    };

    socket.onmessage = (event) => {
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
        if (!document.hidden && pendingByVehicle.size > 0) {
            const entries = [...pendingByVehicle.values()];
            pendingByVehicle.clear();
            drainPending(entries, map, 0);
        }
    });
}
