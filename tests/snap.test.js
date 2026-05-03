import { vi, describe, it, expect, beforeAll } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(),
}));

import { snapToRoute, lngLatAtArc, shapeData, arcLengths, precomputeRoute } from '../js/snap.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Build a straight N-S route: n points spaced ~100m apart going north from baseLat.
// pts stored as [lat, lng].
function buildRoute(code, n = 10, baseLat = 34.0, baseLng = -118.2) {
    const DEG_PER_100M = 100 / 110540;
    const pts = Array.from({ length: n }, (_, i) => [baseLat + i * DEG_PER_100M, baseLng]);
    shapeData[code] = pts;
    precomputeRoute(code, pts);
    return pts;
}

// ── snapToRoute ───────────────────────────────────────────────────────────────

describe('snapToRoute', () => {
    const RC = 'SNAP_TEST';
    let pts;

    beforeAll(() => { pts = buildRoute(RC); });

    it('returns null for unknown route code', () => {
        expect(snapToRoute('UNKNOWN', -118.2, 34.0)).toBeNull();
    });

    it('snaps a point directly on the polyline', () => {
        const mid = pts[5];
        const result = snapToRoute(RC, mid[1], mid[0]);
        expect(result).not.toBeNull();
        expect(result.snappedLat).toBeCloseTo(mid[0], 5);
        expect(result.snappedLng).toBeCloseTo(mid[1], 5);
    });

    it('snaps a point laterally offset from the line', () => {
        // Point 100m east of the midpoint — should snap to the same lat on the line
        const mid = pts[5];
        const offsetLng = mid[1] + (100 / 92630);
        const result = snapToRoute(RC, offsetLng, mid[0]);
        expect(result).not.toBeNull();
        expect(result.snappedLng).toBeCloseTo(mid[1], 4);   // snapped back to line lng
        expect(result.snappedLat).toBeCloseTo(mid[0], 4);
    });

    it('returns a plausible arcMeters value', () => {
        // Point at ~middle of route should have arcMeters near 5 × 100m = 500m
        const mid = pts[5];
        const result = snapToRoute(RC, mid[1], mid[0]);
        expect(result.arcMeters).toBeGreaterThan(400);
        expect(result.arcMeters).toBeLessThan(600);
    });

    it('returns tangentForward as a valid bearing (0–360)', () => {
        const result = snapToRoute(RC, pts[3][1], pts[3][0]);
        expect(result.tangentForward).toBeGreaterThanOrEqual(0);
        expect(result.tangentForward).toBeLessThan(360);
    });

    it('tangentForward points roughly north (~0°) for a N-S route', () => {
        const result = snapToRoute(RC, pts[3][1], pts[3][0]);
        // North = 0°; allow generous ±15° for floating-point
        const delta = Math.abs(((result.tangentForward + 180) % 360) - 180);
        expect(delta).toBeLessThan(15);
    });

    it('handles a point before the first segment (clamps to start)', () => {
        const start = pts[0];
        // Point 200m south of start — should snap to start or very close
        const southLat = start[0] - (200 / 110540);
        const result = snapToRoute(RC, start[1], southLat);
        expect(result).not.toBeNull();
        expect(result.arcMeters).toBeGreaterThanOrEqual(0);
    });

    it('handles a point after the last segment (clamps to end)', () => {
        const end = pts[pts.length - 1];
        const northLat = end[0] + (200 / 110540);
        const result = snapToRoute(RC, end[1], northLat);
        expect(result).not.toBeNull();
        expect(result.arcMeters).toBeLessThanOrEqual(arcLengths[RC][pts.length - 1] + 1);
    });
});

// ── lngLatAtArc ───────────────────────────────────────────────────────────────

describe('lngLatAtArc', () => {
    const RC = 'ARC_TEST';
    let pts;

    beforeAll(() => { pts = buildRoute(RC); });

    it('returns null for unknown route', () => {
        expect(lngLatAtArc('UNKNOWN', 0)).toBeNull();
    });

    it('returns start of route for arc = 0', () => {
        const result = lngLatAtArc(RC, 0);
        expect(result.lat).toBeCloseTo(pts[0][0], 5);
        expect(result.lng).toBeCloseTo(pts[0][1], 5);
    });

    it('returns end of route for arc beyond total length', () => {
        const totalArc = arcLengths[RC][pts.length - 1];
        const result   = lngLatAtArc(RC, totalArc + 9999);
        expect(result.lat).toBeCloseTo(pts[pts.length - 1][0], 4);
    });

    it('returns midpoint for arc at half total length', () => {
        const totalArc = arcLengths[RC][pts.length - 1];
        const result   = lngLatAtArc(RC, totalArc / 2);
        expect(result).not.toBeNull();
        // Midpoint should be roughly in the middle of the lat range
        const midLat = (pts[0][0] + pts[pts.length - 1][0]) / 2;
        expect(result.lat).toBeCloseTo(midLat, 3);
    });

    it('roundtrips: snap then arc lookup returns same position', () => {
        const pt = pts[4];
        const snap = snapToRoute(RC, pt[1], pt[0]);
        const back = lngLatAtArc(RC, snap.arcMeters);
        expect(back.lat).toBeCloseTo(pt[0], 4);
        expect(back.lng).toBeCloseTo(pt[1], 4);
    });

    it('tangent from lngLatAtArc is a valid bearing', () => {
        const totalArc = arcLengths[RC][pts.length - 1];
        const result   = lngLatAtArc(RC, totalArc / 3);
        expect(result.tangent).toBeGreaterThanOrEqual(0);
        expect(result.tangent).toBeLessThan(360);
    });
});
