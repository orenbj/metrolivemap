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

const STATION_SOURCE = 'metro-stations';
const CLICK_LAYER    = 'metro-stations-click';

const RAIL_STOP_RE   = /^8\d{4,5}$/;
const GJ_DEST_RE     = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;
const MERGE_RADIUS_M = 300;

const M_PER_DEG_LAT    = 110540;
const M_PER_DEG_LNG_LA = 92500;

const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C',
    '804': 'E', '805': 'D', '806': 'L',
    '807': 'K', '901': 'G', '910': 'J',
};

let activePopup   = null;
// Central registry: each entry represents one clickable dot on the map.
const stationGroups = [];

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

function addToRegistry(stopId, stop) {
    const normName = normalizeStationName(stop.name);
    const existing = findGroup(normName, stop.lat, stop.lon);
    if (existing) {
        existing.stopIds.push(stopId);
        return false; // merged into existing group
    }
    stationGroups.push({
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [stopId],
        displayName: toDisplayName(normName),
    });
    return true; // new group created
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

    map.on('click', CLICK_LAYER, (e) => {
        if (e.originalEvent.target.closest('.maplibregl-marker')) return;
        const props  = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        const stopIds = props.stopIds ? props.stopIds.split(',') : [props.stopId];
        showArrivalsPopup(map, coords, stopIds, props.stopName);
        e.originalEvent.stopPropagation();
    });

    map.on('mouseenter', CLICK_LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', CLICK_LAYER, () => { map.getCanvas().style.cursor = ''; });

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

            addToRegistry(sid, stop);
        });
    });

    source.setData({ type: 'FeatureCollection', features: groupsToFeatures() });
    console.log(`[stations] Phase 2 complete — ${stationGroups.length} station groups, ${seenStops.size} busway stop IDs processed`);
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopup) { activePopup.remove(); activePopup = null; }
}

function showArrivalsPopup(map, coords, stopIds, stopName) {
    closeStationPopup();
    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(buildArrivalsHTML(stopIds, stopName))
        .addTo(map);
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

    // Group by directionId → routeId
    const dirMap = new Map();
    arrivals.forEach(a => {
        const dk = String(a.directionId);
        if (!dirMap.has(dk)) dirMap.set(dk, new Map());
        const routeMap = dirMap.get(dk);
        if (!routeMap.has(a.routeId)) routeMap.set(a.routeId, []);
        const list = routeMap.get(a.routeId);
        if (list.length < 2) list.push(a);
    });

    const groupsHTML = [...dirMap.entries()].map(([dirKey, routeMap]) => {
        const firstRoute = [...routeMap.keys()][0];
        const dirLabel   = routeDirectionLabels[firstRoute]?.[Number(dirKey)] ?? `Direction ${dirKey}`;

        const rowsHTML = [...routeMap.entries()].map(([routeId, group]) => {
            const color    = routeHexColors[routeId] ?? '#888';
            const letter   = ROUTE_LETTER[routeId]   ?? routeId;
            const tripInfo = group[0].tripId ? window.masterTripsData?.[group[0].tripId] : null;
            const terminus = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;

            const timesHTML = group.map(a => {
                const secAway  = Math.round(a.arrivalUnix - now);
                const timeStr  = secAway <= 0 ? 'Now' : secAway < 60 ? `${secAway} sec` : `${Math.round(secAway / 60)} min`;
                const clockStr = new Date(a.arrivalUnix * 1000).toLocaleTimeString([], {
                    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
                });
                return `<div class="arr-time-row">
                    <span class="arr-time">${timeStr}</span>
                    <span class="arr-clock">${clockStr}</span>
                </div>`;
            }).join('');

            return `<tr>
                <td><span class="arr-route-badge" style="background:${color}">${letter}</span></td>
                <td class="arr-dest-cell">${terminus ? `→ ${esc(terminus)}` : ''}</td>
                <td class="arr-time-cell">${timesHTML}</td>
            </tr>`;
        }).join('');

        return `<div class="arrival-group">
            <div class="arrival-group-header">${esc(dirLabel)}</div>
            <table class="station-arrivals-table"><tbody>${rowsHTML}</tbody></table>
        </div>`;
    }).join('');

    return `<div class="station-popup-wrap">
        <div class="station-popup-name">${esc(name)}</div>
        ${groupsHTML}
    </div>`;
}

function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
