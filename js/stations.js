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

import { routeIcons, routeHexColors, routeDirectionLabels } from './config.js';
import { cleanDestination } from './ui.js';
import { planarMeters, cleanStationName, escHtml as esc } from './utils.js';
import { getScheduledArrivals, getTerminalName, isOriginStop, isTerminalStop, getBoardingVehicles } from './predictions.js';

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
let activePopupStopIds = null;
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

// ── Source/layer management ───────────────────────────────────────────────────

function _addStationSourceAndLayer(map) {
    if (!map.getSource(STATION_SOURCE)) {
        map.addSource(STATION_SOURCE, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: groupsToFeatures() },
        });
    } else {
        map.getSource(STATION_SOURCE).setData({ type: 'FeatureCollection', features: groupsToFeatures() });
    }
    if (!map.getLayer(CLICK_LAYER)) {
        map.addLayer({
            id: CLICK_LAYER,
            type: 'circle',
            source: STATION_SOURCE,
            minzoom: 10,
            paint: { 'circle-radius': 14, 'circle-opacity': 0, 'circle-stroke-width': 0 },
        });
    }
}

export function reAddStationLayer(map) {
    _addStationSourceAndLayer(map);
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

    _addStationSourceAndLayer(map);

    map.on('click', CLICK_LAYER, (e) => {
        if (e.originalEvent.target.closest('.maplibregl-marker')) return;
        const props   = e.features[0].properties;
        const coords  = e.features[0].geometry.coordinates.slice();
        const stopIds = props.stopIds ? props.stopIds.split(',') : [props.stopId];
        showArrivalsPopup(map, coords, stopIds, props.stopName, true);
        e.originalEvent.stopPropagation();
    });

    let hoverTimer;
    map.on('mouseenter', CLICK_LAYER, (e) => {
        map.getCanvas().style.cursor = 'pointer';
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
        map.getCanvas().style.cursor = '';
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

    _addStationSourceAndLayer(map);
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopupRefreshTimer) {
        clearInterval(activePopupRefreshTimer);
        activePopupRefreshTimer = null;
    }
    if (activePopup) { activePopup.remove(); activePopup = null; }
    activePopupStopIds = null;
    clearVehicleHighlights();
}

function showArrivalsPopup(map, coords, stopIds, stopName, pinned = false) {
    closeStationPopup();
    activePopupStopIds = stopIds;
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

function clearVehicleHighlights() {
    document.querySelectorAll('.marker.debug-highlight-vehicle')
        .forEach(el => el.classList.remove('debug-highlight-vehicle'));
}

function applyVehicleHighlights(vidSet) {
    document.querySelectorAll('.marker').forEach(el => {
        const vid = el.getAttribute('data-vehicle-id');
        el.classList.toggle('debug-highlight-vehicle', vidSet.has(vid));
    });
}

function buildArrivalsHTML(stopIds, stopName) {
    const now = Math.floor(Date.now() / 1000);

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

    const name = stopName || stopIds[0];

    if (!arrivals.length) {
        clearVehicleHighlights();
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

    // Highlight only the vehicles actually shown in the popup (≤2 per direction)
    const shownVids = new Set();
    routeMap.forEach(dirs => {
        [0, 1].forEach(dirIdx => {
            (dirs[dirIdx] || []).forEach(a => shownVids.add(String(a.vehicleId)));
        });
    });
    applyVehicleHighlights(shownVids);

    const rowsHTML = [...routeMap.entries()]
        .sort(([a], [b]) => (ROUTE_LETTER[a] ?? a).localeCompare(ROUTE_LETTER[b] ?? b))
        .map(([routeId, dirs]) => {
        const color  = routeHexColors[routeId] ?? '#888';
        const letter = ROUTE_LETTER[routeId]   ?? routeId;
        const labels = routeDirectionLabels[routeId] || { 0: 'Dir 0', 1: 'Dir 1' };

        // Left = Westbound/Southbound, Right = Eastbound/Northbound
        let leftDir = 0, rightDir = 1;
        const l0 = labels[0];
        if (l0 === 'Eastbound' || l0 === 'Northbound') { leftDir = 1; rightDir = 0; }

        const resolveTerminus = (dirIdx, tripInfo) => {
            // Schedule-derived terminus is authoritative — live trip.dest can carry
            // short-turn or pre-revenue test destinations that aren't real termini.
            const structural = getTerminalName(routeId, dirIdx);
            if (structural) return structural;
            let t = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
            if (!t && tripInfo?.stops) {
                const lastStopId = [...tripInfo.stops].reverse().find(s => s);
                const stop = lastStopId ? window.masterStopsData?.[String(lastStopId)] : null;
                if (stop?.name) t = cleanStationName(stop.name);
            }
            return t ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
        };

        const renderRow = (dirIdx, showBadge) => {
            const list = dirs[dirIdx] || [];
            const isTerminal = isTerminalStop(stopIds, routeId, dirIdx);

            // Destination label
            let dest = '';
            if (list.length) {
                const tripInfo = list[0].tripId ? window.masterTripsData?.[list[0].tripId] : null;
                dest = isTerminal ? 'Arriving' : resolveTerminus(dirIdx, tripInfo);
            } else if (!isTerminal) {
                dest = getTerminalName(routeId, dirIdx) ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
            }

            // Pills
            let pillsHTML = '';
            if (list.length) {
                pillsHTML = list.slice(0, 2).map(a => {
                    const secAway = Math.round(a.arrivalUnix - now);
                    const isNow   = secAway <= 30;
                    const timeStr = isNow ? 'Now' : `${Math.max(1, Math.round(secAway / 60))}m`;
                    const lastTag = window.masterTripsData?.[a.tripId]?.isLast ? `<span class="pill-last">LAST</span>` : '';
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${timeStr}${lastTag}</span>`;
                }).join('');
            } else if (!isTerminal && isOriginStop(stopIds, routeId, dirIdx)) {
                const boarding = getBoardingVehicles(stopIds)
                    .filter(v => v.routeId === routeId && v.directionId === dirIdx);
                if (boarding.length) pillsHTML = `<span class="arr-time-pill boarding">Boarding</span>`;
            } else if (!isTerminal) {
                pillsHTML = `<span class="sp-no-data">—</span>`;
            }

            // Skip completely empty rows (terminal side with no arrivals)
            if (!dest && !pillsHTML) return '';

            const iconSrc = routeIcons[routeId] ?? '';
            const badge = showBadge
                ? `<img src="${iconSrc}" class="sp-route-icon" alt="${letter}">`
                : `<div class="sp-badge-gap"></div>`;

            return `
                <div class="sp-row">
                    ${badge}
                    <div class="sp-dest">${esc(dest)}</div>
                    <div class="sp-pills">${pillsHTML}</div>
                </div>`;
        };

        const row1 = renderRow(leftDir,  true);
        const row2 = renderRow(rightDir, !row1);   // badge on row2 if row1 was skipped
        if (!row1 && !row2) return '';

        return `<div class="sp-route">${row1}${row2}</div>`;
    }).join('');

    return `
        <div class="station-popup-wrap modern">
            <div class="station-popup-name">${esc(name)}</div>
            <div class="sp-table">${rowsHTML}</div>
        </div>
    `;
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
