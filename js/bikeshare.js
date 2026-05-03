import { BIKESHARE_COLOR, BIKESHARE_POLL_MS, GBFS_INFO_URL, GBFS_STATUS_URL } from './config.js';
import { escHtml } from './utils.js';

window.masterBikeStations = new Map();

const SOURCE_ID = 'bike-stations';
const LAYER_ID  = 'bike-stations-circles';

let _map         = null;
let _visible     = true;
let _activePopup = null;
let _activeStId  = null;
let _listenersOk = false;

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
    _addLayers(map);
    _attachListeners(map);
    _updateLegend();

    setInterval(async () => {
        await _refreshStatus();
        _updateSource();
        _updateLegend();
        _refreshActivePopup();
    }, BIKESHARE_POLL_MS);

    const row = document.getElementById('bikeshare-legend-row');
    if (row) {
        row.addEventListener('click', () => {
            _visible = !_visible;
            row.classList.toggle('disabled', !_visible);
            if (_map?.getLayer(LAYER_ID)) {
                _map.setLayoutProperty(LAYER_ID, 'visibility', _visible ? 'visible' : 'none');
            }
            if (!_visible && _activePopup) {
                _activePopup.remove();
                _activePopup = null;
                _activeStId  = null;
            }
        });
    }
}

export function reAddBikeLayer(map) {
    _map = map;
    _addLayers(map);
    // Listeners registered via map.on(event, layerId, handler) survive style reloads
    // on the map object — no need to re-attach.
}

async function _refreshStatus() {
    try {
        const r    = await fetch(GBFS_STATUS_URL);
        const data = await r.json();
        for (const st of data.data.stations) {
            const info = window.masterBikeStations.get(st.station_id);
            if (info) {
                info.bikes  = st.num_bikes_available  ?? 0;
                info.ebikes = st.num_ebikes_available ?? 0;
                info.docks  = st.num_docks_available  ?? 0;
            }
        }
    } catch (e) {
        console.warn('[bikeshare] Status refresh failed:', e);
    }
}

function _toGeoJSON() {
    const features = [];
    for (const [id, st] of window.masterBikeStations) {
        if (!st.lat || !st.lon) continue;
        features.push({
            type:       'Feature',
            geometry:   { type: 'Point', coordinates: [st.lon, st.lat] },
            properties: { id, name: st.name, bikes: st.bikes, ebikes: st.ebikes, docks: st.docks },
        });
    }
    return { type: 'FeatureCollection', features };
}

function _addLayers(map) {
    if (map.getSource(SOURCE_ID)) return;
    map.addSource(SOURCE_ID, { type: 'geojson', data: _toGeoJSON() });
    map.addLayer({
        id:      LAYER_ID,
        type:    'circle',
        source:  SOURCE_ID,
        minzoom: 12,
        layout:  { visibility: _visible ? 'visible' : 'none' },
        paint:   {
            'circle-radius':       ['interpolate', ['linear'], ['zoom'], 12, 5, 15, 9],
            'circle-color':        BIKESHARE_COLOR,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
            'circle-opacity':      0.9,
        },
    });
}

function _attachListeners(map) {
    if (_listenersOk) return;
    _listenersOk = true;
    map.on('mouseenter', LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', LAYER_ID, () => { map.getCanvas().style.cursor = ''; });
    map.on('click', LAYER_ID, e => {
        const props = e.features?.[0]?.properties;
        if (!props) return;
        if (_activePopup) _activePopup.remove();
        _activeStId  = props.id;
        _activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '220px' })
            .setLngLat(e.lngLat)
            .setHTML(_buildPopupHTML(props))
            .addTo(map);
        _activePopup.on('close', () => { _activePopup = null; _activeStId = null; });
    });
}

function _buildPopupHTML(props) {
    const isDark      = document.body.classList.contains('dark-mode');
    const bg          = isDark ? '#1e1e1e' : '#ffffff';
    const txt         = isDark ? '#f0f0f0' : '#111111';
    const muted       = isDark ? '#aaaaaa' : '#666666';
    const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
    return `
<div style="font-family:'Open Sans',sans-serif;background:${bg};border-radius:8px;overflow:hidden;min-width:160px;">
  <div style="background:${BIKESHARE_COLOR};height:3px;width:100%;"></div>
  <div style="padding:8px 12px 10px;">
    <div style="font-size:12px;font-weight:800;color:${txt};margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid ${borderColor};">${escHtml(props.name)}</div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:3px 8px;font-size:12px;color:${txt};">
      <span>🚲</span><span><b>${props.bikes}</b>&nbsp;<span style="color:${muted}">bikes</span></span>
      <span>⚡</span><span><b>${props.ebikes}</b>&nbsp;<span style="color:${muted}">e-bikes</span></span>
      <span>🅿️</span><span><b>${props.docks}</b>&nbsp;<span style="color:${muted}">docks</span></span>
    </div>
  </div>
</div>`;
}

function _updateSource() {
    const src = _map?.getSource(SOURCE_ID);
    if (src) src.setData(_toGeoJSON());
}

function _updateLegend() {
    const stations = Array.from(window.masterBikeStations.values());
    const active   = stations.filter(s => s.bikes + s.ebikes > 0).length;
    const total    = stations.length;

    const badge = document.getElementById('bikeshare-count');
    if (badge) badge.textContent = active > 0 ? active : '';

    const fill = document.querySelector('#bikeshare-legend-row .bar-fill');
    if (fill) fill.style.width = total > 0 ? `${Math.round((active / total) * 100)}%` : '0%';
}

function _refreshActivePopup() {
    if (!_activePopup || !_activeStId) return;
    const st = window.masterBikeStations.get(_activeStId);
    if (!st) return;
    _activePopup.setHTML(_buildPopupHTML({
        name: st.name, bikes: st.bikes, ebikes: st.ebikes, docks: st.docks,
    }));
}
