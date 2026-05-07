import { routeIcons, routeHexColors, STALE_FADE_START_SEC } from './config.js';
import { getTerminalName } from './predictions.js';
import { stationGroups, openStationByGroup } from './stations.js';
import { cleanStationName, escHtml as esc, isStoppedAt, isArrivingAt } from './utils.js';

/**
 * Cleans a GTFS destination_code string for display.
 *   "El Monte Station - Downtown LA / J Line" → "El Monte"
 *   "North Hollywood Station G Line"          → "North Hollywood"
 *   "Pomona Station"                          → "Pomona"
 *   "Union Station"                           → "Union Station"  (preserved)
 */
export function cleanDestination(dest) {
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
    showMini = false; // Start with Legend expanded
    adjustMiniDisplay();

    const closeLegend = () => { showMini = true; adjustMiniDisplay(); };
    document.getElementById('legend-close-btn')?.addEventListener('click', closeLegend);
    const closeBtn = document.getElementById('sheet-close-btn');
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
    const setLegendRowVisible = (row, route, visible) => {
        document.body.classList.toggle(`hide-route-${route}`, !visible);
        row.classList.toggle('disabled', !visible);
        row.setAttribute('aria-checked', visible ? 'true' : 'false');
        // Persist filter state
        try {
            const disabled = JSON.parse(localStorage.getItem('disabledRoutes') || '[]');
            const idx = disabled.indexOf(route);
            if (!visible && idx === -1) disabled.push(route);
            else if (visible && idx !== -1) disabled.splice(idx, 1);
            localStorage.setItem('disabledRoutes', JSON.stringify(disabled));
        } catch { /* ignore storage errors */ }
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

        const soloRow = () => {
            // Check if this row is currently the ONLY one visible
            const isSolo = !row.classList.contains('disabled') &&
                          legendRows.every(r => r === row || r.classList.contains('disabled'));
            legendRows.forEach((r, i) => setLegendRowVisible(r, legendRoutes[i], isSolo || r === row));
            updateFilterButtons();
        };

        row.addEventListener('click', soloRow);
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); soloRow(); }
        });
    });

    // Restore filter state from previous session
    try {
        const disabled = JSON.parse(localStorage.getItem('disabledRoutes') || '[]');
        if (disabled.length) {
            legendRows.forEach((row, i) => {
                const route = legendRoutes[i];
                if (route && disabled.includes(route)) setLegendRowVisible(row, route, false);
            });
        }
    } catch { /* ignore storage errors */ }

    // Show All button
    const showAllBtn = document.getElementById('show-all-btn');
    if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
            legendRows.forEach((row, i) => { if (legendRoutes[i]) setLegendRowVisible(row, legendRoutes[i], true); });
            updateFilterButtons();
        });
    }

    // Hide All button
    const hideAllBtn = document.getElementById('hide-all-btn');
    if (hideAllBtn) {
        hideAllBtn.addEventListener('click', () => {
            legendRows.forEach((row, i) => { if (legendRoutes[i]) setLegendRowVisible(row, legendRoutes[i], false); });
            updateFilterButtons();
        });
    }

    // Mobile swipe-to-dismiss bottom sheet
    initSwipeSheet();

    // Station Search
    const searchInput = document.getElementById('station-search');
    const searchResults = document.getElementById('search-results');
    const searchClearBtn = document.getElementById('search-clear-btn');
    if (searchInput && searchResults) {
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
                    .map(g => `<div data-id="${g.normName}">${esc(g.displayName)}</div>`)
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
    const hideAllBtn = document.getElementById('hide-all-btn');
    if (!showAllBtn || !hideAllBtn) return;

    const anyHidden  = legendRows.some(r => r.classList.contains('disabled'));
    const anyVisible = legendRows.some(r => !r.classList.contains('disabled') && !r.classList.contains('collapsed'));

    showAllBtn.style.display = anyHidden  ? 'block' : 'none';
    hideAllBtn.style.display = anyVisible ? 'block' : 'none';
}

function isMobile() {
    return window.innerWidth <= 768;
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
        if (delta > 0) e.preventDefault();              // prevent map pan while dragging
        container.style.transform = `translateY(${delta}px)`;
    }

    function onTouchEnd() {
        if (!isMobile() || !sheetDragActive) return;
        sheetDragActive = false;
        container.classList.remove('is-dragging');

        const delta  = sheetDragLastY - sheetDragStartY;
        const thresh = container.offsetHeight * SHEET_DISMISS_RATIO;

        if (sheetVelocityY > SHEET_VELOCITY_DISMISS || delta > thresh) {
            // Dismiss: clear inline transform, let CSS hidden class slide it out
            container.style.transform = '';
            showMini = true;
            adjustMiniDisplay();
        } else {
            // Snap back: clear inline transform, force reflow to re-enable transition
            container.style.transform = '';
            void container.offsetHeight; // trigger reflow → CSS transition fires
        }
    }

    function onTouchCancel() {
        sheetDragActive = false;
        container.classList.remove('is-dragging');
        container.style.transform = '';
    }

    // Tap handle to expand from peek
    handle.addEventListener('click', () => {
        if (isMobile() && showMini) { showMini = false; adjustMiniDisplay(); }
    });

    // Handle: always drag-able
    handle.addEventListener('touchstart',  onTouchStart,  { passive: true  });
    handle.addEventListener('touchmove',   onTouchMove,   { passive: false });
    handle.addEventListener('touchend',    onTouchEnd,    { passive: true  });
    handle.addEventListener('touchcancel', onTouchCancel, { passive: true  });

    // Content area: drag only when scrolled to top
    legend.addEventListener('touchstart',  onTouchStart,  { passive: true  });
    legend.addEventListener('touchmove',   onTouchMove,   { passive: false });
    legend.addEventListener('touchend',    onTouchEnd,    { passive: true  });
    legend.addEventListener('touchcancel', onTouchCancel, { passive: true  });
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
 * Auto-dismisses after 4 seconds.
 * @param {string} message Text to display
 */
export function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = [
        'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
        'background:var(--bg-glass-solid,rgba(255,255,255,.95))',
        'color:var(--text-main,#575757)',
        'border:1px solid var(--border-line,#f3f3f3)',
        'padding:8px 16px', 'border-radius:6px',
        'box-shadow:0 2px 8px rgba(0,0,0,.15)',
        'font-size:13px', 'z-index:9999',
        'opacity:1', 'transition:opacity 0.4s',
        'pointer-events:none',
    ].join(';');
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 4000);
    setTimeout(() => toast.remove(), 4500);
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
        updateTimeDiv.textContent = `Updated at ${new Date().toLocaleTimeString()}`;
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
        ? Math.round((currentStopSequence / totalStops) * 100) : null;
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
            <span class="pv2-time" data-ts="${timestamp}"><span class="pv2-dot"${secsSince >= STALE_FADE_START_SEC ? ' style="background:#9ca3af"' : ''}></span><span class="pv2-secs">${secsSince}s</span></span>
            <span class="pv2-vehicle" title="${esc(vehicleHTML)}">${vehicleHTML}</span>
        </div>
    </div>`;
}
