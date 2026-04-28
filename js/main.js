import { initMap } from './map.js';
import { initUI } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes } from './snap.js';
import { initMetrolinkPolling } from './metrolink.js';

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

// Start Metrolink polling (30s interval, REST JSON feed)
initMetrolinkPolling(map);

// Handle visibility state for pending updates
initVisibilityHandler(map);

