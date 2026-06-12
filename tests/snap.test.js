import { vi, describe, it, expect, beforeAll } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(),
}));

import { snapToRoute, lngLatAtArc, shapeData, arcLengths, precomputeRoute, resolveShapeKey } from '../js/snap.js';

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

// ── snapToRoute — arc continuity (self-approaching alignment) ────────────────
// Reproduces the A Line "fly to the wrong arc" bug: a hairpin whose return leg
// runs ~56 m from the outbound leg, so a single physical spot maps to two arcs
// ~6 km apart. Global-nearest can grab the far one; the continuity hint keeps
// the marker on the arc near where it already is.
describe('snapToRoute — arc continuity on a self-approaching alignment', () => {
    const RC = 'HAIRPIN';
    const baseLat = 34.0, baseLng = -118.2;
    const D = 100 / 110540;   // 100 m in latitude degrees
    const E = 56 / 92630;     // 56 m in longitude degrees (return leg offset)
    let pts;

    beforeAll(() => {
        // Outbound: north 30×100 m on baseLng (arc 0..3000).
        const up = Array.from({ length: 31 }, (_, i) => [baseLat + i * D, baseLng]);
        // Return: south 30×100 m on a track 56 m east (arc ~3056..6056), so the
        // bottom-east point sits 56 m from the start but ~6 km away in arc.
        const down = Array.from({ length: 31 }, (_, i) => [baseLat + (30 - i) * D, baseLng + E]);
        pts = [...up, ...down];
        shapeData[RC] = pts; precomputeRoute(RC, pts);
    });

    // GPS near the bottom, slightly toward the (closer) return leg, so global
    // nearest lands on the FAR arc (~6 km).
    const gpsLng = baseLng + 35 / 92630;   // 35 m east of outbound, 21 m from return
    const gpsLat = baseLat;

    it('WITHOUT a hint, global-nearest grabs the far arc (the bug)', () => {
        const r = snapToRoute(RC, gpsLng, gpsLat);
        expect(r.arcMeters).toBeGreaterThan(5000);   // snapped onto the return leg
    });

    it('WITH a near-arc hint, keeps the marker on the near arc (the fix)', () => {
        const r = snapToRoute(RC, gpsLng, gpsLat, /*nearArc*/ 0);
        expect(r.arcMeters).toBeLessThan(200);        // stayed on the outbound leg
    });

    it('does NOT hold back a genuine move (only the far arc is comparable)', () => {
        // Marker was at arc 0; the train really travelled to the top (~arc 3000).
        // The near-arc (0) leg is ~3 km from this GPS, so it is NOT comparable —
        // the snap must follow the real position, not stick at the old arc.
        const r = snapToRoute(RC, baseLng, baseLat + 30 * D, /*nearArc*/ 0);
        expect(r.arcMeters).toBeGreaterThan(2900);
        expect(r.arcMeters).toBeLessThan(3100);
    });

    it('leaves a normal in-place snap unchanged when no far arc competes', () => {
        // Small lateral offset near arc 1000, hint at 1000 → ordinary snap, the
        // continuity branch never engages (jump < threshold).
        const r = snapToRoute(RC, baseLng + 5 / 92630, baseLat + 10 * D, /*nearArc*/ 1000);
        expect(r.arcMeters).toBeGreaterThan(900);
        expect(r.arcMeters).toBeLessThan(1100);
    });
});

// ── resolveShapeKey ─────────────────────────────────────────────────────────
// The per-direction split: a route may carry a bare `${code}` shape (canonical
// direction) plus a `${code}|${dir}` shape for the NON-canonical direction.
// resolveShapeKey must return the direction key only when it actually exists,
// and the bare code otherwise — so it's a safe drop-in for non-split routes and
// unknown directions (exactly the pre-split arc space).
describe('resolveShapeKey', () => {
    beforeAll(() => {
        buildRoute('RK_SPLIT');        // bare (canonical direction)
        buildRoute('RK_SPLIT|0');      // non-canonical direction present
        buildRoute('RK_PLAIN');        // non-split route — bare only
    });

    it('returns the direction key when that split shape exists', () => {
        expect(resolveShapeKey('RK_SPLIT', 0)).toBe('RK_SPLIT|0');
        expect(resolveShapeKey('RK_SPLIT', '0')).toBe('RK_SPLIT|0');
    });

    it('falls back to the bare code for the canonical direction (no |dir key)', () => {
        // dir 1 has no split shape — it IS the bare canonical shape.
        expect(resolveShapeKey('RK_SPLIT', 1)).toBe('RK_SPLIT');
    });

    it('falls back to the bare code for a non-split route in either direction', () => {
        expect(resolveShapeKey('RK_PLAIN', 0)).toBe('RK_PLAIN');
        expect(resolveShapeKey('RK_PLAIN', 1)).toBe('RK_PLAIN');
    });

    it('returns the bare code when direction is null/undefined/invalid', () => {
        expect(resolveShapeKey('RK_SPLIT', null)).toBe('RK_SPLIT');
        expect(resolveShapeKey('RK_SPLIT', undefined)).toBe('RK_SPLIT');
        expect(resolveShapeKey('RK_SPLIT', 2)).toBe('RK_SPLIT');
    });

    it('produces a key that snapToRoute can actually use', () => {
        const key = resolveShapeKey('RK_SPLIT', 0);
        const result = snapToRoute(key, -118.2, 34.0);
        expect(result).not.toBeNull();
        expect(arcLengths[key]).toBeDefined();
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
