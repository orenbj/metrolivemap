import { routeIcons, routeDirectionLabels, METROLINK_ICON, METROLINK_ROUTE_IDS } from './config.js';

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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

    legendRows.forEach(row => {
        const route = row.getAttribute('data-route');
        const count = counts[route] || 0;
        const speedSum = speeds[route] || 0;

        const countBadge = row.querySelector('.count-badge');
        if (countBadge) countBadge.textContent = count;

        const speedBadge = row.querySelector('.speed-badge');
        if (speedBadge) {
            const avgMph = count > 0 ? Math.round((speedSum / count) * 2.23694) : 0;
            speedBadge.textContent = `${avgMph} mph`;
        }

        row.classList.toggle('collapsed', count === 0 && !row.dataset.persistent);
    });
}

export function updateUpdateTime() {
    const updateTimeDiv = document.getElementById('update-time');
    if (updateTimeDiv) {
        updateTimeDiv.textContent = `Updated at ${new Date().toLocaleTimeString()}`;
    }
}

export function getPopupHTML(routeCode, vehicleId, vehicleLabel, timestamp, stopId, currentStatus, directionId, agency = 'metro') {
    const stopKey = stopId != null ? String(stopId) : null;
    const stopInfo = stopKey && window.masterStopsData?.[stopKey];
    const stopName = stopInfo?.name?.replace(/\s*Station\b/i, '').trim() || null;

    const isAtStop    = currentStatus === 1 || currentStatus === 'STOPPED_AT';
    const isArriving  = currentStatus === 0 || currentStatus === 'INCOMING_AT';
    const statusLabel = isAtStop ? 'At:' : isArriving ? 'Arriving at:' : 'Next stop:';

    const stopHeadline = stopName
        ? `<div class="popup-stop-headline"><span class="status-label-small">${escapeHtml(statusLabel)}</span> <span class="stop-name-big">${escapeHtml(stopName)}</span></div>`
        : '';

    const directionName = (directionId != null && routeDirectionLabels[routeCode])
        ? (routeDirectionLabels[routeCode][Number(directionId)] ?? '')
        : '';
    const dirLine = directionName
        ? `<div class="direction-label" style="font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 2px;">${escapeHtml(directionName)}</div>`
        : '';

    const isMetrolink = agency === 'metrolink';
    const iconSrc = isMetrolink ? METROLINK_ICON : (routeIcons[routeCode] || '');

    return `
    <div class="popup-container">
        <div class="popup-icon">
            <img src="${escapeHtml(iconSrc)}" alt="${isMetrolink ? 'Metrolink' : 'Route'} Icon">
        </div>
        <div class="popup-details">
            ${dirLine}
            ${stopHeadline}
            <div class="timestamp">Data from ${escapeHtml(new Date(timestamp * 1000).toLocaleTimeString())}</div>
            <div class="vehicle-id-small">${escapeHtml(vehicleLabel)}${escapeHtml(String(vehicleId))}</div>
        </div>
    </div>`;
}
