/**
 * Tests for js/bikeshare.js — focused on the merge-precompute helper
 * `_computeMerges` and its resilience to stale or empty station data.
 *
 * The merge math itself (union-find over GBFS station positions) is exercised
 * via `getNearbyBikeStation` in other manual smoke tests; this file pins the
 * "stale member id" defensive guard added in commit A2.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DOM-dependent imports so importing bikeshare.js doesn't try to
// access a live MapLibre map. We only exercise the pure compute path.
vi.mock('../js/map.js', () => ({ getMap: () => null }));
vi.mock('../js/stations.js', () => ({}));
vi.mock('../js/popups.js', () => ({ setActivePopup: vi.fn(), notifyPopupClosed: vi.fn() }));
// Keep the real pure helpers (escHtml, planarMeters) but replace the two
// side-effecting ones so initBikeShare's self-heal path is testable: fetchWithTimeout
// is fully controlled per-test, and setVisibleInterval is captured rather than
// scheduled so the poll tick can be invoked directly instead of waiting on a timer.
const _fetchImpl = vi.fn();
const _pollCallbacks = {};
vi.mock('../js/utils.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        fetchWithTimeout: (...args) => _fetchImpl(...args),
        setVisibleInterval: vi.fn((fn, _ms, key) => { _pollCallbacks[key] = fn; return `mock-${key}`; }),
    };
});

import { _computeMerges, initBikeShare } from '../js/bikeshare.js';
import { getNearbyBikeStation } from '../js/bikeshare.js';

function makeStubMap() {
    return {
        on: vi.fn(),
        getZoom: vi.fn(() => 12),   // >= BIKE_MINZOOM (10) so the layer's show-band is open
        getBounds: vi.fn(() => ({
            getWest: () => -119, getEast: () => -117, getSouth: () => 33, getNorth: () => 35,
        })),
    };
}

function jsonResponse(body) {
    return { ok: true, json: () => Promise.resolve(body) };
}

// The layer is OFF by default (bikeshareVisible unset), and the poll's self-heal
// branch is gated on `if (!_visible) return;` — same as every other poll step, so
// it never runs while toggled off. initBikeShare wires a click handler on
// #bikeshare-legend-row that flips visibility, but ONLY IF the row already exists
// in the DOM at init time — so the row must be built BEFORE calling initBikeShare.
function setUpToggleRow() {
    document.body.innerHTML = '<div id="bikeshare-legend-row"></div><button id="bikeshare-toggle-btn"></button>';
}
function turnBikeshareOn() {
    // Idempotent: _visible is module state that persists across tests (no
    // exported reset), so only click if the row's own class shows it's
    // currently off — a blind click would TOGGLE it back off if a prior test
    // already turned it on.
    const row = document.getElementById('bikeshare-legend-row');
    if (row.classList.contains('disabled')) row.click();
}

beforeEach(() => {
    window.masterBikeStations = new Map();
    _fetchImpl.mockReset();
    for (const k of Object.keys(_pollCallbacks)) delete _pollCallbacks[k];
    global.maplibregl = { Marker: vi.fn(() => ({
        setLngLat: vi.fn().mockReturnThis(),
        addTo:     vi.fn().mockReturnThis(),
        remove:    vi.fn(),
    })) };
});

describe('_computeMerges — stale-member-id resilience', () => {
    it('does not throw when no stations are registered', () => {
        expect(() => _computeMerges()).not.toThrow();
    });

    it('merges two close stations into a single group', () => {
        // Two stations ~20 m apart (within MERGE_RADIUS_M = 50 m).
        window.masterBikeStations.set('A', { lat: 34.04000, lon: -118.26000, name: 'Station A' });
        window.masterBikeStations.set('B', { lat: 34.04015, lon: -118.26000, name: 'Station B' });
        _computeMerges();
        // A and B should resolve to the same merged group via getNearbyBikeStation.
        const a = getNearbyBikeStation(34.04000, -118.26000, 5);
        const b = getNearbyBikeStation(34.04015, -118.26000, 5);
        expect(a?.memberIds).toEqual(expect.arrayContaining(['A', 'B']));
        expect(b?.memberIds).toEqual(expect.arrayContaining(['A', 'B']));
        // Merged lat is the average; must be a finite number, not NaN.
        expect(Number.isFinite(a.lat)).toBe(true);
        expect(Number.isFinite(a.lon)).toBe(true);
    });

    it('does NOT throw or render NaN when a member is removed before re-merge', () => {
        // Initial: 3 stations cluster together.
        window.masterBikeStations.set('A', { lat: 34.04000, lon: -118.26000, name: 'Station A' });
        window.masterBikeStations.set('B', { lat: 34.04015, lon: -118.26000, name: 'Station B' });
        window.masterBikeStations.set('C', { lat: 34.04020, lon: -118.26002, name: 'Station C' });
        _computeMerges();

        // Mid-session GBFS refresh removes station C entirely.
        window.masterBikeStations.delete('C');

        // The pre-fix path would have thrown TypeError on undefined.lat if any
        // future call path passed pre-computed memberIds; the post-fix path
        // filters stale ids out of the live aggregate first.
        expect(() => _computeMerges()).not.toThrow();

        // A and B remain a valid merge; aggregate coords are still finite.
        const a = getNearbyBikeStation(34.04000, -118.26000, 5);
        expect(a?.memberIds).toEqual(expect.arrayContaining(['A', 'B']));
        expect(a?.memberIds).not.toContain('C');
        expect(Number.isFinite(a.lat)).toBe(true);
        expect(Number.isFinite(a.lon)).toBe(true);
    });

    it('drops the merge entirely when stale ids reduce members below 2', () => {
        // Two close stations become a 1-station singleton when one is removed.
        window.masterBikeStations.set('A', { lat: 34.04000, lon: -118.26000, name: 'A' });
        window.masterBikeStations.set('B', { lat: 34.04015, lon: -118.26000, name: 'B' });
        _computeMerges();
        // Confirm merge exists.
        expect(getNearbyBikeStation(34.04000, -118.26000, 5)?.memberIds?.length).toBe(2);

        // Remove B; re-merge.
        window.masterBikeStations.delete('B');
        _computeMerges();

        // No merge group exists now — getNearbyBikeStation falls back to the
        // singleton lookup against masterBikeStations, returning A directly
        // (no memberIds field on a raw station record).
        const after = getNearbyBikeStation(34.04000, -118.26000, 5);
        expect(after).toBeDefined();
        expect(after.memberIds).toBeUndefined();   // not a merge anymore
    });
});

// Regression coverage for the whole-app-audit LOW: a failed startup GBFS
// info fetch used to `return` before the poll interval was registered, so the
// layer stayed empty for the whole session with no retry. initBikeShare now
// registers the poll regardless of startup success, and the poll self-heals.
describe('initBikeShare — startup failure does not disable the layer permanently', () => {
    it('a failed startup station-info fetch does not throw, and still registers the poll', async () => {
        _fetchImpl.mockRejectedValue(new Error('network down'));
        await expect(initBikeShare(makeStubMap())).resolves.not.toThrow();
        expect(window.masterBikeStations.size).toBe(0);
        // The self-heal contract: the poll must exist so a later tick can retry.
        expect(_pollCallbacks['bikeshare:poll']).toBeInstanceOf(Function);
    });

    it('the poll retries a failed startup load and recovers on the next tick', async () => {
        setUpToggleRow();
        _fetchImpl.mockRejectedValueOnce(new Error('network down'));  // startup load fails
        await initBikeShare(makeStubMap());
        expect(window.masterBikeStations.size).toBe(0);
        turnBikeshareOn();   // the retry branch is gated on _visible, like every poll step

        // GBFS recovers: the info endpoint now succeeds. The poll tick also hits
        // _refreshStatus (the status endpoint) — resolve every subsequent call.
        _fetchImpl.mockResolvedValue(jsonResponse({ data: { stations: [] } }));
        _fetchImpl.mockResolvedValueOnce(jsonResponse({
            data: { stations: [{ station_id: 'A', name: 'Station A', lat: 34.04, lon: -118.26 }] },
        }));

        await _pollCallbacks['bikeshare:poll']();

        expect(window.masterBikeStations.size).toBe(1);
        expect(window.masterBikeStations.get('A')?.name).toBe('Station A');
        // _buildAllMarkers ran as part of the recovery (the startup path skipped
        // it entirely since the station set was empty at that point).
        expect(global.maplibregl.Marker).toHaveBeenCalled();
    });

    it('the poll is a safe no-op retry while GBFS is still down (no throw, stays empty)', async () => {
        setUpToggleRow();
        _fetchImpl.mockRejectedValue(new Error('still down'));
        await initBikeShare(makeStubMap());
        expect(window.masterBikeStations.size).toBe(0);
        turnBikeshareOn();

        await expect(_pollCallbacks['bikeshare:poll']()).resolves.not.toThrow();
        expect(window.masterBikeStations.size).toBe(0);
        expect(global.maplibregl.Marker).not.toHaveBeenCalled();
    });
});
