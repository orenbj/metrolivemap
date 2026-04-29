/**
 * stations.js
 * Renders clickable station dots on the map for all rail/busway stops.
 * Clicking a station shows a popup with predicted next arrivals from
 * window.masterArrivalsData (populated by tripUpdates.js).
 *
 * Station dot layer sits below vehicle markers.
 */

import { routeHexColors, routeDirectionLabels } from './config.js';
import { cleanDestination } from './ui.js';

const STATION_SOURCE = 'metro-stations';
const CLICK_LAYER    = 'metro-stations-click';  // invisible wider hit area

// Only render stops whose IDs match Metro Rail (5-or-6-digit starting with "8")
const RAIL_STOP_RE = /^8\d{4,5}$/;

// G/J busway route IDs — their stops get added once trip_updates data arrives
const BUSWAY_ROUTE_IDS = new Set(['901', '910']);

// Route letter badges (single letter) for popup pills
const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C',
    '804': 'E', '805': 'D', '806': 'L',
    '807': 'K', '901': 'G', '910': 'J',
};

let activePopup  = null;
let allFeatures  = []; // current GeoJSON feature set — updated by both phases

// ── Public ───────────────────────────────────────────────────────────────────

export function initStations(map) {
    // Wait for masterStopsData
    if (!window.masterStopsData) {
        setTimeout(() => initStations(map), 500);
        return;
    }

    allFeatures = buildStationFeatures();

    map.addSource(STATION_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: allFeatures },
    });

    // Invisible click target only — no visible dot (avoids doubling map's own station markers)
    map.addLayer({
        id: CLICK_LAYER,
        type: 'circle',
        source: STATION_SOURCE,
        minzoom: 10,
        paint: {
            'circle-radius': 14,
            'circle-opacity': 0,
            'circle-stroke-width': 0,
        },
    });

    map.on('click', CLICK_LAYER, (e) => {
        // Don't fire if the click landed on a vehicle marker DOM element
        if (e.originalEvent.target.closest('.maplibregl-marker')) return;
        const props = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        showArrivalsPopup(map, coords, props.stopId, props.stopName);
        e.originalEvent.stopPropagation();
    });

    map.on('mouseenter', CLICK_LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', CLICK_LAYER, () => { map.getCanvas().style.cursor = ''; });

    // Phase 2: add G/J busway stops from masterTripsData (reliable, no WebSocket needed)
    // Wait for masterTripsData then scan trips.json for G/J line stops
    addBuswayStopsFromTrips(map);
}

// ── Build features ────────────────────────────────────────────────────────────

function buildStationFeatures() {
    const stops = window.masterStopsData;
    const seen  = new Set(); // deduplicate by name+coords
    const features = [];

    Object.entries(stops).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!stop.lat || !stop.lon)    return;

        const dedupKey = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
        if (seen.has(dedupKey)) return;
        seen.add(dedupKey);

        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
            properties: {
                stopId,
                stopName: stop.name ?? stopId,
            },
        });
    });

    return features;
}

/**
 * Phase 2: scan masterTripsData for G/J line trips and add all their
 * stop IDs to the clickable station layer immediately on init.
 * Falls back with retries in case masterTripsData isn't loaded yet.
 */
function addBuswayStopsFromTrips(map, attempt = 0) {
    const trips = window.masterTripsData;
    const stops = window.masterStopsData;
    if (!trips || !stops) {
        if (attempt < 10) setTimeout(() => addBuswayStopsFromTrips(map, attempt + 1), 500);
        return;
    }

    const source = map.getSource(STATION_SOURCE);
    if (!source) return;

    // Match G Line / J Line trip destinations
    const GJ_RE = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;

    const existingCoords = new Set(
        allFeatures.map(f => `${f.geometry.coordinates[1].toFixed(4)},${f.geometry.coordinates[0].toFixed(4)}`)
    );

    const newFeatures = [];
    const seenStops   = new Set();
    const seenCoords  = new Set();

    Object.values(trips).forEach(trip => {
        if (!GJ_RE.test(trip.dest || '')) return;
        (trip.stops || []).forEach(stopId => {
            const sid = String(stopId);
            if (seenStops.has(sid)) return;
            seenStops.add(sid);

            const stop = stops[sid];
            if (!stop?.lat || !stop?.lon) return;

            const coordKey = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;
            if (existingCoords.has(coordKey) || seenCoords.has(coordKey)) return;
            seenCoords.add(coordKey);

            newFeatures.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: { stopId: sid, stopName: stop.name ?? sid },
            });
        });
    });

    if (newFeatures.length) {
        allFeatures = [...allFeatures, ...newFeatures];
        source.setData({ type: 'FeatureCollection', features: allFeatures });
        console.log(`[stations] Added ${newFeatures.length} G/J busway stops from trips.json`);
    }
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopup) { activePopup.remove(); activePopup = null; }
}

function showArrivalsPopup(map, coords, stopId, stopName) {
    closeStationPopup();

    const html = buildArrivalsHTML(stopId, stopName);

    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
}

function buildArrivalsHTML(stopId, stopName) {
    const arrivals = window.masterArrivalsData?.get(stopId) ?? [];
    const now = Math.floor(Date.now() / 1000);

    const clean = (stopName || stopId)
        .replace(/\s*Station\b/i, '')
        .replace(/\s*-\s*(Metro\s+)?[A-Z](\s+&\s+[A-Z])?\s+Lines?/i, '')
        .trim();

    if (!arrivals.length) {
        return `<div class="station-popup-wrap">
            <div class="station-popup-name">${esc(clean)}</div>
            <div class="station-popup-empty">No upcoming arrivals</div>
        </div>`;
    }

    // Group by directionId → then by routeId, collect up to 2 times each
    const dirMap = new Map(); // directionId → Map<routeId, arrival[]>
    arrivals.forEach(a => {
        const dk = String(a.directionId);
        if (!dirMap.has(dk)) dirMap.set(dk, new Map());
        const routeMap = dirMap.get(dk);
        if (!routeMap.has(a.routeId)) routeMap.set(a.routeId, []);
        const list = routeMap.get(a.routeId);
        if (list.length < 2) list.push(a);
    });

    const groupsHTML = [...dirMap.entries()].map(([dirKey, routeMap]) => {
        // Use direction label from first route in this direction
        const firstRoute = [...routeMap.keys()][0];
        const dirLabel = routeDirectionLabels[firstRoute]?.[Number(dirKey)] ?? `Direction ${dirKey}`;

        const rowsHTML = [...routeMap.entries()].map(([routeId, group]) => {
            // All arrivals share the same route+destination — stack times
            const color   = routeHexColors[routeId] ?? '#888';
            const letter  = ROUTE_LETTER[routeId]   ?? routeId;
            const tripInfo = group[0].tripId ? window.masterTripsData?.[group[0].tripId] : null;
            const terminus = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
            const destHTML = terminus ? `→ ${esc(terminus)}` : '';

            const timesHTML = group.map(a => {
                const secAway  = Math.round(a.arrivalUnix - now);
                const timeStr  = secAway <= 0   ? 'Now'
                               : secAway < 60   ? `${secAway} sec`
                               : `${Math.round(secAway / 60)} min`;
                const clockStr = new Date(a.arrivalUnix * 1000).toLocaleTimeString([], {
                    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
                });
                return `<div class="arr-time-row">
                    <span class="arr-time">${timeStr}</span>
                    <span class="arr-clock">${clockStr}</span>
                </div>`;
            }).join('');

            return `<tr>
                <td><span class="arr-route-badge" style="background:${color}">${letter}</span></td>
                <td class="arr-dest-cell">${destHTML}</td>
                <td class="arr-time-cell">${timesHTML}</td>
            </tr>`;
        }).join('');

        return `<div class="arrival-group">
            <div class="arrival-group-header">${esc(dirLabel)}</div>
            <table class="station-arrivals-table"><tbody>${rowsHTML}</tbody></table>
        </div>`;
    }).join('');

    return `<div class="station-popup-wrap">
        <div class="station-popup-name">${esc(clean)}</div>
        ${groupsHTML}
    </div>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
