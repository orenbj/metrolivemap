import { routeIcons, routeHexColors } from './config.js';
import { getTerminalName } from './predictions.js';
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

    // Show All button — exits filter mode and restores all routes.
    const showAllBtn = document.getElementById('show-all-btn');
    if (showAllBtn) {
        showAllBtn.addEventListener('click', _showAll);
    }

    // Hide All button — not part of the filter-mode paradigm; keep hidden.
    const hideAllBtn = document.getElementById('hide-all-btn');
    if (hideAllBtn) {
        hideAllBtn.style.display = 'none';
    }

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

        // Keyboard navigation for search results
        searchInput.addEventListener('keydown', (e) => {
            const options = [...searchResults.querySelectorAll('[role="option"]')];
            if (!options.length) return;
            const focused = searchResults.querySelector('[aria-selected="true"]');
            const currentIdx = focused ? options.indexOf(focused) : -1;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const nextIdx = (currentIdx + 1) % options.length;
                if (focused) focused.setAttribute('aria-selected', 'false');
                options[nextIdx].setAttribute('aria-selected', 'true');
                options[nextIdx].focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prevIdx = (currentIdx - 1 + options.length) % options.length;
                if (focused) focused.setAttribute('aria-selected', 'false');
                options[prevIdx].setAttribute('aria-selected', 'true');
                options[prevIdx].focus();
            } else if (e.key === 'Enter' && focused) {
                e.preventDefault();
                focused.click();
            } else if (e.key === 'Escape') {
                searchResults.classList.add('hidden');
            }
        });

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (!query) {
                searchResults.innerHTML = '';
                searchResults.classList.add('hidden');
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
                    .map(g => `<div role="option" aria-selected="false" tabindex="-1" data-id="${g.normName.replace(/"/g, '&quot;')}">${esc(g.displayName)}</div>`)
                    .join('') + hint;
                searchResults.classList.remove('hidden');
            } else {
                searchResults.innerHTML = '<div class="search-no-results">No stations found</div>';
                searchResults.classList.remove('hidden');
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
                searchResults.classList.add('hidden');
            }
        });

        // Close search on click outside
        document.addEventListener('click', (e) => {
            if (!searchInput.contains(e.target) && !searchResults.contains(e.target) && (!searchClearBtn || !searchClearBtn.contains(e.target))) {
                searchResults.classList.add('hidden');
            }
        });

        // Clear button
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', () => {
                searchInput.value = '';
                searchResults.innerHTML = '';
                searchResults.classList.add('hidden');
                searchClearBtn.style.display = 'none';
                searchInput.focus();
            });
        }
    }
}

function updateFilterButtons() {
    const showAllBtn = document.getElementById('show-all-btn');
    if (showAllBtn) showAllBtn.style.display = _activeFilter !== null ? 'block' : 'none';
    // Hide All is not used with the filter-mode paradigm — keep it hidden.
    const hideAllBtn = document.getElementById('hide-all-btn');
    if (hideAllBtn) hideAllBtn.style.display = 'none';
}

// Returns true for any viewport that uses the bottom-sheet layout.
// Must match the @media (max-width: 1280px) breakpoint in index-style.css
// where #legend-mini is hidden and the sheet peek/drag UI takes over.
function isMobile() {
    return window.innerWidth <= 1280;
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
}

/**
 * Mobile swipe-to-dismiss bottom sheet.
 * Drag handle always participates. Content area only when scrolled to top.
 * Velocity-aware snap: fast flick OR drag > 30% height → dismiss.
 */
function initSwipeSheet() {
    const container = document.getElementById('legend-container');
    const handle    = document.getElementById('sheet-handle');
    const legend    = document.getElementById('legend');
    if (!container || !handle || !legend) return;

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
        updateTimeDiv.textContent = `Updated at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
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
            dot.title = 'Connecting...';
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
 * @param {string} routeCode          e.g. "801"
 * @param {string|number} vehicleId   Feed vehicle ID
 * @param {string} vehicleLabel       Display prefix ("Train ", "Bus ", etc.)
 * @param {number} timestamp          Unix seconds of last GPS fix
 * @param {string|number|null} stopId Current/next stop ID
 * @param {number|string|null} currentStatus GTFS-RT currentStatus
 * @param {number|null} directionId   0 or 1
 * @param {string|null} tripId        GTFS trip ID
 * @param {number|null} currentStopSequence
 * @param {string} [agency='metro']
 * @param {number|null} [secToNextStop] Pre-computed seconds to next stop
 * @param {number|null} [boardingDepSecs] Seconds until boarding departure (origin only)
 * @returns {string} HTML string
 */
export function getPopupHTML(routeCode, vehicleId, vehicleLabel, timestamp, stopId, currentStatus, directionId, tripId, currentStopSequence, agency = 'metro', secToNextStop = null, boardingDepSecs = null) {
    const stopKey  = stopId != null ? String(stopId) : null;
    const stopInfo = stopKey && window.masterStopsData?.[stopKey];
    const stopName = stopInfo ? cleanStationName(stopInfo.name) : null;

    const statusLabel = boardingDepSecs !== null ? 'Boarding'
        : isStoppedAt(currentStatus) ? 'At stop'
        : isArrivingAt(currentStatus) ? 'Arriving'
        : 'Next stop';

    // Trip data
    const tripInfo   = tripId ? window.masterTripsData?.[String(tripId)] : null;
    const totalStops = tripInfo?.total ?? null;

    // Resolve terminal station: explicit dest → last stop lookup → direction label fallback
    let destination = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
    if (!destination && tripInfo?.stops) {
        const lastStopId = [...tripInfo.stops].reverse().find(s => s);
        const lastStopInfo = lastStopId ? window.masterStopsData?.[String(lastStopId)] : null;
        if (lastStopInfo?.name) destination = cleanStationName(lastStopInfo.name);
    }
    if (!destination && directionId != null)
        destination = getTerminalName(routeCode, Number(directionId));

    // Route accent color
    const accentColor = routeHexColors[routeCode] ?? '#888';
    const iconSrc     = routeIcons[routeCode] || '';

    // Destination header \u2014 always arrow + terminal station, no cardinal direction
    const lastTrainBadge = tripInfo?.isLast ? `<span class="last-train-badge veh-last-train">Last Train</span>` : '';
    const destHTML = destination
        ? `<div class="pv2-dest">\u2192 ${esc(destination)}${lastTrainBadge}</div>`
        : lastTrainBadge
            ? `<div class="pv2-dest">${lastTrainBadge}</div>`
            : '';

    // Next stop / boarding section
    let etaStr = null;
    if (boardingDepSecs !== null) {
        etaStr = boardingDepSecs <= 30 ? null : `Departs ${Math.max(1, Math.round(boardingDepSecs / 60))}m`;
    } else if (secToNextStop != null) {
        etaStr = secToNextStop <= 30 ? 'Now' : Math.max(1, Math.round(secToNextStop / 60)) + 'm';
    }
    const stopSection = stopName ? `
        <div class="pv2-section">
            <div class="pv2-label">${esc(statusLabel)}</div>
            <div class="pv2-stop-row">
                <span class="pv2-stop">${esc(stopName)}</span>
                ${etaStr ? `<span class="arr-time-pill${etaStr === 'Now' ? ' now' : ''}">${esc(etaStr)}</span>` : ''}
            </div>
        </div>` : '';

    // Progress bar
    const pct = (currentStopSequence && totalStops)
        ? Math.min(100, Math.round((currentStopSequence / totalStops) * 100)) : null;
    const progressHTML = pct !== null ? `
        <div class="pv2-progress-track">
            <div class="pv2-progress-fill" style="width:${pct}%;background:${accentColor}"></div>
        </div>` : '';

    // Footer: seconds since last update (green dot) · vehicle id
    const secsSince = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    const vehicleHTML = `${esc(vehicleLabel)}${esc(String(vehicleId))}`;

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
        ${progressHTML}
        <div class="pv2-footer">
            <span class="pv2-time" data-ts="${timestamp}"><span class="pv2-dot" data-tier="${getFreshnessTierFromAge(secsSince)}"></span><span class="pv2-secs">${secsSince}s</span></span>
            <span class="pv2-vehicle" title="${esc(vehicleHTML)}">${vehicleHTML}</span>
        </div>
    </div>`;
}
