/**
 * alerts.js
 * Polls the Metro service-alerts REST endpoints (which power alerts.metro.net)
 * and maintains a live lookup of active alerts per route:
 *
 *   window.masterAlertsData = Map { routeCode → Alert[] }
 *   Alert = { id, effect, header, description, activePeriod: { start, end } }
 *
 * Exports: getActiveAlerts, updateAlertBadges
 */

import { RAIL_ALERTS_URL, BUS_ALERTS_URL, ALERTS_POLL_MS } from './config.js';
import { setVisibleInterval } from './utils.js';

const RELEVANT_ROUTES = new Set(['801','802','803','804','805','807','901','910','950']);

/** Map of GTFS-RT effect codes to human-readable labels shown in popups and badges. */
export const STRIP_EFFECT_LABELS = {
    DETOUR:               'Detour',
    REDUCED_SERVICE:      'Reduced service',
    SIGNIFICANT_DELAYS:   'Delays',
    NO_SERVICE:           'No service',
    MODIFIED_SERVICE:     'Modified service',
    STOP_MOVED:           'Stop changes',
    OTHER_EFFECT:         'Service alert',
    UNKNOWN_EFFECT:       'Service alert',
};

/**
 * Start polling Metro service-alerts REST endpoints and populate
 * window.masterAlertsData (Map<routeCode, Alert[]>). Polls every ALERTS_POLL_MS
 * and pauses while the tab is hidden.
 */
export function initAlerts() {
    window.masterAlertsData = new Map();
    _fetchAlerts();
    setVisibleInterval(_fetchAlerts, ALERTS_POLL_MS);
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
    if (alert.effect === 'ACCESSIBILITY_ISSUE') return;
    // Some elevator/escalator alerts are mislabelled OTHER_EFFECT by the API
    const _desc = (alert.descriptionText ?? '') + (alert.headerText ?? '');
    if (/elevator|escalator/i.test(_desc)) return;

    const period = alert.activePeriods?.[0] ?? {};
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

/**
 * Return currently-active alerts for a route, filtered by current time.
 * @param {string|number} routeCode  e.g. "801", "901"
 * @returns {Alert[]} Active alerts (may be empty)
 */
export function getActiveAlerts(routeCode) {
    if (!window.masterAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterAlertsData.get(String(routeCode)) ?? [])
        .filter(a => a.activePeriod.start <= now && a.activePeriod.end > now);
}

/**
 * Add or remove "!" alert badges on legend rows based on current masterAlertsData.
 * Safe to call repeatedly — idempotent, detects existing badges before creating new ones.
 */
export function updateAlertBadges() {
    document.querySelectorAll('.legend-row[data-route]').forEach(row => {
        const rc       = row.getAttribute('data-route');
        const hasAlert = getActiveAlerts(rc).some(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect));
        let   badge    = row.querySelector('.alert-badge');

        if (hasAlert && !badge) {
            const img = row.querySelector('img');
            if (!img) return;
            let wrap = img.parentNode.classList?.contains('alert-icon-wrap')
                ? img.parentNode : null;
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

            const tip = document.createElement('div');
            tip.className = 'alert-tooltip';
            const alerts = getActiveAlerts(rc).filter(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect));
            tip.textContent = alerts.map(a => `${STRIP_EFFECT_LABELS[a.effect]}: ${a.header}`).join('\n');
            wrap.appendChild(tip);
        } else if (!hasAlert && badge) {
            const wrap = badge.parentNode;
            badge.remove();
            wrap?.querySelector('.alert-tooltip')?.remove();
            if (wrap?.classList.contains('alert-icon-wrap')) {
                const img = wrap.querySelector('img');
                if (img) wrap.parentNode.insertBefore(img, wrap);
                wrap.remove();
            }
        } else if (hasAlert && badge) {
            // Update tooltip text in case alerts changed
            const wrap = badge.parentNode;
            let tip = wrap?.querySelector('.alert-tooltip');
            if (tip) {
                const alerts = getActiveAlerts(rc).filter(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect));
                tip.textContent = alerts.map(a => `${STRIP_EFFECT_LABELS[a.effect]}: ${a.header}`).join('\n');
            }
        }
    });
}

