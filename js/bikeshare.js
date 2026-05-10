import { BIKESHARE_POLL_MS, GBFS_INFO_URL, GBFS_STATUS_URL,
         BIKESHARE_NEAR_RAIL_RADIUS_M, BIKESHARE_HOVER_DELAY_NEAR_MS,
         BIKESHARE_HOVER_DELAY_SOLO_MS } from './config.js';
import { escHtml, setVisibleInterval, planarMeters, fetchWithTimeout } from './utils.js';

window.masterBikeStations = new Map();

// Pie segment colors
const C_EBIKE = '#2563eb'; // blue  — e-bikes
const C_BIKE  = '#16a34a'; // green — standard bikes
const C_DOCK  = '#9ca3af'; // gray  — open docks

const BIKE_MINZOOM = 10;
const PIE_SIZE     = 15;    // px diameter — shown at zoom ≥ BIKE_PIE_ZOOM
const DOT_SIZE     = 7;     // px diameter — shown at zoom < BIKE_PIE_ZOOM
const BIKE_PIE_ZOOM = 13;   // zoom threshold: below → dot, above → pie (minZoom=8, 5 clicks = zoom 13)

let _map         = null;
let _visible     = true;
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

/**
 * Fetch GBFS station info, render bike share markers on the map, and start
 * polling for live availability every BIKESHARE_POLL_MS. Shows SVG pie charts
 * at zoom ≥ BIKE_PIE_ZOOM and simple dots at lower zooms. Viewport-culls the
 * ~500-station pool so only visible markers are mounted at any time.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export async function initBikeShare(map) {
    _map = map;

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
        return;
    }

    _computeMerges();
    await _refreshStatus();
    _buildAllMarkers(map);
    _updateLegend();
    _syncBikeshareToCamera(map);

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
        await _refreshStatus();
        _updateAllMarkers();
        _updateLegend();
        _refreshActivePopup();
    }, BIKESHARE_POLL_MS);

    const row = document.getElementById('bikeshare-legend-row');
    if (row) {
        row.addEventListener('click', () => {
            _visible = !_visible;
            row.classList.toggle('disabled', !_visible);
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

function _computeMerges() {
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
        const members = memberIds.map(id => window.masterBikeStations.get(id));
        const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
        const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
        const mergeId = 'merge:' + memberIds.slice().sort().join(',');
        _mergedStations.set(mergeId, { memberIds, lat, lon, name: members[0].name, bikes: 0, ebikes: 0, docks: 0 });
        for (const id of memberIds) _mergedById.set(id, mergeId);
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

    // Precompute the nearby rail station group ONCE — bike station coords
    // never change, and stationGroups is stable after init. Previously each
    // hover/click handler re-scanned all groups (~100 distance computations
    // per event). At 500 markers × 3 handlers = 1500 closures all running
    // O(stationGroups) on every interaction.
    const groups = window.stationGroups ?? [];
    const nearGroup = groups.find(g => planarMeters(st.lat, st.lon, g.lat, g.lon) < BIKESHARE_NEAR_RAIL_RADIUS_M) ?? null;

    el.addEventListener('mouseenter', () => {
        clearTimeout(_hoverTimer);
        if (nearGroup) {
            _hoverTimer = setTimeout(() => {
                window.__hoverStationByGroup?.(_map, nearGroup);
            }, BIKESHARE_HOVER_DELAY_NEAR_MS);
        } else {
            _hoverTimer = setTimeout(() => {
                _openPopup(id, st, _markers.get(id)?.marker?.getLngLat());
            }, BIKESHARE_HOVER_DELAY_SOLO_MS);
        }
    });

    el.addEventListener('mouseleave', () => {
        clearTimeout(_hoverTimer);
        if (nearGroup) window.__closeStationIfUnpinned?.();
        // Non-nearGroup: popup is sticky — user dismisses via × or map click
    });

    el.addEventListener('click', e => {
        e.stopPropagation();
        clearTimeout(_hoverTimer);
        if (nearGroup) {
            window.__openStationByGroup?.(_map, nearGroup);
            return;
        }
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

function _openPopup(id, st, lngLat) {
    if (_activePopup) _activePopup.remove();
    if (!lngLat) return;
    _activeStId  = id;
    _activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px', offset: PIE_SIZE / 2 + 4, className: 'bikeshare-popup' })
        .setLngLat(lngLat)
        .setHTML(_buildPopupHTML(st))
        .addTo(_map);
    _activePopup.on('close', () => { _activePopup = null; _activeStId = null; });
}

function _buildPopupHTML(st) {
    const isDark      = document.body.classList.contains('dark-mode');
    const bg          = isDark ? '#1e1e1e' : '#ffffff';
    const txt         = isDark ? '#f0f0f0' : '#111111';
    const muted       = isDark ? '#aaaaaa' : '#666666';
    const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
    const bikes  = st.bikes  ?? 0;
    const ebikes = st.ebikes ?? 0;
    const docks  = st.docks  ?? 0;
    return `
<div style="font-family:'Open Sans',sans-serif;background:${bg};border-radius:8px;overflow:hidden;min-width:160px;">
  <div style="background:#16a34a;height:3px;width:100%;"></div>
  <div style="padding:8px 12px 10px;">
    <div style="font-size:12px;font-weight:800;color:${txt};margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid ${borderColor};">${escHtml(st.name)}</div>
    <div style="display:grid;grid-template-columns:10px auto 1fr;gap:3px 6px;align-items:center;font-size:12px;color:${txt};">
      <span style="width:10px;height:10px;border-radius:50%;background:${C_BIKE};display:inline-block;"></span>
      <span><b>${bikes}</b></span><span style="color:${muted}">bikes</span>
      <span style="width:10px;height:10px;border-radius:50%;background:${C_EBIKE};display:inline-block;"></span>
      <span><b>${ebikes}</b></span><span style="color:${muted}">e-bikes</span>
      <span style="width:10px;height:10px;border-radius:50%;background:${C_DOCK};display:inline-block;"></span>
      <span><b>${docks}</b></span><span style="color:${muted}">open docks</span>
    </div>
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
