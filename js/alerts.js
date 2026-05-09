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
import { setVisibleInterval, normalizeStopId } from './utils.js';

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
    window.masterStopAlertsData = new Map();
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
        window.masterStopAlertsData.clear();
        for (const alert of [...(Array.isArray(rail) ? rail : []), ...(Array.isArray(bus) ? bus : [])]) {
            _ingest(alert, now);
        }
        updateAlertBadges();
        document.dispatchEvent(new CustomEvent('alertsUpdated'));
    } catch (err) {
        console.warn('[alerts] fetch failed:', err);
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
    const stopIdSet  = new Set();
    for (const ie of (alert.informedEntities ?? [])) {
        const rc = String(ie.routeId ?? '').split('-')[0];
        if (RELEVANT_ROUTES.has(rc)) routeCodes.add(rc);
        if (ie.stopId) stopIdSet.add(normalizeStopId(String(ie.stopId)));
    }
    if (routeCodes.size === 0) return;

    const start = period.start ? Math.floor(new Date(period.start).getTime() / 1000) : 0;
    const entry = {
        id:          alert.id ?? '',
        effect:      alert.effect ?? '',
        header:      alert.headerText ?? '',
        description: alert.descriptionText ?? '',
        activePeriod: { start, end },
        stopIds:     [...stopIdSet],
    };

    for (const rc of routeCodes) {
        if (!window.masterAlertsData.has(rc)) window.masterAlertsData.set(rc, []);
        const list = window.masterAlertsData.get(rc);
        const idx  = list.findIndex(a => a.id === entry.id);
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
    }
    for (const stopId of stopIdSet) {
        if (!window.masterStopAlertsData.has(stopId)) window.masterStopAlertsData.set(stopId, []);
        const sList = window.masterStopAlertsData.get(stopId);
        const sIdx  = sList.findIndex(a => a.id === entry.id);
        if (sIdx >= 0) sList[sIdx] = entry;
        else sList.push(entry);
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

// Singleton tooltip appended to <body> so position:fixed is never trapped
// inside a CSS-transformed ancestor (MapLibre markers, legend slide panel).
let _activeTooltip  = null;
let _alertTipEl     = null;

function _getOrCreateTip() {
    if (_alertTipEl) return _alertTipEl;
    _alertTipEl = document.createElement('div');
    _alertTipEl.className = 'alert-tooltip';
    _alertTipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(_alertTipEl);
    return _alertTipEl;
}

function _hideAlertTooltip() {
    if (!_activeTooltip) return;
    _alertTipEl?.classList.remove('is-visible');
    _activeTooltip.wrap.classList.remove('is-open');
    _activeTooltip = null;
}

function _showAlertTooltip(wrap) {
    const text = wrap.dataset.alertText;
    if (!text) return;
    if (_activeTooltip && _activeTooltip.wrap !== wrap) _hideAlertTooltip();

    const tip = _getOrCreateTip();
    tip.textContent = text;
    tip.classList.add('is-visible');
    wrap.classList.add('is-open');

    const wrapRect = wrap.getBoundingClientRect();
    const tipW     = tip.offsetWidth;
    const tipH     = tip.offsetHeight;
    const margin   = 8;
    const gap      = 8;

    // Prefer above the icon; flip below if there's not enough room.
    const wantAbove = wrapRect.top - tipH - gap >= margin;
    const top  = wantAbove
        ? wrapRect.top - tipH - gap
        : wrapRect.bottom + gap;
    const wrapCx  = wrapRect.left + wrapRect.width / 2;
    const rawLeft = wrapCx - tipW / 2;
    const left    = Math.max(margin, Math.min(window.innerWidth - tipW - margin, rawLeft));

    tip.style.top  = `${top}px`;
    tip.style.left = `${left}px`;
    const caretX = Math.max(10, Math.min(tipW - 10, wrapCx - left));
    tip.style.setProperty('--caret-x', `${caretX}px`);
    tip.classList.toggle('is-below', !wantAbove);

    _activeTooltip = { wrap, tip };
}

// One-time global listeners (registered on first call to updateAlertBadges).
let _alertTooltipBound = false;
function _bindAlertTooltipGlobals() {
    if (_alertTooltipBound) return;
    _alertTooltipBound = true;
    const dismiss = (e) => {
        if (!_activeTooltip) return;
        if (!_activeTooltip.wrap.contains(e.target)) _hideAlertTooltip();
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('touchstart', dismiss, { passive: true });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') _hideAlertTooltip();
    });
    // Reposition on scroll/resize so the tooltip tracks its anchor.
    const reflow = () => { if (_activeTooltip) _showAlertTooltip(_activeTooltip.wrap); };
    window.addEventListener('scroll', reflow, { passive: true, capture: true });
    window.addEventListener('resize', reflow);
}

export function wireAlertBadge(wrap, badge) {
    if (badge._alertWired) return;
    badge._alertWired = true;
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');

    // Hover anywhere on the icon wrap reveals the tooltip on desktop. Touch
    // devices fire a synthetic mouseenter after tap, but we drive touch
    // exclusively through click on the badge — the synthetic hover is
    // harmless because mouseleave clears it once the user moves on.
    wrap.addEventListener('mouseenter', () => _showAlertTooltip(wrap));
    wrap.addEventListener('mouseleave', () => {
        if (_activeTooltip?.wrap === wrap && !wrap.contains(document.activeElement)) {
            _hideAlertTooltip();
        }
    });
    badge.addEventListener('focus', () => _showAlertTooltip(wrap));
    badge.addEventListener('blur',  () => {
        if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
    });

    // Click on the badge toggles the tooltip without bubbling — the row's
    // click handler (route filter) must not fire when the user is reaching
    // for the alert info, and the global outside-tap dismiss must not see
    // this same click as "outside" and immediately re-close.
    const toggleTap = (e) => {
        e.stopPropagation();
        if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
        else _showAlertTooltip(wrap);
    };
    badge.addEventListener('click', toggleTap);
    // touchstart bubbles to the document-level dismiss handler too — stop it
    // so a tap on the badge doesn't trigger an immediate hide-then-show race.
    badge.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    badge.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTap(e); }
    });
}

/**
 * Return currently-active alerts targeting a specific stop, filtered by current time.
 * Only returns alerts whose informedEntities listed this stop explicitly — route-wide
 * alerts (stopIds is empty) are not included.
 * @param {string} stopId  Canonical stop ID, e.g. "80111"
 * @returns {Alert[]} Active stop-targeted alerts (may be empty)
 */
export function getActiveStopAlerts(stopId) {
    if (!window.masterStopAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterStopAlertsData.get(normalizeStopId(String(stopId))) ?? [])
        .filter(a => a.activePeriod.start <= now && a.activePeriod.end > now);
}

/**
 * Add or remove "!" alert badges on legend rows based on current masterAlertsData.
 * Safe to call repeatedly — idempotent, detects existing badges before creating new ones.
 */
export function updateAlertBadges() {
    _bindAlertTooltipGlobals();
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
            badge.textContent = '!';
            wrap.appendChild(badge);

            const alerts = [...new Map(
                getActiveAlerts(rc).filter(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect))
                    .map(a => [a.effect, a])
            ).values()];
            const tipText = alerts.map(a => `${STRIP_EFFECT_LABELS[a.effect]}: ${a.header}`).join('\n');
            wrap.dataset.alertText = tipText;
            badge.setAttribute('aria-label', `Service alert: ${tipText}`);
            wireAlertBadge(wrap, badge);
        } else if (!hasAlert && badge) {
            const wrap = badge.parentNode;
            if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
            badge.remove();
            if (wrap?.classList.contains('alert-icon-wrap')) {
                const img = wrap.querySelector('img');
                if (img) wrap.parentNode.insertBefore(img, wrap);
                wrap.remove();
            }
        } else if (hasAlert && badge) {
            // Update tooltip text in case alerts changed.
            const wrap = badge.parentNode;
            const alerts = [...new Map(
                getActiveAlerts(rc).filter(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect))
                    .map(a => [a.effect, a])
            ).values()];
            const tipText = alerts.map(a => `${STRIP_EFFECT_LABELS[a.effect]}: ${a.header}`).join('\n');
            wrap.dataset.alertText = tipText;
            badge.setAttribute('aria-label', `Service alert: ${tipText}`);
        }
    });
}

