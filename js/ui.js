import { routeIcons, routeHexColors, routeDirectionLabels, VIEWPORT_BREAKPOINT_TABLET } from './config.js';
import { resolveTripDestination } from './predictions.js';
import { stationGroups, openStationByGroup } from './stations.js';
import { cleanStationName, escHtml as esc, isStoppedAt, isArrivingAt } from './utils.js';
import { getFreshnessTierFromAge } from './freshness.js';

/**
 * Cleans a GTFS destination_code string for display.
 *   "El Monte Station - Downtown LA / J Line" → "El Monte"
 *   "North Hollywood Station G Line"          → "North Hollywood"
 *   "Pomona Station"                          → "Pomona"
 *   "Union Station"                           → "Union Station"  (preserved)
 */
export function cleanDestination(dest) {
    dest = String(dest ?? '');
    const d = dest.trim();
    if (/^union station$/i.test(d)) return 'Union Station';
    return d
        .replace(/\s*-\s*.*$/, '')          // strip " - Downtown LA / J Line" etc.
        .replace(/\s+[A-Z]\s+Line\b.*/i, '') // strip trailing " G Line", " J Line" etc.
        .replace(/\s*\bStation\b/i, '')      // strip remaining " Station"
        .replace(/\s*\/\s*$/, '')            // strip trailing " /"
        .trim();
}

/**
 * Pure helper for ArrowDown/ArrowUp navigation through the search-results
 * listbox. Returns the next active option index given the current index, the
 * number of options, and the arrow direction.
 *
 *  - From "nothing active" (current === -1): ArrowDown → first (0),
 *    ArrowUp → last (count-1).
 *  - Otherwise wraps around: last + ArrowDown → 0, first + ArrowUp → last.
 *
 * Extracted so the wrap-around logic is unit-testable without a DOM.
 *
 * @param {number} current  current active index, or -1 if none active
 * @param {number} count    number of options (must be > 0)
 * @param {1|-1}   dir       +1 for ArrowDown, -1 for ArrowUp
 * @returns {number} the next active index in [0, count-1], or -1 if no options
 */
export function nextActiveIndex(current, count, dir) {
    if (count <= 0) return -1;
    if (current < 0) return dir > 0 ? 0 : count - 1;
    return (current + dir + count) % count;
}

let showMini = false;
let legendRows   = []; // cached once at init — avoids repeated DOM queries in hot paths
let legendRoutes = []; // parallel array of data-route strings for updateDataPanel hot path
let _panelLastUpdated = 0;

// ── Legend filter state ────────────────────────────────────────────────────────
// null  = all routes visible (normal).
// Set   = filter mode; only routes in the Set are visible.
// First click on any row enters filter mode (that row only).
// Subsequent clicks on other rows add them to the set.
// Clicking an already-selected row removes it; empty set → exit filter mode.
let _activeFilter = null; // Set<routeCode> | null

// ── Mobile bottom-sheet drag state ────────────────────────────────────────────
let sheetDragActive   = false;
let sheetDragStartY   = 0;
let sheetDragLastY    = 0;
let sheetDragLastTime = 0;
let sheetVelocityY    = 0; // px/ms, positive = downward (dismiss direction)
const SHEET_DISMISS_RATIO    = 0.30; // drag past 30% of sheet height → dismiss
const SHEET_VELOCITY_DISMISS = 0.4;  // px/ms fast-flick threshold → always dismiss

/**
 * Wire all UI interactions: legend collapse/expand, route filter toggles, mobile
 * bottom-sheet drag gestures, search bar autocomplete, and the locate button.
 * Must be called once after DOM is ready.
 */
export function initUI() {
    showMini = isMobile(); // Mobile starts minimized; desktop starts expanded
    adjustMiniDisplay();

    const closeLegend = () => {
        // Reset drag state so stale sheetDragActive / is-dragging can't leak
        // across interactions when the X button's touchend stops propagation
        // before handle's onTouchEnd has a chance to clean up.
        sheetDragActive = false;
        document.getElementById('legend-container')?.classList.remove('is-dragging');
        showMini = true;
        adjustMiniDisplay();
    };
    document.getElementById('legend-close-btn')?.addEventListener('click', closeLegend);
    const closeBtn = document.getElementById('sheet-close-btn');
    // Stop touchstart from bubbling to the handle so it can't set sheetDragActive.
    closeBtn?.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    closeBtn?.addEventListener('click', e => { e.stopPropagation(); closeLegend(); });
    closeBtn?.addEventListener('touchend', e => { e.stopPropagation(); closeLegend(); }, { passive: true });

    document.getElementById('legend-mini')?.addEventListener('click', () => {
        showMini = false;
        adjustMiniDisplay();
    });

    window.addEventListener('resize', () => {
        sheetDragActive = false; // abort any in-flight drag on resize
        // showMini state is preserved across resize
        adjustMiniDisplay();
    });

    // Translation is handled by each browser's built-in feature (Chrome / Edge
    // / Safari menu, iOS Safari AA menu, Android Chrome menu). The previous
    // in-app translate link was removed in favour of the native flow — no JS
    // wiring is needed; alert bodies are wrapped <p lang="en"> so translators
    // can identify the source language.

    // Cache and wire up legend rows (filtering + a11y)
    //
    // _applyRowVisible: single DOM write — body class, row class, aria-checked.
    // Filter mode is session-only (not persisted); each load starts with all routes visible.
    const _applyRowVisible = (row, route, visible) => {
        document.body.classList.toggle(`hide-route-${route}`, !visible);
        row.classList.toggle('disabled', !visible);
        row.setAttribute('aria-checked', visible ? 'true' : 'false');
    };

    // Show all routes and exit filter mode (shared by Show All button and empty-selection path).
    const _showAll = () => {
        _activeFilter = null;
        legendRows.forEach((r, i) => { if (legendRoutes[i]) _applyRowVisible(r, legendRoutes[i], true); });
        updateFilterButtons();
    };

    legendRows = Array.from(document.querySelectorAll('.legend-row'));
    legendRoutes = legendRows.map(r => r.getAttribute('data-route') || '');
    legendRows.forEach(row => {
        const route = row.getAttribute('data-route');
        if (!route) return;

        // A11y
        row.setAttribute('tabindex', '0');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', 'true');
        const imgAlt = row.querySelector('img')?.alt || `Route ${route}`;
        row.setAttribute('aria-label', imgAlt.replace(/ icon$/i, ''));
        row.style.cursor = 'pointer';

        const toggleRow = () => {
            if (_activeFilter === null) {
                // Enter filter mode — show only this route, dim all others.
                _activeFilter = new Set([route]);
                legendRows.forEach((r, i) => {
                    const rc = legendRoutes[i];
                    if (rc) _applyRowVisible(r, rc, rc === route);
                });
            } else if (_activeFilter.has(route)) {
                // Deselect — remove from filter.
                _activeFilter.delete(route);
                _applyRowVisible(row, route, false);
                if (_activeFilter.size === 0) {
                    // Nothing left selected → exit filter mode.
                    _showAll();
                    return; // updateFilterButtons already called inside _showAll
                }
            } else {
                // Add to filter.
                _activeFilter.add(route);
                _applyRowVisible(row, route, true);
            }
            updateFilterButtons();
        };

        row.addEventListener('click', toggleRow);
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(); }
        });
    });

    // Mobile swipe-to-dismiss bottom sheet
    initSwipeSheet();

    // Station Search
    const searchInput = document.getElementById('station-search');
    const searchResults = document.getElementById('search-results');
    const searchClearBtn = document.getElementById('search-clear-btn');
    if (searchInput && searchResults) {
        // a11y: mark the results container as a listbox
        searchResults.setAttribute('role', 'listbox');
        searchInput.setAttribute('aria-autocomplete', 'list');
        searchInput.setAttribute('aria-haspopup', 'listbox');

        // Single show/hide path so the combobox's aria-expanded stays in sync
        // with the .hidden class at every call site (was never toggled before,
        // leaving screen-reader users with a permanently-collapsed combobox).
        // Collapsing also clears the active-descendant so a stale id can't point
        // at a removed option.
        const setResultsVisible = (visible) => {
            searchResults.classList.toggle('hidden', !visible);
            searchInput.setAttribute('aria-expanded', String(visible));
            if (!visible) clearActiveOption();
        };

        // ── Active-descendant management ─────────────────────────────────────
        // The WAI-ARIA combobox pattern keeps DOM focus on the INPUT and points
        // aria-activedescendant at the active option's id (rather than roving
        // real focus into the listbox). This lets the user keep typing to refine
        // the query while an option is highlighted, and avoids focus escaping the
        // input as options are re-rendered on each keystroke.
        const optionId = (i) => `search-opt-${i}`;

        const clearActiveOption = () => {
            searchInput.removeAttribute('aria-activedescendant');
            searchResults
                .querySelectorAll('[role="option"].active')
                .forEach((el) => {
                    el.classList.remove('active');
                    el.setAttribute('aria-selected', 'false');
                });
        };

        // Highlight the option at `idx` (or clear when idx < 0), update
        // aria-activedescendant, and scroll it into view.
        const setActiveOption = (idx) => {
            const options = [...searchResults.querySelectorAll('[role="option"]')];
            clearActiveOption();
            if (idx < 0 || idx >= options.length) return;
            const opt = options[idx];
            opt.classList.add('active');
            opt.setAttribute('aria-selected', 'true');
            searchInput.setAttribute('aria-activedescendant', opt.id);
            opt.scrollIntoView({ block: 'nearest' });
        };

        // Keyboard navigation for search results
        searchInput.addEventListener('keydown', (e) => {
            const options = [...searchResults.querySelectorAll('[role="option"]')];
            if (e.key === 'Escape') {
                setResultsVisible(false);
                return;
            }
            if (!options.length) return;
            const active = searchResults.querySelector('[role="option"].active');
            const currentIdx = active ? options.indexOf(active) : -1;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveOption(nextActiveIndex(currentIdx, options.length, 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveOption(nextActiveIndex(currentIdx, options.length, -1));
            } else if (e.key === 'Enter' && active) {
                e.preventDefault();
                active.click();
            }
        });

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (!query) {
                searchResults.innerHTML = '';
                setResultsVisible(false);
                if (searchClearBtn) searchClearBtn.style.display = 'none';
                return;
            }

            if (searchClearBtn) searchClearBtn.style.display = 'block';

            const allMatches = stationGroups
                .filter(g => g.displayName.toLowerCase().includes(query));
            const matches = allMatches.slice(0, 5);
            const overflow = allMatches.length - matches.length;

            if (matches.length > 0) {
                const hint = overflow > 0
                    ? `<div class="search-more-hint">and ${overflow} more — keep typing to narrow</div>`
                    : '';
                searchResults.innerHTML = matches
                    .map((g, i) => `<div id="${optionId(i)}" role="option" aria-selected="false" data-id="${g.normName.replace(/"/g, '&quot;')}">${esc(g.displayName)}</div>`)
                    .join('') + hint;
                // New result set → drop any stale active-descendant pointer.
                clearActiveOption();
                setResultsVisible(true);
            } else {
                searchResults.innerHTML = '<div class="search-no-results">No stations found</div>';
                clearActiveOption();
                setResultsVisible(true);
            }
        });

        searchResults.addEventListener('click', (e) => {
            const div = e.target.closest('div');
            if (!div) return;
            const normName = div.getAttribute('data-id');
            const group = stationGroups.find(g => g.normName === normName);
            if (group) {
                const map = window.map;
                if (map) {
                    map.flyTo({ center: [group.lon, group.lat], zoom: 14 });
                    openStationByGroup(map, group);
                }
                searchInput.value = group.displayName;
                searchResults.innerHTML = '';
                setResultsVisible(false);
            }
        });

        // Close search on click outside
        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !searchResults.contains(e.target) && (!searchClearBtn || !searchClearBtn.contains(e.target))) {
                setResultsVisible(false);
            }
        });

        // Clear button
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', () => {
                searchInput.value = '';
                searchResults.innerHTML = '';
                setResultsVisible(false);
                searchClearBtn.style.display = 'none';
                searchInput.focus();
            });
        }
    }
}

function updateFilterButtons() {
    // Show All and Hide All buttons removed — filter state tracked via _activeFilter only.
}

// Returns true for any viewport that uses the bottom-sheet layout.
// Must match the @media (max-width: 1280px) breakpoint in index-style.css
// where #legend-mini is hidden and the sheet peek/drag UI takes over.
function isMobile() {
    return window.innerWidth <= VIEWPORT_BREAKPOINT_TABLET;
}

function adjustMiniDisplay() {
    const container = document.getElementById('legend-container');
    const mini = document.getElementById('legend-mini');
    if (!container || !mini) return;
    // Clear any live-drag inline style so CSS transitions take over cleanly
    container.style.transform = '';
    container.classList.remove('is-dragging');
    container.classList.toggle('hidden', showMini);
    mini.classList.toggle('hidden', !showMini);
    // Lift the map attribution ⓘ above the open sheet so the required
    // "© LA Metro, Esri" credit (a tile-license obligation — see js/map.js) is
    // never covered. `--sheet-lift` feeds the bottom-right control's `bottom`
    // in the ≤1280px media query; when peeked or on desktop we remove it so the
    // rule falls back to the 44px peek-handle height.
    if (!showMini && isMobile()) {
        document.documentElement.style.setProperty('--sheet-lift', `${container.offsetHeight + 8}px`);
    } else {
        document.documentElement.style.removeProperty('--sheet-lift');
    }
}

/**
 * Mobile swipe-to-dismiss bottom sheet.
 * Drag handle always participates. Content area only when scrolled to top.
 * Velocity-aware snap: fast flick OR drag > 30% height → dismiss.
 */
let _swipeInitialized = false;
function initSwipeSheet() {
    // Idempotence guard: each call attaches three touch listeners on the legend
    // content area (touchstart/touchmove/touchend). Without this gate, a second
    // call (dev hot-reload, future SPA re-route) would accumulate duplicate
    // listeners — a single touch event would then fire the handlers N times.
    if (_swipeInitialized) return;
    const container = document.getElementById('legend-container');
    const handle    = document.getElementById('sheet-handle');
    const legend    = document.getElementById('legend');
    if (!container || !handle || !legend) return;
    _swipeInitialized = true;

    function onTouchStart(e) {
        if (!isMobile()) return;
        const isHandle = handle.contains(e.target);
        // On the scrollable content: only engage drag when content is at top
        if (!isHandle && legend.scrollTop > 0) return;

        sheetDragActive   = true;
        sheetDragStartY   = e.touches[0].clientY;
        sheetDragLastY    = sheetDragStartY;
        sheetDragLastTime = Date.now();
        sheetVelocityY    = 0;
        container.classList.add('is-dragging');
    }

    function onTouchMove(e) {
        if (!isMobile() || !sheetDragActive) return;
        const y   = e.touches[0].clientY;
        const now = Date.now();
        const dt  = now - sheetDragLastTime;
        if (dt > 0) sheetVelocityY = (y - sheetDragLastY) / dt;
        sheetDragLastY    = y;
        sheetDragLastTime = now;

        const delta = Math.max(0, y - sheetDragStartY); // downward only
        if (delta > 10) e.preventDefault();             // dead-zone: don't suppress click on micro-movement
        container.style.transform = `translateY(${delta}px)`;
    }

    function onTouchEnd() {
        if (!isMobile() || !sheetDragActive) return;
        sheetDragActive = false;
        container.classList.remove('is-dragging');

        const delta  = sheetDragLastY - sheetDragStartY;
        const thresh = container.offsetHeight * SHEET_DISMISS_RATIO;
        const isTap  = Math.abs(delta) < 10; // < 10px movement = treat as tap, not drag

        if (sheetVelocityY > SHEET_VELOCITY_DISMISS || delta > thresh) {
            // Dismiss: let CSS hidden class slide it out
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else if (isTap && showMini) {
            // Tap on peek handle → open sheet. Handle in touchend rather than
            // click so it fires reliably even when touchmove suppressed the click.
            container.style.transform = '';
            showMini = false;
            adjustMiniDisplay();
        } else if (isTap && !showMini) {
            // Tap on handle while sheet is open → close back to mini.
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else {
            // Snap back: clear inline transform, force reflow to re-enable transition
            container.style.transform = '';
            void container.offsetHeight; // trigger reflow → CSS transition fires
        }
    }

    // Content-area variant: never closes on tap (tapping a legend row should not
    // dismiss the sheet). Only drag-to-dismiss applies here.
    function onContentTouchEnd() {
        if (!isMobile() || !sheetDragActive) return;
        sheetDragActive = false;
        container.classList.remove('is-dragging');

        const delta  = sheetDragLastY - sheetDragStartY;
        const thresh = container.offsetHeight * SHEET_DISMISS_RATIO;

        if (sheetVelocityY > SHEET_VELOCITY_DISMISS || delta > thresh) {
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else {
            // Snap back — do NOT treat as a tap-to-close
            container.style.transform = '';
            void container.offsetHeight;
        }
    }

    function onTouchCancel() {
        sheetDragActive = false;
        container.classList.remove('is-dragging');
        container.style.transform = '';
    }

    // Desktop fallback: open on click (touch devices use onTouchEnd isTap path above)
    handle.addEventListener('click', () => {
        if (!('ontouchstart' in window) && isMobile() && showMini) { showMini = false; adjustMiniDisplay(); }
    });

    // Handle: always drag-able
    handle.addEventListener('touchstart',  onTouchStart,  { passive: true  });
    handle.addEventListener('touchmove',   onTouchMove,   { passive: false });
    handle.addEventListener('touchend',    onTouchEnd,    { passive: true  });
    handle.addEventListener('touchcancel', onTouchCancel, { passive: true  });

    // Content area: drag only when scrolled to top; tapping a row must NOT close the sheet.
    legend.addEventListener('touchstart',  onTouchStart,      { passive: true  });
    legend.addEventListener('touchmove',   onTouchMove,       { passive: false });
    legend.addEventListener('touchend',    onContentTouchEnd, { passive: true  });
    legend.addEventListener('touchcancel', onTouchCancel,     { passive: true  });
}

// Resolves the first time removeLoadingScreen() runs (WS connected, or the
// 15 s global fallback in api.js). Consumers that must not act until the
// loading splash is gone — e.g. the startup auto-locate station popup, which
// would otherwise render over the loader — await this. Resolves immediately
// for any consumer that imports it after the screen is already removed.
let _loadingDoneResolve;
export const loadingDone = new Promise(resolve => { _loadingDoneResolve = resolve; });

/**
 * Fade out and remove the loading overlay. Safe to call multiple times — removes
 * the element from the DOM after the CSS fade-out transition completes.
 */
export function removeLoadingScreen() {
    const loadingScreen = document.getElementById('loading');
    if (loadingScreen) {
        loadingScreen.classList.add('fade-out');
        setTimeout(() => loadingScreen.remove(), 500);
    }
    // Signal any awaiters (idempotent — the resolve is a no-op after the first).
    _loadingDoneResolve?.();
    _loadingDoneResolve = null;
}

/**
 * Display a transient toast notification at the bottom of the viewport.
 * Styling lives in the `.toast` rule in styles/index-style.css (and inherits
 * dark-mode automatically). Auto-dismisses after `duration` ms (default 4 s).
 *
 * @param {string} message            Text to display
 * @param {Object} [opts]
 * @param {'info'|'error'} [opts.severity='info']  'error' uses dark high-contrast variant
 * @param {number}         [opts.duration=4000]    Visible duration before fade-out (ms)
 */
export function showToast(message, { severity = 'info', duration = 4000 } = {}) {
    // Single-toast policy: replace any existing one so rapid calls don't stack.
    document.getElementById('toast-notice')?.remove();
    const toast = document.createElement('div');
    toast.id = 'toast-notice';
    toast.className = severity === 'error' ? 'toast toast--error' : 'toast';
    toast.setAttribute('role', severity === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, duration);
    setTimeout(() => toast.remove(), duration + 500);
}

/**
 * Refresh the legend data panel (vehicle counts per route, average age).
 * Throttled to at most once per second to avoid excessive DOM updates on
 * rapid WebSocket bursts.
 * @param {Object} markers Live vehicle markers object from markers.js
 */
export function updateDataPanel(markers) {
    const _now = Date.now();
    if (_now - _panelLastUpdated < 1000) return;
    _panelLastUpdated = _now;

    const counts = {};
    const speeds = {};
    let total = 0;
    let totalSpeed = 0;

    for (const id in markers) {
        const route = markers[id].route_code;
        const speedMpS = markers[id].properties?.speed || 0;
        counts[route] = (counts[route] || 0) + 1;
        speeds[route] = (speeds[route] || 0) + speedMpS;
        total++;
        totalSpeed += speedMpS;
    }

    for (const id of ['total-count-badge', 'total-count-badge-mobile']) {
        const totalEl = document.getElementById(id);
        if (!totalEl) continue;
        const prevCount = totalEl.textContent;
        totalEl.textContent = total;
        if (prevCount !== String(total)) {
            totalEl.classList.remove('pulse');
            void totalEl.offsetWidth;
            totalEl.classList.add('pulse');
        }
    }

    // Compute max count for proportional bar widths
    const maxCount = Math.max(1, ...legendRoutes.map(r => counts[r] || 0));

    legendRows.forEach((row, i) => {
        const route = legendRoutes[i];
        const count = counts[route] || 0;
        const speedSum = speeds[route] || 0;

        const countBadge = row.querySelector('.count-badge');
        if (countBadge) countBadge.textContent = count > 0 ? count : '';

        const barFill = row.querySelector('.bar-fill');
        if (barFill) barFill.style.width = `${Math.round((count / maxCount) * 100)}%`;

        row.classList.toggle('collapsed', count === 0 && !row.dataset.persistent);
    });

}

/** Update the "Updated at HH:MM:SS" timestamp displayed in the legend footer. */
export function updateUpdateTime() {
    const updateTimeDiv = document.getElementById('update-time');
    if (updateTimeDiv) {
        // Fixed en-US locale — page text is English, browser translators
        // handle conversion to the rider's language at render time. Seconds
        // are shown so a rider can tell at a glance how recently the feed
        // ticked (a frozen clock = a stalled feed).
        const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        updateTimeDiv.textContent = `Updated at ${time}`;
    }
}

/**
 * Update the connection status dot and label in the legend.
 * @param {'connected'|'connecting'|'error'|'offline'} status
 */
export function setConnectionStatus(status) {
    const dot = document.getElementById('connection-status-dot');
    const label = document.getElementById('update-time');
    if (!dot) return;
    dot.classList.remove('connected', 'disconnected');
    switch (status) {
        case 'connected':
            dot.classList.add('connected');
            dot.title = 'Live feed connected';
            break;
        case 'connecting':
            dot.title = 'Connecting';
            if (label && label.textContent === '') label.textContent = 'Connecting...';
            break;
        case 'error':
        case 'offline':
            dot.classList.add('disconnected');
            dot.title = 'Live feed disconnected';
            if (label) label.textContent = 'Reconnecting...';
            break;
    }
}

/**
 * Build the inner HTML for a vehicle marker popup.
 *
 * Single options object (was a 12-positional-arg signature — #250). Add a new
 * field as an opts key rather than threading another positional through every
 * call site.
 *
 * @param {Object} opts
 * @param {string} opts.routeCode          e.g. "801"
 * @param {string|number} opts.vehicleId   Feed vehicle ID
 * @param {string} opts.vehicleLabel       Display prefix ("Train ", "Bus ", etc.)
 * @param {number} opts.timestamp          Unix seconds of last GPS fix
 * @param {string|number|null} opts.stopId Current/next stop ID
 * @param {number|string|null} opts.currentStatus GTFS-RT currentStatus
 * @param {number|null} opts.directionId   0 or 1
 * @param {string|null} opts.tripId        GTFS trip ID
 * @param {number|null} opts.currentStopSequence
 * @param {number|null} [opts.secToNextStop] Pre-computed seconds to next stop
 * @param {number|null} [opts.boardingDepSecs] Seconds until boarding departure (origin only)
 * @param {string|null} [opts.etaSource] Debug: which tier produced the ETA
 *   ('gtfs-rt' | 'calc' | 'stopped' | 'none'). Rendered only when the
 *   `mlm_debug_eta` localStorage flag is set.
 * @returns {string} HTML string
 */
export function getPopupHTML({
    routeCode, vehicleId, vehicleLabel, timestamp, stopId, currentStatus,
    directionId, tripId, currentStopSequence,
    secToNextStop = null, boardingDepSecs = null, etaSource = null,
} = {}) {
    const stopKey  = stopId != null ? String(stopId) : null;
    const stopInfo = stopKey && window.masterStopsData?.[stopKey];
    const stopName = stopInfo ? cleanStationName(stopInfo.name) : null;

    const statusLabel = boardingDepSecs !== null ? 'Boarding'
        : isStoppedAt(currentStatus) ? 'At stop'
        : isArrivingAt(currentStatus) ? 'Arriving'
        : 'Next stop';

    // Trip data
    const tripInfo   = tripId ? window.masterTripsData?.[String(tripId)] : null;

    // Shared cascade with the station-popup row labels — see
    // predictions.resolveTripDestination. Schedule-derived terminus first
    // (authoritative), then live trip.dest, then last-stop, then live-feed
    // fallback. Previously this cascade was reimplemented inline with the
    // structural step LAST, which produced different labels than the station
    // popup for the same trip.
    const cleanedDest = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
    const destination = directionId != null
        ? resolveTripDestination(routeCode, Number(directionId), tripId, tripInfo, cleanedDest)
        : cleanedDest;

    // Route accent color
    const accentColor = routeHexColors[routeCode] ?? '#888';
    const iconSrc     = routeIcons[routeCode] || '';

    // Cardinal direction letter (N/S/E/W) from the static direction-label table.
    // Shown as a subtle suffix on the destination header so riders can quickly
    // orient the vehicle relative to the line map.
    const dirLabel = directionId != null ? routeDirectionLabels[routeCode]?.[directionId] : null;
    const cardinalLetter = dirLabel ? dirLabel.charAt(0) : null;
    const cardinalHTML = cardinalLetter ? ` <span class="pv2-cardinal" aria-hidden="true">\u00b7 ${esc(cardinalLetter)}</span>` : '';

    const lastTrainBadge = tripInfo?.isLast ? `<span class="last-train-badge veh-last-train">Last Train</span>` : '';
    const destHTML = destination
        ? `<div class="pv2-dest"><span aria-hidden="true">\u2192</span> ${esc(destination)}${cardinalHTML}${lastTrainBadge}</div>`
        : lastTrainBadge
            ? `<div class="pv2-dest">${lastTrainBadge}</div>`
            : '';

    // Next stop / boarding section
    let etaStr = null;
    let etaIsNow = false;
    if (boardingDepSecs !== null) {
        // "<1m" not "30s": same sub-minute vocabulary as the next-stop pill and
        // stations.js, so no ETA surface shows the "30s" token (misreadable as
        // "30 minutes"). Under 30s the pill is suppressed — the "Boarding" status
        // label carries it and a sub-30s departure countdown is too jittery.
        etaStr = boardingDepSecs < 30 ? null
               : boardingDepSecs < 60 ? 'Departs <1m'
               : `Departs ${Math.floor(boardingDepSecs / 60)}m`;
    } else if (secToNextStop != null) {
        // "Now" is reserved for a vehicle actually AT the stop (STOPPED_AT). An
        // in-transit vehicle — even a few seconds out — reads "<1m" so the
        // sub-minute state always shows on approach. Previously "Now" owned
        // everything under 30s, so when the ETA leaped from >=60s straight into
        // that band — a trip_updates re-broadcast, a calc/GTFS source swap, or
        // the IN_TRANSIT_TO -> STOPPED_AT flip — the popup jumped "1m" -> "Now"
        // and the rider never saw "<1m". Gating "Now" on STOPPED_AT makes every
        // approach pass through "<1m" first. ("<1m" over "30s" also rules out
        // the "30s"/"30m" misread; matches stations.js _formatArrivalPill so
        // every ETA surface shares one vocabulary.)
        if (isStoppedAt(currentStatus)) {
            etaStr = 'Now';
            etaIsNow = true;
        } else if (secToNextStop < 60) {
            etaStr = '<1m';
        } else {
            // The "m" suffix is universal (Spanish riders see "5m" as fine).
            etaStr = Math.floor(secToNextStop / 60) + 'm';
        }
    }
    // Debug-only ETA-source tag. Toggle from the console:
    //   localStorage.mlm_debug_eta = '1'   (then reopen the popup)
    //   delete localStorage.mlm_debug_eta  (to hide again)
    // Shows whether the ETA came from GTFS-RT trip_updates ([RT]) or the
    // schedule/distance calc fallback ([calc]) — answers "the train is right
    // there but says 3m: bad feed prediction, or a real queued wait?".
    let etaDebugHTML = '';
    try {
        if (etaSource && typeof localStorage !== 'undefined' && localStorage.getItem('mlm_debug_eta') === '1') {
            const tagLabel = etaSource === 'gtfs-rt' ? 'RT' : etaSource;
            etaDebugHTML = `<span class="pv2-eta-src" data-src="${esc(etaSource)}">[${esc(tagLabel)}]</span>`;
        }
    } catch { /* localStorage blocked (private mode) — no debug tag, no crash */ }

    const stopSection = stopName ? `
        <div class="pv2-section">
            <div class="pv2-label">${esc(statusLabel)}</div>
            <div class="pv2-stop-row">
                <span class="pv2-stop">${esc(stopName)}</span>
                ${etaStr ? `<span class="arr-time-pill${etaIsNow ? ' now' : ''}">${esc(etaStr)}</span>` : ''}
                ${etaDebugHTML}
            </div>
        </div>` : '';

    // Footer: seconds since last update (color-coded dot) · vehicle id
    const secsSince = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    const vehicleHTML = `${esc(vehicleLabel)}${esc(String(vehicleId))}`;
    // Single-escaped form for the title attribute. esc()-ing vehicleHTML (already
    // escaped) would double-escape — "&" would render as "&amp;amp;" in the tooltip.
    const vehicleTitle = esc(`${vehicleLabel}${String(vehicleId)}`);
    const tier = getFreshnessTierFromAge(secsSince);
    // Tier labels for the freshness dot's ARIA name — the dot itself is
    // color-only, so without these labels a screen-reader user has no signal
    // about data freshness. Phrasing matches the popup's overall vocabulary.
    const tierAria = tier === 'live'  ? 'Data fresh'
                   : tier === 'stale' ? 'Data stale'
                   :                    'Data expired';

    return `
    <div class="pv2-card">
        <div class="pv2-accent" style="background:${accentColor}"></div>
        <div class="pv2-header">
            <img class="pv2-icon" src="${esc(iconSrc)}" alt="route">
            <div class="pv2-header-text">
                ${destHTML}
            </div>
        </div>
        ${stopSection}
        <div class="pv2-footer">
            <span class="pv2-time" data-ts="${timestamp}"><span class="pv2-dot" data-tier="${tier}" role="img" aria-label="${tierAria}"></span><span class="pv2-secs">${secsSince}s</span></span>
            <span class="pv2-vehicle" title="${vehicleTitle}">${vehicleHTML}</span>
        </div>
    </div>`;
}
