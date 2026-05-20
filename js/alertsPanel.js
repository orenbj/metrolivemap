/**
 * Service-alerts panel — the slide-in card opened by the "Alerts" button in
 * the top-right control group (js/map.js AlertsControl). Renders every
 * currently-active alert from window.masterAlertsData, grouped by route.
 *
 * Data flow:
 *   alerts.js  →  masterAlertsData  +  CustomEvent('alertsUpdated')
 *                 ↑                    ↓
 *                 │                  this module re-renders while the panel
 *                 │                  is open. While closed we skip render
 *                 │                  work entirely (the event still fires
 *                 │                  for the legend badges).
 *                 │
 *   open click ── │ ──► render once  ──► panel visible
 *
 * Imports stay one-way (alertsPanel → alerts); we never import back into
 * alerts.js. Route ordering, dedup, and badge styling live here so the
 * presentation concerns don't leak into the polling/normalization module.
 */

import { routeIcons, routeHexColors, METRO_ROUTE_CODES } from './config.js';
import {
    STRIP_EFFECT_LABELS,
    getActiveAlerts,
    normalizeAlertProse,
    effectSeverity,
    maxSeverity,
} from './alerts.js';

// Friendly line letter per route_code. Mirrors the table in stations.js;
// duplicated here to keep alertsPanel independent of stations.js (which
// has its own heavy deps). If a third site ever needs this map, hoist
// to config.js. For now two copies of ~10 entries is cheaper than the
// import-graph cost.
const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C',
    '804': 'E', '805': 'D',
    '807': 'K', '901': 'G',
    // J Line is 910 (rapid) + 950 (commuter); both render as "J".
    '910': 'J', '950': 'J',
};

// Display order: rail lines first (A B C D E K), then bus/busway (G J).
// Independent of routeCode numeric order — the rider expects "A Line"
// at top regardless of feed sort order. Routes not listed sort to the
// end by routeCode.
const ROUTE_DISPLAY_ORDER = ['801', '802', '803', '805', '804', '807', '901', '910', '950'];

/**
 * Effect-level dedup that preserves all distinct descriptions seen for the
 * same effect code. Mirrors the helper in stations.js but kept local to
 * avoid a stations.js → alerts.js → stations.js circular import (stations
 * already imports from alerts).
 *
 * @param {Array<{effect:string, description?:string}>} alerts
 * @returns {Array<{effect:string, header:string, _count:number, _descriptions:string[]}>}
 */
function _dedupeByEffect(alerts) {
    const byEffect = new Map();
    for (const a of alerts) {
        const desc = (a.description ?? '').trim();
        const existing = byEffect.get(a.effect);
        if (!existing) {
            byEffect.set(a.effect, { ...a, _count: 1, _descriptions: desc ? [desc] : [] });
            continue;
        }
        existing._count++;
        if (desc && !existing._descriptions.includes(desc)) {
            existing._descriptions.push(desc);
        }
    }
    return [...byEffect.values()];
}

/**
 * Gather every active alert across every route Metro publishes, organised
 * for the panel renderer. Returns an array of { routeCode, alerts[] }
 * groups in display order (rail first, then bus/busway). Routes with zero
 * active alerts are omitted. Exported for unit tests.
 *
 * @returns {Array<{routeCode: string, alerts: Array}>}
 */
export function getActiveAlertsByRoute() {
    const groups = [];
    const seen = new Set();
    // First pass: routes in our preferred display order.
    for (const rc of ROUTE_DISPLAY_ORDER) {
        if (!METRO_ROUTE_CODES.has(rc)) continue;
        const list = getActiveAlerts(rc);
        if (list.length === 0) continue;
        groups.push({ routeCode: rc, alerts: _dedupeByEffect(list) });
        seen.add(rc);
    }
    // Second pass: any route from the feed we didn't already list (defensive
    // — METRO_ROUTE_CODES could grow without ROUTE_DISPLAY_ORDER being
    // updated; an unknown route still surfaces rather than vanishing).
    if (window.masterAlertsData) {
        const tail = [];
        for (const rc of window.masterAlertsData.keys()) {
            if (seen.has(rc)) continue;
            const list = getActiveAlerts(rc);
            if (list.length === 0) continue;
            tail.push({ routeCode: rc, alerts: _dedupeByEffect(list) });
        }
        tail.sort((a, b) => a.routeCode.localeCompare(b.routeCode));
        groups.push(...tail);
    }
    return groups;
}

/**
 * Total active-alert count summed across every route, for the header badge.
 * Counts distinct alerts (post dedup) so the badge matches what the rider
 * actually sees in the panel.
 *
 * @returns {number}
 */
export function getTotalActiveAlertCount() {
    return getActiveAlertsByRoute().reduce((sum, g) => sum + g.alerts.length, 0);
}

/**
 * Highest severity present across every active alert in the system.
 * Drives the toggle-button dot color and the panel-header count badge.
 * Returns null when no alerts exist so the indicator stays inert.
 *
 * @returns {'severe'|'moderate'|null}
 */
export function getOverallSeverity() {
    const groups = getActiveAlertsByRoute();
    const all    = groups.flatMap(g => g.alerts);
    return maxSeverity(all);
}

// ── DOM render ──────────────────────────────────────────────────────────────

/**
 * Render a single route group as HTML. Returns an HTMLElement to append to
 * the panel body. Each route header carries the brand color bar (matches the
 * legend rows) and the line's icon + letter. Each alert below is rendered
 * with the structured prefix → title → description pattern that the
 * existing alert tooltips use, so the visual vocabulary is consistent.
 *
 * @param {{routeCode: string, alerts: Array}} group
 * @returns {HTMLElement}
 */
function _renderRouteGroup(group) {
    const { routeCode, alerts } = group;
    const letter = ROUTE_LETTER[routeCode] ?? routeCode;
    const color  = routeHexColors[routeCode] ?? '#888';
    const icon   = routeIcons[routeCode];

    const groupEl = document.createElement('section');
    groupEl.className = 'alerts-route-group';
    groupEl.dataset.route = routeCode;

    const header = document.createElement('header');
    header.className = 'alerts-route-header';
    header.style.borderLeftColor = color;
    if (icon) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = `${letter} Line icon`;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.width = 24;
        img.height = 24;
        header.appendChild(img);
    }
    const titleEl = document.createElement('span');
    titleEl.className = 'alerts-route-name';
    titleEl.textContent = `${letter} Line`;
    header.appendChild(titleEl);

    const badge = document.createElement('span');
    badge.className = 'alerts-route-count';
    badge.textContent = String(alerts.length);
    header.appendChild(badge);

    groupEl.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'alerts-route-list';
    for (const alert of alerts) {
        list.appendChild(_renderAlertItem(alert));
    }
    groupEl.appendChild(list);

    return groupEl;
}

/**
 * Render one deduped alert as a list item. Surfaces every distinct
 * description seen for the effect (the dedup helper preserves them in
 * `_descriptions`) so two same-effect alerts with different bodies both
 * render — see the dedup audit (PR #206).
 *
 * @param {Object} alert  Deduped alert with _count and _descriptions[]
 * @returns {HTMLLIElement}
 */
function _renderAlertItem(alert) {
    const li = document.createElement('li');
    li.className = 'alerts-item';
    li.dataset.severity = effectSeverity(alert.effect);

    const effectLabel = STRIP_EFFECT_LABELS[alert.effect] ?? 'Service alert';

    // If the dedup found multiple distinct descriptions for the same effect,
    // render each as its own block under one shared effect chip — matches
    // the badge tooltip pattern (stations.js _collectBoardingState).
    const descs = alert._descriptions?.length
        ? alert._descriptions
        : [alert.description ?? ''];
    // We still need to title-case shouting headers and normalize whitespace
    // per the audit; route the alert's own header through normalizeAlertProse
    // once and reuse the result for every description block (the header
    // doesn't change, only the body might differ).
    const { header: normalizedHeader } = normalizeAlertProse(alert);

    descs.forEach((body, idx) => {
        const block = document.createElement('div');
        block.className = 'alerts-block';

        // Only the first block carries the effect chip — subsequent blocks
        // are sub-descriptions of the same effect category and should read
        // as a continuation, not a fresh effect.
        if (idx === 0) {
            const chip = document.createElement('span');
            chip.className = 'alerts-effect-chip';
            chip.dataset.severity = effectSeverity(alert.effect);
            chip.textContent = effectLabel;
            block.appendChild(chip);
        }

        if (normalizedHeader && idx === 0) {
            const title = document.createElement('div');
            title.className = 'alerts-title';
            title.textContent = normalizedHeader;
            block.appendChild(title);
        }

        // Normalize the description through the same prose pipeline alerts.js
        // uses for tooltip blocks — picks up am/pm canonicalization, header-
        // duplicate stripping, and whitespace collapse.
        const { body: normalizedBody } = normalizeAlertProse({
            header: normalizedHeader,
            description: body,
        });
        if (normalizedBody) {
            const desc = document.createElement('p');
            desc.className = 'alerts-desc';
            desc.lang = 'en';   // browser-translate hook (matches station popups)
            desc.textContent = normalizedBody;
            block.appendChild(desc);
        }

        // Render active window beneath each block (the Active: line existing
        // tooltips show). Only on the FIRST block since the activePeriod
        // belongs to the alert as a whole, not the individual description.
        if (idx === 0 && alert.activePeriod) {
            const activeLine = _formatActiveWindow(alert.activePeriod);
            if (activeLine) {
                const meta = document.createElement('div');
                meta.className = 'alerts-active';
                meta.textContent = activeLine;
                block.appendChild(meta);
            }
        }

        li.appendChild(block);
    });

    return li;
}

/**
 * Format an alert's activePeriod into a human "Active: …" line. Open-ended
 * alerts (no end timestamp / Infinity) render as "Active: ongoing" rather
 * than a misleading start-only string. Returns empty when neither bound is
 * usable so the caller can skip rendering the line entirely.
 *
 * @param {{start: number, end: number}} period
 * @returns {string}
 */
function _formatActiveWindow(period) {
    const { start, end } = period ?? {};
    const hasStart = Number.isFinite(start) && start > 0;
    const hasEnd   = Number.isFinite(end);
    if (!hasStart && !hasEnd) return '';

    const fmt = ts => new Date(ts * 1000).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });

    if (hasStart && hasEnd) return `Active: ${fmt(start)} – ${fmt(end)}`;
    if (hasStart)           return `Active from: ${fmt(start)} (ongoing)`;
    return 'Active: ongoing';
}

// ── Panel open/close lifecycle ──────────────────────────────────────────────

let _wired = false;
let _lastRenderedAt = 0;

/**
 * Re-render the panel from current masterAlertsData. Cheap to call but
 * skipped when the panel is hidden — the alertsUpdated CustomEvent fires
 * every poll (every ~120 s) and we don't want layout work when nothing
 * will be seen.
 */
export function renderAlertsPanel() {
    const panel = document.getElementById('alerts-panel');
    if (!panel || panel.classList.contains('hidden')) return;

    const body  = document.getElementById('alerts-panel-body');
    const count = document.getElementById('alerts-panel-count');
    const updated = document.getElementById('alerts-panel-updated');
    if (!body || !count) return;

    body.replaceChildren();
    const groups = getActiveAlertsByRoute();
    const total  = groups.reduce((sum, g) => sum + g.alerts.length, 0);
    const overallSev = getOverallSeverity();
    count.textContent = String(total);
    count.classList.toggle('is-zero', total === 0);
    if (overallSev) count.dataset.severity = overallSev;
    else delete count.dataset.severity;

    if (groups.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'alerts-empty';
        empty.textContent = window.masterAlertsData
            ? 'No active service alerts.'
            : 'Loading alerts…';
        body.appendChild(empty);
    } else {
        for (const g of groups) body.appendChild(_renderRouteGroup(g));
    }

    _lastRenderedAt = Date.now();
    if (updated) {
        updated.textContent = `Updated ${new Date(_lastRenderedAt).toLocaleTimeString(undefined, {
            hour: 'numeric', minute: '2-digit',
        })}`;
    }
}

export function openAlertsPanel() {
    const panel    = document.getElementById('alerts-panel');
    const backdrop = document.getElementById('alerts-panel-backdrop');
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    backdrop?.classList.remove('hidden');
    backdrop?.setAttribute('aria-hidden', 'false');
    renderAlertsPanel();
    // Defer focus to next frame so the show transition can start before the
    // focus-induced scroll into view; otherwise mobile Safari sometimes
    // scrolls the page before the panel finishes sliding in.
    requestAnimationFrame(() => panel.focus({ preventScroll: true }));
    document.dispatchEvent(new CustomEvent('alertsPanelOpened'));
}

export function closeAlertsPanel() {
    const panel    = document.getElementById('alerts-panel');
    const backdrop = document.getElementById('alerts-panel-backdrop');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
    document.dispatchEvent(new CustomEvent('alertsPanelClosed'));
}

export function toggleAlertsPanel() {
    const panel = document.getElementById('alerts-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) openAlertsPanel();
    else closeAlertsPanel();
}

export function isAlertsPanelOpen() {
    const panel = document.getElementById('alerts-panel');
    return !!panel && !panel.classList.contains('hidden');
}

/**
 * Idempotent wire-up — close button, backdrop click, Escape key, and the
 * `alertsUpdated` listener that refreshes content while the panel is open.
 * Called once from main.js after DOM is ready.
 */
export function initAlertsPanel() {
    if (_wired) return;
    _wired = true;

    const closeBtn = document.getElementById('alerts-panel-close');
    const backdrop = document.getElementById('alerts-panel-backdrop');
    closeBtn?.addEventListener('click', closeAlertsPanel);
    backdrop?.addEventListener('click', closeAlertsPanel);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isAlertsPanelOpen()) closeAlertsPanel();
    });

    // Live updates while open. Polling interval is ~120 s so this is cheap.
    document.addEventListener('alertsUpdated', () => {
        if (isAlertsPanelOpen()) renderAlertsPanel();
    });
}

// Re-export so unrelated callers (the IControl button handler in map.js)
// can import a single symbol without pulling everything.
export const _internals = { _dedupeByEffect, _formatActiveWindow };
