/**
 * busBridges.js
 * Renders bus bridge indicators on the map when a NO_SERVICE alert targets two
 * or more consecutive stops on a Metro rail/busway route.
 *
 * A bus bridge is detected structurally: effect === 'NO_SERVICE' AND the alert's
 * stopIds contain a consecutive subsequence of the route's ordered stop list.
 * One dashed line is drawn per contiguous run, with a bus glyph at its midpoint.
 *
 * Layer:
 *   bus-bridges-line — dashed orange line between the first and last affected stop
 *
 * DOM markers:
 *   .bus-bridge-glyph — bus emoji at the geographic midpoint of each bridge segment
 *
 * Exported:
 *   initBusBridges(map)    — install layer + listen for alertsUpdated
 *   detectBusBridges()     — pure detection; returns Array<BusBridge>
 */

import { getRouteCache } from './predictions.js';
import { normalizeStopId } from './utils.js';

const SOURCE_ID = 'bus-bridges';
const LINE_LAYER = 'bus-bridges-line';

// keyed by `${routeCode}|${fromStopId}|${toStopId}`
const _glyphMarkers = new Map();
let _map = null;

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
                            const key    = `${routeCode}|${fromId}|${toId}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                const fromStop = window.masterStopsData[fromId];
                                const toStop   = window.masterStopsData[toId];
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

function _buildGeoJSON(bridges) {
    return {
        type: 'FeatureCollection',
        features: bridges.map(b => ({
            type: 'Feature',
            geometry: {
                type: 'LineString',
                coordinates: [b.fromCoords, b.toCoords],
            },
            properties: { routeCode: b.routeCode, alertId: b.alertId },
        })),
    };
}

function _addLayer(map) {
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
        id:     LINE_LAYER,
        type:   'line',
        source: SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint:  {
            'line-color':     '#ff8800',
            'line-width':     3,
            'line-dasharray': [2, 2],
            'line-opacity':   0.85,
        },
    }, 'metro-stations-click');
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

        const midLng = (b.fromCoords[0] + b.toCoords[0]) / 2;
        const midLat = (b.fromCoords[1] + b.toCoords[1]) / 2;

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
