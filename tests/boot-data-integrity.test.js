/**
 * Boot-time data has to be checked for PLAUSIBILITY, not just for parsing
 * (R9-01), and a transient shape-load failure must not be permanent (R1-03).
 *
 * Both are silent failures of the worst kind: the app looks like it booted
 * fine. The splash clears on the second WebSocket connect, which has nothing to
 * do with whether the static data arrived, so a rider sees a normal-looking map
 * that is quietly missing its entire fleet or quietly moving every train in
 * straight lines across city blocks.
 *
 *   R9-01  `_loadJson` only rejects on a network error or a non-2xx. A bad
 *          deploy, a truncated-but-valid body, or a CDN edge serving `{}` with
 *          HTTP 200 all resolve "successfully". `masterStopsData` is then
 *          permanently `{}`, and markers.js's `preBootstrap` guard drops EVERY
 *          vehicle frame for the life of the page. Reproduced end-to-end by the
 *          review: splash cleared normally, no banner, 440 frames received, 0
 *          rendered.
 *   R1-03  `loadShapes()` memoises its promise so callers share one fetch — but
 *          it also memoises the FAILED one. One stalled fetch on a flaky phone
 *          connection disables snapping, arc-glide, the cross-line guard and the
 *          cold-start off-route gate for the entire session, behind a toast that
 *          only mentions headings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
}));

import { MIN_STOPS_EXPECTED, MIN_TRIPS_EXPECTED } from '../js/config.js';
import { isPlausibleDataset } from '../js/utils.js';

describe('a parsed-but-implausible dataset is treated as a failure (R9-01)', () => {
    it('rejects the empty object a bad deploy or a CDN placeholder produces', () => {
        // The exact shape the review reproduced: valid JSON, HTTP 200, and every
        // vehicle frame silently dropped for the rest of the session.
        expect(isPlausibleDataset({}, MIN_STOPS_EXPECTED)).toBe(false);
    });

    it('rejects a truncated file that still parses', () => {
        const fewStops = Object.fromEntries(
            Array.from({ length: 50 }, (_, i) => [String(i), { lat: 34, lon: -118, name: `S${i}` }]),
        );
        expect(isPlausibleDataset(fewStops, MIN_STOPS_EXPECTED)).toBe(false);
    });

    it('accepts the real committed dataset', async () => {
        // The floor has to sit well below reality or it turns into a false alarm
        // on a legitimate service reduction.
        const stops = JSON.parse(readFileSync('data/stops.json', 'utf8'));
        const trips = JSON.parse(readFileSync('data/trips.json', 'utf8'));
        expect(isPlausibleDataset(stops, MIN_STOPS_EXPECTED)).toBe(true);
        expect(isPlausibleDataset(trips, MIN_TRIPS_EXPECTED)).toBe(true);
        // Sanity on the floors themselves: comfortably below the real counts, so
        // an ordinary schedule change can never trip them.
        expect(Object.keys(stops).length).toBeGreaterThan(MIN_STOPS_EXPECTED * 2);
        expect(Object.keys(trips).length).toBeGreaterThan(MIN_TRIPS_EXPECTED * 2);
    });

    it('rejects a non-object without throwing', () => {
        for (const bad of [null, undefined, [], '', 0, 'not json']) {
            expect(isPlausibleDataset(bad, MIN_STOPS_EXPECTED)).toBe(false);
        }
    });
});

describe('loadShapes retries after a transient failure (R1-03)', () => {
    let snap;

    beforeEach(async () => {
        vi.resetModules();
        snap = await import('../js/snap.js');
        snap._resetShapesForTest?.();
    });

    afterEach(() => { delete globalThis.fetch; });

    it('does not cache a failure forever', async () => {
        // One stalled fetch on a flaky connection used to disable snapping,
        // arc-glide, the cross-line guard and the cold-start off-route gate for
        // the whole session — every rail marker moving in straight lines across
        // city blocks until the rider reloaded.
        let calls = 0;
        globalThis.fetch = vi.fn(() => {
            calls++;
            if (calls === 1) return Promise.reject(new Error('network'));
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ 801: [[34.0, -118.0], [34.1, -118.1]] }),
            });
        });

        await snap.loadShapes();
        expect(snap.hasShapeData('801'), 'first attempt failed, as set up').toBe(false);

        await snap.loadShapes();
        expect(calls, 'a second call must actually re-fetch').toBe(2);
        expect(snap.hasShapeData('801'), 'the retry must take effect').toBe(true);
    });

    it('still shares ONE in-flight fetch between concurrent callers', () => {
        // The memo exists for a reason: main.js and the rollover path both call
        // this. Clearing it on failure must not turn every caller into its own
        // request.
        let calls = 0;
        globalThis.fetch = vi.fn(() => {
            calls++;
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ 801: [[34, -118], [34.1, -118.1]] }) });
        });
        const a = snap.loadShapes();
        const b = snap.loadShapes();
        expect(a).toBe(b);
        return Promise.all([a, b]).then(() => expect(calls).toBe(1));
    });

    it('does not re-fetch after a SUCCESSFUL load', () => {
        let calls = 0;
        globalThis.fetch = vi.fn(() => {
            calls++;
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ 801: [[34, -118], [34.1, -118.1]] }) });
        });
        return snap.loadShapes()
            .then(() => snap.loadShapes())
            .then(() => expect(calls, 'success is still memoised').toBe(1));
    });
});

describe('the boot path actually applies the floors (wiring)', () => {
    // A correct predicate says nothing about whether it is CALLED — the gap
    // that let three "pinned" guards in this repo go unpinned.
    const src = readFileSync('js/main.js', 'utf8');

    it('stops.json is loaded with a minimum-entry floor', () => {
        expect(src).toMatch(/_loadJson\('\.\/data\/stops\.json',\s*'stops',\s*\{\},\s*MIN_STOPS_EXPECTED\)/);
    });

    it('every trips.json path checks the floor, including the Worker success branch', () => {
        // The Worker reports FETCH failure only, so an implausible payload
        // arrives as ok:1 — the branch a floor on the fallback paths alone
        // would miss entirely.
        expect(src).toMatch(/e\.data\.ok && isPlausibleDataset\(e\.data\.d, MIN_TRIPS_EXPECTED\)/);
        const fallbacks = [...src.matchAll(/_loadJson\('\.\/data\/trips\.json'[^)]*\)/g)].map(m => m[0]);
        expect(fallbacks.length, 'both main-thread fallbacks exist').toBe(2);
        for (const f of fallbacks) expect(f).toMatch(/MIN_TRIPS_EXPECTED/);
    });

    it('the failure banner distinguishes a total outage from a partial one', () => {
        // "Predictions and station data may be limited" is true of bus-routes;
        // for a failed stops load it describes a blank map as a minor issue.
        expect(src).toMatch(/failures\.includes\('stops'\) \|\| failures\.includes\('trips'\)/);
        expect(src).toMatch(/Vehicles and arrival times are unavailable/);
    });
});
