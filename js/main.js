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
import { initFollow, hasPendingRestore, isFollowActive } from './followVehicle.js';
import { setupWebSocket, initVisibilityHandler } from './api.js';
import { loadShapes, _clearShapeCache } from './snap.js';
import { initTripUpdates } from './tripUpdates.js';
import { initStations, findNearestStation, openStationByGroup, reAddStationLayer, _rebuildStationGroups } from './stations.js';
import { initBoardingBadges } from './boardingBadges.js';
import { initBusBridges } from './busBridges.js';
import { initPredictions, _clearRouteStopsCache } from './predictions.js';
import { initBikeShare, reAddBikeLayer } from './bikeshare.js';
import { initAlerts, _clearStationIndexCache } from './alerts.js';
import { initAlertsPanel, isAlertsPanelOpen } from './alertsPanel.js';
import { closeActivePopup } from './popups.js';
import { initMicroZones, reAddMicroZonesLayer } from './microzones.js';
import { startFeedStatsReporter, recordMarkerDrop } from './feedStats.js';
import { initPwaInstall } from './pwaInstall.js';
import { fetchWithTimeout, setVisibleInterval, localISODate } from './utils.js';
import { SERVICE_DATE_CHECK_MS, METRO_WS_FEEDS } from './config.js';
import { _preserveActiveTrips, _countMidnightTripIdMisses } from './serviceDate.js';

// Load static data in parallel. Track per-source success so we can surface a
// banner if anything critical (predictions, shapes) failed entirely.
const _loadFailures = [];
// Shared fetch+ok-check+parse core for both the startup and rollover JSON
// loaders below — they differ only in what happens on failure (startup
// swallows it and falls back; rollover lets it propagate so the whole
// Promise.all rejects), so only that difference is duplicated, not the fetch.
const _fetchJson = (path, timeoutMs) =>
    fetchWithTimeout(path, timeoutMs)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + path); return r.json(); });
const _loadJson = (path, label, fallback) =>
    _fetchJson(path, 15000)
        .catch(err => { console.warn(`[${label}] Failed:`, err); _loadFailures.push(label); return fallback; });

// trips.json (2.5 MB) is fetched and parsed off-thread in a blob Worker so
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

// Fast path: stops (~892 KB) + bus-routes (15 KB) + shapes (191 KB) — gates
// WS connect and map init without waiting for trips.json (2.5 MB).
const dataPromise = Promise.all([
    _loadJson('./data/stops.json',            'stops',            {}),
    _loadJson('./data/bus-routes.json',       'bus-routes',       {}),
    _loadJson('./data/bus-destinations.json', 'bus-destinations', {}),
    loadShapes().catch(err => { console.warn('[shapes] Failed:', err); _loadFailures.push('shapes'); }),
]);

// Trips load concurrently on its own timeline, parsed off-thread.
const _tripsPromise = _loadTrips();

// Initialize map immediately to start loading tiles. A synchronous throw here
// is almost always "this device/browser can't run WebGL" — MapLibre throws when
// it can't acquire a GL context (old hardware, WebGL disabled, headless). That's
// a SINGLE uncaught error, below the error boundary's 3-in-30s burst threshold,
// so without this catch the rider just stares at the loading splash forever and
// the rest of bootstrap (initUI, WS feeds) never runs. Replace the splash with a
// plain, actionable message instead.
let map;
try {
    map = initMap();
} catch (err) {
    console.error('[main] map init failed:', err);
    _showFatalBootError();
    throw err; // nothing downstream works without the map — stop bootstrap here
}
window.map = map;

// Pin-and-follow: lets the camera track a chosen vehicle (and restores a
// persisted follow across reload / PWA resume). Read-only w.r.t. the motion
// engine. Safe to init as soon as the map exists.
initFollow(map);

// Page UI strings are plain English; riders who need translation use their
// browser's built-in translate flow.
initUI();

dataPromise.then(([stops, busRoutes, busDestinations]) => {
    window.masterStopsData = stops;
    window.masterBusRoutes = busRoutes;
    window.masterBusDestinations = busDestinations;
    // initPredictions() is primed below once BOTH trips.json and stops/shapes
    // are loaded — all WS-frame call sites use optional chaining so they degrade
    // gracefully in the brief window before masterTripsData is populated.
    initMarkerCleanup();
    setupWebSocket(METRO_WS_FEEDS.RAIL_VP, map);
    setupWebSocket(METRO_WS_FEEDS.BUS_VP, map);
    initTripUpdates();
    initAlerts();
    initAlertsPanel();
    // Escape-to-close for map popups (vehicle / station / bike / micro). MapLibre
    // 5.24 does NOT close popups on Escape and none of the owners bound it, so the
    // × button was the only keyboard dismiss — inconsistent with the alerts panel
    // and alert tooltips, which do. The single-popup coordinator closes whichever
    // is active via its own teardown (focus restore, highlight clear). Skip when the
    // alerts panel is open: it owns its own Escape (+ focus trap) and would double-fire.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || isAlertsPanelOpen()) return;
        closeActivePopup();
    });
    initVisibilityHandler(map);
    startFeedStatsReporter();
    // Register the installability service worker and the "add to home screen"
    // banner. Independent of feed data — placed here only to share one init site.
    initPwaInstall();

    if (_loadFailures.length) _showLoadFailureBanner(_loadFailures);
}).catch(err => console.error('[main] init failed:', err));

// Assign trips and prime the predictions cache once the off-thread parse finishes.
// This intentionally races with map.on('load'); whichever resolves first is fine:
//   • trips first → initStations's addBuswayStopsFromTrips() sees full data.
//   • map+stations first → map.on('load') schedules _rebuildStationGroups() below
//     so G/J Line busway stops are added retroactively.
_tripsPromise.then(trips => {
    window.masterTripsData = trips;
    if (_loadFailures.includes('trips')) _showLoadFailureBanner(_loadFailures);
}).catch(err => console.error('[main] init failed:', err));

// Prime the predictions arc cache only once BOTH trips AND the stops/shapes it
// projects against are present. initPredictions() reads window.masterStopsData
// and snapToRoute (shapes) for every stop — if it ran on trips-resolved alone
// and trips happened to win the race with dataPromise (cache asymmetry, a retry
// on the larger stops fetch), every arcMeters entry would be null and arc
// reasoning (adherence, stop-lag, oriented jitter-hold) would be silently
// disabled for the whole session until the midnight rollover re-ran it. In the
// common case dataPromise (the fast path) is already resolved when trips land,
// so this adds no delay. masterTripsData is still assigned above as early as
// possible so addBuswayStopsFromTrips / map.on('load') timing is unchanged.
Promise.all([dataPromise, _tripsPromise]).then(() => {
    initPredictions();
}).catch(err => console.error('[main] initPredictions failed:', err));

// Fatal, unrecoverable boot failure (map could not initialize — almost always
// no WebGL). Replace the loading splash in place so the rider sees an actionable
// message instead of an eternal spinner. All strings are static — no feed data,
// no XSS surface. Falls back to a fresh fixed overlay if the splash is gone.
function _showFatalBootError() {
    let host = document.getElementById('loading');
    if (host) {
        host.innerHTML = '';
        host.removeAttribute('aria-busy');
    } else {
        host = document.createElement('div');
        host.id = 'loading';
        host.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:#fff;';
        document.body?.appendChild(host);
    }
    host.setAttribute('role', 'alert');
    host.setAttribute('aria-label', 'Map could not be loaded');

    const box = document.createElement('div');
    box.style.cssText = 'max-width:30rem;margin:auto;padding:24px;text-align:center;font:15px/1.6 system-ui,-apple-system,sans-serif;color:#231f20;';

    const h = document.createElement('h1');
    h.textContent = 'Map couldn’t load on this device';
    h.style.cssText = 'font-size:18px;margin:0 0 12px;';

    const p = document.createElement('p');
    p.textContent = 'The live map needs WebGL, which this browser or device isn’t providing. Try updating your browser, enabling hardware acceleration, or opening the map on another device.';
    p.style.cssText = 'margin:0 0 16px;';

    const a = document.createElement('a');
    a.href = 'https://www.metro.net/riding/maps/';
    a.textContent = 'View Metro system maps instead';
    a.rel = 'noopener';
    a.style.cssText = 'color:#0072ce;font-weight:600;';

    box.append(h, p, a);
    host.appendChild(box);
}

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

/**
 * Resolve whether geolocation permission is ALREADY granted, WITHOUT prompting.
 * Gates the startup auto-locate (audit D3) so the app never fires an unsolicited
 * permission prompt on page load. Resolves false when the Permissions API is
 * unavailable or the state isn't 'granted' — in both cases startup auto-locate
 * is skipped and the rider can still tap the Locate button (which prompts).
 * @returns {Promise<boolean>}
 */
async function _geoPermissionGranted() {
    try {
        if (!navigator.permissions?.query) return false;
        const status = await navigator.permissions.query({ name: 'geolocation' });
        return status.state === 'granted';
    } catch {
        return false;   // Permissions API unsupported / threw → don't auto-prompt
    }
}

function autoLocate(isStartup = false) {
    // On startup, if a follow is being restored OR already active (reload /
    // app-return), the follow module focuses the rider's vehicle + opens its
    // popup — so skip the nearest-station auto-locate entirely (no competing
    // popup, no whole-network view, no camera fight). Check isFollowActive() too,
    // not just hasPendingRestore(): the pending flag clears the moment the restore
    // acquires its marker, which routinely happens BEFORE this tile-gated startup
    // path runs (WS snapshot beats tile load), and then a stale-false pending flag
    // let auto-locate hijack the just-restored follow. If the vehicle turns out to
    // be gone, followVehicle re-dispatches 'requestAutoLocate' as a fallback.
    if (isStartup && (hasPendingRestore() || isFollowActive())) return;
    if (isStartup) {
        // Never fire an UNSOLICITED geolocation prompt on page load (audit D3):
        // only auto-locate when permission was ALREADY granted (a return visit).
        // Otherwise wait for an explicit Locate-button tap — the isStartup=false
        // path, a user gesture, which may prompt. _geoPermissionGranted never
        // prompts.
        _geoPermissionGranted().then(granted => { if (granted) _runAutoLocate(true); });
        return;
    }
    _runAutoLocate(false);
}

function _runAutoLocate(isStartup) {
    getUserLocation().then(coords => {
        // Taking over the camera — pause any active vehicle-follow.
        document.dispatchEvent(new CustomEvent('mlm:camera-takeover'));
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
    // Bikeshare and microzones fetch their own data independently. They're async
    // and fire-and-forget here, so surface any rejection (a failed GBFS/zone fetch
    // past their internal guards would otherwise vanish as an unhandled rejection
    // and the layer would silently never appear).
    initBikeShare(map).catch(err => console.warn('[main] bikeshare init failed:', err));
    initMicroZones(map).catch(err => console.warn('[main] micro-zones init failed:', err));
    dataPromise.then(() => {
        initStations(map);
        initBoardingBadges(map);
        initBusBridges(map);
        // Re-add our custom layers after EVERY future basemap style swap (dark-mode
        // toggle). Registered ONCE here as a PERSISTENT handler — not per-toggle.
        // The old per-event `map.once('style.load')` broke on a rapid double-toggle:
        // both once-handlers were consumed by the FIRST style.load, so the FINAL
        // style had no re-add and the station / micro-zone layers vanished until the
        // next toggle. A persistent handler fires on every style.load including the
        // final one; the re-adds are idempotent (getSource/getLayer guards). map.js
        // handles its own basemap layers + the pendingDark chaining separately.
        map.on('style.load', () => {
            reAddStationLayer(map);
            reAddBikeLayer(map);
            reAddMicroZonesLayer(map);
        });
        autoLocate(true);
        // addBuswayStopsFromTrips() inside initStations guards against a null
        // masterTripsData and silently skips G/J Line stops if trips haven't
        // arrived yet. Schedule a rebuild for when they do.
        if (!window.masterTripsData) {
            _tripsPromise.then(() => _rebuildStationGroups(map))
                .catch(err => console.error('[main] station-group rebuild failed:', err));
        }
    }).catch(err => console.error('[main] data-promise init chain failed:', err));
});

// Gate on dataPromise so the popup never opens before stops are loaded.
// If data is already resolved (typical case), the .then() fires on the next
// microtask with no perceptible delay. This fires from followVehicle's
// _endFollow when a persisted follow can't reacquire its vehicle — a fallback
// reaction, NOT a user gesture — so it must NEVER prompt for geolocation
// (audit D3). Gate on already-granted permission; on a fresh grant the failed
// restore just ends quietly. _runAutoLocate(false) is right here (no loadingDone
// splash gate — the splash is long gone by the time a restore times out).
document.addEventListener('requestAutoLocate', () => dataPromise.then(async () => {
    if (await _geoPermissionGranted()) _runAutoLocate(false);
}));

// (Custom-layer re-add after a dark-mode style swap is registered as a single
// persistent map.on('style.load') handler inside map.on('load') above — see the
// comment there for why a per-toggle map.once() broke on rapid double-toggles.)

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
        // Guard r.ok like the startup _loadJson path: a non-2xx whose body happens
        // to parse as JSON (a proxy/captive-portal/CDN error page emitting JSON)
        // would otherwise be swapped wholesale into masterStopsData/masterTripsData
        // at 00:01 and burn the day's retry window. Unlike _loadJson, no .catch here
        // — a thrown HTTP error propagates through Promise.all to the try/catch
        // below → return false → retry on the next tick.
        const [stops, trips, busRoutes, busDestinations] = await Promise.all([
            _fetchJson('./data/stops.json', 15000),
            _fetchJson('./data/trips.json', 15000),
            _fetchJson('./data/bus-routes.json', 15000),
            _fetchJson('./data/bus-destinations.json', 15000),
        ]);
        // Instrument the rollover race (#246, measure-first): how many live
        // vehicles ran on a new-day-only tripId during the pre-swap window?
        // Counted BEFORE preservation mutates `trips` — see helper doc.
        const missed = _countMidnightTripIdMisses(oldTrips, trips, window.vehicleMarkers ?? {});
        if (missed > 0) recordMarkerDrop('midnightTripIdMiss', missed);
        // Preserve cross-midnight owl trips' static context — see helper doc.
        const preserved = _preserveActiveTrips(oldTrips, trips, window.vehicleMarkers ?? {});
        window.masterStopsData = stops;
        window.masterTripsData = trips;
        window.masterBusRoutes = busRoutes;
        window.masterBusDestinations = busDestinations;
        const tag = (preserved > 0 ? ` (preserved ${preserved} cross-midnight trips)` : '')
                  + (missed    > 0 ? ` (${missed} vehicles hit the rollover tripId race)` : '');
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
document.addEventListener('gtfsDataReloaded', async () => {
    _clearRouteStopsCache();      // predictions.js — per-route stop sequences
    _clearStationIndexCache();    // alerts.js — station-name regex index
    _clearShapeCache();           // snap.js — wipes shapeData + arcLengths
    _rebuildStationGroups(map);   // stations.js — rebuilds Array + map layer
    // AWAIT the shape re-fetch before initPredictions. _clearShapeCache nulled
    // shapeData + the load promise, so loadShapes() re-fetches; without this kick
    // hasShapeData(rc) returns false for every route until page reload —
    // snap-to-polyline, the arc-glide, and adherence offsets all degrade. The
    // await matters because initPredictions computes each route-direction's arc
    // orientation (cache.arcAscending) by snapping stops to the polyline, which
    // needs shapes LOADED. Running it before the re-fetch resolved left
    // arcAscending unset until the next reload, so the arc-glide jitter-hold
    // reverted to its orientation-naive form and re-froze the decreasing-arc half
    // of the fleet for the rest of the service day. (Startup already orders this
    // correctly — shapes ~191 KB resolve before trips.json ~2.5 MB gates
    // initPredictions; this fixes only the post-midnight rollover.)
    await loadShapes().catch(err => console.warn('[shapes] post-rollover reload failed:', err));
    initPredictions();            // repopulate routeStops + arc orientation from new trips
});
