import { BIKESHARE_POLL_MS, GBFS_INFO_URL, GBFS_STATUS_URL } from './config.js';
import { escHtml } from './utils.js';

window.masterBikeStations = new Map();

// Pie segment colors
const C_EBIKE = '#2563eb'; // blue  — e-bikes
const C_BIKE  = '#16a34a'; // green — standard bikes
const C_DOCK  = '#9ca3af'; // gray  — open docks

const BIKE_MINZOOM = 12;
const PIE_SIZE     = 18;    // px diameter

let _map         = null;
let _visible     = true;
let _markers     = new Map(); // stationId → { marker, el }
let _activePopup = null;
let _activeStId  = null;

export async function initBikeShare(map) {
    _map = map;

    try {
        const r    = await fetch(GBFS_INFO_URL);
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

    await _refreshStatus();
    _buildAllMarkers(map);
    _updateLegend();
    _applyZoomVisibility(map);

    map.on('zoom', () => _applyZoomVisibility(map));

    setInterval(async () => {
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
            _applyZoomVisibility(map);
            if (!_visible && _activePopup) {
                _activePopup.remove();
                _activePopup = null;
                _activeStId  = null;
            }
        });
    }
}

// HTML markers persist across style.load — nothing to re-add after dark mode swap.
export function reAddBikeLayer(map) {
    _map = map;
}

async function _refreshStatus() {
    try {
        const r    = await fetch(GBFS_STATUS_URL);
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
    } catch (e) {
        console.warn('[bikeshare] Status refresh failed:', e);
    }
}

// ── Pie chart SVG ──────────────────────────────────────────────────────────────

function _pieSVG(bikes, ebikes, docks) {
    const total = bikes + ebikes + docks;
    const R     = PIE_SIZE / 2;
    const cx    = R, cy = R;
    const r     = R - 1; // inner radius (1px border)

    if (total === 0) {
        // Offline / empty — solid gray
        return `<svg width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="${C_DOCK}" stroke="#fff" stroke-width="1.5"/>
        </svg>`;
    }

    const segments = [
        { value: ebikes, color: C_EBIKE },
        { value: bikes,  color: C_BIKE  },
        { value: docks,  color: C_DOCK  },
    ].filter(s => s.value > 0);

    // Single-segment shortcut (full circle)
    if (segments.length === 1) {
        return `<svg width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="${segments[0].color}" stroke="#fff" stroke-width="1.5"/>
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

    return `<svg width="${PIE_SIZE}" height="${PIE_SIZE}" viewBox="0 0 ${PIE_SIZE} ${PIE_SIZE}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/>
        ${paths}
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#fff" stroke-width="1.5"/>
    </svg>`;
}

// ── Marker management ──────────────────────────────────────────────────────────

function _makeMarkerEl(id, st) {
    const el = document.createElement('div');
    el.className     = 'bike-marker';
    el.style.cssText = `position:relative;cursor:pointer;width:${PIE_SIZE}px;height:${PIE_SIZE}px;` +
                       `filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3));z-index:1;`;
    el.innerHTML = _pieSVG(st.bikes, st.ebikes, st.docks) +
        `<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);` +
        `font-size:7px;line-height:1;pointer-events:none;user-select:none;">🚲</span>`;
    el.addEventListener('click', e => {
        e.stopPropagation();
        _openPopup(id, st, _markers.get(id)?.marker?.getLngLat());
    });
    return el;
}

function _buildAllMarkers(map) {
    for (const [id, st] of window.masterBikeStations) {
        if (!st.lat || !st.lon) continue;
        const el     = _makeMarkerEl(id, st);
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([st.lon, st.lat])
            .addTo(map);
        _markers.set(id, { marker, el });
    }
}

function _updateAllMarkers() {
    const ICON = `<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);` +
                 `font-size:7px;line-height:1;pointer-events:none;user-select:none;">🚲</span>`;
    for (const [id, st] of window.masterBikeStations) {
        const m = _markers.get(id);
        if (!m) continue;
        m.el.innerHTML = _pieSVG(st.bikes, st.ebikes, st.docks) + ICON;
    }
}

function _applyZoomVisibility(map) {
    const zoom    = map.getZoom();
    const show    = _visible && zoom >= BIKE_MINZOOM;
    const display = show ? '' : 'none';
    for (const { el } of _markers.values()) {
        el.style.display = display;
    }
}

// ── Popup ──────────────────────────────────────────────────────────────────────

function _openPopup(id, st, lngLat) {
    if (_activePopup) _activePopup.remove();
    if (!lngLat) return;
    _activeStId  = id;
    _activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px', offset: PIE_SIZE / 2 + 4 })
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
    const st = window.masterBikeStations.get(_activeStId);
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
