/**
 * Tests for js/alerts.js — covers the public surface (getActiveAlerts /
 * getActiveStopAlerts) and the _ingest pipeline via initAlerts + a stubbed
 * fetch. The DOM badge rendering (updateAlertBadges, tooltip wiring) is not
 * covered here — it's a separate concern with heavy DOM side effects.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Capture the document.dispatchEvent calls so we can verify alertsUpdated fires.
let _dispatchedEvents = [];
const _origDispatch = document.dispatchEvent.bind(document);
document.dispatchEvent = (e) => { _dispatchedEvents.push(e.type); return _origDispatch(e); };

import { getActiveAlerts, getActiveStopAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, initAlerts, buildAlertTooltipText, buildAlertTooltipBlock } from '../js/alerts.js';
import { initPredictions } from '../js/predictions.js';
import { installGlobals } from './_helpers/globals.js';

const NOW = () => Math.floor(Date.now() / 1000);

function makeRawAlert({
    id = 'a-1',
    effect = 'NO_SERVICE',
    routes = ['801'],
    stops = [],
    headerText = 'Test alert',
    descriptionText = '',
    start = null,
    end = null,
} = {}) {
    return {
        id, effect, headerText, descriptionText,
        informedEntities: [
            ...routes.map(r => ({ routeId: r })),
            ...stops.map(s => ({ stopId: s })),
        ],
        activePeriods: [{
            start: start != null ? new Date(start * 1000).toISOString() : null,
            end:   end   != null ? new Date(end   * 1000).toISOString() : null,
        }],
    };
}

beforeEach(() => {
    _dispatchedEvents = [];
    delete window.masterAlertsData;
    delete window.masterStopAlertsData;
    delete window.masterStopAccessibilityAlertsData;
    vi.useRealTimers();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('getActiveAlerts', () => {
    it('returns [] when masterAlertsData is not initialized', () => {
        expect(getActiveAlerts('801')).toEqual([]);
    });

    it('returns [] for an unknown route', () => {
        window.masterAlertsData = new Map();
        expect(getActiveAlerts('999')).toEqual([]);
    });

    it('filters out expired alerts', () => {
        const now = NOW();
        window.masterAlertsData = new Map([
            ['801', [
                { id: 'expired', effect: 'NO_SERVICE',
                  activePeriod: { start: now - 7200, end: now - 3600 } },
                { id: 'active', effect: 'DETOUR',
                  activePeriod: { start: now - 100, end: now + 3600 } },
            ]],
        ]);
        const result = getActiveAlerts('801');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('active');
    });

    it('coerces numeric route codes to strings', () => {
        const now = NOW();
        window.masterAlertsData = new Map([
            ['801', [{ id: 'a', effect: 'DETOUR',
                      activePeriod: { start: 0, end: now + 3600 } }]],
        ]);
        expect(getActiveAlerts(801)).toHaveLength(1);
    });
});

describe('getActiveStopAlerts', () => {
    it('returns [] when masterStopAlertsData is not initialized', () => {
        expect(getActiveStopAlerts('80101')).toEqual([]);
    });

    it('returns alerts targeting a specific stop, filtered by activePeriod', () => {
        const now = NOW();
        window.masterStopAlertsData = new Map([
            ['80111', [
                { id: 'a-1', effect: 'NO_SERVICE',
                  activePeriod: { start: 0, end: now + 3600 } },
            ]],
        ]);
        const result = getActiveStopAlerts('80111');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('a-1');
    });

    it('normalizes _N/_S directional suffixes on the lookup key', () => {
        const now = NOW();
        window.masterStopAlertsData = new Map([
            ['80101', [{ id: 'a-1', effect: 'DETOUR',
                        activePeriod: { start: 0, end: now + 3600 } }]],
        ]);
        // Caller passes a suffixed ID — normalizeStopId should strip "_N" and match.
        expect(getActiveStopAlerts('80101_N')).toHaveLength(1);
    });

    it('returns [] for a stop that has no targeted alerts even when its route does', () => {
        // Route-wide alerts (no stopIds in the alert) do not bleed into stop lookups.
        window.masterStopAlertsData = new Map();   // no stop entries
        window.masterAlertsData = new Map([
            ['801', [{ id: 'route-wide', effect: 'DETOUR',
                      activePeriod: { start: 0, end: Infinity }, stopIds: [] }]],
        ]);
        expect(getActiveStopAlerts('80111')).toEqual([]);
    });
});

describe('getActiveStopAccessibilityAlerts', () => {
    it('returns [] when masterStopAccessibilityAlertsData is not initialized', () => {
        expect(getActiveStopAccessibilityAlerts('80101')).toEqual([]);
    });

    it('filters out expired accessibility alerts', () => {
        const now = NOW();
        window.masterStopAccessibilityAlertsData = new Map([
            ['80101', [
                { id: 'old', effect: 'ACCESSIBILITY_ISSUE',
                  activePeriod: { start: now - 7200, end: now - 3600 } },
                { id: 'live', effect: 'ACCESSIBILITY_ISSUE',
                  activePeriod: { start: now - 100, end: now + 3600 } },
            ]],
        ]);
        const result = getActiveStopAccessibilityAlerts('80101');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('live');
    });

    it('normalizes _N/_S directional suffixes on the lookup key', () => {
        const now = NOW();
        window.masterStopAccessibilityAlertsData = new Map([
            ['80101', [{ id: 'a-1', effect: 'ACCESSIBILITY_ISSUE',
                        activePeriod: { start: 0, end: now + 3600 } }]],
        ]);
        expect(getActiveStopAccessibilityAlerts('80101_N')).toHaveLength(1);
    });
});

describe('classifyAccessibilityAlert', () => {
    it('returns "elevator" when only elevator is mentioned', () => {
        expect(classifyAccessibilityAlert('Elevator out at 7th/Metro', '')).toBe('elevator');
        expect(classifyAccessibilityAlert('', 'The elevator is out of service.')).toBe('elevator');
        expect(classifyAccessibilityAlert('Service alert', 'Elevators on the platform are not running')).toBe('elevator');
    });

    it('returns "escalator" when only escalator is mentioned', () => {
        expect(classifyAccessibilityAlert('Escalator out at Pico', '')).toBe('escalator');
        expect(classifyAccessibilityAlert('', 'The escalator from the platform is being repaired.')).toBe('escalator');
    });

    it('returns "both" when an alert mentions both facilities', () => {
        expect(classifyAccessibilityAlert('Elevator and escalator out', '')).toBe('both');
        expect(classifyAccessibilityAlert('Maintenance', 'Elevator out; escalator also unavailable')).toBe('both');
    });

    it('returns "unknown" for alerts that name no facility', () => {
        expect(classifyAccessibilityAlert('', '')).toBe('unknown');
        expect(classifyAccessibilityAlert('Accessibility issue', 'Please use alternate entry.')).toBe('unknown');
    });

    it('is case-insensitive', () => {
        expect(classifyAccessibilityAlert('ELEVATOR OUT', '')).toBe('elevator');
        expect(classifyAccessibilityAlert('', 'ESCALATOR is broken')).toBe('escalator');
    });

    it('matches stem variants like elevators / elevator-out', () => {
        expect(classifyAccessibilityAlert('Elevators not in service', '')).toBe('elevator');
        expect(classifyAccessibilityAlert('Elevator-out', '')).toBe('elevator');
    });

    it('rejects arbitrary letter continuations (tight word boundary)', () => {
        // Theoretical false positives the prior unanchored /\belevator/ would
        // have caught — digits or extra letters glued onto the facility word
        // are not Metro's format, but the regex now makes the rule explicit.
        expect(classifyAccessibilityAlert('Elevator123 fault', '')).toBe('unknown');
        expect(classifyAccessibilityAlert('', 'escalatorish concept proposal')).toBe('unknown');
    });
});

describe('initAlerts + _ingest pipeline', () => {
    it('preserves stopIds with _N suffix stripped and dispatches alertsUpdated', async () => {
        // Stub fetch — return the alert on the first call (rail), empty on the
        // second (bus). The actual lambda URLs are opaque so we count calls
        // rather than matching URL substrings.
        const railAlert = makeRawAlert({
            id: 'r-1',
            routes: ['801'],
            stops: ['80101_N', '80102', '80101_N'],   // dup + suffix
            start: NOW() - 100,
            end:   NOW() + 3600,
        });
        let _call = 0;
        global.fetch = vi.fn(() => Promise.resolve({
            json: () => Promise.resolve(_call++ === 0 ? [railAlert] : []),
        }));

        initAlerts();
        // initAlerts kicks off async fetch; flush microtasks so _fetchAlerts completes.
        await vi.waitFor(() => {
            expect(window.masterAlertsData?.has('801')).toBe(true);
        });

        const entry = window.masterAlertsData.get('801')[0];
        expect(entry.id).toBe('r-1');
        expect(entry.effect).toBe('NO_SERVICE');
        // _N suffix stripped; duplicates collapsed.
        expect([...entry.stopIds].sort()).toEqual(['80101', '80102']);

        // Stop map populated under both stop IDs.
        expect(window.masterStopAlertsData.get('80101')[0].id).toBe('r-1');
        expect(window.masterStopAlertsData.get('80102')[0].id).toBe('r-1');

        expect(_dispatchedEvents).toContain('alertsUpdated');
    });

    it('routes ACCESSIBILITY_ISSUE alerts to masterStopAccessibilityAlertsData, not masterAlertsData', async () => {
        const a = makeRawAlert({
            id: 'a11y', effect: 'ACCESSIBILITY_ISSUE',
            routes: ['801'], stops: ['80101'],
            headerText: 'Elevator out at Pico',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterStopAccessibilityAlertsData?.has('80101')).toBe(true);
        });
        // Route-level and regular per-stop maps stay empty — accessibility alerts
        // are a station-scoped channel, distinct from service alerts.
        expect(window.masterAlertsData.size).toBe(0);
        expect(window.masterStopAlertsData.size).toBe(0);
        const entry = window.masterStopAccessibilityAlertsData.get('80101')[0];
        expect(entry.id).toBe('a11y');
        expect(getActiveStopAccessibilityAlerts('80101')).toHaveLength(1);
        expect(getActiveStopAlerts('80101')).toHaveLength(0);
    });

    it('routes alerts whose text mentions elevator/escalator to the accessibility map', async () => {
        const a = makeRawAlert({
            id: 'elev', effect: 'OTHER_EFFECT',
            routes: ['801'], stops: ['80101'],
            descriptionText: 'Elevator out of service at Pico',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterStopAccessibilityAlertsData?.has('80101')).toBe(true);
        });
        expect(window.masterAlertsData.size).toBe(0);
        expect(window.masterStopAlertsData.size).toBe(0);
        expect(getActiveStopAccessibilityAlerts('80101')).toHaveLength(1);
    });

    it('keeps service alerts and accessibility alerts disjoint on the same stop', async () => {
        const detour = makeRawAlert({
            id: 'detour', effect: 'DETOUR',
            routes: ['801'], stops: ['80101'],
            headerText: 'Detour',
            start: NOW() - 100, end: NOW() + 3600,
        });
        const elev = makeRawAlert({
            id: 'a11y', effect: 'ACCESSIBILITY_ISSUE',
            routes: ['801'], stops: ['80101'],
            headerText: 'Elevator out',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([detour, elev]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterStopAlertsData?.has('80101')).toBe(true);
            expect(window.masterStopAccessibilityAlertsData?.has('80101')).toBe(true);
        });
        // Each lookup returns only its own kind — no cross-pollination.
        const svc = getActiveStopAlerts('80101');
        const acc = getActiveStopAccessibilityAlerts('80101');
        expect(svc.map(a => a.id)).toEqual(['detour']);
        expect(acc.map(a => a.id)).toEqual(['a11y']);
        // And the legend-facing route map only sees the service alert.
        expect(getActiveAlerts('801').map(a => a.id)).toEqual(['detour']);
    });

    it('accepts an accessibility alert with no route as long as it has a stop', async () => {
        // Elevator outages are sometimes published with only a stopId — no
        // routeId — since they affect station infrastructure, not a line.
        const a = makeRawAlert({
            id: 'a11y-no-route', effect: 'ACCESSIBILITY_ISSUE',
            routes: [], stops: ['80101'],
            headerText: 'Elevator out',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterStopAccessibilityAlertsData?.has('80101')).toBe(true);
        });
        expect(getActiveStopAccessibilityAlerts('80101')).toHaveLength(1);
    });

    it('drops an accessibility alert with no per-stop target after fallback yields nothing', async () => {
        // No stops in feed, no station name in text → nowhere to attach.
        const a = makeRawAlert({
            id: 'orphan', effect: 'ACCESSIBILITY_ISSUE',
            routes: ['801'], stops: [],
            headerText: 'Elevator issue', descriptionText: 'Generic message.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData).toBeDefined());
        expect(window.masterStopAccessibilityAlertsData.size).toBe(0);
    });

    it('treats missing end as open-ended (Infinity)', async () => {
        const a = makeRawAlert({ id: 'open', start: NOW() - 100, end: null });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.has('801')).toBe(true));
        const entry = window.masterAlertsData.get('801')[0];
        expect(entry.activePeriod.end).toBe(Infinity);
        // And it shows up via getActiveAlerts.
        expect(getActiveAlerts('801')).toHaveLength(1);
    });

    it('drops alerts where end < now (already expired at ingest)', async () => {
        const a = makeRawAlert({ id: 'expired', start: NOW() - 7200, end: NOW() - 3600 });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
    });

    it('drops alerts whose activePeriod cannot be parsed (NaN guard)', async () => {
        // After PR #150 widened normalizeTimestamp to accept ISO strings, a
        // malformed value silently produces NaN. Without an explicit guard the
        // alert slipped past `end < now` (NaN comparisons are always false)
        // and landed in masterAlertsData with NaN periods, where it became an
        // invisible memory tenant filtered out forever by getActiveAlerts.
        // The ingest guard now warns and drops these.
        const a = makeRawAlert({ id: 'malformed' });
        a.activePeriods = [{ start: 'not a date', end: 'also not a date' }];
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
    });

    it('drops alerts whose informedEntities target no relevant route', async () => {
        const a = makeRawAlert({ id: 'irrelevant', routes: ['9999'],
                                  start: NOW() - 100, end: NOW() + 3600 });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
    });
});

describe('station-name text-mining fallback', () => {
    // Seed masterStopsData + masterTripsData so getRouteCache returns a non-empty
    // stop list, and predictions.js's route-stops cache is populated.
    beforeEach(() => {
        installGlobals({
            stops: {
                '80101': { lat: 34.04, lon: -118.26, name: 'Allen' },
                '80202': { lat: 34.05, lon: -118.26, name: 'Pico' },
                '80303': { lat: 34.06, lon: -118.26, name: 'Union Station' },  // name already ends in "Station"
                '80404': { lat: 34.07, lon: -118.26, name: '7th' },             // < 4 chars → skipped
                '90101': { lat: 34.18, lon: -118.50, name: 'Allen / Colorado' }, // bus stop, different route
            },
            trips: {
                'T-RAIL': { rc: '801', dir: 0, stops: ['80101', '80202', '80303', '80404'], scheduledTimes: [0, 60, 120, 180] },
                'T-BUS':  { rc: '901', dir: 0, stops: ['90101'], scheduledTimes: [0] },
            },
        });
        initPredictions();
    });

    it('tags a station when the alert mentions "<Name> Station" but informedEntities has no stopId', async () => {
        // Real-world scenario: Metro publishes a delay at Allen Station with only
        // routeId: '801' in informedEntities. The station name appears in description.
        const a = makeRawAlert({
            id: 'allen-delay',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['801'],
            stops: [],   // no per-stop targeting in feed
            headerText: 'Modified service',
            descriptionText: 'Southbound trains are experiencing 15 minute delays due to train with mechanical issue at Allen Station. Follow announcements.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterStopAlertsData?.size).toBeGreaterThan(0);
        });

        expect(getActiveStopAlerts('80101')).toHaveLength(1);
        expect(getActiveStopAlerts('80101')[0].id).toBe('allen-delay');
        // The route-level entry still exists.
        expect(getActiveAlerts('801')).toHaveLength(1);
        // Other stops on the route aren't tagged.
        expect(getActiveStopAlerts('80202')).toHaveLength(0);
    });

    it('matches a name that already ends in "Station" without requiring another " Station"', async () => {
        const a = makeRawAlert({
            id: 'union-issue',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            headerText: 'Trains delayed at Union Station',
            descriptionText: '',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80303')).toBe(true));

        expect(getActiveStopAlerts('80303')).toHaveLength(1);
    });

    it('does NOT match a bus stop on a different route (route-scoped index)', async () => {
        // "Allen / Colorado" is a 901 bus stop whose name CONTAINS "Allen". A rail alert
        // for 801 must not fall through and tag the bus stop — index is scoped to the
        // alert's routes only.
        const a = makeRawAlert({
            id: 'allen-rail',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['801'],
            stops: [],
            descriptionText: 'Allen Station closed.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));

        expect(getActiveStopAlerts('80101')).toHaveLength(1);   // rail Allen — matched
        expect(getActiveStopAlerts('90101')).toHaveLength(0);   // bus Allen/Colorado — not matched
    });

    it('does NOT run the fallback when feed-side stopIds are already present', async () => {
        // Authoritative feed targeting beats text mining. If a stop is in
        // informedEntities, we trust that and don't scan text for additional matches.
        const a = makeRawAlert({
            id: 'feed-targeted',
            effect: 'NO_SERVICE',
            routes: ['801'],
            stops: ['80202'],   // Pico explicitly
            descriptionText: 'No service at Pico Station. Allen Station also affected by a separate issue.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80202')).toBe(true));

        // 80202 (Pico) tagged via informedEntities — yes.
        expect(getActiveStopAlerts('80202')).toHaveLength(1);
        // 80101 (Allen) mentioned in text but the fallback was skipped.
        expect(getActiveStopAlerts('80101')).toHaveLength(0);
    });

    it('skips name candidates shorter than 4 chars to avoid spurious matches', async () => {
        // "7th" is a real stop name in the fixture but only 3 chars — too short
        // to be safe. The fallback should not light it up.
        const a = makeRawAlert({
            id: 'short-name',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['801'],
            stops: [],
            descriptionText: 'Trains delayed near 7th and Spring.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));

        expect(getActiveStopAlerts('80404')).toHaveLength(0);
    });
});

describe('initAlerts long-session hygiene', () => {
    it('retries once 10s after a transient fetch failure', async () => {
        vi.useFakeTimers();
        // Each _fetchAlerts call fires two fetches (rail + bus) via Promise.all.
        // Fail the first round outright; the catch path schedules a retry 10 s later.
        let round = 0;
        global.fetch = vi.fn(() => {
            // The first round (calls 1-2) fails; subsequent rounds resolve empty.
            if (round === 0) {
                return Promise.reject(new Error('network blip'));
            }
            return Promise.resolve({ json: () => Promise.resolve([]) });
        });

        initAlerts();
        // Flush microtasks so the initial Promise.all rejection lands in catch.
        await vi.advanceTimersByTimeAsync(50);
        const initialCalls = global.fetch.mock.calls.length;
        expect(initialCalls).toBeGreaterThanOrEqual(2);

        // Mark round 1 (retry will succeed). Retry fires 10 s after the catch.
        round = 1;
        await vi.advanceTimersByTimeAsync(11_000);
        expect(global.fetch.mock.calls.length).toBeGreaterThan(initialCalls);
        vi.useRealTimers();
    });

    it('does NOT retry a second time if the retry also fails', async () => {
        // Retry should be single-shot — bounded by the next poll interval, not
        // unbounded. Verifies the `_retry === 0` guard at alerts.js retry path
        // so a failing endpoint can't trigger a runaway loop.
        vi.useFakeTimers();
        global.fetch = vi.fn(() => Promise.reject(new Error('persistent outage')));

        initAlerts();
        await vi.advanceTimersByTimeAsync(50);     // initial fetch round (rail + bus)
        const afterInitial = global.fetch.mock.calls.length;
        expect(afterInitial).toBeGreaterThanOrEqual(2);

        await vi.advanceTimersByTimeAsync(11_000); // first retry round (rail + bus)
        const afterRetry = global.fetch.mock.calls.length;
        expect(afterRetry).toBeGreaterThan(afterInitial);

        // No second retry — only the regular poll interval can trigger another
        // attempt (and only after ALERTS_POLL_MS = 120 s, well past 11 s).
        await vi.advanceTimersByTimeAsync(30_000);
        expect(global.fetch.mock.calls.length).toBe(afterRetry);
        vi.useRealTimers();
    });
});

describe('buildAlertTooltipText — full-text rendering for hover tooltips', () => {
    it('returns prefix + header on its own line when description is empty', () => {
        const text = buildAlertTooltipText('Detour', {
            header: 'Bus routes 720 and 920 detoured',
            description: '',
        });
        expect(text).toBe('Detour: Bus routes 720 and 920 detoured');
    });

    it('appends description on a blank line below the title when description has new content', () => {
        const text = buildAlertTooltipText('Detour', {
            header: 'Bus routes 720 and 920 detoured',
            description: 'Buses are detoured due to construction on Wilshire Blvd 6/1–6/30. Use Olympic Blvd as alternate.',
        });
        expect(text).toBe(
            'Detour: Bus routes 720 and 920 detoured\n\n' +
            'Buses are detoured due to construction on Wilshire Blvd 6/1–6/30. Use Olympic Blvd as alternate.'
        );
    });

    it('drops description when it duplicates header verbatim', () => {
        const text = buildAlertTooltipText('Service issue', {
            header: 'Reduced service',
            description: 'Reduced service',
        });
        expect(text).toBe('Service issue: Reduced service');
        expect(text).not.toContain('\n');
    });

    it('promotes description to title when description is a superset of header', () => {
        // Metro feeds sometimes ship a truncated header + full description
        // that includes the header text. Showing both is redundant; the full
        // description carries all the info.
        const text = buildAlertTooltipText('Elevator', {
            header: 'Elevator out',
            description: 'Elevator out of service from 6/1 to 6/15 for maintenance. Use the stairs or the Hope St entrance.',
        });
        // Title line uses the full description; no extra body block.
        expect(text).toBe(
            'Elevator: Elevator out of service from 6/1 to 6/15 for maintenance. Use the stairs or the Hope St entrance.'
        );
        // No double-line break (would mean both title and body were rendered).
        expect(text.split('\n\n').length).toBe(1);
    });

    it('trims surrounding whitespace from header and description', () => {
        const text = buildAlertTooltipText('Notice', {
            header: '   Reduced service   ',
            description: '\n\nServices may run up to 10 min late.\n',
        });
        expect(text).toBe('Notice: Reduced service\n\nServices may run up to 10 min late.');
    });

    it('handles missing alert fields gracefully (empty strings)', () => {
        expect(buildAlertTooltipText('X', {})).toBe('X: ');
        expect(buildAlertTooltipText('X', null)).toBe('X: ');
        expect(buildAlertTooltipText('X', undefined)).toBe('X: ');
    });
});

describe('buildAlertTooltipBlock — structured form for DOM rendering', () => {
    it('returns {prefix, title, body} with body empty when description is missing', () => {
        const block = buildAlertTooltipBlock('Detour', {
            header: 'Bus routes 720 and 920 detoured',
            description: '',
        });
        expect(block).toEqual({
            prefix: 'Detour',
            title: 'Bus routes 720 and 920 detoured',
            body: '',
        });
    });

    it('returns title + body when description carries new content', () => {
        const block = buildAlertTooltipBlock('Detour', {
            header: 'Bus routes 720 and 920 detoured',
            description: 'Buses are detoured due to construction on Wilshire Blvd.',
        });
        expect(block.prefix).toBe('Detour');
        expect(block.title).toBe('Bus routes 720 and 920 detoured');
        expect(block.body).toBe('Buses are detoured due to construction on Wilshire Blvd.');
    });

    it('collapses to title-only when description duplicates header verbatim', () => {
        const block = buildAlertTooltipBlock('Service issue', {
            header: 'Reduced service',
            description: 'Reduced service',
        });
        expect(block.body).toBe('');
        expect(block.title).toBe('Reduced service');
    });

    it('promotes superset description to the title and clears body', () => {
        const block = buildAlertTooltipBlock('Elevator', {
            header: 'Elevator out',
            description: 'Elevator out of service from 6/1 to 6/15 for maintenance.',
        });
        expect(block.title).toBe('Elevator out of service from 6/1 to 6/15 for maintenance.');
        expect(block.body).toBe('');
    });

    it('handles missing alert fields (empty strings) without throwing', () => {
        expect(buildAlertTooltipBlock('X', {})).toEqual({ prefix: 'X', title: '', body: '' });
        expect(buildAlertTooltipBlock('X', null)).toEqual({ prefix: 'X', title: '', body: '' });
        expect(buildAlertTooltipBlock('X', undefined)).toEqual({ prefix: 'X', title: '', body: '' });
    });

    it('produces the same flat string as buildAlertTooltipText when reassembled', () => {
        const alert = {
            header: 'BUS ROUTES 720 AND 920 DETOURED',
            description: 'Buses are detoured 6/1 to 6/30.',
        };
        const block = buildAlertTooltipBlock('Detour', alert);
        const text  = buildAlertTooltipText('Detour', alert);
        const reassembled = block.body
            ? `${block.prefix}: ${block.title}\n\n${block.body}`
            : `${block.prefix}: ${block.title}`;
        expect(reassembled).toBe(text);
    });
});
