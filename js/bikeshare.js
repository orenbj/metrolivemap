import { BIKESHARE_POLL_MS, GBFS_INFO_URL, GBFS_STATUS_URL,
         BIKESHARE_NEAR_RAIL_RADIUS_M, BIKESHARE_HOVER_DELAY_NEAR_MS,
         BIKESHARE_HOVER_DELAY_SOLO_MS, BIKE_COLORS } from './config.js';
import { escHtml, setVisibleInterval, planarMeters, fetchWithTimeout, readPersistedBoolean } from './utils.js';
import { setActivePopup, notifyPopupClosed } from './popups.js';

window.masterBikeStations = new Map();

// Pie segment colors — from the shared BIKE_COLORS palette (config.js) so the
// pie markers and the station-popup amenity row never drift apart.
const C_EBIKE = BIKE_COLORS.ebike; // blue  — e-bikes
const C_BIKE  = BIKE_COLORS.bike;  // green — standard bikes
const C_DOCK  = BIKE_COLORS.dock;  // gray  — open docks

const BIKE_MINZOOM = 10;
const PIE_SIZE     = 15;    // px diameter — shown at zoom ≥ BIKE_PIE_ZOOM
const DOT_SIZE     = 7;     // px diameter — shown at zoom < BIKE_PIE_ZOOM
const BIKE_PIE_ZOOM = 13;   // zoom threshold: below → dot, above → pie (minZoom=8, 5 clicks = zoom 13)

let _map         = null;
// Persisted across sessions in localStorage under BIKESHARE_VISIBLE_KEY.
// Default OFF on first visit so the initial map render isn't busy with
// ~500 station markers a rider may not care about; the toggle is one
// click away in the top-right control group. Returning riders' choices
// are restored on every load. Mirrors the darkMode pattern in map.js.
const BIKESHARE_VISIBLE_KEY = 'bikeshareVisible';
let _visible     = readPersistedBoolean(BIKESHARE_VISIBLE_KEY, false);
const _BIKESHARE_MIN_REFETCH_MS = 5_000;
let _lastBikeshareFetchAt = 0;
let _markers     = new Map(); // stationId → { marker, el, lastBikes, lastEbikes, lastDocks, lastIsDot }
let _mounted     = new Set(); // stationIds currently addTo'd to the map (subset of _markers)
let _activePopup = null;
let _activeStId  = null;
// Stations within MERGE_RADIUS_M of each other share one marker with summed counts.
// 50 m covers same-intersection pairs (e.g. La Cienega) without merging genuinely
// separate stations (~half a city block apart). Note: rail-station merging in
// stations.js uses STATION_MERGE_RADIUS_M=300 — intentionally different scales,
// see the comment block in config.js next to STATION_MERGE_RADIUS_M.
const MERGE_RADIUS_M = 50;
let _mergedStations = new Map(); // mergeId → { memberIds, lat, lon, name, bikes, ebikes, docks }
let _mergedById     = new Map(); // originalId → mergeId
// Cached state for _applyZoomVisibility — guards against the per-frame
// zoom listener doing redundant work (re-rendering 500 SVGs every frame
// while the user is mid-pinch but isDot/visibility haven't actually changed).
let _lastIsDot   = null;
let _lastVisible = null;
let _zoomRaf     = 0;
// Bounds buffer (~1 km at LA latitude) keeps a margin of off-screen markers
// pre-mounted so quick pans don't pop in. Larger values trade fewer pop-ins
// for more mounted markers (cost scales linearly with mounted count).
const VIEWPORT_BUFFER_DEG = 0.01;

let _bikeShareInitialized = false;

// One-shot GBFS station-info load (name/lat/lon per station). Best-effort: on
// failure it logs and leaves masterBikeStations as-is so the caller can retry.
async function _loadStationInfo() {
    try {
        const r    = await fetchWithTimeout(GBFS_INFO_URL, 10000);
        const data = await r.json();
        for (const st of data.data.stations) {
            window.masterBikeStations.set(st.station_id, {
                name:   st.name,
                lat:    st.lat,
                lon:    st.lon,
                bikes:  0,
                ebikes: 0,
                docks:  0,
            });
        }
    } catch (e) {
        console.warn('[bikeshare] Failed to load station info:', e);
    }
}

/**
 * Fetch GBFS station info, render bike share markers on the map, and start
 * polling for live availability every BIKESHARE_POLL_MS. Shows SVG pie charts
 * at zoom ≥ BIKE_PIE_ZOOM and simple dots at lower zooms. Viewport-culls the
 * ~500-station pool so only visible markers are mounted at any time.
 * The initial station-info load is best-effort — a failure here does NOT
 * disable the layer for the session; the poll below retries it (see its
 * self-heal comment) so a transient GBFS outage recovers on its own.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export async function initBikeShare(map) {
    // Skip if already initialized AND the bike-station registry survived
    // (test resets wipe the map; production never re-imports the module).
    if (_bikeShareInitialized && window.masterBikeStations?.size > 0) return;
    _bikeShareInitialized = true;
    _map = map;

    // Best-effort one-shot station-info load. On failure we do NOT bail — the poll
    // below retries it, so a transient GBFS hiccup at startup can no longer disable
    // the layer for the whole session (it used to `return` here and never recover).
    await _loadStationInfo();

    if (window.masterBikeStations.size > 0) {
        _computeMerges();
        await _refreshStatus();
        _buildAllMarkers(map);
        _updateLegend();
        _syncBikeshareToCamera(map);
    }

    // Zoom fires every frame during pinch/scroll; coalesce to one call per
    // animation frame so the sync loop runs at most once per frame instead
    // of multiple times. We sync both viewport mount state AND dot/pie SVG
    // mode (gated internally on real changes).
    map.on('zoom', () => {
        if (_zoomRaf) return;
        _zoomRaf = requestAnimationFrame(() => {
            _zoomRaf = 0;
            _syncBikeshareToCamera(map);
        });
    });
    // moveend covers pan settle (zoom event handled above already covers
    // zoom). Direct call — moveend fires only when motion stops, so no
    // debouncing needed.
    map.on('moveend', () => _syncBikeshareToCamera(map));

    setVisibleInterval(async () => {
        if (!_visible) return;  // skip GBFS network call + DOM work while toggled off
        // Self-heal: if the startup station-info load failed, retry it here so a
        // transient GBFS outage doesn't leave the layer empty for the session. On
        // recovery, do the one-time merge + marker build the startup path skipped.
        if (window.masterBikeStations.size === 0) {
            await _loadStationInfo();
            if (window.masterBikeStations.size === 0) return;  // still down — retry next tick
            _computeMerges();
            _buildAllMarkers(_map);
        }
        await _refreshStatus();
        _updateAllMarkers();
        _updateLegend();
        _refreshActivePopup();
    }, BIKESHARE_POLL_MS, 'bikeshare:poll');

    const row = document.getElementById('bikeshare-legend-row');
    if (row) {
        // Sync the persisted off-state onto the row + map toggle button
        // BEFORE wiring the click handler so we don't accidentally fire a
        // toggle that flips the state again. Both DOM nodes carry the
        // visible/disabled class explicitly so CSS-only consumers stay
        // accurate without subscribing to events.
        row.classList.toggle('disabled', !_visible);
        document.getElementById('bikeshare-toggle-btn')
            ?.classList.toggle('layer-btn-off', !_visible);

        row.addEventListener('click', () => {
            _visible = !_visible;
            row.classList.toggle('disabled', !_visible);
            try { localStorage.setItem(BIKESHARE_VISIBLE_KEY, String(_visible)); } catch { /* storage disabled */ }
            if (!_visible && _activePopup) {
                _activePopup.remove();
                _activePopup = null;
                _activeStId  = null;
            }
            _syncBikeshareToCamera(map);
        });
    }
}

/**
 * Called after a dark mode style swap to re-anchor the module's map reference.
 * HTML markers survive style.load automatically; no layers need to be re-added.
 * @param {maplibregl.Map} map MapLibre map instance (post-swap)
 */
export function reAddBikeLayer(map) {
    _map = map;
}

/**
 * Return the nearest Metro Bike Share station within radiusM of the given point.
 * @param {number} lat
 * @param {number} lon
 * @param {number} [radiusM=120] Search radius in meters
 * @returns {{ name, lat, lon, bikes, ebikes, docks } | null}
 */
export function getNearbyBikeStation(lat, lon, radiusM = 120) {
    let bestId = null, best = null, bestDist = Infinity;
    for (const [id, st] of window.masterBikeStations) {
        const d = planarMeters(lat, lon, st.lat, st.lon);
        if (d < radiusM && d < bestDist) { bestDist = d; best = st; bestId = id; }
    }
    if (bestId && _mergedById.has(bestId)) {
        return _mergedStations.get(_mergedById.get(bestId)) ?? best;
    }
    return best;
}

export function _computeMerges() {
    const ids = [...window.masterBikeStations.keys()];
    const parent = new Map(ids.map(id => [id, id]));
    const find = id => {
        while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
        return id;
    };
    for (let i = 0; i < ids.length; i++) {
        const si = window.masterBikeStations.get(ids[i]);
        for (let j = i + 1; j < ids.length; j++) {
            const sj = window.masterBikeStations.get(ids[j]);
            if (planarMeters(si.lat, si.lon, sj.lat, sj.lon) < MERGE_RADIUS_M) {
                const ri = find(ids[i]), rj = find(ids[j]);
                if (ri !== rj) parent.set(ri, rj);
            }
        }
    }
    const groups = new Map();
    for (const id of ids) {
        const root = find(id);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(id);
    }
    _mergedStations.clear();
    _mergedById.clear();
    for (const memberIds of groups.values()) {
        if (memberIds.length < 2) continue;
        // Filter out stale IDs (stations removed from a mid-session GBFS
        // station-info refresh). Without this, members.reduce throws on
        // undefined.lat and the whole merge pass aborts, breaking the bike
        // layer. If filtering drops the group below 2, it's no longer a
        // cluster — leave the singleton(s) un-merged.
        const liveMembers = memberIds
            .map(id => window.masterBikeStations.get(id))
            .filter(Boolean);
        if (liveMembers.length < 2) continue;
        const liveIds = memberIds.filter(id => window.masterBikeStations.has(id));
        const lat = liveMembers.reduce((s, m) => s + m.lat, 0) / liveMembers.length;
        const lon = liveMembers.reduce((s, m) => s + m.lon, 0) / liveMembers.length;
        const mergeId = 'merge:' + liveIds.slice().sort().join(',');
        _mergedStations.set(mergeId, { memberIds: liveIds, lat, lon, name: liveMembers[0].name, bikes: 0, ebikes: 0, docks: 0 });
        for (const id of liveIds) _mergedById.set(id, mergeId);
    }
}

async function _refreshStatus() {
    const now = Date.now();
    if (now - _lastBikeshareFetchAt < _BIKESHARE_MIN_REFETCH_MS) return;
    _lastBikeshareFetchAt = now;
    try {
        const r    = await fetchWithTimeout(GBFS_STATUS_URL, 10000);
        const data = await r.json();
        for (const st of data.data.stations) {
            const info = window.masterBikeStations.get(st.station_id);
            if (info) {
                const types  = st.num_bikes_available_types ?? {};
                info.ebikes  = (types.electric ?? 0) + (types.smart ?? 0);
                info.bikes   = types.classic ?? Math.max(0, (st.num_bikes_available ?? 0) - info.ebikes);
                info.docks   = st.num_docks_available ?? 0;
            }
        }
        // Aggregate merged station totals
        for (const merged of _mergedStations.values()) {
            merged.bikes = merged.ebikes = merged.docks = 0;
            for (const id of merged.memberIds) {
                const m = window.masterBikeStations.get(id);
                if (m) { merged.bikes += m.bikes; merged.ebikes += m.ebikes; merged.docks += m.docks; }
            }
        }
    } catch (e) {
        console.warn('[bikeshare] Status refresh failed:', e);
    }
}

// ── Dot SVG (low-zoom) ─────────────────────────────────────────────────────────

function _dotSVG(st) {
    const r    = DOT_SIZE / 2;
    const fill = (st.bikes + st.ebikes) > 0 ? C_BIKE : C_DOCK;
    return `<svg display="block" width="${DOT_SIZE}" height="${DOT_SIZE}" viewBox="0 0 ${DOT_SIZE} ${DOT_SIZE}">
        <circle cx="${r}" cy="${r}" r="${r - 1}" fill="${fill}"/>
    </svg>`;
}

// ── Pie chart SVG ──────────────────────────────────────────────────────────────

function _pieSVG(bikes, ebikes, docks) {
    const total = bikes + ebikes + docks;
    const R     = PIE_SIZE / 2;
    const cx    = R, cy = R;
    const r     = R - 1; // inner radius (1px border)

    if (total === 0) {
        // Offline / empty — solid gray
        return `<svg display="block" width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="${C_DOCK}"/>
        </svg>`;
    }

    const segments = [
        { value: ebikes, color: C_EBIKE },
        { value: bikes,  color: C_BIKE  },
        { value: docks,  color: C_DOCK  },
    ].filter(s => s.value > 0);

    // Defensive: total > 0 should imply at least one filtered segment, but a
    // future field rename or rounding edge could leave segments empty —
    // fall through to the offline-gray circle instead of emitting an SVG with
    // no paths.
    if (segments.length === 0) {
        return `<svg display="block" width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="${C_DOCK}"/>
        </svg>`;
    }

    // Single-segment shortcut (full circle)
    if (segments.length === 1) {
        return `<svg display="block" width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="${segments[0].color}"/>
        </svg>`;
    }

    let paths = '';
    let angle = -Math.PI / 2; // start at 12 o'clock

    for (const seg of segments) {
        const sweep = (seg.value / total) * 2 * Math.PI;
        const end   = angle + sweep;
        const x1 = (cx + r * Math.cos(angle)).toFixed(3);
        const y1 = (cy + r * Math.sin(angle)).toFixed(3);
        const x2 = (cx + r * Math.cos(end)).toFixed(3);
        const y2 = (cy + r * Math.sin(end)).toFixed(3);
        const large = sweep > Math.PI ? 1 : 0;
        paths += `<path d="M${cx},${cy}L${x1},${y1}A${r},${r} 0 ${large},1 ${x2},${y2}Z" fill="${seg.color}"/>`;
        angle = end;
    }

    return `<svg display="block" width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/>
        ${paths}
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"/>
    </svg>`;
}

// ── Marker management ──────────────────────────────────────────────────────────

function _makeMarkerEl(id, st) {
    const isDot = (_map?.getZoom() ?? 0) < BIKE_PIE_ZOOM;
    const el = document.createElement('div');
    el.className     = 'bike-marker';
    el.style.cursor  = 'pointer';
    el.innerHTML = isDot ? _dotSVG(st) : _pieSVG(st.bikes, st.ebikes, st.docks);
    let _hoverTimer = null;

    // Resolve the nearby rail station group ONCE, lazily on first interaction,
    // then cache it. Bike station coords never change, so a single scan suffices
    // (previously each hover/click handler re-scanned all groups — ~100 distance
    // computations per event × 500 markers × 3 handlers). It is computed LAZILY
    // rather than at build time because initBikeShare awaits a network GBFS fetch
    // and races initStations: a bike marker can be built before window.stationGroups
    // is populated, which would permanently cache `null` and lose the near-rail
    // hover/click hand-off. Deferring to first interaction guarantees the groups
    // are ready; we only cache once a non-empty list is seen.
    let _nearGroup;  // undefined = unresolved; null or a group once resolved
    const getNearGroup = () => {
        if (_nearGroup === undefined) {
            const groups = window.stationGroups;
            if (!groups || groups.length === 0) return null;  // not ready yet — retry next time
            _nearGroup = groups.find(g => planarMeters(st.lat, st.lon, g.lat, g.lon) < BIKESHARE_NEAR_RAIL_RADIUS_M) ?? null;
        }
        return _nearGroup;
    };

    // Track whether the solo popup was opened by HOVER vs a deliberate CLICK,
    // so mouseleave closes a hover-preview but a click pins it — the same
    // contract every other hover surface uses (vehicle markers, station
    // hover-preview). Previously the solo popup was sticky on hover (it stayed
    // until ×/map-click), the lone outlier that left popups a rider only
    // grazed with the cursor.
    let openedByHover = false;

    el.addEventListener('mouseenter', () => {
        clearTimeout(_hoverTimer);
        const nearGroup = getNearGroup();
        if (nearGroup) {
            _hoverTimer = setTimeout(() => {
                window.__hoverStationByGroup?.(_map, nearGroup);
            }, BIKESHARE_HOVER_DELAY_NEAR_MS);
        } else {
            _hoverTimer = setTimeout(() => {
                _openPopup(id, st, _markers.get(id)?.marker?.getLngLat());
                openedByHover = true;
            }, BIKESHARE_HOVER_DELAY_SOLO_MS);
        }
    });

    el.addEventListener('mouseleave', () => {
        clearTimeout(_hoverTimer);
        const nearGroup = getNearGroup();
        if (nearGroup) {
            window.__closeStationIfUnpinned?.();
        } else if (openedByHover && _activeStId === id) {
            // Close the hover-preview when the cursor leaves — unless a click
            // pinned it (click clears openedByHover below). Guard on _activeStId
            // so we only close OUR popup, never one the rider pinned elsewhere.
            _closeActivePopup();
        }
        openedByHover = false;
    });

    el.addEventListener('click', e => {
        e.stopPropagation();
        clearTimeout(_hoverTimer);
        const nearGroup = getNearGroup();
        if (nearGroup) {
            window.__openStationByGroup?.(_map, nearGroup);
            return;
        }
        openedByHover = false;   // pin: mouseleave will no longer close it
        _openPopup(id, st, _markers.get(id)?.marker?.getLngLat());
    });
    return el;
}

function _buildAllMarkers(map) {
    const isDot = (_map?.getZoom() ?? 0) < BIKE_PIE_ZOOM;
    // Merged group markers
    for (const [mergeId, merged] of _mergedStations) {
        const el = _makeMarkerEl(mergeId, merged);
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([merged.lon, merged.lat]);
        _markers.set(mergeId, { marker, el, lastBikes: merged.bikes, lastEbikes: merged.ebikes, lastDocks: merged.docks, lastIsDot: isDot });
    }
    // Individual station markers (skip those absorbed into a merge group)
    for (const [id, st] of window.masterBikeStations) {
        if (!st.lat || !st.lon) continue;
        if (_mergedById.has(id)) continue;
        const el     = _makeMarkerEl(id, st);
        // Construct only — DO NOT addTo(map) here. _syncMountedToViewport
        // mounts only the markers within the current viewport bounds, which
        // caps MapLibre's per-frame transform cost at ~visible-marker-count
        // instead of the full ~500-station set.
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([st.lon, st.lat]);
        _markers.set(id, { marker, el, lastBikes: st.bikes, lastEbikes: st.ebikes, lastDocks: st.docks, lastIsDot: isDot });
    }
}

// Mount only the markers within the current viewport (plus a small buffer
// to avoid pop-in during quick pans). The actively-popped marker stays
// mounted regardless so its popup anchor doesn't disappear.
function _syncMountedToViewport(map) {
    const zoom = map.getZoom();
    const showBand = _visible && zoom >= BIKE_MINZOOM;

    // When out of show band (toggled off, or zoomed too far out), unmount
    // everything except the active-popup anchor.
    if (!showBand) {
        for (const id of _mounted) {
            if (id === _activeStId) continue;
            _markers.get(id)?.marker.remove();
        }
        _mounted = _activeStId && _mounted.has(_activeStId)
            ? new Set([_activeStId]) : new Set();
        return;
    }

    const bounds = map.getBounds();
    const west  = bounds.getWest()  - VIEWPORT_BUFFER_DEG;
    const east  = bounds.getEast()  + VIEWPORT_BUFFER_DEG;
    const south = bounds.getSouth() - VIEWPORT_BUFFER_DEG;
    const north = bounds.getNorth() + VIEWPORT_BUFFER_DEG;
    const isDot = zoom < BIKE_PIE_ZOOM;

    for (const [id, m] of _markers) {
        const st = _mergedStations.get(id) ?? window.masterBikeStations.get(id);
        if (!st) continue;
        const inView = st.lon >= west && st.lon <= east && st.lat >= south && st.lat <= north;
        const isMounted = _mounted.has(id);
        if (inView && !isMounted) {
            // Refresh SVG if dot/pie mode shifted while marker was unmounted,
            // OR data changed (the 30-second poll updates lastBikes/etc.
            // even on unmounted markers, but on first mount we may need to
            // catch up to the current isDot mode).
            if (m.lastIsDot !== isDot) {
                m.lastIsDot = isDot;
                m.el.innerHTML = isDot ? _dotSVG(st) : _pieSVG(st.bikes, st.ebikes, st.docks);
            }
            m.marker.addTo(map);
            _mounted.add(id);
        } else if (!inView && isMounted) {
            if (id === _activeStId) continue;  // keep popup anchor alive
            m.marker.remove();
            _mounted.delete(id);
        }
    }
}

// Composite handler for camera changes: viewport sync + zoom-threshold SVG
// flip. Both inner functions are gated on real state change so duplicate
// calls (zoom + moveend in quick succession) are cheap.
function _syncBikeshareToCamera(map) {
    _syncMountedToViewport(map);
    _applyZoomVisibility(map);
}

function _updateAllMarkers() {
    if (!_visible) return;  // nothing to update while toggled off
    const isDot = (_map?.getZoom() ?? 0) < BIKE_PIE_ZOOM;
    for (const [id, m] of _markers) {
        const st = _mergedStations.get(id) ?? window.masterBikeStations.get(id);
        if (!st) continue;
        if (m.lastBikes === st.bikes && m.lastEbikes === st.ebikes &&
            m.lastDocks === st.docks && m.lastIsDot === isDot) continue;
        m.lastBikes  = st.bikes;
        m.lastEbikes = st.ebikes;
        m.lastDocks  = st.docks;
        m.lastIsDot  = isDot;
        m.el.innerHTML = isDot ? _dotSVG(st) : _pieSVG(st.bikes, st.ebikes, st.docks);
    }
}

// Flip mounted markers between dot and pie SVG when the zoom threshold
// (BIKE_PIE_ZOOM) is crossed. Mount/unmount visibility is handled by
// _syncMountedToViewport, so this function only cares about SVG content.
// Gated on real state change so duplicate calls during a zoom burst are
// no-ops; iterates only mounted markers, not the full ~500-station pool.
function _applyZoomVisibility(map) {
    const zoom  = map.getZoom();
    const isDot = zoom < BIKE_PIE_ZOOM;
    if (isDot === _lastIsDot && _visible === _lastVisible) return;
    const dotModeChanged = isDot !== _lastIsDot;
    _lastVisible = _visible;
    _lastIsDot   = isDot;
    if (!dotModeChanged) return;  // visibility-only change is handled by sync

    for (const id of _mounted) {
        const m  = _markers.get(id);
        const st = _mergedStations.get(id) ?? window.masterBikeStations.get(id);
        if (!m || !st) continue;
        m.lastIsDot = isDot;
        m.el.innerHTML = isDot ? _dotSVG(st) : _pieSVG(st.bikes, st.ebikes, st.docks);
    }
}

// ── Popup ──────────────────────────────────────────────────────────────────────

// Canonical teardown for the bike popup. Stable module-level reference so the
// single-popup coordinator (js/popups.js) can both invoke it and match it on
// notify. Clears module pointers BEFORE remove() so the synchronous 'close'
// listener sees a clean "no popup active" state rather than a pointer to the
// popup being destroyed.
function _closeActivePopup() {
    const prev = _activePopup;
    _activePopup = null;
    _activeStId  = null;
    if (prev) prev.remove();
}

function _openPopup(id, st, lngLat) {
    _closeActivePopup();  // tear down any prior bike popup first

    if (!lngLat) return;
    _activeStId  = id;
    _activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px', offset: PIE_SIZE / 2 + 4, className: 'bikeshare-popup' })
        .setLngLat(lngLat)
        .setHTML(_buildPopupHTML(st))
        .addTo(_map);
    // a11y: label the popup container as a dialog (mirrors stations.js) so
    // screen readers announce a named region instead of a generic container.
    const _popupEl = _activePopup.getElement?.();
    if (_popupEl) {
        _popupEl.setAttribute('role', 'dialog');
        _popupEl.setAttribute('aria-label', `Bike share station: ${st.name ?? ''}`.trim());
    }
    _activePopup.on('close', () => { notifyPopupClosed(_closeActivePopup); _activePopup = null; _activeStId = null; });
    // Single active popup: close any OTHER open popup (station / vehicle / micro).
    setActivePopup(_closeActivePopup);
}

// App store links — also act as universal/app links that open the installed app.
const BIKE_IOS_URL     = 'https://apps.apple.com/us/app/metro-bike-share/id1121738367';
const BIKE_ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.bicycletransit.MetroBikeShare';

function _buildPopupHTML(st) {
    const bikes  = Number(st.bikes)  || 0;
    const ebikes = Number(st.ebikes) || 0;
    const docks  = Number(st.docks)  || 0;

    // Content is class-styled (shared mp-* recipe in index-style.css) so dark
    // mode restyles an OPEN popup live via CSS variables — the old inline-style
    // build baked the theme in at render time and went stale on toggle.
    const link = (href, label) =>
        `<a href="${href}" target="_blank" rel="noopener" class="mp-link mp-link--bike">${label}</a>`;
    const ua = navigator.userAgent;
    let appLinksHTML;
    if (/iPad|iPhone|iPod/.test(ua)) {
        appLinksHTML = link(BIKE_IOS_URL, '📱 Open in App Store →');
    } else if (/Android/.test(ua)) {
        appLinksHTML = link(BIKE_ANDROID_URL, '📱 Open in Google Play →');
    } else {
        appLinksHTML = `<div class="mp-links">${link(BIKE_IOS_URL, '🍎 App Store')}${link(BIKE_ANDROID_URL, '▶ Google Play')}</div>`;
    }

    return `
<div class="mp-card">
  <div class="mp-accent mp-accent--bike"></div>
  <div class="mp-body">
    <div class="mp-title">${escHtml(st.name)}</div>
    <div class="mp-grid">
      <span class="mp-dot" style="--bc:${C_BIKE}"></span>
      <span><b>${bikes}</b></span><span class="mp-lbl">bikes</span>
      <span class="mp-dot" style="--bc:${C_EBIKE}"></span>
      <span><b>${ebikes}</b></span><span class="mp-lbl">e-bikes</span>
      <span class="mp-dot" style="--bc:${C_DOCK}"></span>
      <span><b>${docks}</b></span><span class="mp-lbl">open docks</span>
    </div>
    ${appLinksHTML}
  </div>
</div>`;
}

function _refreshActivePopup() {
    if (!_activePopup || !_activeStId) return;
    const st = _mergedStations.get(_activeStId) ?? window.masterBikeStations.get(_activeStId);
    if (!st) return;
    _activePopup.setHTML(_buildPopupHTML(st));
}

// ── Legend ─────────────────────────────────────────────────────────────────────

function _updateLegend() {
    const stations = Array.from(window.masterBikeStations.values());
    const active   = stations.filter(s => s.bikes + s.ebikes > 0).length;
    const total    = stations.length;

    const badge = document.getElementById('bikeshare-count');
    if (badge) badge.textContent = active > 0 ? active : '';

    const fill = document.querySelector('#bikeshare-legend-row .bar-fill');
    if (fill) fill.style.width = total > 0 ? `${Math.round((active / total) * 100)}%` : '0%';
}
