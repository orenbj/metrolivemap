import { initMap, getUserLocation } from './map.js';
import { initUI } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes, precomputeStationArcs } from './snap.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup } from './stations.js';

// Load static data in parallel
const dataPromise = Promise.all([
    fetch('./data/stops.json').then(r => r.json()).catch(err => { console.warn('[stops] Failed:', err); return {}; }),
    fetch('./data/trips.json').then(r => r.json()).catch(err => { console.warn('[trips] Failed:', err); return {}; }),
    loadShapes()
]);

// Initialize the MapLibre instance immediately to start loading tiles
const map = initMap();
window.map = map;

// Initialize the UI (legend interactions, resizing)
initUI();

// Wait for core data before connecting live feeds
dataPromise.then(([stops, trips, _]) => {
    window.masterStopsData = stops;
    window.masterTripsData = trips;

    // Now that stops + trips + shapes are all in memory, pre-snap every station
    // served by each route to that route's polyline. This gives predictions.js
    // O(1) access to true along-track distance for every (route, stop) pair.
    // Isolated in try-catch so a geometry failure doesn't abort WebSocket setup.
    try {
        precomputeStationArcs(stops, trips);
    } catch (err) {
        console.error('[snap] precomputeStationArcs failed — falling back to planar distance:', err);
    }

    // Start the stale marker cleanup loop
    initMarkerCleanup();

    // Start the WebSocket connections for LA Metro
    setupWebSocket('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', map);
    setupWebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901', map);

    // Subscribe to GTFS-RT trip_updates for predicted station arrivals
    initTripUpdates();

    // Handle visibility state for pending updates
    initVisibilityHandler(map);
});

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

// Render station dots and click-to-arrivals popup (after map tiles loaded AND data ready)
map.on('load', () => {
    dataPromise.then(() => {
        initStations(map);
        // Trigger zero-tap auto-locate on startup
        autoLocate(true);
    });
});

// Listen for manual "Locate Me" button clicks
document.addEventListener('requestAutoLocate', () => autoLocate(false));
