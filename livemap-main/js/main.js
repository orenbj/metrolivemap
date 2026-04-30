import { initMap, getUserLocation } from './map.js';
import { initUI } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes } from './snap.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup } from './stations.js';

// Load stop name data asynchronously (used by popups and heading logic via window.masterStopsData)
fetch('./data/stops.json')
    .then(r => r.json())
    .then(data => { window.masterStopsData = data; })
    .catch(err => console.warn('[stops] Failed to load stops.json:', err));

// Load trip metadata (destination + stop sequence list) for popup enrichment and future snap accuracy
fetch('./data/trips.json')
    .then(r => r.json())
    .then(data => { window.masterTripsData = data; })
    .catch(err => console.warn('[trips] Failed to load trips.json:', err));

// Initialize the MapLibre instance
const map = initMap();
window.map = map;

// Initialize the UI (legend interactions, resizing)
initUI();

// Start the stale marker cleanup loop
initMarkerCleanup();

// Pre-load GTFS shape data for snapping (runs async, ready before first WS update in practice)
loadShapes();

// Start the WebSocket connections for LA Metro
setupWebSocket('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', map);
setupWebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901', map);

// Subscribe to GTFS-RT trip_updates for predicted station arrivals
initTripUpdates();

function autoLocate(isStartup = false) {
    getUserLocation().then(coords => {
        map.flyTo({ center: [coords.lng, coords.lat], zoom: 14 });
        map.once('moveend', () => {
            // Wait for both stationGroups AND real-time arrivals data to be ready
            const checkReady = setInterval(() => {
                const nearest = findNearestStation(coords.lng, coords.lat);
                const arrivalsReady = window.masterArrivalsData && window.masterArrivalsData.size > 0;
                
                if (nearest && arrivalsReady) {
                    clearInterval(checkReady);
                    openStationByGroup(map, nearest);
                }
            }, 500);
            // Timeout after 10s
            setTimeout(() => clearInterval(checkReady), 10000);
        });
    }).catch(err => {
        if (!isStartup) alert('Could not determine your location. Please check your browser permissions.');
    });
}

// Render station dots and click-to-arrivals popup (after map tiles loaded)
map.on('load', () => {
    initStations(map);
    // Trigger zero-tap auto-locate on startup
    autoLocate(true);
});

// Listen for manual "Locate Me" button clicks
document.addEventListener('requestAutoLocate', () => autoLocate(false));

// Handle visibility state for pending updates
initVisibilityHandler(map);
