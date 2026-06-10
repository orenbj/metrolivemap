/**
 * Unit tests for the pure logic exported by scripts/build-shapes.cjs.
 *
 * Why this exists: the J Line 910/950 case (two route_codes sharing
 * shape_ids) silently regressed the data file for an unknown number of
 * builds because the old shapeToRoute was last-write-wins. These tests
 * pin the canonical-selection invariant so a future refactor doesn't
 * re-introduce the same data loss.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickCanonicalByCode, maxPolylineDivergence } = require('../scripts/build-shapes.cjs');

describe('pickCanonicalByCode', () => {
    it('picks the highest-point-count shape per route_code', () => {
        const counts = {
            'sA|901': 100,
            'sB|901': 250,
            'sC|901': 150,
        };
        expect(pickCanonicalByCode(counts)).toEqual({ '901': 'sB' });
    });

    it('handles a shape_id shared by two route_codes (J Line 910/950 case)', () => {
        // 's_short' is the El Monte ↔ Harbor Gateway shape used by both 910 and 950.
        // 's_long_950' is the El Monte ↔ San Pedro shape used only by 950.
        // The old single-value shapeToRoute let one route claim 's_short' while
        // the other was left with no shapes at all. Now both get represented
        // in the count map, and each picks its own longest:
        //   910 → 's_short' (its only option)
        //   950 → 's_long_950' (longer than 's_short')
        const counts = {
            's_short|910':    600,
            's_short|950':    600,
            's_long_950|950': 850,
        };
        expect(pickCanonicalByCode(counts)).toEqual({
            '910': 's_short',
            '950': 's_long_950',
        });
    });

    it('handles three route_codes sharing one shape with different per-route winners', () => {
        const counts = {
            'shared|910': 300,
            'shared|950': 300,
            'shared|901': 300,
            'long910|910': 500,
            'long950|950': 700,
            // 901 has no longer alternative — keeps the shared one.
        };
        expect(pickCanonicalByCode(counts)).toEqual({
            '910': 'long910',
            '950': 'long950',
            '901': 'shared',
        });
    });

    it('returns an empty object for empty input', () => {
        expect(pickCanonicalByCode({})).toEqual({});
    });

    it('skips malformed keys without a separator', () => {
        const counts = { 'no_separator_here': 999, 'sA|901': 100 };
        expect(pickCanonicalByCode(counts)).toEqual({ '901': 'sA' });
    });

    it('preserves the first-seen winner on ties (deterministic)', () => {
        // Object.entries iterates insertion order in modern JS, so 's1' wins.
        const counts = { 's1|901': 100, 's2|901': 100 };
        expect(pickCanonicalByCode(counts)).toEqual({ '901': 's1' });
    });
});

describe('maxPolylineDivergence (per-direction split decision)', () => {
    // ~111 m per 0.001° lat at LA; lng scaled by ~0.837. Use lat offsets so the
    // metre conversion is the simple 110540 factor.
    const M_PER_0001_LAT = 0.001 * 110540; // ≈ 110.5 m

    it('returns ~0 for two identical polylines', () => {
        const a = [[34.00, -118.20], [34.01, -118.20], [34.02, -118.20]];
        expect(maxPolylineDivergence(a, a)).toBeLessThan(0.001);
    });

    it('measures the max perpendicular offset of a parallel line', () => {
        const a = [[34.00, -118.200], [34.02, -118.200]];
        const b = [[34.00, -118.201], [34.02, -118.201]]; // ~0.001° lng ≈ 92.6 m east
        const d = maxPolylineDivergence(a, b);
        expect(d).toBeGreaterThan(85);
        expect(d).toBeLessThan(100);
    });

    it('catches a one-way couplet: a far-diverging arm shows large divergence', () => {
        // A runs straight north; B detours ~3×110 m east mid-route (a parallel street).
        const a = [[34.000, -118.20], [34.005, -118.20], [34.010, -118.20]];
        const b = [[34.000, -118.20], [34.005, -118.197], [34.010, -118.20]];
        expect(maxPolylineDivergence(a, b)).toBeGreaterThan(150);
    });

    it('is one-sided: distance from A vertices to the nearest point on B', () => {
        // A single point exactly on B's line → 0 regardless of B having more points.
        const a = [[34.00, -118.20]];
        const b = [[33.99, -118.20], [34.00, -118.20], [34.01, -118.20]];
        expect(maxPolylineDivergence(a, b)).toBeLessThan(0.001);
    });

    it('projects onto segments, not just vertices (a point beside a long segment)', () => {
        // A point ~110 m north-offset from the midpoint of a long E-W segment in B.
        const b = [[34.00, -118.20], [34.00, -118.10]];
        const a = [[34.00 + 0.001, -118.15]];
        const d = maxPolylineDivergence(a, b);
        expect(d).toBeGreaterThan(M_PER_0001_LAT - 5);
        expect(d).toBeLessThan(M_PER_0001_LAT + 5);
    });
});
