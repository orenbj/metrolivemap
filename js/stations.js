/**
 * stations.js
 * Renders clickable station dots on the map for all rail/busway stops.
 * Clicking a station shows a popup with predicted next arrivals from
 * window.masterArrivalsData (populated by tripUpdates.js).
 *
 * Transfer stations (multiple stop IDs at the same coordinates) are merged
 * into a single clickable dot whose popup aggregates arrivals from all lines.
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

// coordKey → stopIds[] — shared mutable map so phase 2 can merge into phase 1 features
const coordStopIds = new Map();

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
        const props  = e.features[0].properties;
        const coords = e.features[0].geometry.coordinates.slice();
        // stopIds is stored as a comma-separated string in GeoJSON properties
        const stopIds = props.stopIds ? props.stopIds.split(',') : [props.stopId];
        showArrivalsPopup(map, coords, stopIds, props.stopName);
        e.originalEvent.stopPropagation();
    });

    map.on('mouseenter', CLICK_LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', CLICK_LAYER, () => { map.getCanvas().style.cursor = ''; });

    // Phase 2: add G/J busway stops from masterTripsData
    addBuswayStopsFromTrips(map);
}

// ── Build features ────────────────────────────────────────────────────────────

function buildStationFeatures() {
    const stops = window.masterStopsData;
    const features = [];

    Object.entries(stops).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!stop.lat || !stop.lon)    return;

        const coordKey = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;

        if (coordStopIds.has(coordKey)) {
            // Transfer station — add this stop ID to the existing feature's list
            coordStopIds.get(coordKey).push(stopId);
        } else {
            const ids = [stopId];
            coordStopIds.set(coordKey, ids);
            features.push({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                properties: {
                    stopId,           // first stop ID (kept for legacy compat)
                    stopName: stop.name ?? stopId,
                    coordKey,         // used by phase 2 to find and update this feature
                    stopIds: stopId,  // will be updated below after all IDs collected
                },
            });
        }
    });

    // Back-fill stopIds on every feature now that all IDs are known
    features.forEach(f => {
        const ids = coordStopIds.get(f.properties.coordKey);
        if (ids) f.properties.stopIds = ids.join(',');
    });

    return features;
}

/**
 * Phase 2: scan masterTripsData for G/J line trips and add all their
 * stop IDs to the clickable station layer. Co-located stops (transfer
 * stations like North Hollywood B+G) are merged into the existing feature.
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

    const GJ_RE = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;

    const newFeatures = [];
    const seenStops   = new Set();

    Object.values(trips).forEach(trip => {
        if (!GJ_RE.test(trip.dest || '')) return;
        (trip.stops || []).forEach(stopId => {
            const sid = String(stopId);
            if (seenStops.has(sid)) return;
            seenStops.add(sid);

            const stop = stops[sid];
            if (!stop?.lat || !stop?.lon) return;

            const coordKey = `${stop.lat.toFixed(4)},${stop.lon.toFixed(4)}`;

            if (coordStopIds.has(coordKey)) {
                // This busway stop shares a location with an existing rail station.
                // Merge the stop ID into that station's feature (transfer station).
                const ids = coordStopIds.get(coordKey);
                if (!ids.includes(sid)) {
                    ids.push(sid);
                    // Update the matching feature's stopIds property
                    const feat = allFeatures.find(f => f.properties.coordKey === coordKey);
                    if (feat) feat.properties.stopIds = ids.join(',');
                }
            } else {
                // New busway-only stop — create a fresh feature
                const ids = [sid];
                coordStopIds.set(coordKey, ids);
                newFeatures.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [stop.lon, stop.lat] },
                    properties: {
                        stopId: sid,
                        stopName: stop.name ?? sid,
                        coordKey,
                        stopIds: sid,
                    },
                });
            }
        });
    });

    if (newFeatures.length || seenStops.size) {
        allFeatures = [...allFeatures, ...newFeatures];
        source.setData({ type: 'FeatureCollection', features: allFeatures });
        console.log(`[stations] Added ${newFeatures.length} G/J busway stops; merged ${seenStops.size} stop IDs`);
    }
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopup) { activePopup.remove(); activePopup = null; }
}

function showArrivalsPopup(map, coords, stopIds, stopName) {
    closeStationPopup();

    const html = buildArrivalsHTML(stopIds, stopName);

    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(map);
}

function buildArrivalsHTML(stopIds, stopName) {
    const now = Math.floor(Date.now() / 1000);

    // Merge arrivals from all stop IDs at this location (transfer stations)
    const arrivals = [];
    const seenKey  = new Set();
    stopIds.forEach(sid => {
        const list = window.masterArrivalsData?.get(String(sid)) ?? [];
        list.forEach(a => {
            const key = `${a.vehicleId}-${a.routeId}-${a.arrivalUnix}`;
            if (!seenKey.has(key)) {
                seenKey.add(key);
                arrivals.push(a);
            }
        });
    });
    arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Use the first stop name, clean display suffixes
    const raw   = stopName || stopIds[0];
    const clean = String(raw)
        .replace(/\s*Station\b/i, '')
        .replace(/\s*[-–]\s*(Metro\s+)?[A-Z](\s*[/&,]\s*[A-Z])*\s+Lines?/i, '')
        .trim();

    if (!arrivals.length) {
        return `<div class="station-popup-wrap">
            <div class="station-popup-name">${esc(clean)}</div>
            <div class="station-popup-empty">No upcoming arrivals</div>
        </div>`;
    }

    // Group by routeId+directionId — each unique combo is one row
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
        const firstRoute = [...routeMap.keys()][0];
        const dirLabel   = routeDirectionLabels[firstRoute]?.[Number(dirKey)] ?? `Direction ${dirKey}`;

        const rowsHTML = [...routeMap.entries()].map(([routeId, group]) => {
            const color    = routeHexColors[routeId] ?? '#888';
            const letter   = ROUTE_LETTER[routeId]   ?? routeId;
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
