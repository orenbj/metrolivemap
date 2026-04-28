import { removeLoadingScreen, updateUpdateTime } from './ui.js';
import { processVehicleData } from './markers.js';

const connectedSockets = new Set();
let pendingData = null;
let isAnimating = false; // We can integrate this deeper if needed, for now just a boolean placeholder
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

export function setupWebSocket(url, map) {
    let socket = new WebSocket(url);
    let pingInterval;

    socket.onopen = () => {
        console.log('WebSocket opened:', url);
        pingInterval = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send('ping');
        }, 30000);
    };

    socket.onerror = (err) => console.error('WebSocket error:', err);

    socket.onclose = () => {
        console.log('WebSocket closed — reconnecting in 5s:', url);
        clearInterval(pingInterval);
        setTimeout(() => setupWebSocket(url, map), 5000);
    };

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // Notice: the dead code memory leak (dataStore) has been removed.

            if (isAnimating) {
                pendingData = data;
            } else if (!document.hidden) {
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
