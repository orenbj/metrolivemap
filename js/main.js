/**
 * @module main
 * Entry point for Metro Live Map. Bootstraps the map, loads static data in
 * parallel, opens WebSocket feeds for vehicle positions and trip updates, and
 * initialises all feature modules (stations, bike share, micro zones, alerts).
 */

import { initMap, getUserLocation } from './map.js';
import { initUI, showToast } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes, _clearShapeCache } from './snap.js';
import { loadIntersections } from './intersections.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup, reAddStationLayer, initBoardingBadges, _rebuildStationGroups } from './stations.js';
import { initBusBridges } from './busBridges.js';
import { initPredictions, _clearRouteStopsCache } from './predictions.js';
import { initBikeShare, reAddBikeLayer } from './bikeshare.js';
import { initAlerts, _clearStationIndexCache } from './alerts.js';
import { initAlertsPanel } from './alertsPanel.js';
import { initMicroZones, reAddMicroZonesLayer } from './microzones.js';
import { startFeedStatsReporter } from './feedStats.js';
import { fetchWithTimeout, setVisibleInterval, localISODate } from './utils.js';
import { SERVICE_DATE_CHECK_MS } from './config.js';

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
    loadIntersections(),  // fail-open: isNearIntersection returns false if this fails
]);

// Initialize map immediately to start loading tiles
const map = initMap();
window.map = map;

// Page UI strings are plain English; riders who need translation use their
// browser's built-in translate flow.
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
    initAlertsPanel();
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
    }).catch(err => {
        if (isStartup) return;
        // GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        let msg = 'Could not determine your location.';
        if (err?.code === 1)      msg = 'Location access was denied. Enable it in your browser settings to use this feature.';
        else if (err?.code === 2) msg = 'Location unavailable. Check that location services are on and try again.';
        else if (err?.code === 3) msg = 'Location request timed out. Try again with a stronger GPS signal.';
        showToast(msg, { severity: 'error', duration: 5000 });
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

// Gate on dataPromise so the popup never opens before stops/trips are loaded.
// If data is already resolved (typical case — user clicks after page settles),
// the .then() fires synchronously on the next microtask with no perceptible delay.
document.addEventListener('requestAutoLocate', () => dataPromise.then(() => autoLocate(false)));

// Re-add custom sources/layers after every dark mode style swap
document.addEventListener('toggleDarkMode', () => {
    map.once('style.load', () => {
        reAddStationLayer(map);
        reAddBikeLayer(map);
        reAddMicroZonesLayer(map);
    });
});

// ── Midnight service-date rollover ────────────────────────────────────────────
// GTFS data (stops/trips/bus-routes) is keyed by service date. A user who
// opens the app at 11 PM and leaves it on overnight otherwise keeps seeing
// yesterday's pattern. Watcher checks once a minute; on date change, refetches
// the three JSON files and fires `gtfsDataReloaded` so derived caches clear.
// Local-midnight trigger. Metro's true service-day boundary is closer to
// 03:00, but the next-day schedule is published well before 00:00 and
// very few trips run between 00:00 and 03:00 — the difference is
// imperceptible in practice. The helper lives in utils.js so a side-effect-
// free unit test can pin the month-padding logic.
const _serviceDateKey = localISODate;
let _lastServiceDate = _serviceDateKey(new Date());

async function _reloadGtfsData() {
    // Match startup's load path — fetchWithTimeout so a hung CDN at
    // 00:01 doesn't leave the rollover promise pending forever. Returns
    // a boolean so the caller can advance `_lastServiceDate` only on
    // success; otherwise a single failed reload would burn the day's
    // retry window.
    try {
        const [stops, trips, busRoutes] = await Promise.all([
            fetchWithTimeout('./data/stops.json',      15000).then(r => r.json()),
            fetchWithTimeout('./data/trips.json',      15000).then(r => r.json()),
            fetchWithTimeout('./data/bus-routes.json', 15000).then(r => r.json()),
        ]);
        window.masterStopsData = stops;
        window.masterTripsData = trips;
        window.masterBusRoutes = busRoutes;
        console.info('[main] reloaded GTFS data for new service date');
        document.dispatchEvent(new CustomEvent('gtfsDataReloaded'));
        return true;
    } catch (err) {
        console.warn('[main] GTFS reload failed:', err);
        return false;
    }
}

setVisibleInterval(async () => {
    const today = _serviceDateKey(new Date());
    if (today === _lastServiceDate) return;
    // Only advance the pointer on successful reload. If the fetch fails,
    // leave _lastServiceDate at yesterday so the next check retries —
    // previously the pointer advanced before the await resolved, so a
    // single transient failure (CDN hiccup at 00:01) left the app on
    // yesterday's schedule for the rest of the day with no retry.
    if (await _reloadGtfsData()) _lastServiceDate = today;
}, SERVICE_DATE_CHECK_MS, 'main:service-date');

// Cache invalidation for every module that snapshots GTFS-derived state.
// Each clearer is safe to call when no cache has been built yet.
document.addEventListener('gtfsDataReloaded', () => {
    _clearRouteStopsCache();      // predictions.js — per-route stop sequences
    _clearStationIndexCache();    // alerts.js — station-name regex index
    _clearShapeCache();           // snap.js — wipes shapeData + arcLengths
    // _clearShapeCache nulls the load promise too, so loadShapes() above
    // will re-fetch. Without this kick, hasShapeData(rc) returns false for
    // every route until page reload — DR fallback, spike rejection's
    // arc-jump gate, and adherence offsets all degrade silently.
    loadShapes().catch(err => console.warn('[shapes] post-rollover reload failed:', err));
    _rebuildStationGroups(map);   // stations.js — rebuilds Array + map layer
    initPredictions();            // repopulate routeStops from new trips
});
