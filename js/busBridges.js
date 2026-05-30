/**
 * busBridges.js
 * Renders bus bridge indicators on the map when an alert closes two or more
 * consecutive stops on a Metro rail/busway route and a shuttle replaces them.
 *
 * A bus bridge is detected structurally: the alert's stopIds contain a
 * consecutive subsequence of the route's ordered stop list, AND the alert is
 * either effect === 'NO_SERVICE' OR its text names a bus shuttle/bridge (Metro
 * tags partial closures — trains still run on part of the line — as
 * MODIFIED_SERVICE, so the effect code alone misses those; see _BRIDGE_TEXT_RE).
 * One bracket polyline is drawn per contiguous run, with a bus glyph at its
 * midpoint. The bracket consists of two perpendicular legs (one from each
 * affected station) joined by a parallel run offset 240 m off the track, so the
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
import { wireAlertBadge, buildAlertTooltipBlock, buildAlertTooltipText } from './alerts.js';
import { VEHICLE_ZOOM_MIN, VEHICLE_ZOOM_MAX, VEHICLE_SIZE_MIN_PX, VEHICLE_SIZE_MAX_PX } from './config.js';

const SOURCE_ID  = 'bus-bridges';
const LINE_LAYER = 'bus-bridges-line';
const HALO_LAYER = 'bus-bridges-line-halo';

/** Perpendicular offset (meters) of the bracket's parallel run from the A→B
 *  chord — also the length of the two perpendicular bracket legs. 240 m (was
 *  120) pushes the parallel run well clear of the rail polyline so the bracket
 *  reads as a distinct replacement-service shape rather than hugging the track. */
const OFFSET_METERS = 240;

// Bus-replacement language that confirms a shuttle/bridge even when Metro tags a
// PARTIAL closure as MODIFIED_SERVICE (trains still run on part of the line)
// rather than NO_SERVICE — the effect code alone misses those (e.g. the 2026-05
// B Line North Hollywood / Universal City closure with shuttle buses). Matched
// as substrings so plurals ("bus shuttles") are covered.
const _BRIDGE_TEXT_RE = /bus shuttle|shuttle bus|bus bridge|rail replacement|replacement bus/i;

// keyed by `${routeCode}|${fromStopId}|${toStopId}`
const _glyphMarkers = new Map();
let _map = null;
let _initialized = false;

// 🚌 glyph zoom-scaling. Uses the same VEHICLE_SIZE_MIN/MAX_PX ramp as rail
// markers so the bus-bridge icon stays visually proportional to vehicles at
// every zoom level. The interpolated value is the *container* (ring) size in px;
// CSS derives the emoji font-size from it at 60% so the glyph fills the ring.

/** Interpolate the glyph container size for the current zoom and publish it as a CSS var. */
function _updateGlyphSize(map) {
    const z = map.getZoom();
    let size;
    if (z <= VEHICLE_ZOOM_MIN) {
        size = VEHICLE_SIZE_MIN_PX;
    } else if (z >= VEHICLE_ZOOM_MAX) {
        size = VEHICLE_SIZE_MAX_PX;
    } else {
        const t = (z - VEHICLE_ZOOM_MIN) / (VEHICLE_ZOOM_MAX - VEHICLE_ZOOM_MIN);
        size = VEHICLE_SIZE_MIN_PX + t * (VEHICLE_SIZE_MAX_PX - VEHICLE_SIZE_MIN_PX);
    }
    document.documentElement.style.setProperty('--bus-bridge-glyph-size', `${Math.round(size)}px`);
}

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
            // A bus bridge is signalled by a NO_SERVICE effect OR by explicit
            // bus-replacement language in the alert text (catches MODIFIED_SERVICE
            // partial closures — see _BRIDGE_TEXT_RE). Combined with a run of ≥2
            // consecutive affected stops below, it's a specific signal.
            const isBridgeAlert = alert.effect === 'NO_SERVICE'
                || _BRIDGE_TEXT_RE.test(`${alert.header ?? ''} ${alert.description ?? ''}`);
            if (!isBridgeAlert) continue;
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
                                        alert,   // carried for the glyph's hover tooltip
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

// Dark casing in BOTH modes. The bridge line is WHITE (neutral — no rail route
// uses white), so it needs a dark outline to stay legible on light basemaps; on
// the dark basemap the casing is ~invisible and the white dashes read directly.
function _haloColor() {
    return '#1a1a1a';
}

function _addLayer(map) {
    if (!map.getSource(SOURCE_ID)) {
        map.addSource(SOURCE_ID, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        });
    }

    // Insert BENEATH the ArcGIS metro overlay ('imagery-layer'): the rail lines,
    // station dots and labels live in that raster (a transparent overlay on the
    // CARTO base), so dropping the bracket below it lets the network draw on top
    // — the bracket tucks under it instead of floating over, and still shows in
    // the open areas where the overlay is transparent. This also keeps it below
    // every interactive layer (the station hit layer + all DOM markers).
    //
    // After a dark-mode style swap, addCustomLayers re-adds 'imagery-layer' and
    // this re-adds the bracket; if the raster isn't back yet we omit beforeId
    // (avoids a MapLibre warning). Still correct — the bracket lands on top
    // momentarily, then addCustomLayers re-adds 'imagery-layer' above it.
    const beneath = map.getLayer('imagery-layer') ? 'imagery-layer' : undefined;

    // Dark halo casing underneath so the orange bracket reads against any basemap
    // (light pavement, parks, water) — a thin outline that keeps the line crisp at
    // any zoom without itself changing with zoom.
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
        }, beneath);
    }

    // Solid Metro-Bus ORANGE bracket on top. Orange is the LA Metro bus brand
    // color (riders recognize it from the official system map) and is distinct
    // from the G Line's red-orange (#fc4c02). Solid (not dashed) so the line
    // reads consistently at every zoom — a dasharray visibly re-tiles as you
    // zoom, which looked like the dash count was changing. `round` cap keeps the
    // solid stroke smooth at the bracket corners.
    if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
            id:     LINE_LAYER,
            type:   'line',
            source: SOURCE_ID,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint:  {
                'line-color':     '#ff8200',
                'line-width':     4,
                'line-opacity':   0.95,
            },
        }, beneath);
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
        el.textContent = '🚌';

        // Hover / focus / click tooltip, reusing the shared alert tooltip (same
        // as the station "!" badges) so the glyph explains the closure + shuttle.
        // Prefix "Bus bridge" so the title reads clearly regardless of the alert's
        // own effect label ("Modified service", etc.).
        if (b.alert) {
            const tipText = buildAlertTooltipText('Bus bridge', b.alert);
            el.dataset.alertText = tipText;
            el._alertBlocks = [buildAlertTooltipBlock('Bus bridge', b.alert)];
            el.setAttribute('aria-label', `Bus bridge: ${tipText}`);
            wireAlertBadge(el, el);
        } else {
            el.setAttribute('aria-label', 'Bus bridge replacement service');
        }

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

    // Size the glyph to the current zoom, then keep it in sync. 'zoom' fires
    // through the whole gesture for a smooth ramp (one CSS-var write per event,
    // so it's cheap regardless of glyph count).
    _updateGlyphSize(map);
    map.on('zoom', () => _updateGlyphSize(map));

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
