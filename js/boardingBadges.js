/**
 * boardingBadges.js
 * Owns the terminus-station boarding-badge subsystem: the 8-cardinal slot
 * geometry that places small per-route badges around a station dot, and the
 * unified renderer (_renderStationBadges) that is the single source of truth
 * for badge placement.
 *
 * Three badge types share one placement system (chooseBadgeSlots) so they never
 * overlap: a boarding pill (trains boarding + next departure time at route
 * origins), a "!" service-alert badge, and a ♿ elevator/escalator-outage badge.
 * Boarding badges bridge the layover gap when GTFS-RT trip_updates know about a
 * train but the VP feed has gone silent. One badge per station group shows all
 * terminating lines and their departure times.
 *
 * Split out of stations.js (which owns the arrivals-popup half); this module
 * imports the few shared helpers it needs from stations.js but stations.js
 * references zero badge symbols, so there is no circular import.
 */

import { routeHexColors, STATION_MERGE_RADIUS_M, STATION_POPUP_REFRESH_MS } from './config.js';
import { planarMeters, computeBearing, setVisibleInterval } from './utils.js';
import { getBoardingVehicles, getAllOriginStops } from './predictions.js';
import { STRIP_EFFECT_LABELS, getActiveStopAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, wireAlertBadge, buildAlertTooltipText, buildAlertTooltipBlock, maxSeverity, maxAccessibilitySeverity } from './alerts.js';
import { snapToRoute, hasShapeData, lngLatAtArc, arcLengths } from './snap.js';
import { stationGroups, dedupeAlertsByEffect, _accessFacilityLabel } from './stations.js';

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

export function _formatDeparture(departureUnix, now) {
    if (departureUnix == null) return '';
    const secs = Math.max(0, Math.round(departureUnix - now));
    // "Now" means departing now (secs == 0 after the clamp); the whole final
    // minute reads "<1m" so the badge always shows the sub-minute state rather
    // than jumping "1m" -> "Now". Matches _formatArrivalPill / the vehicle popup.
    if (secs <= 0) return 'Now';   // Capitalized to match the vehicle-popup "Now" pill.
    // See _formatArrivalPill — "<1m" avoids the "30s" / "30m" misread.
    if (secs < 60) return '<1m';
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
    { match: 'atlantic',        slot: 'R' },  // E east terminus — line curves in, polyline slot mis-aims; force east
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

function _makeAlertEl(tipText, tipBlocks, severity) {
    const wrap = document.createElement('div');
    wrap.className = 'station-alert-badge-wrap';
    wrap.dataset.alertText = tipText;
    if (tipBlocks) wrap._alertBlocks = tipBlocks;
    const el = document.createElement('span');
    el.className = 'station-alert-badge';
    el.textContent = '!';
    if (severity) el.dataset.severity = severity;
    el.setAttribute('aria-label', `Service alert: ${tipText}`);
    wrap.appendChild(el);
    wireAlertBadge(wrap, el);
    return wrap;
}

function _makeAccessEl(tipText, accessType, tipBlocks, severity) {
    const wrap = document.createElement('div');
    wrap.className = 'station-access-badge-wrap';
    wrap.dataset.alertText = tipText;
    if (tipBlocks) wrap._alertBlocks = tipBlocks;
    const el = document.createElement('span');
    el.className = 'station-access-badge';
    el.textContent = '♿';
    // Severity is keyed off the classification, not the GTFS-RT effect code:
    // elevator outage (or both) = severe red, escalator-only = moderate amber.
    if (severity) el.dataset.severity = severity;
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
        // Only fire the map-dot badge for station-specific alerts — those where
        // masterStopAlertsData has an entry (explicit stopId in informedEntities
        // OR text-mined station name match). Route-wide alerts belong on the
        // legend badge, not on every station dot along the route.
        const stopAlerts  = group.stopIds.flatMap(id => getActiveStopAlerts(id));
        const alertsById  = new Map(stopAlerts.map(a => [a.id, a]));
        const alerts      = [...alertsById.values()];

        const access = group.stopIds.flatMap(id => getActiveStopAccessibilityAlerts(id));
        if (!alerts.length && !access.length) continue;

        const badgeKey = group.stopIds[0];
        const existing = perStation.get(badgeKey)
            || { coords: { lng: group.lon, lat: group.lat }, normName: group.normName ?? '' };

        if (alerts.length) {
            // Use the shared effect-level dedup helper, then flatten across
            // distinct descriptions so the badge tooltip surfaces one block
            // per unique alert content (not just the last alert per effect —
            // the pre-helper version dropped duplicates silently). When an
            // effect has multiple distinct descriptions, the alert is rendered
            // once per description with the same prefix label.
            const dedupedAlerts = dedupeAlertsByEffect(alerts);
            const pairs = dedupedAlerts.flatMap(a => {
                const prefix = STRIP_EFFECT_LABELS[a.effect] ?? 'Service alert';
                if (a._descriptions.length === 0) return [{ prefix, alert: a }];
                return a._descriptions.map(desc => ({
                    prefix,
                    alert: { ...a, description: desc },
                }));
            });
            existing.alertTipBlocks = pairs.map(p => buildAlertTooltipBlock(p.prefix, p.alert));
            existing.alertTipText = pairs
                .map(p => buildAlertTooltipText(p.prefix, p.alert))
                .join('\n\n');
            // Highest severity across all alerts at this stop drives the
            // badge color. Computed from the RAW alerts (not the dedup
            // output) so the effect of every original alert is considered.
            existing.alertSeverity = maxSeverity(alerts);
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
            // Accessibility severity is keyed off the classification, NOT
            // the GTFS-RT effect code: elevator outage (or both) is severe
            // (rider can't reach the platform); escalator-only is moderate.
            existing.accessSeverity = maxAccessibilitySeverity(access);
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
            buildEl: () => _makeAlertEl(station.alertTipText, station.alertTipBlocks, station.alertSeverity),
            updateEl: el => {
                el.dataset.alertText = station.alertTipText;
                el._alertBlocks = station.alertTipBlocks;
                const badgeEl = el.querySelector('.station-alert-badge');
                if (badgeEl) {
                    if (station.alertSeverity) badgeEl.dataset.severity = station.alertSeverity;
                    else delete badgeEl.dataset.severity;
                    badgeEl.setAttribute('aria-label', `Service alert: ${station.alertTipText}`);
                }
            },
        });
        _syncBadgeMarker({
            map, entry, slotKey: slots.access, showBadges,
            kind: 'access',
            present: hasAccess,
            buildEl: () => _makeAccessEl(station.accessTipText, station.accessType, station.accessTipBlocks, station.accessSeverity),
            updateEl: el => {
                el.dataset.alertText = station.accessTipText;
                el._alertBlocks = station.accessTipBlocks;
                const badgeEl = el.querySelector('.station-access-badge');
                if (badgeEl) {
                    if (station.accessSeverity) badgeEl.dataset.severity = station.accessSeverity;
                    else delete badgeEl.dataset.severity;
                    badgeEl.setAttribute('aria-label',
                        `${_accessFacilityLabel(station.accessType)}: ${station.accessTipText}`);
                }
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

// The boarding pill's intrinsic CSS size IS its zoomed-in size — at far-out
// zoom that fixed size dwarfs the small station dots and the (zoom-scaled)
// alert/access circles, reading as oversized. So we only ever shrink it as
// the map zooms out: full (1.0) at ALERT_BADGE_ZOOM_MAX, down to
// BB_SCALE_MIN at BADGE_MINZOOM. Driven into CSS as `--bb-scale`, which the
// .boarding-badge rules multiply through their dimensions.
const BB_SCALE_MIN = 0.7;

/**
 * Map a map zoom level to the boarding-pill scale factor (BB_SCALE_MIN…1).
 * Pure + exported for test coverage; production reads it in _applyBadgeZoom.
 * @param {number} zoom MapLibre zoom level
 * @returns {number} scale in [BB_SCALE_MIN, 1]
 */
export function boardingBadgeScale(zoom) {
    const t = Math.max(0, Math.min(1, (zoom - BADGE_MINZOOM) / (ALERT_BADGE_ZOOM_MAX - BADGE_MINZOOM)));
    return BB_SCALE_MIN + t * (1 - BB_SCALE_MIN);
}

function _applyBadgeZoom(map) {
    const zoom = map.getZoom();
    const show = zoom >= BADGE_MINZOOM;
    const t = Math.max(0, Math.min(1, (zoom - BADGE_MINZOOM) / (ALERT_BADGE_ZOOM_MAX - BADGE_MINZOOM)));
    const size = Math.round(ALERT_BADGE_SIZE_MIN_PX + t * (ALERT_BADGE_SIZE_MAX_PX - ALERT_BADGE_SIZE_MIN_PX));
    document.documentElement.style.setProperty('--alert-badge-size', `${size}px`);
    document.documentElement.style.setProperty('--bb-scale', boardingBadgeScale(zoom).toFixed(3));

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
