import { METROLINK_API_KEY, METROLINK_ROUTE_IDS } from './config.js';
import { processVehicleData } from './markers.js';
import { updateUpdateTime } from './ui.js';

const VEHICLES_URL = 'https://metrolink-gtfsrt.gbsdigital.us/extended/vehicles';
const POLL_INTERVAL_MS = 30000;

function normalizeEntity(entity) {
    const v = entity.vehicle;
    if (!v || !v.trip || !v.position) return null;

    const lat = parseFloat(v.position.latitude);
    const lng = parseFloat(v.position.longitude);
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;

    const routeCode = v.trip.routeId || '';
    if (!METROLINK_ROUTE_IDS.includes(routeCode)) return null;

    const vehicleId = v.vehicle?.label || v.vehicle?.id || entity.id || '';
    const timestamp = v.timestamp ? parseInt(v.timestamp) : Math.floor(Date.now() / 1000);
    const dirId = v.trip.directionId != null ? Number(v.trip.directionId) : null;

    return {
        type: 'Feature',
        properties: {
            vehicle_id: vehicleId,
            agency: 'metrolink',
            route_code: routeCode,
            trip_id: `ml_${v.trip.tripId || entity.id}`,
            direction_id: dirId,
            currentStatus: v.currentStatus,
            stopId: v.stopId || null,
            timestamp,
            position_bearing: v.position.bearing || 0,
            position_speed: v.position.speed || 0,
            position_latitude: lat,
            position_longitude: lng,
        },
        geometry: { type: 'Point', coordinates: [lng, lat] }
    };
}

async function pollFeed(map) {
    try {
        const res = await fetch(`${VEHICLES_URL}?t=${Date.now()}`, {
            headers: { 'X-Api-Key': METROLINK_API_KEY }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();

        // Extended API wraps entities in a FeedMessage envelope
        const entities = json?.entity || json?.entities || (Array.isArray(json) ? json : []);
        const features = entities.map(normalizeEntity).filter(Boolean);

        if (features.length > 0) {
            processVehicleData({ features }, features, map);
            updateUpdateTime();
        }
    } catch (err) {
        console.warn('[Metrolink] Poll failed:', err.message);
    }
}

export function initMetrolinkPolling(map) {
    pollFeed(map);
    setInterval(() => pollFeed(map), POLL_INTERVAL_MS);
}
