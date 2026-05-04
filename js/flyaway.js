/**
 * flyaway.js
 * LAX FlyAway intercity bus tracker — Ride Systems / TransLoc public REST API.
 * Self-contained module following the bikeshare.js isolation pattern.
 *
 * All routes from laxflyaway.transloc.com are intercity Flyaway buses
 * (Van Nuys ↔ LAX, Union Station ↔ LAX). Intra-airport shuttles live on a
 * separate deployment and are never fetched here.
 *
 * Adds to the map:
 *   • Moving vehicles   → airplane icon, rotated by Heading from the feed.
 *   • Stopped vehicles  → square icon (no rotation), matching G/J bus style.
 *   • Size scales with zoom level (VEHICLE_SIZE_MIN_PX – VEHICLE_SIZE_MAX_PX).
 *   • Click popup: route name, vehicle name, speed, on-route / delay status,
 *     and next stop + ETA from GetStopArrivalTimes.
 *
 * Vehicles absent for > FLYAWAY_REMOVE_SEC are removed (grace period prevents
 * flash when a vehicle is temporarily missing from one poll cycle).
 * Vehicles stale > FLYAWAY_STALE_SEC (per the feed's Seconds field) fade to 0.4.
 */

import {
    FLYAWAY_API,
    FLYAWAY_POLL_MS, FLYAWAY_STALE_SEC, FLYAWAY_REMOVE_SEC,
    VEHICLE_ZOOM_MIN, VEHICLE_ZOOM_MAX, VEHICLE_SIZE_MIN_PX, VEHICLE_SIZE_MAX_PX,
} from './config.js';
import { escHtml, setVisibleInterval } from './utils.js';

// Speed threshold (km/h) below which a vehicle is considered stopped.
// GroundSpeed from the feed is in km/h.
const STOPPED_KMH = 2;

const MIN_ZOOM_MARK = 10;

// ── Module state ──────────────────────────────────────────────────────────────
let _map     = null;
let _visible = true;
let _routes  = {};          // routeId → { name, color }
let _markers = new Map();   // vehicleId → { marker, el, meta, lastSeen, color, heading, stopped }
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
// HTML markers survive style swaps automatically; no GeoJSON layers to re-add.
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

// ── Arrival ETAs ──────────────────────────────────────────────────────────────

async function _fetchArrivals() {
    let data;
    try {
        data = await _apiFetch('GetStopArrivalTimes');
    } catch (e) {
        console.warn('[flyaway] Arrival fetch failed:', e);
        return {};
    }
    const list = Array.isArray(data) ? data : (data?.d ?? []);
    const lookup = {};  // vehicleId → { nextStop, etaText, etaTime, seconds }
    for (const stop of list) {
        const stopName = String(stop.StopDescription ?? stop.stopDescription ?? '');
        for (const t of (stop.Times ?? stop.times ?? [])) {
            const vid  = String(t.VehicleId ?? t.vehicleId ?? '');
            if (!vid) continue;
            const secs = Number(t.Seconds ?? t.seconds ?? Infinity);
            // Keep the earliest (soonest) arrival per vehicle across all stops
            if (!lookup[vid] || secs < lookup[vid].seconds) {
                lookup[vid] = {
                    nextStop: stopName,
                    etaText:  String(t.Text ?? t.text ?? ''),
                    etaTime:  _formatTime(Date.now() + secs * 1000),
                    seconds:  secs,
                };
            }
        }
    }
    return lookup;
}

/** Format a timestamp (ms) as "2:34 PM" in local time. */
function _formatTime(ms) {
    return new Date(ms).toLocaleTimeString('en-US', {
        hour:   'numeric',
        minute: '2-digit',
        hour12: true,
    });
}

// ── Vehicle markers ───────────────────────────────────────────────────────────

async function _updateMarkers() {
    // Fetch vehicle positions; fetch arrivals in parallel (arrivals never rejects).
    let vehicleData;
    let arrivals = {};
    try {
        [vehicleData, arrivals] = await Promise.all([
            _apiFetch('GetMapVehiclePoints'),
            _fetchArrivals(),
        ]);
    } catch (e) {
        console.warn('[flyaway] Vehicle fetch failed:', e);
        return;
    }

    const vehicles = Array.isArray(vehicleData) ? vehicleData
        : (vehicleData?.vehiclepoints ?? vehicleData?.VehiclePoints ?? vehicleData?.d ?? []);

    const now  = Date.now();
    const zoom = _map?.getZoom() ?? 0;

    for (const v of vehicles) {
        const id = String(v.VehicleID ?? v.vehicleId ?? v.ID ?? '');
        if (!id) continue;

        const routeId   = Number(v.RouteID ?? v.routeId);
        const lat       = parseFloat(v.Latitude  ?? v.lat ?? 0);
        const lng       = parseFloat(v.Longitude ?? v.Long ?? v.lon ?? 0);
        const heading   = parseFloat(v.Heading   ?? 0);
        const staleSec  = parseFloat(v.Seconds   ?? 0);
        const name      = String(v.Name ?? id);
        const speed     = parseFloat(v.GroundSpeed ?? 0);  // km/h from feed
        const onRoute   = v.IsOnRoute !== false && v.IsOnRoute !== 0;
        const delayed   = !!(v.IsDelayed);
        const color     = _routes[routeId]?.color ?? '#09f038';
        const routeName = _routes[routeId]?.name ?? 'LAX FlyAway';
        const stopped   = speed < STOPPED_KMH;

        if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;

        // Hard-remove via the feed's own staleness counter (GPS ping age).
        if (staleSec > FLYAWAY_REMOVE_SEC) {
            _removeMarker(id);
            continue;
        }

        const opacity = staleSec > FLYAWAY_STALE_SEC ? 0.4 : 1.0;
        const eta     = arrivals[id] ?? null;
        const meta    = { name, routeName, speed, onRoute, delayed, eta };

        if (_markers.has(id)) {
            const entry = _markers.get(id);
            entry.marker.setLngLat([lng, lat]);
            entry.color   = color;
            entry.heading = heading;
            entry.stopped = stopped;
            entry.opacity = opacity;
            _applyMarkerStyle(entry.el, color, heading, opacity, stopped);
            entry.meta     = meta;
            entry.lastSeen = now;
        } else {
            const el     = _makeMarkerEl(color, heading, opacity, stopped);
            const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
                .setLngLat([lng, lat])
                .addTo(_map);

            const entry = { marker, el, meta, lastSeen: now, color, heading, stopped, opacity };
            _markers.set(id, entry);

            el.addEventListener('click', (evt) => {
                evt.stopPropagation();
                const e = _markers.get(id);
                if (!e) return;
                const { lng: curLng, lat: curLat } = e.marker.getLngLat();
                _openPopup(curLng, curLat, e.meta);
            });
        }

        _markers.get(id).el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
    }

    // Grace-period removal: drop markers that weren't seen in this poll cycle
    // AND whose lastSeen is older than FLYAWAY_REMOVE_SEC. This prevents flash
    // when a vehicle is briefly absent from a single poll response.
    const removeThreshold = now - FLYAWAY_REMOVE_SEC * 1000;
    for (const [id, entry] of _markers) {
        if (entry.lastSeen < removeThreshold) _removeMarker(id);
    }
}

// ── Marker helpers ────────────────────────────────────────────────────────────

function _markerSize() {
    const zoom = _map?.getZoom() ?? VEHICLE_ZOOM_MIN;
    const t = Math.max(0, Math.min(1,
        (zoom - VEHICLE_ZOOM_MIN) / (VEHICLE_ZOOM_MAX - VEHICLE_ZOOM_MIN)));
    return Math.round(VEHICLE_SIZE_MIN_PX + t * (VEHICLE_SIZE_MAX_PX - VEHICLE_SIZE_MIN_PX));
}

function _makeMarkerEl(color, heading, opacity, stopped) {
    const el = document.createElement('div');
    el.className = 'flyaway-marker';
    _applyMarkerStyle(el, color, heading, opacity, stopped);
    return el;
}

function _applyMarkerStyle(el, color, heading, opacity, stopped) {
    const size = _markerSize();
    el.innerHTML = stopped ? _squareSvg(color, size) : _planeSvg(color, heading, size);
    el.style.opacity   = opacity;
    // Stopped vehicles: no rotation (square is orientation-neutral).
    // Moving vehicles: rotation is baked into the SVG transform so the 44×44
    // tap container stays axis-aligned (avoids MapLibre anchor jitter on rotate).
    el.style.transform = '';
}

/**
 * Top-down airplane silhouette pointing north (up), rotated by `heading`.
 * Rotation is applied inside the SVG so the outer div stays square and the
 * MapLibre anchor point remains stable regardless of heading.
 */
function _planeSvg(color, heading, size) {
    const c = _safeColor(color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="${size}" height="${size}">
        <rect x="2" y="2" width="46" height="46" rx="6" fill="${c}" stroke="#ffffff" stroke-width="3"/>
        <g transform="rotate(${heading}, 25, 25)">
            <path d="M25 5 C27 5,29 11,29 18 L46 27 L46 32 L29 26 L30 38 L34 41 L34 44 L25 42 L16 44 L16 41 L20 38 L21 26 L4 32 L4 27 L21 18 C21 11,23 5,25 5 Z" fill="#ffffff"/>
        </g>
    </svg>`;
}

/** Plain colored square with rounded corners — used when vehicle is stopped. */
function _squareSvg(color, size) {
    const c = _safeColor(color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="${size}" height="${size}">
        <rect x="2" y="2" width="46" height="46" rx="6" fill="${c}" stroke="#ffffff" stroke-width="3"/>
    </svg>`;
}

function _safeColor(color) {
    return String(color).replace(/[^#a-fA-F0-9]/g, '') || '#09f038';
}

function _removeMarker(id) {
    const m = _markers.get(id);
    if (!m) return;
    m.marker.remove();
    _markers.delete(id);
}

// ── Popup ─────────────────────────────────────────────────────────────────────

/**
 * Derive a short bidirectional label from the route description.
 * "FlyAway - Van Nuys to LAX"  →  "Van Nuys ↔ LAX"
 * Falls back to the full name if the pattern doesn't match.
 */
function _routeShorthand(name) {
    const m = String(name).match(/FlyAway\s*[-–]\s*(.+?)\s+to\s+(.+)/i);
    return m ? `${m[1].trim()} ↔ ${m[2].trim()}` : name;
}

function _openPopup(lng, lat, { name, routeName, onRoute, delayed, eta }) {
    if (_popup) { _popup.remove(); _popup = null; }

    const status     = delayed ? '⚠ Delayed' : onRoute ? 'On route' : 'Off route';
    const shortRoute = _routeShorthand(routeName);

    // Always show the route direction; departure time only when available.
    const etaHtml =
        `<div class="flyaway-popup-eta">${escHtml(shortRoute)}</div>` +
        (eta
            ? `<div class="flyaway-popup-departing">Departing ${escHtml(eta.etaText)} &middot; ${escHtml(eta.etaTime)}</div>`
            : '');

    const html = `<div class="flyaway-popup">
        <div class="flyaway-popup-route">${escHtml(routeName)}</div>
        <div class="flyaway-popup-vehicle">${escHtml(name)}</div>
        <div class="flyaway-popup-meta">${escHtml(status)}</div>
        ${etaHtml}
    </div>`;

    _popup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px' })
        .setLngLat([lng, lat])
        .setHTML(html)
        .addTo(_map);
    _popup.on('close', () => { _popup = null; });
}

// ── Visibility / zoom ─────────────────────────────────────────────────────────

function _applyVisibility() {
    const zoom = _map?.getZoom() ?? 0;
    for (const { el } of _markers.values()) {
        el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
    }
}

function _applyZoomVisibility() {
    const zoom = _map?.getZoom() ?? 0;
    const size = _markerSize();
    for (const entry of _markers.values()) {
        entry.el.style.display = (_visible && zoom >= MIN_ZOOM_MARK) ? '' : 'none';
        // Update SVG dimensions without rebuilding the whole element
        const svg = entry.el.querySelector('svg');
        if (svg) {
            svg.setAttribute('width',  size);
            svg.setAttribute('height', size);
        }
    }
}

// ── Fetch wrapper ─────────────────────────────────────────────────────────────

async function _apiFetch(endpoint) {
    const url = `${FLYAWAY_API}/${endpoint}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`[flyaway] ${endpoint} returned HTTP ${r.status}`);
    return r.json();
}
