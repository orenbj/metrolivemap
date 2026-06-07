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

import { getActiveAlerts, getActiveStopAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, initAlerts, buildAlertTooltipText, buildAlertTooltipBlock, effectSeverity, maxSeverity } from '../js/alerts.js';
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

    it('accessibility alerts: filters "alternative station" stopIds when header names a specific stop', async () => {
        // Real-world bug (2026-05): Metro tags a Hollywood/Highland elevator
        // outage with BOTH stopIds — 80203 (the actually-affected station)
        // AND 80204 (Hollywood/Vine, suggested in the alert body as "Use
        // Hollywood/Vine instead"). The unaffected stop's marker then
        // displayed the "Elevator outage — HOLLYWOOD/HIGHLAND STATION"
        // banner, confusing riders.
        //
        // Fix: when an accessibility alert's header normalizes to one of
        // the tagged stops' canonical names, filter the stopIds to only
        // the matching stop. The other tagged stops are alternatives, not
        // affected facilities.
        installGlobals({
            stops: {
                '80203': { lat: 34.10, lon: -118.34, name: 'Hollywood / Highland Station' },
                '80204': { lat: 34.10, lon: -118.33, name: 'Hollywood / Vine Station' },
            },
        });
        const a = makeRawAlert({
            id: 'hh-elev',
            effect: 'ACCESSIBILITY_ISSUE',
            routes: ['802'],
            stops: ['80203', '80204'],     // BOTH stops tagged in feed
            headerText: 'HOLLYWOOD/HIGHLAND STATION',
            descriptionText: 'Elevator access is currently unavailable. Use Hollywood/Vine instead.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData?.has('80203')).toBe(true));

        // Only the actually-affected stop carries the alert.
        expect(getActiveStopAccessibilityAlerts('80203')).toHaveLength(1);
        // Hollywood/Vine — the suggested alternative — must NOT show the outage.
        expect(getActiveStopAccessibilityAlerts('80204')).toHaveLength(0);
    });

    it('accessibility alerts: KEEPS all stopIds when header doesn\'t match any tagged stop name', async () => {
        // System-wide or vague headers shouldn't trigger the filter — fall
        // back to the feed's stopId targeting verbatim. Regression guard
        // that legitimate multi-stop access alerts ("all elevators down")
        // aren't accidentally filtered to empty.
        installGlobals({
            stops: {
                '80203': { lat: 34.10, lon: -118.34, name: 'Hollywood / Highland Station' },
                '80204': { lat: 34.10, lon: -118.33, name: 'Hollywood / Vine Station' },
            },
        });
        const a = makeRawAlert({
            id: 'systemwide',
            effect: 'ACCESSIBILITY_ISSUE',
            routes: ['802'],
            stops: ['80203', '80204'],
            headerText: 'Multiple elevators offline',      // doesn't match either station name
            descriptionText: 'Elevators at multiple B Line stations are out.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData?.has('80203')).toBe(true));

        // Both stops keep the alert — filter didn't engage because the
        // header doesn't normalize to either station's canonical name.
        expect(getActiveStopAccessibilityAlerts('80203')).toHaveLength(1);
        expect(getActiveStopAccessibilityAlerts('80204')).toHaveLength(1);
    });

    it('accessibility alerts: entrance-variant stop entries belong to the same station (prefix match)', async () => {
        // Metro publishes per-entrance stop entries with names like
        // "Hollywood / Vine Station - Elevator" / " - Main Entrance".
        // Their stationNameKey ends with the suffix, so a plain equality
        // check against the bare-station header "HOLLYWOOD/VINE STATION"
        // (key "hollywoodvine") would drop the entrance variants as
        // "alternatives" — but they're really the same station. The
        // prefix-match keeps them while still excluding a genuinely
        // different station.
        installGlobals({
            stops: {
                '80204':  { lat: 34.10, lon: -118.33, name: 'Hollywood / Vine Station' },
                '80204A': { lat: 34.10, lon: -118.33, name: 'Hollywood / Vine Station - Elevator' },
                '80204B': { lat: 34.10, lon: -118.33, name: 'Hollywood / Vine Station - Main Entrance' },
                '80203':  { lat: 34.10, lon: -118.34, name: 'Hollywood / Highland Station' },
            },
        });
        const a = makeRawAlert({
            id: 'hv-elev',
            effect: 'ACCESSIBILITY_ISSUE',
            routes: ['802'],
            stops: ['80204', '80204A', '80204B', '80203'],   // include a true alternative
            headerText: 'HOLLYWOOD/VINE STATION',
            descriptionText: 'Elevator unavailable. Use Hollywood/Highland instead.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData?.has('80204')).toBe(true));

        // All Hollywood/Vine entries (base + entrances) carry the alert.
        expect(getActiveStopAccessibilityAlerts('80204')).toHaveLength(1);
        expect(getActiveStopAccessibilityAlerts('80204A')).toHaveLength(1);
        expect(getActiveStopAccessibilityAlerts('80204B')).toHaveLength(1);
        // Hollywood/Highland (a genuine alternative — different station)
        // does NOT carry the alert.
        expect(getActiveStopAccessibilityAlerts('80203')).toHaveLength(0);
    });

    it('accessibility alerts: single-stopId alerts are unaffected by the filter', async () => {
        // Filter is a no-op when there's only one tagged stop — regression
        // guard that the fix doesn't break the common case.
        installGlobals({
            stops: { '80212': { lat: 34.05, lon: -118.25, name: 'Pershing Square Station' } },
        });
        const a = makeRawAlert({
            id: 'pershing',
            effect: 'ACCESSIBILITY_ISSUE',
            routes: ['802'],
            stops: ['80212'],
            headerText: 'PERSHING SQUARE STATION',
            descriptionText: 'Escalators may be unavailable.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData?.has('80212')).toBe(true));

        expect(getActiveStopAccessibilityAlerts('80212')).toHaveLength(1);
    });

    it('SERVICE alerts: NOT filtered by header-match (legitimately span multiple stops)', async () => {
        // Defensive: service alerts often span multiple stations ("delays
        // between Union and Chinatown"). The filter must NOT apply to
        // service alerts — only to accessibility.
        installGlobals({
            stops: {
                '80101': { lat: 34.04, lon: -118.23, name: 'Union Station' },
                '80102': { lat: 34.06, lon: -118.24, name: 'Chinatown Station' },
            },
        });
        const a = makeRawAlert({
            id: 'svc-multi',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['801'],
            stops: ['80101', '80102'],
            headerText: 'UNION STATION',          // matches one stop name
            descriptionText: 'Delays between Union and Chinatown.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80101')).toBe(true));

        // Both stops still tagged — the access-only filter didn't fire.
        expect(getActiveStopAlerts('80101')).toHaveLength(1);
        expect(getActiveStopAlerts('80102')).toHaveLength(1);
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

    it('matches a transfer station whose name carries a line-designator suffix', async () => {
        // Regression for the missing alert icon at Willowbrook/Rosa Parks.
        // The canonical stop name in masterStopsData is
        // "Willowbrook - Rosa Parks Station - Metro A-Line" (and similar with
        // " - Metro C-Line" for the C Line side). Without stripping the line
        // designator before building the regex, the index produced patterns
        // that required the literal "Metro A-Line" substring in alert text and
        // never matched. The fix uses cleanStationName(name, false) to drop
        // the line designator while preserving the "Station" suffix, and
        // makes the slash/hyphen separator flexible so prose can use either.
        installGlobals({
            stops: {
                'WB-A': { lat: 33.928, lon: -118.238, name: 'Willowbrook - Rosa Parks Station - Metro A-Line' },
                'WB-C': { lat: 33.928, lon: -118.238, name: 'Willowbrook - Rosa Parks Station - Metro C-Line' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['WB-A'], scheduledTimes: [0] },
                'T-C': { rc: '803', dir: 0, stops: ['WB-C'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'wb-modified',
            effect: 'MODIFIED_SERVICE',
            routes: ['801', '803'],
            stops: [],
            headerText: 'Modified service',
            descriptionText: 'Expect delays due to train mechanical incident at Willowbrook/Rosa Parks Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('WB-A')).toBe(true));

        expect(getActiveStopAlerts('WB-A')).toHaveLength(1);
        expect(getActiveStopAlerts('WB-C')).toHaveLength(1);
    });

    it('matches a transfer station whose alert prose uses " - " instead of "/"', async () => {
        installGlobals({
            stops: {
                'WB-A': { lat: 33.928, lon: -118.238, name: 'Willowbrook - Rosa Parks Station - Metro A-Line' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['WB-A'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'wb-dash',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            headerText: 'Delays at Willowbrook - Rosa Parks Station',
            descriptionText: '',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('WB-A')).toBe(true));

        expect(getActiveStopAlerts('WB-A')).toHaveLength(1);
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

    it('matches "Pomona Station" against "Pomona North Station" when no other Pomona-core stop exists', async () => {
        // Real-world bug (2026-05): Metro's A Line alert says
        // "between Pomona Station and Los Angeles Union Station" but the
        // stop's canonical name is "Pomona North Station" (the directional
        // suffix exists because the new A Line extension labelled it so;
        // however there's no "Pomona South" stop on the system). The
        // fallback now emits a directional alias for any station whose
        // name ends with North/South/East/West, gated on the core being
        // unique across the indexed set so cross-stop ambiguity stays out.
        installGlobals({
            stops: {
                'POM-N': { lat: 34.073, lon: -117.752, name: 'Pomona North Station' },
                'UNION': { lat: 34.056, lon: -118.234, name: 'Union Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['POM-N', 'UNION'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'pomona-modified',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            headerText: 'A Line modified service',
            descriptionText: 'A Line trains will run every 20 minutes between Pomona Station and Los Angeles Union Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('POM-N')).toBe(true));

        // Both stops mentioned by alias / full name must light up.
        expect(getActiveStopAlerts('POM-N')).toHaveLength(1);
        expect(getActiveStopAlerts('UNION')).toHaveLength(1);
    });

    it('does NOT emit a directional alias when multiple stops share the same core', async () => {
        // Defensive: if a future Metro extension adds "Pomona North" + "Pomona
        // South" on the same line, "Pomona Station" in alert prose becomes
        // ambiguous. The collision check suppresses the alias for both stops
        // so we don't fire the alert at the wrong platform.
        installGlobals({
            stops: {
                'POM-N': { lat: 34.073, lon: -117.752, name: 'Pomona North Station' },
                'POM-S': { lat: 34.062, lon: -117.752, name: 'Pomona South Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['POM-N', 'POM-S'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'pomona-ambiguous',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            descriptionText: 'Service disruption at Pomona Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        // The alert still ingests at route level. We then assert neither stop
        // got the alias-tagged stop entry (since "Pomona Station" alone is
        // ambiguous when two Pomona-core stops exist).
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));

        expect(getActiveStopAlerts('POM-N')).toHaveLength(0);
        expect(getActiveStopAlerts('POM-S')).toHaveLength(0);
        // Route-level entry is preserved.
        expect(getActiveAlerts('801')).toHaveLength(1);
    });

    it('full station name still matches even when an alias is present', async () => {
        // The alias is ADDITIVE — it doesn't replace the primary full-name
        // regex. An alert that uses the full "Pomona North Station" must
        // still match (regression guard).
        installGlobals({
            stops: {
                'POM-N': { lat: 34.073, lon: -117.752, name: 'Pomona North Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['POM-N'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'pomona-full',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            descriptionText: 'Disruption at Pomona North Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('POM-N')).toBe(true));

        expect(getActiveStopAlerts('POM-N')).toHaveLength(1);
    });

    it('matches "[A] and [B] Stations" list pattern — no-Station bare alias', async () => {
        // Real-world failure (2026-05-31): Metro E Line alert reads
        // "Trains will share 1 track at Culver City and Palms Stations."
        // Neither "Culver City" nor "Palms" is immediately adjacent to "Station",
        // so the primary regex (\bCulver City Station\b) never matched.
        // The no-Station alias emits \bCulver City\b and \bPalms\b for these
        // stops (both unambiguous on the E Line) so both light up.
        installGlobals({
            stops: {
                'CC':    { lat: 34.006, lon: -118.396, name: 'Culver City Station' },
                'PALMS': { lat: 34.001, lon: -118.408, name: 'Palms Station' },
                'SMB':   { lat: 34.013, lon: -118.491, name: 'Downtown Santa Monica Station' },
            },
            trips: {
                'T-E': { rc: '804', dir: 0, stops: ['CC', 'PALMS', 'SMB'], scheduledTimes: [0, 60, 120] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'e-line-track',
            effect: 'MODIFIED_SERVICE',
            routes: ['804'],
            stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will share 1 track at Culver City and Palms Stations.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.size).toBeGreaterThan(0));

        // Both named stations must light up.
        expect(getActiveStopAlerts('CC')).toHaveLength(1);
        expect(getActiveStopAlerts('PALMS')).toHaveLength(1);
        // An un-mentioned station on the same route must NOT light up.
        expect(getActiveStopAlerts('SMB')).toHaveLength(0);
    });

    it('no-Station bare alias does NOT match station name appearing in street-name prose', async () => {
        // Regression guard for the lookahead gate added to the no-Station alias.
        // "Washington Blvd" in alert prose must not tag Washington Station —
        // the alias should only fire when "Station" or "Stations" follows
        // the bare name later in the same sentence.
        installGlobals({
            stops: {
                'WASH': { lat: 34.028, lon: -118.31,  name: 'Washington Station' },
                'SMB':  { lat: 34.013, lon: -118.491, name: 'Downtown Santa Monica Station' },
            },
            trips: {
                'T-E': { rc: '804', dir: 0, stops: ['WASH', 'SMB'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'e-line-detour',
            effect: 'DETOUR',
            routes: ['804'],
            stops: [],
            headerText: 'Detour',
            descriptionText: 'E Line trains detour via Washington Blvd due to construction.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        // Wait for the fetch cycle to complete; the map should still be empty
        // (no stop-level match) or at worst not contain WASH.
        await vi.waitFor(() => expect(window.masterStopAlertsData).toBeDefined());
        await new Promise(resolve => setTimeout(resolve, 50));

        // "Washington Blvd" must NOT trigger a match for Washington Station.
        expect(getActiveStopAlerts('WASH')).toHaveLength(0);
    });

    it('matches a slash-named STATION by its first segment ("Heritage Square")', async () => {
        installGlobals({
            stops: {
                'HS': { lat: 34.09, lon: -118.21, name: 'Heritage Square / Arroyo Station' },
                'SW': { lat: 34.08, lon: -118.22, name: 'Southwest Museum Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['HS', 'SW'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'hs-delay', effect: 'MODIFIED_SERVICE', routes: ['801'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will not stop at Heritage Square Station due to maintenance.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('HS')).toBe(true));
        expect(getActiveStopAlerts('HS')).toHaveLength(1);
    });

    it('does NOT tag sibling stations that share a first segment ("Expo / *")', async () => {
        // Regression: LA Metro's cross-street naming means many stations share a
        // first segment — the E Line has Expo/Western, Expo/Vermont,
        // Expo/Crenshaw, etc. An alert naming "Expo/Western Station" must badge
        // ONLY Expo/Western, not every Expo stop (the bare "\bExpo\b" first-
        // segment alias must be suppressed because "Expo" is not unique).
        installGlobals({
            stops: {
                'EXPW':  { lat: 34.02, lon: -118.31, name: 'Expo / Western Station' },
                'EXPV':  { lat: 34.02, lon: -118.29, name: 'Expo / Vermont Station' },
                'EXPC':  { lat: 34.02, lon: -118.33, name: 'Expo / Crenshaw Station' },
            },
            trips: {
                'T-E': { rc: '804', dir: 0, stops: ['EXPW', 'EXPV', 'EXPC'], scheduledTimes: [0, 60, 120] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'expo-track', effect: 'MODIFIED_SERVICE', routes: ['804'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will share 1 track at Expo/Western Station due to maintenance.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('EXPW')).toBe(true));

        expect(getActiveStopAlerts('EXPW')).toHaveLength(1);   // named (via primary/2b)
        expect(getActiveStopAlerts('EXPV')).toHaveLength(0);   // sibling — must NOT match
        expect(getActiveStopAlerts('EXPC')).toHaveLength(0);   // sibling — must NOT match
    });

    it('does NOT badge a slash-named INTERSECTION stop when prose mentions one segment as a street', async () => {
        // Regression: J Line street stops like "Figueroa / 23rd" are NOT
        // stations. A J Line alert mentioning "Figueroa" as a street must not
        // emit a bare "\bFigueroa\b" alias and mis-badge every Figueroa stop.
        installGlobals({
            stops: {
                'FIG23': { lat: 34.02, lon: -118.27, name: 'Figueroa / 23rd' },
                'FIGPICO': { lat: 34.03, lon: -118.27, name: 'Figueroa / Pico' },
                'JTERM': { lat: 34.06, lon: -118.26, name: 'Harbor Gateway Transit Center Station' },
            },
            trips: {
                'T-J': { rc: '910', dir: 0, stops: ['FIG23', 'FIGPICO', 'JTERM'], scheduledTimes: [0, 60, 120] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'j-detour', effect: 'DETOUR', routes: ['910'], stops: [],
            headerText: 'Detour',
            descriptionText: 'J Line buses detour off Figueroa Street between downtown and the 110 freeway.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(getActiveStopAlerts('FIG23')).toHaveLength(0);
        expect(getActiveStopAlerts('FIGPICO')).toHaveLength(0);
    });
});

describe('per-stop badge scoping (feed over-listing)', () => {
    // A 6-stop A Line so the route-wide threshold (≥ 2/3 = 4 of 6) is testable.
    beforeEach(() => {
        installGlobals({
            stops: {
                '80101': { lat: 34.10, lon: -118.20, name: 'Lake Station' },
                '80102': { lat: 34.11, lon: -118.21, name: 'Memorial Park Station' },
                '80103': { lat: 34.12, lon: -118.22, name: 'Del Mar Station' },
                '80104': { lat: 34.13, lon: -118.23, name: 'Fillmore Station' },
                '80105': { lat: 34.14, lon: -118.24, name: 'South Pasadena Station' },
                '80106': { lat: 34.15, lon: -118.25, name: 'Highland Park Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0,
                         stops: ['80101', '80102', '80103', '80104', '80105', '80106'],
                         scheduledTimes: [0, 60, 120, 180, 240, 300] },
            },
        });
        initPredictions();
    });

    it('narrows an over-listed feed to the single station named in the prose', async () => {
        // Real-world (first screenshot): "delays ... at Del Mar Station" but the
        // feed tags Del Mar PLUS its neighbors Lake + Memorial Park. Only the
        // named station should get a map-dot badge.
        const a = makeRawAlert({
            id: 'a-delmar',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['801'],
            stops: ['80101', '80102', '80103'],   // feed over-lists 3 stops
            headerText: 'Modified service',
            descriptionText: 'Trains are experiencing delays of up to 15 minutes due to earlier signaling issues at Del Mar Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80103')).toBe(true));

        expect(getActiveStopAlerts('80103')).toHaveLength(1);   // Del Mar (named)
        expect(getActiveStopAlerts('80101')).toHaveLength(0);   // Lake (over-listed)
        expect(getActiveStopAlerts('80102')).toHaveLength(0);   // Memorial Park (over-listed)
        // Route-level entry preserved for the legend badge + station popups.
        expect(getActiveAlerts('801')).toHaveLength(1);
    });

    it('narrows a route-wide feed to the one incidentally-named station', async () => {
        // Real-world (E Line "every 11 min"): the feed tags every stop but the
        // prose names only the track-sharing station. Narrow to that one.
        const a = makeRawAlert({
            id: 'a-elevenmin',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: ['80101', '80102', '80103', '80104', '80105', '80106'],  // all 6
            headerText: 'Modified service',
            descriptionText: 'A Line trains run every 11 minutes due to maintenance. Trains will share 1 track at Fillmore Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80104')).toBe(true));

        expect(getActiveStopAlerts('80104')).toHaveLength(1);   // Fillmore (named)
        expect(getActiveStopAlerts('80101')).toHaveLength(0);
        expect(getActiveStopAlerts('80106')).toHaveLength(0);
    });

    it('suppresses ALL per-stop badges for a route-wide alert that names no station', async () => {
        // Feed tags ≥ 2/3 of the route and the prose names no station → it's a
        // system-wide change. No map-dot badges; legend badge only.
        const a = makeRawAlert({
            id: 'a-systemwide',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['801'],
            stops: ['80101', '80102', '80103', '80104', '80105'],  // 5 of 6 = 83%
            headerText: 'Major delays',
            descriptionText: 'A Line trains are experiencing systemwide delays due to police activity.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 20));

        for (const id of ['80101', '80102', '80103', '80104', '80105', '80106']) {
            expect(getActiveStopAlerts(id)).toHaveLength(0);
        }
        // Route-level entry preserved.
        expect(getActiveAlerts('801')).toHaveLength(1);
    });

    it('keeps all feed stops when a small explicit set names no station', async () => {
        // A genuine 2-stop closure with no station named in prose (below the
        // route-wide threshold) keeps both feed stops — we only suppress when
        // the feed is route-wide.
        const a = makeRawAlert({
            id: 'a-twostop',
            effect: 'NO_SERVICE',
            routes: ['801'],
            stops: ['80101', '80102'],  // 2 of 6 = 33%, below threshold
            headerText: 'No service',
            descriptionText: 'Buses are replacing trains in this area.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80101')).toBe(true));

        expect(getActiveStopAlerts('80101')).toHaveLength(1);
        expect(getActiveStopAlerts('80102')).toHaveLength(1);
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

    it('inserts the active-period line between title and body', () => {
        const text = buildAlertTooltipText('Delays', {
            header: 'Signaling issue at Del Mar Station',
            description: 'Trains delayed up to 15 minutes.',
            activePeriod: { start: 1717340160, end: Infinity },
        });
        const lines = text.split('\n');
        expect(lines[0]).toBe('Delays: Signaling issue at Del Mar Station');
        expect(lines[1]).toMatch(/^Active from /);   // period directly under title
        expect(text).toContain('\n\nTrains delayed up to 15 minutes.');
    });
});

describe('buildAlertTooltipBlock — structured form for DOM rendering', () => {
    it('returns {prefix, title, body, period} with body empty when description is missing', () => {
        const block = buildAlertTooltipBlock('Detour', {
            header: 'Bus routes 720 and 920 detoured',
            description: '',
        });
        expect(block).toEqual({
            prefix: 'Detour',
            title: 'Bus routes 720 and 920 detoured',
            body: '',
            period: '',   // no activePeriod → empty
        });
    });

    it('includes the active-period line when the alert carries an activePeriod', () => {
        const block = buildAlertTooltipBlock('Delays', {
            header: 'Signaling issue',
            description: '',
            activePeriod: { start: 1717340160, end: Infinity },  // open-ended
        });
        expect(block.period).toMatch(/^Active from /);
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
        expect(buildAlertTooltipBlock('X', {})).toEqual({ prefix: 'X', title: '', body: '', period: '' });
        expect(buildAlertTooltipBlock('X', null)).toEqual({ prefix: 'X', title: '', body: '', period: '' });
        expect(buildAlertTooltipBlock('X', undefined)).toEqual({ prefix: 'X', title: '', body: '', period: '' });
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

describe('effectSeverity', () => {
    it('NO_SERVICE → severe', () => {
        expect(effectSeverity('NO_SERVICE')).toBe('severe');
    });

    it('SIGNIFICANT_DELAYS → severe', () => {
        expect(effectSeverity('SIGNIFICANT_DELAYS')).toBe('severe');
    });

    it('DETOUR → moderate', () => {
        expect(effectSeverity('DETOUR')).toBe('moderate');
    });

    it('REDUCED_SERVICE → moderate', () => {
        expect(effectSeverity('REDUCED_SERVICE')).toBe('moderate');
    });

    it('MODIFIED_SERVICE → moderate', () => {
        expect(effectSeverity('MODIFIED_SERVICE')).toBe('moderate');
    });

    it('STOP_MOVED → moderate', () => {
        expect(effectSeverity('STOP_MOVED')).toBe('moderate');
    });

    it('OTHER_EFFECT → moderate', () => {
        expect(effectSeverity('OTHER_EFFECT')).toBe('moderate');
    });

    it('UNKNOWN_EFFECT → moderate', () => {
        expect(effectSeverity('UNKNOWN_EFFECT')).toBe('moderate');
    });

    it('unrecognised effect → moderate (fallback)', () => {
        expect(effectSeverity('BRAND_NEW_METRO_EFFECT')).toBe('moderate');
        expect(effectSeverity(undefined)).toBe('moderate');
        expect(effectSeverity('')).toBe('moderate');
    });
});

describe('maxSeverity', () => {
    it('returns null for empty array', () => {
        expect(maxSeverity([])).toBeNull();
    });

    it('returns moderate when all alerts are moderate', () => {
        const alerts = [
            { effect: 'DETOUR' },
            { effect: 'REDUCED_SERVICE' },
            { effect: 'MODIFIED_SERVICE' },
        ];
        expect(maxSeverity(alerts)).toBe('moderate');
    });

    it('returns severe and short-circuits on first severe alert', () => {
        // The second element has a getter that throws — if short-circuit is
        // removed and the loop reaches it, the test will throw an error,
        // proving the short-circuit is necessary. With the real early return
        // after the first 'severe', the getter is never accessed.
        const alerts = [
            { effect: 'NO_SERVICE' },
            { get effect() { throw new Error('should not reach'); } },
        ];
        expect(maxSeverity(alerts)).toBe('severe');
    });

    it('returns severe when mixed severe + moderate alerts are present', () => {
        const alerts = [
            { effect: 'DETOUR' },
            { effect: 'SIGNIFICANT_DELAYS' },
            { effect: 'REDUCED_SERVICE' },
        ];
        expect(maxSeverity(alerts)).toBe('severe');
    });

    it('returns severe even when severe alert appears last in the list', () => {
        const alerts = [
            { effect: 'DETOUR' },
            { effect: 'MODIFIED_SERVICE' },
            { effect: 'NO_SERVICE' },
        ];
        expect(maxSeverity(alerts)).toBe('severe');
    });

    it('returns moderate (not null) for a single-element moderate array', () => {
        expect(maxSeverity([{ effect: 'DETOUR' }])).toBe('moderate');
    });

    it('treats unrecognised effects as moderate (fallback applied inside maxSeverity)', () => {
        const alerts = [
            { effect: 'FUTURE_METRO_CODE' },
        ];
        expect(maxSeverity(alerts)).toBe('moderate');
    });
});

describe('three-tier activePeriods selection', () => {
    // These tests exercise the period-selection logic inside _ingest via the
    // full pollAlerts integration path (same technique as the other integration
    // tests in this file).

    it('tier-1: picks a currently-active period over an expired one listed first', async () => {
        const now = NOW();
        const expiredStart = now - 7200;
        const expiredEnd   = now - 3600;  // already over
        const activeStart  = now - 60;
        const activeEnd    = now + 3600;

        const a = {
            id: 'multi-period',
            effect: 'DETOUR',
            headerText: 'Detour',
            descriptionText: '',
            informedEntities: [{ routeId: '801' }],
            activePeriods: [
                // Expired period listed FIRST — tier-1 must skip it.
                { start: new Date(expiredStart * 1000).toISOString(),
                  end:   new Date(expiredEnd   * 1000).toISOString() },
                // Currently-active period listed SECOND — tier-1 must pick this.
                { start: new Date(activeStart  * 1000).toISOString(),
                  end:   new Date(activeEnd    * 1000).toISOString() },
            ],
        };

        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.has('801')).toBe(true));

        const entry = window.masterAlertsData.get('801')[0];
        expect(entry.activePeriod.start).toBe(activeStart);
        expect(entry.activePeriod.end).toBe(activeEnd);
    });

    it('tier-2: falls back to next upcoming period when no period is currently active', async () => {
        const now = NOW();
        const expiredStart  = now - 7200;
        const expiredEnd    = now - 3600;   // already over
        const futureStart   = now + 3600;
        const futureEnd     = now + 7200;

        const a = {
            id: 'future-period',
            effect: 'DETOUR',
            headerText: 'Scheduled detour',
            descriptionText: '',
            informedEntities: [{ routeId: '801' }],
            activePeriods: [
                // Expired period first — neither tier-1 nor tier-2 should pick it.
                { start: new Date(expiredStart * 1000).toISOString(),
                  end:   new Date(expiredEnd   * 1000).toISOString() },
                // Future (not yet started) period — tier-2 selects this.
                { start: new Date(futureStart  * 1000).toISOString(),
                  end:   new Date(futureEnd    * 1000).toISOString() },
            ],
        };

        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.has('801')).toBe(true));

        const entry = window.masterAlertsData.get('801')[0];
        expect(entry.activePeriod.start).toBe(futureStart);
        expect(entry.activePeriod.end).toBe(futureEnd);
    });

    it('tier-3: uses activePeriods[0] as last resort when all periods are expired', async () => {
        // Both activePeriods are expired → alert is dropped (size === 0).
        // The end<now expiry guard fires on whichever period tier-3 selects,
        // and the result is the same regardless of which one is picked — we
        // verify that _ingest completes without throwing and that the alert
        // is correctly absent from masterAlertsData.
        const now = NOW();
        const a = {
            id: 'all-expired',
            effect: 'DETOUR',
            headerText: 'Old detour',
            descriptionText: '',
            informedEntities: [{ routeId: '801' }],
            activePeriods: [
                { start: new Date((now - 7200) * 1000).toISOString(),
                  end:   new Date((now - 5400) * 1000).toISOString() },
                { start: new Date((now - 5400) * 1000).toISOString(),
                  end:   new Date((now - 3600) * 1000).toISOString() },
            ],
        };

        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        // Wait for the fetch to complete; the map must stay empty because both
        // periods are expired (end < now) and _ingest drops the alert.
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        // Flush one extra tick so _ingest finishes.
        await new Promise(resolve => setTimeout(resolve, 50));

        // Alert dropped by expiry filter — tier-3 path was exercised without
        // throwing and the result correctly hit the downstream expiry guard.
        expect(window.masterAlertsData.size).toBe(0);
    });
});
