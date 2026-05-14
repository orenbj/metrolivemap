/**
 * busBridges.js
 * Renders bus bridge indicators on the map when a NO_SERVICE alert targets two
 * or more consecutive stops on a Metro rail/busway route.
 *
 * A bus bridge is detected structurally: effect === 'NO_SERVICE' AND the alert's
 * stopIds contain a consecutive subsequence of the route's ordered stop list.
 * One bracket polyline is drawn per contiguous run, with a bus glyph at its
 * midpoint. The bracket consists of two perpendicular legs (one from each
 * affected station) joined by a parallel run offset 60 m off the track, so the
 * bridge is visually distinct from the rail polyline beneath it.
 *
 * Layers:
 *   bus-bridges-line-halo — wider light/dark casing for legibility
 *   bus-bridges-line      — solid orange bracket on top of the halo
 *
 * DOM markers:
 *   .bus-bridge-glyph — bus emoji at the midpoint of the offset run
 *
 * Exported:
 *   initBusBridges(map)    — install layer + listen for alertsUpdated
 *   detectBusBridges()     — pure detection; returns Array<BusBridge>
 */

import { getRouteCache } from './predictions.js';
import { normalizeStopId, M_PER_DEG_LAT, M_PER_DEG_LNG_LA } from './utils.js';

const SOURCE_ID  = 'bus-bridges';
const LINE_LAYER = 'bus-bridges-line';
const HALO_LAYER = 'bus-bridges-line-halo';

/** Perpendicular offset (meters) of the bracket's parallel run from the A→B chord. */
const OFFSET_METERS = 60;

// keyed by `${routeCode}|${fromStopId}|${toStopId}`
const _glyphMarkers = new Map();
let _map = null;
let _initialized = false;

/**
 * Detect bus bridges from current masterAlertsData.
 * @returns {Array<{routeCode:string, fromStopId:string, toStopId:string, fromCoords:[number,number], toCoords:[number,number], alertId:string}>}
 */
export function detectBusBridges() {
    if (!window.masterAlertsData || !window.masterStopsData) return [];

    const bridges = [];
    const seen = new Set();

    for (const [routeCode, alertList] of window.masterAlertsData) {
        for (const alert of alertList) {
            if (alert.effect !== 'NO_SERVICE') continue;
            if (!alert.stopIds?.length || alert.stopIds.length < 2) continue;

            const alertStops = new Set(alert.stopIds.map(s => normalizeStopId(s)));

            // Try both directions — pick the first cache that has a matching run
            for (const dir of [0, 1]) {
                const cache = getRouteCache(routeCode, dir);
                if (!cache?.stops?.length) continue;

                const stops = cache.stops.map(s => normalizeStopId(s));

                // Find maximal consecutive runs where every stop is in alertStops
                let runStart = -1;
                for (let i = 0; i <= stops.length; i++) {
                    const inRun = i < stops.length && alertStops.has(stops[i]);
                    if (inRun && runStart === -1) {
                        runStart = i;
                    } else if (!inRun && runStart !== -1) {
                        const runLen = i - runStart;
                        if (runLen >= 2) {
                            const fromId = stops[runStart];
                            const toId   = stops[i - 1];
                            // Canonical key: dir 0 yields "A→B" and dir 1 yields "B→A" for
                            // the same affected segment. Sort endpoints so both directions
                            // collapse to one bridge.
                            const [a, b] = [fromId, toId].sort();
                            const key = `${routeCode}|${a}|${b}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                // `stops[]` was normalized at line 62, but masterStopsData
                                // may be keyed by the un-normalized GTFS stop_id (e.g.
                                // "80111_N") depending on which pipeline built it. Try the
                                // normalized form first, then the original from cache.stops
                                // — mirrors the dual-lookup pattern used in markers.js.
                                const fromOrig = cache.stops[runStart];
                                const toOrig   = cache.stops[i - 1];
                                const fromStop = window.masterStopsData[fromId] ?? window.masterStopsData[fromOrig];
                                const toStop   = window.masterStopsData[toId]   ?? window.masterStopsData[toOrig];
                                if (fromStop && toStop) {
                                    bridges.push({
                                        routeCode,
                                        fromStopId: fromId,
                                        toStopId:   toId,
                                        fromCoords: [fromStop.lon, fromStop.lat],
                                        toCoords:   [toStop.lon,   toStop.lat],
                                        alertId:    alert.id,
                                    });
                                }
                            }
                        }
                        runStart = -1;
                    }
                }
            }
        }
    }

    return bridges;
}

function _bridgesKey(b) {
    return `${b.routeCode}|${b.fromStopId}|${b.toStopId}`;
}

/**
 * Compute the bracket polyline for a bus bridge between two stations.
 *
 * Returns a 4-vertex polyline [A, A_off, B_off, B] where A_off / B_off sit
 * perpendicular-left of A→B by `offsetMeters`. The bus icon goes at the
 * midpoint of the offset run (A_off → B_off), clear of the rail track.
 *
 * Pure — no MapLibre dependencies; testable.
 *
 * @param {[number, number]} fromCoords  [lng, lat] of station A
 * @param {[number, number]} toCoords    [lng, lat] of station B
 * @param {number} [offsetMeters=OFFSET_METERS]
 * @returns {{ coords: [number,number][], midpoint: [number,number] } | null}
 *          null for degenerate (zero-length) input
 */
export function _bridgePolyline(fromCoords, toCoords, offsetMeters = OFFSET_METERS) {
    const [lonA, latA] = fromCoords;
    const [lonB, latB] = toCoords;

    // AB in local meters using LA-calibrated degree↔meter conversions
    const dxM = (lonB - lonA) * M_PER_DEG_LNG_LA;
    const dyM = (latB - latA) * M_PER_DEG_LAT;
    const L   = Math.sqrt(dxM * dxM + dyM * dyM);
    if (L === 0) return null;

    // Perpendicular-left unit vector (meters)
    const ux = -dyM / L;
    const uy =  dxM / L;

    // Convert the offset back to degrees per axis
    const offLng = (ux * offsetMeters) / M_PER_DEG_LNG_LA;
    const offLat = (uy * offsetMeters) / M_PER_DEG_LAT;

    const A_off = [lonA + offLng, latA + offLat];
    const B_off = [lonB + offLng, latB + offLat];
    const midpoint = [(A_off[0] + B_off[0]) / 2, (A_off[1] + B_off[1]) / 2];

    return {
        coords: [fromCoords, A_off, B_off, toCoords],
        midpoint,
    };
}

function _buildGeoJSON(bridges) {
    const features = [];
    for (const b of bridges) {
        const poly = _bridgePolyline(b.fromCoords, b.toCoords);
        if (!poly) continue;
        features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: poly.coords },
            properties: { routeCode: b.routeCode, alertId: b.alertId },
        });
    }
    return { type: 'FeatureCollection', features };
}

function _haloColor() {
    return document.body.classList.contains('dark-mode') ? '#1a1a1a' : '#ffffff';
}

function _addLayer(map) {
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        });
    }

    // Insert beneath the station hit layer so dots & alert badges remain
    // clickable. After a dark-mode style swap, both this and reAddStationLayer
    // listen for style.load — if station layer hasn't been re-added yet, omit
    // beforeId rather than tripping a MapLibre warning and silently flipping
    // layer order.
    const stationLayer = map.getLayer('metro-stations-click') ? 'metro-stations-click' : undefined;

    // Halo casing underneath — light in day mode, dark in night mode — so the
    // orange bracket reads against any basemap (light pavement, parks, water).
    if (!map.getLayer(HALO_LAYER)) {
        map.addLayer({
            id:     HALO_LAYER,
            type:   'line',
            source: SOURCE_ID,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint:  {
                'line-color':   _haloColor(),
                'line-width':   7,
                'line-opacity': 0.9,
            },
        }, stationLayer);
    }

    // Solid orange bracket on top — dropping the dasharray; the bracket shape
    // itself is the affordance ("this is not the track"), the halo handles
    // legibility, dashes on short perpendicular legs would read as noise.
    if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
            id:     LINE_LAYER,
            type:   'line',
            source: SOURCE_ID,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint:  {
                'line-color':   '#ff8800',
                'line-width':   4,
                'line-opacity': 0.95,
            },
        }, stationLayer);
    }
}

function _refreshBusBridges(map) {
    if (!map) return;

    const bridges = detectBusBridges();

    // Update geojson layer
    const src = map.getSource(SOURCE_ID);
    if (src) src.setData(_buildGeoJSON(bridges));

    // Reconcile glyph markers
    const nextKeys = new Set(bridges.map(_bridgesKey));

    // Remove obsolete
    for (const [key, marker] of _glyphMarkers) {
        if (!nextKeys.has(key)) {
            marker.remove();
            _glyphMarkers.delete(key);
        }
    }

    // Add new
    for (const b of bridges) {
        const key = _bridgesKey(b);
        if (_glyphMarkers.has(key)) continue;

        // Place the bus glyph on the offset run (between A_off and B_off), so
        // it sits clear of the rail track rather than on top of it.
        const poly = _bridgePolyline(b.fromCoords, b.toCoords);
        if (!poly) continue;
        const [midLng, midLat] = poly.midpoint;

        const el = document.createElement('span');
        el.className = 'bus-bridge-glyph';
        el.setAttribute('aria-label', 'Bus bridge replacement service');
        el.textContent = '🚌';

        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([midLng, midLat])
            .addTo(map);
        _glyphMarkers.set(key, marker);
    }
}

/**
 * Initialize bus bridge layer and glyph markers. Refreshes on every
 * 'alertsUpdated' event dispatched by alerts.js, and re-installs the layer
 * after dark mode style swaps via the 'toggleDarkMode' + 'style.load' pattern.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export function initBusBridges(map) {
    if (_initialized) return;
    _initialized = true;
    _map = map;
    _addLayer(map);
    _refreshBusBridges(map);

    document.addEventListener('alertsUpdated', () => {
        if (!_map) return;
        // Layer may have been removed by a dark mode swap that hasn't re-loaded yet
        if (!_map.getSource(SOURCE_ID)) _addLayer(_map);
        _refreshBusBridges(_map);
    });

    document.addEventListener('toggleDarkMode', () => {
        _map.once('style.load', () => {
            _addLayer(_map);
            _refreshBusBridges(_map);
        });
    });
}
