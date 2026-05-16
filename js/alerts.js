/**
 * alerts.js
 * Polls the Metro service-alerts REST endpoints (which power alerts.metro.net)
 * and maintains a live lookup of active alerts:
 *
 *   window.masterAlertsData                    Map { routeCode → Alert[] }
 *   window.masterStopAlertsData                Map { stopId    → Alert[] }
 *   window.masterStopAccessibilityAlertsData   Map { stopId    → Alert[] } (♿)
 *
 *   Alert = { id, effect, header, description, activePeriod: { start, end } }
 *
 * Exports:
 *   initAlerts                            — bootstrap the poll loop
 *   updateAlertBadges                     — refresh legend "!" indicators
 *   wireAlertBadge                        — shared tooltip + click handler
 *   getActiveAlerts(routeCode)            — route-keyed canonical filter
 *   getActiveStopAlerts(stopId)           — stop-keyed regular alerts
 *   getActiveStopAccessibilityAlerts(id)  — stop-keyed elevator/escalator
 *   classifyAccessibilityAlert(h, d)      — 'elevator' | 'escalator' | 'both' | 'unknown'
 *   STRIP_EFFECT_LABELS                   — GTFS-RT effect → display label
 *   _clearStationIndexCache               — invalidate the regex index on GTFS reload
 */

import { RAIL_ALERTS_URL, BUS_ALERTS_URL, ALERTS_POLL_MS, METRO_ROUTE_CODES } from './config.js';
import { setVisibleInterval, normalizeStopId, fetchWithTimeout, normalizeTimestamp, splitRouteId } from './utils.js';
import { getRouteCache } from './predictions.js';

// ── Station-name text-mining fallback ──────────────────────────────────────
//
// LA Metro's alerts feed often publishes station-specific delays/issues as
// route-scoped alerts (informedEntities: [{ routeId: '801' }]) where the
// affected station name appears only in descriptionText/headerText —
// e.g. "delays due to mechanical issue at Allen Station". Without any
// stopId in the feed, masterStopAlertsData stays empty for that stop and
// the per-station "!" badge never renders.
//
// Fallback: when an alert produced zero stopIds from informedEntities, scan
// its text against the names of stops on the alert's routes. Match is
// constrained to:
//   - station name + literal " Station" (case-insensitive, word boundaries)
//   - OR, if the stop's name already ends in "Station", just the name
//   - name must be ≥ 4 chars (avoid matching tokens like "7th")
// Restricting candidates to stops on the alert's routes prevents matching
// e.g. a bus stop named "Allen / Colorado" against a rail alert.
//
// The whole index is rebuilt per _fetchAlerts pass (cheap: ~150 rail stops
// total) and the rebuild is keyed by the union of all routes seen, so we
// only do it when there's at least one fallback-eligible alert.
let _stationIndexCache = null;
let _stationIndexCacheKey = '';

/** Build [{ stopId, regex }] for every stop on the given routeCodes. */
function _buildStationIndex(routeCodes) {
    const key = [...routeCodes].sort().join(',');
    if (key === _stationIndexCacheKey && _stationIndexCache) return _stationIndexCache;
    _stationIndexCacheKey = key;
    _stationIndexCache = [];
    if (!window.masterStopsData) return _stationIndexCache;

    const seen = new Set();
    for (const rc of routeCodes) {
        for (const dir of [0, 1]) {
            const cache = getRouteCache(rc, dir);
            if (!cache?.stops) continue;
            for (const sid of cache.stops) {
                const id = normalizeStopId(String(sid));
                if (seen.has(id)) continue;
                seen.add(id);
                const stop = window.masterStopsData[id]
                          ?? window.masterStopsData[String(sid)];
                const name = String(stop?.name ?? '').trim();
                if (name.length < 4) continue;
                const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = /\bstation$/i.test(name)
                    ? `\\b${escaped}\\b`
                    : `\\b${escaped}\\s+Station\\b`;
                _stationIndexCache.push({ stopId: id, regex: new RegExp(pattern, 'i') });
            }
        }
    }
    return _stationIndexCache;
}

/** Find stopIds whose station name appears in the given text, scoped to routeCodes. */
function _matchStationsInText(text, routeCodes) {
    if (!text || routeCodes.size === 0) return new Set();
    const matches = new Set();
    for (const { stopId, regex } of _buildStationIndex(routeCodes)) {
        if (regex.test(text)) matches.add(stopId);
    }
    return matches;
}

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
let _alertsInitialized = false;

export function initAlerts() {
    // Allow re-init if module state was wiped (test reset path) — production
    // callers never delete masterAlertsData, so this early-return covers the
    // legitimate idempotency case without breaking the test harness.
    if (_alertsInitialized && window.masterAlertsData) return;
    _alertsInitialized = true;
    window.masterAlertsData = new Map();
    window.masterStopAlertsData = new Map();
    window.masterStopAccessibilityAlertsData = new Map();
    _fetchAlerts();
    setVisibleInterval(_fetchAlerts, ALERTS_POLL_MS, 'alerts:poll');
}

/**
 * Clear the station-name regex index. Called when GTFS data reloads at
 * midnight so the index rebuilds from the new masterStopsData on the
 * next poll instead of routing alerts to yesterday's stops.
 */
export function _clearStationIndexCache() {
    _stationIndexCache = null;
    _stationIndexCacheKey = '';
}

async function _fetchAlerts(_retry = 0) {
    try {
        const [rail, bus] = await Promise.all([
            fetchWithTimeout(RAIL_ALERTS_URL, 10000).then(r => r.json()),
            fetchWithTimeout(BUS_ALERTS_URL,  10000).then(r => r.json()),
        ]);
        const now = Math.floor(Date.now() / 1000);
        window.masterAlertsData.clear();
        window.masterStopAlertsData.clear();
        window.masterStopAccessibilityAlertsData.clear();
        // Invalidate the station-name index — masterStopsData may have hot-reloaded
        // since the previous poll (e.g. weekly GTFS rebuild), and stale entries
        // would mis-route fallback matches.
        _stationIndexCache = null;
        _stationIndexCacheKey = '';
        for (const alert of [...(Array.isArray(rail) ? rail : []), ...(Array.isArray(bus) ? bus : [])]) {
            _ingest(alert, now);
        }
        updateAlertBadges();
        document.dispatchEvent(new CustomEvent('alertsUpdated'));
    } catch (err) {
        console.warn('[alerts] fetch failed:', err);
        // One quick retry covers transient network blips — without this a
        // single bad poll silently leaves alerts stale for the full 120 s
        // poll interval. After the retry we yield to the regular poll.
        if (_retry === 0) setTimeout(() => _fetchAlerts(1), 10_000);
    }
}

function _ingest(alert, now) {
    // Classify accessibility alerts (elevator/escalator outages) — Metro often
    // mislabels them as OTHER_EFFECT, so match the text too. These are routed
    // into a separate per-stop map (masterStopAccessibilityAlertsData) so they
    // don't pollute the route-level service-alert UI and don't double-render
    // as both an amber "!" and a blue ♿ badge on the same station.
    const _accessText = (alert.descriptionText ?? '') + (alert.headerText ?? '');
    // Word-boundary anchor avoids accidental substring matches in service-alert
    // prose (e.g. "service elevated to priority", "issue escalated"). Without
    // \b, a metaphorical "elevator" or "escalator" mention silently re-routes
    // a service alert into the per-stop accessibility map and renders as ♿.
    const isAccessibility =
        alert.effect === 'ACCESSIBILITY_ISSUE' ||
        /\b(?:elevator|escalator)/i.test(_accessText);

    const period = alert.activePeriods?.[0] ?? {};
    // Metro alert API mixes ISO strings and Unix integers (seconds or ms) for
    // activePeriod boundaries. normalizeTimestamp handles all three forms,
    // returning NaN for unparseable input.
    const end = period.end ? normalizeTimestamp(period.end) : Infinity;
    // Drop malformed timestamps loudly. Without this, NaN slips through
    // (`NaN < now` is false), the alert lurks in masterAlertsData with NaN
    // periods, and getActiveAlerts silently filters it out forever — an
    // invisible memory leak until the next 120s poll's clear() phase.
    if (!Number.isFinite(end) && end !== Infinity) {
        console.warn(`[alerts] dropping malformed activePeriod.end for alert ${alert.id}:`, period.end);
        return;
    }
    if (end < now) return;

    const routeCodes = new Set();
    const stopIdSet  = new Set();
    for (const ie of (alert.informedEntities ?? [])) {
        const rc = splitRouteId(ie.routeId);
        if (METRO_ROUTE_CODES.has(rc)) routeCodes.add(rc);
        if (ie.stopId) stopIdSet.add(normalizeStopId(String(ie.stopId)));
    }
    // Route-scoped requirement applies only to service alerts. Accessibility
    // alerts are inherently station-scoped — an elevator outage tagged only to
    // a stop (with no route) is still actionable for riders.
    if (!isAccessibility && routeCodes.size === 0) return;

    // Fallback: when the feed provided no per-stop targeting, scan the alert
    // text for station names on the affected routes. Used both for labelled
    // service alerts (STRIP_EFFECT_LABELS) and for accessibility alerts where
    // the feed omits stopIds.
    if (stopIdSet.size === 0 &&
        (isAccessibility || Object.hasOwn(STRIP_EFFECT_LABELS, alert.effect))) {
        const scanRoutes = routeCodes.size ? routeCodes : new Set(METRO_ROUTE_CODES);
        const text = `${alert.headerText ?? ''} ${alert.descriptionText ?? ''}`;
        for (const sid of _matchStationsInText(text, scanRoutes)) stopIdSet.add(sid);
    }

    // Same NaN guard as end above. A malformed start could let
    // activePeriod.start > now silently rule a future alert "active".
    const start = period.start ? normalizeTimestamp(period.start) : 0;
    if (!Number.isFinite(start)) {
        console.warn(`[alerts] dropping malformed activePeriod.start for alert ${alert.id}:`, period.start);
        return;
    }
    // The same `entry` object is pushed by reference into both
    // masterAlertsData[routeCode] and masterStopAlertsData[stopId] below,
    // so a single alert spanning N routes × M stops uses one heap object,
    // not N×M copies. **Callers must treat entries as immutable** — mutating
    // an entry from one lookup path silently changes it on every other path.
    const entry = {
        id:          alert.id ?? '',
        effect:      alert.effect ?? '',
        header:      alert.headerText ?? '',
        description: alert.descriptionText ?? '',
        activePeriod: { start, end },
        stopIds:     [...stopIdSet],
    };

    if (isAccessibility) {
        // Accessibility alerts only land in the per-stop accessibility map.
        // No per-stop targeting (after fallback) → nothing to attach to.
        if (stopIdSet.size === 0) return;
        for (const stopId of stopIdSet) {
            if (!window.masterStopAccessibilityAlertsData.has(stopId)) {
                window.masterStopAccessibilityAlertsData.set(stopId, []);
            }
            const aList = window.masterStopAccessibilityAlertsData.get(stopId);
            const aIdx  = aList.findIndex(a => a.id === entry.id);
            if (aIdx >= 0) aList[aIdx] = entry;
            else aList.push(entry);
        }
        return;
    }

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

/**
 * Compose the full hover-tooltip text for a single alert. Format:
 *
 *     <prefix>: <header>
 *     <description>
 *
 * Empty / redundant lines are dropped — when description is missing,
 * matches the header exactly, or is a prefix of header (Metro feeds
 * sometimes truncate header from description), only the title line is
 * shown. The blank line between title and body uses `\n\n`; the
 * `.alert-tooltip` rule in styles/index-style.css sets `white-space:
 * pre-line` so the line breaks render.
 *
 * Used at four sites — legend route badges (this file's
 * updateAlertBadges, x2 — create + update path), and station map-badge
 * tooltips for alerts and accessibility (stations.js _collectBoardingState).
 *
 * @param {string} prefix   "Service issue", "Elevator", … or whatever
 *                          the call site uses to label this alert type.
 * @param {Object} alert    {header, description, …} — alert entry from
 *                          masterAlertsData / masterStopAlertsData /
 *                          masterStopAccessibilityAlertsData.
 * @returns {string} formatted text (single line if no body, multi-line otherwise)
 */
export function buildAlertTooltipText(prefix, alert) {
    const header = (alert?.header ?? '').trim();
    const body   = (alert?.description ?? '').trim();
    const title  = `${prefix}: ${header}`;
    if (!body)                  return title;
    if (body === header)        return title;     // description repeats header verbatim
    if (header && body.includes(header)) return `${prefix}: ${body}`;  // body is a superset
    return `${title}\n\n${body}`;
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
    // Inner body wrapper hosts the scroll context when pinned. The outer
    // .alert-tooltip must stay overflow:visible so the ::before/::after
    // carets aren't clipped and don't drag a permanent scrollbar onto
    // short content — see styles/index-style.css `.alert-tooltip.is-pinned`.
    const body = document.createElement('div');
    body.className = 'alert-tooltip-body';
    _alertTipEl.appendChild(body);
    document.body.appendChild(_alertTipEl);
    return _alertTipEl;
}

function _hideAlertTooltip() {
    if (!_activeTooltip) return;
    _alertTipEl?.classList.remove('is-visible');
    _alertTipEl?.classList.remove('is-pinned');
    _activeTooltip.wrap.classList.remove('is-open');
    _activeTooltip = null;
}

/**
 * Open or refresh the tooltip anchored to `wrap`.
 * @param {HTMLElement} wrap  The .alert-icon-wrap / .station-*-badge-wrap.
 * @param {Object} [opts]
 * @param {boolean} [opts.pinned=false]  When true, tooltip sticks past
 *   mouseleave (rider can scroll body / select text) until dismissed by
 *   another click on the badge, click outside, or Escape.
 */
function _showAlertTooltip(wrap, { pinned = false } = {}) {
    const text = wrap.dataset.alertText;
    if (!text) return;
    if (_activeTooltip && _activeTooltip.wrap !== wrap) _hideAlertTooltip();

    const tip = _getOrCreateTip();
    // Write text into the inner body wrapper, not the outer tip — see
    // _getOrCreateTip for the scroll-context rationale.
    const body = tip.firstElementChild;
    body.textContent = text;
    tip.classList.add('is-visible');
    tip.classList.toggle('is-pinned', pinned);
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

    _activeTooltip = { wrap, tip, pinned };
}

// One-time global listeners (registered on first call to updateAlertBadges).
// `_mapBound` is split out because window.map may not exist on the first
// call — we keep retrying just the map binding on subsequent ticks until
// it succeeds.
let _alertTooltipBound = false;
let _mapBound = false;
function _bindAlertTooltipGlobals() {
    if (_alertTooltipBound) {
        _bindMapReflow();
        return;
    }
    _alertTooltipBound = true;
    const dismiss = (e) => {
        if (!_activeTooltip) return;
        // Clicks inside the badge wrap are handled by its own click listener
        // (toggleTap below). Clicks inside the pinned tooltip itself
        // (scrolling, selecting text) must NOT dismiss either. Anything else
        // is "outside" and closes the tooltip.
        if (_activeTooltip.wrap.contains(e.target)) return;
        if (_activeTooltip.tip?.contains(e.target)) return;
        _hideAlertTooltip();
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('touchstart', dismiss, { passive: true });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') _hideAlertTooltip();
    });
    // Reposition on scroll/resize so the tooltip tracks its anchor.
    // Also follow MapLibre map pan/zoom — station-badge wraps live inside
    // marker DOM that MapLibre transforms on every map move, so without
    // these listeners a pinned tooltip stays put while the badge slides
    // away beneath the rider's cursor. We preserve `pinned` across reflow
    // so a tracked pinned tooltip doesn't quietly revert to hover mode.
    const reflow = () => {
        if (!_activeTooltip) return;
        _showAlertTooltip(_activeTooltip.wrap, { pinned: _activeTooltip.pinned });
    };
    window.addEventListener('scroll', reflow, { passive: true, capture: true });
    window.addEventListener('resize', reflow);
    _bindMapReflow();
}

// Hook MapLibre's pan/zoom events so a pinned tooltip on a station-marker
// badge tracks the badge as the map moves. window.map may not exist on
// the first call (alerts.js can load before map.js boots), so retry on
// every subsequent _bindAlertTooltipGlobals call until it succeeds.
function _bindMapReflow() {
    if (_mapBound) return;
    if (!window.map?.on) return;
    _mapBound = true;
    const mapReflow = () => {
        if (!_activeTooltip) return;
        _showAlertTooltip(_activeTooltip.wrap, { pinned: _activeTooltip.pinned });
    };
    window.map.on('move', mapReflow);
    window.map.on('zoom', mapReflow);
}

export function wireAlertBadge(wrap, badge) {
    if (badge._alertWired) return;
    badge._alertWired = true;
    badge.setAttribute('role', 'button');
    badge.setAttribute('tabindex', '0');

    // Hover anywhere on the icon wrap reveals the tooltip in its transient
    // (unpinned) form. mouseleave hides it UNLESS the rider has pinned it
    // via click — pinned tooltips persist until dismissed explicitly.
    // Touch devices fire a synthetic mouseenter after tap, but we drive
    // touch through click on the badge; the synthetic hover is harmless.
    wrap.addEventListener('mouseenter', () => {
        if (_activeTooltip?.wrap === wrap && _activeTooltip.pinned) return;
        _showAlertTooltip(wrap);
    });
    wrap.addEventListener('mouseleave', () => {
        if (_activeTooltip?.wrap !== wrap) return;
        if (_activeTooltip.pinned) return;                              // pinned: stay open
        if (wrap.contains(document.activeElement)) return;              // keyboard focus: stay open
        _hideAlertTooltip();
    });
    badge.addEventListener('focus', () => _showAlertTooltip(wrap));
    badge.addEventListener('blur',  () => {
        if (_activeTooltip?.wrap === wrap && !_activeTooltip.pinned) _hideAlertTooltip();
    });

    // Click on the badge pins the tooltip. If already pinned, a second
    // click unpins and closes. stopPropagation() prevents both the row's
    // click handler (route filter) and the global outside-tap dismiss
    // from firing on this same event.
    const togglePin = (e) => {
        e.stopPropagation();
        const alreadyPinned = _activeTooltip?.wrap === wrap && _activeTooltip.pinned;
        if (alreadyPinned) _hideAlertTooltip();
        else               _showAlertTooltip(wrap, { pinned: true });
    };
    badge.addEventListener('click', togglePin);
    // touchstart bubbles to the document-level dismiss handler too — stop it
    // so a tap on the badge doesn't trigger an immediate hide-then-show race.
    badge.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
    badge.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(e); }
    });
}

/**
 * Return currently-active alerts targeting a specific stop, filtered by current time.
 * Includes both feed-side per-stop alerts (informedEntities listed this stop
 * explicitly) and text-mining matches where the feed gave only a route-level
 * informedEntity but the description mentions this stop's name. Pure route-wide
 * alerts (no stop-name match, no per-stop informedEntity) are not included.
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
 * Return currently-active accessibility (elevator/escalator) outages targeting
 * a specific stop. Returned alerts have `effect === 'ACCESSIBILITY_ISSUE'` or
 * mention elevator/escalator in their text. Disjoint from getActiveStopAlerts.
 * @param {string} stopId  Canonical stop ID, e.g. "80111"
 * @returns {Alert[]} Active accessibility alerts (may be empty)
 */
export function getActiveStopAccessibilityAlerts(stopId) {
    if (!window.masterStopAccessibilityAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterStopAccessibilityAlertsData.get(normalizeStopId(String(stopId))) ?? [])
        .filter(a => a.activePeriod.start <= now && a.activePeriod.end > now);
}

/**
 * Classify an accessibility alert as elevator, escalator, both, or unknown
 * by scanning header + description for the word that names the facility.
 * Anchored on both sides (`\b…s?\b`) so plural matches but arbitrary letter
 * continuations don't — "elevators" and "escalator's" classify, "elevator123"
 * or "escalatorish" don't. Real Metro feed text has never mixed digits into
 * facility words, but the tight anchor makes the rule explicit.
 *
 * @param {string} [headerText='']
 * @param {string} [descriptionText='']
 * @returns {'elevator'|'escalator'|'both'|'unknown'}
 */
export function classifyAccessibilityAlert(headerText = '', descriptionText = '') {
    const text = `${headerText} ${descriptionText}`.toLowerCase();
    const hasElevator  = /\belevators?\b/.test(text);
    const hasEscalator = /\bescalators?\b/.test(text);
    if (hasElevator && hasEscalator) return 'both';
    if (hasElevator)  return 'elevator';
    if (hasEscalator) return 'escalator';
    return 'unknown';
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
            // Per-alert blocks separated by a blank line so multi-alert routes
            // remain scannable. Each block carries header + description via
            // buildAlertTooltipText.
            const tipText = alerts
                .map(a => buildAlertTooltipText(STRIP_EFFECT_LABELS[a.effect], a))
                .join('\n\n');
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
            const tipText = alerts
                .map(a => buildAlertTooltipText(STRIP_EFFECT_LABELS[a.effect], a))
                .join('\n\n');
            wrap.dataset.alertText = tipText;
            badge.setAttribute('aria-label', `Service alert: ${tipText}`);
        }
    });
}

