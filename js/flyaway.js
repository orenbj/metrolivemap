/**
 * flyaway.js
 * LAX FlyAway bus tracker — Ride Systems / TransLoc public REST API.
 * Self-contained module following the bikeshare.js isolation pattern.
 *
 * Adds to the map:
 *   • Colored GeoJSON route polylines (built from MapPoints in each stop record)
 *   • HTML arrow markers per live vehicle (heading from Heading field, colored by route)
 *   • Click popup: route name, vehicle name, speed, on-route / delay status
 *
 * Vehicles stale > FLYAWAY_STALE_SEC fade to 0.4; removed at FLYAWAY_REMOVE_SEC.
 * reAddFlyawayLayer() re-registers the GeoJSON source+layer after dark-mode style swaps.
 */

import {
    FLYAWAY_API, FLYAWAY_SYSTEM,
    FLYAWAY_POLL_MS, FLYAWAY_STALE_SEC, FLYAWAY_REMOVE_SEC,
} from './config.js';
import { escHtml, setVisibleInterval } from './utils.js';

// ── MapLibre layer / source IDs ───────────────────────────────────────────────
const SOURCE_ID     = 'flyaway-routes';
const LAYER_ID      = 'flyaway-route-lines';
const MIN_ZOOM_LINE = 9;
const MIN_ZOOM_MARK = 10;

// ── Module state ──────────────────────────────────────────────────────────────
let _map          = null;
let _visible      = true;
let _routes       = {};          // routeId → { name, color }
let _routeGeoJSON = null;        // cached FeatureCollection for re-add after style swap
let _markers      = new Map();   // vehicleId → { marker, el, meta }
let _popup        = null;

// ── Public API ─────────────────────────────────────────────────────────────────

export async function initFlyaway(map) {
    _map = map;
    try {
        await _fetchRoutes();
        await _fetchStops();          // builds route polylines
        await _updateMarkers();       // first vehicle paint
    } catch (e) {
        console.warn('[flyaway] Init failed:', e);
        return;
    }

    setVisibleInterval(_updateMarkers, FLYAWAY_POLL_MS);

    // Hide/show markers with map zoom
    map.on('zoom', _applyZoomVisibility);

    // Visibility toggle from the hidden legend row
    const row = document.getElementById('flyaway-legend-row');
    if (row) {
        row.addEventListener('click', () => {
            _visible = !_visible;
            _applyVisibility();
        });
    }
}

/**
 * Re-register the GeoJSON source + layer after a dark-mode style swap.
 * HTML markers survive the swap automatically — no action needed for them.
 */
export function reAddFlyawayLayer(map) {
    _map = map;
    if (!_routeGeoJSON) return;
    _applyRouteLayer(_routeGeoJSON);
}

// ── Routes ────────────────────────────────────────────────────────────────────

async function _fetchRoutes() {
    const data = await _apiFetch('GetRoutes');
    const list = data?.routes ?? data?.d?.routes ?? data?.d ?? [];
    for (const r of list) {
        const id    = String(r.RouteID ?? r.routeId ?? '');
        const color = r.MapLineColor
            ? '#' + String(r.MapLineColor).replace(/^#/, '')
            : '#888888';
        _routes[id] = {
            name:  r.Description ?? r.description ?? `Route ${id}`,
            color,
        };
    }
}

// ── Stops / route polylines ───────────────────────────────────────────────────

async function _fetchStops() {
    const data = await _apiFetch('GetStops');
    const stops = data?.stops ?? data?.d?.stops ?? data?.d ?? [];
    if (!stops.length) return;

    // Group MapPoints by route, in stop order, to build continuous polylines.
    // Each stop's MapPoints array describes the path segment from that stop to the next.
    const routeSegments = {};   // routeId → [ [lng, lat], ... ]
    const routeSeenPts  = {};   // routeId → Set of "lng,lat" keys (dedup)

    for (const stop of stops) {
        const pts = stop.MapPoints ?? stop.mapPoints ?? [];
        if (!pts.length) continue;
        const routeId = String(stop.RouteID ?? stop.routeId ?? '');
        if (!routeSegments[routeId]) {
            routeSegments[routeId] = [];
            routeSeenPts[routeId]  = new Set();
        }
        for (const p of pts) {
            const lat = parseFloat(p.Lat ?? p.lat ?? p.Latitude ?? p.latitude ?? 0);
            const lng = parseFloat(p.Long ?? p.long ?? p.Longitude ?? p.longitude ?? 0);
            if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;
            const key = `${lng.toFixed(6)},${lat.toFixed(6)}`;
            if (!routeSeenPts[routeId].has(key)) {
                routeSeenPts[routeId].add(key);
                routeSegments[routeId].push([lng, lat]);
            }
        }
    }

    const features = Object.entries(routeSegments)
        .filter(([, coords]) => coords.length >= 2)
        .map(([routeId, coords]) => ({
            type: 'Feature',
            properties: {
                routeId,
                color: _routes[routeId]?.color ?? '#888888',
            },
            geometry: { type: 'LineString', coordinates: coords },
        }));

    if (!features.length) return;

    _routeGeoJSON = { type: 'FeatureCollection', features };
    _applyRouteLayer(_routeGeoJSON);
}

function _applyRouteLayer(geojson) {
    if (!_map) return;
    const src = _map.getSource(SOURCE_ID);
    if (src) {
        src.setData(geojson);
    } else {
        _map.addSource(SOURCE_ID, { type: 'geojson', data: geojson });
        _map.addLayer({
            id:      LAYER_ID,
            type:    'line',
            source:  SOURCE_ID,
            minzoom: MIN_ZOOM_LINE,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: {
                'line-color':   ['get', 'color'],
                'line-width':   2.5,
                'line-opacity': 0.65,
            },
        });
        if (!_visible) _map.setLayoutProperty(LAYER_ID, 'visibility', 'none');
    }
}

// ── Vehicle markers ───────────────────────────────────────────────────────────

async function _updateMarkers() {
    let data;
    try {
        data = await _apiFetch('GetMapVehiclePoints');
    } catch (e) {
        console.warn('[flyaway] Vehicle fetch failed:', e);
        return;
    }

    const vehicles = data?.vehiclepoints
        ?? data?.VehiclePoints
        ?? data?.d?.vehiclepoints
        ?? data?.d
        ?? [];

    const seen = new Set();
    const zoom = _map?.getZoom() ?? 0;

    for (const v of vehicles) {
        const id = String(v.VehicleID ?? v.vehicleId ?? v.ID ?? '');
        if (!id) continue;
        seen.add(id);

        const lat      = parseFloat(v.Latitude  ?? v.lat ?? 0);
        const lng      = parseFloat(v.Longitude ?? v.Long ?? v.lon ?? 0);
        const heading  = parseFloat(v.Heading   ?? v.heading ?? 0);
        const staleSec = parseFloat(v.Seconds   ?? v.seconds ?? 0);
        const routeId  = String(v.RouteID ?? v.routeId ?? '');
        const name     = String(v.Name ?? v.VehicleName ?? v.name ?? id);
        const speed    = parseFloat(v.GroundSpeed ?? v.groundSpeed ?? v.speed ?? 0);
        const onRoute  = v.IsOnRoute !== false && v.IsOnRoute !== 0;
        const delayed  = !!(v.IsDelayed ?? v.isDelayed);
        const color    = _routes[routeId]?.color ?? '#888888';
        const routeName = _routes[routeId]?.name ?? `Route ${routeId}`;

        if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;

        // Drop vehicles that have gone very stale
        if (staleSec > FLYAWAY_REMOVE_SEC) {
            _removeMarker(id);
            continue;
        }

        const opacity = staleSec > FLYAWAY_STALE_SEC ? 0.4 : 1.0;
        const meta = { name, routeName, speed, onRoute, delayed, routeId };

        if (_markers.has(id)) {
            const { marker, el } = _markers.get(id);
            marker.setLngLat([lng, lat]);
            _applyMarkerStyle(el, color, heading, opacity);
            _markers.get(id).meta = meta;
        } else {
            const el = _makeMarkerEl(color, heading, opacity);
            const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat([lng, lat])
                .addTo(_map);

            el.addEventListener('click', (evt) => {
                evt.stopPropagation();
                const { meta: m } = _markers.get(id) ?? {};
                if (m) _openPopup(lng, lat, m);
            });

            _markers.set(id, { marker, el, meta });
        }

        // Apply current visibility / zoom state to newly created or existing marker
        const m = _markers.get(id);
        m.el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
    }

    // Remove markers for vehicles no longer in feed
    for (const id of [..._markers.keys()]) {
        if (!seen.has(id)) _removeMarker(id);
    }
}

// ── Marker helpers ────────────────────────────────────────────────────────────

function _makeMarkerEl(color, heading, opacity) {
    const el = document.createElement('div');
    el.className = 'flyaway-marker';
    _applyMarkerStyle(el, color, heading, opacity);
    return el;
}

function _applyMarkerStyle(el, color, heading, opacity) {
    el.innerHTML = _busSvg(color);
    el.style.opacity   = opacity;
    el.style.transform = `rotate(${heading}deg)`;
}

function _busSvg(color) {
    // Square bus arrow matching G/J busway marker style in markers.js
    const c = String(color).replace(/[^#a-fA-F0-9]/g, '') || '888888';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="28" height="28">
        <rect x="4" y="4" width="42" height="42" rx="5" fill="${c}" stroke="#ffffff" stroke-width="4"/>
        <path d="M 25 11 L 35 34 L 25 27 L 15 34 Z" fill="#ffffff"/>
    </svg>`;
}

function _removeMarker(id) {
    const m = _markers.get(id);
    if (!m) return;
    m.marker.remove();
    _markers.delete(id);
}

// ── Popup ─────────────────────────────────────────────────────────────────────

function _openPopup(lng, lat, { name, routeName, speed, onRoute, delayed }) {
    if (_popup) { _popup.remove(); _popup = null; }

    const mph    = (speed * 0.621371).toFixed(0);
    const status = delayed ? '⚠ Delayed' : onRoute ? 'On route' : 'Off route';

    const html = `<div class="flyaway-popup">
        <div class="flyaway-popup-route">${escHtml(routeName)}</div>
        <div class="flyaway-popup-vehicle">${escHtml(name)}</div>
        <div class="flyaway-popup-meta">${mph} mph &bull; ${escHtml(status)}</div>
    </div>`;

    _popup = new maplibregl.Popup({ closeButton: true, maxWidth: '200px' })
        .setLngLat([lng, lat])
        .setHTML(html)
        .addTo(_map);
    _popup.on('close', () => { _popup = null; });
}

// ── Visibility helpers ────────────────────────────────────────────────────────

function _applyVisibility() {
    const zoom = _map?.getZoom() ?? 0;
    for (const { el } of _markers.values()) {
        el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
    }
    if (_map?.getLayer(LAYER_ID)) {
        _map.setLayoutProperty(LAYER_ID, 'visibility', _visible ? 'visible' : 'none');
    }
}

function _applyZoomVisibility() {
    const zoom = _map?.getZoom() ?? 0;
    for (const { el } of _markers.values()) {
        el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
    }
}

// ── Fetch wrapper ─────────────────────────────────────────────────────────────

async function _apiFetch(endpoint) {
    const url = `${FLYAWAY_API}/${endpoint}?systemSelected0=${FLYAWAY_SYSTEM}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`[flyaway] ${endpoint} returned HTTP ${r.status}`);
    return r.json();
}
