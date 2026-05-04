import { initMap, getUserLocation } from './map.js';
import { initUI } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes } from './snap.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup, reAddStationLayer } from './stations.js';
import { initPredictions } from './predictions.js';
import { initBikeShare, reAddBikeLayer } from './bikeshare.js';
import { initAlerts } from './alerts.js';
import { initMicroZones, reAddMicroZonesLayer } from './microzones.js';
import { initFlyaway, reAddFlyawayLayer } from './flyaway.js';

// Load static data in parallel
const dataPromise = Promise.all([
    fetch('./data/stops.json').then(r => r.json()).catch(err => { console.warn('[stops] Failed:', err); return {}; }),
    fetch('./data/trips.json').then(r => r.json()).catch(err => { console.warn('[trips] Failed:', err); return {}; }),
    loadShapes(),
]);

// Initialize map immediately to start loading tiles
const map = initMap();
window.map = map;

initUI();

dataPromise.then(([stops, trips]) => {
    window.masterStopsData = stops;
    window.masterTripsData = trips;
    initPredictions();

    initMarkerCleanup();
    setupWebSocket('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', map);
    setupWebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901', map);
    initTripUpdates();
    initAlerts();
    initVisibilityHandler(map);
});

function autoLocate(isStartup = false) {
    getUserLocation().then(coords => {
        map.flyTo({ center: [coords.lng, coords.lat], zoom: 14 });
        map.once('moveend', () => {
            const nearest = findNearestStation(coords.lng, coords.lat);
            if (nearest) openStationByGroup(map, nearest);
        });
    }).catch(() => {
        if (!isStartup) alert('Could not determine your location. Please check your browser permissions.');
    });
}

map.on('load', () => {
    // Bikeshare and microzones fetch their own data — start immediately, don't
    // block on trips.json (3.8 MB). Stations and autoLocate need masterStopsData.
    initBikeShare(map);
    initMicroZones(map);
    initFlyaway(map);       // fetches its own data; no dataPromise dependency
    dataPromise.then(() => {
        initStations(map);
        autoLocate(true);
    });
});

document.addEventListener('requestAutoLocate', () => autoLocate(false));

// Re-add custom sources/layers after every dark mode style swap
document.addEventListener('toggleDarkMode', () => {
    map.once('style.load', () => {
        reAddStationLayer(map);
        reAddBikeLayer(map);
        reAddMicroZonesLayer(map);
        reAddFlyawayLayer(map);
    });
});
