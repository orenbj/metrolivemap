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
const { pickCanonicalByCode, maxPolylineDivergence, cleanPolyline,
        compactBusDestinations } = require('../scripts/build-shapes.cjs');

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

describe('cleanPolyline (digitization-artifact removal)', () => {
    // ~0.0001° lat ≈ 11 m; ~0.001° lat ≈ 110 m.
    it('removes consecutive duplicate vertices', () => {
        const pts = [[34.00, -118.20], [34.00, -118.20], [34.01, -118.20], [34.01, -118.20], [34.02, -118.20]];
        expect(cleanPolyline(pts)).toEqual([[34.00, -118.20], [34.01, -118.20], [34.02, -118.20]]);
    });

    it('removes a short backtrack spike (the D Line Wilshire/Vermont zigzag class)', () => {
        // Straight north path with a ~11 m backwards stutter at the middle:
        // ...34.010 → 34.0101 → 34.010 (reverse, 11 m) → 34.020...
        const pts = [[34.000, -118.20], [34.010, -118.20], [34.0101, -118.20], [34.010, -118.20], [34.020, -118.20]];
        const out = cleanPolyline(pts);
        // The spike vertex AND the duplicate it leaves behind must both go.
        expect(out).toEqual([[34.000, -118.20], [34.010, -118.20], [34.020, -118.20]]);
    });

    it('keeps a genuine 90° street corner', () => {
        const pts = [[34.00, -118.20], [34.001, -118.20], [34.001, -118.199]];
        expect(cleanPolyline(pts)).toEqual(pts);
    });

    it('keeps a long hairpin (real terminal loop / switchback geometry)', () => {
        // A reversal whose hops are ~110 m each — far above the 20 m artifact
        // bound. Real track can do this over distance; artifacts cannot.
        const pts = [[34.000, -118.20], [34.001, -118.20], [34.000, -118.1999]];
        expect(cleanPolyline(pts)).toEqual(pts);
    });

    it('passes a clean polyline through untouched', () => {
        const pts = [[34.00, -118.20], [34.01, -118.20], [34.02, -118.19], [34.03, -118.19]];
        expect(cleanPolyline(pts)).toEqual(pts);
    });
});

describe('compactBusDestinations — the "zero mislabels" compaction (R9-04)', () => {
    /**
     * Build the two maps the CSV passes produce.
     * @param {Array<[tripId, routeCode, direction, destination]>} rows
     */
    function fixture(rows) {
        const tripDest = {}, tripDir = {};
        for (const [tid, rc, dir, dest] of rows) {
            tripDest[tid] = { rc, dest };
            tripDir[tid] = dir;
        }
        return [tripDest, tripDir];
    }

    /** Resolve a trip the way js/predictions.js resolveBusDestination does. */
    function resolve(out, tripId, rc, dir) {
        const idx = out.byTrip[tripId] ?? out.byRouteDir[`${rc}|${dir}`];
        return idx == null ? null : out.dests[idx];
    }

    it('picks the majority destination per route|dir as the dominant one', () => {
        const out = compactBusDestinations(...fixture([
            ['t1', '111', '0', 'LAX City Bus Center'],
            ['t2', '111', '0', 'LAX City Bus Center'],
            ['t3', '111', '0', 'LAX City Bus Center'],
            ['t4', '111', '0', 'Inglewood'],
        ]));
        expect(out.dests[out.byRouteDir['111|0']]).toBe('LAX City Bus Center');
    });

    it('the CLAUDE.md case: a 111 short-turning to Inglewood keeps its OWN destination', () => {
        // This is the exact rider-facing mislabel the feature was built to
        // eliminate — a rider waiting for Inglewood being shown LAX.
        const out = compactBusDestinations(...fixture([
            ['t1', '111', '0', 'LAX City Bus Center'],
            ['t2', '111', '0', 'LAX City Bus Center'],
            ['t3', '111', '0', 'LAX City Bus Center'],
            ['short', '111', '0', 'Inglewood'],
        ]));
        expect(resolve(out, 'short', '111', '0')).toBe('Inglewood');
        expect(resolve(out, 't1', '111', '0')).toBe('LAX City Bus Center');
    });

    it('byTrip carries ONLY the minority trips — the majority stay implicit', () => {
        // This is what keeps the file at ~17 KB. If the branch test inverts,
        // byTrip either explodes to every trip or empties out entirely; both
        // are caught here, and the second is the silent-mislabel direction.
        const out = compactBusDestinations(...fixture([
            ['t1', '111', '0', 'LAX City Bus Center'],
            ['t2', '111', '0', 'LAX City Bus Center'],
            ['t3', '111', '0', 'LAX City Bus Center'],
            ['short', '111', '0', 'Inglewood'],
        ]));
        expect(Object.keys(out.byTrip)).toEqual(['short']);
    });

    it('every trip resolves to its TRUE destination, majority and minority alike', () => {
        // The end-to-end property the compaction exists to guarantee. Asserted
        // over a mixed fixture rather than per-field, so any reshaping of the
        // output that still satisfies the runtime resolver stays green while a
        // genuine mislabel goes red.
        const rows = [
            ['a1', '111', '0', 'LAX City Bus Center'],
            ['a2', '111', '0', 'LAX City Bus Center'],
            ['a3', '111', '0', 'Inglewood'],
            ['b1', '111', '1', 'Norwalk Station'],
            ['b2', '111', '1', 'Norwalk Station'],
            ['c1', '720', '0', 'Santa Monica'],
            ['c2', '720', '0', 'Commerce'],
        ];
        const out = compactBusDestinations(...fixture(rows));
        for (const [tid, rc, dir, dest] of rows) {
            expect(resolve(out, tid, rc, dir), `trip ${tid} on ${rc}|${dir}`).toBe(dest);
        }
    });

    it('keeps route|dir separate — the same route can differ by direction', () => {
        const out = compactBusDestinations(...fixture([
            ['a', '111', '0', 'LAX City Bus Center'],
            ['b', '111', '1', 'Norwalk Station'],
        ]));
        expect(out.dests[out.byRouteDir['111|0']]).toBe('LAX City Bus Center');
        expect(out.dests[out.byRouteDir['111|1']]).toBe('Norwalk Station');
        expect(out.byTrip, 'neither trip is a minority branch').toEqual({});
    });

    it('emits a deterministic, deduplicated dests table', () => {
        // The weekly rebuild PR diff is only reviewable if identical input
        // yields identical output.
        const rows = [
            ['t1', '111', '0', 'Inglewood'],
            ['t2', '720', '0', 'Santa Monica'],
            ['t3', '733', '0', 'Inglewood'],
        ];
        const a = compactBusDestinations(...fixture(rows));
        const b = compactBusDestinations(...fixture([...rows].reverse()));
        expect(a.dests).toEqual([...new Set(a.dests)]);
        expect(a.dests).toEqual([...a.dests].sort());
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});

describe('compactBusDestinations — the silent-breakage signals (R9-04)', () => {
    it('flags a non-numeric route code, which the runtime could never match', () => {
        // The runtime looks up bare numeric codes from splitRouteId. If a GTFS
        // revision starts emitting "111-13149", every key silently stops
        // matching and the whole feature reverts to the terminus fallback with
        // no error — so the builder has to shout.
        const out = compactBusDestinations(
            { t1: { rc: '111-13149', dest: 'Inglewood' } }, { t1: '0' },
        );
        expect(out.nonBareRoutes).toEqual(['111-13149']);
    });

    it('stays quiet on ordinary numeric codes', () => {
        const out = compactBusDestinations(
            { t1: { rc: '111', dest: 'Inglewood' } }, { t1: '0' },
        );
        expect(out.nonBareRoutes).toEqual([]);
        expect(out.droppedEmptyDir).toBe(0);
    });

    it('drops and counts a route|dir key with no direction_id', () => {
        // Unmatchable dead weight: the runtime only ever queries dir 0/1.
        const out = compactBusDestinations(
            { t1: { rc: '111', dest: 'Inglewood' } }, { t1: '' },
        );
        expect(out.droppedEmptyDir).toBe(1);
        expect(out.byRouteDir).toEqual({});
        // And it does NOT reappear via byTrip: the trip matches its own
        // (direction-less) dominant, so the minority test excludes it. The trip
        // is therefore unresolvable from this file and falls through to the
        // live-terminus fallback at runtime — which is exactly why the builder
        // warns rather than failing quietly. Asserted so a future change that
        // starts emitting these keys has to come back and reconsider the
        // warning too.
        expect(out.byTrip).toEqual({});
    });

    it('handles an empty dataset without throwing', () => {
        const out = compactBusDestinations({}, {});
        expect(out).toEqual({ dests: [], byRouteDir: {}, byTrip: {}, nonBareRoutes: [], droppedEmptyDir: 0 });
    });
});
