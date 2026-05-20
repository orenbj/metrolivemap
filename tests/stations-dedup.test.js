/**
 * Tests for the dedupeAlertsByEffect helper in stations.js.
 *
 * Regression for the badge-side alert dedup bug: two alerts with the same
 * effect code but different descriptions used to drop the earlier one
 * silently via `new Map(alerts.map(a => [a.effect, a]))`. The helper now
 * preserves every distinct description so the badge tooltip + popup both
 * render the full content.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock MapLibre and predictions so stations.js can be imported without a
// live map. We don't need them for the pure helper test.
vi.mock('../js/predictions.js', () => ({
    getActiveAlerts: () => [],
    getActiveStopAccessibilityAlerts: () => [],
    resolveTripDestination: () => null,
    getRouteCache: () => null,
}));

import { dedupeAlertsByEffect } from '../js/stations.js';

describe('dedupeAlertsByEffect', () => {
    it('returns [] for empty input', () => {
        expect(dedupeAlertsByEffect([])).toEqual([]);
    });

    it('passes a single alert through with _count=1 and one _descriptions entry', () => {
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Northbound trains rerouted via Long Beach.' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].effect).toBe('DETOUR');
        expect(out[0]._count).toBe(1);
        expect(out[0]._descriptions).toEqual(['Northbound trains rerouted via Long Beach.']);
    });

    it('merges two alerts with the same effect AND identical description into one entry', () => {
        // Same effect, same description → one entry, _count=2, one description.
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR', description: 'Trains rerouted.' },
            { id: 'a-2', effect: 'DETOUR', description: 'Trains rerouted.' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._count).toBe(2);
        expect(out[0]._descriptions).toEqual(['Trains rerouted.']);
    });

    it('preserves BOTH descriptions when same effect carries distinct text', () => {
        // The bug: pre-fix, the badge path used `new Map([effect, alert])`
        // and only the last alert survived. Now both descriptions are
        // preserved in _descriptions[].
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'SIGNIFICANT_DELAYS', description: 'A Line: 15-min delays northbound.' },
            { id: 'a-2', effect: 'SIGNIFICANT_DELAYS', description: 'A Line: 10-min delays southbound.' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._count).toBe(2);
        expect(out[0]._descriptions).toHaveLength(2);
        expect(out[0]._descriptions).toContain('A Line: 15-min delays northbound.');
        expect(out[0]._descriptions).toContain('A Line: 10-min delays southbound.');
    });

    it('keeps distinct effects as separate entries', () => {
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'DETOUR',             description: 'Detour A.' },
            { id: 'a-2', effect: 'SIGNIFICANT_DELAYS', description: 'Delays B.' },
            { id: 'a-3', effect: 'DETOUR',             description: 'Detour C.' },
        ]);
        expect(out).toHaveLength(2);
        const detour = out.find(a => a.effect === 'DETOUR');
        const delays = out.find(a => a.effect === 'SIGNIFICANT_DELAYS');
        expect(detour._count).toBe(2);
        expect(detour._descriptions).toEqual(['Detour A.', 'Detour C.']);
        expect(delays._count).toBe(1);
        expect(delays._descriptions).toEqual(['Delays B.']);
    });

    it('handles missing / empty description gracefully (no empty strings in array)', () => {
        // Alerts without descriptions should not contribute an empty string —
        // _descriptions starts empty and stays empty.
        const out = dedupeAlertsByEffect([
            { id: 'a-1', effect: 'NO_SERVICE', description: '' },
            { id: 'a-2', effect: 'NO_SERVICE' },  // no description field
            { id: 'a-3', effect: 'NO_SERVICE', description: '   ' },  // whitespace-only
        ]);
        expect(out).toHaveLength(1);
        expect(out[0]._count).toBe(3);
        expect(out[0]._descriptions).toEqual([]);
    });

    it('preserves alert metadata from the first alert seen per effect', () => {
        // Future-proofing: if downstream code reads a.id or a.header from the
        // deduped output, it should get the first alert's metadata, not the
        // last. The first one wins because it's spread first into the Map.
        const out = dedupeAlertsByEffect([
            { id: 'first',  effect: 'DETOUR', header: 'First',  description: 'Desc A.' },
            { id: 'second', effect: 'DETOUR', header: 'Second', description: 'Desc B.' },
        ]);
        expect(out[0].id).toBe('first');
        expect(out[0].header).toBe('First');
        expect(out[0]._descriptions).toEqual(['Desc A.', 'Desc B.']);
    });
});
