/**
 * microzones.js
 * Loads and renders Metro Micro on-demand service zone polygons from
 * data/metro-micro-zones.json (a GeoJSON FeatureCollection).
 *
 * Layers:
 *   micro-zones-fill   — semi-transparent fill (opacity 0.12), colored per zone
 *   micro-zones-border — zone outline
 *   micro-zones-labels — centered zone name label (minzoom 10)
 *   micro-zones-hover  — invisible hit target, drives hover opacity boost
 *
 * Download data/metro-micro-zones.json from:
 *   https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas
 *   → Download → GeoJSON → save as data/metro-micro-zones.json
 */

import { escHtml } from './utils.js';

const SOURCE_ID       = 'micro-zones';
const FILL_LAYER      = 'micro-zones-fill';
const BORDER_LAYER    = 'micro-zones-border';
const LABEL_LAYER     = 'micro-zones-labels';
const HOVER_LAYER     = 'micro-zones-hover';

// Default zone color (overridden per-feature by a `color` property if present)
const DEFAULT_COLOR   = '#6366f1'; // indigo — visually distinct from route colors
const DARK_COLOR      = '#f97316'; // orange — used in dark mode
const FILL_OPACITY    = 0.12;
const HOVER_OPACITY   = 0.28;
const BORDER_OPACITY  = 0.55;

let _map          = null;
let _visible      = true;
let _hoveredId    = null;
let _popup        = null;
let _listenersOk  = false;
let _geojsonCache = null;

/**
 * Load metro-micro-zones.json and add fill, border, label, and hover layers to the map.
 * Handles legend row toggle, hover opacity boost, click popup, and dark mode color updates.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export async function initMicroZones(map) {
    _map = map;

    let geojson;
    if (_geojsonCache) {
        geojson = _geojsonCache;
    } else {
        try {
            const r = await fetch('./data/metro-micro-zones.json');
            geojson = await r.json();
            _geojsonCache = geojson;
        } catch (e) {
            console.warn('[microzones] Failed to load metro-micro-zones.json:', e);
            return;
        }
    }

    if (!geojson?.features?.length) {
        console.warn('[microzones] No zone features found — download the GeoJSON from the Hub page.');
        return;
    }

    // Assign sequential numeric IDs so hover state can be tracked
    geojson.features.forEach((f, i) => { f.id ??= i; });

    _addLayers(map, geojson);
    _attachListeners(map);
    _updateLegend(geojson.features.length);
}

/**
 * Re-add all micro-zone layers after a dark mode style swap.
 * GeoJSON is served from the in-memory cache so no additional fetch is made.
 * @param {maplibregl.Map} map MapLibre map instance (post-swap)
 */
export function reAddMicroZonesLayer(map) {
    _map = map;
    // Re-add layers after style swap. GeoJSON is served from _geojsonCache —
    // no network refetch. Listeners survive style reload on the map object.
    initMicroZones(map);
}

function _addLayers(map, geojson) {
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: geojson,
        generateId: false, // IDs already set above
        promoteId: 'id',
    });

    const isDark = document.body.classList.contains('dark-mode');
    const defaultColor = isDark ? DARK_COLOR : DEFAULT_COLOR;

    // Fill
    map.addLayer({
        id:      FILL_LAYER,
        type:    'fill',
        source:  SOURCE_ID,
        minzoom: 9,
        layout:  { visibility: _visible ? 'visible' : 'none' },
        paint:   {
            'fill-color':   ['coalesce', ['get', 'color'], defaultColor],
            'fill-opacity': [
                'case',
                ['boolean', ['feature-state', 'hover'], false],
                HOVER_OPACITY,
                FILL_OPACITY,
            ],
        },
    });

    // Border
    map.addLayer({
        id:      BORDER_LAYER,
        type:    'line',
        source:  SOURCE_ID,
        minzoom: 9,
        layout:  { visibility: _visible ? 'visible' : 'none' },
        paint:   {
            'line-color':   ['coalesce', ['get', 'color'], defaultColor],
            'line-width':   1.5,
            'line-opacity': BORDER_OPACITY,
        },
    });

    // Hover hit target (invisible, just for events)
    map.addLayer({
        id:      HOVER_LAYER,
        type:    'fill',
        source:  SOURCE_ID,
        minzoom: 9,
        layout:  { visibility: _visible ? 'visible' : 'none' },
        paint:   { 'fill-opacity': 0 },
    });
}

function _attachListeners(map) {
    if (_listenersOk) return;
    _listenersOk = true;

    map.on('mouseenter', HOVER_LAYER, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', HOVER_LAYER, () => {
        map.getCanvas().style.cursor = '';
        if (_hoveredId !== null) {
            map.setFeatureState({ source: SOURCE_ID, id: _hoveredId }, { hover: false });
            _hoveredId = null;
        }
    });
    map.on('mousemove', HOVER_LAYER, e => {
        const id = e.features?.[0]?.id;
        if (id === undefined) return;
        if (_hoveredId !== null && _hoveredId !== id) {
            map.setFeatureState({ source: SOURCE_ID, id: _hoveredId }, { hover: false });
        }
        _hoveredId = id;
        map.setFeatureState({ source: SOURCE_ID, id: _hoveredId }, { hover: true });
    });

    // App store links — App Store / Play Store URLs also act as universal/app links
    // and open the installed app directly on iOS / Android.
    const IOS_URL     = 'https://apps.apple.com/ca/app/la-metro-micro/id6742661117';
    const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.sparelabs.platform.rider.lametromicro&hl=en';

    map.on('click', HOVER_LAYER, e => {
        // Don't open micro zone popup when a transit station is at the same point.
        if (map.queryRenderedFeatures(e.point, { layers: ['metro-stations-click'] }).length) return;
        const props = e.features?.[0]?.properties;
        if (!props) return;
        if (_popup) _popup.remove();

        const name  = props.Name ?? props.name ?? props.zone_name ?? 'Metro Micro Zone';
        const hours = props.hours ?? props.operating_hours ?? '';
        const isDark = document.body.classList.contains('dark-mode');
        const bg  = isDark ? '#1e1e1e' : '#ffffff';
        const txt = isDark ? '#f0f0f0' : '#111111';
        const muted = isDark ? '#aaaaaa' : '#666666';
        const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

        const hoursRow = hours
            ? `<div style="margin-top:4px;font-size:11px;color:${muted};">⏰ ${escHtml(hours)}</div>`
            : '';

        const accentColor = isDark ? DARK_COLOR : DEFAULT_COLOR;
        const linkColor   = isDark ? '#93c5fd' : '#0072bc';
        const btnBase     = `display:inline-flex;align-items:center;gap:4px;margin-top:8px;font-size:11px;font-weight:600;color:${linkColor};text-decoration:none;`;

        // Detect platform so the primary link opens the correct store
        // (both store URLs are universal/app links that launch the installed app)
        const ua       = navigator.userAgent;
        const isIOS    = /iPad|iPhone|iPod/.test(ua);
        const isAndroid = /Android/.test(ua);

        let appLinksHTML;
        if (isIOS) {
            appLinksHTML = `<a href="${IOS_URL}" target="_blank" rel="noopener" style="${btnBase}">📱 Open in App Store →</a>`;
        } else if (isAndroid) {
            appLinksHTML = `<a href="${ANDROID_URL}" target="_blank" rel="noopener" style="${btnBase}">📱 Open in Google Play →</a>`;
        } else {
            // Desktop: show both store links
            appLinksHTML = `
              <div style="display:flex;gap:10px;margin-top:8px;flex-wrap:wrap;">
                <a href="${IOS_URL}" target="_blank" rel="noopener" style="${btnBase}margin-top:0;">🍎 App Store</a>
                <a href="${ANDROID_URL}" target="_blank" rel="noopener" style="${btnBase}margin-top:0;">▶ Google Play</a>
              </div>`;
        }

        _popup = new maplibregl.Popup({ closeButton: true, maxWidth: '240px' })
            .setLngLat(e.lngLat)
            .setHTML(`
<div style="font-family:'Open Sans',sans-serif;background:${bg};border-radius:8px;overflow:hidden;min-width:160px;">
  <div style="background:${accentColor};height:3px;width:100%;"></div>
  <div style="padding:8px 12px 10px;">
    <div style="font-size:12px;font-weight:800;color:${txt};margin-bottom:4px;padding-bottom:6px;border-bottom:1px solid ${borderColor};">
      🚐 ${escHtml(name)}
    </div>
    ${hoursRow}
    ${appLinksHTML}
  </div>
</div>`)
            .addTo(map);
        _popup.on('close', () => { _popup = null; });
    });

    // Legend row toggle (attach only once via _listenersOk guard)
    const row = document.getElementById('microzones-legend-row');
    if (row) {
        row.addEventListener('click', () => {
            _visible = !_visible;
            row.classList.toggle('disabled', !_visible);
            for (const layerId of [FILL_LAYER, BORDER_LAYER, HOVER_LAYER]) {
                if (map.getLayer(layerId)) {
                    map.setLayoutProperty(layerId, 'visibility', _visible ? 'visible' : 'none');
                }
            }
            if (!_visible && _popup) { _popup.remove(); _popup = null; }
        });
    }

    // Dark mode toggle
    document.addEventListener('toggleDarkMode', e => {
        if (!map.getLayer(FILL_LAYER)) return; // style not yet loaded
        const isDark = e.detail.isDark;
        const color = isDark ? DARK_COLOR : DEFAULT_COLOR;
        map.setPaintProperty(FILL_LAYER, 'fill-color', ['coalesce', ['get', 'color'], color]);
        map.setPaintProperty(BORDER_LAYER, 'line-color', ['coalesce', ['get', 'color'], color]);
    });
}

function _updateLegend(count) {
    const badge = document.getElementById('microzones-count');
    if (badge) badge.textContent = count > 0 ? count : '';
}
