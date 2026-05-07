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

import { getActiveAlerts, getActiveStopAlerts, initAlerts } from '../js/alerts.js';

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

    it('drops alerts with effect=ACCESSIBILITY_ISSUE', async () => {
        const a = makeRawAlert({ id: 'a11y', effect: 'ACCESSIBILITY_ISSUE',
                                  start: NOW() - 100, end: NOW() + 3600 });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
    });

    it('drops alerts whose description mentions elevator/escalator', async () => {
        const a = makeRawAlert({
            id: 'elev', effect: 'OTHER_EFFECT',
            descriptionText: 'Elevator out of service at Pico',
            start: NOW() - 100, end: NOW() + 3600,
        });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
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

    it('drops alerts whose informedEntities target no relevant route', async () => {
        const a = makeRawAlert({ id: 'irrelevant', routes: ['9999'],
                                  start: NOW() - 100, end: NOW() + 3600 });
        global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve([a]) }));
        initAlerts();
        await vi.waitFor(() => expect(window.masterAlertsData).toBeDefined());
        expect(window.masterAlertsData.size).toBe(0);
    });
});
