import { initMap } from './map.js';
import { initUI } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes } from './snap.js';
// Metrolink disabled — see worker/metrolink-proxy.js & js/metrolink.js for future use

// Load stop name data asynchronously (used by popups and heading logic via window.masterStopsData)
fetch('./js/stops.json')
    .then(r => r.json())
    .then(data => { window.masterStopsData = data; })
    .catch(err => console.warn('[stops] Failed to load stops.json:', err));

// Initialize the MapLibre instance
const map = initMap();

// Initialize the UI (legend interactions, resizing)
initUI();

// Start the stale marker cleanup loop
initMarkerCleanup();

// Pre-load GTFS shape data for snapping (runs async, ready before first WS update in practice)
loadShapes();

// Start the WebSocket connections for LA Metro
setupWebSocket('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', map);
setupWebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901', map);

// Metrolink polling disabled — re-enable when proxy + stop data are ready
// import { initMetrolinkPolling } from './metrolink.js';
// initMetrolinkPolling(map);

// Handle visibility state for pending updates
initVisibilityHandler(map);

