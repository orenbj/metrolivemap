import { VIEWPORT_BREAKPOINT_MOBILE, VIEWPORT_BREAKPOINT_TABLET, VEHICLE_ZOOM_MIN, VEHICLE_ZOOM_MAX, VEHICLE_SIZE_MIN_PX, VEHICLE_SIZE_MAX_PX } from './config.js';

/**
 * Create and configure the MapLibre map instance. Restores dark mode from
 * localStorage, applies zoom-based initial view, adds navigation/home/locate/
 * dark-mode/layer-toggle controls, loads the ESRI rail overlay, and wires
 * vehicle marker size scaling to the zoom level.
 * @returns {maplibregl.Map}
 */
export function initMap() {
    // Restore dark mode before map creation so the correct style loads on first paint
    const savedDark = localStorage.getItem('darkMode') === 'true';
    if (savedDark) document.body.classList.add('dark-mode');

    const params = new URLSearchParams(window.location.search);
    const rawZoom = parseFloat(params.get('zoom'));
    let zoom;
    if (isFinite(rawZoom)) {
        zoom = Math.max(8, Math.min(20, rawZoom));
    } else {
        const w = window.innerWidth;
        zoom = w <= VIEWPORT_BREAKPOINT_MOBILE ? 8 : w <= VIEWPORT_BREAKPOINT_TABLET ? 9 : 10;
    }

    const map = new maplibregl.Map({
        container: 'map',
        center: [-118.25133692966446, 34.00095151499077],
        zoom: zoom,
        pitch: 0,
        bearing: 0,
        antialias: true,
        minZoom: 8,
        style: savedDark
            ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
            : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
        attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');

    class HomeControl {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'maplibregl-ctrl-icon home-icon';
            button.setAttribute('aria-label', 'Return to home view');
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
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

    class LocateControl {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'maplibregl-ctrl-icon locate-icon';
            button.setAttribute('aria-label', 'Locate me');
            // GPS Target Icon - using currentColor for stroke
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle><line x1="12" y1="1" x2="12" y2="4"></line><line x1="12" y1="20" x2="12" y2="23"></line><line x1="1" y1="12" x2="4" y2="12"></line><line x1="20" y1="12" x2="23" y2="12"></line></svg>`;
            button.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('requestAutoLocate'));
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
            button.type = 'button';
            button.className = 'maplibregl-ctrl-icon dark-mode-icon';

            const SUN_ICON  = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
            const MOON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

            // Initialise icon to match restored dark mode state
            const initDark = document.body.classList.contains('dark-mode');
            button.setAttribute('aria-label', initDark ? 'Toggle light mode' : 'Toggle dark mode');
            button.innerHTML = initDark ? SUN_ICON : MOON_ICON;

            button.addEventListener('click', () => {
                document.body.classList.toggle('dark-mode');
                const isDark = document.body.classList.contains('dark-mode');
                localStorage.setItem('darkMode', String(isDark));
                document.dispatchEvent(new CustomEvent('toggleDarkMode', { detail: { isDark } }));

                if (isDark) {
                    button.setAttribute('aria-label', 'Toggle light mode');
                    button.innerHTML = SUN_ICON;
                } else {
                    button.setAttribute('aria-label', 'Toggle dark mode');
                    button.innerHTML = MOON_ICON;
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
    map.addControl(new LocateControl(), 'top-left');
    map.addControl(new DarkModeControl(), 'top-left');

    class LayerToggleControl {
        onAdd(map) {
            this._map = map;
            this._container = document.createElement('div');
            this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

            const makeBtn = (icon, label, rowId) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('title', label);
                btn.setAttribute('aria-label', label);
                btn.className = 'maplibregl-ctrl-icon layer-toggle-btn';
                btn.innerHTML = icon;
                btn.addEventListener('click', () => {
                    document.getElementById(rowId)?.click();
                    btn.classList.toggle('layer-btn-off', document.getElementById(rowId)?.classList.contains('disabled') ?? false);
                });
                return btn;
            };

            this._container.appendChild(makeBtn('🚲', 'Metro Bike Share', 'bikeshare-legend-row'));
            this._container.appendChild(makeBtn('🚐', 'Metro Micro', 'microzones-legend-row'));
            return this._container;
        }
        onRemove() {
            this._container.parentNode?.removeChild(this._container);
            this._map = undefined;
        }
    }

    map.addControl(new LayerToggleControl(), 'top-right');

    /** Add imagery and custom GeoJSON layers to the map after style load. */
    function addCustomLayers() {
        // ── Metro rail overlay (polylines + stations) ────────────────────────────
        if (!map.getSource('imagery-source')) {
            try {
                new mapboxglEsriSources.TiledMapService('imagery-source', map, {
                    url: 'https://tiles.arcgis.com/tiles/TNoJFjk1LsD45Juj/arcgis/rest/services/Metro_Rail_and_Busway10/MapServer'
                });
            } catch (e) {
                console.warn('[esri] Failed to add rail overlay source:', e);
            }
        }

        if (!map.getLayer('imagery-layer') && map.getSource('imagery-source')) {
            map.addLayer({
                id: 'imagery-layer',
                type: 'raster',
                source: 'imagery-source',
                paint: { 'raster-opacity': 1.0 }
            });
        }

    }

    map.on('load', addCustomLayers);

    let isStyleChanging = false;
    document.addEventListener('toggleDarkMode', (e) => {
        if (isStyleChanging) return;
        isStyleChanging = true;
        const isDark = e.detail.isDark;
        const newStyle = isDark
            ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
            : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
        map.setStyle(newStyle);
        map.once('style.load', () => {
            addCustomLayers();
            isStyleChanging = false;
        });
    });

    function updateVehicleSize() {
        const currentZoom = map.getZoom();
        const zoomRange = VEHICLE_ZOOM_MAX - VEHICLE_ZOOM_MIN;
        const sizeRange = VEHICLE_SIZE_MAX_PX - VEHICLE_SIZE_MIN_PX;
        let newSize;
        if (currentZoom <= VEHICLE_ZOOM_MIN) {
            newSize = VEHICLE_SIZE_MIN_PX;
        } else if (currentZoom >= VEHICLE_ZOOM_MAX) {
            newSize = VEHICLE_SIZE_MAX_PX;
        } else {
            newSize = VEHICLE_SIZE_MIN_PX + ((currentZoom - VEHICLE_ZOOM_MIN) / zoomRange) * sizeRange;
        }
        document.documentElement.style.setProperty('--vehicle-size', `${newSize}px`);
    }

    // Call once on init and bind to zoom
    updateVehicleSize();
    map.on('zoom', updateVehicleSize);

    return map;
}

/**
 * Request the user's current GPS position.
 * @returns {Promise<{lng: number, lat: number}>}
 */
export function getUserLocation() {
    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            return reject(new Error('Geolocation not supported'));
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
            (err) => reject(err),
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    });
}
