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

import { routeIcons, routeHexColors, routeDirectionLabels, STATION_MERGE_RADIUS_M, STATION_POPUP_REFRESH_MS } from './config.js';
import { cleanDestination } from './ui.js';
import { planarMeters, cleanStationName, escHtml as esc, setVisibleInterval } from './utils.js';
import { getScheduledArrivals, getTerminalName, isOriginStop, isTerminalStop, isNearTerminalStop, getBoardingVehicles, getAllOriginStops, getRouteCache } from './predictions.js';
import { STRIP_EFFECT_LABELS, getActiveStopAlerts, getActiveStopAccessibilityAlerts, wireAlertBadge } from './alerts.js';
import { getNearbyBikeStation } from './bikeshare.js';
import { tripTerminusByTripId, getTripUpdatesFeedHealth } from './tripUpdates.js';

// If a trip_updates feed has been silent this long, surface a "data may be
// stale" banner above the popup rows. Frames normally arrive at sub-30s
// cadence; 90s of silence is well past any normal idle gap and a reliable
// signal that displayed ETAs are no longer ground truth.
const FEED_STALE_THRESHOLD_S = 90;

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
    const normName = cleanStationName(stop.name, false);
    let existing = findGroup(normName, stop.lat, stop.lon);
    if (!existing && isBusway) {
        existing = stationGroups.find(g =>
            planarMeters(g.lat, g.lon, stop.lat, stop.lon) < STATION_MERGE_RADIUS_M
        );
    }
    if (existing) {
        if (!existing.stopIds.includes(stopId)) existing.stopIds.push(stopId);
        return false;
    }
    const group = {
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [stopId],
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
    activePopupRefreshTimer = setInterval(() => {
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
                    currentWrap.querySelectorAll('.sp-alert[open]').forEach(el => {
                        const id = el.dataset.alertId;
                        if (!id) return;
                        const match = fresh.querySelector(`.sp-alert[data-alert-id="${id}"]`);
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
    }, STATION_POPUP_REFRESH_MS);

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
            if (a.arrivalUnix < now - 60) return;
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
    // entries in config.js — remove it so orphaned arrivals don't create broken rows.
    const RAIL_LIKE_ROUTES = new Set(['801','802','803','804','805','807','901','910','950']);

    // Group by routeId → directionId
    const routeMap = new Map();
    arrivals.forEach(a => {
        if (!RAIL_LIKE_ROUTES.has(a.routeId)) return;
        if (!routeMap.has(a.routeId)) routeMap.set(a.routeId, { 0: [], 1: [] });
        // Defensive: directionId from feed may be missing for malformed trip_updates.
        // Default to 0 so we don't blow up on undefined.push.
        const dir = a.directionId === 1 ? 1 : 0;
        routeMap.get(a.routeId)[dir].push(a);
    });
    // Seed routeMap with routes that only appear in boardingAtOrigin (no arrivals from
    // getScheduledArrivals). Without this, renderRow is never called for those routes
    // and boarding pills are silently dropped.
    boardingAtOrigin.forEach(b => {
        if (!RAIL_LIKE_ROUTES.has(b.routeId)) return;
        if (!routeMap.has(b.routeId)) routeMap.set(b.routeId, { 0: [], 1: [] });
    });

    // Seed routeMap with any RAIL_LIKE_ROUTE that serves this station as a
    // mid-route through stop (not origin, not terminal). This ensures a route
    // row appears even when no live vehicles are currently tracking — e.g. the
    // 950 southbound San Pedro direction at Harbor Gateway TC when no 950s are
    // active. Rows whose direction turns out to be terminal are still suppressed
    // by isTerminalStop inside renderRow.
    for (const routeId of RAIL_LIKE_ROUTES) {
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

        const resolveTerminus = (dirIdx, tripInfo, tripId) => {
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
            // Live trip_updates fallback — covers routes (e.g. city buses folded into
            // the station group, or J Line variants) that lack static masterTripsData.
            if (!t && tripId) {
                const liveTermStopId = window.tripTerminusByTripId?.get(String(tripId));
                const stop = liveTermStopId ? window.masterStopsData?.[String(liveTermStopId)] : null;
                if (stop?.name) t = cleanStationName(stop.name);
            }
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
                    const isNow   = secAway < 0 || secAway <= 30;
                    const timeStr = isNow ? 'Now' : `${Math.max(1, Math.round(secAway / 60))}m`;
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${timeStr}</span>`;
                }).join('');
                if (!pillsHTML) pillsHTML = `<span class="sp-no-data">—</span>`;
            } else if (list.length) {
                const sorted = [...list].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                pillsHTML = sorted.slice(0, 2).map(a => {
                    const secAway = Math.round(a.arrivalUnix - now);
                    const isNow   = secAway <= 30;
                    const timeStr = isNow ? 'Now' : `${Math.max(1, Math.round(secAway / 60))}m`;
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

        // Service alerts for this route. Metro often publishes near-identical
        // alert variants (one per direction or per affected segment) — group by
        // (effect|header|description) and render a single banner with a ×N count
        // when duplicates collapse together.
        const alertList = window.masterAlertsData?.get(routeId) ?? [];
        const EFFECT_PRIORITY = ['DETOUR','NO_SERVICE','REDUCED_SERVICE','SIGNIFICANT_DELAYS','MODIFIED_SERVICE','STOP_MOVED','OTHER_EFFECT','UNKNOWN_EFFECT'];
        const POPUP_LABELS = { ...STRIP_EFFECT_LABELS, ACCESSIBILITY_ISSUE: 'Elevator/escalator' };
        // Treat missing/null end as Infinity — open-ended alerts are active indefinitely.
        const activeAlerts = alertList.filter(a => {
            if (a.activePeriod?.start > now) return false;
            const end = a.activePeriod?.end ?? Infinity;
            return end > now;
        });
        // Aggressive dedupe: collapse by effect alone at the route level. Metro
        // commonly publishes one DETOUR alert per affected stop or direction with
        // slightly different headers/descriptions; conceptually they're a single
        // "this line is detoured." All distinct descriptions are preserved inside
        // the expandable banner so detail isn't lost — only the chrome consolidates.
        const dedupedMap = new Map();
        for (const a of activeAlerts) {
            const prev = dedupedMap.get(a.effect);
            if (prev) {
                prev._count++;
                const desc = (a.description ?? '').trim();
                if (desc && !prev._descriptions.includes(desc)) prev._descriptions.push(desc);
            } else {
                const desc = (a.description ?? '').trim();
                dedupedMap.set(a.effect, {
                    ...a,
                    _count: 1,
                    _descriptions: desc ? [desc] : [],
                });
            }
        }
        const dedupedAlerts = [...dedupedMap.values()]
            .sort((a, b) => (EFFECT_PRIORITY.indexOf(a.effect) + 1 || 99) - (EFFECT_PRIORITY.indexOf(b.effect) + 1 || 99));
        const alertHTML = dedupedAlerts.map(a => {
            const label = POPUP_LABELS[a.effect] ?? 'Service alert';
            const count = a._count > 1 ? ` <span class="sp-alert-count">×${a._count}</span>` : '';
            const bodyHTML = a._descriptions.length
                ? a._descriptions.map(d => `<p>${esc(d)}</p>`).join('')
                : (a.header ? `<p>${esc(a.header)}</p>` : '');
            return `<details class="sp-alert" data-alert-id="${esc(a.id)}">` +
                   `<summary class="sp-alert-title">⚠ ${label}${count}</summary>` +
                   bodyHTML +
                   `</details>`;
        }).join('');

        // Rows first so the actual ETAs are visible at the top of every route
        // block — alerts collapse below where they don't push live data offscreen.
        return `<div class="sp-route">${row1}${row2}${alertHTML}</div>`;
    }).join('');

    // Bike share section — find the nearest station within 160 m of this group.
    // 120 m missed several legitimate stations (e.g. Wilshire/La Cienega at 135 m)
    // because Metro Bike docks are sometimes placed at the far end of a large plaza.
    const group = stationGroups.find(g => stopIds.some(id => g.stopIds.includes(id)));
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
                if (a.arrivalUnix < now - 60) continue;
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
                    const isNow   = secAway <= 30;
                    const time    = isNow ? 'Now' : `${Math.max(1, Math.round(secAway / 60))}m`;
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
    // any RAIL_LIKE_ROUTES row was rendered; bus feed is needed when the nearby
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
        staleBannerHTML = `<div class="sp-feed-stale" title="Trip-updates feed silent for ${esc(_ageLabel)} — ETAs may be stale">⚠ Live ${esc(_which)} feed delayed (${esc(_ageLabel)})</div>`;
    }

    // Station-scoped accessibility (elevator/escalator) outages. Rendered at
    // the top of the popup, above the per-route arrival rows, since they apply
    // to the whole station rather than to any one line.
    const accessAlerts = stopIds.flatMap(id => getActiveStopAccessibilityAlerts(id));
    let accessHTML = '';
    if (accessAlerts.length) {
        const dedupedAccess = [...new Map(accessAlerts.map(a => [a.id || a.header, a])).values()];
        const items = dedupedAccess.map(a => {
            const title = (a.header || 'Accessibility outage').trim();
            const body  = (a.description || '').trim();
            const bodyHTML = body ? `<p>${esc(body)}</p>` : '';
            return `<details class="sp-access-alert" data-alert-id="${esc(a.id)}">` +
                   `<summary class="sp-access-title">♿ ${esc(title)}</summary>` +
                   bodyHTML +
                   `</details>`;
        }).join('');
        accessHTML = `<div class="sp-access-section">${items}</div>`;
    }

    return `
        <div class="station-popup-wrap modern">
            <div class="station-popup-name">${esc(name)}</div>
            ${staleBannerHTML}
            ${accessHTML}
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
    if (secs <= 30) return 'now';
    return `${Math.max(1, Math.round(secs / 60))}m`;
}

// ── Slot model ──────────────────────────────────────────────────────────────
// A 3×3 grid of slots around the station dot. MapLibre's `anchor` names the
// corner of the BADGE that sits at the lat/lng — anchor:'bottom-left' with
// positive offset places the badge to the upper-right of the dot. Each slot
// below is named for where the BADGE ends up relative to the dot.

const BADGE_OFFSET_PX = 10;
export const SLOTS = {
    TL: { anchor: 'bottom-right', offset: [-BADGE_OFFSET_PX, -BADGE_OFFSET_PX] },  // upper-left
    T:  { anchor: 'bottom',       offset: [0,                -BADGE_OFFSET_PX] },  // upper-mid
    TR: { anchor: 'bottom-left',  offset: [ BADGE_OFFSET_PX, -BADGE_OFFSET_PX] },  // upper-right
    R:  { anchor: 'left',         offset: [ BADGE_OFFSET_PX,  0] },                // right-mid
    BR: { anchor: 'top-left',     offset: [ BADGE_OFFSET_PX,  BADGE_OFFSET_PX] },  // lower-right
    B:  { anchor: 'top',          offset: [0,                 BADGE_OFFSET_PX] },  // lower-mid
    BL: { anchor: 'top-right',    offset: [-BADGE_OFFSET_PX,  BADGE_OFFSET_PX] },  // lower-left
    L:  { anchor: 'right',        offset: [-BADGE_OFFSET_PX,  0] },                // left-mid
};

// Per-terminus boarding-badge slot. Default 'TR' (upper-right of dot). Overrides
// for edge termini where TR would push off-screen or run over a route line.
// Match is lowercased substring of the station group's normName.
export const BOARDING_SLOT_OVERRIDES = [
    { match: 'santa monica',    slot: 'L' },  // A west
    { match: 'redondo beach',   slot: 'B' },  // C south
    { match: 'long beach',      slot: 'B' },  // A east
    { match: 'harbor gateway',  slot: 'B' },  // J south
    { match: 'san pedro',       slot: 'B' },  // J south alt name
    { match: 'lax',             slot: 'L' },  // K south
    { match: 'aviation',        slot: 'L' },  // K south alt name
    { match: 'la cienega',      slot: 'L' },  // D west
    { match: 'chatsworth',      slot: 'L' },  // G west
    { match: 'norwalk',         slot: 'B' },  // C east
    { match: 'north hollywood', slot: 'B' },  // B/G north
    { match: 'atlantic',        slot: 'L' },  // E east
    { match: 'el monte',        slot: 'L' },  // J east
];

export function resolveBoardingSlot(normName) {
    if (!normName) return 'TR';
    const n = normName.toLowerCase();
    for (const p of BOARDING_SLOT_OVERRIDES) {
        if (n.includes(p.match)) return p.slot;
    }
    return 'TR';
}

function _isOverrideMatch(normName) {
    return resolveBoardingSlot(normName) !== 'TR';
}

/**
 * Pure layout function. Given which badge types are present and where the
 * boarding badge must sit, returns the slot key for each present badge type
 * such that no two share a slot.
 *
 *   default (boarding TR, or no boarding) → alert TL, access BL
 *   boarding L (left-anchored terminus)   → alert TR, access BR
 *   boarding B (below-anchored terminus)  → alert TL, access TR
 *
 * @param {{ hasBoarding:boolean, boardingSlot?:string,
 *           hasAlert:boolean, hasAccess:boolean }} state
 * @returns {{ boarding?:string, alert?:string, access?:string }}
 */
export function chooseBadgeSlots({ hasBoarding, boardingSlot = 'TR', hasAlert, hasAccess }) {
    const out = {};
    if (hasBoarding) out.boarding = boardingSlot;

    if (hasBoarding && boardingSlot === 'L') {
        if (hasAlert)  out.alert  = 'TR';
        if (hasAccess) out.access = 'BR';
    } else if (hasBoarding && boardingSlot === 'B') {
        if (hasAlert)  out.alert  = 'TL';
        if (hasAccess) out.access = 'TR';
    } else {
        if (hasAlert)  out.alert  = 'TL';
        if (hasAccess) out.access = 'BL';
    }
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

function _makeAlertEl(tipText) {
    const wrap = document.createElement('div');
    wrap.className = 'station-alert-badge-wrap';
    wrap.dataset.alertText = tipText;
    const el = document.createElement('span');
    el.className = 'station-alert-badge';
    el.textContent = '!';
    el.setAttribute('aria-label', `Service alert: ${tipText}`);
    wrap.appendChild(el);
    wireAlertBadge(wrap, el);
    return wrap;
}

function _makeAccessEl(tipText) {
    const wrap = document.createElement('div');
    wrap.className = 'station-access-badge-wrap';
    wrap.dataset.alertText = tipText;
    const el = document.createElement('span');
    el.className = 'station-access-badge';
    el.textContent = '♿';
    el.setAttribute('aria-label', `Accessibility outage: ${tipText}`);
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
                result.set(badgeKey, { coords, normName: group?.normName ?? '', entries: [] });
            }
        }

        const matches = boarding.filter(b =>
            b.stopId === o.stopId && b.routeId === o.routeCode && b.directionId === o.dir
        );
        // Always push an entry for every terminating route — when nothing is
        // boarding yet, depLabel='' renders as '—' so the line never disappears.
        const soonestDep = matches.length
            ? matches.map(m => m.departureUnix).filter(t => t != null).sort((a, b) => a - b)[0] ?? null
            : null;
        result.get(badgeKey).entries.push({
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

    for (const [key, { coords, normName, entries }] of _collectBoardingState()) {
        perStation.set(key, { coords, normName, boardingEntries: entries });
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
            existing.alertTipText = dedupedAlerts
                .map(a => `${STRIP_EFFECT_LABELS[a.effect] ?? 'Service alert'}: ${a.header}`)
                .join('\n');
        }
        if (access.length) {
            const dedupedAccess = [...new Map(access.map(a => [a.id || a.header, a])).values()];
            existing.accessTipText = dedupedAccess
                .map(a => a.header || 'Elevator/escalator outage')
                .join('\n');
        }
        perStation.set(badgeKey, existing);
    }

    for (const [badgeKey, station] of perStation) {
        seenKeys.add(badgeKey);

        const hasBoarding = !!(station.boardingEntries?.length);
        const hasAlert    = !!station.alertTipText;
        const hasAccess   = !!station.accessTipText;
        const boardingSlot = resolveBoardingSlot(station.normName);
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
            buildEl: () => _makeAlertEl(station.alertTipText),
            updateEl: el => {
                el.dataset.alertText = station.alertTipText;
                el.querySelector('.station-alert-badge')
                    ?.setAttribute('aria-label', `Service alert: ${station.alertTipText}`);
            },
        });
        _syncBadgeMarker({
            map, entry, slotKey: slots.access, showBadges,
            kind: 'access',
            present: hasAccess,
            buildEl: () => _makeAccessEl(station.accessTipText),
            updateEl: el => {
                el.dataset.alertText = station.accessTipText;
                el.querySelector('.station-access-badge')
                    ?.setAttribute('aria-label', `Accessibility outage: ${station.accessTipText}`);
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

    const slot = SLOTS[slotKey];
    const existing = entry[markerField];

    if (existing && entry[slotField] === slotKey) {
        existing.setLngLat([entry.coords.lng, entry.coords.lat]);
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
        element: el, anchor: slot.anchor, offset: slot.offset,
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
    for (const entry of _stationBadges.values()) {
        if (entry.boardingMarker?._wrapEl) entry.boardingMarker._wrapEl.style.display = show ? '' : 'none';
        if (entry.alertMarker?._wrapEl)    entry.alertMarker._wrapEl.style.display    = show ? '' : 'none';
        if (entry.accessMarker?._wrapEl)   entry.accessMarker._wrapEl.style.display   = show ? '' : 'none';
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
