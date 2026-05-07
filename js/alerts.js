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

// Currently-visible tooltip; null when none. Position is set imperatively so
// the tooltip uses position: fixed and escapes any container's overflow clip.
let _activeTooltip = null;

function _hideAlertTooltip() {
    if (!_activeTooltip) return;
    _activeTooltip.tip.classList.remove('is-visible');
    _activeTooltip.wrap.classList.remove('is-open');
    _activeTooltip = null;
}

function _showAlertTooltip(wrap) {
    const tip = wrap.querySelector('.alert-tooltip');
    if (!tip) return;
    if (_activeTooltip && _activeTooltip.tip !== tip) _hideAlertTooltip();

    // Make tip measurable: must be visible to read offsetWidth/Height.
    tip.classList.add('is-visible');
    wrap.classList.add('is-open');

    const wrapRect = wrap.getBoundingClientRect();
    const tipW     = tip.offsetWidth;
    const tipH     = tip.offsetHeight;
    const margin   = 8;       // page-edge margin
    const gap      = 8;       // gap between icon and tooltip

    // Prefer above the icon; flip below only if there's not enough room.
    const wantAbove = wrapRect.top - tipH - gap >= margin;
    const top  = wantAbove
        ? wrapRect.top - tipH - gap
        : wrapRect.bottom + gap;
    // Center horizontally on the wrap, but clamp to the viewport with a margin.
    const wrapCx  = wrapRect.left + wrapRect.width / 2;
    const rawLeft = wrapCx - tipW / 2;
    const left    = Math.max(margin, Math.min(window.innerWidth - tipW - margin, rawLeft));

    tip.style.top  = `${top}px`;
    tip.style.left = `${left}px`;
    // Caret horizontal position relative to the tooltip's left edge.
    const caretX = Math.max(10, Math.min(tipW - 10, wrapCx - left));
    tip.style.setProperty('--caret-x', `${caretX}px`);
    // Flip caret to point UP from the bottom edge when the tooltip is below.
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

function _wireAlertWrap(wrap) {
    if (wrap._alertWired) return;
    wrap._alertWired = true;
    wrap.setAttribute('role', 'button');
    wrap.setAttribute('tabindex', '0');

    // Desktop: hover/focus reveal. Touch devices fire a synthetic mouseenter
    // after tap, so we additionally drive everything from click for tap UX.
    wrap.addEventListener('mouseenter', () => _showAlertTooltip(wrap));
    wrap.addEventListener('mouseleave', () => {
        // Only auto-hide if the user didn't tap-to-pin it open.
        if (_activeTooltip?.wrap === wrap && !wrap.matches(':focus-within')) {
            _hideAlertTooltip();
        }
    });
    wrap.addEventListener('focus', () => _showAlertTooltip(wrap));
    wrap.addEventListener('blur',  () => {
        if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
    });

    const toggleTap = (e) => {
        e.stopPropagation(); // don't immediately trip the global dismiss
        if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
        else _showAlertTooltip(wrap);
    };
    wrap.addEventListener('click', toggleTap);
    wrap.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTap(e); }
    });
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
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = '!';
            wrap.appendChild(badge);

            const tip = document.createElement('div');
            tip.className = 'alert-tooltip';
            tip.setAttribute('role', 'tooltip');
            const alerts = getActiveAlerts(rc).filter(a => Object.hasOwn(STRIP_EFFECT_LABELS, a.effect));
            const tipText = alerts.map(a => `${STRIP_EFFECT_LABELS[a.effect]}: ${a.header}`).join('\n');
            tip.textContent = tipText;
            wrap.appendChild(tip);
            wrap.setAttribute('aria-label', `Service alert: ${tipText}`);
            _wireAlertWrap(wrap);
        } else if (!hasAlert && badge) {
            const wrap = badge.parentNode;
            // If the active tooltip belongs to this wrap, hide it before tearing down.
            if (_activeTooltip?.wrap === wrap) _hideAlertTooltip();
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
                const tipText = alerts.map(a => `${STRIP_EFFECT_LABELS[a.effect]}: ${a.header}`).join('\n');
                tip.textContent = tipText;
                wrap?.setAttribute('aria-label', `Service alert: ${tipText}`);
            }
        }
    });
}

