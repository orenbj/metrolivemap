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
import { planarMeters, cleanStationName, escHtml as esc, setVisibleInterval, clearVisibleInterval, computeBearing, stationNameKey } from './utils.js';
import { getScheduledArrivals, getTerminalName, isOriginStop, isTerminalStop, isNearTerminalStop, getBoardingVehicles, getAllOriginStops, getRouteCache, resolveTripDestination } from './predictions.js';
import { STRIP_EFFECT_LABELS, getActiveAlerts, getActiveStopAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, wireAlertBadge, buildAlertTooltipText, buildAlertTooltipBlock, maxSeverity, maxAccessibilitySeverity, effectSeverity, accessibilitySeverity, formatActivePeriodLine } from './alerts.js';
import { getNearbyBikeStation } from './bikeshare.js';
import { tripTerminusByTripId, getTripUpdatesFeedHealth } from './tripUpdates.js';
import { snapToRoute, hasShapeData, lngLatAtArc, arcLengths } from './snap.js';
import { setActivePopup, notifyPopupClosed } from './popups.js';

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
 * Format a relative seconds-until-arrival/departure into the station-popup
 * pill string. Three callers (rail boarding+approaching, rail arrivals, bus
 * arrivals) used to inline this ladder with subtle drift — one had a
 * `secAway < 0 || secAway < 30` negative-bypass and the others didn't, so
 * a past-arrival rail-only row briefly showed "Now" while the boarding row
 * showed the same value as "-3m". A null `secAway` also collapses to "Now"
 * so callers don't have to special-case missing departureUnix.
 * @param {number|null|undefined} secAway Seconds until the event.
 * @returns {{label: string, isNow: boolean}}
 */
export function _formatArrivalPill(secAway, atStop) {
    // "Now" means the train is AT this stop. When the caller knows the vehicle's
    // live status (`atStop` is a boolean from getScheduledArrivals), honor it so
    // the station board matches the vehicle popup EXACTLY — the popup gates "Now"
    // on STOPPED_AT, so a train that's reached its predicted arrival time but is
    // still IN_TRANSIT must read "<1m" on BOTH surfaces, and "Now" only once it's
    // STOPPED_AT here. (Before this, the board used secAway<=0 while the popup
    // used STOPPED_AT, so the same train showed "Now" on the board and "<1m" in
    // the popup.) When status is UNKNOWN (`atStop === undefined`: GTFS-only
    // arrivals with no live marker, or bus rows), fall back to the time proxy
    // — secAway <= 0, or a null secAway (missing departureUnix) — for "Now".
    const isNow = atStop === true
        || (atStop !== false && (secAway == null || secAway <= 0));
    // "<1m" over "30s": the explicit "less than" notation is impossible to
    // misread as "30 minutes" when glanced at on a crowded popup.
    const label = isNow ? 'Now'
                : secAway < 60 ? '<1m'
                : `${Math.floor(secAway / 60)}m`;
    return { label, isNow };
}

/**
 * Map a `classifyAccessibilityAlert` result to a localized facility label.
 * Three usage sites (popup banner, badge aria-label, badge update) — keeping
 * the lookup in one place ensures translations and casing stay consistent.
 * @param {'elevator'|'escalator'|'both'|null|undefined} type
 * @returns {string}
 */
/**
 * Effect-level dedup that preserves all distinct descriptions seen for the
 * same effect code. Returns one entry per unique effect, with `_descriptions[]`
 * carrying every distinct description text and `_count` tracking total inputs.
 *
 * Both consumers (station popup and map badge) call this to avoid the
 * "two alerts, same effect, different descriptions → only the last kept"
 * bug — the popup renders the structured shape directly, the badge flattens
 * `_descriptions` to produce one tooltip block per unique alert content.
 *
 * @param {Array<{effect:string, description?:string}>} alerts
 * @returns {Array<{_count:number, _descriptions:string[]}>}
 */
export function dedupeAlertsByEffect(alerts) {
    const byEffect = new Map();
    for (const a of alerts) {
        const desc = (a.description ?? '').trim();
        const existing = byEffect.get(a.effect);
        if (!existing) {
            byEffect.set(a.effect, { ...a, _count: 1, _descriptions: desc ? [desc] : [] });
            continue;
        }
        existing._count++;
        if (desc && !existing._descriptions.includes(desc)) {
            existing._descriptions.push(desc);
        }
    }
    return [...byEffect.values()];
}

export function _accessFacilityLabel(type) {
    if (type === 'elevator')  return 'Elevator outage';
    if (type === 'escalator') return 'Escalator outage';
    if (type === 'both')      return 'Elevator & escalator outage';
    return 'Accessibility outage';
}

/**
 * True when an alert's header adds nothing over the station name already shown
 * as the popup title — so it should be dropped rather than rendered as a
 * redundant subtitle. Both sides are normalized via stationNameKey (lowercase,
 * drop "station", collapse non-alphanumerics).
 *
 * Uses CONTAINMENT, not equality: a merged station ("Harbor Transitway / 37th
 * St / USC") has a longer display name than a per-line alert header ("37TH
 * ST/USC STATION") that names just one component — the header key is a subset
 * of the station key. Equality missed that. The reverse (header longer than
 * the station name) is NOT treated as redundant — that extra text is real
 * info worth keeping as a subtitle.
 *
 * @param {string} header   Raw alert header.
 * @param {string} stopName Station display name (popup title).
 * @returns {boolean}
 */
export function _isRedundantStationName(header, stopName) {
    const headerKey  = stationNameKey((header || '').trim());
    const stationKey = stationNameKey(stopName || '');
    return !!headerKey && !!stationKey && stationKey.includes(headerKey);
}

/**
 * Render line-bullet chips for a service-alert banner showing which route(s)
 * at this station the alert affects. Station service alerts are kept at the
 * top of the popup (so they don't push arrivals offscreen and can be tagged to
 * multiple routes), and these chips restore the line association a rider would
 * otherwise have to guess at. Uses Metro's official line-bullet icons
 * (`routeIcons`) for correct contrast + visual parity with the arrival rows;
 * falls back to a brand-color letter pill for any route lacking an icon.
 *
 * @param {Set<string>|undefined} routeCodes  Route IDs at this station the alert touches.
 * @returns {string} HTML (empty string when no routes).
 */
export function _alertRouteChips(routeCodes) {
    if (!routeCodes || routeCodes.size === 0) return '';
    // Collapse to unique line letters (910 + 950 both → "J"); keep one
    // representative route id per letter for the icon/color lookup.
    const byLetter = new Map();
    for (const rc of routeCodes) {
        const letter = ROUTE_LETTER[rc] ?? rc;
        if (!byLetter.has(letter)) byLetter.set(letter, rc);
    }
    const entries = [...byLetter.entries()].sort(([a], [b]) => a.localeCompare(b));
    const chips = entries.map(([letter, rc]) => {
        const icon = routeIcons[rc];
        // Intrinsic width/height ATTRIBUTES (not just CSS) so the remote SVG —
        // which has a large natural size — is constrained even if the new
        // .sp-alert-chip-icon CSS rule hasn't loaded (stale cached stylesheet).
        // Without them, fresh JS + stale CSS rendered the bullet at full size.
        return icon
            ? `<img src="${icon}" class="sp-alert-chip-icon" width="15" height="15" alt="${esc(letter)}">`
            : `<span class="sp-alert-chip" style="background:${routeHexColors[rc] || '#231f20'}">${esc(letter)}</span>`;
    }).join('');
    const label = entries.map(([l]) => l).join(', ');
    return `<span class="sp-alert-chips" role="img" aria-label="Affects ${esc(label)} Line${entries.length > 1 ? 's' : ''}">${chips}</span>`;
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

// stationNameKey lives in utils.js — used here for redundant-name detection
// in popup banners, and in alerts.js for filtering out "alternative station"
// stopIds that Metro tags alongside the actually-affected station.

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
        clearVisibleInterval(activePopupRefreshTimer);
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

    // Single active popup: showing this station popup closes any other open
    // popup (vehicle / bike / micro). closeStationPopup is our canonical
    // teardown — it also clears vehicle highlights and restores focus, which a
    // bare popup.remove() would skip. See js/popups.js.
    setActivePopup(closeStationPopup);

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
    if (activePopupRefreshTimer) clearVisibleInterval(activePopupRefreshTimer);
    // setVisibleInterval pauses when the tab is hidden — avoids re-running
    // buildArrivalsHTML + DOM diff against an invisible popup. Every other
    // recurring timer in the project uses this same wrapper. Capture the
    // returned token in a closure-local so the re-entry guard below can
    // cancel THIS specific timer rather than whatever the module-level
    // `activePopupRefreshTimer` currently points at — by the time the
    // re-entry fires, the module pointer may already be the NEW popup's
    // timer (set by the synchronous re-entry into showArrivalsPopup).
    const _myTimer = setVisibleInterval(() => {
        // Re-entry guard: the refresh callback's body calls
        // `currentWrap.replaceWith(fresh)` further down — DOM mutation can
        // trigger event listeners on the displaced subtree, including the
        // `__hoverStationByGroup` hook bikeshare.js consumes. A hover listener
        // can re-enter `showArrivalsPopup` synchronously, after which the
        // module-level `activePopup` / `activePopupStopIds` point at the
        // *new* popup; the remainder of this tick would then mutate the new
        // popup with the old station's data. The closure-captured `stopIds`
        // here is the OLD popup's identity; the module-level pointer is the
        // NEW one. When they diverge, bail before writing.
        if (activePopupStopIds !== stopIds) {
            clearVisibleInterval(_myTimer);
            // Only null the module pointer if it still names us — if a
            // re-entry installed a fresh timer, that one is now authoritative.
            if (activePopupRefreshTimer === _myTimer) activePopupRefreshTimer = null;
            return;
        }
        // Self-cancel if the popup has been removed by any path that didn't
        // run the close handler (e.g. direct popup.remove() from elsewhere).
        if (!activePopup || !activePopup.isOpen?.() || !activePopup.getElement()?.isConnected) {
            clearVisibleInterval(_myTimer);
            if (activePopupRefreshTimer === _myTimer) activePopupRefreshTimer = null;
            return;
        }
        try {
            const el = activePopup.getElement();
            const content = el?.querySelector('.maplibregl-popup-content');
            if (!content) return;
            const newHTML = buildArrivalsHTML(stopIds, stopName);
            const currentWrap = content.querySelector('.station-popup-wrap');
            // The smart in-place replacement path (preserves <details> open
            // state) requires the .station-popup-wrap subtree from the prior
            // render. Without it, fall through to a full setHTML replace.
            // This happens once on first refresh after open (no prior wrap
            // exists) and shouldn't happen subsequently — log only when it
            // does, gated by a session flag to avoid spam if DOM lifecycle
            // ever drifts.
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
                        const match = fresh.querySelector(`.sp-banner[data-alert-id="${CSS.escape(id)}"]`);
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
    activePopupRefreshTimer = _myTimer;

    activePopup.on('close', () => {
        notifyPopupClosed(closeStationPopup);
        if (activePopupRefreshTimer) {
            clearVisibleInterval(activePopupRefreshTimer);
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
            <h3 class="station-popup-name">${esc(name)}</h3>
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

        // Sort direction rows by NESW cardinal order (N=0, E=1, S=2, W=3).
        const RAIL_CARDINAL_SORT = { N: 0, E: 1, S: 2, W: 3 };
        const cardOrd = (dirIdx) => {
            const lbl = labels[dirIdx] ?? '';
            return RAIL_CARDINAL_SORT[lbl.charAt(0)] ?? 4;
        };
        const [leftDir, rightDir] = cardOrd(0) <= cardOrd(1) ? [0, 1] : [1, 0];

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
                    const secAway = b.departureUnix != null ? Math.round(b.departureUnix - now) : null;
                    const { label, isNow } = _formatArrivalPill(secAway, b.atStop);
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${label}</span>`;
                }).join('');
                if (!pillsHTML) pillsHTML = `<span class="sp-no-data">—</span>`;
            } else if (list.length) {
                const sorted = [...list].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                pillsHTML = sorted.slice(0, 2).map(a => {
                    const secAway = Math.round(a.arrivalUnix - now);
                    const { label, isNow } = _formatArrivalPill(secAway, a.atStop);
                    const lastTag = window.masterTripsData?.[a.tripId]?.isLast ? `<span class="pill-last">LAST</span>` : '';
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${label}${lastTag}</span>`;
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
            const dirLabel = labels[dirIdx] ?? '';
            const cardinalLetter = /^[NSEW]/.test(dirLabel) ? dirLabel.charAt(0) : null;
            const cardinalHTML = cardinalLetter ? `<span class="sp-bus-cardinal" aria-hidden="true"> · ${cardinalLetter}</span>` : '';
            return `
                <div class="sp-row">
                    ${badge}
                    <div class="sp-dest">${esc(dest)}${cardinalHTML}</div>
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

    const bikeHTML = _renderBikeSection(stopIds);

    const nearbyBusHTML = _renderNearbyBusSection(stopIds, now, routeMap);

    const staleBannerHTML = _renderStaleFeedBanner(now, routeMap, nearbyBusHTML);

    const alertsHTML = _renderStationAlertsSection(stopIds, routeMap, stopName);

    return `
        <div class="station-popup-wrap modern">
            <h3 class="station-popup-name">${esc(name)}</h3>
            ${staleBannerHTML}
            ${alertsHTML}
            <div class="sp-table">${rowsHTML}</div>
            ${nearbyBusHTML}
            ${bikeHTML}
        </div>
    `;
}

/**
 * Bike share section — find the nearest station within 160 m of this group.
 * 120 m missed several legitimate stations (e.g. Wilshire/La Cienega at 135 m)
 * because Metro Bike docks are sometimes placed at the far end of a large plaza.
 * Coerce to String to honor the registry invariant (addToRegistry stores
 * stopIds as strings). Callers reaching here may pass numbers, especially
 * from feed-derived integer ids.
 * @returns {string} bike-row HTML, or '' when no nearby station.
 */
function _renderBikeSection(stopIds) {
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
    return bikeHTML;
}

/**
 * Nearby buses section — bus routes serving stops within 0.1 mi (~160 m).
 * Skips rail route_codes (8xx) and any route already shown above (e.g. G/J
 * when a busway stop is folded into this rail station). Grouped by route:
 * each route block shows up to 2 direction rows (badge on first row,
 * gap on second), each row carrying its own destination + pill ETAs.
 * @param {string[]} stopIds  Station-group stop ids (to resolve the group).
 * @param {number} now        Unix seconds (passed so the whole popup shares one clock read).
 * @param {Map} routeMap      Rail routeMap — its keys are the routes already shown above.
 * @returns {string} bus-details HTML, or '' when no nearby buses.
 */
function _renderNearbyBusSection(stopIds, now, routeMap) {
    const group = stationGroups.find(g => stopIds.some(id => g.stopIds.includes(String(id))));
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
                // directionId from the feed may be null for malformed trip_updates.
                // Mirror the rail block above (lines 529-541): do NOT silently
                // default to 0 — that puts a SB bus in the NB column and a
                // rider may board going the wrong way. Render unknown-direction
                // arrivals in BOTH directions so they show up somewhere visible.
                const dirs = a.directionId === 0 ? [0]
                           : a.directionId === 1 ? [1]
                           : [0, 1];
                if (!byRoute.has(a.routeId)) byRoute.set(a.routeId, { 0: [], 1: [] });
                for (const dir of dirs) {
                    const slotKey = `${a.routeId}:${dir}`;
                    if (!slotSeen.has(slotKey)) slotSeen.set(slotKey, new Set());
                    const seen = slotSeen.get(slotKey);
                    // Skip the dedup when tripId is missing — otherwise Set.has(null)
                    // collapses every malformed null-tripId arrival into a single
                    // row, hiding genuinely distinct buses (low-probability feed
                    // quirk but a real rider impact: "where did the 2nd bus go?").
                    // Fall back to vehicleId so two distinct vehicles still dedup
                    // legitimately.
                    const dedupKey = a.tripId ?? (a.vehicleId ? `vid:${a.vehicleId}` : null);
                    if (dedupKey != null) {
                        if (seen.has(dedupKey)) continue;
                        seen.add(dedupKey);
                    }
                    byRoute.get(a.routeId)[dir].push(a);
                }
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
                routeIdSortKey(a.routeId) - routeIdSortKey(b.routeId)
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
                                labelHTML = `${esc(stopName)}<span class="sp-bus-cardinal"> · ${cardinal}</span>`;
                                titleParts.push(stopName);
                            } else if (stopName) {
                                labelHTML = esc(stopName);
                                titleParts.push(stopName);
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
                    const { label, isNow } = _formatArrivalPill(secAway, a.atStop);
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}">${label}</span>`;
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
    return busHTML;
}

/**
 * Stale-feed banner: when the trip_updates WS for a feed this popup depends
 * on has been silent past FEED_STALE_THRESHOLD_S, surface it so users know
 * displayed ETAs may not reflect ground truth. Rail feed is needed whenever
 * any METRO_ROUTE_CODES row was rendered; bus feed is needed when the nearby
 * buses block exists. Boot-time zero is treated as fresh (no false alarm
 * before the first frame arrives).
 * @param {number} now           Unix seconds (shared popup clock read).
 * @param {Map} routeMap         Rail routeMap — size > 0 means a rail row was shown.
 * @param {string} nearbyBusHTML The rendered nearby-bus block (truthy ⇒ bus shown).
 * @returns {string} banner HTML, or '' when no feed is stale.
 */
function _renderStaleFeedBanner(now, routeMap, nearbyBusHTML) {
    const _feedHealth = getTripUpdatesFeedHealth();
    const _showsRail  = routeMap.size > 0;
    const _showsBus   = !!nearbyBusHTML;
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
    return staleBannerHTML;
}

/**
 * Station-scoped alerts (accessibility + service). Both are rendered at
 * the top of the popup since they apply to the whole station, not to any
 * single route block. Service alerts used to live inside each route's
 * sp-route block; consolidating them up here means they share width and
 * chrome with the access banner and don't push live arrivals offscreen.
 * Per-route association is preserved by the line-bullet chips added to each
 * service banner (see _alertRouteChips) — so a rider still sees which line(s)
 * an alert affects without re-introducing the offscreen-arrivals problem or
 * duplicating a multi-route alert under each line.
 * @param {string[]} stopIds  Station-group stop ids (accessibility alerts are per-stop).
 * @param {Map} routeMap      Rail routeMap — its keys are the routes at this station.
 * @param {string} stopName   Display name (for redundant-header suppression).
 * @returns {string} alerts-section HTML, or '' when no active alerts.
 */
function _renderStationAlertsSection(stopIds, routeMap, stopName) {
    const accessAlerts  = stopIds.flatMap(id => getActiveStopAccessibilityAlerts(id));
    const routeIdsAtStation = [...routeMap.keys()];
    // getActiveAlerts already applies the canonical activePeriod filter — keeping
    // a parallel inline filter here meant the rule lived in two places (different
    // boundary semantics: `<=` vs `>`) and could drift silently on either side.
    // Cross-route dedupe by id stays here because Metro tags one alert across
    // multiple routes; effect-level dedupe with ×N count happens below.
    const _seenIds = new Set();
    // Accumulate which station routes each EFFECT touches, for the line chips
    // on the banner. Keyed by effect because dedupeAlertsByEffect (below)
    // merges alerts by effect — so the chips on a merged "Detour ×2" banner
    // are the UNION of routes across both detours. An alert tagged to several
    // routes (Metro does this) appears under each route's getActiveAlerts(),
    // so every affected route lands in the set.
    const _routesByEffect = new Map();
    const _activeService = [];
    for (const rId of routeIdsAtStation) {
        for (const a of getActiveAlerts(rId)) {
            let set = _routesByEffect.get(a.effect);
            if (!set) { set = new Set(); _routesByEffect.set(a.effect, set); }
            set.add(rId);
            // Cross-route dedupe by id (one alert tagged across multiple routes).
            if (_seenIds.has(a.id)) continue;
            _seenIds.add(a.id);
            _activeService.push(a);
        }
    }
    const STATION_POPUP_EFFECT_PRIORITY = ['DETOUR','NO_SERVICE','REDUCED_SERVICE','SIGNIFICANT_DELAYS','MODIFIED_SERVICE','STOP_MOVED','OTHER_EFFECT','UNKNOWN_EFFECT'];
    const STATION_POPUP_LABELS = { ...STRIP_EFFECT_LABELS, ACCESSIBILITY_ISSUE: 'Elevator/escalator' };
    // The alphabetically-first line letter an effect touches (its chip group),
    // used as the PRIMARY banner sort so alerts read in line order — B's alert
    // before J's. Effect priority (Detour > Modified service > …) is the
    // tiebreaker within a line. '￿' sorts routeless alerts last.
    const _firstLineLetter = (effect) => {
        const set = _routesByEffect.get(effect);
        if (!set || set.size === 0) return '￿';
        return [...set].map(rc => ROUTE_LETTER[rc] ?? rc).sort()[0];
    };
    const dedupedService = dedupeAlertsByEffect(_activeService)
        .sort((a, b) => {
            const la = _firstLineLetter(a.effect), lb = _firstLineLetter(b.effect);
            if (la !== lb) return la.localeCompare(lb);
            return (STATION_POPUP_EFFECT_PRIORITY.indexOf(a.effect) + 1 || 99) - (STATION_POPUP_EFFECT_PRIORITY.indexOf(b.effect) + 1 || 99);
        });

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
                // Drop the feed's headline when it adds nothing over the
                // station name above. Metro authors send the station name in
                // many forms — "37TH ST/USC STATION", "WILSHIRE/NORMANDIE",
                // "Hollywood/Vine Station" — all of which would render as
                // redundant subtitles next to the popup title. stationNameKey
                // normalizes both sides (lowercase, drop "station", collapse
                // non-alphanumerics).
                //
                // Containment, not equality: a MERGED station (e.g. "Harbor
                // Transitway / 37th St / USC") has a longer display name than
                // the per-line alert header ("37TH ST/USC STATION") which only
                // names one component — so the header key is a SUBSET of the
                // station key, and exact-equality missed it. Treat the header
                // as redundant when its key is contained in the station key.
                // (We don't do the reverse — a header LONGER than the station
                // name carries extra info worth keeping as a subtitle.)
                const headerTrim = (a.header || '').trim();
                const isRedundantName = _isRedundantStationName(headerTrim, stopName);
                const titleHTML = (!headerTrim || isRedundantName)
                    ? esc(facilityLabel)
                    : `${esc(facilityLabel)} — ${esc(headerTrim)}`;
                const body = (a.description || '').trim();
                const bodyHTML = body ? _alertBodyHTML(body) : '';
                // Severity for accessibility banners is keyed off the
                // facility classification (elevator/both → severe,
                // escalator-only → moderate) — same rule as the marker
                // badge ::after dot.
                const sev = accessibilitySeverity(type);
                const periodLine = formatActivePeriodLine(a.activePeriod?.start ?? 0, a.activePeriod?.end ?? Infinity);
                const periodHTML = periodLine ? `<div class="sp-banner-period">${esc(periodLine)}</div>` : '';
                return `<details class="sp-banner sp-banner--access" data-severity="${sev}" data-alert-id="${esc(a.id)}">` +
                       `<summary class="sp-banner-title">♿ ${titleHTML}</summary>` +
                       bodyHTML + periodHTML +
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
            // data-severity carries the alert's effect severity (severe vs
            // moderate) so the popup banner matches the badge + chip color
            // scheme everywhere else in the app.
            const sev = effectSeverity(a.effect);
            // Line chips: which route(s) at this station this effect touches.
            const chipsHTML = _alertRouteChips(_routesByEffect.get(a.effect));
            // Chips render to the LEFT of the ⚠ icon, vertically centered with
            // the label (the title is flexed in CSS). The label is wrapped so
            // it's a single flex item next to the chips.
            const periodLine = formatActivePeriodLine(a.activePeriod?.start ?? 0, a.activePeriod?.end ?? Infinity);
            const periodHTML = periodLine ? `<div class="sp-banner-period">${esc(periodLine)}</div>` : '';
            return `<details class="sp-banner sp-banner--service" data-severity="${sev}" data-alert-id="${esc(a.id)}">` +
                   `<summary class="sp-banner-title">${chipsHTML}<span class="sp-banner-label">⚠ ${label}${count}</span></summary>` +
                   bodyHTML + periodHTML +
                   `</details>`;
        }).join('');
        alertsHTML = `<div class="sp-alerts-section">${accessItems}${serviceItems}</div>`;
    }
    return alertsHTML;
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

