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

import { _computeMerges } from '../js/bikeshare.js';
import { getNearbyBikeStation } from '../js/bikeshare.js';

beforeEach(() => {
    window.masterBikeStations = new Map();
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
