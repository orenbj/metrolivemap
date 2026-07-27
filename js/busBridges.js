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
 * affected station) joined by a parallel run offset 500 m (OFFSET_METERS) off the track, so the
 * bridge is visually distinct from the rail polyline beneath it.
 *
 * Layers:
 *   bus-bridges-line — solid orange bracket (no casing/outline)
 *
 * DOM markers:
 *   .bus-bridge-glyph — bus emoji at the midpoint of the offset run
 *
 * Exported:
 *   initBusBridges(map)    — install layer + listen for alertsUpdated
 *   detectBusBridges()     — pure detection; returns Array<BusBridge>
 */

import { getRouteCache } from './predictions.js';
import { normalizeStopId, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, planarMeters } from './utils.js';
import { wireAlertBadge, buildAlertTooltipBlock, buildAlertTooltipText, hideAlertTooltipForAnchor } from './alerts.js';
import { hasShapeData, snapToRoute, shapeData } from './snap.js';
import { VEHICLE_ZOOM_MIN, VEHICLE_ZOOM_MAX, VEHICLE_SIZE_MIN_PX, VEHICLE_SIZE_MAX_PX } from './config.js';

const SOURCE_ID  = 'bus-bridges';
const LINE_LAYER = 'bus-bridges-line';

/** Perpendicular offset (meters) of the bracket's parallel run from the A→B
 *  chord — also the length of the two perpendicular bracket legs. 500 m pushes
 *  the parallel run well clear of the rail polyline so the bracket reads as a
 *  distinct replacement-service shape rather than hugging the track. */
const OFFSET_METERS = 500;

/** Minimum mean rail bow (meters off the A→B chord) before the bracket flips
 *  to the far side. Below this the rail is effectively straight — a straight
 *  rail can't overlap a parallel bracket offset 500 m away regardless of side,
 *  so we keep the historical perpendicular-LEFT default for stable rendering. */
const SIDE_BOW_DEADBAND_M = 5;

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
    const now = Math.floor(Date.now() / 1000);

    for (const [routeCode, alertList] of window.masterAlertsData) {
        for (const alert of alertList) {
            // Only draw a bridge for currently-active alerts. masterAlertsData
            // retains alerts until the next 120 s poll re-clears, so it holds both
            // not-yet-started (start > now) AND just-expired (end <= now) alerts.
            // Mirror getActiveAlerts' full `start <= now && end > now` window here —
            // open-ended alerts store end = Infinity so they pass. Without the end
            // check an expired closure's bracket + 🚌 lingered up to one poll cycle
            // (indefinitely if the alerts feed dropped mid-alert).
            if (alert.activePeriod.start > now || alert.activePeriod.end <= now) continue;

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
                                // `stops[]` entries are already normalized (see normalizeStopId call above), but masterStopsData
                                // may be keyed by the un-normalized GTFS stop_id (e.g.
                                // "80111_N") depending on which pipeline built it. Try the
                                // normalized form first, then the original from cache.stops
                                // — mirrors the dual-lookup pattern used in markers.js.
                                const fromOrig = cache.stops[runStart];
                                const toOrig   = cache.stops[i - 1];
                                const fromStop = window.masterStopsData[fromId] ?? window.masterStopsData[fromOrig];
                                const toStop   = window.masterStopsData[toId]   ?? window.masterStopsData[toOrig];
                                if (fromStop && toStop) {
                                    const fromCoords = [fromStop.lon, fromStop.lat];
                                    const toCoords   = [toStop.lon,   toStop.lat];
                                    // Pick the bracket side that bows AWAY from the rail
                                    // so it overlaps the metro line the least.
                                    const side = _chooseBridgeSide(
                                        fromCoords, toCoords,
                                        _railVerticesBetween(routeCode, fromCoords, toCoords),
                                    );
                                    bridges.push({
                                        routeCode,
                                        fromStopId: fromId,
                                        toStopId:   toId,
                                        fromCoords,
                                        toCoords,
                                        side,
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

// Write the shared-alert-tooltip fields onto a glyph element from the bridge's
// alert. Shared by glyph creation and the same-side reuse path so a reused glyph
// picks up updated alert text. No-op when there's no alert. Does NOT wire
// listeners (creation does that once); the listeners read these fields live.
function _applyBridgeTooltip(el, alert) {
    if (!el || !alert) return;
    const tipText = buildAlertTooltipText('Bus bridge', alert);
    el.dataset.alertText = tipText;
    el._alertBlocks = [buildAlertTooltipBlock('Bus bridge', alert)];
    el.setAttribute('aria-label', `Bus bridge: ${tipText}`);
}

/**
 * Compute the perpendicular-left unit vector (in local meters) for the
 * A→B chord, anchored at A. Returns null for a degenerate (zero-length) chord.
 * Shared by `_chooseBridgeSide` and `_bridgePolyline` so the LA-calibrated
 * metre conversion and sign convention are defined exactly once.
 * @param {[number,number]} fromCoords [lng, lat]
 * @param {[number,number]} toCoords   [lng, lat]
 * @returns {{ lonA:number, latA:number, ux:number, uy:number } | null}
 */
function _chordPerp(fromCoords, toCoords) {
    const [lonA, latA] = fromCoords;
    const [lonB, latB] = toCoords;
    const dxM = (lonB - lonA) * M_PER_DEG_LNG_LA;
    const dyM = (latB - latA) * M_PER_DEG_LAT;
    const L   = planarMeters(latA, lonA, latB, lonB);
    if (L === 0) return null;
    return { lonA, latA, ux: -dyM / L, uy: dxM / L };
}

/**
 * Choose which side of the A→B chord the bracket should sit on so it overlaps
 * the rail polyline as little as possible.
 *
 * Given the rail shape vertices that lie between the two endpoints, measure
 * which side of the chord the rail bows toward (signed perpendicular offset,
 * with the perpendicular-LEFT normal taken as positive) and return the
 * OPPOSITE side. A rail that curves left would overlap a left-offset bracket,
 * so the bracket goes right, and vice-versa.
 *
 * Returns +1 (perpendicular-left — the historical default) when the rail is
 * effectively straight (mean bow < `SIDE_BOW_DEADBAND_M`) or no in-between
 * vertices are available.
 *
 * Pure — no MapLibre / module-state dependencies; testable.
 *
 * @param {[number, number]} fromCoords  [lng, lat] of station A
 * @param {[number, number]} toCoords    [lng, lat] of station B
 * @param {Array<[number, number]>} betweenPts  rail vertices between A and B, [lng, lat]
 * @returns {1|-1}  +1 = perpendicular-left, -1 = perpendicular-right
 */
export function _chooseBridgeSide(fromCoords, toCoords, betweenPts) {
    if (!betweenPts?.length) return 1;
    const perp = _chordPerp(fromCoords, toCoords);
    if (!perp) return 1;
    const { lonA, latA, ux, uy } = perp;

    let sum = 0;
    for (const [lon, lat] of betweenPts) {
        const px = (lon - lonA) * M_PER_DEG_LNG_LA;
        const py = (lat - latA) * M_PER_DEG_LAT;
        sum += px * ux + py * uy;   // signed distance onto the left-normal
    }
    const avgBow = sum / betweenPts.length;

    if (avgBow >  SIDE_BOW_DEADBAND_M) return -1;  // rail bows left  → bracket right
    if (avgBow < -SIDE_BOW_DEADBAND_M) return  1;  // rail bows right → bracket left
    return 1;                                       // ~straight → historical default
}

/**
 * Rail shape vertices strictly between two endpoints, as [lng, lat] pairs.
 * Returns [] when the route has no shape data or either endpoint fails to snap.
 * Used to feed `_chooseBridgeSide`.
 *
 * @param {string} routeCode
 * @param {[number, number]} fromCoords  [lng, lat]
 * @param {[number, number]} toCoords    [lng, lat]
 * @returns {Array<[number, number]>}
 */
function _railVerticesBetween(routeCode, fromCoords, toCoords) {
    if (!hasShapeData(routeCode)) return [];
    const a = snapToRoute(routeCode, fromCoords[0], fromCoords[1]);
    const b = snapToRoute(routeCode, toCoords[0], toCoords[1]);
    if (!a || !b) return [];

    const pts = shapeData[routeCode];          // [lat, lng] pairs
    const lo  = Math.min(a.arcIndex, b.arcIndex);
    const hi  = Math.max(a.arcIndex, b.arcIndex);
    const out = [];
    // Vertices between the two snapped segments trace the rail's curve; convert
    // the stored [lat, lng] to the [lng, lat] the bracket math expects.
    for (let i = lo + 1; i <= hi; i++) out.push([pts[i][1], pts[i][0]]);
    return out;
}

/**
 * Compute the bracket polyline for a bus bridge between two stations.
 *
 * Returns a 4-vertex polyline [A, A_off, B_off, B] where A_off / B_off sit
 * `offsetMeters` perpendicular to A→B. `side` picks which perpendicular
 * direction: +1 = left (default), -1 = right (see `_chooseBridgeSide`). The bus
 * icon goes at the midpoint of the offset run (A_off → B_off), clear of the track.
 *
 * Pure — no MapLibre dependencies; testable.
 *
 * @param {[number, number]} fromCoords  [lng, lat] of station A
 * @param {[number, number]} toCoords    [lng, lat] of station B
 * @param {number} [offsetMeters=OFFSET_METERS]
 * @param {1|-1}   [side=1]  +1 = perpendicular-left, -1 = perpendicular-right
 * @returns {{ coords: [number,number][], midpoint: [number,number] } | null}
 *          null for degenerate (zero-length) input
 */
export function _bridgePolyline(fromCoords, toCoords, offsetMeters = OFFSET_METERS, side = 1) {
    const [lonA, latA] = fromCoords;
    const [lonB, latB] = toCoords;

    const perp = _chordPerp(fromCoords, toCoords);
    if (!perp) return null;

    // `side` flips the perpendicular direction left↔right.
    const offLng = (perp.ux * side * offsetMeters) / M_PER_DEG_LNG_LA;
    const offLat = (perp.uy * side * offsetMeters) / M_PER_DEG_LAT;

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
        const poly = _bridgePolyline(b.fromCoords, b.toCoords, OFFSET_METERS, b.side);
        if (!poly) continue;
        features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: poly.coords },
            properties: { routeCode: b.routeCode, alertId: b.alertId },
        });
    }
    return { type: 'FeatureCollection', features };
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

    // Solid Metro-Bus ORANGE bracket. Orange is the LA Metro bus brand color
    // (riders recognize it from the official system map) and is distinct from
    // the G Line's red-orange (#fc4c02). Solid (not dashed) so the line reads
    // consistently at every zoom — a dasharray visibly re-tiles as you zoom,
    // which looked like the dash count was changing. `round` cap keeps the solid
    // stroke smooth at the bracket corners. No casing/outline — the saturated
    // orange reads on its own against both basemaps.
    if (!map.getLayer(LINE_LAYER)) {
        map.addLayer({
            id:     LINE_LAYER,
            type:   'line',
            source: SOURCE_ID,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint:  {
                'line-color':     '#ff8200',
                'line-width':     3,
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
            // Drop the shared alert tooltip if it's pinned to this glyph, so it
            // isn't orphaned to the viewport corner after the marker is gone.
            hideAlertTooltipForAnchor(marker.getElement?.());
            marker.remove();
            _glyphMarkers.delete(key);
        }
    }

    // Add new / reposition when the side changed (e.g. shapes loaded after first render).
    // The GeoJSON line is always updated above via src.setData(); the glyph must
    // follow — otherwise it sits at the old midpoint on the wrong side of the track.
    for (const b of bridges) {
        const key     = _bridgesKey(b);
        const existing = _glyphMarkers.get(key);
        if (existing) {
            if (existing._bridgeSide === b.side) {
                // Same segment + side → reuse the glyph, but REFRESH its tooltip:
                // _bridgesKey omits alert content, so an updated alert (new end
                // date, changed shuttle instructions, or a different alert over the
                // same stop run) keeps the same key. The bound tooltip listeners
                // read dataset.alertText / _alertBlocks live at hover, so updating
                // them here is enough — no re-wiring needed.
                _applyBridgeTooltip(existing.getElement?.(), b.alert);
                continue;
            }
            hideAlertTooltipForAnchor(existing.getElement?.());
            existing.remove();                                // side changed — recreate
            _glyphMarkers.delete(key);
        }

        // Place the bus glyph on the offset run (between A_off and B_off), so
        // it sits clear of the rail track rather than on top of it.
        const poly = _bridgePolyline(b.fromCoords, b.toCoords, OFFSET_METERS, b.side);
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
            _applyBridgeTooltip(el, b.alert);
            wireAlertBadge(el, el);
        } else {
            el.setAttribute('aria-label', 'Bus bridge replacement service');
        }

        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([midLng, midLat])
            .addTo(map);
        marker._bridgeSide = b.side;   // track side so we can detect changes
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
