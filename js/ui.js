import { routeIcons, routeDirectionLabels, METROLINK_ROUTE_IDS, METROLINK_ICON } from './config.js';

let showMini = false;

export function initUI() {
    // Detect if the screen is a mobile device and start the legend minified
    if (window.innerWidth <= 600) {
        showMini = true;
    }
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
        var w = document.documentElement.clientWidth;
        if (w > 600) {
            showMini = false;
        } else {
            showMini = true;
        }
        adjustMiniDisplay();
    });

    // Setup line filtering
    document.querySelectorAll('.legend-row').forEach(row => {
        row.style.cursor = 'pointer';
        
        // Single click to toggle
        row.addEventListener('click', (e) => {
            const route = row.getAttribute('data-route');
            if (!route) return;
            
            const isHidden = document.body.classList.contains(`hide-route-${route}`);
            if (isHidden) {
                document.body.classList.remove(`hide-route-${route}`);
                row.classList.remove('disabled');
            } else {
                document.body.classList.add(`hide-route-${route}`);
                row.classList.add('disabled');
            }
            updateFilterButtons();
        });
    });

    // Show All button
    const showAllBtn = document.getElementById('show-all-btn');
    if (showAllBtn) {
        showAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.legend-row').forEach(row => {
                const route = row.getAttribute('data-route');
                if (route) {
                    document.body.classList.remove(`hide-route-${route}`);
                    row.classList.remove('disabled');
                }
            });
            updateFilterButtons();
        });
    }

    // Hide All button
    const hideAllBtn = document.getElementById('hide-all-btn');
    if (hideAllBtn) {
        hideAllBtn.addEventListener('click', () => {
            document.querySelectorAll('.legend-row').forEach(row => {
                const route = row.getAttribute('data-route');
                if (route) {
                    document.body.classList.add(`hide-route-${route}`);
                    row.classList.add('disabled');
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
    
    // Check states
    const anyHidden = document.querySelector('.legend-row.disabled');
    const anyVisible = document.querySelector('.legend-row:not(.disabled):not(.collapsed)');

    showAllBtn.style.display = anyHidden ? 'block' : 'none';
    hideAllBtn.style.display = anyVisible ? 'block' : 'none';
}

function adjustMiniDisplay() {
    const container = document.getElementById('legend-container');
    const mini = document.getElementById('legend-mini');
    
    if (!container || !mini) return;

    if (showMini) {
        // Use classes for CSS transitions instead of inline styles
        container.classList.add('hidden');
        mini.classList.remove('hidden');
    } else {
        container.classList.remove('hidden');
        mini.classList.add('hidden');
    }
}

export function removeLoadingScreen() {
    const loadingScreen = document.getElementById('loading');
    if (loadingScreen) {
        loadingScreen.classList.add('fade-out');
        setTimeout(() => loadingScreen.remove(), 500);
    }
}

export function updateDataPanel(markers) {
    const counts = {};
    const speeds = {};
    let total = 0;
    let totalSpeed = 0;

    // Tally active vehicles and speeds by line
    for (const id in markers) {
        const route = markers[id].route_code;
        const speedMpS = markers[id].properties?.speed || 0;

        // Aggregate all Metrolink lines under 'ML' for the single legend row
        const countKey = METROLINK_ROUTE_IDS.includes(route) ? 'ML' : route;
        counts[countKey] = (counts[countKey] || 0) + 1;
        speeds[countKey] = (speeds[countKey] || 0) + speedMpS;
        total++;
        totalSpeed += speedMpS;
    }

    // Update total count
    const totalEl = document.getElementById('total-count-badge');
    if (totalEl) totalEl.textContent = total;

    // Update total avg speed
    const totalSpeedEl = document.getElementById('total-speed-badge');
    if (totalSpeedEl) {
        const avgMps = total > 0 ? (totalSpeed / total) : 0;
        const avgMph = Math.round(avgMps * 2.23694);
        totalSpeedEl.textContent = `${avgMph} mph`;
    }

    // Update line-by-line metrics and toggle visibility
    document.querySelectorAll('.legend-row').forEach(row => {
        const route = row.getAttribute('data-route');
        const count = counts[route] || 0;
        const speedSum = speeds[route] || 0;

        const countBadge = row.querySelector('.count-badge');
        if (countBadge) countBadge.textContent = count;

        const speedBadge = row.querySelector('.speed-badge');
        if (speedBadge) {
            const avgMps = count > 0 ? (speedSum / count) : 0;
            const avgMph = Math.round(avgMps * 2.23694);
            speedBadge.textContent = `${avgMph} mph`;
        }

        if (count === 0 && !row.dataset.persistent) {
            row.classList.add('collapsed');
        } else {
            row.classList.remove('collapsed');
        }
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
    const stopName = stopInfo?.name || null;

    const isAtStop      = currentStatus === 1 || currentStatus === 'STOPPED_AT';
    const isArriving    = currentStatus === 0 || currentStatus === 'INCOMING_AT';
    const isInTransit   = currentStatus === 2 || currentStatus === 'IN_TRANSIT_TO';
    const statusLabel   = isAtStop ? 'At:' : isArriving ? 'Arriving at:' : 'Next stop:';

    const stopHeadline = stopName
        ? `<div class="popup-stop-headline"><span class="status-label-small">${statusLabel}</span> <span class="stop-name-big">${stopName}</span></div>`
        : '';

    const directionName = (directionId != null && routeDirectionLabels[routeCode])
        ? (routeDirectionLabels[routeCode][Number(directionId)] ?? '')
        : '';
    const dirLine = directionName ? `<div class="direction-label" style="font-size: 11px; font-weight: 600; text-transform: uppercase; margin-bottom: 2px;">${directionName}</div>` : '';

    // Use Metrolink icon for Metrolink vehicles, Metro route icon otherwise
    const isMetrolink = agency === 'metrolink';
    const iconSrc = isMetrolink ? METROLINK_ICON : (routeIcons[routeCode] || '');

    return `
    <div class="popup-container">
        <div class="popup-icon">
            <img src="${iconSrc}" alt="${isMetrolink ? 'Metrolink' : 'Route'} Icon">
        </div>
        <div class="popup-details">
            ${dirLine}
            ${stopHeadline}
            <div class="timestamp">Data from ${new Date(timestamp * 1000).toLocaleTimeString()}</div>
            <div class="vehicle-id-small">${vehicleLabel}${vehicleId}</div>
        </div>
    </div>`;
}
