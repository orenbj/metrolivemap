/**
 * Tests for the per-stop badge-set composition in alerts.js _ingest —
 * specifically rule (3): prose-named stations the feed's stop set omits
 * still get a map-dot badge.
 *
 * Regression anchor: the G Line Sepulveda detour (2026-06). Metro's alert
 * said "stop Sepulveda Station will not be served" and tagged the SERVED
 * stops in informedEntities — so Sepulveda, the alert's actual subject, was
 * the one stop missing from the feed set. The old badge logic used only
 * `stopIdSet ∩ textStops` (or the raw feed set), which dropped it: the
 * route-level popup showed the alert, but the station dot carried no "!"
 * badge. Rule (3) unions text-mined stations into the badge set.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { getActiveStopAlerts, getActiveAlerts, initAlerts, _clearStationIndexCache } from '../js/alerts.js';
import { initPredictions } from '../js/predictions.js';
import { installGlobals } from './_helpers/globals.js';

const NOW = () => Math.floor(Date.now() / 1000);

function makeRawAlert({ id, effect = 'DETOUR', routes = [], stops = [], headerText = '', descriptionText = '', start, end }) {
    return {
        id, effect, headerText, descriptionText,
        informedEntities: [...routes.map(r => ({ routeId: r })), ...stops.map(s => ({ stopId: s }))],
        activePeriods: [{ start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() }],
    };
}

async function ingest(alerts) {
    global.fetch = vi.fn(() => Promise.resolve({ json: () => Promise.resolve(alerts) }));
    initAlerts();
    await vi.waitFor(() => {
        expect(window.masterAlertsData?.size).toBeGreaterThan(0);
    });
}

describe('badge-set composition — prose-named stations vs feed stop set', () => {
    beforeEach(() => {
        // Re-arm initAlerts (it early-returns while masterAlertsData exists)
        // so each test ingests its own alert set — same reset pattern as
        // tests/alerts.test.js.
        delete window.masterAlertsData;
        delete window.masterStopAlertsData;
        delete window.masterStopAccessibilityAlertsData;
        _clearStationIndexCache();
        installGlobals({
            stops: {
                '6139': { lat: 34.17, lon: -118.46, name: 'Sepulveda Station' },
                '6140': { lat: 34.17, lon: -118.46, name: 'Sepulveda Station' },
                '6200': { lat: 34.17, lon: -118.37, name: 'North Hollywood Station' },
                '6300': { lat: 34.25, lon: -118.60, name: 'Chatsworth Station' },
                '6400': { lat: 34.20, lon: -118.52, name: 'Reseda Station' },
                '6500': { lat: 34.19, lon: -118.45, name: 'Van Nuys Station' },
                '6600': { lat: 34.18, lon: -118.43, name: 'Woodman Station' },
            },
            trips: {
                // Both directions, like the real route 901 — each platform of
                // the Sepulveda pair (6139/6140) appears in one direction's
                // stop sequence, so BOTH get indexed for text-mining.
                'G1': { rc: '901', dir: 0, stops: ['6300', '6400', '6500', '6600', '6139', '6200'], scheduledTimes: [0, 60, 120, 180, 240, 300] },
                'G2': { rc: '901', dir: 1, stops: ['6200', '6140', '6600', '6500', '6400', '6300'], scheduledTimes: [0, 60, 120, 180, 240, 300] },
            },
        });
        initPredictions();
    });

    it('REGRESSION (Sepulveda): a skipped-but-prose-named station keeps its badge when the feed tags only the SERVED stops', async () => {
        await ingest([makeRawAlert({
            id: 'gline-detour',
            routes: ['901'],
            stops: ['6300', '6400', '6500', '6600', '6200'],   // served stops; Sepulveda omitted
            headerText: 'G Line (Orange) Detour',
            descriptionText: 'Buses detour via Erwin and Sepulveda due to construction. ' +
                'Toward North Hollywood Station G Line, stop Sepulveda Station will not be served. ' +
                'Toward Chatsworth Station / G Line, stop Sepulveda Station will not be served.',
            start: NOW() - 100, end: NOW() + 3600,
        })]);

        // The alert's subject — the skipped station — must carry the badge,
        // on BOTH platform stopIds.
        expect(getActiveStopAlerts('6139')).toHaveLength(1);
        expect(getActiveStopAlerts('6140')).toHaveLength(1);
        // Route-level popup entry still present.
        expect(getActiveAlerts('901')).toHaveLength(1);
    });

    it('rule (1) narrowing still applies: prose naming a feed subset narrows over-listed badges, and union adds nothing new', async () => {
        await ingest([makeRawAlert({
            id: 'delays-at-reseda',
            effect: 'SIGNIFICANT_DELAYS',
            routes: ['901'],
            stops: ['6300', '6400', '6500'],          // feed over-lists the segment
            headerText: 'Delays',
            descriptionText: 'Delays due to an incident at Reseda Station.',
            start: NOW() - 100, end: NOW() + 3600,
        })]);

        expect(getActiveStopAlerts('6400')).toHaveLength(1);   // named → badge
        expect(getActiveStopAlerts('6300')).toHaveLength(0);   // over-listed → narrowed away
        expect(getActiveStopAlerts('6500')).toHaveLength(0);
    });

    it('rule (2) route-wide suppression unaffected: no prose names + feed covers the route → no per-stop badges', async () => {
        await ingest([makeRawAlert({
            id: 'route-wide',
            effect: 'REDUCED_SERVICE',
            routes: ['901'],
            stops: ['6300', '6400', '6500', '6600', '6139'],   // ≥ 2/3 of the 6-stop route
            headerText: 'Buses every 20 minutes',
            descriptionText: 'Buses are running every 20 minutes due to staffing.',
            start: NOW() - 100, end: NOW() + 3600,
        })]);

        for (const sid of ['6300', '6400', '6500', '6600', '6139']) {
            expect(getActiveStopAlerts(sid)).toHaveLength(0);
        }
        expect(getActiveAlerts('901')).toHaveLength(1);        // legend badge data intact
    });

    it('under-targeting fallback unchanged: route-only feed adopts the text-mined stops', async () => {
        await ingest([makeRawAlert({
            id: 'route-only',
            routes: ['901'],
            stops: [],
            headerText: 'Detour',
            descriptionText: 'Stop Sepulveda Station will not be served.',
            start: NOW() - 100, end: NOW() + 3600,
        })]);

        expect(getActiveStopAlerts('6139')).toHaveLength(1);
        expect(getActiveStopAlerts('6140')).toHaveLength(1);
    });
});
