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
import { getScheduledArrivals, getTerminalName, isOriginStop, isTerminalStop, getBoardingVehicles, getAllOriginStops } from './predictions.js';
import { STRIP_EFFECT_LABELS } from './alerts.js';
import { getNearbyBikeStation } from './bikeshare.js';

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
let _lastHighlightVids = null;

// Central registry: each entry represents one clickable dot on the map.
export const stationGroups = [];
window.stationGroups = stationGroups; // shared read-only reference for bikeshare.js

// ── Name helpers ──────────────────────────────────────────────────────────────

function toDisplayName(normalized) {
    const stripped = normalized.replace(/\s+Station\s*$/i, '').trim();
    return stripped.length >= 6 ? stripped : normalized;
}

// ── Group registry ────────────────────────────────────────────────────────────

function findGroup(normName, lat, lon) {
    return stationGroups.find(g =>
        g.normName === normName &&
        planarMeters(g.lat, g.lon, lat, lon) < STATION_MERGE_RADIUS_M
    );
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
    stationGroups.push({
        normName,
        lat: stop.lat,
        lon: stop.lon,
        stopIds: [stopId],
        displayName: toDisplayName(normName),
    });
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
            paint: { 'circle-radius': 14, 'circle-opacity': 0, 'circle-stroke-width': 0 },
        });
    }
}

export function reAddStationLayer(map) {
    _addStationSourceAndLayer(map);
}

// ── Public ────────────────────────────────────────────────────────────────────

export function initStations(map) {
    if (!window.masterStopsData) return;

    // Phase 1: rail stops
    Object.entries(window.masterStopsData).forEach(([stopId, stop]) => {
        if (!RAIL_STOP_RE.test(stopId)) return;
        if (!stop.lat || !stop.lon) return;
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
            if (!stop?.lat || !stop?.lon) return;
            addToRegistry(sid, stop, true);
        });
    });

    _addStationSourceAndLayer(map);
}

// ── Arrivals popup ────────────────────────────────────────────────────────────

export function closeStationPopup() {
    if (activePopupRefreshTimer) {
        clearInterval(activePopupRefreshTimer);
        activePopupRefreshTimer = null;
    }
    if (activePopup) { activePopup.remove(); activePopup = null; }
    activePopupStopIds = null;
    clearVehicleHighlights();
}

function showArrivalsPopup(map, coords, stopIds, stopName, pinned = false) {
    closeStationPopup();
    activePopupStopIds = stopIds;
    activePopup = new maplibregl.Popup({ maxWidth: '300px', className: 'station-popup', offset: 8 })
        .setLngLat(coords)
        .setHTML(buildArrivalsHTML(stopIds, stopName)) // safe: all feed-derived values go through esc() — see buildArrivalsHTML
        .addTo(map);
    activePopup.isPinned = pinned;

    activePopupRefreshTimer = setInterval(() => {
        if (!activePopup) return;
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
        activePopup = null;
        activePopupStopIds = null;
        clearVehicleHighlights();
    });
}

function clearVehicleHighlights() {
    _lastHighlightVids = null;
    document.querySelectorAll('.marker.debug-highlight-vehicle')
        .forEach(el => el.classList.remove('debug-highlight-vehicle'));
}

function applyVehicleHighlights(vidSet) {
    const same = _lastHighlightVids &&
        vidSet.size === _lastHighlightVids.size &&
        [...vidSet].every(v => _lastHighlightVids.has(v));
    if (same) return;
    _lastHighlightVids = vidSet;
    document.querySelectorAll('.marker').forEach(el => {
        const vid = el.getAttribute('data-vehicle-id');
        el.classList.toggle('debug-highlight-vehicle', vidSet.has(vid));
    });
}

function buildArrivalsHTML(stopIds, stopName) {
    const now = Math.floor(Date.now() / 1000);

    // Boarding vehicles at origin stops — used for departure pills on origin rows.
    // getBoardingVehicles is more reliable than getScheduledArrivals here because
    // getScheduledArrivals suppresses calc ETA for STOPPED_AT origin vehicles.
    const boardingAtOrigin = getBoardingVehicles(stopIds);

    const arrivals = [];
    const seenKey  = new Set();
    stopIds.forEach(sid => {
        getScheduledArrivals(sid).forEach(a => {
            if (a.arrivalUnix < now - 60) return;
            const key = `${a.vehicleId}-${a.routeId}`;
            if (!seenKey.has(key)) { seenKey.add(key); arrivals.push(a); }
        });
    });
    arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    const name = stopName || stopIds[0];

    if (!arrivals.length) {
        clearVehicleHighlights();
        return `<div class="station-popup-wrap">
            <div class="station-popup-name">${esc(name)}</div>
            <div class="station-popup-empty">No upcoming arrivals</div>
        </div>`;
    }

    // Group by routeId → directionId
    const routeMap = new Map();
    arrivals.forEach(a => {
        if (!routeMap.has(a.routeId)) routeMap.set(a.routeId, { 0: [], 1: [] });
        routeMap.get(a.routeId)[a.directionId].push(a);
    });

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

        const resolveTerminus = (dirIdx, tripInfo) => {
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
            return t ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
        };

        const renderRow = (dirIdx, showBadge) => {
            const list = dirs[dirIdx] || [];
            const isTerminal = isTerminalStop(stopIds, routeId, dirIdx);

            // At terminus stations, trains are arriving — skip the row to keep popups clean
            if (isTerminal) return '';

            // Destination label
            let dest = '';
            if (list.length) {
                const tripInfo = list[0].tripId ? window.masterTripsData?.[list[0].tripId] : null;
                dest = resolveTerminus(dirIdx, tripInfo);
            } else {
                dest = getTerminalName(routeId, dirIdx) ?? labels[dirIdx] ?? `Dir ${dirIdx}`;
            }

            // Pills — origin stops show departure times from getBoardingVehicles.
            // Sort ascending by time so the soonest pill is always on the left.
            let pillsHTML = '';
            if (isOriginStop(stopIds, routeId, dirIdx)) {
                const boarding = boardingAtOrigin
                    .filter(b => b.routeId === routeId && b.directionId === dirIdx)
                    .sort((a, b) => (a.departureUnix ?? Infinity) - (b.departureUnix ?? Infinity));
                pillsHTML = boarding.slice(0, 2).map(b => {
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

        // Service alert banner for this route
        const alertList = window.masterAlertsData?.get(routeId) ?? [];
        const EFFECT_PRIORITY = ['DETOUR','NO_SERVICE','REDUCED_SERVICE','SIGNIFICANT_DELAYS','MODIFIED_SERVICE','STOP_MOVED','OTHER_EFFECT','UNKNOWN_EFFECT'];
        const POPUP_LABELS = { ...STRIP_EFFECT_LABELS, ACCESSIBILITY_ISSUE: 'Elevator/escalator' };
        const activeAlerts = alertList.filter(a => a.activePeriod?.start <= now && a.activePeriod?.end > now);
        activeAlerts.sort((a, b) => (EFFECT_PRIORITY.indexOf(a.effect) + 1 || 99) - (EFFECT_PRIORITY.indexOf(b.effect) + 1 || 99));
        const alertHTML = activeAlerts.map(a => {
            const label = POPUP_LABELS[a.effect] ?? 'Service alert';
            const body  = a.description || a.header || '';
            return `<details class="sp-alert">` +
                   `<summary class="sp-alert-title">⚠ ${label}</summary>` +
                   (body ? `<p>${esc(body)}</p>` : '') +
                   `</details>`;
        }).join('');

        return `<div class="sp-route">${alertHTML}${row1}${row2}</div>`;
    }).join('');

    // Bike share section — find the nearest station within 120 m of this group.
    const group = stationGroups.find(g => stopIds.some(id => g.stopIds.includes(id)));
    let bikeHTML = '';
    if (group) {
        const bs = getNearbyBikeStation(group.lat, group.lon, 120);
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

    return `
        <div class="station-popup-wrap modern">
            <div class="station-popup-name">${esc(name)}</div>
            <div class="sp-table">${rowsHTML}</div>
            ${bikeHTML}
        </div>
    `;
}

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

export function openStationByGroup(map, group) {
    if (!group) return;
    showArrivalsPopup(map, [group.lon, group.lat], group.stopIds, group.displayName, true);
}

// Exposed on window so bikeshare.js can open the station popup when a bike
// marker is folded into a metro station, without a circular import.
window.__openStationByGroup = openStationByGroup;

// ── Boarding badges at terminus stations ─────────────────────────────────────
// Replaces individual vehicle markers at route origins with a small per-route
// badge on the station, showing how many trains are boarding and when the next
// one departs. Bridges the layover gap when GTFS-RT trip_updates know about a
// train but the VP feed has gone silent.
//
// Key: `${stopId}|${routeCode}|${dir}` — one badge per (origin stop, route,
// One badge per station showing all boarding lines and their departure times.

const _boardingBadges = new Map(); // keyed by station group key (first stopId in group)
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

// Per-terminus badge placement overrides keyed by partial normalized station name.
// Default: bottom-left (upper-right of the dot). Overrides for edge termini where
// the default would push the badge off-screen or overlap the route line.
const BADGE_PLACEMENT_OVERRIDES = [
    { match: 'santa monica',   anchor: 'right',  offset: [-8,  0]  }, // A Line west — badge to the left
    { match: 'redondo beach',  anchor: 'top',    offset: [0,   8]  }, // C Line south — badge below
    { match: 'long beach',     anchor: 'top',    offset: [0,   8]  }, // A Line east  — badge below
    { match: 'harbor gateway', anchor: 'top',    offset: [0,   8]  }, // J Line south — badge below
    { match: 'san pedro',      anchor: 'top',    offset: [0,   8]  }, // J Line south alt name
    { match: 'lax',            anchor: 'right',  offset: [-8,  0]  }, // K Line south — badge to the left
    { match: 'aviation',       anchor: 'right',  offset: [-8,  0]  }, // K Line south alt name
];

function _badgePlacement(normName) {
    if (normName) {
        const n = normName.toLowerCase();
        for (const p of BADGE_PLACEMENT_OVERRIDES) {
            if (n.includes(p.match)) return { anchor: p.anchor, offset: p.offset };
        }
    }
    return { anchor: 'bottom-left', offset: [10, -10] };
}

// entries: [{routeCode, depLabel}] — one per boarding line at this station
function _badgeHTML(entries) {
    const rows = entries.map(({ routeCode, depLabel }) => {
        const color = routeHexColors[routeCode] || '#231f20';
        return `<div class="boarding-badge" style="--bb-color:${color};">` +
               `<span class="bb-dot"></span>` +
               `<span class="bb-time">${depLabel || '—'}</span>` +
               `</div>`;
    }).join('');
    return `<div class="boarding-badge-wrap">${rows}</div>`;
}

function _entryHTML({ routeCode, depLabel }) {
    const color = routeHexColors[routeCode] || '#231f20';
    return `<div class="boarding-badge" style="--bb-color:${color};">` +
           `<span class="bb-dot"></span>` +
           `<span class="bb-time">${depLabel || '—'}</span>` +
           `</div>`;
}

function _renderBoardingBadges(map) {
    if (!map) return;

    const origins = getAllOriginStops();
    if (!origins.length) return;

    const allOriginStopIds = origins.map(o => o.stopId);
    const boarding = getBoardingVehicles(allOriginStopIds);
    const now  = Math.floor(Date.now() / 1000);
    const zoom = map.getZoom() ?? 0;

    // Group origins by station group so multi-line termini share one badge.
    // Badge key = first stopId of the station group (stable across calls).
    const byGroupKey = new Map();
    const sortedOrigins = [...origins].sort((a, b) =>
        a.routeCode.localeCompare(b.routeCode) || a.dir - b.dir
    );
    for (const o of sortedOrigins) {
        const group = stationGroups.find(g => g.stopIds.includes(String(o.stopId)));
        let badgeKey = group ? group.stopIds[0] : String(o.stopId);
        if (!byGroupKey.has(badgeKey)) {
            const coords = group
                ? { lng: group.lon, lat: group.lat }
                : _findStationCoords(o.stopId);
            if (!coords) continue;
            // Proximity merge: if another badge already exists within STATION_MERGE_RADIUS_M
            // (e.g. J Line 910 and J Line 950 at El Monte have different stopIds/groups),
            // fold this origin into that badge instead of creating a second one.
            let nearbyKey = null;
            for (const [k, existing] of byGroupKey) {
                if (planarMeters(coords.lat, coords.lng, existing.coords.lat, existing.coords.lng) < STATION_MERGE_RADIUS_M) {
                    nearbyKey = k;
                    break;
                }
            }
            if (nearbyKey) {
                badgeKey = nearbyKey;
            } else {
                byGroupKey.set(badgeKey, { coords, normName: group?.normName ?? '', entries: [] });
            }
        }

        const matches = boarding.filter(b =>
            b.stopId === o.stopId && b.routeId === o.routeCode && b.directionId === o.dir
        );
        // Only add an entry when there are active boarding vehicles for this route+dir.
        // '—' is used when boarding is confirmed but departure time is unknown.
        if (!matches.length) continue;
        const soonestDep = matches
            .map(m => m.departureUnix)
            .filter(t => t != null)
            .sort((a, b) => a - b)[0] ?? null;
        byGroupKey.get(badgeKey).entries.push({
            routeCode: o.routeCode,
            depLabel:  _formatDeparture(soonestDep, now),
        });
    }

    const seenKeys = new Set();
    const showBadges = zoom >= BADGE_MINZOOM;

    for (const [badgeKey, { coords, normName, entries }] of byGroupKey) {
        if (!entries.length) continue;
        seenKeys.add(badgeKey);

        let badge = _boardingBadges.get(badgeKey);
        if (!badge) {
            const placement = _badgePlacement(normName);
            const el = document.createElement('div');
            el.innerHTML = _badgeHTML(entries);
            const wrapEl = el.firstElementChild;
            wrapEl.style.display = showBadges ? '' : 'none';
            badge = new maplibregl.Marker({
                element: wrapEl,
                anchor:  placement.anchor,
                offset:  placement.offset,
            })
                .setLngLat([coords.lng, coords.lat])
                .addTo(map);
            badge._wrapEl = wrapEl;
            _boardingBadges.set(badgeKey, badge);
        } else {
            badge.setLngLat([coords.lng, coords.lat]);
            badge._wrapEl.innerHTML = entries.map(_entryHTML).join('');
        }
    }

    // Remove badges for groups with no active boarding trains.
    for (const [key, badge] of _boardingBadges) {
        if (seenKeys.has(key)) continue;
        badge.remove();
        _boardingBadges.delete(key);
    }
}

function _applyBadgeZoom(map) {
    const show = map.getZoom() >= BADGE_MINZOOM;
    for (const badge of _boardingBadges.values()) {
        badge._wrapEl.style.display = show ? '' : 'none';
    }
}

export function initBoardingBadges(map) {
    if (_boardingInitialized) return;
    _boardingInitialized = true;
    _renderBoardingBadges(map);
    setVisibleInterval(() => _renderBoardingBadges(map), STATION_POPUP_REFRESH_MS);
    map.on('zoom', () => _applyBadgeZoom(map));
}
