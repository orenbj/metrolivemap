/**
 * @module main
 * Entry point for Metro Live Map. Bootstraps the map, loads static data in
 * parallel, opens WebSocket feeds for vehicle positions and trip updates, and
 * initialises all feature modules (stations, bike share, micro zones, alerts).
 */

import { initMap, getUserLocation } from './map.js';
import { initUI } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes } from './snap.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup, reAddStationLayer, initBoardingBadges } from './stations.js';
import { initBusBridges } from './busBridges.js';
import { initPredictions } from './predictions.js';
import { initBikeShare, reAddBikeLayer } from './bikeshare.js';
import { initAlerts } from './alerts.js';
import { initMicroZones, reAddMicroZonesLayer } from './microzones.js';
import { startFeedStatsReporter } from './feedStats.js';
import { fetchWithTimeout } from './utils.js';

// Load static data in parallel. Track per-source success so we can surface a
// banner if anything critical (predictions, shapes) failed entirely.
const _loadFailures = [];
const _loadJson = (path, label, fallback) =>
    fetchWithTimeout(path, 15000)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(err => { console.warn(`[${label}] Failed:`, err); _loadFailures.push(label); return fallback; });

const dataPromise = Promise.all([
    _loadJson('./data/stops.json',       'stops',      {}),
    _loadJson('./data/trips.json',       'trips',      {}),
    _loadJson('./data/bus-routes.json',  'bus-routes', {}),
    loadShapes().catch(err => { console.warn('[shapes] Failed:', err); _loadFailures.push('shapes'); }),
]);

// Initialize map immediately to start loading tiles
const map = initMap();
window.map = map;

initUI();

dataPromise.then(([stops, trips, busRoutes]) => {
    window.masterStopsData = stops;
    window.masterTripsData = trips;
    window.masterBusRoutes = busRoutes;
    initPredictions();

    initMarkerCleanup();
    setupWebSocket('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', map);
    setupWebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901', map);
    initTripUpdates();
    initAlerts();
    initVisibilityHandler(map);
    startFeedStatsReporter();

    if (_loadFailures.length) _showLoadFailureBanner(_loadFailures);
});

function _showLoadFailureBanner(failures) {
    if (document.getElementById('data-load-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'data-load-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#b22222;color:#fff;padding:8px 40px 8px 12px;font:14px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.3);';
    banner.textContent = `Some data failed to load (${failures.join(', ')}). Predictions and station data may be limited. Refresh to retry.`;
    const close = document.createElement('button');
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 8px;';
    close.addEventListener('click', () => banner.remove());
    banner.appendChild(close);
    document.body.appendChild(banner);
}

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
    dataPromise.then(() => {
        initStations(map);
        initBoardingBadges(map);
        initBusBridges(map);
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
    });
});
