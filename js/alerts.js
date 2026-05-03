/**
 * alerts.js
 * Polls the Metro service-alerts REST endpoints (which power alerts.metro.net)
 * and maintains a live lookup of active + planned alerts per route:
 *
 *   window.masterAlertsData = Map { routeCode → Alert[] }
 *   Alert = { id, effect, header, description, activePeriod: { start, end } }
 *
 * Exports getActiveAlerts(routeCode) and updateAlertBadges() for use by the
 * station popup (stations.js) and legend (ui.js).
 *
 * Note: The Metro GTFS-RT service_alerts WebSocket only pushes deltas and never
 * sends a snapshot on connect, so it cannot populate initial state. These REST
 * endpoints are the authoritative source.
 */

import { RAIL_ALERTS_URL, BUS_ALERTS_URL, ALERTS_POLL_MS } from './config.js';

const RELEVANT_ROUTES = new Set(['801','802','803','804','805','807','901','910','950']);

export function initAlerts() {
    window.masterAlertsData = new Map();
    _fetchAlerts();
    setInterval(_fetchAlerts, ALERTS_POLL_MS);
}

async function _fetchAlerts() {
    try {
        const [rail, bus] = await Promise.all([
            fetch(RAIL_ALERTS_URL).then(r => r.json()),
            fetch(BUS_ALERTS_URL).then(r => r.json()),
        ]);
        const now = Math.floor(Date.now() / 1000);
        window.masterAlertsData.clear();
        for (const alert of [...(Array.isArray(rail) ? rail : []), ...(Array.isArray(bus) ? bus : [])]) {
            _ingest(alert, now);
        }
        updateAlertBadges();
    } catch {
        // Non-critical — keep showing whatever was last loaded
    }
}

function _ingest(alert, now) {
    const period = alert.activePeriods?.[0] ?? {};
    // Dates arrive as ISO strings; convert to unix seconds
    const end = period.end ? Math.floor(new Date(period.end).getTime() / 1000) : Infinity;
    if (end < now) return;

    const routeCodes = new Set();
    for (const ie of (alert.informedEntities ?? [])) {
        const rc = String(ie.routeId ?? '').split('-')[0];
        if (RELEVANT_ROUTES.has(rc)) routeCodes.add(rc);
    }
    if (routeCodes.size === 0) return;

    const start = period.start ? Math.floor(new Date(period.start).getTime() / 1000) : 0;
    const entry = {
        id:          alert.id ?? '',
        effect:      alert.effect ?? '',
        header:      alert.headerText ?? '',
        description: alert.descriptionText ?? '',
        activePeriod: { start, end },
    };

    for (const rc of routeCodes) {
        if (!window.masterAlertsData.has(rc)) window.masterAlertsData.set(rc, []);
        const list = window.masterAlertsData.get(rc);
        const idx  = list.findIndex(a => a.id === entry.id);
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
    }
}

export function getActiveAlerts(routeCode) {
    if (!window.masterAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterAlertsData.get(String(routeCode)) ?? [])
        .filter(a => a.activePeriod.end > now);
}

export function updateAlertBadges() {
    document.querySelectorAll('.legend-row[data-route]').forEach(row => {
        const rc       = row.getAttribute('data-route');
        const hasAlert = getActiveAlerts(rc).length > 0;
        let   badge    = row.querySelector('.alert-badge');

        if (hasAlert && !badge) {
            const img = row.querySelector('img');
            if (!img) return;
            let wrap = img.parentNode.classList?.contains('alert-icon-wrap')
                ? img.parentNode
                : null;
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.className = 'alert-icon-wrap';
                img.parentNode.insertBefore(wrap, img);
                wrap.appendChild(img);
            }
            badge = document.createElement('span');
            badge.className = 'alert-badge';
            badge.setAttribute('aria-label', 'Service alert');
            badge.textContent = '!';
            wrap.appendChild(badge);
        } else if (!hasAlert && badge) {
            const wrap = badge.parentNode;
            badge.remove();
            if (wrap?.classList.contains('alert-icon-wrap')) {
                const img = wrap.querySelector('img');
                if (img) wrap.parentNode.insertBefore(img, wrap);
                wrap.remove();
            }
        }
    });
}
