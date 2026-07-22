/**
 * microzones.js
 * Loads and renders Metro Micro on-demand service zone polygons from
 * data/metro-micro-zones.json (a GeoJSON FeatureCollection).
 *
 * Layers:
 *   micro-zones-fill   — semi-transparent fill (opacity 0.12), colored per zone
 *   micro-zones-border — zone outline
 *   micro-zones-hover  — invisible hit target, drives hover opacity boost
 *
 * Download data/metro-micro-zones.json from:
 *   https://transit2parks-lametro.hub.arcgis.com/datasets/metro-micro-service-areas
 *   → Download → GeoJSON → save as data/metro-micro-zones.json
 */

import { escHtml, fetchWithTimeout, readPersistedBoolean, isDomMarkerTarget } from './utils.js';
import { setActivePopup, notifyPopupClosed } from './popups.js';

const SOURCE_ID       = 'micro-zones';
const FILL_LAYER      = 'micro-zones-fill';
const BORDER_LAYER    = 'micro-zones-border';
const HOVER_LAYER     = 'micro-zones-hover';

// Default zone color (overridden per-feature by a `color` property if present)
const DEFAULT_COLOR   = '#6366f1'; // indigo — visually distinct from route colors
const DARK_COLOR      = '#f97316'; // orange — used in dark mode
const FILL_OPACITY    = 0.12;
const HOVER_OPACITY   = 0.28;
const BORDER_OPACITY  = 0.55;

// Persisted across sessions in localStorage under MICROZONES_VISIBLE_KEY.
// Default OFF on first visit so the initial map render isn't blanketed
// by the indigo Micro service-area polygon — riders who use Micro can
// turn it on via the top-right toggle and their choice persists.
// Mirrors the bikeshare.js / darkMode persistence pattern.
const MICROZONES_VISIBLE_KEY = 'microzonesVisible';
let _visible      = readPersistedBoolean(MICROZONES_VISIBLE_KEY, false);
let _hoveredId    = null;
let _popup        = null;

// Canonical teardown for the micro-zone popup. Stable module-level reference so
// the single-popup coordinator (js/popups.js) can invoke it and match it on notify.
function _closeMicroPopup() {
    const p = _popup;
    _popup = null;
    if (p) p.remove();
}
let _listenersOk  = false;
let _geojsonCache = null;
let _retryTimer   = null;
let _retryCount   = 0;
// Bounded self-heal for the one-shot GeoJSON load. Unlike bike-share (which
// self-heals via its live GBFS poll), micro-zones is a static one-shot fetch —
// a transient failure (e.g. a request landing mid-deploy) previously disabled
// the layer for the whole session, recovering only if the user happened to
// toggle dark mode. A few spaced retries recover a transient outage on their own.
const _MICRO_RETRY_MAX      = 3;
const _MICRO_RETRY_DELAY_MS = 30000;

/**
 * Load metro-micro-zones.json and add fill, border, label, and hover layers to the map.
 * Handles legend row toggle, hover opacity boost, click popup, and dark mode color updates.
 * @param {maplibregl.Map} map MapLibre map instance
 */
export async function initMicroZones(map) {
    let geojson;
    if (_geojsonCache) {
        geojson = _geojsonCache;
    } else {
        try {
            const r = await fetchWithTimeout('./data/metro-micro-zones.json', 10000);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            geojson = await r.json();
            _geojsonCache = geojson;
            _retryCount = 0;
        } catch (e) {
            console.warn('[microzones] Failed to load metro-micro-zones.json:', e);
            // Self-heal: schedule a bounded retry so a transient outage doesn't
            // disable the layer for the session. Idempotent — only one timer is
            // ever in flight, and _addLayers is guarded against a double-add if a
            // retry races a dark-mode re-invoke.
            if (_retryTimer == null && _retryCount < _MICRO_RETRY_MAX) {
                _retryCount++;
                _retryTimer = setTimeout(() => { _retryTimer = null; initMicroZones(map); }, _MICRO_RETRY_DELAY_MS);
            }
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
    // Re-add layers after style swap. GeoJSON is served from _geojsonCache —
    // no network refetch. Listeners survive style reload on the map object.
    initMicroZones(map);
}

function _addLayers(map, geojson) {
    if (map.getSource(SOURCE_ID)) return;

    map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: geojson,
        generateId: false, // top-level feature ids already set above (f.id ??= i)
        // No promoteId: the ids live at the TOP level (f.id), which is MapLibre's
        // default feature-state key. `promoteId: 'id'` instead read
        // feature.properties.id — a key the Metro Micro data doesn't have
        // (properties are OBJECTID/Name/…) — so every id resolved undefined and
        // the hover-opacity boost (setFeatureState({hover})) silently never fired.
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
        // Don't open the micro zone popup when something else owns this click:
        //  • a DOM marker (vehicle / bike) at the same point — those handle their
        //    own click and would otherwise be evicted by the zone popup;
        //  • either station click layer — rail/BRT (metro-stations-click) OR J
        //    Line street-running stops (metro-stations-click-jline, active at
        //    zoom ≥ 14). The guard previously checked only the rail/BRT layer, so
        //    tapping a J Line stop inside a Micro service area opened both popups.
        if (isDomMarkerTarget(e)) return;
        if (map.queryRenderedFeatures(e.point, {
            layers: ['metro-stations-click', 'metro-stations-click-jline'],
        }).length) return;
        const props = e.features?.[0]?.properties;
        if (!props) return;
        _closeMicroPopup();

        const name  = props.Name ?? props.name ?? props.zone_name ?? 'Metro Micro Zone';
        const hours = props.hours ?? props.operating_hours ?? '';

        // Content is class-styled (shared mp-* recipe in index-style.css) so
        // dark mode restyles an OPEN popup live via CSS variables — the old
        // inline-style build baked the theme in at render time and went stale
        // on toggle. The accent's light/dark colors live on .mp-accent--micro.
        const hoursRow = hours
            ? `<div class="mp-muted">⏰ ${escHtml(hours)}</div>`
            : '';

        // Both store URLs are universal/app links that launch the installed app.
        const link = (href, label) =>
            `<a href="${href}" target="_blank" rel="noopener" class="mp-link mp-link--micro">${label}</a>`;
        const ua = navigator.userAgent;
        let appLinksHTML;
        if (/iPad|iPhone|iPod/.test(ua)) {
            appLinksHTML = link(IOS_URL, '📱 Open in App Store →');
        } else if (/Android/.test(ua)) {
            appLinksHTML = link(ANDROID_URL, '📱 Open in Google Play →');
        } else {
            appLinksHTML = `<div class="mp-links">${link(IOS_URL, '🍎 App Store')}${link(ANDROID_URL, '▶ Google Play')}</div>`;
        }

        _popup = new maplibregl.Popup({ closeButton: true, maxWidth: '240px', className: 'microzones-popup' })
            .setLngLat(e.lngLat)
            .setHTML(`
<div class="mp-card">
  <div class="mp-accent mp-accent--micro"></div>
  <div class="mp-body">
    <div class="mp-title">🚐 ${escHtml(name)}</div>
    ${hoursRow}
    ${appLinksHTML}
  </div>
</div>`)
            .addTo(map);
        // a11y: label the popup container as a dialog (mirrors stations.js).
        const _mpEl = _popup.getElement?.();
        if (_mpEl) {
            _mpEl.setAttribute('role', 'dialog');
            _mpEl.setAttribute('aria-label', `Metro Micro zone: ${name ?? ''}`.trim());
        }
        _popup.on('close', () => { notifyPopupClosed(_closeMicroPopup); _popup = null; });
        // Single active popup: close any OTHER open popup (station / vehicle /
        // bike / alerts panel). Micro zone popups are click-only (no hover
        // preview), so always pinned → other owners' hovers won't evict them.
        setActivePopup(_closeMicroPopup, () => true);
    });

    // Legend row toggle (attach only once via _listenersOk guard)
    const row = document.getElementById('microzones-legend-row');
    if (row) {
        // Reflect the persisted off-state on the row + map toggle button
        // before wiring the click handler. The layer's `visibility` layout
        // property was already set to 'none' at layer creation via _visible.
        row.classList.toggle('disabled', !_visible);
        document.getElementById('microzones-toggle-btn')
            ?.classList.toggle('layer-btn-off', !_visible);

        row.addEventListener('click', () => {
            _visible = !_visible;
            row.classList.toggle('disabled', !_visible);
            try { localStorage.setItem(MICROZONES_VISIBLE_KEY, String(_visible)); } catch { /* storage disabled */ }
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
