import { removeLoadingScreen, updateUpdateTime } from './ui.js';
import { processVehicleData } from './markers.js';

const connectedSockets = new Set();
let pendingData = null;
let globalLoadingTimeout = null;

function getFeaturesFromData(data) {
    let features = data?.features;
    if (!features) throw new Error('No features in API response');
    if (!Array.isArray(features)) features = Object.values(features);
    return features.filter(f => {
        const [lng, lat] = f.geometry.coordinates;
        return !isNaN(lng) && !isNaN(lat);
    });
}

function processAndUpdate(data, map) {
    if (!data.vehicle || !data.vehicle.trip) return;

    const v = data.vehicle;
    const feature = {
        type: 'Feature',
        properties: {
            vehicle_id: v.vehicle.id,
            currentStatus: v.currentStatus,
            currentStopSequence: v.currentStopSequence,
            stopId: v.stopId,
            timestamp: parseInt(v.timestamp),
            route_code: data.route_code,
            trip_id: v.trip.tripId,
            direction_id: v.trip.directionId,
            position_bearing: v.position.bearing,
            position_speed: v.position.speed,
            position_latitude: v.position.latitude,
            position_longitude: v.position.longitude,
        },
        geometry: { type: 'Point', coordinates: [v.position.longitude, v.position.latitude] }
    };

    try {
        const features = getFeaturesFromData({ type: 'FeatureCollection', features: [feature] });
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
        console.log('WebSocket opened:', url);
        pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send('ping');
        }, 30000);
    };

    socket.onerror = (err) => console.error('WebSocket error:', err);

    socket.onclose = () => {
        clearInterval(pingInterval);
        const jitter = 0.8 + Math.random() * 0.4;
        const delay = Math.min(5000 * Math.pow(2, currentAttempt), 300000) * jitter;
        console.log(`WebSocket closed — reconnecting in ${Math.round(delay / 1000)}s (attempt ${currentAttempt + 1}):`, url);
        setTimeout(() => setupWebSocket(url, map, currentAttempt + 1), delay);
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);

            if (document.hidden) {
                pendingData = data; // drain on visibility restore via initVisibilityHandler
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
                globalLoadingTimeout = setTimeout(removeLoadingScreen, 15000);
            }
        } catch (e) {
            // Heartbeat string 'pong' — safely ignored
        }
    };
}

export function initVisibilityHandler(map) {
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && pendingData) {
            processAndUpdate(pendingData, map);
            pendingData = null;
        }
    });
}
