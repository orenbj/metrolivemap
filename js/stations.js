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

import { routeIcons, routeHexColors, routeDirectionLabels, STATION_MERGE_RADIUS_M, STATION_POPUP_REFRESH_MS, PAST_ARRIVAL_GRACE_S, FEED_STALE_THRESHOLD_S, METRO_ROUTE_CODES } from './config.js';
import { cleanDestination } from './ui.js';
import { planarMeters, cleanStationName, escHtml as esc, setVisibleInterval, computeBearing } from './utils.js';
import { getScheduledArrivals, getTerminalName, isOriginStop, isTerminalStop, isNearTerminalStop, getBoardingVehicles, getAllOriginStops, getRouteCache, resolveTripDestination } from './predictions.js';
import { STRIP_EFFECT_LABELS, getActiveAlerts, getActiveStopAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, wireAlertBadge, buildAlertTooltipText, buildAlertTooltipBlock } from './alerts.js';
import { getNearbyBikeStation } from './bikeshare.js';
import { tripTerminusByTripId, getTripUpdatesFeedHealth } from './tripUpdates.js';
import { snapToRoute, hasShapeData, lngLatAtArc, arcLengths } from './snap.js';

const STATION_SOURCE = 'metro-stations';
const CLICK_LAYER    = 'metro-stations-click';

const RAIL_STOP_RE = /^8\d{4,5}$/;
const GJ_DEST_RE   = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;

const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C',
    '804': 'E', '805': 'D',
    '807': 'K', '901': 'G', '910': 'J',
    '950': 'J',
};

/**
 * Map a `classifyAccessibilityAlert` result to a localized facility label.
 * Three usage sites (popup banner, badge aria-label, badge update) — keeping
 * the lookup in one place ensures translations and casing stay consistent.
 * @param {'elevator'|'escalator'|'both'|null|undefined} type
 * @returns {string}
 */
function _accessFacilityLabel(type) {
    if (type === 'elevator')  return 'Elevator outage';
    if (type === 'escalator') return 'Escalator outage';
    if (type === 'both')      return 'Elevator & escalator outage';
    return 'Accessibility outage';
}

/**
 * Render an alert description paragraph. The LACMTA service-alerts feed is
 * English-only (no `translations` field on any sampled alert), so the page
 * marks each body `lang="en"` explicitly. That signals both screen readers
 * AND browser translators (Chrome / Edge / Safari built-in, or the
 * "Translate" link in the legend that opens Google Translate) to handle
 * the prose alongside the rest of the page — the rider sees alerts in
 * their language without an in-app dictionary.
 *
 * @param {string} text  Raw description text from the alerts feed.
 * @returns {string} HTML string.
 */
function _alertBodyHTML(text) {
    return `<p lang="en">${esc(text)}</p>`;
}

let activePopup = null;
let activePopupRefreshTimer = null;
let activePopupStopIds = null;
let _activeMap = null;
// Element that triggered the last pinned popup open — focus returns here on close.
let _popupTriggerEl = null;
// Tracks which marker elements are currently highlighted so we can un-highlight
// them without an O(n) querySelectorAll scan on every popup refresh tick.
const _highlightedMarkerEls = new Set();
/**
 * Central registry of clickable station dots. Each entry represents one merged
 * group of stops (transfer stations are coalesced into a single dot).
 * Also exposed as window.stationGroups for bike share hover lookups.
 * @type {Array<{ normName: string, displayName: string, lat: number, lon: number, stopIds: string[] }>}
 */
export const stationGroups = [];
window.stationGroups = stationGroups; // shared read-only reference for bikeshare.js

// ── Name helpers ──────────────────────────────────────────────────────────────

function toDisplayName(normalized) {
    const stripped = normalized.replace(/\s+Station\s*$/i, '').trim();
    return stripped.length >= 6 ? stripped : normalized;
}

// ── Group registry ────────────────────────────────────────────────────────────

// Map index for O(1) name-based lookups in findGroup / addToRegistry.
// Kept in sync with stationGroups on every push.
const _groupByName = new Map();

function findGroup(normName, lat, lon) {
    const candidate = _groupByName.get(normName);
    if (!candidate) return undefined;
    return planarMeters(candidate.lat, candidate.lon, lat, lon) < STATION_MERGE_RADIUS_M
        ? candidate : undefined;
}

// isBusway=true adds a proximity-only fallback for different-name transfers.
function addToRegistry(stopId, stop, isBusway = false) {
    // Stop IDs come from multiple feeds (stops.json, trip_updates, vehicle
    // properties) and arrive as a mix of strings and numbers. Normalize at
    // the registry entry point so every downstream `.includes()` and `.get()`
    // can assume strings — eliminates the three call sites that previously
    // coerced inconsistently (stations.js:652, 1062, 1358).
    const sid = String(stopId);
    const normName = cleanStationName(stop.name, false);
    let existing = findGroup(normName, stop.lat, stop.lon);
    if (!existing && isBusway) {
        existing = stationGroups.find(g =>
            planarMeters(g.lat, g.lon, stop.lat, stop.lon) < STATION_MERGE_RADIUS_M
        );
    }
    if (existing) {
        if (!existing.stopIds.includes(sid)) existing.stopIds.push(sid);
        return false;
    }
    const group = {
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [sid],
        displayName: toDisplayName(normName),
    };
    stationGroups.push(group);
    _groupByName.set(normName, group);
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
            paint: { 'circle-radius': 18, 'circle-opacity': 0, 'circle-stroke-width': 0 },
        });
    }
}

/**
 * Re-add the station GeoJSON source and click layer after a dark mode style swap.
 * @param {maplibregl.Map} map MapLibre map instance (post-swap)
 */
export function reAddStationLayer(map) {
    _addStationSourceAndLayer(map);
}

/**
 * Rebuild stationGroups from the (possibly reloaded) masterStopsData and
 * masterTripsData and push the new feature collection into the map layer.
 * Called when GTFS data reloads at midnight — without this, the map dots
 * stay pinned to yesterday's station list.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export function _rebuildStationGroups(map) {
    if (!window.masterStopsData) return;
    stationGroups.length = 0;
    Object.entries(window.masterStopsData).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!stop.lat || !stop.lon) return;
        addToRegistry(stopId, stop);
    });
    addBuswayStopsFromTrips(map);
    if (map?.getSource?.(STATION_SOURCE)) {
        map.getSource(STATION_SOURCE).setData({
            type: 'FeatureCollection',
            features: groupsToFeatures(),
        });
    }
}

// ── Public ────────────────────────────────────────────────────────────────────

/**
 * Build the station registry from window.masterStopsData, render clickable dots,
 * and wire hover/click handlers. Phase 1 handles rail stops (8xxxxx IDs);
 * Phase 2 adds G/J busway stops derived from trip data.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export function initStations(map) {
    if (!window.masterStopsData) return;

    // Phase 1: rail stops
    Object.entries(window.masterStopsData).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
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
            if (!Number.isFinite(stop?.lat) || !Number.isFinite(stop?.lon)) return;
            addToRegistry(sid, stop, true);
        });
    });

    _addStationSourceAndLayer(map);
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

/**
 * Close the active station arrivals popup (if any) and clear its refresh timer.
 */
export function closeStationPopup() {
    if (activePopupRefreshTimer) {
        clearInterval(activePopupRefreshTimer);
        activePopupRefreshTimer = null;
    }
    if (activePopup) { activePopup.remove(); activePopup = null; }
    activePopupStopIds = null;
    clearVehicleHighlights();
    _activeMap = null;
    // Return focus to the element that opened the popup (keyboard/a11y).
    if (_popupTriggerEl) {
        _popupTriggerEl.focus?.();
        _popupTriggerEl = null;
    }
}

function showArrivalsPopup(map, coords, stopIds, stopName, pinned = false) {
    // Remember what had focus before opening so we can restore it on close.
    // closeStationPopup() nulls _popupTriggerEl, so capture the element first
    // and re-assign after the close so the next Escape returns focus correctly.
    const triggerEl = pinned ? document.activeElement : null;
    closeStationPopup();
    if (triggerEl) _popupTriggerEl = triggerEl;
    _activeMap = map;
    activePopupStopIds = stopIds;
    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(buildArrivalsHTML(stopIds, stopName)) // safe: all feed-derived values go through esc() — see buildArrivalsHTML
        .addTo(map);
    activePopup.isPinned = pinned;

    // a11y: mark popup container as a dialog and move focus in.
    const popupEl = activePopup.getElement?.();
    if (popupEl) {
        popupEl.setAttribute('role', 'dialog');
        popupEl.setAttribute('aria-label', 'Station details');
        if (pinned) {
            // Move focus to the close button (or the popup itself as fallback).
            const closeBtn = popupEl.querySelector('.maplibregl-popup-close-button');
            setTimeout(() => (closeBtn ?? popupEl).focus?.(), 0);
        }
    }

    // Eagerly clear any prior timer — if showArrivalsPopup is called before
    // the previous popup's 'close' handler fires (e.g. a fast hover-then-pin
    // sequence, or a programmatic popup replacement), the old timer would
    // otherwise keep ticking on a detached DOM node.
    if (activePopupRefreshTimer) clearInterval(activePopupRefreshTimer);
    // setVisibleInterval pauses when the tab is hidden — avoids re-running
    // buildArrivalsHTML + DOM diff against an invisible popup. Every other
    // recurring timer in the project uses this same wrapper.
    activePopupRefreshTimer = setVisibleInterval(() => {
        // Self-cancel if the popup has been removed by any path that didn't
        // run the close handler (e.g. direct popup.remove() from elsewhere).
        if (!activePopup || !activePopup.isOpen?.() || !activePopup.getElement()?.isConnected) {
            clearInterval(activePopupRefreshTimer);
            activePopupRefreshTimer = null;
            return;
        }
        try {
            const el = activePopup.getElement();
            const content = el?.querySelector('.maplibregl-popup-content');
            if (!content) return;
            const newHTML = buildArrivalsHTML(stopIds, stopName);
            const currentWrap = content.querySelector('.station-popup-wrap');
            if (currentWrap) {
                const div = document.createElement('div');
                div.innerHTML = newHTML; // safe: newHTML comes from buildArrivalsHTML
                const fresh = div.querySelector('.station-popup-wrap');
                if (fresh && fresh.innerHTML !== currentWrap.innerHTML) {
                    // Preserve open state of all <details> elements across re-renders.
                    // Without this, the bus section and any expanded service alerts
                    // snap closed every STATION_POPUP_REFRESH_MS tick.
                    const wasBusOpen = currentWrap.querySelector('.sp-bus-details')?.open;
                    if (wasBusOpen) {
                        const freshBus = fresh.querySelector('.sp-bus-details');
                        if (freshBus) freshBus.open = true;
                    }
                    // Preserve individually-expanded alert <details> by alert id.
                    currentWrap.querySelectorAll('.sp-banner[open]').forEach(el => {
                        const id = el.dataset.alertId;
                        if (!id) return;
                        const match = fresh.querySelector(`.sp-banner[data-alert-id="${id}"]`);
                        if (match) match.open = true;
                    });
                    currentWrap.replaceWith(fresh);
                }
            } else {
                activePopup.setHTML(newHTML);
            }
        } catch (err) {
            console.warn('[stations] Popup refresh error:', err);
        }
    }, STATION_POPUP_REFRESH_MS, 'stations:popup-refresh');

    activePopup.on('close', () => {
        if (activePopupRefreshTimer) {
            clearInterval(activePopupRefreshTimer);
            activePopupRefreshTimer = null;
        }
        _activeMap = null;
        activePopup = null;
        activePopupStopIds = null;
        clearVehicleHighlights();
        // Return focus to trigger element if set (a11y).
        if (_popupTriggerEl) {
            _popupTriggerEl.focus?.();
            _popupTriggerEl = null;
        }
    });
}

function clearVehicleHighlights() {
    for (const el of _highlightedMarkerEls) {
        el.classList.remove('debug-highlight-vehicle');
    }
    _highlightedMarkerEls.clear();
}

function applyVehicleHighlights(vidSet) {
    // Un-highlight elements no longer in the desired set.
    for (const el of _highlightedMarkerEls) {
        const vid = el.getAttribute('data-vehicle-id');
        if (!vidSet.has(vid)) {
            el.classList.remove('debug-highlight-vehicle');
            _highlightedMarkerEls.delete(el);
        }
    }
    // Highlight elements newly in the desired set.
    // vehicleMarkers is keyed by trip_id; iterate markers to find matching elements.
    if (vidSet.size) {
        for (const marker of Object.values(window.vehicleMarkers ?? {})) {
            const vid = marker.properties?.vehicle_id;
            if (!vid || !vidSet.has(String(vid))) continue;
            const el = marker.getElement?.();
            if (!el) continue;
            if (!el.classList.contains('debug-highlight-vehicle')) {
                el.classList.add('debug-highlight-vehicle');
            }
            _highlightedMarkerEls.add(el);
        }
    }
}

function buildArrivalsHTML(stopIds, stopName) {
    const now = Math.floor(Date.now() / 1000);

    // Boarding vehicles at origin stops — used for departure pills on origin rows.
    // getBoardingVehicles is more reliable than getScheduledArrivals here because
    // getScheduledArrivals suppresses calc ETA for STOPPED_AT origin vehicles.
    const boardingAtOrigin = getBoardingVehicles(stopIds);

    // Cross-stop_id dedup: transfer stations have multiple platform stop_ids,
    // and the same trip can land in masterArrivalsData under several of them.
    // tripId is the canonical GTFS identity — key by it always. The previous
    // mixed key (vehicleId-routeId when present, tripId otherwise) split the
    // same trip across two namespaces when one frame had vehicleId set and
    // another didn't, producing duplicate "Now" pills on the popup. When
    // duplicates collide, keep the earliest arrivalUnix (the soonest arrival
    // is what the rider standing at the transfer cares about).
    const byTripKey = new Map();
    stopIds.forEach(sid => {
        getScheduledArrivals(sid).forEach(a => {
            if (a.arrivalUnix < now - PAST_ARRIVAL_GRACE_S) return;
            const key = a.tripId || `vid:${a.vehicleId}-${a.routeId}`;
            const prev = byTripKey.get(key);
            if (!prev || a.arrivalUnix < prev.arrivalUnix) byTripKey.set(key, a);
        });
    });
    const arrivals = [...byTripKey.values()];
    arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    const name = stopName || stopIds[0];

    if (!arrivals.length && !boardingAtOrigin.length) {
        clearVehicleHighlights();
        return `<div class="station-popup-wrap">
            <div class="station-popup-name">${esc(name)}</div>
            <div class="station-popup-empty">No upcoming arrivals</div>
        </div>`;
    }

    // Routes rendered in the top "rail" section: true rail (801–807) plus
    // rail-like rapid bus corridors (G/J Lines). Anything else — local city buses
    // whose stopId happens to be folded into this station group — flows into the
    // NEARBY BUSES section below, never the top section.
    // 806 (L Line) is retired/merged and has no icon, color, or direction-label
    // entries in config.js — METRO_ROUTE_CODES omits it so orphaned arrivals
    // can't create broken rows.

    // Group by routeId → directionId
    const routeMap = new Map();
    arrivals.forEach(a => {
        if (!METRO_ROUTE_CODES.has(a.routeId)) return;
        if (!routeMap.has(a.routeId)) routeMap.set(a.routeId, { 0: [], 1: [] });
        // directionId from the feed may be null for malformed trip_updates.
        // Critical: do NOT silently default to 0 — that renders a SB train in
        // the NB column, and a rider may board going the wrong way. Render
        // unknown-direction arrivals in BOTH columns so the train appears
        // somewhere visible; better duplicated than misclassified.
        if (a.directionId === 0) {
            routeMap.get(a.routeId)[0].push(a);
        } else if (a.directionId === 1) {
            routeMap.get(a.routeId)[1].push(a);
        } else {
            routeMap.get(a.routeId)[0].push(a);
            routeMap.get(a.routeId)[1].push(a);
        }
    });
    // Seed routeMap with routes that only appear in boardingAtOrigin (no arrivals from
    // getScheduledArrivals). Without this, renderRow is never called for those routes
    // and boarding pills are silently dropped.
    boardingAtOrigin.forEach(b => {
        if (!METRO_ROUTE_CODES.has(b.routeId)) return;
        if (!routeMap.has(b.routeId)) routeMap.set(b.routeId, { 0: [], 1: [] });
    });

    // Seed routeMap with any RAIL_LIKE_ROUTE that serves this station as a
    // mid-route through stop (not origin, not terminal). This ensures a route
    // row appears even when no live vehicles are currently tracking — e.g. the
    // 950 southbound San Pedro direction at Harbor Gateway TC when no 950s are
    // active. Rows whose direction turns out to be terminal are still suppressed
    // by isTerminalStop inside renderRow.
    for (const routeId of METRO_ROUTE_CODES) {
        if (routeMap.has(routeId)) continue;
        for (const dir of [0, 1]) {
            const cache = getRouteCache(routeId, dir);
            if (!cache?.stops) continue;
            if (!stopIds.some(sid => cache.stops.includes(sid))) continue;
            // Only seed mid-route stops — origins are covered by boardingAtOrigin
            // and terminals are suppressed by renderRow anyway.
            if (isOriginStop(stopIds, routeId, dir) || isTerminalStop(stopIds, routeId, dir)) continue;
            routeMap.set(routeId, { 0: [], 1: [] });
            break;
        }
    }

    // Highlight only the closest vehicle per direction.
    // vehicleId may be "" when the GTFS-RT trip_update omitted vehicle.id;
    // in that case fall back to looking up the marker by tripId (markers are
    // keyed by trip_id in window.vehicleMarkers).
    const shownVids = new Set();
    routeMap.forEach(dirs => {
        [0, 1].forEach(dirIdx => {
            const first = (dirs[dirIdx] || [])[0];
            if (!first) return;
            const vid = first.vehicleId ||
                window.vehicleMarkers?.[first.tripId]?.properties?.vehicle_id;
            if (vid) shownVids.add(String(vid));
        });
    });
    applyVehicleHighlights(shownVids);

    // Track destinations already rendered so empty cache-seeded rows don't echo
    // a terminal already shown by a live-arrival row from another route (e.g. the
    // 950 El Monte direction duplicating the 910 El Monte row at Harbor Gateway TC).
    const shownDestinations = new Set();

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

        // Shared cascade (predictions.resolveTripDestination): structural →
        // live-dest → last-stop → live-terminus. Owned in predictions.js so
        // the vehicle popup (ui.js) uses the same ordering — previously each
        // call site had its own cascade with subtly different priorities.
        const resolveTerminus = (dirIdx, tripInfo, tripId) => {
            const cleanedDest = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
            const t = resolveTripDestination(routeId, dirIdx, tripId, tripInfo, cleanedDest);
            return t ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
        };

        const renderRow = (dirIdx, showBadge) => {
            const list = dirs[dirIdx] || [];
            const isTerminal = isTerminalStop(stopIds, routeId, dirIdx);

            // At terminus stations, trains are arriving — skip the row to keep popups clean
            if (isTerminal) return '';

            // Suppress empty direction rows at near-terminal stops (last stop before terminal).
            // A rider at Pacific/11th doesn't need to see "San Pedro" as a destination since
            // they're already in San Pedro. Live-arrival rows are always shown regardless.
            if (!list.length && !isOriginStop(stopIds, routeId, dirIdx) && isNearTerminalStop(stopIds, routeId, dirIdx)) return '';

            // Destination label
            let dest = '';
            if (list.length) {
                const firstTripId = list[0].tripId;
                const tripInfo    = firstTripId ? window.masterTripsData?.[firstTripId] : null;
                dest = resolveTerminus(dirIdx, tripInfo, firstTripId);
            } else {
                dest = getTerminalName(routeId, dirIdx) ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
            }

            // Suppress empty (no live arrivals) non-origin rows whose destination is
            // already shown by a prior row — prevents the 950 El Monte direction from
            // duplicating the 910 El Monte row at Harbor Gateway TC, and avoids two
            // identical "El Monte —" rows when both 910 and 950 have no northbound data.
            if (!list.length && !isOriginStop(stopIds, routeId, dirIdx) && dest && shownDestinations.has(dest)) return '';

            // Pills — origin stops show departure times from getBoardingVehicles,
            // supplemented by approaching trains from getScheduledArrivals (deduped by tripId).
            // Sort ascending by time so the soonest pill is always on the left.
            let pillsHTML = '';
            if (isOriginStop(stopIds, routeId, dirIdx)) {
                const boarding = boardingAtOrigin
                    .filter(b => b.routeId === routeId && b.directionId === dirIdx);
                const boardingTripIds = new Set(boarding.map(b => b.tripId).filter(Boolean));
                // Include approaching trains not yet boarding (within 10 min) from scheduled list
                const approaching = list
                    .filter(a => !boardingTripIds.has(a.tripId) && (a.arrivalUnix - now) <= 600)
                    .map(a => ({ ...a, departureUnix: a.arrivalUnix }));
                const merged = [...boarding, ...approaching]
                    .sort((a, b) => (a.departureUnix ?? Infinity) - (b.departureUnix ?? Infinity));
                pillsHTML = merged.slice(0, 2).map(b => {
                    const secAway = b.departureUnix != null ? Math.round(b.departureUnix - now) : -1;
                    const isNow   = secAway < 0 || secAway < 30;
                    const timeStr = isNow ? 'Now'
                                  : secAway < 60 ? '30s'
                                  : `${Math.floor(secAway / 60)}m`;
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${timeStr}</span>`;
                }).join('');
                if (!pillsHTML) pillsHTML = `<span class="sp-no-data">—</span>`;
            } else if (list.length) {
                const sorted = [...list].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                pillsHTML = sorted.slice(0, 2).map(a => {
                    const secAway = Math.round(a.arrivalUnix - now);
                    const isNow   = secAway < 30;
                    const timeStr = isNow ? 'Now'
                                  : secAway < 60 ? '30s'
                                  : `${Math.floor(secAway / 60)}m`;
                    const lastTag = window.masterTripsData?.[a.tripId]?.isLast ? `<span class="pill-last">LAST</span>` : '';
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${timeStr}${lastTag}</span>`;
                }).join('');
            } else {
                pillsHTML = `<span class="sp-no-data">—</span>`;
            }

            // Skip completely empty rows (terminal side with no arrivals)
            if (!dest && !pillsHTML) return '';

            const iconSrc = routeIcons[routeId] ?? '';
            const badge = showBadge
                ? `<img src="${iconSrc}" class="sp-route-icon" alt="${letter}">`
                : `<div class="sp-badge-gap"></div>`;

            if (dest) shownDestinations.add(dest);
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

        // Per-route service alerts now render once at the top of the popup
        // (sp-alerts-section, built above) instead of duplicating under each
        // route block.
        return `<div class="sp-route">${row1}${row2}</div>`;
    }).join('');

    // Bike share section — find the nearest station within 160 m of this group.
    // 120 m missed several legitimate stations (e.g. Wilshire/La Cienega at 135 m)
    // because Metro Bike docks are sometimes placed at the far end of a large plaza.
    // Coerce to String to honor the registry invariant (addToRegistry stores
    // stopIds as strings). Callers reaching here may pass numbers, especially
    // from feed-derived integer ids.
    const group = stationGroups.find(g => stopIds.some(id => g.stopIds.includes(String(id))));
    let bikeHTML = '';
    if (group) {
        const bs = getNearbyBikeStation(group.lat, group.lon, 160);
        if (bs) {
            const total = (bs.bikes || 0) + (bs.ebikes || 0);
            const docks = bs.docks || 0;
            const segs = [];
            if (bs.ebikes) segs.push(`<span class="sp-bike-seg" style="--bc:#2563eb">${bs.ebikes}<span class="sp-bike-lbl">e-bike</span></span>`);
            if (bs.bikes)  segs.push(`<span class="sp-bike-seg" style="--bc:#16a34a">${bs.bikes}<span class="sp-bike-lbl">bike</span></span>`);
            if (!total)    segs.push(`<span class="sp-bike-seg" style="--bc:#9ca3af">0<span class="sp-bike-lbl">bikes</span></span>`);
            segs.push(`<span class="sp-bike-seg" style="--bc:#9ca3af">${docks}<span class="sp-bike-lbl">dock</span></span>`);
            bikeHTML = `<div class="sp-bike-row"><span class="sp-bike-icon">🚲</span>${segs.join('')}</div>`;
        }
    }

    // Nearby buses section — bus routes serving stops within 0.1 mi (~160 m).
    // Skips rail route_codes (8xx) and any route already shown above (e.g. G/J
    // when a busway stop is folded into this rail station). Grouped by route:
    // each route block shows up to 2 direction rows (badge on first row,
    // gap on second), each row carrying its own destination + pill ETAs.
    let busHTML = '';
    if (group) {
        const NEARBY_BUS_MAX_ROUTES = 6;
        const ownRoutes = new Set(routeMap.keys());
        // routeId → { 0: arrivals[], 1: arrivals[] }
        const byRoute = new Map();
        // Per-slot seen-tripId Sets to avoid O(n²) dedup inside the inner loop.
        const slotSeen = new Map(); // `${routeId}:${dir}` → Set<tripId>
        for (const { stopId } of getNearbyBusStops(group.lat, group.lon, 200)) {
            const list = window.masterArrivalsData?.get(stopId) ?? [];
            for (const a of list) {
                if (a.arrivalUnix < now - PAST_ARRIVAL_GRACE_S) continue;
                if (ownRoutes.has(a.routeId)) continue;
                if (/^8\d{2}$/.test(a.routeId)) continue;   // skip rail
                const dir = a.directionId ?? 0;
                if (!byRoute.has(a.routeId)) byRoute.set(a.routeId, { 0: [], 1: [] });
                const slotKey = `${a.routeId}:${dir}`;
                if (!slotSeen.has(slotKey)) slotSeen.set(slotKey, new Set());
                const seen = slotSeen.get(slotKey);
                if (seen.has(a.tripId)) continue;
                seen.add(a.tripId);
                byRoute.get(a.routeId)[dir].push(a);
            }
        }
        const totalRouteCount = byRoute.size;
        if (byRoute.size) {
            // Rank routes by soonest upcoming arrival (across both directions)
            // so when the NEARBY_BUS_MAX_ROUTES cap truncates a major hub the
            // surviving routes are the ones most useful right now. Stable
            // tiebreakers (route number, then string) keep order deterministic
            // across the 5 s refresh cycle when ETAs are equal or both rounded
            // to the same Unix second.
            const routeIdSortKey = (id) => {
                const n = parseInt(id, 10);
                return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
            };
            const ranked = [...byRoute.entries()].map(([routeId, dirs]) => {
                dirs[0].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                dirs[1].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                const soonest = Math.min(
                    dirs[0][0]?.arrivalUnix ?? Infinity,
                    dirs[1][0]?.arrivalUnix ?? Infinity,
                );
                return { routeId, dirs, soonest };
            }).sort((a, b) =>
                a.soonest - b.soonest
                || routeIdSortKey(a.routeId) - routeIdSortKey(b.routeId)
                || String(a.routeId).localeCompare(String(b.routeId))
            ).slice(0, NEARBY_BUS_MAX_ROUTES);

            // Resolve a bus arrival's destination label. Riders pick a bus by
            // where it's going far more often than by compass bearing, so the
            // terminus stop name leads ("to Pioneer") with the cardinal as a
            // small disambiguator ("· E"). The cardinal is 8-bucket — see
            // compute8Cardinal — so diagonal routes don't get squashed into the
            // wrong cardinal axis. Full route long_name stays in the title
            // attribute for hover.
            //
            // Returns:
            //   labelHTML  — safe-escaped HTML for the primary row label
            //   title      — plain-text hover title (full terminus + long_name)
            //   cardinal   — 'N'|'NE'|…|'NW'|null  (used to sort dir rows N→…→NW)
            const resolveBusDest = (tripId, routeMeta) => {
                let labelHTML = '';
                let titleParts = [];
                let cardinal = null;
                if (tripId) {
                    const termStopId = tripTerminusByTripId?.get(String(tripId));
                    if (termStopId) {
                        const stop = window.masterStopsData?.[String(termStopId)];
                        if (stop) {
                            cardinal = compute8Cardinal(group.lat, group.lon, stop.lat, stop.lon);
                            const stopName = stop.name ? cleanStationName(stop.name) : null;
                            if (stopName && cardinal) {
                                labelHTML = `to ${esc(stopName)}<span class="sp-bus-cardinal"> · ${cardinal}</span>`;
                                titleParts.push(`to ${stopName}`);
                            } else if (stopName) {
                                labelHTML = `to ${esc(stopName)}`;
                                titleParts.push(`to ${stopName}`);
                            } else if (cardinal) {
                                labelHTML = esc(CARDINAL_FULL_WORDS[cardinal]);
                            }
                        }
                    }
                }
                if (routeMeta?.long_name?.trim()) {
                    titleParts.push(routeMeta.long_name.trim());
                    if (!labelHTML) labelHTML = esc(routeMeta.long_name.trim());
                }
                return { labelHTML, title: titleParts.join(' · '), cardinal };
            };

            const renderBusRow = (routeId, arrivals, badgeHTML, dest) => {
                if (!arrivals.length) return '';
                const pills = arrivals.slice(0, 2).map(a => {
                    const secAway = Math.round(a.arrivalUnix - now);
                    const isNow   = secAway < 30;
                    const time    = isNow ? 'Now'
                                  : secAway < 60 ? '30s'
                                  : `${Math.floor(secAway / 60)}m`;
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${time}</span>`;
                }).join('');
                const destHTML = dest.labelHTML
                    ? `<div class="sp-dest sp-bus-dest" title="${esc(dest.title)}">${dest.labelHTML}</div>`
                    : `<div class="sp-dest sp-bus-dest sp-dest-empty">—</div>`;
                return `<div class="sp-row sp-bus-row">
                    ${badgeHTML}
                    ${destHTML}
                    <div class="sp-pills">${pills}</div>
                </div>`;
            };

            // Cardinal sort order N→NE→E→SE→S→SW→W→NW for stable row ordering
            // within each route. Non-cardinal (terminus-name fallback / no data)
            // rows sort last.
            const CARDINAL_ORDER = { N: 0, NE: 1, E: 2, SE: 3, S: 4, SW: 5, W: 6, NW: 7 };

            const items = ranked.map(({ routeId, dirs }) => {
                const meta  = window.masterBusRoutes?.[routeId];
                const short = meta?.short_name ?? routeId;
                const title = meta?.long_name ? ` title="${esc(meta.long_name)}"` : '';
                const badge = `<span class="sp-bus-badge"${title}>${esc(short)}</span>`;
                const gap   = `<div class="sp-bus-badge-gap"></div>`;
                const dest0 = resolveBusDest(dirs[0][0]?.tripId, meta);
                const dest1 = resolveBusDest(dirs[1][0]?.tripId, meta);
                const ord0  = CARDINAL_ORDER[dest0.cardinal] ?? 8;
                const ord1  = CARDINAL_ORDER[dest1.cardinal] ?? 8;
                const [firstDir, secondDir, firstDest, secondDest] =
                    ord0 <= ord1 ? [0, 1, dest0, dest1] : [1, 0, dest1, dest0];
                const row1 = renderBusRow(routeId, dirs[firstDir],  badge,             firstDest);
                const row2 = renderBusRow(routeId, dirs[secondDir], row1 ? gap : badge, secondDest);
                return row1 + row2;
            }).join('');
            // <details> renders the bus list collapsed by default. Browser
            // manages open/closed state natively; the popup refresh path
            // (showArrivalsPopup) preserves it across re-renders.
            // Show "X of Y" only when the cap truncated the list so users know
            // more routes exist beyond what's visible.
            const countLabel = totalRouteCount > NEARBY_BUS_MAX_ROUTES
                ? `${ranked.length} of ${totalRouteCount}`
                : `${ranked.length}`;
            busHTML = `<details class="sp-bus-details">
                <summary class="sp-bus-summary">
                    <span class="sp-bus-summary-label">Nearby buses</span>
                    <span class="sp-bus-count">${countLabel}</span>
                </summary>
                <div class="sp-bus-list">${items}</div>
            </details>`;
        }
    }

    // Stale-feed banner: when the trip_updates WS for a feed this popup depends
    // on has been silent past FEED_STALE_THRESHOLD_S, surface it so users know
    // displayed ETAs may not reflect ground truth. Rail feed is needed whenever
    // any METRO_ROUTE_CODES row was rendered; bus feed is needed when the nearby
    // buses block exists. Boot-time zero is treated as fresh (no false alarm
    // before the first frame arrives).
    const _feedHealth = getTripUpdatesFeedHealth();
    const _showsRail  = routeMap.size > 0;
    const _showsBus   = !!busHTML;
    const _railStaleS = _feedHealth.rail ? now - _feedHealth.rail : 0;
    const _busStaleS  = _feedHealth.bus  ? now - _feedHealth.bus  : 0;
    const _railStale  = _showsRail && _railStaleS > FEED_STALE_THRESHOLD_S;
    const _busStale   = _showsBus  && _busStaleS  > FEED_STALE_THRESHOLD_S;
    let staleBannerHTML = '';
    if (_railStale || _busStale) {
        const _which = _railStale && _busStale ? 'rail and bus'
                     : _railStale ? 'rail'
                     : 'bus';
        const _ageS  = Math.max(_railStale ? _railStaleS : 0, _busStale ? _busStaleS : 0);
        const _ageLabel = _ageS >= 60 ? `${Math.round(_ageS / 60)}m` : `${Math.round(_ageS)}s`;
        const _title  = `Trip-updates feed silent for ${_ageLabel} — ETAs may be stale`;
        const _banner = `⚠ Live ${_which} feed delayed (${_ageLabel})`;
        staleBannerHTML = `<div class="sp-feed-stale" title="${esc(_title)}">${esc(_banner)}</div>`;
    }

    // Station-scoped alerts (accessibility + service). Both are rendered at
    // the top of the popup since they apply to the whole station, not to any
    // single route block. Service alerts used to live inside each route's
    // sp-route block; consolidating them up here means they share width and
    // chrome with the access banner and don't push live arrivals offscreen.
    const accessAlerts  = stopIds.flatMap(id => getActiveStopAccessibilityAlerts(id));
    const routeIdsAtStation = [...routeMap.keys()];
    // getActiveAlerts already applies the canonical activePeriod filter — keeping
    // a parallel inline filter here meant the rule lived in two places (different
    // boundary semantics: `<=` vs `>`) and could drift silently on either side.
    // Cross-route dedupe by id stays here because Metro tags one alert across
    // multiple routes; effect-level dedupe with ×N count happens below.
    const _seenIds = new Set();
    const _activeService = routeIdsAtStation
        .flatMap(rId => getActiveAlerts(rId))
        .filter(a => {
            if (_seenIds.has(a.id)) return false;
            _seenIds.add(a.id);
            return true;
        });
    const _effectDedupe = new Map();
    for (const a of _activeService) {
        const prev = _effectDedupe.get(a.effect);
        if (prev) {
            prev._count++;
            const desc = (a.description ?? '').trim();
            if (desc && !prev._descriptions.includes(desc)) prev._descriptions.push(desc);
        } else {
            const desc = (a.description ?? '').trim();
            _effectDedupe.set(a.effect, { ...a, _count: 1, _descriptions: desc ? [desc] : [] });
        }
    }
    const STATION_POPUP_EFFECT_PRIORITY = ['DETOUR','NO_SERVICE','REDUCED_SERVICE','SIGNIFICANT_DELAYS','MODIFIED_SERVICE','STOP_MOVED','OTHER_EFFECT','UNKNOWN_EFFECT'];
    const STATION_POPUP_LABELS = { ...STRIP_EFFECT_LABELS, ACCESSIBILITY_ISSUE: 'Elevator/escalator' };
    const dedupedService = [...(_effectDedupe.values())]
        .sort((a, b) => (STATION_POPUP_EFFECT_PRIORITY.indexOf(a.effect) + 1 || 99) - (STATION_POPUP_EFFECT_PRIORITY.indexOf(b.effect) + 1 || 99));

    // Build the unified alerts section. Access (♿) first because it's
    // station-blocking info that affects whether the rider can use the
    // station at all; service (⚠) below.
    let alertsHTML = '';
    if (accessAlerts.length || dedupedService.length) {
        // First dedup by alert ID, then by content fingerprint — Metro sometimes
        // tags the same outage to multiple stop IDs (e.g. merged 910/950 stops at
        // El Monte) producing different IDs but identical header + description.
        const _seenContent = new Set();
        const accessItems = [...new Map(accessAlerts.map(a => [a.id || a.header, a])).values()]
            .filter(a => {
                const fp = `${(a.header || '').trim().toLowerCase()}|\
${(a.description || '').trim().toLowerCase()}`;
                if (_seenContent.has(fp)) return false;
                _seenContent.add(fp);
                return true;
            })
            .map(a => {
                // Facility-specific label so riders see at a glance whether
                // it's an elevator they need or escalator they can detour.
                const type = classifyAccessibilityAlert(a.header, a.description);
                const facilityLabel = _accessFacilityLabel(type);
                // Drop the feed's headline when it just repeats the station
                // name (Metro typically sends "37TH ST/USC STATION") — the
                // popup title already shows the station, so the suffix is
                // pure redundancy. Otherwise keep the feed headline as a
                // more-specific subtitle.
                const headerTrim = (a.header || '').trim();
                const looksLikeStationName = headerTrim && /STATION$/i.test(headerTrim);
                const titleHTML = (!headerTrim || looksLikeStationName)
                    ? esc(facilityLabel)
                    : `${esc(facilityLabel)} — ${esc(headerTrim)}`;
                const body = (a.description || '').trim();
                const bodyHTML = body ? _alertBodyHTML(body) : '';
                return `<details class="sp-banner sp-banner--access" data-alert-id="${esc(a.id)}">` +
                       `<summary class="sp-banner-title">♿ ${titleHTML}</summary>` +
                       bodyHTML +
                       `</details>`;
            }).join('');
        const serviceItems = dedupedService.map(a => {
            // STATION_POPUP_LABELS extends STRIP_EFFECT_LABELS (alerts.js) with
            // an ACCESSIBILITY_ISSUE entry; "Service alert" is the safe
            // fallback for any effect code Metro adds later.
            const label = STATION_POPUP_LABELS[a.effect] ?? 'Service alert';
            const count = a._count > 1 ? ` <span class="sp-banner-count">×${a._count}</span>` : '';
            const bodyHTML = a._descriptions.length
                ? a._descriptions.map(d => _alertBodyHTML(d)).join('')
                : (a.header ? _alertBodyHTML(a.header) : '');
            return `<details class="sp-banner sp-banner--service" data-alert-id="${esc(a.id)}">` +
                   `<summary class="sp-banner-title">⚠ ${label}${count}</summary>` +
                   bodyHTML +
                   `</details>`;
        }).join('');
        alertsHTML = `<div class="sp-alerts-section">${accessItems}${serviceItems}</div>`;
    }

    return `
        <div class="station-popup-wrap modern">
            <div class="station-popup-name">${esc(name)}</div>
            ${staleBannerHTML}
            ${alertsHTML}
            <div class="sp-table">${rowsHTML}</div>
            ${busHTML}
            ${bikeHTML}
        </div>
    `;
}

const CARDINAL_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const CARDINAL_FULL_WORDS = {
    N: 'Northbound', NE: 'Northeast', E: 'Eastbound',  SE: 'Southeast',
    S: 'Southbound', SW: 'Southwest', W: 'Westbound',  NW: 'Northwest',
};

/**
 * Compute an 8-bucket cardinal direction from (stationLat, stationLon) to a
 * terminus stop. Returns 'N','NE','E','SE','S','SW','W','NW' or null when the
 * terminus is too close to the station (<~50 m) to label meaningfully.
 *
 * Longitude is scaled by cos(stationLat) to correct for the LA basin's
 * longitude compression so a 1° dLat and 1° dLon represent comparable metres.
 * The bucket is chosen by atan2 bearing rounded to the nearest 45°.
 *
 * @param {number} stationLat
 * @param {number} stationLon
 * @param {number} termLat
 * @param {number} termLon
 * @returns {string|null}
 */
export function compute8Cardinal(stationLat, stationLon, termLat, termLon) {
    if (!Number.isFinite(stationLat) || !Number.isFinite(stationLon)) return null;
    if (!Number.isFinite(termLat)    || !Number.isFinite(termLon))    return null;
    const latRad = (stationLat * Math.PI) / 180;
    const dLat   = termLat - stationLat;
    const dLon   = (termLon - stationLon) * Math.cos(latRad);
    if (Math.abs(dLat) < 0.0005 && Math.abs(dLon) < 0.0005) return null; // ~50 m null zone
    // atan2(dLon, dLat): 0° = North, 90° = East, etc.
    const bearing = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
    return CARDINAL_8[Math.round(bearing / 45) % 8];
}

/**
 * Return all bus stops within radiusM of the given point, sorted by distance.
 * Rail stops (8xxxxx IDs) are excluded. Scans window.masterStopsData linearly.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusM=400] Search radius in meters
 * @returns {Array<{ stopId: string, stop: Object, distM: number }>}
 */
export function getNearbyBusStops(lat, lon, radiusM = 400) {
    const out = [];
    for (const [stopId, stop] of Object.entries(window.masterStopsData ?? {})) {
        if (RAIL_STOP_RE.test(stopId)) continue;
        if (!Number.isFinite(stop?.lat) || !Number.isFinite(stop?.lon)) continue;
        const d = planarMeters(lat, lon, stop.lat, stop.lon);
        if (d <= radiusM) out.push({ stopId, stop, distM: d });
    }
    return out.sort((a, b) => a.distM - b.distM);
}

/**
 * Return the station group nearest to the given coordinates (no radius limit).
 * @param {number} lng
 * @param {number} lat
 * @returns {{ normName, displayName, lat, lon, stopIds } | null}
 */
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

/**
 * Open a pinned arrivals popup for the given station group.
 * @param {maplibregl.Map} map
 * @param {{ lon: number, lat: number, stopIds: string[], displayName: string }} group
 */
export function openStationByGroup(map, group) {
    if (!group) return;
    showArrivalsPopup(map, [group.lon, group.lat], group.stopIds, group.displayName, true);
}

// Exposed on window so bikeshare.js can open/hover the station popup when a
// bike marker is folded into a metro station, without a circular import.
window.__openStationByGroup  = openStationByGroup;
window.__hoverStationByGroup = (map, group) => {
    if (!group || activePopup?.isPinned) return;
    showArrivalsPopup(map, [group.lon, group.lat], group.stopIds, group.displayName, false);
};
window.__closeStationIfUnpinned = () => {
    if (!activePopup?.isPinned) closeStationPopup();
};

// ── Boarding badges at terminus stations ─────────────────────────────────────
// Replaces individual vehicle markers at route origins with a small per-route
// badge on the station, showing how many trains are boarding and when the next
// one departs. Bridges the layover gap when GTFS-RT trip_updates know about a
// train but the VP feed has gone silent. One badge per station group shows all
// terminating lines and their departure times.

// One marker map keyed by station group; each entry holds the up-to-three
// child markers (boarding pill, alert "!" circle, access ♿ circle). A single
// renderer (_renderStationBadges) is the source of truth for placement, so
// the three badge types can never collide and a fourth type added later
// only has to extend the slot table — no new renderer needed.
const _stationBadges = new Map();
let _boardingInitialized = false;
const BADGE_MINZOOM = 9;

function _findStationCoords(stopId) {
    // Prefer the station group (post-merge) so badges land on the dot the user clicks.
    const group = stationGroups.find(g => g.stopIds.includes(String(stopId)));
    if (group) return { lng: group.lon, lat: group.lat };
    const stop = window.masterStopsData?.[String(stopId)];
    if (stop?.lat && stop?.lon) return { lng: stop.lon, lat: stop.lat };
    return null;
}

function _formatDeparture(departureUnix, now) {
    if (departureUnix == null) return '';
    const secs = Math.max(0, Math.round(departureUnix - now));
    if (secs < 30) return 'now';
    if (secs < 60) return '30s';
    return `${Math.floor(secs / 60)}m`;
}

// ── Slot model ──────────────────────────────────────────────────────────────
// A 3×3 grid of slots around the station dot. MapLibre's `anchor` names the
// corner of the BADGE that sits at the lat/lng — anchor:'bottom-left' with
// positive offset places the badge to the upper-right of the dot. Each slot
// below is named for where the BADGE ends up relative to the dot.

// Badge offset scales with zoom so it tracks the badge-size growth applied
// by _applyBadgeZoom (alert/access circles double from 10→20 px). Keeping a
// fixed 10 px offset while the badge swelled around it made the near edge
// drift across the underlying route polyline at high zoom — the "doesn't
// stick" complaint. The offset is recomputed on every zoom event and pushed
// to each marker via setOffset() so positioning stays visually consistent.
// Track roughly half the badge size (10–20 px) plus a tiny gap so the inner
// edge of the badge sits just outside the station dot at every zoom. The old
// 14 px floor made badges visibly float away from the small zoom-9/10 dots
// — the "detach when zoomed out" complaint.
const BADGE_OFFSET_MIN_PX = 2;
const BADGE_OFFSET_MAX_PX = 10;
let _currentBadgeOffsetPx = BADGE_OFFSET_MIN_PX;

// SLOT_VECTORS pairs each slot with its anchor and a unit direction vector
// (one of −1, 0, +1 on each axis). The pixel offset for a marker is derived
// by multiplying the unit vector by the current zoom-adjusted offset. This
// replaces the previous constant SLOTS table whose offsets couldn't move
// with zoom.
const SLOT_VECTORS = {
    TL: { anchor: 'bottom-right', dx: -1, dy: -1 },  // upper-left
    T:  { anchor: 'bottom',       dx:  0, dy: -1 },  // upper-mid
    TR: { anchor: 'bottom-left',  dx: +1, dy: -1 },  // upper-right
    R:  { anchor: 'left',         dx: +1, dy:  0 },  // right-mid
    BR: { anchor: 'top-left',     dx: +1, dy: +1 },  // lower-right
    B:  { anchor: 'top',          dx:  0, dy: +1 },  // lower-mid
    BL: { anchor: 'top-right',    dx: -1, dy: +1 },  // lower-left
    L:  { anchor: 'right',        dx: -1, dy:  0 },  // left-mid
};

/**
 * Resolve a slot key to MapLibre Marker `{ anchor, offset }` at the given
 * pixel scale. Exported for test coverage; production callers normally use
 * the helper `_slotConfig()` which defaults to `_currentBadgeOffsetPx`.
 * @param {string} slotKey one of TL/T/TR/R/BR/B/BL/L
 * @param {number} offsetPx scalar pixel distance from anchor
 * @returns {{ anchor:string, offset:[number,number] } | null}
 */
export function slotConfig(slotKey, offsetPx = BADGE_OFFSET_MIN_PX) {
    const v = SLOT_VECTORS[slotKey];
    if (!v) return null;
    return { anchor: v.anchor, offset: [v.dx * offsetPx, v.dy * offsetPx] };
}

// Backwards-compat alias for tests that imported `SLOTS` directly. Returns
// the zoom-minimum offsets — useful for layout assertions that don't depend
// on the live zoom state. Real placement uses slotConfig with the current px.
export const SLOTS = Object.fromEntries(
    Object.keys(SLOT_VECTORS).map(k => [k, slotConfig(k, BADGE_OFFSET_MIN_PX)])
);

function _slotConfig(slotKey) {
    return slotConfig(slotKey, _currentBadgeOffsetPx);
}

// Per-terminus boarding-badge slot fallback. Most rail termini get their
// slot computed from polyline geometry (resolveBoardingSlotFromPolyline);
// this list is the escape hatch for stops where polyline data is missing
// (bus routes — G/J have no shape data) or where the polyline-derived slot
// looks wrong visually.
export const BOARDING_SLOT_OVERRIDES = [
    { match: 'harbor gateway',  slot: 'B' },  // J south (bus, no shape)
    { match: 'san pedro',       slot: 'B' },  // J south alt name
    { match: 'chatsworth',      slot: 'L' },  // G west (bus, no shape)
    { match: 'north hollywood', slot: 'R' },  // B/G terminus — east of station
    { match: 'union station',   slot: 'R' },  // multi-line east terminus
    { match: 'el monte',        slot: 'R' },  // J east terminus — east of station
    { match: 'pomona',          slot: 'R' },  // A east terminus — east of station
    { match: 'lax',             slot: 'L' },  // K/C terminus — west of station
    { match: 'long beach',      slot: 'B' },  // A south terminus — below station
];

/**
 * Map a continuous bearing (degrees, 0=N, 90=E) to the nearest of the 8
 * slot keys. Exposed for tests.
 */
export function bearingToSlot(bearingDeg) {
    if (bearingDeg == null || !Number.isFinite(bearingDeg)) return null;
    // Normalise to [0, 360).
    const b = ((bearingDeg % 360) + 360) % 360;
    // 8 buckets centred on 0/45/90/.../315. Each bucket is 45° wide.
    const i = Math.round(b / 45) % 8;
    return ['T', 'TR', 'R', 'BR', 'B', 'BL', 'L', 'TL'][i];
}

/**
 * Compute the slot that places the boarding badge OPPOSITE the polyline at a
 * terminus stop. We snap the stop to the route polyline, probe a point ~200 m
 * deeper into the line (away from this stop), and place the badge on the
 * far side of the dot from that probe — so the polyline visually exits one
 * side of the dot and the badge sits on the other.
 *
 * Returns null when the route has no shape data (bus routes, missing data)
 * or when bearing computation is degenerate. Callers fall back to the manual
 * override list.
 *
 * @param {string} routeCode  GTFS route_id (e.g. '801')
 * @param {number} lat
 * @param {number} lng
 * @returns {string|null}     slot key (TL/T/TR/R/BR/B/BL/L) or null
 */
export function resolveBoardingSlotFromPolyline(routeCode, lat, lng) {
    if (!routeCode || !hasShapeData(routeCode)) return null;
    const snap = snapToRoute(routeCode, lng, lat);
    if (!snap) return null;

    const arcs = arcLengths[routeCode];
    if (!arcs?.length) return null;
    const totalArc = arcs[arcs.length - 1];

    // Probe a point ~200 m deeper into the polyline, in whichever direction
    // has more line ahead of us. At an endpoint that's the only viable
    // direction; at a midpoint we still pick the side with more length so
    // the bearing is dominated by the bulk of the polyline.
    const PROBE_M = 200;
    const arcHere = snap.arcMeters;
    const arcF = arcHere + PROBE_M;
    const arcB = arcHere - PROBE_M;
    const target = (totalArc - arcHere) >= arcHere
        ? Math.min(totalArc, arcF)
        : Math.max(0, arcB);
    const probe = lngLatAtArc(routeCode, target);
    if (!probe) return null;

    // Bearing FROM the terminus TO the probe — points along the polyline.
    const polylineBearing = computeBearing(lng, lat, probe.lng, probe.lat);
    if (polylineBearing == null) return null;

    // Badge sits 180° opposite — away from where the polyline runs.
    return bearingToSlot((polylineBearing + 180) % 360);
}

export function resolveBoardingSlot(normName) {
    if (!normName) return 'TR';
    const n = normName.toLowerCase();
    for (const p of BOARDING_SLOT_OVERRIDES) {
        if (n.includes(p.match)) return p.slot;
    }
    return 'TR';
}

/**
 * Resolve a station group's boarding-badge slot. Prefers polyline-derived
 * placement (so rail termini sit on the opposite side of the route line);
 * falls back to the manual override list for bus-only termini and edge
 * cases; defaults to 'TR' if neither applies. When multiple rail routes
 * converge at one badge group, the circular mean of their per-route slot
 * bearings is used so a J/D/B station like Union doesn't snap to whichever
 * route the loop sees first.
 *
 * @param {string} normName        station group normName (manual override key)
 * @param {Array<{routeCode:string, lat:number, lng:number}>} routes
 * @returns {string} slot key
 */
function _resolveBoardingSlotForGroup(normName, routes) {
    const manual = resolveBoardingSlot(normName);
    if (manual !== 'TR') return manual;

    // Circular mean of per-route polyline bearings — handles wrap at 360°.
    let sumX = 0, sumY = 0, count = 0;
    for (const r of routes) {
        const slot = resolveBoardingSlotFromPolyline(r.routeCode, r.lat, r.lng);
        if (!slot) continue;
        // Convert slot back to its 8-bucket bearing for the circular mean.
        const bearing = ['T','TR','R','BR','B','BL','L','TL'].indexOf(slot) * 45;
        const rad = bearing * Math.PI / 180;
        sumX += Math.sin(rad);
        sumY += Math.cos(rad);
        count++;
    }
    if (count === 0) return 'TR';
    const meanBearing = Math.atan2(sumX, sumY) * 180 / Math.PI;
    return bearingToSlot(meanBearing) ?? 'TR';
}

function _isOverrideMatch(normName) {
    return resolveBoardingSlot(normName) !== 'TR';
}

/**
 * Pure layout function. Given which badge types are present and where the
 * boarding badge must sit, returns the slot key for each present badge type
 * such that no two share a slot. Alert + access are placed at the corners
 * farthest from the boarding badge so the three never crowd each other.
 *
 * @param {{ hasBoarding:boolean, boardingSlot?:string,
 *           hasAlert:boolean, hasAccess:boolean }} state
 * @returns {{ boarding?:string, alert?:string, access?:string }}
 */
export function chooseBadgeSlots({ hasBoarding, boardingSlot = 'TR', hasAlert, hasAccess }) {
    const out = {};
    if (hasBoarding) out.boarding = boardingSlot;

    // Place alert + access at the two corners on the OPPOSITE side from the
    // boarding badge. This generalises the earlier hand-coded table so any
    // of the 8 slots Just Works when polyline-derived placement returns
    // something like 'R', 'BR', 'BL', etc.
    const cornerPlacement = {
        TL: { alert: 'TR', access: 'BR' },
        T:  { alert: 'BL', access: 'BR' },
        TR: { alert: 'TL', access: 'BL' },
        R:  { alert: 'TL', access: 'BL' },
        BR: { alert: 'TL', access: 'BL' },
        B:  { alert: 'TL', access: 'TR' },
        BL: { alert: 'TR', access: 'BR' },
        L:  { alert: 'TR', access: 'BR' },
    };
    const opp = hasBoarding ? cornerPlacement[boardingSlot] : { alert: 'TL', access: 'BL' };
    if (hasAlert)  out.alert  = opp.alert;
    if (hasAccess) out.access = opp.access;
    return out;
}

// ── DOM element builders (one per badge type) ───────────────────────────────

function _entryHTML({ routeCode, depLabel }) {
    const color = routeHexColors[routeCode] || '#231f20';
    return `<div class="boarding-badge" style="--bb-color:${color};">` +
           `<span class="bb-dot"></span>` +
           `<span class="bb-time">${depLabel || '—'}</span>` +
           `</div>`;
}

function _makeBoardingEl(entries) {
    const tmp = document.createElement('div');
    tmp.innerHTML = `<div class="boarding-badge-wrap">${entries.map(_entryHTML).join('')}</div>`;
    return tmp.firstElementChild;
}

function _makeAlertEl(tipText, tipBlocks) {
    const wrap = document.createElement('div');
    wrap.className = 'station-alert-badge-wrap';
    wrap.dataset.alertText = tipText;
    if (tipBlocks) wrap._alertBlocks = tipBlocks;
    const el = document.createElement('span');
    el.className = 'station-alert-badge';
    el.textContent = '!';
    el.setAttribute('aria-label', `Service alert: ${tipText}`);
    wrap.appendChild(el);
    wireAlertBadge(wrap, el);
    return wrap;
}

function _makeAccessEl(tipText, accessType, tipBlocks) {
    const wrap = document.createElement('div');
    wrap.className = 'station-access-badge-wrap';
    wrap.dataset.alertText = tipText;
    if (tipBlocks) wrap._alertBlocks = tipBlocks;
    const el = document.createElement('span');
    el.className = 'station-access-badge';
    el.textContent = '♿';
    el.setAttribute('aria-label', `${_accessFacilityLabel(accessType)}: ${tipText}`);
    wrap.appendChild(el);
    wireAlertBadge(wrap, el);
    return wrap;
}

// ── Per-station boarding state (origin/terminus departure pills) ────────────

function _collectBoardingState() {
    const result = new Map();
    const origins = getAllOriginStops();
    if (!origins.length) return result;

    const allOriginStopIds = origins.map(o => o.stopId);
    const boarding = getBoardingVehicles(allOriginStopIds);
    const now = Math.floor(Date.now() / 1000);

    // Stable origin order so the entry list inside a multi-line terminus badge
    // doesn't re-order between refreshes (would cause flicker).
    const sortedOrigins = [...origins].sort((a, b) =>
        a.routeCode.localeCompare(b.routeCode) || a.dir - b.dir
    );

    for (const o of sortedOrigins) {
        const group = stationGroups.find(g => g.stopIds.includes(String(o.stopId)));
        let badgeKey = group ? group.stopIds[0] : String(o.stopId);
        if (!result.has(badgeKey)) {
            const coords = group
                ? { lng: group.lon, lat: group.lat }
                : _findStationCoords(o.stopId);
            if (!coords) continue;
            // Proximity merge so 910/950 at El Monte share one badge even
            // though they live in different station groups.
            let nearbyKey = null;
            for (const [k, existing] of result) {
                if (planarMeters(coords.lat, coords.lng, existing.coords.lat, existing.coords.lng) < STATION_MERGE_RADIUS_M) {
                    nearbyKey = k;
                    break;
                }
            }
            if (nearbyKey) {
                badgeKey = nearbyKey;
                const existing = result.get(nearbyKey);
                const newName = group?.normName ?? '';
                // Upgrade the merged entry's normName if the incoming group
                // matches a slot override and the existing one doesn't —
                // otherwise first-write-wins picks the wrong placement.
                if (newName && !_isOverrideMatch(existing.normName) && _isOverrideMatch(newName)) {
                    existing.normName = newName;
                }
            } else {
                // routesAt tracks every (routeCode, lat, lng) so the polyline
                // slot resolver can take a circular mean across the lines that
                // converge at this badge (e.g. B+D+J at Union Station).
                result.set(badgeKey, { coords, normName: group?.normName ?? '', entries: [], routesAt: [] });
            }
        }

        const entry = result.get(badgeKey);
        entry.routesAt.push({ routeCode: o.routeCode, lat: entry.coords.lat, lng: entry.coords.lng });

        const matches = boarding.filter(b =>
            b.stopId === o.stopId && b.routeId === o.routeCode && b.directionId === o.dir
        );
        // Always push an entry for every terminating route — when nothing is
        // boarding yet, depLabel='' renders as '—' so the line never disappears.
        const soonestDep = matches.length
            ? matches.map(m => m.departureUnix).filter(t => t != null).sort((a, b) => a - b)[0] ?? null
            : null;
        entry.entries.push({
            routeCode: o.routeCode,
            depLabel:  _formatDeparture(soonestDep, now),
        });
    }

    // Collapse same-brand-color entries (e.g. 910 and 950 share J Line gray).
    for (const group of result.values()) {
        const byColor = new Map();
        for (const e of group.entries) {
            const color = routeHexColors[e.routeCode] ?? '#231f20';
            const existing = byColor.get(color);
            if (!existing || (existing.depLabel === '—' && e.depLabel !== '—')) {
                byColor.set(color, e);
            }
        }
        group.entries = [...byColor.values()];
    }

    return result;
}

// ── Unified renderer ────────────────────────────────────────────────────────
// Single source of truth for badge placement at every station. Aggregates the
// three badge types into one per-station record, runs chooseBadgeSlots() to
// assign a non-overlapping slot per badge, then creates / updates / cleans
// MapLibre Markers. Replaces three separate renderers that each picked their
// own corner without coordinating with the others.

function _renderStationBadges(map) {
    if (!map) return;

    const showBadges = (map.getZoom() ?? 0) >= BADGE_MINZOOM;
    const seenKeys = new Set();

    // Aggregate per-station state across all three badge types.
    const perStation = new Map();   // badgeKey → { coords, normName, boardingEntries?, alertTipText?, accessTipText? }

    for (const [key, { coords, normName, entries, routesAt }] of _collectBoardingState()) {
        perStation.set(key, { coords, normName, boardingEntries: entries, routesAt });
    }

    for (const group of stationGroups) {
        const alerts = group.stopIds.flatMap(id => getActiveStopAlerts(id));
        const access = group.stopIds.flatMap(id => getActiveStopAccessibilityAlerts(id));
        if (!alerts.length && !access.length) continue;

        const badgeKey = group.stopIds[0];
        const existing = perStation.get(badgeKey)
            || { coords: { lng: group.lon, lat: group.lat }, normName: group.normName ?? '' };

        if (alerts.length) {
            const dedupedAlerts = [...new Map(alerts.map(a => [a.effect, a])).values()];
            // Structured blocks for DOM rendering (bold prefix chip, tighter
            // spacing). Plain text mirror is the source of truth for aria-label
            // + textContent fallback when the DOM path is unavailable.
            const pairs = dedupedAlerts.map(a => ({
                prefix: STRIP_EFFECT_LABELS[a.effect] ?? 'Service alert',
                alert: a,
            }));
            existing.alertTipBlocks = pairs.map(p => buildAlertTooltipBlock(p.prefix, p.alert));
            existing.alertTipText = pairs
                .map(p => buildAlertTooltipText(p.prefix, p.alert))
                .join('\n\n');
        }
        if (access.length) {
            const dedupedAccess = [...new Map(access.map(a => [a.id || a.header, a])).values()];
            // Per-alert facility classification (elevator / escalator / both)
            // so the tooltip can say "Elevator: <header>" instead of the
            // generic "Accessibility outage". Falls back to the generic
            // phrasing when the alert text doesn't mention either word.
            const pairs = dedupedAccess.map(a => {
                const type = classifyAccessibilityAlert(a.header, a.description);
                const prefix = type === 'elevator'  ? 'Elevator'
                             : type === 'escalator' ? 'Escalator'
                             : type === 'both'      ? 'Elevator/escalator'
                             : 'Accessibility';
                // Synthesize a header fallback so the title line is never
                // bare when Metro omits the alert.header field.
                return { prefix, alert: { ...a, header: a.header || `${prefix} outage` } };
            });
            existing.accessTipBlocks = pairs.map(p => buildAlertTooltipBlock(p.prefix, p.alert));
            existing.accessTipText = pairs
                .map(p => buildAlertTooltipText(p.prefix, p.alert))
                .join('\n\n');
            // Headline classification (used for badge aria-label & popup
            // summary). If every alert at this stop is about the same
            // facility we say "elevator" / "escalator"; mixed → "both".
            const types = new Set(dedupedAccess.map(a =>
                classifyAccessibilityAlert(a.header, a.description)
            ));
            existing.accessType = types.size === 1
                ? [...types][0]
                : (types.has('elevator') && types.has('escalator')) ? 'both' : 'unknown';
        }
        perStation.set(badgeKey, existing);
    }

    for (const [badgeKey, station] of perStation) {
        seenKeys.add(badgeKey);

        const hasBoarding = !!(station.boardingEntries?.length);
        const hasAlert    = !!station.alertTipText;
        const hasAccess   = !!station.accessTipText;
        const boardingSlot = hasBoarding
            ? _resolveBoardingSlotForGroup(station.normName, station.routesAt ?? [])
            : 'TR';
        const slots = chooseBadgeSlots({ hasBoarding, boardingSlot, hasAlert, hasAccess });

        let entry = _stationBadges.get(badgeKey);
        if (!entry) {
            entry = { coords: station.coords };
            _stationBadges.set(badgeKey, entry);
        }
        entry.coords = station.coords;

        _syncBadgeMarker({
            map, entry, slotKey: slots.boarding, showBadges,
            kind: 'boarding',
            present: hasBoarding,
            buildEl: () => _makeBoardingEl(station.boardingEntries),
            updateEl: el => { el.innerHTML = station.boardingEntries.map(_entryHTML).join(''); },
        });
        _syncBadgeMarker({
            map, entry, slotKey: slots.alert, showBadges,
            kind: 'alert',
            present: hasAlert,
            buildEl: () => _makeAlertEl(station.alertTipText, station.alertTipBlocks),
            updateEl: el => {
                el.dataset.alertText = station.alertTipText;
                el._alertBlocks = station.alertTipBlocks;
                el.querySelector('.station-alert-badge')
                    ?.setAttribute('aria-label', `Service alert: ${station.alertTipText}`);
            },
        });
        _syncBadgeMarker({
            map, entry, slotKey: slots.access, showBadges,
            kind: 'access',
            present: hasAccess,
            buildEl: () => _makeAccessEl(station.accessTipText, station.accessType, station.accessTipBlocks),
            updateEl: el => {
                el.dataset.alertText = station.accessTipText;
                el._alertBlocks = station.accessTipBlocks;
                el.querySelector('.station-access-badge')
                    ?.setAttribute('aria-label',
                        `${_accessFacilityLabel(station.accessType)}: ${station.accessTipText}`);
            },
        });
    }

    // Cleanup: stations no longer in the active set lose all their markers.
    for (const [key, entry] of _stationBadges) {
        if (seenKeys.has(key)) continue;
        entry.boardingMarker?.remove();
        entry.alertMarker?.remove();
        entry.accessMarker?.remove();
        _stationBadges.delete(key);
    }
}

// Create-or-update one badge marker on a station entry. Reuses the marker
// when the slot hasn't changed; rebuilds when the slot moved (rare —
// triggered by override-name upgrades during proximity merge).
function _syncBadgeMarker({ map, entry, slotKey, showBadges, kind, present, buildEl, updateEl }) {
    const markerField = `${kind}Marker`;
    const slotField   = `${kind}Slot`;

    if (!present) {
        if (entry[markerField]) {
            entry[markerField].remove();
            entry[markerField] = null;
            entry[slotField]   = null;
        }
        return;
    }

    const cfg = _slotConfig(slotKey);
    const existing = entry[markerField];

    if (existing && entry[slotField] === slotKey) {
        existing.setLngLat([entry.coords.lng, entry.coords.lat]);
        // Offset can change between calls (zoom event re-renders with a
        // different scale), so refresh it every sync.
        existing.setOffset(cfg.offset);
        updateEl(existing._wrapEl);
        return;
    }

    if (existing) existing.remove();

    const el = buildEl();
    el.style.display = showBadges ? '' : 'none';
    // For the boarding pill we suppress a single-frame top-left flash that
    // happens before MapLibre composites its CSS transform onto the new node.
    if (kind === 'boarding') el.style.opacity = '0';

    const marker = new maplibregl.Marker({
        element: el, anchor: cfg.anchor, offset: cfg.offset,
    })
        .setLngLat([entry.coords.lng, entry.coords.lat])
        .addTo(map);
    marker._wrapEl = el;

    if (kind === 'boarding') requestAnimationFrame(() => { el.style.opacity = ''; });

    entry[markerField] = marker;
    entry[slotField]   = slotKey;
}

const ALERT_BADGE_SIZE_MIN_PX = 10;
const ALERT_BADGE_SIZE_MAX_PX = 20;
const ALERT_BADGE_ZOOM_MAX    = 15;

function _applyBadgeZoom(map) {
    const zoom = map.getZoom();
    const show = zoom >= BADGE_MINZOOM;
    const t = Math.max(0, Math.min(1, (zoom - BADGE_MINZOOM) / (ALERT_BADGE_ZOOM_MAX - BADGE_MINZOOM)));
    const size = Math.round(ALERT_BADGE_SIZE_MIN_PX + t * (ALERT_BADGE_SIZE_MAX_PX - ALERT_BADGE_SIZE_MIN_PX));
    document.documentElement.style.setProperty('--alert-badge-size', `${size}px`);

    // Scale badge offset in lockstep with badge size so the near edge of
    // the badge stays a constant visual distance from the station point
    // through the entire zoom range. Without this, the badge swelled
    // around a fixed anchor and visually crowded the underlying polyline
    // at high zoom — the "doesn't stick" complaint.
    _currentBadgeOffsetPx = Math.round(
        BADGE_OFFSET_MIN_PX + t * (BADGE_OFFSET_MAX_PX - BADGE_OFFSET_MIN_PX)
    );

    for (const entry of _stationBadges.values()) {
        for (const kind of ['boarding', 'alert', 'access']) {
            const marker = entry[`${kind}Marker`];
            if (!marker?._wrapEl) continue;
            marker._wrapEl.style.display = show ? '' : 'none';
            const slotKey = entry[`${kind}Slot`];
            if (slotKey) marker.setOffset(_slotConfig(slotKey).offset);
        }
    }
}

/**
 * Start the unified station-badge renderer. Draws boarding pills at origin
 * termini, "!" badges at stations with active service alerts, and ♿ badges
 * at stations with elevator/escalator outages. All three badge types share
 * a single placement system (chooseBadgeSlots) so they never overlap, and
 * a single refresh tick (STATION_POPUP_REFRESH_MS).
 * @param {maplibregl.Map} map MapLibre map instance
 */
export function initBoardingBadges(map) {
    if (_boardingInitialized) return;
    _boardingInitialized = true;
    _renderStationBadges(map);
    setVisibleInterval(() => _renderStationBadges(map),
                       STATION_POPUP_REFRESH_MS, 'stations:badges');
    map.on('zoom', () => _applyBadgeZoom(map));
    _applyBadgeZoom(map);
}
