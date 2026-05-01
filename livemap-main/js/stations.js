/**
 * stations.js
 * Renders clickable station dots on the map for all rail/busway stops.
 * Clicking a station shows a popup with upcoming arrivals sourced directly
 * from window.masterArrivalsData (populated by tripUpdates.js).
 *
 * Transfer stations are merged: stops with the same normalised name within
 * 300 m are grouped into a single dot whose popup aggregates arrivals from
 * all lines served. Handles 7th St/Metro Center, Willowbrook/Rosa Parks,
 * Expo/Crenshaw, Union Station, North Hollywood, and all J-line NB/SB pairs.
 */

import { routeHexColors, routeDirectionLabels } from './config.js';
import { cleanDestination } from './ui.js';
import { planarMeters, cleanStationName } from './utils.js';
import { getScheduledArrivals } from './predictions.js';

const STATION_SOURCE = 'metro-stations';
const CLICK_LAYER    = 'metro-stations-click';

const RAIL_STOP_RE   = /^8\d{4,5}$/;
const GJ_DEST_RE     = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;
const MERGE_RADIUS_M = 300;

const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C',
    '804': 'E', '805': 'D', '806': 'L',
    '807': 'K', '901': 'G', '910': 'J',
    '950': 'J',
};

let activePopup = null;
let activePopupRefreshTimer = null;
const POPUP_REFRESH_MS = 5000;

// Central registry: each entry represents one clickable dot on the map.
export const stationGroups = [];

// ── Name helpers ──────────────────────────────────────────────────────────────

function toDisplayName(normalized) {
    const stripped = normalized.replace(/\s+Station\s*$/i, '').trim();
    return stripped.length >= 6 ? stripped : normalized;
}

// ── Group registry ────────────────────────────────────────────────────────────

function findGroup(normName, lat, lon) {
    return stationGroups.find(g =>
        g.normName === normName &&
        planarMeters(g.lat, g.lon, lat, lon) < MERGE_RADIUS_M
    );
}

function addToRegistry(stopId, stop) {
    const normName = cleanStationName(stop.name, false);
    const existing = findGroup(normName, stop.lat, stop.lon);
    if (existing) {
        existing.stopIds.push(stopId);
        return false;
    }
    stationGroups.push({
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [stopId],
        displayName: toDisplayName(normName),
    });
    return true;
}

// Phase 2 (busway): name match first, proximity fallback for different-name transfers.
function addBuswayToRegistry(stopId, stop) {
    const normName = cleanStationName(stop.name, false);
    let target = findGroup(normName, stop.lat, stop.lon);
    if (!target) {
        target = stationGroups.find(g =>
            planarMeters(g.lat, g.lon, stop.lat, stop.lon) < MERGE_RADIUS_M
        );
    }
    if (target) {
        if (!target.stopIds.includes(stopId)) target.stopIds.push(stopId);
        return false;
    }
    stationGroups.push({
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [stopId],
        displayName: toDisplayName(normName),
    });
    return true;
}

function groupsToFeatures() {
    return stationGroups.map(g => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
        properties: {
            stopId:   g.stopIds[0],
            stopName: g.displayName,
            stopIds:  g.stopIds.join(','),
        },
    }));
}

// ── Public ────────────────────────────────────────────────────────────────────

export function initStations(map) {
    if (!window.masterStopsData) return;

    // Phase 1: rail stops
    Object.entries(window.masterStopsData).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!stop.lat || !stop.lon) return;
        addToRegistry(stopId, stop);
    });

    map.addSource(STATION_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: groupsToFeatures() },
    });

    map.addLayer({
        id: CLICK_LAYER,
        type: 'circle',
        source: STATION_SOURCE,
        minzoom: 10,
        paint: { 'circle-radius': 14, 'circle-opacity': 0, 'circle-stroke-width': 0 },
    });

    map.on('click', CLICK_LAYER, (e) => {
        if (e.originalEvent.target.closest('.maplibregl-marker')) return;
        const props   = e.features[0].properties;
        const coords  = e.features[0].geometry.coordinates.slice();
        const stopIds = props.stopIds ? props.stopIds.split(',') : [props.stopId];
        showArrivalsPopup(map, coords, stopIds, props.stopName, true);
        e.originalEvent.stopPropagation();
    });

    map.on('mouseenter', CLICK_LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', CLICK_LAYER, () => { map.getCanvas().style.cursor = ''; });

    let hoverTimer;
    map.on('mouseenter', CLICK_LAYER, (e) => {
        if (e.originalEvent.target.closest('.maplibregl-marker')) return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            if (activePopup?.isPinned) return;
            const props   = e.features[0]?.properties;
            const coords  = e.features[0]?.geometry.coordinates.slice();
            if (!props || !coords) return;
            const stopIds = props.stopIds ? props.stopIds.split(',') : [props.stopId];
            showArrivalsPopup(map, coords, stopIds, props.stopName, false);
        }, 180);
    });

    map.on('mouseleave', CLICK_LAYER, () => {
        clearTimeout(hoverTimer);
        if (!activePopup?.isPinned) closeStationPopup();
    });

    // Phase 2: G/J busway stops
    addBuswayStopsFromTrips(map);
}

// ── Phase 2: busway stops ─────────────────────────────────────────────────────

function addBuswayStopsFromTrips(map) {
    const trips = window.masterTripsData;
    const stops = window.masterStopsData;
    if (!trips || !stops) return;

    const source = map.getSource(STATION_SOURCE);
    if (!source) return;

    const seenStops = new Set();
    Object.values(trips).forEach(trip => {
        if (!GJ_DEST_RE.test(trip.dest || '')) return;
        (trip.stops || []).forEach(stopId => {
            const sid = String(stopId);
            if (seenStops.has(sid)) return;
            seenStops.add(sid);
            const stop = stops[sid];
            if (!stop?.lat || !stop?.lon) return;
            addBuswayToRegistry(sid, stop);
        });
    });

    source.setData({ type: 'FeatureCollection', features: groupsToFeatures() });
    console.log(`[stations] ${stationGroups.length} station groups (${seenStops.size} busway stops processed)`);
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopupRefreshTimer) {
        clearInterval(activePopupRefreshTimer);
        activePopupRefreshTimer = null;
    }
    if (activePopup) { activePopup.remove(); activePopup = null; }
}

function showArrivalsPopup(map, coords, stopIds, stopName, pinned = false) {
    closeStationPopup();
    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(buildArrivalsHTML(stopIds, stopName))
        .addTo(map);
    activePopup.isPinned = pinned;

    activePopupRefreshTimer = setInterval(() => {
        if (!activePopup) return;
        try {
            const el = activePopup.getElement();
            const content = el?.querySelector('.maplibregl-popup-content');
            if (!content) return;
            const newHTML = buildArrivalsHTML(stopIds, stopName);
            const currentWrap = content.querySelector('.station-popup-wrap');
            if (currentWrap) {
                const div = document.createElement('div');
                div.innerHTML = newHTML;
                const fresh = div.querySelector('.station-popup-wrap');
                if (fresh && fresh.innerHTML !== currentWrap.innerHTML) {
                    currentWrap.replaceWith(fresh);
                }
            } else {
                activePopup.setHTML(newHTML);
            }
        } catch (err) {
            console.warn('[stations] Popup refresh error:', err);
        }
    }, POPUP_REFRESH_MS);

    activePopup.on('close', () => {
        if (activePopupRefreshTimer) {
            clearInterval(activePopupRefreshTimer);
            activePopupRefreshTimer = null;
        }
        activePopup = null;
    });
}

function buildArrivalsHTML(stopIds, stopName) {
    const now = Math.floor(Date.now() / 1000);

    // Collect schedule-calculated arrivals for all stop IDs in this group
    const arrivals = [];
    const seenKey  = new Set();
    stopIds.forEach(sid => {
        getScheduledArrivals(sid).forEach(a => {
            if (a.arrivalUnix < now - 60) return;
            const key = `${a.vehicleId}-${a.routeId}`;
            if (!seenKey.has(key)) { seenKey.add(key); arrivals.push(a); }
        });
    });
    arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Pink debug outline on markers whose ETA was calculated
    const debugVids = new Set(arrivals.map(a => String(a.vehicleId)));
    document.querySelectorAll('.marker.debug-highlight-vehicle').forEach(el => {
        if (!debugVids.has(el.getAttribute('data-vehicle-id')))
            el.classList.remove('debug-highlight-vehicle');
    });
    debugVids.forEach(vid => {
        document.querySelector(`.marker[data-vehicle-id="${vid}"]`)?.classList.add('debug-highlight-vehicle');
    });

    const name = stopName || stopIds[0];

    if (!arrivals.length) {
        return `<div class="station-popup-wrap">
            <div class="station-popup-name">${esc(name)}</div>
            <div class="station-popup-empty">No upcoming arrivals</div>
        </div>`;
    }

    // Group by routeId → directionId
    const routeMap = new Map();
    arrivals.forEach(a => {
        if (!routeMap.has(a.routeId)) routeMap.set(a.routeId, { 0: [], 1: [] });
        routeMap.get(a.routeId)[a.directionId].push(a);
    });

    const rowsHTML = [...routeMap.entries()].map(([routeId, dirs]) => {
        const color  = routeHexColors[routeId] ?? '#888';
        const letter = ROUTE_LETTER[routeId]   ?? routeId;
        const labels = routeDirectionLabels[routeId] || { 0: 'Dir 0', 1: 'Dir 1' };

        // Left = Westbound/Southbound, Right = Eastbound/Northbound
        let leftDir = 0, rightDir = 1;
        const l0 = labels[0];
        if (l0 === 'Eastbound' || l0 === 'Northbound') { leftDir = 1; rightDir = 0; }

        const renderSide = (dirIdx) => {
            const list = dirs[dirIdx] || [];
            if (!list.length) {
                const terminus = labels[dirIdx] || `Dir ${dirIdx}`;
                if (terminus === name) return `<div class="side-dest"></div><div class="side-times"></div>`;
                return `
                    <div class="side-dest">${esc(terminus)}</div>
                    <div class="side-times"><div class="side-no-data">No active arrivals</div></div>
                `;
            }

            const tripInfo = list[0].tripId ? window.masterTripsData?.[list[0].tripId] : null;
            const terminus = tripInfo?.dest ? cleanDestination(tripInfo.dest) : (labels[dirIdx] || `Dir ${dirIdx}`);
            if (terminus === name) return `<div class="side-dest"></div><div class="side-times"></div>`;

            const isLast = list.some(a => window.masterTripsData?.[a.tripId]?.isLast)
                ? `<div class="last-train-pill">Last</div>` : '';

            const pillsHTML = list.slice(0, 2).map(a => {
                const secAway  = Math.round(a.arrivalUnix - now);
                const timeStr  = secAway <= 0 ? 'Now' : secAway < 60 ? `${secAway}s` : `${Math.round(secAway / 60)}m`;
                const clockStr = new Date(a.arrivalUnix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
                const nowClass = secAway <= 0 ? ' now' : '';
                const lastTag  = window.masterTripsData?.[a.tripId]?.isLast ? `<span class="pill-last">LAST</span>` : '';
                const dbgHTML  = a._dbgMath ? `<div class="arr-dbg">${esc(a._dbgMath)}</div>` : '';
                return `
                    <div class="arr-time-group">
                        <span class="arr-time-pill${nowClass}">${timeStr}${lastTag}</span>
                        <span class="arr-clock-time">${clockStr}</span>
                        ${dbgHTML}
                    </div>`;
            }).join('');

            return `
                <div class="side-dest">${esc(terminus)}</div>
                <div class="side-times">${pillsHTML}${isLast}</div>
            `;
        };

        return `
            <div class="dual-route-row">
                <div class="side left">${renderSide(leftDir)}</div>
                <div class="center">
                    <span class="arr-route-badge" style="background:${color}">${letter}</span>
                </div>
                <div class="side right">${renderSide(rightDir)}</div>
            </div>
        `;
    }).join('');

    return `
        <div class="station-popup-wrap modern">
            <div class="station-popup-name">${esc(name)}</div>
            <div class="dual-rows-container">${rowsHTML}</div>
        </div>
    `;
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function findNearestStation(lng, lat) {
    if (!stationGroups.length) return null;
    let nearest = null;
    let minDist = Infinity;
    stationGroups.forEach(g => {
        const d = planarMeters(lat, lng, g.lat, g.lon);
        if (d < minDist) { minDist = d; nearest = g; }
    });
    return nearest;
}

export function openStationByGroup(map, group) {
    if (!group) return;
    showArrivalsPopup(map, [group.lon, group.lat], group.stopIds, group.displayName, true);
}
