import { MAPTILER_KEY } from './config.js';
import { loadShapes, getShapeGeoJSON } from './snap.js';

export function initMap() {
    const params = new URLSearchParams(window.location.search);
    let zoom = params.get('zoom');
    if (!zoom) {
        const w = window.innerWidth;
        zoom = w <= 768 ? 8 : w <= 1280 ? 9 : 10;
    }

    const map = new maplibregl.Map({
        container: 'map',
        center: [-118.25133692966446, 34.00095151499077],
        zoom: zoom,
        pitch: 0,
        bearing: 0,
        antialias: true,
        minZoom: 8,
        style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');

    class HomeControl {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
            const button = document.createElement('button');
            button.className = 'maplibregl-ctrl-icon home-icon';
            // Use inline SVG instead of FontAwesome
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M12 3l8 6v12h-5v-7H9v7H4V9l8-6z"/>
            </svg>`;
            button.addEventListener('click', () => {
                this.map.flyTo({ center: [-118.25133692966446, 34.00095151499077], zoom: 9, pitch: 0, bearing: 0 });
            });
            this.container.appendChild(button);
            return this.container;
        }
        onRemove() {
            this.container.parentNode.removeChild(this.container);
            this.map = undefined;
        }
    }

    class DarkModeControl {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
            const button = document.createElement('button');
            button.className = 'maplibregl-ctrl-icon dark-mode-icon';
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
            
            button.addEventListener('click', () => {
                document.body.classList.toggle('dark-mode');
                const isDark = document.body.classList.contains('dark-mode');
                document.dispatchEvent(new CustomEvent('toggleDarkMode', { detail: { isDark } }));
                
                if (isDark) {
                    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
                } else {
                    button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
                }
            });
            this.container.appendChild(button);
            return this.container;
        }
        onRemove() {
            this.container.parentNode.removeChild(this.container);
            this.map = undefined;
        }
    }

    map.addControl(new HomeControl(), 'top-left');
    map.addControl(new DarkModeControl(), 'top-left');

    function addCustomLayers() {
        const layers = map.getStyle().layers;
        let labelLayerId;
        for (const layer of layers) {
            if (layer.type === 'symbol' && layer.layout['text-field']) {
                labelLayerId = layer.id;
                break;
            }
        }

        // ── Route polylines from rail-shapes.json ────────────────────────────
        const addRouteLines = () => {
            if (map.getSource('route-lines')) return; // already added
            const geo = getShapeGeoJSON();
            if (!geo.features.length) return;

            map.addSource('route-lines', { type: 'geojson', data: geo });
            map.addLayer({
                id: 'route-lines',
                type: 'line',
                source: 'route-lines',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-color': [
                        'match', ['get', 'route_code'],
                        '801', '#0072bc',
                        '802', '#e31937',
                        '803', '#58a738',
                        '804', '#fdb913',
                        '805', '#a05da5',
                        '807', '#e56db1',
                        '901', '#fc4c02',
                        '910', '#adb8bf',
                        '#888888'
                    ],
                    'line-width': [
                        'interpolate', ['linear'], ['zoom'],
                        8, 1.5, 12, 3, 16, 5
                    ],
                    'line-opacity': 0.85,
                },
            }, labelLayerId);
        };

        // Shapes may still be loading on first map load — retry when ready
        if (getShapeGeoJSON().features.length > 0) {
            addRouteLines();
        } else {
            loadShapes().then(addRouteLines);
        }

        // ── ESRI imagery (may 404 on some zoom levels — non-critical) ─────────
            new mapboxglEsriSources.TiledMapService('imagery-source', map, {
                url: 'https://tiles.arcgis.com/tiles/TNoJFjk1LsD45Juj/arcgis/rest/services/Map_RGB_Vector_Offset_RC5/MapServer'
            });
        }

        if (!map.getLayer('imagery-layer')) {
            map.addLayer({
                id: 'imagery-layer',
                type: 'raster',
                source: 'imagery-source',
                paint: { 'raster-opacity': 1.0 }
            });
        }

        if (!map.getSource('openmaptiles')) {
            map.addSource('openmaptiles', {
                url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${MAPTILER_KEY}`,
                type: 'vector',
            });
        }

        if (!map.getLayer('3d-buildings')) {
            map.addLayer({
                id: '3d-buildings',
                source: 'openmaptiles',
                'source-layer': 'building',
                type: 'fill-extrusion',
                minzoom: 14,
                paint: {
                    'fill-extrusion-color': [
                        'interpolate', ['linear'], ['get', 'render_height'],
                        0, 'lightgray', 200, 'hsl(38, 28%, 77%)', 400, 'hsl(38, 28%, 77%)'
                    ],
                    'fill-extrusion-opacity': 0.5,
                    'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, ['get', 'render_height']],
                    'fill-extrusion-base': ['case', ['>=', ['get', 'zoom'], 16], ['get', 'render_min_height'], 0]
                }
            }, labelLayerId);
        }
    }

    map.on('load', () => {
        addCustomLayers();

        // Toggle attribution collapse by default
        const attrBtn = document.getElementsByClassName('maplibregl-ctrl-attrib-button')[0];
        if (attrBtn) attrBtn.click();
    });

    document.addEventListener('toggleDarkMode', (e) => {
        const isDark = e.detail.isDark;
        const newStyle = isDark 
            ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
            : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
        
        map.setStyle(newStyle);
        map.once('style.load', addCustomLayers);
    });

    function updateVehicleSize() {
        const currentZoom = map.getZoom();
        // At zoom 9 or lower, size is 16px. At zoom 14 or higher, size is 32px.
        let newSize = 24;
        if (currentZoom <= 9) {
            newSize = 14;
        } else if (currentZoom >= 14) {
            newSize = 36;
        } else {
            // Smooth gradient between zoom 9 and 14
            newSize = 14 + ((currentZoom - 9) / 5) * 22;
        }
        document.documentElement.style.setProperty('--vehicle-size', `${newSize}px`);
    }

    // Call once on init and bind to zoom
    updateVehicleSize();
    map.on('zoom', updateVehicleSize);

    return map;
}
