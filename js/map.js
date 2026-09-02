import { VEHICLE_ZOOM_MIN, VEHICLE_ZOOM_MAX, VEHICLE_SIZE_MIN_PX, VEHICLE_SIZE_MAX_PX, GEO_TIMEOUT_MS, GEO_MAX_AGE_MS, NETWORK_FIT_BOUNDS, MAP_PAN_BOUNDS } from './config.js';
import { readPersistedBoolean } from './utils.js';

// fitBounds padding for the initial view and the Home button. Extra top
// clearance keeps the network's north end out from under the overlaying
// search bar.
const FIT_PADDING = { top: 90, bottom: 40, left: 30, right: 30 };

/**
 * Status-bar / browser-chrome colors. Must match the body background-color
 * rules in styles/index-style.css — the strip above the page and the page
 * itself are painted by different mechanisms, and a mismatch shows as a seam.
 */
const THEME_COLOR_LIGHT = '#ffffff';
const THEME_COLOR_DARK  = '#1e1e1e';

/**
 * Point the `theme-color` metas at the theme the app is ACTUALLY showing.
 *
 * index.html ships two of them, switched by `prefers-color-scheme`. That is
 * only correct while the app follows the OS — but the app has its own dark-mode
 * toggle, persisted in `localStorage.darkMode`, so a rider on a light-mode phone
 * who turns on dark mode (or the reverse) left the metas resolving to the wrong
 * one. In an installed PWA that is a white status bar sitting above a dark map,
 * for the whole session, every session.
 *
 * BOTH metas are set to the same resolved value rather than one being removed:
 * whichever media query matches then yields the same answer, so the OS
 * preference stops mattering without any DOM surgery, and the static pair still
 * gives a correct pre-JS default for the common case where app and OS agree.
 * @param {boolean} isDark
 */
function _applyThemeColor(isDark) {
    const color = isDark ? THEME_COLOR_DARK : THEME_COLOR_LIGHT;
    document.querySelectorAll('meta[name="theme-color"]')
        .forEach(m => m.setAttribute('content', color));
}

/** Test seam for the above — the real caller is inside `initMap`, which needs a
 *  live MapLibre instance the unit suite has no reason to build. */
export const _applyThemeColorForTest = _applyThemeColor;

/**
 * Resolve the initial dark/light theme. Honors a saved preference first so the
 * rider's last choice is remembered across visits; on first visit (no saved
 * value) falls back to the OS `prefers-color-scheme`. localStorage access is
 * wrapped because Safari private mode can throw on read — that must not break
 * map init.
 * @returns {boolean} true → dark mode
 */
function _resolveInitialDark() {
    const osDefault = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    return readPersistedBoolean('darkMode', osDefault);
}

/**
 * Create and configure the MapLibre map instance. Restores dark mode from
 * localStorage, applies zoom-based initial view, adds navigation/home/locate/
 * dark-mode/layer-toggle controls, loads the ESRI rail overlay, and wires
 * vehicle marker size scaling to the zoom level.
 * @returns {maplibregl.Map}
 */
export function initMap() {
    // Restore the saved theme before map creation so the correct basemap style
    // loads on first paint (first visit falls back to the OS color scheme).
    const savedDark = _resolveInitialDark();
    if (savedDark) document.body.classList.add('dark-mode');
    _applyThemeColor(savedDark);

    const params = new URLSearchParams(window.location.search);
    const rawZoom = parseFloat(params.get('zoom'));
    // Default view fits the whole network via `bounds`, so it is centered at
    // every viewport aspect ratio. The old per-breakpoint center+zoom guess
    // was overridden on phones by the maxBounds soft-clamp recenter (see
    // config.js MAP_PAN_BOUNDS) and left the network in the bottom half of
    // the screen. A `?zoom=N` deep link keeps the fixed-center form.
    const initialView = isFinite(rawZoom)
        ? { center: [-118.25133692966446, 34.00095151499077], zoom: Math.max(8, Math.min(20, rawZoom)) }
        : { bounds: NETWORK_FIT_BOUNDS, fitBoundsOptions: { padding: FIT_PADDING } };

    const map = new maplibregl.Map({
        container: 'map',
        ...initialView,
        pitch: 0,
        bearing: 0,
        antialias: true,
        minZoom: 8,
        // Keep the camera over the LA Metro service area — the user can't pan
        // off into open ocean / the desert / another state and lose the
        // network. NOT the api.js feed box: the pan clamp needs its box
        // CENTERED on the network centroid, because MapLibre's maxBounds is a
        // soft clamp that recenters on the box center whenever the viewport
        // outgrows the box (every phone at zoom 8) — see config.js.
        maxBounds: MAP_PAN_BOUNDS,
        // Locked north-up. This is a 2D transit OVERVIEW map, not turn-by-turn
        // nav: the rail lines, legend, and rider mental model ("Westside left,
        // Downtown right") all assume north-up, and on a phone rotation/pitch
        // almost always happens by ACCIDENT (a pinch-zoom that twists). Free
        // rotation also misaligns every north-up overlay — boarding/departure
        // pills, directional arrows, the 8-cardinal boarding-slot geometry.
        // dragRotate (right-/ctrl-drag) and touchPitch (two-finger tilt) are
        // off here; the pinch-zoom-rotate handler stays on for zoom but has its
        // rotation component stripped just below.
        dragRotate: false,
        touchPitch: false,
        style: savedDark
            ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
            : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
        // Suppress the DEFAULT (non-compact) control; an explicit compact one is
        // added right after construction so we control its mode + placement.
        // Attribution itself is REQUIRED and must stay visible — see below.
        attributionControl: false,
    });

    // Keep pinch-to-zoom, drop the rotation twist that rides along with it,
    // plus the keyboard rotate shortcuts. The handler objects are constructed
    // synchronously inside the Map ctor, so they're available immediately.
    map.touchZoomRotate.disableRotation();
    map.keyboard?.disableRotation?.();

    // Zoom-only navigation control. No compass: with rotation locked there's
    // nothing to reset, so a compass button would be dead weight (and pitch
    // visualization is moot with pitch locked too).
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');

    // Visible basemap attribution is LEGALLY REQUIRED and must never be removed:
    // the CARTO Voyager / Dark Matter styles derive from OpenStreetMap, whose
    // ODbL mandates a visible "© OpenStreetMap contributors © CARTO" credit, and
    // the bounded Metro/ESRI raster overlay carries its own "© LA Metro, Esri"
    // credit (see the raster source's `attribution` field). MapLibre's
    // AttributionControl auto-collects each source's `attribution` string and
    // renders them; `compact` shows a single ⓘ that expands on tap so the credit
    // stays present but unobtrusive on phones. The constructor sets
    // attributionControl:false ONLY so this explicit compact one is the sole
    // control — do NOT read that as "attribution is optional."
    map.addControl(new maplibregl.AttributionControl({
        compact: true,
        // The unofficial-tool disclaimer lives in the attribution ⓘ popover
        // (alongside the OSM/CARTO/Esri/Metro credits) rather than as a separate
        // on-screen pill. Remove when hosted on an official LA Metro channel.
        customAttribution: 'Unofficial app',
    }), 'bottom-right');

    // Home + Locate + DarkMode in a single group so they share one border/shadow
    // and eliminate two inter-group margin gaps from the left control column.
    class CustomControls {
        onAdd(map) {
            this.map = map;
            this.container = document.createElement('div');
            this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

            const makeBtn = (cls, label, svgHtml) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `maplibregl-ctrl-icon ${cls}`;
                btn.setAttribute('aria-label', label);
                btn.innerHTML = svgHtml;
                return btn;
            };

            const HOME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><path d="M12 3l8 6v12h-5v-7H9v7H4V9l8-6z"/></svg>`;
            const LOCATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/></svg>`;
            const SUN_SVG  = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
            const MOON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

            const homeBtn = makeBtn('home-icon', 'Return to home view', HOME_SVG);
            homeBtn.addEventListener('click', () => {
                // Same network-extent fit as the initial view, so "home" means
                // "show me the whole system" on every screen shape.
                // Taking over the camera — pause any active vehicle-follow.
                document.dispatchEvent(new CustomEvent('mlm:camera-takeover'));
                map.fitBounds(NETWORK_FIT_BOUNDS, { padding: FIT_PADDING });
            });

            const locateBtn = makeBtn('locate-icon', 'Locate me', LOCATE_SVG);
            locateBtn.addEventListener('click', () => {
                document.dispatchEvent(new CustomEvent('requestAutoLocate'));
            });

            const initDark = document.body.classList.contains('dark-mode');
            const darkBtn = makeBtn('dark-mode-icon', initDark ? 'Toggle light mode' : 'Toggle dark mode', initDark ? SUN_SVG : MOON_SVG);
            darkBtn.addEventListener('click', () => {
                document.body.classList.toggle('dark-mode');
                const isDark = document.body.classList.contains('dark-mode');
                // Persist the choice so it's remembered next visit. Wrapped —
                // Safari private mode can throw on write.
                try { localStorage.setItem('darkMode', String(isDark)); } catch { /* storage blocked */ }
                _applyThemeColor(isDark);
                document.dispatchEvent(new CustomEvent('toggleDarkMode', { detail: { isDark } }));
                darkBtn.setAttribute('aria-label', isDark ? 'Toggle light mode' : 'Toggle dark mode');
                darkBtn.innerHTML = isDark ? SUN_SVG : MOON_SVG;
            });

            this.container.appendChild(homeBtn);
            this.container.appendChild(locateBtn);
            this.container.appendChild(darkBtn);
            return this.container;
        }
        onRemove() {
            this.container.parentNode.removeChild(this.container);
            this.map = undefined;
        }
    }

    map.addControl(new CustomControls(), 'top-left');

    class LayerToggleControl {
        onAdd(map) {
            this._map = map;
            this._container = document.createElement('div');
            this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

            const makeBtn = (icon, label, rowId, btnId) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                if (btnId) btn.id = btnId;
                btn.setAttribute('title', label);
                btn.setAttribute('aria-label', label);
                btn.className = 'maplibregl-ctrl-icon layer-toggle-btn';
                btn.innerHTML = icon;
                // Stateful toggle: aria-pressed mirrors layer visibility so SR
                // users hear on/off — the aria-label is identical both ways.
                // The layer-btn-off class is the single source of truth for the
                // visible state, flipped here on click AND by bikeshare.js /
                // microzones.js on init from persisted localStorage state (after
                // this control mounts). aria-pressed is derived from that class:
                // set it immediately on click for zero-latency feedback, and an
                // observer keeps it in sync with the external init-time flip.
                const syncPressed = () =>
                    btn.setAttribute('aria-pressed', String(!btn.classList.contains('layer-btn-off')));
                syncPressed();
                new MutationObserver(syncPressed)
                    .observe(btn, { attributes: true, attributeFilter: ['class'] });
                btn.addEventListener('click', () => {
                    const row = document.getElementById(rowId);
                    row?.click();
                    btn.classList.toggle('layer-btn-off', row?.classList.contains('disabled') ?? false);
                    syncPressed();
                });
                return btn;
            };

            const BIKE_SVG  = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm-3 11.5L5.5 17.5l4.8-8H15l3 5.5"/><path d="M15 6l-3 5.5"/></svg>`;
            const MICRO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="3" width="15" height="13" rx="2"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`;
            // Buttons get explicit ids so bikeshare.js / microzones.js can
            // sync the layer-btn-off class from their persisted-visibility
            // state on init (default off; toggled choice survives reloads).
            this._container.appendChild(makeBtn(BIKE_SVG,  'Metro Bike Share', 'bikeshare-legend-row',  'bikeshare-toggle-btn'));
            this._container.appendChild(makeBtn(MICRO_SVG, 'Metro Micro',      'microzones-legend-row', 'microzones-toggle-btn'));
            return this._container;
        }
        onRemove() {
            this._container.parentNode?.removeChild(this._container);
            this._map = undefined;
        }
    }

    map.addControl(new LayerToggleControl(), 'top-right');

    // ── Alerts button ───────────────────────────────────────────────────
    // Lives in its own IControl so MapLibre stacks it as a separate group
    // below LayerToggleControl — the natural inter-group gap visually
    // separates "data layers" (bike/micro) from "service info" (alerts),
    // matching the grouping convention on the left-side CustomControls.
    class AlertsControl {
        onAdd(map) {
            this._map = map;
            this._container = document.createElement('div');
            this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'alerts-control-btn';
            btn.setAttribute('title', 'Service alerts');
            btn.setAttribute('aria-label', 'Service alerts');
            btn.setAttribute('aria-haspopup', 'dialog');
            btn.setAttribute('aria-expanded', 'false');
            btn.className = 'maplibregl-ctrl-icon layer-toggle-btn alerts-toggle-btn';
            // Warning-triangle icon. Stroke-only, matches the line-art style
            // of the bike/micro icons above.
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span class="alerts-toggle-dot" aria-hidden="true"></span>`;

            // Dynamic import keeps the panel module out of the map.js boot
            // graph — alerts data still polls via initAlerts(), the panel
            // module only loads when the button is first clicked. Cheap
            // either way (one small file) but avoids a circular import
            // surface if alertsPanel.js ever needs map state.
            btn.addEventListener('click', async () => {
                try {
                    const mod = await import('./alertsPanel.js');
                    mod.toggleAlertsPanel();
                    btn.setAttribute('aria-expanded', String(mod.isAlertsPanelOpen()));
                } catch (err) {
                    console.error('[map] Failed to load alerts panel:', err);
                }
            });

            // Reflect open/close state from elsewhere (Escape key, backdrop click)
            // back onto aria-expanded so screen-reader users hear consistent state.
            // Store as instance properties so onRemove() can deregister them and
            // prevent listener accumulation on repeated style swaps (dark-mode toggle).
            this._onAlertsPanelOpened = () => btn.setAttribute('aria-expanded', 'true');
            this._onAlertsPanelClosed = () => btn.setAttribute('aria-expanded', 'false');
            document.addEventListener('alertsPanelOpened', this._onAlertsPanelOpened);
            document.addEventListener('alertsPanelClosed', this._onAlertsPanelClosed);

            // Live count indicator dot. Driven by the alertsUpdated event so
            // it stays in sync with the panel content without us re-polling.
            // Dot color tracks overall severity (severe=red, moderate=amber)
            // via the shared data-severity attribute that every alert
            // indicator across the app uses.
            const refreshDot = async () => {
                try {
                    const mod = await import('./alertsPanel.js');
                    const n   = mod.getTotalActiveAlertCount();
                    const sev = mod.getOverallSeverity();
                    btn.classList.toggle('has-alerts', n > 0);
                    btn.dataset.count = String(n);
                    const dot = btn.querySelector('.alerts-toggle-dot');
                    if (dot) {
                        if (sev) dot.dataset.severity = sev;
                        else delete dot.dataset.severity;
                    }
                    // Reflect a total alerts-feed outage in the control's
                    // accessible name (audit D2) so a silent failure isn't
                    // mistaken for "no active alerts." Only when the feed has
                    // NEVER loaded — a stale-after-success state still shows the
                    // last-known count, which is more useful than an alarm.
                    const { getAlertsFeedHealth } = await import('./alerts.js');
                    const health = getAlertsFeedHealth();
                    const unavailable = health.failing && !health.everSucceeded;
                    btn.classList.toggle('alerts-unavailable', unavailable);
                    const label = unavailable ? 'Service alerts (currently unavailable)' : 'Service alerts';
                    btn.setAttribute('aria-label', label);
                    btn.setAttribute('title', label);
                } catch (err) {
                    console.error('[map] Failed to load alerts panel:', err);
                }
            };
            this._onAlertsUpdated = refreshDot;
            document.addEventListener('alertsUpdated', this._onAlertsUpdated);
            // First evaluation runs after the initial poll resolves, but kick
            // one off after a short delay in case alerts were already cached.
            setTimeout(refreshDot, 1000);

            this._container.appendChild(btn);
            return this._container;
        }
        onRemove() {
            document.removeEventListener('alertsPanelOpened', this._onAlertsPanelOpened);
            document.removeEventListener('alertsPanelClosed', this._onAlertsPanelClosed);
            document.removeEventListener('alertsUpdated', this._onAlertsUpdated);
            this._container.parentNode?.removeChild(this._container);
            this._map = undefined;
        }
    }
    map.addControl(new AlertsControl(), 'top-right');

    /** Add imagery and custom GeoJSON layers to the map after style load. */
    function addCustomLayers() {
        // ── Metro official basemap (rail lines + interlining + station labels) ───
        // Tiled ESRI raster from Metro's ArcGIS Online org. The cache only covers
        // the LA County extent at zoom 8–20 (verified against the service tileInfo
        // and live tile probes: zoom 6–7 and 21–23 and anything outside the bounds
        // box 404). Declaring minzoom/maxzoom/bounds keeps MapLibre from ever
        // REQUESTING the out-of-range tiles — which previously 404'd by the hundreds
        // and flooded the console. (Those are logged by the browser's own network
        // stack, so bounding the requests is the only way to silence them; a
        // console override can't.) MapLibre overzooms past 20 (upscales) so deep
        // zoom still shows tiles, just blurrier — no 404, no blank.
        //
        // Added as a plain raster source: a standard Web-Mercator {z}/{y}/{x} cache
        // (ESRI tile path is /tile/{level}/{row}/{col} = {z}/{y}/{x}) needs no
        // mapbox-gl-esri-sources helper. If Metro moves the service, only this URL
        // changes — re-probe the tileInfo for the new minzoom/maxzoom/bounds.
        if (!map.getSource('imagery-source')) {
            map.addSource('imagery-source', {
                type: 'raster',
                tiles: ['https://tiles.arcgis.com/tiles/TNoJFjk1LsD45Juj/arcgis/rest/services/Map_RGB_Vector_Offset_RC5/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                minzoom: 8,
                maxzoom: 20,
                bounds: [-118.5997, 33.7242, -117.7164, 34.2524],
                attribution: '© LA Metro, Esri'
            });
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
    let pendingDark = null;   // latest theme requested while a swap is in flight
    function applyBasemapTheme(isDark) {
        isStyleChanging = true;
        pendingDark = null;
        const newStyle = isDark
            ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
            : 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json';
        map.setStyle(newStyle);
        map.once('style.load', () => {
            addCustomLayers();
            isStyleChanging = false;
            // A toggle that arrived mid-swap is DEFERRED, not dropped: applying
            // the latest requested theme keeps the basemap in sync with
            // body.dark-mode after a rapid double-toggle (otherwise the early
            // return left the chrome light while the basemap stayed dark).
            if (pendingDark !== null && pendingDark !== isDark) {
                const next = pendingDark;
                pendingDark = null;
                applyBasemapTheme(next);
            }
        });
    }
    document.addEventListener('toggleDarkMode', (e) => {
        const isDark = e.detail.isDark;
        if (isStyleChanging) { pendingDark = isDark; return; }
        applyBasemapTheme(isDark);
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
            { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS }
        );
    });
}
