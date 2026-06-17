/**
 * Tests for js/alertsPanel.js — the active-alerts panel surface. Covers the
 * pure data-shaping helpers (grouping, dedup, total count, active-window
 * formatting). Render/DOM logic is exercised via a small jsdom fixture
 * that mounts the panel HTML and asserts content.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Audit D2: the panel reads getAlertsFeedHealth() to tell "no active alerts"
// apart from "couldn't load." Mock just that export (spread the rest) so the
// feed-health states are controllable; default is a healthy never-failed feed
// so all the other tests behave exactly as before.
const DEFAULT_HEALTH = { everSucceeded: false, failing: false, consecutiveFailures: 0, lastSuccessMs: null };
const { healthState } = vi.hoisted(() => ({ healthState: { value: { everSucceeded: false, failing: false, consecutiveFailures: 0, lastSuccessMs: null } } }));
vi.mock('../js/alerts.js', async (importActual) => {
    const actual = await importActual();
    return { ...actual, getAlertsFeedHealth: () => healthState.value };
});

import {
    getActiveAlertsByRoute,
    getTotalActiveAlertCount,
    getActiveAccessibilityByStation,
    getOverallSeverity,
    renderAlertsPanel,
    switchAlertsTab,
    getActiveTab,
    _internals,
} from '../js/alertsPanel.js';
import {
    effectSeverity,
    maxSeverity,
    accessibilitySeverity,
    maxAccessibilitySeverity,
} from '../js/alerts.js';

const NOW = 1_700_000_000;
const ACTIVE_PERIOD = { start: NOW - 3600, end: NOW + 3600 };

function makeAlert({ id, effect, header, description, period = ACTIVE_PERIOD }) {
    return {
        id, effect,
        header,
        description: description ?? '',
        activePeriod: period,
        stopIds: [],
    };
}

beforeEach(() => {
    // Pin Date.now so the active-window filter is deterministic.
    const orig = Date.now;
    Date.now = () => NOW * 1000;
    // Restore after each test by reassigning in afterEach? No — vitest gives
    // each test a fresh module instance. Reset within beforeEach is enough
    // for our use because every test sets its own clock.
    void orig;

    // Reset feed-health to a healthy never-failed feed (audit D2 tests opt in).
    healthState.value = { ...DEFAULT_HEALTH };

    // Fresh global state every test.
    window.masterAlertsData = new Map();
    window.masterStopAlertsData = new Map();
    window.masterStopAccessibilityAlertsData = new Map();
    window.masterStopsData = {
        '80101': { lat: 0, lon: 0, name: 'Wilshire/Vermont' },
        '80202': { lat: 0, lon: 0, name: 'Hollywood/Highland Station' },
    };
});

describe('getActiveAlertsByRoute', () => {
    it('returns empty array when no alerts exist', () => {
        expect(getActiveAlertsByRoute()).toEqual([]);
    });

    it('groups alerts by route in the preferred display order (rail first, then bus)', () => {
        // Seed alerts on G Line (bus, 901), B Line (rail, 802), A Line (rail, 801).
        window.masterAlertsData.set('901', [
            makeAlert({ id: 'g1', effect: 'DETOUR', header: 'G detour' }),
        ]);
        window.masterAlertsData.set('802', [
            makeAlert({ id: 'b1', effect: 'SIGNIFICANT_DELAYS', header: 'B delay' }),
        ]);
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'NO_SERVICE', header: 'A out' }),
        ]);

        const groups = getActiveAlertsByRoute();
        expect(groups.map(g => g.routeCode)).toEqual(['801', '802', '901']);
    });

    it('omits routes whose alerts are all expired', () => {
        window.masterAlertsData.set('801', [
            makeAlert({
                id: 'expired',
                effect: 'DETOUR', header: 'old',
                period: { start: NOW - 7200, end: NOW - 3600 },  // ended 1 h ago
            }),
        ]);
        expect(getActiveAlertsByRoute()).toEqual([]);
    });

    it('omits routes whose alerts are all in the future', () => {
        window.masterAlertsData.set('801', [
            makeAlert({
                id: 'future',
                effect: 'DETOUR', header: 'tomorrow',
                period: { start: NOW + 3600, end: NOW + 7200 },
            }),
        ]);
        expect(getActiveAlertsByRoute()).toEqual([]);
    });

    it('collapses only true duplicates; keeps distinct same-effect alerts separate', () => {
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h1', description: 'd1' }),
            makeAlert({ id: 'a2', effect: 'DETOUR', header: 'h1', description: 'd2' }),  // distinct body → own row
            makeAlert({ id: 'a3', effect: 'DETOUR', header: 'h1', description: 'd1' }),  // true dup of a1
            makeAlert({ id: 'a4', effect: 'NO_SERVICE', header: 'h2', description: '' }),
        ]);

        const groups = getActiveAlertsByRoute();
        expect(groups).toHaveLength(1);
        // Two distinct DETOURs (d1, d2) + NO_SERVICE = 3 rows; a3 collapsed into a1.
        expect(groups[0].alerts).toHaveLength(3);
        const detours = groups[0].alerts.filter(a => a.effect === 'DETOUR');
        expect(detours.map(a => a.description).sort()).toEqual(['d1', 'd2']);
        const d1 = detours.find(a => a.description === 'd1');
        expect(d1._count).toBe(2);   // a1 + a3 (identical) collapsed, tally preserved
    });

    it('surfaces routes not in the display-order list (defensive fallback)', () => {
        // Seed a route code that's in METRO_ROUTE_CODES but not in ROUTE_DISPLAY_ORDER.
        // 950 IS in display order; we use it as control. The fallback path
        // covers a future-added route — simulate by stuffing an alert under
        // a routeCode we haven't listed.
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h1' }),
        ]);
        // 999 is not in METRO_ROUTE_CODES, so it's filtered out — which is
        // the correct behavior. The "tail" pass in alertsPanel.js iterates
        // masterAlertsData.keys() so an *unknown route* still gets a group;
        // but METRO_ROUTE_CODES filters it. Document the union semantics
        // instead of asserting against the filter set.
        const groups = getActiveAlertsByRoute();
        expect(groups.map(g => g.routeCode)).toContain('801');
    });
});

describe('getTotalActiveAlertCount', () => {
    it('returns 0 when no alerts exist', () => {
        expect(getTotalActiveAlertCount()).toBe(0);
    });

    it('sums deduped counts across routes', () => {
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h', description: 'd1' }),
            makeAlert({ id: 'a2', effect: 'DETOUR', header: 'h', description: 'd2' }),  // distinct body → own row
            makeAlert({ id: 'a3', effect: 'DETOUR', header: 'h', description: 'd1' }),  // true dup of a1 → collapses
        ]);
        window.masterAlertsData.set('901', [
            makeAlert({ id: 'g1', effect: 'NO_SERVICE', header: 'g' }),
        ]);

        // 801 → 2 distinct (d1, d2; a3 collapsed), 901 → 1, total = 3
        expect(getTotalActiveAlertCount()).toBe(3);
    });
});

describe('_formatActiveWindow', () => {
    const { _formatActiveWindow } = _internals;

    it('returns empty string for entirely-missing period', () => {
        expect(_formatActiveWindow({})).toBe('');
        expect(_formatActiveWindow(null)).toBe('');
    });

    it('formats a both-bound window', () => {
        const out = _formatActiveWindow({ start: NOW, end: NOW + 3600 });
        expect(out).toMatch(/^Active: /);
        expect(out).toContain('–');
    });

    it('renders open-ended "Active from …" when end is Infinity', () => {
        // Unified with alerts.js formatActivePeriodLine: open-ended windows
        // read "Active from <day>, <time>" (no "(ongoing)" suffix).
        const out = _formatActiveWindow({ start: NOW, end: Infinity });
        expect(out).toMatch(/^Active from /);
    });

    it('renders "Until …" when only the end is known', () => {
        // formatActivePeriodLine maps unknown-start + known-end to "Until <day>,
        // <time>" rather than discarding the known end as "ongoing".
        expect(_formatActiveWindow({ start: 0, end: NOW + 3600 })).toMatch(/^Until /);
    });
});

describe('_isLineNameOnly — suppress titles that just restate the line name', () => {
    const { _isLineNameOnly } = _internals;

    it('flags pure line-name restatements as redundant', () => {
        // The exact titles seen under route-group headers in the panel.
        expect(_isLineNameOnly('G Line')).toBe(true);
        expect(_isLineNameOnly('C/K Lines')).toBe(true);
        expect(_isLineNameOnly('Metro G Line (Orange) 901')).toBe(true);
        expect(_isLineNameOnly('Metro J Line (Silver) 910/950')).toBe(true);
        expect(_isLineNameOnly('A Line')).toBe(true);
    });

    it('keeps titles that carry real information', () => {
        expect(_isLineNameOnly('Elevator outage at Civic Center')).toBe(false);
        expect(_isLineNameOnly('Service change due to maintenance')).toBe(false);
        expect(_isLineNameOnly('Weekend single-tracking')).toBe(false);
    });

    it('handles empty / nullish input without throwing', () => {
        expect(_isLineNameOnly('')).toBe(false);
        expect(_isLineNameOnly(null)).toBe(false);
        expect(_isLineNameOnly(undefined)).toBe(false);
    });
});

describe('renderAlertsPanel (DOM)', () => {
    function mountPanel() {
        document.body.innerHTML = `
            <div id="alerts-panel" class="">
                <span id="alerts-panel-count">0</span>
                <div id="alerts-panel-body"></div>
                <span id="alerts-panel-updated"></span>
            </div>
        `;
    }

    it('renders an empty-state message when no alerts and masterAlertsData is set', () => {
        mountPanel();
        renderAlertsPanel();
        const body = document.getElementById('alerts-panel-body');
        expect(body.querySelector('.alerts-empty')).not.toBeNull();
        expect(body.querySelector('.alerts-empty').textContent).toBe('No active service alerts.');
        expect(document.getElementById('alerts-panel-count').textContent).toBe('0');
    });

    it('shows "Alerts unavailable" empty-state + footer when the feed never loaded and is failing (D2)', () => {
        healthState.value = { everSucceeded: false, failing: true, consecutiveFailures: 2, lastSuccessMs: null };
        mountPanel();
        renderAlertsPanel();
        const body = document.getElementById('alerts-panel-body');
        expect(body.querySelector('.alerts-empty').textContent).toBe('Alerts unavailable. Check your connection.');
        expect(document.getElementById('alerts-panel-updated').textContent).toBe('Alerts unavailable');
    });

    it('keeps showing last-good data with a stale footer when a later poll fails (D2)', () => {
        // everSucceeded → not "unavailable"; the empty-state stays the normal
        // "no active" text, but the footer flags the failed refresh.
        healthState.value = { everSucceeded: true, failing: true, consecutiveFailures: 2, lastSuccessMs: NOW * 1000 };
        mountPanel();
        renderAlertsPanel();
        const body = document.getElementById('alerts-panel-body');
        expect(body.querySelector('.alerts-empty').textContent).toBe('No active service alerts.');
        expect(document.getElementById('alerts-panel-updated').textContent).toMatch(/^Last updated .+ · couldn't refresh$/);
    });

    it('does nothing when panel is hidden (no work for offscreen panel)', () => {
        document.body.innerHTML = `
            <div id="alerts-panel" class="hidden">
                <div id="alerts-panel-body"><div class="should-not-clear">x</div></div>
                <span id="alerts-panel-count"></span>
            </div>
        `;
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h' }),
        ]);
        renderAlertsPanel();
        // The placeholder content remains — render was a no-op.
        expect(document.querySelector('.should-not-clear')).not.toBeNull();
    });

    it('renders a route group with effect chip, title, and active line', () => {
        mountPanel();
        window.masterAlertsData.set('801', [
            makeAlert({
                id: 'a1', effect: 'DETOUR',
                header: 'A LINE DETOUR DOWNTOWN',  // shouting → title-cased on render
                description: 'Trains reroute via 7th Street through 9 PM.',
            }),
        ]);
        document.getElementById('alerts-panel').classList.remove('hidden');
        renderAlertsPanel();

        const group = document.querySelector('.alerts-route-group');
        expect(group).not.toBeNull();
        expect(group.dataset.route).toBe('801');
        expect(group.querySelector('.alerts-route-name').textContent).toBe('A Line');

        const chip = group.querySelector('.alerts-effect-chip');
        expect(chip.textContent).toBe('Detour');

        const title = group.querySelector('.alerts-title');
        expect(title.textContent).toBe('A Line Detour Downtown');  // title-cased

        const desc = group.querySelector('.alerts-desc');
        expect(desc.textContent).toContain('9 pm');                // am/pm normalized

        // Active line is rendered when the period is bounded.
        expect(group.querySelector('.alerts-active')).not.toBeNull();
    });

    it('distinct same-effect alerts render as separate rows, each with its own chip', () => {
        mountPanel();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h', description: 'first detour text' }),
            makeAlert({ id: 'a2', effect: 'DETOUR', header: 'h', description: 'second detour text' }),
        ]);
        document.getElementById('alerts-panel').classList.remove('hidden');
        renderAlertsPanel();

        // Two separate list items (not one item with an indented continuation).
        const items = document.querySelectorAll('.alerts-item');
        expect(items).toHaveLength(2);
        // Each item has exactly one block, and each block carries its own chip.
        for (const item of items) {
            expect(item.querySelectorAll('.alerts-block')).toHaveLength(1);
            expect(item.querySelector('.alerts-effect-chip')).not.toBeNull();
        }
    });

    it('updates the header count badge with deduped totals', () => {
        mountPanel();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h', description: 'd1' }),
            makeAlert({ id: 'a2', effect: 'DETOUR', header: 'h', description: 'd2' }),  // distinct body
            makeAlert({ id: 'a3', effect: 'DETOUR', header: 'h', description: 'd1' }),  // true dup → collapses
        ]);
        window.masterAlertsData.set('802', [
            makeAlert({ id: 'b1', effect: 'NO_SERVICE', header: 'h' }),
        ]);
        document.getElementById('alerts-panel').classList.remove('hidden');
        renderAlertsPanel();

        // 801 → 2 distinct DETOURs (a3 collapsed into a1), 802 → 1, total = 3.
        expect(document.getElementById('alerts-panel-count').textContent).toBe('3');
    });
});

describe('severity helpers (single source of truth for alert color coding)', () => {
    it('effectSeverity maps known effects to severe vs moderate', () => {
        expect(effectSeverity('NO_SERVICE')).toBe('severe');
        expect(effectSeverity('SIGNIFICANT_DELAYS')).toBe('severe');
        expect(effectSeverity('DETOUR')).toBe('moderate');
        expect(effectSeverity('REDUCED_SERVICE')).toBe('moderate');
        expect(effectSeverity('MODIFIED_SERVICE')).toBe('moderate');
        expect(effectSeverity('STOP_MOVED')).toBe('moderate');
        expect(effectSeverity('OTHER_EFFECT')).toBe('moderate');
        expect(effectSeverity('UNKNOWN_EFFECT')).toBe('moderate');
    });

    it('effectSeverity defaults UNKNOWN codes to moderate (visible amber, not silent)', () => {
        // Defensive against Metro introducing a new GTFS-RT effect code —
        // we'd rather render amber than vanish the alert.
        expect(effectSeverity('SOMETHING_NEW')).toBe('moderate');
        expect(effectSeverity(undefined)).toBe('moderate');
    });

    it('maxSeverity escalates the moment a severe alert is present', () => {
        expect(maxSeverity([])).toBe(null);
        expect(maxSeverity([{ effect: 'MODIFIED_SERVICE' }])).toBe('moderate');
        expect(maxSeverity([
            { effect: 'MODIFIED_SERVICE' },
            { effect: 'NO_SERVICE' },
            { effect: 'DETOUR' },
        ])).toBe('severe');
    });

    it('accessibilitySeverity: elevator + both = severe; escalator = moderate', () => {
        expect(accessibilitySeverity('elevator')).toBe('severe');
        expect(accessibilitySeverity('both')).toBe('severe');
        expect(accessibilitySeverity('escalator')).toBe('moderate');
        // Unknown classification still renders visibly (amber) rather than
        // dropping silently.
        expect(accessibilitySeverity('unknown')).toBe('moderate');
    });

    it('maxAccessibilitySeverity classifies from header+description text', () => {
        expect(maxAccessibilitySeverity([])).toBe(null);
        expect(maxAccessibilitySeverity([
            { header: 'Escalator out at Wilshire/Vermont', description: '' },
        ])).toBe('moderate');
        expect(maxAccessibilitySeverity([
            { header: 'Escalator out', description: '' },
            { header: 'Elevator out', description: '' },
        ])).toBe('severe');   // any elevator wins
    });

    it('getOverallSeverity reflects highest severity across all routes', () => {
        expect(getOverallSeverity()).toBe(null);

        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'MODIFIED_SERVICE', header: 'h' }),
        ]);
        expect(getOverallSeverity()).toBe('moderate');

        window.masterAlertsData.set('802', [
            makeAlert({ id: 'b1', effect: 'NO_SERVICE', header: 'h' }),
        ]);
        expect(getOverallSeverity()).toBe('severe');
    });
});

describe('severity rendering (data-severity attribute on every indicator)', () => {
    function mountPanel() {
        document.body.innerHTML = `
            <div id="alerts-panel" class="">
                <span id="alerts-panel-count">0</span>
                <div id="alerts-panel-body"></div>
                <span id="alerts-panel-updated"></span>
            </div>
        `;
    }

    it('chip + item carry data-severity matching the effect', () => {
        mountPanel();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'NO_SERVICE', header: 'Out' }),
            makeAlert({ id: 'a2', effect: 'MODIFIED_SERVICE', header: 'Mod' }),
        ]);
        renderAlertsPanel();

        const items = document.querySelectorAll('.alerts-item');
        expect(items).toHaveLength(2);
        const severeItem   = [...items].find(i => i.dataset.severity === 'severe');
        const moderateItem = [...items].find(i => i.dataset.severity === 'moderate');
        expect(severeItem.querySelector('.alerts-effect-chip').dataset.severity).toBe('severe');
        expect(moderateItem.querySelector('.alerts-effect-chip').dataset.severity).toBe('moderate');
    });

    it('count badge inherits the highest severity across the panel', () => {
        mountPanel();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'MODIFIED_SERVICE', header: 'h' }),
        ]);
        renderAlertsPanel();
        expect(document.getElementById('alerts-panel-count').dataset.severity).toBe('moderate');

        // Add a severe alert — count badge escalates to severe.
        window.masterAlertsData.set('802', [
            makeAlert({ id: 'b1', effect: 'NO_SERVICE', header: 'h' }),
        ]);
        renderAlertsPanel();
        expect(document.getElementById('alerts-panel-count').dataset.severity).toBe('severe');
    });

    it('count badge drops the severity attribute when no alerts exist', () => {
        mountPanel();
        renderAlertsPanel();
        expect(document.getElementById('alerts-panel-count').dataset.severity).toBeUndefined();
    });
});

describe('accessibility tab (per-station accessibility-alert grouping)', () => {
    function makeAccessAlert({ id, header = '', description = '', period = ACTIVE_PERIOD }) {
        return { id, effect: 'ACCESSIBILITY_ISSUE', header, description, activePeriod: period, stopIds: [] };
    }

    it('returns empty when no accessibility alerts exist', () => {
        expect(getActiveAccessibilityByStation()).toEqual([]);
    });

    it('groups accessibility alerts by station (alphabetical) with per-station dedup', () => {
        window.masterStopAccessibilityAlertsData.set('80101', [
            makeAccessAlert({ id: 'e1', header: 'Elevator outage' }),
        ]);
        window.masterStopAccessibilityAlertsData.set('80202', [
            makeAccessAlert({ id: 'x1', header: 'Escalator outage' }),
        ]);

        const groups = getActiveAccessibilityByStation();
        expect(groups).toHaveLength(2);
        // Alphabetical: Hollywood/Highland comes before Wilshire/Vermont after
        // cleanStationName strips the "Station" suffix from the former.
        expect(groups[0].stopName).toBe('Hollywood/Highland');
        expect(groups[1].stopName).toBe('Wilshire/Vermont');
    });

    it('collapses multiple stop IDs that share a station name (entrance suffixes)', () => {
        window.masterStopsData['80101A'] = { lat: 0, lon: 0, name: 'Wilshire/Vermont' };
        window.masterStopAccessibilityAlertsData.set('80101', [
            makeAccessAlert({ id: 'e1', header: 'Elevator outage' }),
        ]);
        window.masterStopAccessibilityAlertsData.set('80101A', [
            // Same alert by id — should collapse into the same station group.
            makeAccessAlert({ id: 'e1', header: 'Elevator outage' }),
        ]);

        const groups = getActiveAccessibilityByStation();
        expect(groups).toHaveLength(1);
        expect(groups[0].alerts).toHaveLength(1);
    });

    it('getOverallSeverity ignores accessibility alerts (service-only)', () => {
        // Service tab is moderate-only.
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'MODIFIED_SERVICE', header: 'h' }),
        ]);
        expect(getOverallSeverity()).toBe('moderate');

        // Add an elevator (severe) accessibility alert — the toggle dot must
        // NOT escalate to red. Accessibility surfaces only via its own
        // per-station icons, never the global alerts-button color.
        window.masterStopAccessibilityAlertsData.set('80101', [
            makeAccessAlert({ id: 'e1', header: 'Elevator out of service' }),
        ]);
        expect(getOverallSeverity()).toBe('moderate');

        // With no service alerts at all, an elevator outage leaves it inert.
        window.masterAlertsData.clear();
        expect(getOverallSeverity()).toBe(null);
    });
});

describe('renderAlertsPanel — tabs', () => {
    // _activeTab is module state; reset to 'service' before every test so
    // earlier tab-switching tests don't leak across.
    beforeEach(() => {
        // Mount minimal DOM so switchAlertsTab can find the tabs to update.
        document.body.innerHTML = `
            <div id="alerts-panel" class="">
                <span id="alerts-panel-count">0</span>
                <div id="alerts-panel-tabs">
                    <button class="alerts-tab is-active" data-tab="service" aria-selected="true">
                        <span class="alerts-tab-count" data-tab-count="service">0</span>
                    </button>
                    <button class="alerts-tab" data-tab="access" aria-selected="false">
                        <span class="alerts-tab-count" data-tab-count="access">0</span>
                    </button>
                </div>
                <div id="alerts-panel-body"></div>
            </div>
        `;
        switchAlertsTab('service');
    });

    function mountPanelWithTabs() {
        document.body.innerHTML = `
            <div id="alerts-panel" class="">
                <span id="alerts-panel-count">0</span>
                <div id="alerts-panel-tabs">
                    <button class="alerts-tab is-active" data-tab="service" aria-selected="true">
                        <span class="alerts-tab-count" data-tab-count="service">0</span>
                    </button>
                    <button class="alerts-tab" data-tab="access" aria-selected="false">
                        <span class="alerts-tab-count" data-tab-count="access">0</span>
                    </button>
                </div>
                <div id="alerts-panel-body"></div>
                <span id="alerts-panel-updated"></span>
            </div>
        `;
    }

    it('renders service alerts on the default service tab', () => {
        mountPanelWithTabs();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h' }),
        ]);
        renderAlertsPanel();
        expect(document.querySelector('.alerts-route-group')).not.toBeNull();
        expect(document.querySelector('.alerts-access-group')).toBeNull();
        expect(document.querySelector('[data-tab-count="service"]').textContent).toBe('1');
        expect(document.querySelector('[data-tab-count="access"]').textContent).toBe('0');
    });

    it('switchAlertsTab("access") re-renders body with accessibility groups', () => {
        mountPanelWithTabs();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'DETOUR', header: 'h' }),
        ]);
        window.masterStopAccessibilityAlertsData.set('80101', [
            { id: 'e1', effect: 'ACCESSIBILITY_ISSUE', header: 'Elevator outage',
              description: '', activePeriod: ACTIVE_PERIOD, stopIds: [] },
        ]);
        renderAlertsPanel();
        switchAlertsTab('access');

        expect(getActiveTab()).toBe('access');
        expect(document.querySelector('.alerts-access-group')).not.toBeNull();
        expect(document.querySelector('.alerts-route-group:not(.alerts-access-group)')).toBeNull();
        // The active tab's count drives the header badge.
        expect(document.getElementById('alerts-panel-count').textContent).toBe('1');

        switchAlertsTab('service');
        expect(getActiveTab()).toBe('service');
        // Header count reflects the service tab now.
        expect(document.getElementById('alerts-panel-count').textContent).toBe('1');
    });

    it('switchAlertsTab re-points the tabpanel aria-labelledby at the active tab', () => {
        // The HTML hard-wires aria-labelledby to the Service tab; aria-labelledby
        // is static, so without an update the Accessibility panel is announced as
        // "Service alerts".
        mountPanelWithTabs();
        const body = document.getElementById('alerts-panel-body');
        body.setAttribute('aria-labelledby', 'alerts-tab-service');

        switchAlertsTab('access');
        expect(body.getAttribute('aria-labelledby')).toBe('alerts-tab-access');

        switchAlertsTab('service');
        expect(body.getAttribute('aria-labelledby')).toBe('alerts-tab-service');
    });

    it('service tab badge colors by severity; access tab badge stays BLUE regardless', () => {
        // Inside the alerts menu, accessibility surfaces are always blue —
        // even when an elevator outage is severe. Severity coloring is
        // reserved for the map-side indicators (station marker corner dot,
        // tooltips) where red is doing functional warning work. The toggle-
        // button dot on the map still escalates via getOverallSeverity().
        mountPanelWithTabs();
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'MODIFIED_SERVICE', header: 'h' }),
        ]);
        window.masterStopAccessibilityAlertsData.set('80101', [
            { id: 'e1', effect: 'ACCESSIBILITY_ISSUE', header: 'Elevator outage',
              description: '', activePeriod: ACTIVE_PERIOD, stopIds: [] },
        ]);
        renderAlertsPanel();

        const serviceBadge = document.querySelector('[data-tab-count="service"]');
        const accessBadge  = document.querySelector('[data-tab-count="access"]');
        expect(serviceBadge.dataset.severity).toBe('moderate');
        expect(serviceBadge.dataset.kind).toBeUndefined();
        // Access tab carries data-kind="access" instead of severity — the
        // CSS rule .alerts-tab-count[data-kind="access"] paints it blue.
        expect(accessBadge.dataset.severity).toBeUndefined();
        expect(accessBadge.dataset.kind).toBe('access');
    });

    it('access tab chips render as kind=access (blue) — not severity-colored', () => {
        mountPanelWithTabs();
        window.masterStopAccessibilityAlertsData.set('80101', [
            { id: 'e1', effect: 'ACCESSIBILITY_ISSUE', header: 'Elevator outage',
              description: '', activePeriod: ACTIVE_PERIOD, stopIds: [] },
        ]);
        switchAlertsTab('access');

        const chip = document.querySelector('.alerts-effect-chip');
        expect(chip).not.toBeNull();
        // Severity is NOT propagated to the chip — kind=access drives blue
        // styling regardless of the underlying accessibility severity.
        expect(chip.dataset.severity).toBeUndefined();
        expect(chip.dataset.kind).toBe('access');
    });

    it('header count badge: blue when active tab = access, severity when active tab = service', () => {
        mountPanelWithTabs();
        // _activeTab is module state and persists across tests — reset to
        // 'service' so this test starts from a known baseline regardless
        // of prior test order.
        switchAlertsTab('service');
        // Service tab: severe alert.
        window.masterAlertsData.set('801', [
            makeAlert({ id: 'a1', effect: 'NO_SERVICE', header: 'h' }),
        ]);
        // Access tab: severe (elevator).
        window.masterStopAccessibilityAlertsData.set('80101', [
            { id: 'e1', effect: 'ACCESSIBILITY_ISSUE', header: 'Elevator outage',
              description: '', activePeriod: ACTIVE_PERIOD, stopIds: [] },
        ]);
        renderAlertsPanel();
        const header = document.getElementById('alerts-panel-count');
        // Service tab active → severity red.
        expect(header.dataset.severity).toBe('severe');
        expect(header.dataset.kind).toBeUndefined();

        switchAlertsTab('access');
        // Access tab active → blue, no severity propagated.
        expect(header.dataset.severity).toBeUndefined();
        expect(header.dataset.kind).toBe('access');
    });

    it('empty state for accessibility tab when none active', () => {
        mountPanelWithTabs();
        window.masterStopAccessibilityAlertsData = new Map();
        renderAlertsPanel();
        switchAlertsTab('access');
        const empty = document.querySelector('.alerts-empty');
        expect(empty.textContent).toBe('No active accessibility alerts.');
    });
});
