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

import { routeIcons, routeHexColors, FALLBACK_ROUTE_COLOR, BIKE_COLORS, routeDirectionLabels, ROUTE_LETTER, STATION_MERGE_RADIUS_M, STATION_CO_LOCATE_M, STATION_CLICK_MINZOOM, JLINE_STOP_CLICK_MINZOOM, STATION_POPUP_REFRESH_MS, STATION_BIKE_SEARCH_RADIUS_M, STATION_NEARBY_BUS_RADIUS_M, STATION_HOVER_DELAY_MS, PAST_ARRIVAL_GRACE_S, GTFS_ENTRY_STALENESS_S, FEED_STALE_THRESHOLD_S, METRO_ROUTE_CODES, BOARDING_MAX_HORIZON_S } from './config.js';
import { cleanDestination } from './ui.js';
import { planarMeters, cleanStationName, escHtml as esc, setVisibleInterval, clearVisibleInterval, stationNameKey, pillTitle } from './utils.js';
import { getScheduledArrivals, getTerminalName, isOriginStop, isTerminalStop, isNearTerminalStop, getBoardingVehicles, getRouteCache, resolveTripDestination } from './predictions.js';
import { STRIP_EFFECT_LABELS, getActiveAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, effectSeverity, accessibilitySeverity, formatActivePeriodLine } from './alerts.js';
import { getNearbyBikeStation } from './bikeshare.js';
import { getStationRestroom, RESTROOM_TYPE_LABEL } from './restrooms.js';
import { tripTerminusByTripId, getTripUpdatesFeedHealth } from './tripUpdates.js';
import { setActivePopup, notifyPopupClosed } from './popups.js';

const STATION_SOURCE = 'metro-stations';
const CLICK_LAYER    = 'metro-stations-click';        // rail + BRT — clickable from overview zoom
const CLICK_LAYER_JLINE = 'metro-stations-click-jline'; // J Line street/busway-only — gated to higher zoom

const RAIL_STOP_RE = /^8\d{4,5}$/;
const GJ_DEST_RE   = /\b[GJ]\s*Line\b|El\s+Monte|Harbor\s+Gtwy|Harbor\s+Gateway/i;

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

// NESW cardinal sort order for rail direction rows (N=0, E=1, S=2, W=3). One
// definition shared by the single-route and merged-J-Line block renderers.
const RAIL_CARDINAL_SORT = { N: 0, E: 1, S: 2, W: 3 };

/**
 * Render the compact "· N" / "· E" cardinal suffix that trails a station-popup
 * destination (or '' when the direction label isn't a cardinal). One helper for
 * both the single-route and merged-line row renderers.
 * @param {string} dirLabel  Direction label, e.g. "Northbound".
 * @returns {string} `<span class="sp-bus-cardinal">…</span>` or ''.
 */
function _cardinalHTML(dirLabel) {
    const letter = /^[NSEW]/.test(dirLabel || '') ? dirLabel.charAt(0) : null;
    return letter ? `<span class="sp-bus-cardinal" aria-hidden="true"> · ${letter}</span>` : '';
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
 * carrying every distinct description text, `_periods[]` carrying each
 * description's OWN activePeriod (index-aligned with `_descriptions`), and
 * `_count` tracking total inputs.
 *
 * `_periods` exists because a merged "Detour ×2" banner used to inherit only
 * the FIRST alert's activePeriod via `{ ...a }` — the second detour's window
 * was silently dropped, so a banner could show "– Jun 30" in its header while
 * its second body said "ends December 31" (the Sepulveda / J Line ×2 bug).
 * Consumers zip `_descriptions[i]` with `_periods[i]` to attribute a per-alert
 * "Active:" line to each body.
 *
 * Both consumers (station popup and map badge) call this to avoid the
 * "two alerts, same effect, different descriptions → only the last kept"
 * bug — the popup renders the structured shape directly, the badge flattens
 * `_descriptions` to produce one tooltip block per unique alert content.
 *
 * @param {Array<{effect:string, description?:string, activePeriod?:Object}>} alerts
 * @returns {Array<{_count:number, _descriptions:string[], _periods:Array<Object|null>}>}
 */
export function dedupeAlertsByEffect(alerts) {
    const byEffect = new Map();
    for (const a of alerts) {
        const desc = (a.description ?? '').trim();
        const existing = byEffect.get(a.effect);
        if (!existing) {
            byEffect.set(a.effect, {
                ...a,
                _count: 1,
                _descriptions: desc ? [desc] : [],
                _periods:      desc ? [a.activePeriod ?? null] : [],
            });
            continue;
        }
        existing._count++;
        if (desc && !existing._descriptions.includes(desc)) {
            existing._descriptions.push(desc);
            existing._periods.push(a.activePeriod ?? null);
        }
    }
    return [...byEffect.values()];
}

/**
 * Compute the "Active:" line(s) for a (possibly merged) service banner.
 *
 * Single distinct window across the group — including every unmerged ×1
 * banner — → one shared line (`header`), no per-body lines. The consumer
 * renders `header` as an sp-body-period line at the top of the expanded
 * body (NOT as the small .sp-banner-period summary span — owner call
 * 2026-06-12: every expanded service banner shows its window at the same
 * size, whether merged-identical, merged-distinct, or unmerged).
 *
 * Multiple distinct windows → NO header line; each body carries its own. An
 * earlier version showed a computed envelope (earliest start – latest end) in
 * the header, but with every paragraph already labelled it was redundant AND
 * matched NEITHER body — reading like a phantom third window. The per-body
 * lines are the complete, unambiguous story, so the header period is dropped.
 *
 * Exported for tests (pure; no DOM).
 *
 * @param {{activePeriod?:Object, _periods?:Array<Object|null>}} a merged alert
 * @returns {{header:string, perBody:string[]|null}}
 */
export function _mergedPeriodLines(a) {
    const periods = a._periods ?? [];
    const key = p => `${p?.start ?? 0}|${p?.end ?? Infinity}`;
    const distinct = new Set(periods.map(key));
    if (distinct.size <= 1) {
        // Header from the period of the description actually RENDERED, not the
        // group-level activePeriod ({...a} = first alert's). They differ when
        // the group's first alert had an EMPTY description: its period seeds
        // a.activePeriod but its absent body contributes nothing to
        // _descriptions — so the visible body rendered under the invisible
        // alert's window (the same mis-attribution class #469 fixed).
        // Identical in the normal case (periods[0] === a.activePeriod).
        const hp = periods[0] ?? a.activePeriod;
        return {
            header: formatActivePeriodLine(hp?.start ?? 0, hp?.end ?? Infinity),
            perBody: null,
        };
    }
    return {
        header: '',   // per-body lines carry every window; no redundant header
        perBody: periods.map(p => p ? formatActivePeriodLine(p.start ?? 0, p.end ?? Infinity) : ''),
    };
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
            : `<span class="sp-alert-chip" style="background:${routeHexColors[rc] ?? FALLBACK_ROUTE_COLOR}">${esc(letter)}</span>`;
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

// Matches stop names that identify BRT infrastructure (dedicated guideway or
// purpose-built facilities) rather than street intersections. Used by
// addToRegistry to set buswayStation=true so _isJLineOnly keeps those stops
// clickable at rail overview zoom (STATION_CLICK_MINZOOM) instead of gating
// them to JLINE_STOP_CLICK_MINZOOM. Add new alternatives here when Metro
// introduces HOV-lane stops under a naming convention not yet covered.
//   "harbor\s+fwy"   — J Line HOV-lane stops south of Harbor Gateway TC whose
//                      names omit "Transitway" (Harbor Fwy / Carson, PCH)
//   "park[\s-]and[\s-]ride" — Harbor Beacon Park and Ride (end of HOV lanes)
export const BRT_INFRA_NAME_RE = /transitway|busway|transit\s+center|\bstation\b|harbor\s+fwy|park[\s-]and[\s-]ride/i;

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
// routeCode (the busway trip's route, e.g. '910'/'950'/'901') is accumulated
// on the group so _isJLineOnly can later decide the click-target zoom tier.
function addToRegistry(stopId, stop, isBusway = false, routeCode = null) {
    // Stop IDs come from multiple feeds (stops.json, trip_updates, vehicle
    // properties) and arrive as a mix of strings and numbers. Normalize at
    // the registry entry point so every downstream `.includes()` and `.get()`
    // can assume strings — eliminates the three call sites that previously
    // coerced inconsistently (stations.js:652, 1062, 1358).
    const sid = String(stopId);
    const normName = cleanStationName(stop.name, false);
    const isBrtName = BRT_INFRA_NAME_RE.test(stop.name || '');
    let existing = findGroup(normName, stop.lat, stop.lon);
    if (!existing && isBusway) {
        existing = stationGroups.find(g =>
            planarMeters(g.lat, g.lon, stop.lat, stop.lon) < STATION_CO_LOCATE_M
        );
    }
    if (existing) {
        if (!existing.stopIds.includes(sid)) existing.stopIds.push(sid);
        if (routeCode) existing.routes.add(String(routeCode));
        if (isBrtName) existing.buswayStation = true;
        return false;
    }
    const group = {
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [sid],
        displayName: toDisplayName(normName),
        routes: new Set(routeCode ? [String(routeCode)] : []),
        buswayStation: isBrtName,
    };
    stationGroups.push(group);
    _groupByName.set(normName, group);
    return true;
}

// A group is "J Line street-running" when it has no rail platform (8xxxxx id),
// every route is 910/950, AND the stop is NOT named after BRT infrastructure.
// Street-running stops (Pacific / 17th, Figueroa / Pico, Flower / Adams, …)
// only appear on Metro's basemap at high zoom, so we gate their click targets
// to JLINE_STOP_CLICK_MINZOOM. Named BRT busway stations (Harbor Transitway / …,
// El Monte Station, Cal State LA Busway Station, Harbor Gateway TC, …) appear
// like rail stations at overview zoom and stay at STATION_CLICK_MINZOOM.
export function _isJLineOnly(g) {
    if (g.stopIds.some(id => RAIL_STOP_RE.test(id))) return false;
    if (!g.routes || g.routes.size === 0) return false;
    // Every route here must be J (910 rapid + 950 commuter) — key off the
    // canonical ROUTE_LETTER map instead of hardcoding the two route codes.
    for (const r of g.routes) if (ROUTE_LETTER[r] !== 'J') return false;
    if (g.buswayStation) return false;
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
            gated:    _isJLineOnly(g),
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
    // Rail + BRT stations (everything not gated): clickable from the overview zoom.
    if (!map.getLayer(CLICK_LAYER)) {
        map.addLayer({
            id: CLICK_LAYER,
            type: 'circle',
            source: STATION_SOURCE,
            minzoom: STATION_CLICK_MINZOOM,
            filter: ['!=', ['get', 'gated'], true],
            paint: { 'circle-radius': 18, 'circle-opacity': 0, 'circle-stroke-width': 0 },
        });
    }
    // J Line street/busway-only stops: only clickable once zoomed in to where
    // Metro's basemap renders their dots — keeps the rail/BRT hit area clear at
    // overview zooms (see JLINE_STOP_CLICK_MINZOOM in config.js).
    if (!map.getLayer(CLICK_LAYER_JLINE)) {
        map.addLayer({
            id: CLICK_LAYER_JLINE,
            type: 'circle',
            source: STATION_SOURCE,
            minzoom: JLINE_STOP_CLICK_MINZOOM,
            filter: ['==', ['get', 'gated'], true],
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
    // _groupByName must be cleared in lockstep with the array. It indexes group
    // objects by name; if left populated, findGroup() returns stale references
    // that are no longer in stationGroups, so addToRegistry merges every stop
    // into an orphaned group and the rebuilt array comes back nearly empty —
    // wiping the station dots at the midnight rollover and on the trips-load-
    // after-map startup path (main.js).
    _groupByName.clear();
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

    // Both click layers (rail/BRT and the zoom-gated J Line layer) share the
    // same click/hover behavior — wire each one. Features in the two layers are
    // disjoint (the `gated` filter), so a point can only ever hit one of them.
    _wireStationLayerEvents(map, CLICK_LAYER);
    _wireStationLayerEvents(map, CLICK_LAYER_JLINE);

    // Phase 2: G/J busway stops
    addBuswayStopsFromTrips(map);
}

/**
 * Attach click + hover handlers for a station click layer. Called once per
 * click layer (rail/BRT and the zoom-gated J Line layer) so both behave
 * identically. Each layer keeps its own hover timer.
 * @param {maplibregl.Map} map
 * @param {string} layerId
 */
function _wireStationLayerEvents(map, layerId) {
    map.on('click', layerId, (e) => {
        if (e.originalEvent.target.closest('.maplibregl-marker')) return;
        const props   = e.features[0].properties;
        const coords  = e.features[0].geometry.coordinates.slice();
        const stopIds = props.stopIds ? props.stopIds.split(',') : [props.stopId];
        showArrivalsPopup(map, coords, stopIds, props.stopName, true);
        e.originalEvent.stopPropagation();
    });

    let hoverTimer;
    map.on('mouseenter', layerId, (e) => {
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
        }, STATION_HOVER_DELAY_MS);
    });

    map.on('mouseleave', layerId, () => {
        map.getCanvas().style.cursor = '';
        clearTimeout(hoverTimer);
        if (!activePopup?.isPinned) closeStationPopup();
    });
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
            addToRegistry(sid, stop, true, trip.rc);
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
    activePopupStopIds = stopIds;
    // offset 12 (was 8): keep the popup tail clear of the tapped station dot
    // and its label on phones — matches the vehicle popup's breathing room.
    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 12 })
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
                    // Preserve scroll position: .station-popup-wrap IS the
                    // scroll container (max-height 60vh, overflow-y auto), and
                    // replaceWith() hands the rider a fresh element at
                    // scrollTop 0. On busy stations (7th/Metro) the HTML
                    // changes nearly every 5 s tick, so a reader scrolled into
                    // the bus list was yanked back to the top every few
                    // seconds. Restore AFTER insertion — the browser clamps to
                    // the new content height if the list shrank.
                    const prevScrollTop = currentWrap.scrollTop;
                    currentWrap.replaceWith(fresh);
                    if (prevScrollTop > 0) fresh.scrollTop = prevScrollTop;
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

    const arrivals = _collectStationArrivals(stopIds, now);

    const name = stopName || stopIds[0];

    if (!arrivals.length && !boardingAtOrigin.length) {
        clearVehicleHighlights();
        return `<div class="station-popup-wrap">
            <h3 class="station-popup-name">${esc(name)}</h3>
            <div class="station-popup-empty">No upcoming arrivals</div>
            ${_renderAmenityRow(stopIds)}
        </div>`;
    }

    // Routes rendered in the top "rail" section: true rail (801–807) plus
    // rail-like rapid bus corridors (G/J Lines). Anything else — local city buses
    // whose stopId happens to be folded into this station group — flows into the
    // NEARBY BUSES section below, never the top section.
    // 806 (L Line) is retired/merged and has no icon, color, or direction-label
    // entries in config.js — METRO_ROUTE_CODES omits it so orphaned arrivals
    // can't create broken rows.
    const routeMap = _buildStationRouteMap(arrivals, boardingAtOrigin, stopIds);

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

    const rowsHTML = _renderRailRouteBlocks(routeMap, stopIds, boardingAtOrigin, now);

    const amenityHTML = _renderAmenityRow(stopIds);

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
            ${amenityHTML}
        </div>
    `;
}

/**
 * Collect the de-duplicated, time-sorted list of scheduled arrivals across all
 * stop_ids in a station group.
 *
 * Cross-stop_id dedup: transfer stations have multiple platform stop_ids,
 * and the same trip can land in masterArrivalsData under several of them.
 * tripId is the canonical GTFS identity — key by it always. The previous
 * mixed key (vehicleId-routeId when present, tripId otherwise) split the
 * same trip across two namespaces when one frame had vehicleId set and
 * another didn't, producing duplicate "Now" pills on the popup. When
 * duplicates collide, keep the earliest arrivalUnix (the soonest arrival
 * is what the rider standing at the transfer cares about).
 * @param {string[]} stopIds  Station-group stop ids.
 * @param {number} now        Unix seconds (shared clock read for the whole popup).
 * @returns {Array} Arrivals sorted ascending by arrivalUnix.
 */
function _collectStationArrivals(stopIds, now) {
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
    return arrivals;
}

/**
 * Build the rail-section routeMap (routeId → { 0: arrivals[], 1: arrivals[] })
 * from live arrivals, then seed it with boarding-only and cache-only rows so a
 * route row appears even when no live vehicle is currently tracking.
 * @param {Array} arrivals          Deduped, sorted arrivals from _collectStationArrivals.
 * @param {Array} boardingAtOrigin  Boarding vehicles at origin stops (getBoardingVehicles).
 * @param {string[]} stopIds        Station-group stop ids.
 * @returns {Map} routeMap keyed by routeId.
 */
function _buildStationRouteMap(arrivals, boardingAtOrigin, stopIds) {
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

    return routeMap;
}

/**
 * Render the per-arrival time pills for a single route+direction row.
 * Origin stops show departure times from getBoardingVehicles, supplemented by
 * approaching trains from getScheduledArrivals (deduped by tripId); other stops
 * show arrival times from the scheduled list. Sorted ascending so the soonest
 * pill is always on the left.
 * @returns {string} pill HTML (always non-empty — falls back to an em-dash).
 */
function _renderRowPills(routeId, dirIdx, list, stopIds, boardingAtOrigin, now) {
    let pillsHTML = '';
    if (isOriginStop(stopIds, routeId, dirIdx)) {
        const boarding = boardingAtOrigin
            .filter(b => b.routeId === routeId && b.directionId === dirIdx);
        const boardingTripIds = new Set(boarding.map(b => b.tripId).filter(Boolean));
        // Include approaching trains not yet boarding (within 10 min) from scheduled list
        const approaching = list
            .filter(a => !boardingTripIds.has(a.tripId) && (a.arrivalUnix - now) <= BOARDING_MAX_HORIZON_S)
            .map(a => ({ ...a, departureUnix: a.arrivalUnix }));
        const merged = [...boarding, ...approaching]
            .sort((a, b) => (a.departureUnix ?? Infinity) - (b.departureUnix ?? Infinity));
        pillsHTML = merged.slice(0, 2).map(b => {
            const secAway = b.departureUnix != null ? Math.round(b.departureUnix - now) : null;
            const { label, isNow } = _formatArrivalPill(secAway, b.atStop);
            const t = esc(pillTitle(label));
            return `<span class="arr-time-pill${isNow ? ' now' : ''}" role="img" aria-label="${t}" title="${t}">${label}</span>`;
        }).join('');
        if (!pillsHTML) pillsHTML = `<span class="sp-no-data">—</span>`;
    } else if (list.length) {
        const sorted = [...list].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
        pillsHTML = sorted.slice(0, 2).map(a => {
            const secAway = Math.round(a.arrivalUnix - now);
            const { label, isNow } = _formatArrivalPill(secAway, a.atStop);
            const isLast = !!window.masterTripsData?.[a.tripId]?.isLast;
            const lastTag = isLast ? `<span class="pill-last">LAST</span>` : '';
            const t = esc(pillTitle(label, isLast));
            return `<span class="arr-time-pill${isNow ? ' now' : ''}" role="img" aria-label="${t}" title="${t}">${label}${lastTag}</span>`;
        }).join('');
    } else {
        pillsHTML = `<span class="sp-no-data">—</span>`;
    }
    return pillsHTML;
}

/**
 * Re-attribute geometrically-impossible live arrivals onto the same-line route
 * that actually serves this stop, BEFORE rendering. During a J Line detour the
 * feed can tag an arrival with a route+direction that doesn't reach this stop —
 * e.g. a 910 (El Monte ⟷ Harbor Gateway) southbound arrival at Harbor Fwy /
 * Carson, a 950-only stop SOUTH of Harbor Gateway. Dropping it would hide a real
 * bus and leave the southbound side reading "—"; instead move its time onto the
 * SAME-LINE route that does serve this stop in that direction, when exactly one
 * such route exists (950 → San Pedro at Carson). The rider keeps the arrival
 * under the only destination that direction can physically reach.
 *
 * Constrained to the same line LETTER (ROUTE_LETTER) so an A-Line arrival is
 * never re-attributed to the interlined E Line — only J's 910/950 pair (the one
 * line with two route codes) is ever affected. When 0 same-line routes serve the
 * stop, or the choice is ambiguous (2+), the arrival is left in place and
 * renderRow's geometric guard suppresses the impossible row instead.
 * Mutates `routeMap` in place (a fresh Map per popup).
 * @param {Map} routeMap      routeId → { 0: arrivals[], 1: arrivals[] }.
 * @param {string[]} stopIds  Station-group stop ids.
 */
function _reattributeOffRouteArrivals(routeMap, stopIds) {
    const serves = (rc, dir) => {
        const c = getRouteCache(rc, dir);
        return !!(c?.stops && stopIds.some(sid => c.stops.includes(sid)));
    };
    for (const [routeId, dirs] of [...routeMap.entries()]) {
        for (const dir of [0, 1]) {
            const list = dirs[dir];
            if (!list.length) continue;
            const cache = getRouteCache(routeId, dir);
            // No static sequence, or this route+dir serves the stop → arrivals
            // are legitimately here; leave them.
            if (!cache?.stops || stopIds.some(sid => cache.stops.includes(sid))) continue;
            // Same-line route codes that DO serve this stop in this direction.
            const targets = [...METRO_ROUTE_CODES].filter(rid =>
                rid !== routeId &&
                ROUTE_LETTER[rid] === ROUTE_LETTER[routeId] &&
                serves(rid, dir));
            if (targets.length !== 1) continue; // none / ambiguous → guard drops it
            if (!routeMap.has(targets[0])) routeMap.set(targets[0], { 0: [], 1: [] });
            const tgt = routeMap.get(targets[0]);
            tgt[dir] = tgt[dir].concat(list);
            dirs[dir] = [];
        }
    }
}

/**
 * Render the rail-section route blocks (top section of the popup): one
 * `.sp-route` block per route, each with up to two direction rows. Routes are
 * sorted by line letter; direction rows within a block by NESW cardinal order.
 * Terminal/near-terminal/duplicate-destination rows are suppressed so the popup
 * shows only useful boarding info.
 * @param {Map} routeMap             routeId → { 0: arrivals[], 1: arrivals[] }.
 * @param {string[]} stopIds         Station-group stop ids.
 * @param {Array} boardingAtOrigin   Boarding vehicles at origin stops.
 * @param {number} now               Unix seconds (shared clock read).
 * @returns {string} concatenated route-block HTML.
 */
export function _renderRailRouteBlocks(routeMap, stopIds, boardingAtOrigin, now) {
    // Move detour-misrouted arrivals onto the same-line route that serves this
    // stop before rendering (see _reattributeOffRouteArrivals). Whatever survives
    // off-route after this is genuinely unserved here and renderRow drops it.
    _reattributeOffRouteArrivals(routeMap, stopIds);

    // Track destinations already rendered so empty cache-seeded rows don't echo
    // a terminal already shown by a live-arrival row from another route (e.g. the
    // 950 El Monte direction duplicating the 910 El Monte row at Harbor Gateway TC).
    const shownDestinations = new Set();

    // Group route ids by line LETTER so the two J Line routes (910 + 950) render
    // as ONE block under a single J icon. 910 ends at Harbor Gateway TC; 950
    // through-runs to San Pedro, so the merged block keeps BOTH southbound
    // destinations as separate rows while collapsing the shared El Monte
    // northbound direction into one combined row. Every other letter maps to a
    // single route, so it takes the single-route path with unchanged output.
    const byLetter = new Map();
    for (const routeId of routeMap.keys()) {
        const letter = ROUTE_LETTER[routeId] ?? routeId;
        if (!byLetter.has(letter)) byLetter.set(letter, []);
        byLetter.get(letter).push(routeId);
    }

    return [...byLetter.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([letter, routeIds]) => routeIds.length > 1
            ? _renderMergedLineBlock(letter, routeIds, routeMap, stopIds, boardingAtOrigin, now, shownDestinations)
            : _renderSingleRouteBlock(routeIds[0], routeMap.get(routeIds[0]), stopIds, boardingAtOrigin, now, shownDestinations))
        .join('');
}

/**
 * Render ONE route's `.sp-route` block (up to two direction rows). The common
 * case — every line letter except J maps to a single route code.
 * @param {string} routeId
 * @param {{0:Array,1:Array}} dirs       Per-direction arrival lists.
 * @param {string[]} stopIds
 * @param {Array} boardingAtOrigin
 * @param {number} now
 * @param {Set<string>} shownDestinations Cross-block dedup of empty rows.
 * @returns {string} `.sp-route` block HTML, or '' when nothing renders.
 */
function _renderSingleRouteBlock(routeId, dirs, stopIds, boardingAtOrigin, now, shownDestinations) {
        const letter = ROUTE_LETTER[routeId]   ?? routeId;
        const labels = routeDirectionLabels[routeId] || { 0: 'Dir 0', 1: 'Dir 1' };

        // Sort direction rows by NESW cardinal order (RAIL_CARDINAL_SORT, module-level).
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

            // Suppress rows for directions/stops this route+direction provably
            // doesn't serve, keyed off the static (route|dir) stop sequence cache
            // (initPredictions picks the longest GTFS pattern, so cache membership
            // == "this route serves this stop"). Two cases:
            //   (a) Empty one-way rows: J Line DTLA stops are one-way — Figueroa St
            //       for northbound (dir=0), Flower St for southbound (dir=1). A
            //       Figueroa stop is in the dir=0 cache but not dir=1, so its
            //       southbound row would permanently show "—".
            //   (b) Mis-attributed LIVE rows: during a J Line detour the feed can
            //       report a 910 (El Monte⟷Harbor Gateway) arrival at a 950-only
            //       stop SOUTH of Harbor Gateway (e.g. Harbor Fwy / Carson), which
            //       would render "Harbor Gateway TC · S" — a southbound bus heading
            //       to a place NORTH of the rider. _reattributeOffRouteArrivals has
            //       already moved such times onto the same-line route that serves
            //       this stop (950 → San Pedro) when one unambiguously exists; a
            //       live list still off-route HERE means re-attribution was
            //       impossible (no/ambiguous same-line route), so the row is dropped.
            // The cross-line spike guard drops the same impossible attribution for
            // the marker; this is its station-popup analogue. Applies whether or not
            // live arrivals are present — a route that can't reach this stop must not
            // render a destination here regardless of what the feed claims.
            if (!isOriginStop(stopIds, routeId, dirIdx)) {
                const cache = getRouteCache(routeId, dirIdx);
                if (cache?.stops && !stopIds.some(sid => cache.stops.includes(sid))) return '';
            }

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

            const pillsHTML = _renderRowPills(routeId, dirIdx, list, stopIds, boardingAtOrigin, now);

            // Skip completely empty rows (terminal side with no arrivals)
            if (!dest && !pillsHTML) return '';

            const iconSrc = routeIcons[routeId] ?? '';
            const badge = showBadge
                ? `<img src="${iconSrc}" class="sp-route-icon" alt="${esc(letter)}">`
                : `<div class="sp-badge-gap"></div>`;

            if (dest) shownDestinations.add(dest);
            const dirLabel = labels[dirIdx] ?? '';
            const cardinalHTML = _cardinalHTML(dirLabel);
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
}

/**
 * Render the merged J Line block: routes 910 + 950 under a single J icon. Rows
 * are grouped by DESTINATION, so the shared El Monte / Downtown LA northbound
 * direction collapses into one row whose pills combine both routes' times, while
 * the southbound split — 910 → Harbor Gateway TC, 950 → San Pedro — renders as
 * two separate rows. A rider north of Harbor Gateway thus sees the San Pedro
 * ETAs (950) and the Harbor-Gateway-only ETAs (910) distinctly, never merged
 * into one misleading destination. Generalises to any letter with >1 route;
 * today only J qualifies. Suppression mirrors _renderSingleRouteBlock's renderRow
 * (terminal / off-route-cache / near-terminal-empty / already-shown-empty).
 * @param {string} letter                Line letter (e.g. 'J').
 * @param {string[]} routeIds            Route codes sharing this letter.
 * @param {Map} routeMap                 routeId → { 0: arrivals[], 1: arrivals[] }.
 * @param {string[]} stopIds
 * @param {Array} boardingAtOrigin
 * @param {number} now
 * @param {Set<string>} shownDestinations
 * @returns {string} `.sp-route` block HTML, or '' when nothing renders.
 */
function _renderMergedLineBlock(letter, routeIds, routeMap, stopIds, boardingAtOrigin, now, shownDestinations) {

    // Phase 1 — collect the renderable (routeId, dirIdx) rows with their resolved
    // destination + arrival list, applying the SAME suppression gates renderRow uses.
    const rows = [];
    for (const routeId of routeIds) {
        const dirs = routeMap.get(routeId);
        if (!dirs) continue;
        const labels = routeDirectionLabels[routeId] || { 0: 'Dir 0', 1: 'Dir 1' };
        for (const dirIdx of [0, 1]) {
            // Terminal: trains are arriving, not departing — skip.
            if (isTerminalStop(stopIds, routeId, dirIdx)) continue;
            // Off-route for this (route|dir): the static stop sequence doesn't
            // include this stop, so the route can't reach it here (drops both
            // empty one-way rows and any still-off-route live arrival).
            if (!isOriginStop(stopIds, routeId, dirIdx)) {
                const cache = getRouteCache(routeId, dirIdx);
                if (cache?.stops && !stopIds.some(sid => cache.stops.includes(sid))) continue;
            }
            const list = dirs[dirIdx] || [];
            // Empty row at a near-terminal stop (rider already at the destination end).
            if (!list.length && !isOriginStop(stopIds, routeId, dirIdx) && isNearTerminalStop(stopIds, routeId, dirIdx)) continue;

            let dest;
            if (list.length) {
                const firstTripId = list[0].tripId;
                const tripInfo    = firstTripId ? window.masterTripsData?.[firstTripId] : null;
                const cleanedDest = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
                dest = resolveTripDestination(routeId, dirIdx, firstTripId, tripInfo, cleanedDest) ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
            } else {
                dest = getTerminalName(routeId, dirIdx) ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
            }
            const dirLabel = labels[dirIdx] ?? '';
            rows.push({ routeId, dirIdx, dest, list, dirLabel, cardOrd: RAIL_CARDINAL_SORT[dirLabel.charAt(0)] ?? 4 });
        }
    }

    // Phase 2 — group by destination so same-destination rows across routes merge
    // their arrival lists (El Monte from 910 + 950 → one row with combined pills).
    const byDest = new Map();
    for (const r of rows) {
        const g = byDest.get(r.dest);
        if (!g) byDest.set(r.dest, { ...r, list: [...r.list] });
        else g.list.push(...r.list);   // keep the first row's routeId/dirLabel for icon + cardinal
    }

    // Phase 3 — render one row per destination, ordered by cardinal (N before S)
    // then routeId (Harbor Gateway's 910 before San Pedro's 950). The J icon sits
    // on the first rendered row only.
    let badgeUsed = false;
    const rowsHTML = [...byDest.values()]
        .sort((a, b) => a.cardOrd - b.cardOrd || a.routeId.localeCompare(b.routeId))
        .map(g => {
            const isOrig = isOriginStop(stopIds, g.routeId, g.dirIdx);
            // Empty row whose destination is already shown elsewhere — drop it.
            if (!g.list.length && !isOrig && g.dest && shownDestinations.has(g.dest)) return '';
            const pillsHTML = _renderRowPills(g.routeId, g.dirIdx, g.list, stopIds, boardingAtOrigin, now);
            if (!g.dest && !pillsHTML) return '';
            if (g.dest) shownDestinations.add(g.dest);
            const iconSrc = routeIcons[g.routeId] ?? '';
            const badge = !badgeUsed
                ? `<img src="${iconSrc}" class="sp-route-icon" alt="${esc(letter)}">`
                : `<div class="sp-badge-gap"></div>`;
            badgeUsed = true;
            const cardinalHTML = _cardinalHTML(g.dirLabel);
            return `
                <div class="sp-row">
                    ${badge}
                    <div class="sp-dest">${esc(g.dest)}${cardinalHTML}</div>
                    <div class="sp-pills">${pillsHTML}</div>
                </div>`;
        })
        .join('');

    if (!rowsHTML) return '';
    return `<div class="sp-route">${rowsHTML}</div>`;
}

/**
 * One combined amenity row: bike-share counts + restroom availability. The
 * two used to be separate rows with identical chrome — merging them saves
 * ~26 px at the bottom of the popup, exactly where fold pressure lands on
 * busy stations (UX audit F7). Count order and pluralization match the
 * standalone bikeshare popup (bikes → e-bikes → docks; audit F9). Bikes
 * render on the first line; the restroom (when present) always sits on its
 * own line BELOW the bikes — never beside them (owner preference). It's still
 * one bordered block (shared border + padding), so it stays cheaper than the
 * pre-F7 two-separate-rows layout while keeping the restroom on its own row.
 *
 * Bike search radius is 160 m: 120 m missed legitimate stations (e.g.
 * Wilshire/La Cienega at 135 m) because Metro Bike docks are sometimes placed
 * at the far end of a large plaza.
 * @param {string[]} stopIds Station-group stop ids.
 * @returns {string} `.sp-amenity-row` HTML, or '' when neither amenity exists.
 */
function _renderAmenityRow(stopIds) {
    const group = stationGroups.find(g => stopIds.some(id => g.stopIds.includes(String(id))));
    if (!group) return '';
    const bs = getNearbyBikeStation(group.lat, group.lon, STATION_BIKE_SEARCH_RADIUS_M);
    const restroomType = getStationRestroom(group);
    if (!bs && !restroomType) return '';

    const parts = [];
    if (bs) {
        const bikes  = bs.bikes  || 0;
        const ebikes = bs.ebikes || 0;
        const docks  = bs.docks  || 0;
        const plural = (n, w) => `${w}${n === 1 ? '' : 's'}`;
        const segs = [];
        if (bikes)            segs.push(`<span class="sp-bike-seg" style="--bc:${BIKE_COLORS.bike}">${bikes}<span class="sp-bike-lbl">${plural(bikes, 'bike')}</span></span>`);
        if (ebikes)           segs.push(`<span class="sp-bike-seg" style="--bc:${BIKE_COLORS.ebike}">${ebikes}<span class="sp-bike-lbl">${plural(ebikes, 'e-bike')}</span></span>`);
        if (!bikes && !ebikes) segs.push(`<span class="sp-bike-seg" style="--bc:${BIKE_COLORS.dock}">0<span class="sp-bike-lbl">bikes</span></span>`);
        segs.push(`<span class="sp-bike-seg" style="--bc:${BIKE_COLORS.dock}">${docks}<span class="sp-bike-lbl">${plural(docks, 'dock')}</span></span>`);
        parts.push(`<span class="sp-amenity-seg"><span class="sp-bike-icon">🚲</span>${segs.join('')}</span>`);
    }
    if (restroomType) {
        const label = RESTROOM_TYPE_LABEL[restroomType] ?? 'Restroom available';
        parts.push(`<span class="sp-amenity-seg"><span class="sp-restroom-icon" role="img" aria-label="Restroom">${RESTROOM_LINE_SVG}</span>${esc(label)}</span>`);
    }
    return `<div class="sp-amenity-row">${parts.join('')}</div>`;
}

// Restroom availability line — static, curated (restrooms.js). Shown only when
// the station is on the curated list. The icon is an inline SVG (man | woman +
// divider) rather than the 🚻 color-emoji so it tints + sizes with the row text.
const RESTROOM_LINE_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<circle cx="6.6" cy="4.6" r="2.3"/>' +
    '<rect x="4.2" y="7.6" width="4.8" height="9.6" rx="2.1"/>' +
    '<line x1="12" y1="3.5" x2="12" y2="20.5" stroke="currentColor" stroke-width="1.2" opacity="0.4"/>' +
    '<circle cx="17.4" cy="4.6" r="2.3"/>' +
    '<polygon points="17.4,7.4 14,17.2 20.8,17.2"/>' +
    '</svg>';


/**
 * Resolve a nearby-bus arrival's destination label. Riders pick a bus by where
 * it's going far more than by compass bearing, so the terminus stop name leads
 * ("Pioneer") with the 8-bucket cardinal as a small disambiguator ("· E"); the
 * full route long_name stays in the hover title. The cardinal is measured from
 * the station group's coords (fromLat/fromLon) to the terminus.
 * @param {string|undefined} tripId
 * @param {{long_name?:string}|undefined} routeMeta
 * @param {number} fromLat  Station-group latitude.
 * @param {number} fromLon  Station-group longitude.
 * @returns {{labelHTML:string, title:string, cardinal:(string|null)}}
 */
function _resolveBusDest(tripId, routeMeta, fromLat, fromLon) {
    let labelHTML = '';
    const titleParts = [];
    let cardinal = null;
    if (tripId) {
        const termStopId = tripTerminusByTripId?.get(String(tripId));
        if (termStopId) {
            const stop = window.masterStopsData?.[String(termStopId)];
            if (stop) {
                cardinal = compute8Cardinal(fromLat, fromLon, stop.lat, stop.lon);
                const stopName = stop.name ? cleanStationName(stop.name) : null;
                if (stopName && cardinal) {
                    labelHTML = `${esc(stopName)}<span class="sp-bus-cardinal" aria-hidden="true"> · ${cardinal}</span>`;
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
}

/**
 * Nearby buses section — bus routes serving stops within NEARBY_BUS_RADIUS_M
 * (225 m) of the merged station centroid. The radius is measured from the
 * rail-station group's lat/lon, so a bus stop on the far side of a wide
 * intersection (e.g. the opposite-direction stop across Wilshire/La Brea)
 * still falls inside it — 200 m clipped some of those, dropping one direction
 * of a route from the popup even while it was running.
 * Skips rail route_codes (8xx) and any route already shown above (e.g. G/J
 * when a busway stop is folded into this rail station). Grouped by route:
 * each route block shows up to 2 direction rows (badge on first row,
 * gap on second), each row carrying its own destination + pill ETAs.
 * UNCAPPED: every route within the radius renders, in route-number order
 * (the .sp-bus-list internal scroll bounds the popup height, not a cap).
 * Exported for tests (pins the uncapped-list + display-order contract).
 * @param {string[]} stopIds  Station-group stop ids (to resolve the group).
 * @param {number} now        Unix seconds (passed so the whole popup shares one clock read).
 * @param {Map} routeMap      Rail routeMap — its keys are the routes already shown above.
 * @returns {string} bus-details HTML, or '' when no nearby buses.
 */
export function _renderNearbyBusSection(stopIds, now, routeMap) {
    const group = stationGroups.find(g => stopIds.some(id => g.stopIds.includes(String(id))));
    let busHTML = '';
    if (group) {
        // Radius from the merged-station centroid (STATION_NEARBY_BUS_RADIUS_M).
        const NEARBY_BUS_RADIUS_M = STATION_NEARBY_BUS_RADIUS_M;
        const ownRoutes = new Set(routeMap.keys());
        // routeId → { 0: arrivals[], 1: arrivals[] }
        const byRoute = new Map();
        // Per-slot seen-tripId Sets to avoid O(n²) dedup inside the inner loop.
        const slotSeen = new Map(); // `${routeId}:${dir}` → Set<tripId>
        for (const { stopId } of getNearbyBusStops(group.lat, group.lon, NEARBY_BUS_RADIUS_M)) {
            const list = window.masterArrivalsData?.get(stopId) ?? [];
            for (const a of list) {
                if (a.arrivalUnix < now - PAST_ARRIVAL_GRACE_S) continue;
                // Staleness gate — match the predictions pipeline (predictions.js
                // L-1). This section reads masterArrivalsData DIRECTLY (not via
                // getScheduledArrivals, which already applies this gate), so
                // without it a CANCELED/pulled trip's arrivals — whose lastIngestUnix
                // stops advancing the moment the trip stops being re-ingested —
                // linger as phantom "nearby bus" rows until each predicted time
                // individually passes. CANCELED is 2–5% of Metro's trip-update
                // volume daily, so this is the rider-visible leak the gate closes.
                if (now - (a.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S) continue;
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
        if (byRoute.size) {
            // EVERY route within the radius renders — the former
            // NEARBY_BUS_MAX_ROUTES = 6 cap was removed (owner call,
            // 2026-06-12): popup height is already bounded by the
            // .sp-bus-list internal scroll (max-height 160px), so a
            // 20-route hub costs scroll depth, not popup height. Routes
            // sort by route number so rows stay stable across the 5 s
            // refresh cycle (a soonest-first sort would reshuffle rows on
            // every tick).
            const routeIdSortKey = (id) => {
                const n = Number(id);
                return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
            };
            const ranked = [...byRoute.entries()].map(([routeId, dirs]) => {
                dirs[0].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                dirs[1].sort((a, b) => a.arrivalUnix - b.arrivalUnix);
                return { routeId, dirs };
            }).sort((a, b) =>
                routeIdSortKey(a.routeId) - routeIdSortKey(b.routeId)
                || String(a.routeId).localeCompare(String(b.routeId)));

            const renderBusRow = (routeId, arrivals, badgeHTML, dest) => {
                if (!arrivals.length) return '';
                const pills = arrivals.slice(0, 2).map(a => {
                    const secAway = Math.round(a.arrivalUnix - now);
                    const { label, isNow } = _formatArrivalPill(secAway, a.atStop);
                    const t = esc(pillTitle(label));
                    return `<span class="arr-time-pill${isNow ? ' now' : ''}" role="img" aria-label="${t}" title="${t}">${label}</span>`;
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
                const dest0 = _resolveBusDest(dirs[0][0]?.tripId, meta, group.lat, group.lon);
                const dest1 = _resolveBusDest(dirs[1][0]?.tripId, meta, group.lat, group.lon);
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
            const countLabel = `${ranked.length}`;
            // Scent for the collapsed state: the route numbers themselves, so
            // a rider waiting for the 204 knows whether to expand at all. The
            // span is single-line and ellipsis-truncated in CSS — at stations
            // with many routes it shows as many as fit, never wraps or grows.
            const routeNums = ranked
                .map(({ routeId }) => esc(window.masterBusRoutes?.[routeId]?.short_name ?? routeId))
                .join(' · ');
            busHTML = `<details class="sp-bus-details">
                <summary class="sp-bus-summary">
                    <span class="sp-bus-summary-label">Nearby buses</span>
                    <span class="sp-bus-summary-routes">${routeNums}</span>
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
// Effect → station-popup banner label. Extends alerts.js's STRIP_EFFECT_LABELS
// with the accessibility entry; "Service alert" is the safe fallback for any
// effect code Metro adds later.
const STATION_POPUP_LABELS = { ...STRIP_EFFECT_LABELS, ACCESSIBILITY_ISSUE: 'Elevator/escalator' };
const STATION_POPUP_EFFECT_PRIORITY = ['DETOUR','NO_SERVICE','REDUCED_SERVICE','SIGNIFICANT_DELAYS','MODIFIED_SERVICE','STOP_MOVED','OTHER_EFFECT','UNKNOWN_EFFECT'];

/**
 * Render the accessibility (♿) banners. Dedups by alert id then by
 * header+description fingerprint (Metro tags the same outage to several stop
 * IDs), drops a feed headline that merely repeats the station name, and keys
 * severity off the elevator/escalator classification.
 * @param {Array} accessAlerts Raw accessibility alerts across the group's stops.
 * @param {string} stopName    Popup title, for redundant-header suppression.
 * @returns {string} concatenated <details> banner HTML (may be '').
 */
function _renderAccessAlerts(accessAlerts, stopName) {
    // First dedup by alert ID, then by content fingerprint — Metro sometimes
    // tags the same outage to multiple stop IDs (e.g. merged 910/950 stops at
    // El Monte) producing different IDs but identical header + description.
    const seenContent = new Set();
    return [...new Map(accessAlerts.map(a => [a.id || a.header, a])).values()]
        .filter(a => {
            const fp = `${(a.header || '').trim().toLowerCase()}|\
${(a.description || '').trim().toLowerCase()}`;
            if (seenContent.has(fp)) return false;
            seenContent.add(fp);
            return true;
        })
        .map(a => {
            // Facility-specific label so riders see at a glance whether
            // it's an elevator they need or escalator they can detour.
            const type = classifyAccessibilityAlert(a.header, a.description);
            const facilityLabel = _accessFacilityLabel(type);
            // Drop the feed's headline when it adds nothing over the station
            // name above. Containment, not equality: a MERGED station name is
            // longer than a per-line alert header that names one component, so
            // the header key is a SUBSET of the station key (exact-equality
            // missed it). _isRedundantStationName normalizes both sides.
            const headerTrim = (a.header || '').trim();
            const isRedundantName = _isRedundantStationName(headerTrim, stopName);
            const titleHTML = (!headerTrim || isRedundantName)
                ? esc(facilityLabel)
                : `${esc(facilityLabel)} — ${esc(headerTrim)}`;
            const body = (a.description || '').trim();
            const bodyHTML = body ? _alertBodyHTML(body) : '';
            // Severity keyed off the facility classification (elevator/both →
            // severe, escalator-only → moderate) — same rule as the marker badge.
            const sev = accessibilitySeverity(type);
            const periodLine = formatActivePeriodLine(a.activePeriod?.start ?? 0, a.activePeriod?.end ?? Infinity);
            const periodSpan = periodLine ? `<span class="sp-banner-period">${esc(periodLine)}</span>` : '';
            return `<details class="sp-banner sp-banner--access" data-severity="${sev}" data-alert-id="${esc(a.id)}">` +
                   `<summary class="sp-banner-title">♿ ${titleHTML}${periodSpan}</summary>` +
                   bodyHTML +
                   `</details>`;
        }).join('');
}

/**
 * Render the service (⚠) banners from the effect-deduped alert list. Each shows
 * line-bullet chips (which routes the effect touches), the effect label + ×N
 * count, and its active window(s) in the body.
 * @param {Array} dedupedService Output of dedupeAlertsByEffect, already sorted.
 * @param {Map<string,Set<string>>} routesByEffect effect → routes, for the chips.
 * @returns {string} concatenated <details> banner HTML (may be '').
 */
function _renderServiceAlerts(dedupedService, routesByEffect) {
    return dedupedService.map(a => {
        // Generic effects deliberately KEEP the plain "Service alert" label.
        // A headline-derived summary label was tried (UX audit F3) and reverted
        // per owner: too much info in the collapsed line — the chips + label +
        // ×N count are the whole collapsed story, the headline is a tap away.
        const label = STATION_POPUP_LABELS[a.effect] ?? 'Service alert';
        const count = a._count > 1 ? ` <span class="sp-banner-count">×${a._count}</span>` : '';
        // Per-alert "Active:" attribution for merged (×N) banners. Distinct
        // windows → one line above each body paragraph; a single shared window
        // (or an unmerged banner) → one sp-body-period line at the top of the
        // body, at the same size (owner call 2026-06-12).
        const { header: periodLine, perBody } = _mergedPeriodLines(a);
        const sharedPeriodHTML = periodLine ? `<div class="sp-body-period">${esc(periodLine)}</div>` : '';
        const bodyHTML = sharedPeriodHTML + (a._descriptions.length
            ? a._descriptions.map((d, i) => {
                const pl = perBody?.[i];
                return (pl ? `<div class="sp-body-period">${esc(pl)}</div>` : '') + _alertBodyHTML(d);
            }).join('')
            : (a.header ? _alertBodyHTML(a.header) : ''));
        const sev = effectSeverity(a.effect);
        const chipsHTML = _alertRouteChips(routesByEffect.get(a.effect));
        return `<details class="sp-banner sp-banner--service" data-severity="${sev}" data-alert-id="${esc(a.id)}">` +
               `<summary class="sp-banner-title">${chipsHTML}<span class="sp-banner-label">⚠ ${label}${count}</span></summary>` +
               bodyHTML +
               `</details>`;
    }).join('');
}

/**
 * Orchestrate the unified station alerts section: gather accessibility + service
 * alerts, dedupe service by effect, sort by affected line then effect priority,
 * and render the two streams (access first — it's station-blocking).
 */
function _renderStationAlertsSection(stopIds, routeMap, stopName) {
    const accessAlerts = stopIds.flatMap(id => getActiveStopAccessibilityAlerts(id));
    // getActiveAlerts already applies the canonical activePeriod filter. Build
    // (a) the cross-route effect→routes map for the banner chips, and (b) the
    // id-deduped active-service list (Metro tags one alert across many routes,
    // so it appears under each route's getActiveAlerts()).
    const routesByEffect = new Map();
    const seenIds = new Set();
    const activeService = [];
    for (const rId of routeMap.keys()) {
        for (const a of getActiveAlerts(rId)) {
            let set = routesByEffect.get(a.effect);
            if (!set) { set = new Set(); routesByEffect.set(a.effect, set); }
            set.add(rId);
            if (seenIds.has(a.id)) continue;
            seenIds.add(a.id);
            activeService.push(a);
        }
    }
    // PRIMARY sort: the alphabetically-first line letter an effect touches, so
    // banners read in line order (B before J); effect priority is the tiebreak.
    // '￿' sorts routeless alerts last.
    const firstLineLetter = (effect) => {
        const set = routesByEffect.get(effect);
        if (!set || set.size === 0) return '￿';
        return [...set].map(rc => ROUTE_LETTER[rc] ?? rc).sort()[0];
    };
    const dedupedService = dedupeAlertsByEffect(activeService)
        .sort((a, b) => {
            const la = firstLineLetter(a.effect), lb = firstLineLetter(b.effect);
            if (la !== lb) return la.localeCompare(lb);
            return (STATION_POPUP_EFFECT_PRIORITY.indexOf(a.effect) + 1 || 99) - (STATION_POPUP_EFFECT_PRIORITY.indexOf(b.effect) + 1 || 99);
        });

    if (!accessAlerts.length && !dedupedService.length) return '';
    return `<div class="sp-alerts-section">${_renderAccessAlerts(accessAlerts, stopName)}${_renderServiceAlerts(dedupedService, routesByEffect)}</div>`;
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

