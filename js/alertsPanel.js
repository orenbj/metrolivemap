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

import { routeIcons, routeHexColors, METRO_ROUTE_CODES, ROUTE_LETTER } from './config.js';
import {
    STRIP_EFFECT_LABELS,
    getActiveAlerts,
    getActiveStopAccessibilityAlerts,
    normalizeAlertProse,
    classifyAccessibilityAlert,
    effectSeverity,
    formatActivePeriodLine,
    maxSeverity,
    getAlertsFeedHealth,
} from './alerts.js';
import { cleanStationName, stationNameKey } from './utils.js';
import { setActivePopup, notifyPopupClosed } from './popups.js';

// Display order: rail lines first (A B C D E K), then bus/busway (G J).
// Independent of routeCode numeric order — the rider expects "A Line"
// at top regardless of feed sort order. Routes not listed sort to the
// end by routeCode.
const ROUTE_DISPLAY_ORDER = ['801', '802', '803', '805', '804', '807', '901', '910', '950'];

/**
 * Collapse TRUE duplicates only — alerts sharing the same effect code, header
 * AND description. Genuinely distinct alerts on one route (e.g. two different
 * DETOURs with different locations and end dates, like the J Line's Front St
 * and Sepulveda detours) stay as separate entries, so each renders as its own
 * row and the route-count badge reflects the real number.
 *
 * Earlier this keyed on `effect` alone, which merged distinct detours into a
 * single entry rendered with an indented continuation block and an undercount
 * ("1" when there were two). `_count` tracks how many identical copies the
 * feed published for this exact alert.
 *
 * Note: stations.js has its own effect-level dedup for the station-popup
 * tooltips — a separate surface with different needs — intentionally left as-is.
 *
 * @param {Array<{effect:string, header?:string, description?:string}>} alerts
 * @returns {Array<{effect:string, header:string, _count:number}>}
 */
function _dedupeAlerts(alerts) {
    const byKey = new Map();
    for (const a of alerts) {
        const header = (a.header ?? '').trim();
        const desc   = (a.description ?? '').trim();
        const key    = JSON.stringify([a.effect, header, desc]);
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { ...a, _count: 1 });
            continue;
        }
        existing._count++;   // identical copy — collapse, bump the tally
    }
    return [...byKey.values()];
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
        groups.push({ routeCode: rc, alerts: _dedupeAlerts(list) });
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
            tail.push({ routeCode: rc, alerts: _dedupeAlerts(list) });
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
 * Highest severity present across active SERVICE alerts only. Drives the
 * toggle-button dot color on the map control. Accessibility alerts are
 * intentionally EXCLUDED — they surface solely through their own per-station
 * accessibility icons, never the global alerts-button color (so a moderate
 * service picture isn't reddened by an elevator outage the rider can already
 * see on the relevant station). Returns null when no service alerts exist so
 * the indicator stays inert.
 *
 * @returns {'severe'|'moderate'|null}
 */
export function getOverallSeverity() {
    const groups = getActiveAlertsByRoute();
    return maxSeverity(groups.flatMap(g => g.alerts));
}

/**
 * Gather every active accessibility alert across every stop the system
 * publishes. Returns an array of `{ stopId, stopName, alerts }` groups
 * sorted alphabetically by station name. Empty stops are omitted, and
 * alerts within a station are deduped by id+header so a single elevator
 * outage reported under multiple stop entries doesn't double up.
 *
 * @returns {Array<{stopId: string, stopName: string, alerts: Array}>}
 */
export function getActiveAccessibilityByStation() {
    const groups = [];
    if (!window.masterStopAccessibilityAlertsData) return groups;
    const seenStations = new Set();
    for (const stopId of window.masterStopAccessibilityAlertsData.keys()) {
        const alerts = getActiveStopAccessibilityAlerts(stopId);
        if (alerts.length === 0) continue;
        // Multiple stop IDs can share the same physical station (suffixed
        // entrance IDs like 80101A / 80101B point to the same platform).
        // Collapse by the normalized station name so the panel doesn't
        // list "Wilshire/Vermont" three times under different stop keys.
        const stop = window.masterStopsData?.[stopId];
        const rawName = stop?.name ?? `Stop ${stopId}`;
        const cleanName = cleanStationName(rawName);
        if (seenStations.has(cleanName)) {
            const existing = groups.find(g => g.stopName === cleanName);
            for (const a of alerts) {
                if (!existing.alerts.find(x => x.id === a.id)) existing.alerts.push(a);
            }
            continue;
        }
        seenStations.add(cleanName);
        groups.push({ stopId: String(stopId), stopName: cleanName, alerts: [...alerts] });
    }
    groups.sort((a, b) => a.stopName.localeCompare(b.stopName));
    return groups;
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
 * True when a candidate alert title carries no information beyond the line
 * name(s) already shown in the route-group header — e.g. "G Line", "C/K Lines",
 * "Metro G Line (Orange) 901", "Metro J Line (Silver) 910/950". Such titles are
 * pure redundancy under a header that already says "G Line" / "C Line", so the
 * service-alert renderer suppresses them (mirrors the station-name suppression
 * the accessibility renderer already does).
 *
 * Heuristic: strip the decorations that make up a Metro line name — the words
 * "Metro"/"Line(s)", parenthetical color names ("(Orange)"), route numbers,
 * single-letter line codes, and separators — and if nothing substantive
 * remains, the title was only ever naming the line. A real title like
 * "Elevator outage at Civic Center" survives the stripping and is kept.
 *
 * @param {string} title
 * @returns {boolean}
 */
function _isLineNameOnly(title) {
    if (!title) return false;
    let s = title.toLowerCase();
    s = s.replace(/\([^)]*\)/g, ' ');          // (orange), (silver), …
    s = s.replace(/\b(metro|lines?)\b/g, ' ');  // "Metro", "Line", "Lines"
    s = s.replace(/\b\d{1,4}\b/g, ' ');         // route numbers (901, 910/950, …)
    s = s.replace(/\b[a-z]\b/g, ' ');           // single-letter line codes (G, C, K, J)
    s = s.replace(/[/,&.-]| and /g, ' ');     // separators
    return s.replace(/\s+/g, '').length === 0;
}

/**
 * Render one deduped alert as a list item: effect chip, title, body, and the
 * Active: window. Each distinct alert is now its own item (the dedup collapses
 * only true duplicates), so there's a single block per item — no indented
 * continuation blocks. Two same-route alerts with different bodies render as
 * two sibling rows, which is what the route-count badge counts.
 *
 * The title is suppressed when it's just the line name restated
 * (`_isLineNameOnly`) — the group header already shows it, so rendering
 * "Metro G Line (Orange) 901" under the "G Line" header is pure noise. The
 * effect chip + description body still carry the alert's content.
 *
 * @param {Object} alert  Deduped alert (effect, header, description, activePeriod)
 * @returns {HTMLLIElement}
 */
function _renderAlertItem(alert) {
    const li = document.createElement('li');
    li.className = 'alerts-item';
    li.dataset.severity = effectSeverity(alert.effect);

    const effectLabel = STRIP_EFFECT_LABELS[alert.effect] ?? 'Service alert';

    const block = document.createElement('div');
    block.className = 'alerts-block';

    const chip = document.createElement('span');
    chip.className = 'alerts-effect-chip';
    chip.dataset.severity = effectSeverity(alert.effect);
    chip.textContent = effectLabel;
    // Active window sits in the chip row, right-aligned — same placement as
    // the station-popup banner header.
    block.appendChild(_chipRow(chip, alert));

    // Normalize header + body through the same prose pipeline alerts.js uses
    // for tooltip blocks — picks up am/pm canonicalization, header-duplicate
    // stripping, and whitespace collapse.
    const { header: normalizedHeader, body: normalizedBody } = normalizeAlertProse(alert);

    if (normalizedHeader && !_isLineNameOnly(normalizedHeader)) {
        const title = document.createElement('div');
        title.className = 'alerts-title';
        title.textContent = normalizedHeader;
        block.appendChild(title);
    }

    if (normalizedBody) {
        const desc = document.createElement('p');
        desc.className = 'alerts-desc';
        desc.lang = 'en';   // browser-translate hook (matches station popups)
        desc.textContent = normalizedBody;
        block.appendChild(desc);
    }

    li.appendChild(block);
    return li;
}

/**
 * Build the chip header row: the effect/facility chip plus, when the alert
 * carries a usable activePeriod, a right-aligned "Active: …" window. Mirrors
 * the station-popup banner header so the timeframe reads at a glance instead
 * of trailing the description body.
 *
 * @param {HTMLSpanElement} chip   Pre-built effect/facility chip
 * @param {Object} alert           Alert with optional activePeriod
 * @returns {HTMLDivElement}
 */
function _chipRow(chip, alert) {
    const row = document.createElement('div');
    row.className = 'alerts-chip-row';
    row.appendChild(chip);
    if (alert.activePeriod) {
        const activeLine = _formatActiveWindow(alert.activePeriod);
        if (activeLine) {
            const meta = document.createElement('span');
            meta.className = 'alerts-active';
            meta.textContent = activeLine;
            row.appendChild(meta);
        }
    }
    return row;
}

/**
 * Format an alert's activePeriod into a human "Active: …" line. Thin adapter
 * over alerts.js `formatActivePeriodLine` (period object → start/end args) so
 * the panel renders the SAME weekday + lowercase am/pm + LA-pinned format as
 * the station-popup banner — one formatter, one visual vocabulary across every
 * surface. Returns empty when neither bound is usable so the caller can skip
 * rendering the line entirely.
 *
 * @param {{start: number, end: number}} period
 * @returns {string}
 */
function _formatActiveWindow(period) {
    const { start, end } = period ?? {};
    return formatActivePeriodLine(
        Number.isFinite(start) && start > 0 ? start : 0,
        Number.isFinite(end) ? end : Infinity,
    );
}

/**
 * Render one accessibility-alert group (per station). Looks similar to a
 * route group but anchored on the station name + facility classification
 * (elevator/escalator/both) rather than a route brand.
 *
 * @param {{stopId: string, stopName: string, alerts: Array}} group
 * @returns {HTMLElement}
 */
function _renderAccessibilityGroup(group) {
    const { stopId, stopName, alerts } = group;
    const groupEl = document.createElement('section');
    groupEl.className = 'alerts-route-group alerts-access-group';
    groupEl.dataset.stopId = stopId;

    const header = document.createElement('header');
    header.className = 'alerts-route-header';
    // Accessibility-blue brand stripe to distinguish from route-colored
    // service groups in the eye, even though severity drives the chip color.
    header.style.borderLeftColor = '#0072CE';
    const glyph = document.createElement('span');
    glyph.className = 'alerts-access-glyph';
    glyph.textContent = '♿';
    glyph.setAttribute('aria-hidden', 'true');
    header.appendChild(glyph);

    const titleEl = document.createElement('span');
    titleEl.className = 'alerts-route-name';
    titleEl.textContent = stopName;
    header.appendChild(titleEl);

    const badge = document.createElement('span');
    badge.className = 'alerts-route-count';
    badge.textContent = String(alerts.length);
    header.appendChild(badge);

    groupEl.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'alerts-route-list';
    for (const alert of alerts) {
        // Pass the group's station name so the per-alert renderer can
        // suppress titles that are just the station name repeated.
        list.appendChild(_renderAccessibilityItem(alert, stopName));
    }
    groupEl.appendChild(list);

    return groupEl;
}

/**
 * Render one accessibility alert as a list item. Classification drives
 * the chip label ("Elevator", "Escalator", "Elevator/escalator") and
 * the severity tier (elevator/both → severe; escalator → moderate).
 *
 * `groupStopName` (when supplied) lets us suppress the alert title when
 * it just repeats the station name above (Metro's headers are almost
 * always "STATION NAME" — under the station group that's redundant).
 *
 * @param {Object} alert
 * @param {string} [groupStopName]  Station name shown as the group header.
 * @returns {HTMLLIElement}
 */
function _renderAccessibilityItem(alert, groupStopName = '') {
    const li = document.createElement('li');
    li.className = 'alerts-item';
    // Inside the panel UI, accessibility surfaces are always BLUE (the
    // universal ♿ brand color). Severity coloring is reserved for the
    // map-side indicators (station marker corner dot, tooltips) where
    // red is doing functional warning work; mixing both palettes in the
    // menu was visually noisy. data-kind="access" → CSS overrides
    // suppress data-severity for both chip and item.
    li.dataset.kind = 'access';

    const type = classifyAccessibilityAlert(alert.header ?? '', alert.description ?? '');
    const facilityLabel = type === 'elevator'  ? 'Elevator'
                        : type === 'escalator' ? 'Escalator'
                        : type === 'both'      ? 'Elevator/escalator'
                        : 'Accessibility';

    const { header: normalizedHeader, body: normalizedBody } = normalizeAlertProse(alert);

    const block = document.createElement('div');
    block.className = 'alerts-block';

    const chip = document.createElement('span');
    chip.className = 'alerts-effect-chip';
    chip.dataset.kind = 'access';
    chip.textContent = facilityLabel;
    block.appendChild(_chipRow(chip, alert));

    // Drop the header when it just repeats the station name above. The
    // accessibility tab groups by station, so the group header already
    // shows the canonical name; Metro's alert headers are almost always
    // a station name in some casing ("HOLLYWOOD/HIGHLAND STATION",
    // "WILSHIRE/NORMANDIE", "Pershing Square Station") which would render
    // as a redundant subtitle. stationNameKey() normalizes both sides so
    // every spelling matches.
    const groupKey  = stationNameKey(groupStopName);
    const headerKey = stationNameKey(normalizedHeader);
    const titleIsStationName = headerKey && groupKey && headerKey === groupKey;
    if (normalizedHeader && !titleIsStationName) {
        const title = document.createElement('div');
        title.className = 'alerts-title';
        title.textContent = normalizedHeader;
        block.appendChild(title);
    }
    if (normalizedBody) {
        const desc = document.createElement('p');
        desc.className = 'alerts-desc';
        desc.lang = 'en';
        desc.textContent = normalizedBody;
        block.appendChild(desc);
    }

    li.appendChild(block);
    return li;
}

// ── Panel open/close lifecycle ──────────────────────────────────────────────

let _wired = false;
let _lastRenderedAt = 0;
// Active tab persists across re-renders so the alertsUpdated poll doesn't
// snap the user back to "service" mid-read.
let _activeTab = 'service';

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

    // Refresh the per-tab counters (always — even when viewing the other
    // tab — so the badge accurately surfaces "there's something on the
    // other tab too").
    const serviceGroups = getActiveAlertsByRoute();
    const serviceTotal  = serviceGroups.reduce((sum, g) => sum + g.alerts.length, 0);
    const accessGroups  = getActiveAccessibilityByStation();
    const accessTotal   = accessGroups.reduce((sum, g) => sum + g.alerts.length, 0);

    _setTabCount('service', serviceTotal);
    _setTabCount('access',  accessTotal);

    // Header badge shows the count of the ACTIVE tab. Color depends on
    // which tab is active:
    //   - service → severity from service alerts (amber/red)
    //   - access  → always BLUE (matches the rest of the access tab)
    // The toggle-button dot on the map control (getOverallSeverity) reflects
    // SERVICE alerts only — accessibility alerts never tint it, they show up
    // through their own per-station accessibility icons instead.
    const activeTotal = _activeTab === 'access' ? accessTotal : serviceTotal;
    count.textContent = String(activeTotal);
    count.classList.toggle('is-zero', activeTotal === 0);
    if (_activeTab === 'access') {
        count.dataset.kind = 'access';
        delete count.dataset.severity;
    } else {
        delete count.dataset.kind;
        const serviceSev = maxSeverity(serviceGroups.flatMap(g => g.alerts));
        if (serviceSev && activeTotal > 0) count.dataset.severity = serviceSev;
        else delete count.dataset.severity;
    }

    // Feed health (audit D2): distinguishes "no active alerts" (loaded OK,
    // nothing active) from "couldn't load" (a silent outage that must NOT read
    // as "service is fine"). masterAlertsData is created empty in initAlerts
    // BEFORE the first fetch, so its truthiness can't tell "loaded" from
    // "loading" — drive that off everSucceeded instead.
    const health = getAlertsFeedHealth();
    const unavailable = health.failing && !health.everSucceeded;
    // `loadedSignal` is the per-tab master-data object (truthy once initAlerts
    // ran). `noActiveText` is the tab-specific "nothing active" message.
    const emptyText = (loadedSignal, noActiveText) => unavailable
        ? 'Alerts unavailable. Check your connection.'
        : (loadedSignal ? noActiveText : 'Loading alerts…');

    body.replaceChildren();
    if (_activeTab === 'access') {
        if (accessGroups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'alerts-empty';
            empty.textContent = emptyText(window.masterStopAccessibilityAlertsData, 'No active accessibility alerts.');
            body.appendChild(empty);
        } else {
            for (const g of accessGroups) body.appendChild(_renderAccessibilityGroup(g));
        }
    } else {
        if (serviceGroups.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'alerts-empty';
            empty.textContent = emptyText(window.masterAlertsData, 'No active service alerts.');
            body.appendChild(empty);
        } else {
            for (const g of serviceGroups) body.appendChild(_renderRouteGroup(g));
        }
    }

    _lastRenderedAt = Date.now();
    if (updated) {
        const fmtClock = (ms) => new Date(ms).toLocaleTimeString(undefined, {
            hour: 'numeric', minute: '2-digit',
        });
        if (unavailable) {
            updated.textContent = 'Alerts unavailable';
        } else if (health.failing && health.lastSuccessMs) {
            // Stale: last load succeeded but the latest poll(s) failed.
            updated.textContent = `Last updated ${fmtClock(health.lastSuccessMs)} · couldn't refresh`;
        } else {
            updated.textContent = `Updated ${fmtClock(_lastRenderedAt)}`;
        }
    }
}

/**
 * Update one tab's count badge. Handles the dataset.severity attribute
 * for the badge AND the parent tab so CSS can dim the badge to gray
 * when zero (matches the panel header count's is-zero behavior).
 *
 * Side effects: mutates the matching `.alerts-tab-count` element — its
 * text, `is-zero` class, and `data-kind`/`data-severity` dataset
 * attributes. Reads `getActiveAlertsByRoute()` (→ window.masterAlertsData)
 * to derive the service-tab severity. No-op when the badge is absent.
 *
 * @param {'service'|'access'} tab  Which tab's badge to update.
 * @param {number} n                Active-alert count to display.
 * @returns {void}
 */
function _setTabCount(tab, n) {
    const badge = document.querySelector(`.alerts-tab-count[data-tab-count="${tab}"]`);
    if (!badge) return;
    badge.textContent = String(n);
    badge.classList.toggle('is-zero', n === 0);
    if (tab === 'access') {
        // Accessibility surfaces in the menu are always BLUE. The
        // data-kind attribute drives the palette override; severity
        // is not propagated here so an elevator outage doesn't paint
        // the tab badge red.
        badge.dataset.kind = 'access';
        delete badge.dataset.severity;
        return;
    }
    delete badge.dataset.kind;
    // Service-tab severity drives the badge color (severe red / moderate
    // amber / no severity when zero alerts).
    const sev = maxSeverity(getActiveAlertsByRoute().flatMap(g => g.alerts));
    if (sev && n > 0) badge.dataset.severity = sev;
    else delete badge.dataset.severity;
}

/**
 * Switch to the named tab and re-render the body. Idempotent; calling
 * with the already-active tab is a no-op aside from focus management.
 *
 * @param {'service'|'access'} tab
 */
export function switchAlertsTab(tab) {
    if (tab !== 'service' && tab !== 'access') return;
    if (_activeTab === tab) return;
    _activeTab = tab;
    document.querySelectorAll('.alerts-tab').forEach(btn => {
        const isActive = btn.dataset.tab === tab;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', String(isActive));
        btn.tabIndex = isActive ? 0 : -1;
    });
    // Re-point the tabpanel's accessible name at the active tab. The HTML
    // hard-wires aria-labelledby to the Service tab, and aria-labelledby is
    // static — without this a screen reader announces the Accessibility tab's
    // panel as "Service alerts".
    const body = document.getElementById('alerts-panel-body');
    if (body) {
        body.setAttribute('aria-labelledby', tab === 'access' ? 'alerts-tab-access' : 'alerts-tab-service');
    }
    // Most screen readers do NOT announce aria-selected changes on
    // programmatic focus (arrow-key cycling within a tablist). Write to the
    // dedicated live-region in index.html so the rider hears the change.
    // Phrasing matches the visible tab label so the announcement and the
    // visual rendering stay consistent.
    const announce = document.getElementById('alerts-tab-announce');
    if (announce) {
        const label = tab === 'service' ? 'Service alerts' : 'Accessibility alerts';
        announce.textContent = `${label} tab selected`;
    }
    renderAlertsPanel();
}

/**
 * The currently-selected tab. Persists across re-renders so the
 * `alertsUpdated` poll doesn't snap the user back to "service" mid-read.
 *
 * @returns {'service'|'access'}
 */
export function getActiveTab() { return _activeTab; }

// Records the element that had focus when the panel opened, so close can
// restore it. Cleared on close so a stale reference can't be focused later.
let _focusOpener = null;

/**
 * Focusable-elements selector used by the focus-trap. Matches anything
 * keyboard-tabbable inside the panel: buttons, inputs, links with href,
 * and any explicit `tabindex>=0`. Excludes disabled and `tabindex="-1"`.
 */
const _FOCUSABLE_SEL = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Collect the currently-tabbable elements within `root`, in document order.
 * Queries `_FOCUSABLE_SEL` then drops anything not actually keyboard-reachable:
 * `offsetParent === null` filters out `display:none`/detached nodes, and
 * `tabIndex < 0` filters out roving-tabindex elements (the inactive alerts tab
 * is a `<button>` with `tabindex="-1"` — the `button:not([disabled])` clause
 * would otherwise include it, making it a false first/last trap boundary and
 * letting Tab escape the dialog in the empty-alerts state). Used by the
 * focus-trap to find the first/last stops to wrap Tab/Shift+Tab between.
 * Read-only; no DOM mutation.
 *
 * @param {Element} root  Container to search (the alerts-panel element).
 * @returns {HTMLElement[]}  Visible, tabbable elements in document order.
 */
function _focusableIn(root) {
    return Array.from(root.querySelectorAll(_FOCUSABLE_SEL))
        .filter(el => el.offsetParent !== null && el.tabIndex >= 0);  // visible AND keyboard-tabbable
}

/**
 * Show the alerts panel: reveal the panel + backdrop, render current content,
 * snapshot the opener for focus-restore on close, and move focus into the
 * panel (deferred a frame so the slide-in transition starts first). Dispatches
 * `alertsPanelOpened`. No-op if the panel element is absent.
 */
export function openAlertsPanel() {
    const panel    = document.getElementById('alerts-panel');
    const backdrop = document.getElementById('alerts-panel-backdrop');
    if (!panel) return;
    // Snapshot the opener BEFORE moving focus, so close can restore it. We
    // grab document.activeElement here rather than from the click handler so
    // any programmatic open path (e.g. URL deep-link) also gets a sensible
    // restore target.
    _focusOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The alerts panel is a persistent modal (click/keyboard opened, never a
    // hover preview) → always pinned, so a stray map hover can't dismiss it.
    setActivePopup(closeAlertsPanel, () => true);
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

/**
 * Hide the alerts panel + backdrop and restore focus to whoever opened it
 * (typically the Alerts IControl button). If the opener has left the DOM,
 * focus is left untouched rather than dumped on `body`. Dispatches
 * `alertsPanelClosed`. No-op if the panel element is absent.
 */
export function closeAlertsPanel() {
    const panel    = document.getElementById('alerts-panel');
    const backdrop = document.getElementById('alerts-panel-backdrop');
    if (!panel) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    backdrop?.classList.add('hidden');
    backdrop?.setAttribute('aria-hidden', 'true');
    // Restore focus to whoever opened the panel — typically the Alerts
    // IControl button. If the opener vanished from the DOM (rare), fall
    // through silently rather than focus body.
    if (_focusOpener && _focusOpener.isConnected && typeof _focusOpener.focus === 'function') {
        _focusOpener.focus({ preventScroll: true });
    }
    _focusOpener = null;
    notifyPopupClosed(closeAlertsPanel);
    document.dispatchEvent(new CustomEvent('alertsPanelClosed'));
}

/**
 * Open the panel if hidden, close it if visible. Wired to the Alerts map
 * control. No-op if the panel element is absent.
 */
export function toggleAlertsPanel() {
    const panel = document.getElementById('alerts-panel');
    if (!panel) return;
    if (panel.classList.contains('hidden')) openAlertsPanel();
    else closeAlertsPanel();
}

/**
 * Whether the panel is currently visible. Used to gate the document-level
 * focus-trap and Escape handlers (they only act while the panel is open).
 *
 * @returns {boolean}
 */
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

    // Tab buttons. Each carries data-tab="service|access"; the renderer
    // reads _activeTab so a no-op click on the current tab still works.
    document.querySelectorAll('.alerts-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            if (tab) switchAlertsTab(tab);
        });
    });

    // Roving tabindex: Left/Right cycle focus through tabs. Standard
    // WAI-ARIA tab-list keyboard pattern.
    const tablist = document.getElementById('alerts-panel-tabs');
    tablist?.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const tabs = [...tablist.querySelectorAll('.alerts-tab')];
        const i = tabs.findIndex(t => t === document.activeElement);
        if (i < 0) return;
        const next = e.key === 'ArrowRight'
            ? tabs[(i + 1) % tabs.length]
            : tabs[(i - 1 + tabs.length) % tabs.length];
        next.focus();
        if (next.dataset.tab) switchAlertsTab(next.dataset.tab);
        e.preventDefault();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isAlertsPanelOpen()) closeAlertsPanel();
    });

    // Focus-trap: while the panel is open, Tab/Shift+Tab cycles within the
    // panel rather than escaping to the map beneath. WCAG 2.4.3 / dialog
    // pattern. Without this, a screen-reader user reaches the end of the
    // alerts list and tab dumps them onto the map controls behind a visual
    // backdrop — they lose context. The keydown listener is global so it
    // fires even when focus is inside a nested element (alert tooltip, etc.).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        if (!isAlertsPanelOpen()) return;
        const panel = document.getElementById('alerts-panel');
        if (!panel) return;
        const focusable = _focusableIn(panel);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panel)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    });

    // Live updates while open. Polling interval is ~120 s so this is cheap.
    document.addEventListener('alertsUpdated', () => {
        if (!isAlertsPanelOpen()) return;
        renderAlertsPanel();
        // Announce the live refresh to screen readers — the count badge alone is
        // easy to miss when the open list rebuilds under the user. WCAG 4.1.3.
        const announce = document.getElementById('alerts-tab-announce');
        if (announce) announce.textContent = 'Alerts updated.';
    });
}

// Re-export so unrelated callers (the IControl button handler in map.js)
// can import a single symbol without pulling everything.
export const _internals = { _dedupeAlerts, _formatActiveWindow, _isLineNameOnly };
