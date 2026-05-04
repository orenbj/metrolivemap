/**
 * flyaway.js
 * LAX FlyAway intercity bus tracker — Ride Systems / TransLoc public REST API.
 * Self-contained module following the bikeshare.js isolation pattern.
 *
 * Shows only the intercity Metro Connector Flyaway routes (6 & 7) that link
 * LAX to the Metro rail network. Intra-airport shuttles (routes 2, 3, 4) are
 * deliberately excluded — they are not part of the Metro system.
 *
 * Adds to the map:
 *   • HTML arrow markers per live Flyaway vehicle, colored by route, rotated
 *     by the Heading field provided directly by the feed (no tangent needed).
 *   • Click popup: route name, vehicle name, speed, on-route / delay status.
 *
 * Vehicles stale > FLYAWAY_STALE_SEC fade to 0.4 opacity; removed at FLYAWAY_REMOVE_SEC.
 */

import {
    FLYAWAY_API,
    FLYAWAY_POLL_MS, FLYAWAY_STALE_SEC, FLYAWAY_REMOVE_SEC,
} from './config.js';
import { escHtml, setVisibleInterval } from './utils.js';

// laxflyaway.transloc.com is a dedicated intercity-only deployment — all routes
// returned by the API are Flyaway intercity buses. No filter needed.
// Route 1 = Van Nuys → LAX  |  Route 5 = LAX → Van Nuys
// Route 2 = Union Station → LAX  |  Route 6 = LAX → Union Station

const MIN_ZOOM_MARK = 10;

// ── Module state ──────────────────────────────────────────────────────────────
let _map     = null;
let _visible = true;
let _routes  = {};          // routeId → { name, color }
let _markers = new Map();   // vehicleId → { marker, el, meta }
let _popup   = null;

// ── Public API ─────────────────────────────────────────────────────────────────

export async function initFlyaway(map) {
    _map = map;
    try {
        await _fetchRoutes();
        await _updateMarkers();
    } catch (e) {
        console.warn('[flyaway] Init failed:', e);
        return;
    }

    setVisibleInterval(_updateMarkers, FLYAWAY_POLL_MS);

    map.on('zoom', _applyZoomVisibility);

    const row = document.getElementById('flyaway-legend-row');
    if (row) {
        row.addEventListener('click', () => {
            _visible = !_visible;
            _applyVisibility();
        });
    }
}

// No-op: kept for API compatibility with main.js dark-mode handler.
// No GeoJSON layers to re-register; HTML markers survive style swaps automatically.
export function reAddFlyawayLayer(_map) {}   // eslint-disable-line no-unused-vars

// ── Routes ────────────────────────────────────────────────────────────────────

async function _fetchRoutes() {
    const data = await _apiFetch('GetRoutes');
    const list = Array.isArray(data) ? data : (data?.routes ?? data?.d ?? []);
    for (const r of list) {
        const id = Number(r.RouteID ?? r.routeId);
        const color = r.MapLineColor
            ? (String(r.MapLineColor).startsWith('#') ? r.MapLineColor : '#' + r.MapLineColor)
            : '#09f038';
        _routes[id] = {
            name:  r.Description ?? `Flyaway Route ${id}`,
            color,
        };
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

    const vehicles = Array.isArray(data) ? data
        : (data?.vehiclepoints ?? data?.VehiclePoints ?? data?.d ?? []);

    const seen = new Set();
    const zoom = _map?.getZoom() ?? 0;

    for (const v of vehicles) {
        const routeId = Number(v.RouteID ?? v.routeId);
        const id = String(v.VehicleID ?? v.vehicleId ?? v.ID ?? '');
        if (!id) continue;
        seen.add(id);

        const lat      = parseFloat(v.Latitude  ?? v.lat ?? 0);
        const lng      = parseFloat(v.Longitude ?? v.Long ?? v.lon ?? 0);
        const heading  = parseFloat(v.Heading   ?? 0);
        const staleSec = parseFloat(v.Seconds   ?? 0);
        const name     = String(v.Name ?? id);
        const speed    = parseFloat(v.GroundSpeed ?? 0);
        const onRoute  = v.IsOnRoute !== false && v.IsOnRoute !== 0;
        const delayed  = !!(v.IsDelayed);
        const color    = _routes[routeId]?.color ?? '#09f038';
        const routeName = _routes[routeId]?.name ?? 'LAX FlyAway';

        if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;

        if (staleSec > FLYAWAY_REMOVE_SEC) {
            _removeMarker(id);
            continue;
        }

        const opacity = staleSec > FLYAWAY_STALE_SEC ? 0.4 : 1.0;
        const meta = { name, routeName, speed, onRoute, delayed };

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

        _markers.get(id).el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
    }

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
    const c = String(color).replace(/[^#a-fA-F0-9]/g, '') || '#09f038';
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

// ── Visibility ────────────────────────────────────────────────────────────────

function _applyVisibility() {
    const zoom = _map?.getZoom() ?? 0;
    for (const { el } of _markers.values()) {
        el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
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
    // laxflyaway.transloc.com is a single-system deployment — no query params needed.
    const url = `${FLYAWAY_API}/${endpoint}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`[flyaway] ${endpoint} returned HTTP ${r.status}`);
    return r.json();
}
