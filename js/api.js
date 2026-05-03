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

function processAndUpdate(data, map) {
    if (!data.vehicle || !data.vehicle.trip) return;

    const v = data.vehicle;

    // Defensive timestamp normalization: accept ms-since-epoch and convert to seconds.
    let ts = parseInt(v.timestamp);
    if (Number.isFinite(ts) && ts > 10_000_000_000) ts = Math.floor(ts / 1000);

    // Speed sanity clamp: reject negative or implausibly fast values so legend
    // averages and downstream filters stay sane. Cap at 50 m/s (~110 mph).
    let speed = Number(v.position.speed);
    if (!Number.isFinite(speed) || speed < 0) speed = 0;
    else if (speed > 50) speed = 50;

    const feature = {
        type: 'Feature',
        properties: {
            vehicle_id: v.vehicle.id,
            currentStatus: v.currentStatus,
            currentStopSequence: v.currentStopSequence,
            stopId: v.stopId,
            timestamp: ts,
            route_code: data.route_code,
            trip_id: v.trip.tripId,
            direction_id: v.trip.directionId,
            position_bearing: v.position.bearing,
            position_speed: speed,
            position_latitude: v.position.latitude,
            position_longitude: v.position.longitude,
        },
        geometry: { type: 'Point', coordinates: [v.position.longitude, v.position.latitude] }
    };

    try {
        const features = [feature];
        processVehicleData({ features }, features, map);
        updateUpdateTime();
    } catch (e) {
        console.error('Error processing update', e);
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

export function initVisibilityHandler(map) {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && pendingByVehicle.size > 0) {
            pendingByVehicle.forEach(data => processAndUpdate(data, map));
            pendingByVehicle.clear();
        }
    });
}
