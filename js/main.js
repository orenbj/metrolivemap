/**
 * @module main
 * Entry point for Metro Live Map. Bootstraps the map, loads static data in
 * parallel, opens WebSocket feeds for vehicle positions and trip updates, and
 * initialises all feature modules (stations, bike share, micro zones, alerts).
 */

// Install the error boundary FIRST so failures during module init / data
// promise resolution are captured. installErrorBoundary() is idempotent and
// must not depend on any other module state.
import { installErrorBoundary } from './errorBoundary.js';
installErrorBoundary();

import { initMap, getUserLocation } from './map.js';
import { initUI, showToast, loadingDone } from './ui.js';
import { initMarkerCleanup } from './markers.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes, _clearShapeCache } from './snap.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup, reAddStationLayer, _rebuildStationGroups } from './stations.js';
import { initBoardingBadges } from './boardingBadges.js';
import { initBusBridges } from './busBridges.js';
import { initPredictions, _clearRouteStopsCache } from './predictions.js';
import { initBikeShare, reAddBikeLayer } from './bikeshare.js';
import { initAlerts, _clearStationIndexCache } from './alerts.js';
import { initAlertsPanel } from './alertsPanel.js';
import { initMicroZones, reAddMicroZonesLayer } from './microzones.js';
import { startFeedStatsReporter } from './feedStats.js';
import { fetchWithTimeout, setVisibleInterval, localISODate } from './utils.js';
import { SERVICE_DATE_CHECK_MS } from './config.js';
import { _preserveActiveTrips } from './serviceDate.js';

// Load static data in parallel. Track per-source success so we can surface a
// banner if anything critical (predictions, shapes) failed entirely.
const _loadFailures = [];
const _loadJson = (path, label, fallback) =>
    fetchWithTimeout(path, 15000)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .catch(err => { console.warn(`[${label}] Failed:`, err); _loadFailures.push(label); return fallback; });

// trips.json (4.7 MB) is fetched and parsed off-thread in a blob Worker so
// mobile devices don't freeze for 300-500 ms waiting for JSON.parse. The
// Worker posts { ok:1, d:<object> } on success or { ok:0 } on fetch error.
// Falls back to a main-thread load if the Worker API is unavailable.
// Intentionally excluded from dataPromise so WS feeds and map tiles are not
// gated on the slow parse — all callers already guard against a null/empty
// masterTripsData via optional-chaining or explicit guards.
function _loadTrips() {
    return new Promise(resolve => {
        try {
            const src = `self.onmessage=function(e){fetch(e.data).then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).then(d=>postMessage({ok:1,d:d})).catch(()=>postMessage({ok:0}));}`;
            const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            const w = new Worker(blobUrl);
            w.onmessage = e => {
                URL.revokeObjectURL(blobUrl);
                w.terminate();
                if (e.data.ok) {
                    resolve(e.data.d);
                } else {
                    console.warn('[trips] Worker fetch failed; predictions unavailable');
                    _loadFailures.push('trips');
                    resolve({});
                }
            };
            w.onerror = () => {
                URL.revokeObjectURL(blobUrl);
                w.terminate();
                _loadJson('./data/trips.json', 'trips', {}).then(resolve);
            };
            w.postMessage(new URL('./data/trips.json', location.href).href);
        } catch (_) {
            _loadJson('./data/trips.json', 'trips', {}).then(resolve);
        }
    });
}

// Fast path: stops (~955 KB) + bus-routes (15 KB) + shapes (191 KB) — gates
// WS connect and map init without waiting for trips.json (4.7 MB).
const dataPromise = Promise.all([
    _loadJson('./data/stops.json',       'stops',      {}),
    _loadJson('./data/bus-routes.json',  'bus-routes', {}),
    loadShapes().catch(err => { console.warn('[shapes] Failed:', err); _loadFailures.push('shapes'); }),
]);

// Trips load concurrently on its own timeline, parsed off-thread.
const _tripsPromise = _loadTrips();

// Initialize map immediately to start loading tiles
const map = initMap();
window.map = map;

// Page UI strings are plain English; riders who need translation use their
// browser's built-in translate flow.
initUI();

dataPromise.then(([stops, busRoutes]) => {
    window.masterStopsData = stops;
    window.masterBusRoutes = busRoutes;
    // initPredictions() is called from _tripsPromise.then() once trips.json is
    // available — all WS-frame call sites use optional chaining so they degrade
    // gracefully in the brief window before masterTripsData is populated.
    initMarkerCleanup();
    setupWebSocket('wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions', map);
    setupWebSocket('wss://api.metro.net/ws/LACMTA/vehicle_positions/910,901,950', map);
    initTripUpdates();
    initAlerts();
    initAlertsPanel();
    initVisibilityHandler(map);
    startFeedStatsReporter();

    if (_loadFailures.length) _showLoadFailureBanner(_loadFailures);
}).catch(err => console.error('[main] init failed:', err));

// Assign trips and prime the predictions cache once the off-thread parse finishes.
// This intentionally races with map.on('load'); whichever resolves first is fine:
//   • trips first → initStations's addBuswayStopsFromTrips() sees full data.
//   • map+stations first → map.on('load') schedules _rebuildStationGroups() below
//     so G/J Line busway stops are added retroactively.
_tripsPromise.then(trips => {
    window.masterTripsData = trips;
    initPredictions();
    if (_loadFailures.includes('trips')) _showLoadFailureBanner(_loadFailures);
}).catch(err => console.error('[main] init failed:', err));

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
        const openNearest = () => {
            const nearest = findNearestStation(coords.lng, coords.lat);
            if (nearest) openStationByGroup(map, nearest);
        };
        // Two gates before the popup may open:
        //   1. map `idle` — tiles fully loaded AND any in-flight animation
        //      (the flyTo above) done. `moveend` alone fires while tiles are
        //      still rasterizing, so the popup floated over a blank map.
        //   2. (startup only) `loadingDone` — the loading splash has been
        //      removed. The splash is torn down separately, gated on WS
        //      connect (api.js), which lands AFTER `dataPromise` resolves and
        //      autoLocate runs. Without this the popup renders over the
        //      still-visible loader (the recurring "Expo / La Brea" report).
        // The locate-button path (isStartup=false) skips gate 2 — the splash
        // is long gone by then, so the popup should open immediately.
        map.once('idle', () => {
            if (isStartup) loadingDone.then(openNearest);
            else openNearest();
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
    // Bikeshare and microzones fetch their own data independently.
    initBikeShare(map);
    initMicroZones(map);
    dataPromise.then(() => {
        initStations(map);
        initBoardingBadges(map);
        initBusBridges(map);
        autoLocate(true);
        // addBuswayStopsFromTrips() inside initStations guards against a null
        // masterTripsData and silently skips G/J Line stops if trips haven't
        // arrived yet. Schedule a rebuild for when they do.
        if (!window.masterTripsData) {
            _tripsPromise.then(() => _rebuildStationGroups(map));
        }
    });
});

// Gate on dataPromise so the popup never opens before stops are loaded.
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
        const oldTrips = window.masterTripsData ?? {};
        const [stops, trips, busRoutes] = await Promise.all([
            fetchWithTimeout('./data/stops.json',      15000).then(r => r.json()),
            fetchWithTimeout('./data/trips.json',      15000).then(r => r.json()),
            fetchWithTimeout('./data/bus-routes.json', 15000).then(r => r.json()),
        ]);
        // Preserve cross-midnight owl trips' static context — see helper doc.
        const preserved = _preserveActiveTrips(oldTrips, trips, window.vehicleMarkers ?? {});
        window.masterStopsData = stops;
        window.masterTripsData = trips;
        window.masterBusRoutes = busRoutes;
        const tag = preserved > 0 ? ` (preserved ${preserved} cross-midnight trips)` : '';
        console.info(`[main] reloaded GTFS data for new service date${tag}`);
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
    // every route until page reload — snap-to-polyline, the arc-glide, spike
    // rejection's arc-jump gate, and adherence offsets all degrade silently.
    loadShapes().catch(err => console.warn('[shapes] post-rollover reload failed:', err));
    _rebuildStationGroups(map);   // stations.js — rebuilds Array + map layer
    initPredictions();            // repopulate routeStops from new trips
});
