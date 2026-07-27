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

import { getActiveAlerts, getActiveStopAlerts, getActiveStopAccessibilityAlerts, classifyAccessibilityAlert, initAlerts, buildAlertTooltipText, buildAlertTooltipBlock, effectSeverity, maxSeverity, getAlertsFeedHealth, _clearStationIndexCache, _resetAlertsStateForTest } from '../js/alerts.js';
import { initPredictions } from '../js/predictions.js';
import { BUS_ALERTS_URL } from '../js/config.js';
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
    _resetAlertsStateForTest();   // clear feed-health streak + any leaked retry timer
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
            ok: true,
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterStopAccessibilityAlertsData?.has('80101')).toBe(true);
        });
        expect(window.masterAlertsData.size).toBe(0);
        expect(window.masterStopAlertsData.size).toBe(0);
        expect(getActiveStopAccessibilityAlerts('80101')).toHaveLength(1);
    });

    it('keeps a strong service effect route-level even when its prose mentions elevators (B4)', async () => {
        // Real-world shape: "B Line: No service North Hollywood–Universal City.
        // Bus shuttles will serve all stations. Elevators at NoHo remain available."
        // The elevator/escalator text fallback exists only to catch Metro's
        // OTHER_EFFECT-mislabeled accessibility alerts — it must NOT reclassify a
        // NO_SERVICE alert as accessibility, which would drop its route badge AND
        // its bus bridge (detectBusBridges reads only masterAlertsData), leaving
        // the whole closure rendered as a lone blue ♿.
        const a = makeRawAlert({
            id: 'noho', effect: 'NO_SERVICE',
            routes: ['802'], stops: ['80101'],
            headerText: 'B Line: No service North Hollywood–Universal City',
            descriptionText: 'Bus shuttles will serve all stations. Elevators at North Hollywood remain available for shuttle boarding.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => {
            expect(window.masterAlertsData?.has('802')).toBe(true);
        });
        // Stays a route-level service alert; NOT diverted into the accessibility map.
        expect(getActiveAlerts('802').map(x => x.id)).toEqual(['noho']);
        expect(window.masterStopAccessibilityAlertsData?.has('80101') ?? false).toBe(false);
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([detour, elev]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData).toBeDefined());
        expect(window.masterStopAccessibilityAlertsData.size).toBe(0);
    });

    it('treats missing end as open-ended (Infinity)', async () => {
        const a = makeRawAlert({ id: 'open', start: NOW() - 100, end: null });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.has('801')).toBe(true));
        const entry = window.masterAlertsData.get('801')[0];
        expect(entry.activePeriod.end).toBe(Infinity);
        // And it shows up via getActiveAlerts.
        expect(getActiveAlerts('801')).toHaveLength(1);
    });

    it('drops alerts where end < now (already expired at ingest)', async () => {
        const a = makeRawAlert({ id: 'expired', start: NOW() - 7200, end: NOW() - 3600 });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
    });

    it('drops alerts whose informedEntities target no relevant route', async () => {
        const a = makeRawAlert({ id: 'irrelevant', routes: ['9999'],
                                  start: NOW() - 100, end: NOW() + 3600 });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));

        expect(getActiveStopAlerts('80101')).toHaveLength(1);   // rail Allen — matched
        expect(getActiveStopAlerts('90101')).toHaveLength(0);   // bus Allen/Colorado — not matched
    });

    it('prose-named stations are ADDED to feed-side stopIds (Sepulveda rule — policy reversal)', async () => {
        // POLICY REVERSAL (2026-06, the G Line Sepulveda detour): this test
        // used to pin "feed targeting beats text mining — don't add text
        // matches when informedEntities has stopIds." That policy broke when
        // Metro tagged the SERVED stops of a detour while the prose named the
        // SKIPPED station ("stop Sepulveda Station will not be served") — the
        // alert's actual subject was exactly the stop missing from the feed
        // set, and it lost its map-dot badge. Feed targeting is NOT
        // authoritative about the alert's subject. Prose-named stations are
        // now unioned into the badge set (alerts.js badge rule 3) — fittingly,
        // this fixture's own prose says Allen is "also affected".
        const a = makeRawAlert({
            id: 'feed-targeted',
            effect: 'NO_SERVICE',
            routes: ['801'],
            stops: ['80202'],   // Pico explicitly
            descriptionText: 'No service at Pico Station. Allen Station also affected by a separate issue.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('80202')).toBe(true));

        // 80202 (Pico) tagged via informedEntities — yes.
        expect(getActiveStopAlerts('80202')).toHaveLength(1);
        // 80101 (Allen) named in prose — unioned in (was 0 under the old policy).
        expect(getActiveStopAlerts('80101')).toHaveLength(1);
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.size).toBeGreaterThan(0));
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(getActiveStopAlerts('FIG23')).toHaveLength(0);
        expect(getActiveStopAlerts('FIGPICO')).toHaveLength(0);
    });

    it('does NOT cross-tag Grand/LATTC when an alert names "Grand Ave Arts / Bunker Hill Station"', async () => {
        // Real-world bug: "Grand" is the first slash-segment of "Grand / LATTC
        // Station" AND a leading word in "Grand Ave Arts / Bunker Hill Station".
        // Without the prefix-collision guard, \bGrand\b (the first-segment alias
        // for Grand/LATTC) would fire on "Grand Ave Arts / Bunker Hill Station"
        // text and tag the wrong stop.
        installGlobals({
            stops: {
                'LATTC':    { lat: 34.02, lon: -118.27, name: 'Grand / LATTC Station' },
                'GRAND-AV': { lat: 34.05, lon: -118.25, name: 'Grand Ave Arts / Bunker Hill Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['LATTC', 'GRAND-AV'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'grand-av-alert', effect: 'MODIFIED_SERVICE', routes: ['801'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will not stop at Grand Ave Arts / Bunker Hill Station due to maintenance.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('GRAND-AV')).toBe(true));

        expect(getActiveStopAlerts('GRAND-AV')).toHaveLength(1);   // correct station
        expect(getActiveStopAlerts('LATTC')).toHaveLength(0);      // must NOT be cross-tagged
    });

    it('matches a "Transit Center" station by its prose spelling, not the abbreviated "TC"', async () => {
        // cleanStationName abbreviates "Transit Center" → "TC" for compact
        // display, but Metro's alert prose always spells it out. Building the
        // match regex with abbreviateTransitCenter=false keeps "Transit Center"
        // in the pattern; treating it as a station-type terminator means the
        // primary doesn't demand a redundant trailing "Station" word.
        installGlobals({
            stops: {
                'LAXTC': { lat: 33.946, lon: -118.378, name: 'LAX / Metro Transit Center' },
                'HGTC':  { lat: 33.828, lon: -118.281, name: 'Harbor Gateway Transit Center' },
            },
            trips: {
                'T-C': { rc: '803', dir: 0, stops: ['LAXTC'], scheduledTimes: [0] },
                'T-J': { rc: '910', dir: 0, stops: ['HGTC'],  scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'lax-tc', effect: 'MODIFIED_SERVICE', routes: ['803'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'C Line trains will not stop at LAX / Metro Transit Center Station due to maintenance.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        const b = makeRawAlert({
            id: 'hg-tc', effect: 'DETOUR', routes: ['910'], stops: [],
            headerText: 'Detour',
            descriptionText: 'J Line buses will board at Harbor Gateway Transit Center.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a, b]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('LAXTC')).toBe(true));

        expect(getActiveStopAlerts('LAXTC')).toHaveLength(1);
        // Harbor Gateway prose drops "Station" entirely — the TC terminator
        // means the primary still matches "Harbor Gateway Transit Center".
        expect(getActiveStopAlerts('HGTC')).toHaveLength(1);
    });

    it('does NOT double-tag "Pico" and "Pico / Aliso" when both routes are in scope', async () => {
        // Real-world risk: A Line "Pico Station" (80121) emits a bare \bPico\b
        // no-Station alias; E Line "Pico / Aliso Station" (80407) emits a bare
        // \bPico\b first-segment alias. On a cross-route 801+804 alert (they
        // share Regional Connector track), "Pico Station" text would fire both.
        // The ambiguous-bare-key guard drops both bare aliases — each station
        // matches only via its own primary full-name regex.
        installGlobals({
            stops: {
                'PICO':  { lat: 34.040, lon: -118.266, name: 'Pico Station' },
                'ALISO': { lat: 34.050, lon: -118.235, name: 'Pico / Aliso Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['PICO'],  scheduledTimes: [0] },
                'T-E': { rc: '804', dir: 0, stops: ['ALISO'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        // Alert about the standalone Pico Station — must NOT tag Pico / Aliso.
        const a = makeRawAlert({
            id: 'pico-only', effect: 'SIGNIFICANT_DELAYS', routes: ['801', '804'], stops: [],
            headerText: 'Delays',
            descriptionText: 'Trains are experiencing delays at Pico Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('PICO')).toBe(true));

        expect(getActiveStopAlerts('PICO')).toHaveLength(1);    // named, via primary
        expect(getActiveStopAlerts('ALISO')).toHaveLength(0);   // must NOT cross-tag
    });

    it('still matches "Pico / Aliso Station" by its own primary without tagging "Pico"', async () => {
        // The reverse direction of the guard: an alert about Pico / Aliso must
        // hit ALISO (primary full-name regex) but NOT the standalone Pico whose
        // bare \bPico\b alias is now suppressed.
        installGlobals({
            stops: {
                'PICO':  { lat: 34.040, lon: -118.266, name: 'Pico Station' },
                'ALISO': { lat: 34.050, lon: -118.235, name: 'Pico / Aliso Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['PICO'],  scheduledTimes: [0] },
                'T-E': { rc: '804', dir: 0, stops: ['ALISO'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'aliso-only', effect: 'MODIFIED_SERVICE', routes: ['801', '804'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will not stop at Pico / Aliso Station due to construction.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('ALISO')).toBe(true));

        expect(getActiveStopAlerts('ALISO')).toHaveLength(1);   // named, via primary
        expect(getActiveStopAlerts('PICO')).toHaveLength(0);    // bare alias suppressed
    });

    it('still emits the bare alias for "Lake" despite "Lakewood Blvd" (word boundary, not key prefix)', async () => {
        // Regression guard for the ambiguity test: it must compare on a real \b
        // word boundary against the names, NOT a prefix test on punctuation-
        // stripped keys. "lake" is a string-prefix of "lakewoodblvd", but
        // \bLake\b can never match "Lakewood" — so Lake's no-Station (2b) alias
        // must still be emitted and the "[A] and [B] Stations" list pattern
        // must still tag Lake.
        installGlobals({
            stops: {
                'LAKE':  { lat: 34.146, lon: -118.131, name: 'Lake Station' },
                'LKWD':  { lat: 33.949, lon: -118.122, name: 'Lakewood Blvd Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['LAKE'], scheduledTimes: [0] },
                'T-C': { rc: '803', dir: 0, stops: ['LKWD'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'lake-list', effect: 'MODIFIED_SERVICE', routes: ['801', '803'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will share 1 track at Allen and Lake Stations.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('LAKE')).toBe(true));

        expect(getActiveStopAlerts('LAKE')).toHaveLength(1);   // bare alias survives
        expect(getActiveStopAlerts('LKWD')).toHaveLength(0);   // \bLake\b never hits Lakewood
    });

    it('does NOT tag standalone "Crenshaw" when prose names "Expo / Crenshaw Station"', async () => {
        // "Crenshaw C-Line Station" cleans to bare "Crenshaw", whose primary
        // \bCrenshaw\s+Station\b would otherwise fire on the TAIL of "Expo /
        // Crenshaw Station" (a different stop). The tail guard anchors the
        // primary so it can't follow a "/" separator.
        installGlobals({
            stops: {
                'CREN':    { lat: 33.990, lon: -118.335, name: 'Crenshaw C-Line Station' },
                'EXPCREN': { lat: 34.018, lon: -118.335, name: 'Expo / Crenshaw Station' },
            },
            trips: {
                'T-C': { rc: '803', dir: 0, stops: ['CREN'],    scheduledTimes: [0] },
                'T-E': { rc: '804', dir: 0, stops: ['EXPCREN'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'expo-cren', effect: 'MODIFIED_SERVICE', routes: ['803', '804'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will not stop at Expo / Crenshaw Station due to maintenance.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('EXPCREN')).toBe(true));

        expect(getActiveStopAlerts('EXPCREN')).toHaveLength(1);   // the real Expo/Crenshaw
        expect(getActiveStopAlerts('CREN')).toHaveLength(0);      // not the C Line Crenshaw
    });

    it('still tags standalone "Crenshaw Station" on its own alert (tail guard keeps the leading match)', async () => {
        installGlobals({
            stops: {
                'CREN':    { lat: 33.990, lon: -118.335, name: 'Crenshaw C-Line Station' },
                'EXPCREN': { lat: 34.018, lon: -118.335, name: 'Expo / Crenshaw Station' },
            },
            trips: {
                'T-C': { rc: '803', dir: 0, stops: ['CREN'],    scheduledTimes: [0] },
                'T-E': { rc: '804', dir: 0, stops: ['EXPCREN'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'cren-only', effect: 'SIGNIFICANT_DELAYS', routes: ['803', '804'], stops: [],
            headerText: 'Delays',
            descriptionText: 'Major delays at Crenshaw Station this evening.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('CREN')).toBe(true));

        expect(getActiveStopAlerts('CREN')).toHaveLength(1);      // leading match survives
        expect(getActiveStopAlerts('EXPCREN')).toHaveLength(0);   // Expo/Crenshaw not named
    });

    it('matches a station whose GTFS name has a double space before "Station"', async () => {
        // Some GTFS names carry a stray double space ("103rd Street / Watts
        // Towers  Station"). Internal whitespace is collapsed at candidate
        // collection so the primary matches the single-spaced prose spelling.
        installGlobals({
            stops: {
                'WATTS': { lat: 33.942, lon: -118.243, name: '103rd Street / Watts Towers  Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['WATTS'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'watts', effect: 'MODIFIED_SERVICE', routes: ['801'], stops: [],
            headerText: 'Modified service',
            descriptionText: 'Trains will not stop at 103rd Street / Watts Towers Station due to maintenance.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('WATTS')).toBe(true));

        expect(getActiveStopAlerts('WATTS')).toHaveLength(1);
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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
            return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
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

    it('keeps rail alerts when the bus feed 502s (decoupled — was Promise.all)', async () => {
        // Production: the bus alerts Lambda 502s intermittently. Promise.all
        // rejected the whole gather, so a bus 502 discarded GOOD rail alerts too.
        // allSettled + per-feed ok-check must keep the live feed's alerts.
        const railAlert = makeRawAlert({
            id: 'rail-only', effect: 'DETOUR', routes: ['801'],
            headerText: 'A Line detour', start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn((url) => {
            if (String(url) === BUS_ALERTS_URL) {
                // 502: non-2xx with a non-JSON body (json() would throw).
                return Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve([railAlert]) });
        });
        initAlerts();
        await vi.waitFor(() => {
            expect(getActiveAlerts('801').length).toBeGreaterThan(0);
        });
        // Rail alert survived the bus outage instead of being discarded with it.
        expect(getActiveAlerts('801')[0].id).toBe('rail-only');
    });

    it('treats a 502 (non-2xx) as a failure and does NOT ingest its body even if it parses as JSON', async () => {
        // Without the per-feed ok-check, a 502 error body that happens to be JSON
        // would be ingested as real alert data. Both feeds 502 → nothing ingested,
        // failure counted. (Covers the ok-check + the allSettled total-failure path.)
        vi.useFakeTimers();
        const before = getAlertsFeedHealth().consecutiveFailures;
        global.fetch = vi.fn(() => Promise.resolve({
            ok: false, status: 502,
            json: () => Promise.resolve([makeRawAlert({ id: 'leak', routes: ['801'], start: NOW() - 100, end: NOW() + 3600 })]),
        }));
        initAlerts();
        await vi.advanceTimersByTimeAsync(50);
        expect(getAlertsFeedHealth().consecutiveFailures).toBeGreaterThan(before);
        expect(window.masterAlertsData.size).toBe(0);   // 502 body NOT ingested
        expect(getActiveAlerts('801')).toHaveLength(0);
        vi.useRealTimers();   // discards the pending 10s retry timer
    });

    it('failure streak increments on a total outage and resets to 0 on recovery', async () => {
        // getAlertsFeedHealth drives the "alerts unavailable" UI — verify the
        // streak counter climbs on failure and zeroes on the next success.
        vi.useFakeTimers();
        let mode = 'fail';
        global.fetch = vi.fn(() => mode === 'fail'
            ? Promise.reject(new Error('outage'))
            : Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));
        initAlerts();
        await vi.advanceTimersByTimeAsync(50);              // initial round fails
        expect(getAlertsFeedHealth().consecutiveFailures).toBeGreaterThanOrEqual(1);
        mode = 'ok';
        await vi.advanceTimersByTimeAsync(11_000);          // single retry succeeds
        expect(getAlertsFeedHealth().consecutiveFailures).toBe(0);
        expect(getAlertsFeedHealth().everSucceeded).toBe(true);
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
    it('returns {prefix, title, body, period, routes} with body empty when description is missing', () => {
        const block = buildAlertTooltipBlock('Detour', {
            header: 'Bus routes 720 and 920 detoured',
            description: '',
        });
        expect(block).toEqual({
            prefix: 'Detour',
            title: 'Bus routes 720 and 920 detoured',
            body: '',
            period: '',   // no activePeriod → empty
            routes: [],   // no informedEntities → no line logos
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

    it('keeps a superset description in the body (title empty) when the alert is dated, so the period sits under the prefix', () => {
        // Regression: a detour whose description was a superset of its header
        // got the whole description promoted INTO the title, pushing the
        // "Active: …" line below the body — while a normal dated alert showed
        // it directly under the title. With a period present the prose stays in
        // `body` so the period renders in the same spot for every alert.
        const block = buildAlertTooltipBlock('Detour', {
            header: 'Buses detour via Erwin and Sepulveda',
            description: 'Buses detour via Erwin and Sepulveda due to construction.',
            activePeriod: { start: 1717340160, end: 1717426560 },
        });
        expect(block.title).toBe('');
        expect(block.body).toBe('Buses detour via Erwin and Sepulveda due to construction.');
        expect(block.period).toMatch(/^Active:/);
    });

    it('handles missing alert fields (empty strings) without throwing', () => {
        const empty = { prefix: 'X', title: '', body: '', period: '', routes: [] };
        expect(buildAlertTooltipBlock('X', {})).toEqual(empty);
        expect(buildAlertTooltipBlock('X', null)).toEqual(empty);
        expect(buildAlertTooltipBlock('X', undefined)).toEqual(empty);
    });

    // ── routes: the line-logo row on the tooltip's top line ──────────────
    it('surfaces the alert\'s informed route codes for the line-logo row', () => {
        const block = buildAlertTooltipBlock('Detour', {
            header: 'Buses detoured',
            description: '',
            informedEntities: [{ routeId: '801' }, { routeId: '802' }],
        });
        expect(block.routes).toEqual(['801', '802']);   // A, B
    });

    it('dedupes the J Line (910 rapid + 950 commuter share one icon)', () => {
        const block = buildAlertTooltipBlock('No service', {
            header: 'Stop closure',
            description: '',
            informedEntities: [{ routeId: '910' }, { routeId: '950' }],
        });
        expect(block.routes).toEqual(['910']);
    });

    it('drops non-Metro (bus) routeIds — they have no line icon', () => {
        const block = buildAlertTooltipBlock('No service', {
            header: 'Lines 460, 81, & J Line stop closure',
            description: '',
            informedEntities: [{ routeId: '460' }, { routeId: '81' }, { routeId: '910' }],
        });
        expect(block.routes).toEqual(['910']);
    });

    it('reads routes off a STORED entry, which has no informedEntities', async () => {
        // Regression (shipped as a no-op in #607): the object the tooltip layer
        // actually renders is the normalized ingestion `entry`, which drops
        // informedEntities. Reading only informedEntities meant production
        // always resolved zero routes and never drew a logo — while hand-built
        // test alerts (which DO carry informedEntities) passed. This test drives
        // the REAL pipeline so the two shapes can't diverge again.
        const raw = makeRawAlert({
            id: 'stored-shape',
            effect: 'NO_SERVICE',
            routes: ['460', '81', '910'],   // two bus lines + the J Line
            stops: ['80214'],
            headerText: 'Lines 460, 81, & J Line Stop Closure',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([raw]) }));
        initAlerts();
        await vi.waitFor(() => expect(getActiveStopAlerts('80214')).toHaveLength(1));

        const stored = getActiveStopAlerts('80214')[0];
        expect(stored.informedEntities).toBeUndefined();   // the shape that broke it
        expect(buildAlertTooltipBlock('No service', stored).routes).toEqual(['910']);
    });

    it('sorts by line letter, not by feed order or route code', () => {
        // 805 = D, 804 = E. Sorting by CODE would put E before D.
        const block = buildAlertTooltipBlock('Delays', {
            header: 'Signal problem',
            description: '',
            informedEntities: [{ routeId: '804' }, { routeId: '805' }],
        });
        expect(block.routes).toEqual(['805', '804']);   // D, then E
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

        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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

        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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

        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
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

    it('P3: skips a NaN-end period and falls through to the next valid period', async () => {
        // Regression for P3: normalizeTimestamp returns NaN for unparseable input.
        // Old code: `Number.isFinite(e) ? e > now : true` — NaN passed (isFinite(NaN)===false),
        // selecting the malformed period and skipping the valid one behind it.
        // New code: `e === Infinity` — NaN is rejected, find() advances.
        const now = NOW();
        const futureStart = now + 3600;
        const futureEnd   = now + 7200;

        const a = {
            id: 'nan-period',
            effect: 'DETOUR',
            headerText: 'Detour',
            descriptionText: '',
            informedEntities: [{ routeId: '801' }],
            activePeriods: [
                // Malformed period — 'end' is not parseable
                { start: new Date((now - 7200) * 1000).toISOString(), end: 'not-a-date' },
                // Valid upcoming period — must be selected
                { start: new Date(futureStart * 1000).toISOString(),
                  end:   new Date(futureEnd   * 1000).toISOString() },
            ],
        };

        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData?.has('801')).toBe(true));

        const entry = window.masterAlertsData.get('801')[0];
        expect(entry.activePeriod.start).toBe(futureStart);
        expect(entry.activePeriod.end).toBe(futureEnd);
    });

    it('P3: drops an alert whose only period has a NaN end (malformed)', async () => {
        // When all periods have unparseable ends, the alert should be dropped
        // by the downstream NaN guard, not silently accepted.
        const now = NOW();
        const a = {
            id: 'nan-only',
            effect: 'DETOUR',
            headerText: 'Detour',
            descriptionText: '',
            informedEntities: [{ routeId: '801' }],
            activePeriods: [
                { start: new Date((now - 100) * 1000).toISOString(), end: 'not-a-date' },
            ],
        };

        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(window.masterAlertsData.size).toBe(0);
    });
});

describe('text-mining regression tests (P1–P7)', () => {
    beforeEach(() => {
        _clearStationIndexCache();
    });

    // ── P1/P2: lookahead over-match and ReDoS ─────────────────────────────────

    it('P1: 2b alias does NOT fire when "Station" is separated by a semicolon (avoid-X;use-Y pattern)', async () => {
        // Old lookahead searched the whole sentence; new one stops at ";".
        // "Culver City" alias must not fire when prose says "avoid Culver City;
        // use something else Station" — Station belongs to the other phrase.
        installGlobals({
            stops: {
                'CC':  { lat: 34.006, lon: -118.396, name: 'Culver City Station' },
                'SMB': { lat: 34.013, lon: -118.491, name: 'Downtown Santa Monica Station' },
            },
            trips: { 'T-E': { rc: '804', dir: 0, stops: ['CC', 'SMB'], scheduledTimes: [0, 60] } },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'avoid-use',
            effect: 'DETOUR',
            routes: ['804'],
            stops: [],
            descriptionText: 'Please avoid Culver City; use Downtown Santa Monica Station as your boarding point.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        await new Promise(resolve => setTimeout(resolve, 50));

        // Culver City alias should NOT fire — "Station" is on the other side of ";".
        expect(getActiveStopAlerts('CC')).toHaveLength(0);
    });

    it('P2: full pipeline with adversarial and-heavy description stays under 500ms', async () => {
        // The real ReDoS check: drive the 2b alias regex via the full ingest path.
        installGlobals({
            stops: { 'CC': { lat: 34.006, lon: -118.396, name: 'Culver City Station' } },
            trips: { 'T-E': { rc: '804', dir: 0, stops: ['CC'], scheduledTimes: [0] } },
        });
        initPredictions();
        _clearStationIndexCache();

        const reps = 4000;
        const adversarial = 'Culver City ' + 'and a '.repeat(reps) + 'disruption';

        const a = makeRawAlert({
            id: 'redos-test',
            effect: 'MODIFIED_SERVICE',
            routes: ['804'],
            stops: [],
            headerText: 'Modified service',
            descriptionText: adversarial,
            start: NOW() - 100, end: NOW() + 3600,
        });

        const t0 = performance.now();
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined(), { timeout: 5000 });
        await new Promise(resolve => setTimeout(resolve, 30));
        const elapsed = performance.now() - t0;

        // 500ms is a very generous budget; O(n) should finish in < 10ms.
        expect(elapsed).toBeLessThan(500);
    });

    // ── P4: accessibility filter prefix FP ────────────────────────────────────

    it('P4: accessibility filter does NOT match a different station that shares a key prefix', async () => {
        // "LAKE STATION" header → key "lake". Old startsWith matched
        // "Lakewood Blvd Station" (key "lakewoodblvd") because "lakewoodblvd".startsWith("lake").
        // New code validates that the suffix after the header key is a known entrance qualifier.
        installGlobals({
            stops: {
                'LAKE':     { lat: 34.252, lon: -118.127, name: 'Lake Station' },
                'LAKEWOOD': { lat: 33.852, lon: -118.135, name: 'Lakewood Blvd Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['LAKE', 'LAKEWOOD'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = {
            id: 'lake-accessibility',
            effect: 'ACCESSIBILITY_ISSUE',
            headerText: 'LAKE STATION',
            descriptionText: 'Elevator out of service. Use Lakewood Blvd Station as an alternative.',
            informedEntities: [
                { stopId: 'LAKE' },
                { stopId: 'LAKEWOOD' },   // alternative — must be filtered out
            ],
            activePeriods: [{ start: new Date((NOW() - 100) * 1000).toISOString(),
                              end:   new Date((NOW() + 3600) * 1000).toISOString() }],
        };
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData?.has('LAKE')).toBe(true));

        expect(getActiveStopAccessibilityAlerts('LAKE')).toHaveLength(1);
        // Lakewood is the suggested alternative — must NOT get the accessibility badge.
        expect(getActiveStopAccessibilityAlerts('LAKEWOOD')).toHaveLength(0);
    });

    it('P4: accessibility filter STILL matches a genuine entrance-variant stop', async () => {
        // "Lake Station - Elevator" is the same physical station as "Lake Station".
        // Key for "Lake Station - Elevator" after stationNameKey = "lakeelevator".
        // Suffix "elevator" matches _ENTRANCE_SUFFIX_RE → should be included.
        installGlobals({
            stops: {
                'LAKE':     { lat: 34.252, lon: -118.127, name: 'Lake Station' },
                'LAKE-ELV': { lat: 34.252, lon: -118.127, name: 'Lake Station - Elevator' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['LAKE', 'LAKE-ELV'], scheduledTimes: [0, 0] },
            },
        });
        initPredictions();

        const a = {
            id: 'lake-entrance',
            effect: 'ACCESSIBILITY_ISSUE',
            headerText: 'LAKE STATION',
            descriptionText: 'Elevator out of service.',
            informedEntities: [{ stopId: 'LAKE' }, { stopId: 'LAKE-ELV' }],
            activePeriods: [{ start: new Date((NOW() - 100) * 1000).toISOString(),
                              end:   new Date((NOW() + 3600) * 1000).toISOString() }],
        };
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAccessibilityAlertsData?.has('LAKE')).toBe(true));

        // Both the base stop and the entrance variant belong to the same station.
        expect(getActiveStopAccessibilityAlerts('LAKE')).toHaveLength(1);
        expect(getActiveStopAccessibilityAlerts('LAKE-ELV')).toHaveLength(1);
    });

    // ── P5: interlined-station alias suppression ──────────────────────────────

    it('P5: two stopIds sharing a name (interlined platforms) count as ONE for alias gates', async () => {
        // Regression for P5: Expo/Crenshaw Station is served by both the E and K
        // Lines with two different stopIds but IDENTICAL names. The old coreCounts
        // increment per-stopId, so both IDs bumped the count to 2, suppressing the
        // directional alias for a stop like "Expo / Crenshaw North Station" whose
        // core "Expo / Crenshaw" would now falsely have count=2.
        // This test uses a simpler model: one stop with two IDs, same name, plus a
        // directional-suffix variant that should emit a 2a alias.
        installGlobals({
            stops: {
                'POMN-1': { lat: 34.073, lon: -117.752, name: 'Pomona North Station' },
                'POMN-2': { lat: 34.073, lon: -117.753, name: 'Pomona North Station' }, // same name, different id
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['POMN-1', 'POMN-2'], scheduledTimes: [0, 0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'pomona-interlined',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            descriptionText: 'Service disruption at Pomona Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.size).toBeGreaterThan(0));

        // Both IDs should be tagged (the 2a directional alias fired).
        expect(getActiveStopAlerts('POMN-1')).toHaveLength(1);
        expect(getActiveStopAlerts('POMN-2')).toHaveLength(1);
    });

    it('P5: 2b no-Station alias fires for a stop with two interlined IDs but one name', async () => {
        installGlobals({
            stops: {
                'CC-1': { lat: 34.006, lon: -118.396, name: 'Culver City Station' },
                'CC-2': { lat: 34.006, lon: -118.396, name: 'Culver City Station' }, // same name, diff id
            },
            trips: {
                'T-E': { rc: '804', dir: 0, stops: ['CC-1', 'CC-2'], scheduledTimes: [0, 0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'culver-interlined',
            effect: 'MODIFIED_SERVICE',
            routes: ['804'],
            stops: [],
            descriptionText: 'Trains share 1 track at Culver City Stations.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.size).toBeGreaterThan(0));

        // 2b alias must fire for both interlined IDs.
        expect(getActiveStopAlerts('CC-1')).toHaveLength(1);
        expect(getActiveStopAlerts('CC-2')).toHaveLength(1);
    });

    // ── P6: directional suffix corrupts cross-street names ────────────────────

    it('P6: a cross-street stop ending in a cardinal direction is NOT truncated by the directional alias', async () => {
        // "Florence / West" ends in "West" — old _DIRECTIONAL_SUFFIX_RE with |$
        // stripped it to "Florence" as the core, producing a wrong alias regex.
        // New code: _DIRECTIONAL_SUFFIX_RE no longer uses |$ (only before Station),
        // and the directional strip is guarded against names containing " / ".
        installGlobals({
            stops: {
                'FLW': { lat: 33.97, lon: -118.40, name: 'Florence / West Station' },
            },
            trips: {
                'T-J': { rc: '910', dir: 0, stops: ['FLW'], scheduledTimes: [0] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'florence-west',
            effect: 'DETOUR',
            routes: ['910'],
            stops: [],
            descriptionText: 'Buses rerouted. Florence / West Station closed.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('FLW')).toBe(true));

        // Primary full-name regex must match; stop must be tagged.
        expect(getActiveStopAlerts('FLW')).toHaveLength(1);
    });

    it('P6: "Florence / West" prose does NOT trigger a bare \\bFlorence\\b alias on an unrelated stop', async () => {
        // If the directional strip fired on "Florence / West" → core "Florence",
        // it might emit a bare \bFlorence\b alias that matches unrelated stops.
        // After the fix, the core should equal the full name, not "Florence".
        installGlobals({
            stops: {
                'FLW':  { lat: 33.97, lon: -118.40, name: 'Florence / West Station' },
                'UNRL': { lat: 33.96, lon: -118.38, name: 'Florence / Figueroa Station' },
            },
            trips: {
                'T-J': { rc: '910', dir: 0, stops: ['FLW', 'UNRL'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'florence-only',
            effect: 'DETOUR',
            routes: ['910'],
            stops: [],
            // Only mentions Florence/West; does NOT mention Florence/Figueroa.
            descriptionText: 'Florence / West Station is temporarily closed due to construction.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('FLW')).toBe(true));

        expect(getActiveStopAlerts('FLW')).toHaveLength(1);    // named — must match
        expect(getActiveStopAlerts('UNRL')).toHaveLength(0);   // shares "Florence" — must NOT
    });

    // ── P7: 2a directional alias tail-guard ──────────────────────────────────

    it('P7: 2a directional alias is suppressed when the core phrase appears in 2+ other stop names', async () => {
        // "Pomona North Station" strips "North" → core "Pomona Station".
        // coreCounts.get("Pomona Station") === 1 (unique core — only POMN maps to it).
        // But _bareTokenAmbiguous("Pomona Station") checks \bPomona Station\b in all
        // distinct names: "East Pomona Station" AND "West Pomona Station" both match
        // (count ≥ 2 → true). Old code: alias emitted anyway. New code: alias suppressed.
        installGlobals({
            stops: {
                'POMN': { lat: 34.073, lon: -117.752, name: 'Pomona North Station' },
                'EPOM': { lat: 34.060, lon: -117.730, name: 'East Pomona Station' },
                'WPOM': { lat: 34.080, lon: -117.760, name: 'West Pomona Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['POMN', 'EPOM', 'WPOM'], scheduledTimes: [0, 60, 120] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'pomona-ambiguous-core',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            descriptionText: 'Trains may skip Pomona Station due to equipment issues.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        await new Promise(resolve => setTimeout(resolve, 50));

        // Alias must be suppressed — "Pomona Station" appears in 2+ stop names.
        // No stop should be tagged since the alias is ambiguous.
        expect(getActiveStopAlerts('POMN')).toHaveLength(0);
        // Route-level entry is preserved.
        expect(getActiveAlerts('801')).toHaveLength(1);
    });

    // ── 2c-ii abbreviation alias emit path ───────────────────────────────────

    it('2c-ii: emits a first-word-per-segment abbreviation alias for a unique slash-named station', async () => {
        // "Lincoln Heights / Cypress Park Station" → alert prose uses "Lincoln/Cypress".
        // This is the 2c-ii path: first word of each slash-segment joined by "/".
        installGlobals({
            stops: {
                'LC': { lat: 34.08, lon: -118.22, name: 'Lincoln Heights / Cypress Park Station' },
                'SW': { lat: 34.09, lon: -118.21, name: 'Southwest Museum Station' },
            },
            trips: {
                'T-A': { rc: '801', dir: 0, stops: ['LC', 'SW'], scheduledTimes: [0, 60] },
            },
        });
        initPredictions();

        const a = makeRawAlert({
            id: 'lc-abbrev',
            effect: 'MODIFIED_SERVICE',
            routes: ['801'],
            stops: [],
            descriptionText: 'Service modifications at Lincoln/Cypress Stations.',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('LC')).toBe(true));

        expect(getActiveStopAlerts('LC')).toHaveLength(1);
        expect(getActiveStopAlerts('SW')).toHaveLength(0);   // not mentioned
    });

    // ── _clearStationIndexCache rebuild ──────────────────────────────────────

    it('_clearStationIndexCache forces index rebuild on next match call', async () => {
        installGlobals({
            stops: { 'ALLEN': { lat: 34.04, lon: -118.26, name: 'Allen Station' } },
            trips: { 'T-A': { rc: '801', dir: 0, stops: ['ALLEN'], scheduledTimes: [0] } },
        });
        initPredictions();

        const alertBase = makeRawAlert({
            id: 'cache-rebuild', effect: 'SIGNIFICANT_DELAYS', routes: ['801'], stops: [],
            descriptionText: 'Delays at Allen Station.',
            start: NOW() - 100, end: NOW() + 3600,
        });

        // First fetch — index is built.
        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([alertBase]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('ALLEN')).toBe(true));
        expect(getActiveStopAlerts('ALLEN')).toHaveLength(1);

        // Clear the cache — simulates midnight GTFS reload.
        _clearStationIndexCache();

        // Re-seed with a different stops dataset (e.g. stop renamed/moved).
        installGlobals({
            stops: { 'ALLEN2': { lat: 34.04, lon: -118.26, name: 'Allen Station' } },
            trips: { 'T-A2': { rc: '801', dir: 0, stops: ['ALLEN2'], scheduledTimes: [0] } },
        });
        initPredictions();

        // Re-init after test reset.
        delete window.masterAlertsData;
        delete window.masterStopAlertsData;
        delete window.masterStopAccessibilityAlertsData;

        global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([{ ...alertBase, id: 'cache-rebuild-2' }]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterStopAlertsData?.has('ALLEN2')).toBe(true));

        // After cache clear + rebuild, new stop ID is matched (not the old one).
        expect(getActiveStopAlerts('ALLEN2')).toHaveLength(1);
        expect(getActiveStopAlerts('ALLEN')).toHaveLength(0);
    });
});
