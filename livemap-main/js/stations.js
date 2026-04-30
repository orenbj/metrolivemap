/**
 * stations.js
 * Renders clickable station dots on the map for all rail/busway stops.
 * Clicking a station shows a popup with predicted next arrivals from
 * window.masterArrivalsData (populated by tripUpdates.js).
 *
 * Transfer stations are merged: stops with the same normalised name within
 * 300 m are grouped into a single clickable dot whose popup aggregates
 * arrivals from all lines. This handles 7th St/Metro Center (B/D + A/E),
 * Willowbrook/Rosa Parks (A + C), Expo/Crenshaw (E + K), Union Station
 * (A + B/D), North Hollywood (B rail + G busway), and all NB/SB busway
 * pairs on the J-line Harbor Transitway — while keeping Union Station and
 * Union Station Patsaouras Bus Plaza separate (different base names).
 */

import { routeHexColors, routeDirectionLabels } from './config.js';
import { cleanDestination } from './ui.js';
import { IS_HOVER_DEVICE } from './utils.js';

const STATION_SOURCE = 'metro-stations';
const CLICK_LAYER    = 'metro-stations-click';

const RAIL_STOP_RE   = /^8\d{4,5}$/;
const GJ_DEST_RE     = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;
const MERGE_RADIUS_M = 300;

const M_PER_DEG_LAT    = 110540;
const M_PER_DEG_LNG_LA = 92630; // tuned for ~34.05°N

const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C',
    '804': 'E', '805': 'D', '806': 'L',
    '807': 'K', '901': 'G', '910': 'J',
    '950': 'J',
};

let activePopup   = null;
// Central registry: each entry represents one clickable dot on the map.
export const stationGroups = [];

// ── Name helpers ──────────────────────────────────────────────────────────────

/**
 * Strip line-identifier suffixes from a stop name so stops for different
 * lines at the same physical station share the same base name.
 * Examples:
 *   "7th Street / Metro Center Station - Metro B & D Lines" → "7th Street / Metro Center Station"
 *   "Expo / Crenshaw K-Line Station"                        → "Expo / Crenshaw"
 *   "Willowbrook - Rosa Parks Station - Metro C-Line"       → "Willowbrook - Rosa Parks Station"
 *   "Union Station Patsaouras Bus Plaza"                    → "Union Station Patsaouras Bus Plaza"
 */
function normalizeStationName(name) {
    return String(name || '')
        .replace(/\s*-\s*Metro\s+.+$/i, '')          // " - Metro B & D Lines" / " - Metro A-Line"
        .replace(/\s+[A-Z]-Line\s+Station\s*$/i, '')  // " E-Line Station" / " K-Line Station"
        .trim();
}

/**
 * Produce the display name shown in the popup header.
 * Strips trailing "Station" unless the result would be fewer than 6 chars
 * (guards "Union Station" → "Union").
 */
function toDisplayName(normalized) {
    const stripped = normalized.replace(/\s+Station\s*$/i, '').trim();
    return stripped.length >= 6 ? stripped : normalized;
}

function metersApart(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
    const dLng = (lon2 - lon1) * M_PER_DEG_LNG_LA;
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

// ── Group registry ────────────────────────────────────────────────────────────

function findGroup(normName, lat, lon) {
    return stationGroups.find(g =>
        g.normName === normName &&
        metersApart(g.lat, g.lon, lat, lon) < MERGE_RADIUS_M
    );
}

// Phase 1 (rail): match by same normalised name + proximity.
function addToRegistry(stopId, stop) {
    const normName = normalizeStationName(stop.name);
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

// Phase 2 (busway): try name match first; if none, fall back to proximity-only.
// The fallback handles busway↔rail transfers where the stop names differ
// (e.g. "Harbor Transitway / Harbor Fwy Station" merges into the C-line
// "Harbor Freeway Station" group, "Figueroa / 7th" merges into
// "7th Street / Metro Center", etc.).
// Metro stations in the same corridor are ≥500 m apart, so 300 m is safe.
function addBuswayToRegistry(stopId, stop) {
    const normName = normalizeStationName(stop.name);
    // 1. Same normalised name + proximity
    let target = findGroup(normName, stop.lat, stop.lon);
    // 2. Proximity-only fallback (different-name busway↔rail transfer)
    if (!target) {
        target = stationGroups.find(g =>
            metersApart(g.lat, g.lon, stop.lat, stop.lon) < MERGE_RADIUS_M
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

// ── Public ───────────────────────────────────────────────────────────────────

export function initStations(map) {
    if (!window.masterStopsData) {
        setTimeout(() => initStations(map), 500);
        return;
    }

    // Phase 1: rail stops
    const stops = window.masterStopsData;
    Object.entries(stops).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!stop.lat || !stop.lon) return;
        addToRegistry(stopId, stop);
    });

    const features = groupsToFeatures();

    map.addSource(STATION_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features },
    });

    map.addLayer({
        id: CLICK_LAYER,
        type: 'circle',
        source: STATION_SOURCE,
        minzoom: 10,
        paint: { 'circle-radius': 14, 'circle-opacity': 0, 'circle-stroke-width': 0 },
    });

    // Click: open popup and pin it (stays until clicked away).
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

    // Hover (desktop only): show popup on enter, dismiss on leave unless pinned by click.
    if (IS_HOVER_DEVICE) {
        let hoverTimer;
        map.on('mouseenter', CLICK_LAYER, (e) => {
            if (e.originalEvent.target.closest('.maplibregl-marker')) return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                if (activePopup?.isPinned) return; // a clicked popup is already open
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
    }

    // Phase 2: G/J busway stops
    addBuswayStopsFromTrips(map);
}

// ── Phase 2: busway stops ─────────────────────────────────────────────────────

function addBuswayStopsFromTrips(map, attempt = 0) {
    const trips = window.masterTripsData;
    const stops = window.masterStopsData;
    if (!trips || !stops) {
        if (attempt < 10) setTimeout(() => addBuswayStopsFromTrips(map, attempt + 1), 500);
        return;
    }

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
    console.log(`[stations] Phase 2 complete — ${stationGroups.length} station groups, ${seenStops.size} busway stop IDs processed`);
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopup) { activePopup.remove(); activePopup = null; }
}

// pinned = true  → opened by click; mouseleave will not dismiss it.
// pinned = false → opened by hover; mouseleave dismisses it.
function showArrivalsPopup(map, coords, stopIds, stopName, pinned = false) {
    closeStationPopup();
    activePopup = new maplibregl.Popup({ maxWidth: 'calc(100vw - 32px)', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(buildArrivalsHTML(stopIds, stopName))
        .addTo(map);
    activePopup.isPinned = pinned;
    // When the user closes a pinned popup via the × button, clear our reference.
    activePopup.on('close', () => { activePopup = null; });
}

function buildArrivalsHTML(stopIds, stopName) {
    const now = Math.floor(Date.now() / 1000);

    // Merge arrivals from all stop IDs (transfer stations, NB/SB pairs, etc.)
    const arrivals = [];
    const seenKey  = new Set();
    stopIds.forEach(sid => {
        (window.masterArrivalsData?.get(String(sid)) ?? []).forEach(a => {
            const key = `${a.vehicleId}-${a.routeId}-${a.arrivalUnix}`;
            if (!seenKey.has(key)) { seenKey.add(key); arrivals.push(a); }
        });
    });
    arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

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

    // We'll render one "Dual Row" per route
    const rowsHTML = [...routeMap.entries()].map(([routeId, dirs]) => {
        const color  = routeHexColors[routeId] ?? '#888';
        const letter = ROUTE_LETTER[routeId]   ?? routeId;
        const labels = routeDirectionLabels[routeId] || { 0: 'Dir 0', 1: 'Dir 1' };

        // Determine which direction goes Left vs Right based on user's spatial preference:
        // Left: Westbound or Southbound
        // Right: Eastbound or Northbound
        let leftDir = 0, rightDir = 1;
        const l0 = labels[0], l1 = labels[1];
        if (l0 === 'Eastbound' || l0 === 'Northbound') {
            leftDir = 1; rightDir = 0;
        } else if (l1 === 'Westbound' || l1 === 'Southbound') {
            leftDir = 1; rightDir = 0;
        }

        const renderSide = (dirIdx, align) => {
            const list = dirs[dirIdx] || [];
            if (list.length === 0) return `<div class="side-empty">${align === 'left' ? '←' : '→'}</div>`;

            const tripInfo = list[0].tripId ? window.masterTripsData?.[list[0].tripId] : null;
            const terminus = tripInfo?.dest ? cleanDestination(tripInfo.dest) : 'Terminus';
            const isLast   = list.some(a => window.masterTripsData?.[a.tripId]?.isLast) ? `<div class="last-train-pill">Last</div>` : '';

            const timesHTML = list.slice(0, 2).map(a => {
                const secAway  = Math.round(a.arrivalUnix - now);
                const timeStr  = secAway <= 0 ? 'Now' : secAway < 60 ? `${secAway}s` : `${Math.round(secAway / 60)}m`;
                const nowClass = secAway <= 0 ? ' now' : '';
                return `<span class="arr-time-pill${nowClass}">${timeStr}</span>`;
            }).join('');

            return `
                <div class="side-dest">${esc(terminus)}</div>
                <div class="side-times">${timesHTML}${isLast}</div>
            `;
        };

        return `
            <div class="dual-route-row">
                <div class="side left">${renderSide(leftDir, 'left')}</div>
                <div class="center">
                    <span class="arr-route-badge" style="background:${color}">${letter}</span>
                </div>
                <div class="side right">${renderSide(rightDir, 'right')}</div>
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


/**
 * Finds the station group nearest to the given coordinates.
 * @param {number} lng - Longitude.
 * @param {number} lat - Latitude.
 * @returns {Object|null} The nearest station group.
 */
export function findNearestStation(lng, lat) {
    if (!stationGroups.length) return null;
    let nearest = null;
    let minDist = Infinity;
    stationGroups.forEach(g => {
        const d = metersApart(lat, lng, g.lat, g.lon);
        if (d < minDist) {
            minDist = d;
            nearest = g;
        }
    });
    return nearest;
}

/**
 * Programmatically opens the arrivals popup for a station group.
 * @param {Object} map - The MapLibre map instance.
 * @param {Object} group - The station group to open.
 */
export function openStationByGroup(map, group) {
    if (!group) return;
    showArrivalsPopup(map, [group.lon, group.lat], group.stopIds, group.displayName, true);
}
