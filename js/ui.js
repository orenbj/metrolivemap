import { routeIcons, routeDirectionLabels, routeHexColors, METROLINK_ICON, METROLINK_ROUTE_IDS } from './config.js';
import { recordSample } from './chart.js';

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
let legendRows = []; // cached once at init — avoids repeated DOM queries in hot paths

export function initUI() {
    if (window.innerWidth <= 600) showMini = true;
    adjustMiniDisplay();

    document.getElementById('legend-close')?.addEventListener('click', () => {
        showMini = true;
        adjustMiniDisplay();
    });

    document.getElementById('legend-mini')?.addEventListener('click', () => {
        showMini = false;
        adjustMiniDisplay();
    });

    window.addEventListener('resize', () => {
        showMini = document.documentElement.clientWidth <= 600;
        adjustMiniDisplay();
    });

    // Cache and wire up legend rows (filtering + a11y)
    legendRows = Array.from(document.querySelectorAll('.legend-row'));
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
            const isHidden = document.body.classList.toggle(`hide-route-${route}`);
            row.classList.toggle('disabled', isHidden);
            row.setAttribute('aria-checked', String(!isHidden));
            updateFilterButtons();
        };

        row.addEventListener('click', toggleRow);
        row.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(); }
        });
    });

    // Show All button
    const showAllBtn = document.getElementById('show-all-btn');
    if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
            legendRows.forEach(row => {
                const route = row.getAttribute('data-route');
                if (route) {
                    document.body.classList.remove(`hide-route-${route}`);
                    row.classList.remove('disabled');
                    row.setAttribute('aria-checked', 'true');
                }
            });
            updateFilterButtons();
        });
    }

    // Hide All button
    const hideAllBtn = document.getElementById('hide-all-btn');
    if (hideAllBtn) {
        hideAllBtn.addEventListener('click', () => {
            legendRows.forEach(row => {
                const route = row.getAttribute('data-route');
                if (route) {
                    document.body.classList.add(`hide-route-${route}`);
                    row.classList.add('disabled');
                    row.setAttribute('aria-checked', 'false');
                }
            });
            updateFilterButtons();
        });
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

function adjustMiniDisplay() {
    const container = document.getElementById('legend-container');
    const mini = document.getElementById('legend-mini');
    if (!container || !mini) return;
    container.classList.toggle('hidden', showMini);
    mini.classList.toggle('hidden', !showMini);
}

export function removeLoadingScreen() {
    const loadingScreen = document.getElementById('loading');
    if (loadingScreen) {
        loadingScreen.classList.add('fade-out');
        setTimeout(() => loadingScreen.remove(), 500);
    }
}

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

export function updateDataPanel(markers) {
    const counts = {};
    const speeds = {};
    let total = 0;
    let totalSpeed = 0;

    for (const id in markers) {
        const route = markers[id].route_code;
        const speedMpS = markers[id].properties?.speed || 0;
        const countKey = METROLINK_ROUTE_IDS.includes(route) ? 'ML' : route;
        counts[countKey] = (counts[countKey] || 0) + 1;
        speeds[countKey] = (speeds[countKey] || 0) + speedMpS;
        total++;
        totalSpeed += speedMpS;
    }

    const totalEl = document.getElementById('total-count-badge');
    if (totalEl) totalEl.textContent = total;

    const totalSpeedEl = document.getElementById('total-speed-badge');
    if (totalSpeedEl) {
        const avgMph = total > 0 ? Math.round((totalSpeed / total) * 2.23694) : 0;
        totalSpeedEl.textContent = `${avgMph} mph`;
    }

    // Compute max count for proportional bar widths
    const allRoutes = legendRows.map(r => r.getAttribute('data-route')).filter(Boolean);
    const maxCount = Math.max(1, ...allRoutes.map(r => counts[r] || 0));

    legendRows.forEach(row => {
        const route = row.getAttribute('data-route');
        const count = counts[route] || 0;
        const speedSum = speeds[route] || 0;

        const countBadge = row.querySelector('.count-badge');
        if (countBadge) countBadge.textContent = count > 0 ? count : '';

        const barFill = row.querySelector('.bar-fill');
        if (barFill) barFill.style.width = `${Math.round((count / maxCount) * 100)}%`;

        const speedBadge = row.querySelector('.speed-badge');
        if (speedBadge) {
            const avgMph = count > 0 ? Math.round((speedSum / count) * 2.23694) : 0;
            speedBadge.textContent = `${avgMph} mph`;
        }

        row.classList.toggle('collapsed', count === 0 && !row.dataset.persistent);
    });

    recordSample(total);
}

export function updateUpdateTime() {
    const updateTimeDiv = document.getElementById('update-time');
    if (updateTimeDiv) {
        updateTimeDiv.textContent = `Updated at ${new Date().toLocaleTimeString()}`;
    }
}

export function getPopupHTML(routeCode, vehicleId, vehicleLabel, timestamp, stopId, currentStatus, directionId, tripId, currentStopSequence, agency = 'metro') {
    const stopKey  = stopId != null ? String(stopId) : null;
    const stopInfo = stopKey && window.masterStopsData?.[stopKey];

    // Clean stop name: strip "Station" and line-brand suffixes
    // handles: "- Metro B & D Lines", "- Metro A-Line", "- Metro B Line Platform"
    const rawStopName = stopInfo?.name
        ?.replace(/\s*-\s*(Metro\s+)?[A-Z][\w]*[\s-]Lines?.*$/i, '')
        .replace(/\s*-\s*(Metro\s+)?[A-Z](\s*[&,]\s*[A-Z])*\s+Lines?.*$/i, '')
        .trim() || null;
    // Preserve "Union Station" — it's a proper name, not a generic suffix
    const stopName = rawStopName && /^union station$/i.test(rawStopName)
        ? 'Union Station'
        : rawStopName?.replace(/\s*\bStation\b/i, '').trim() || null;

    const isAtStop   = currentStatus === 1 || currentStatus === 'STOPPED_AT';
    const isArriving = currentStatus === 0 || currentStatus === 'INCOMING_AT';
    const statusLabel = isAtStop ? 'At stop' : isArriving ? 'Arriving' : 'Next stop';

    // Trip data
    const tripInfo    = tripId ? window.masterTripsData?.[String(tripId)] : null;
    const destination = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
    const totalStops  = tripInfo?.total ?? null;
    const directionName = (directionId != null && routeDirectionLabels[routeCode])
        ? (routeDirectionLabels[routeCode][Number(directionId)] ?? '')
        : '';

    // Route accent color
    const isMetrolink = agency === 'metrolink';
    const accentColor = isMetrolink ? '#0079C1' : (routeHexColors[routeCode] ?? '#888');
    const iconSrc     = isMetrolink ? METROLINK_ICON : (routeIcons[routeCode] || '');

    // Destination / direction header
    const destHTML = destination
        ? `<div class="pv2-dest">\u2192 ${escapeHtml(destination)}</div>`
        : directionName
            ? `<div class="pv2-dest">${escapeHtml(directionName)}</div>`
            : '';
    const dirHTML = destination && directionName
        ? `<div class="pv2-dir">${escapeHtml(directionName)}</div>`
        : '';

    // Next stop section
    const stopSection = stopName ? `
        <div class="pv2-section">
            <div class="pv2-label">${escapeHtml(statusLabel)}</div>
            <div class="pv2-stop ${isAtStop ? 'at-stop' : ''}">${escapeHtml(stopName)}</div>
        </div>` : '';

    // Progress bar
    const pct = (currentStopSequence && totalStops)
        ? Math.round((currentStopSequence / totalStops) * 100) : null;
    const progressHTML = pct !== null ? `
        <div class="pv2-progress-track">
            <div class="pv2-progress-fill" style="width:${pct}%"></div>
        </div>` : '';

    // Footer: time · vehicle id (full)
    const timeStr  = new Date(timestamp * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    const vehicleHTML = `${escapeHtml(vehicleLabel)}${escapeHtml(String(vehicleId))}`;

    return `
    <div class="pv2-card">
        <div class="pv2-accent" style="background:${accentColor}"></div>
        <div class="pv2-header">
            <img class="pv2-icon" src="${escapeHtml(iconSrc)}" alt="route">
            <div class="pv2-header-text">
                ${destHTML}
                ${dirHTML}
            </div>
        </div>
        ${stopSection}
        ${progressHTML}
        <div class="pv2-footer">
            <span class="pv2-time">${escapeHtml(timeStr)}</span>
            <span class="pv2-vehicle" title="${escapeHtml(vehicleHTML)}">${vehicleHTML}</span>
        </div>
    </div>`;
}
