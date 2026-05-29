/**
 * Data-driven regression guard for the rail/busway shape build.
 *
 * The ETA arc math (predictions.computeTripAdherenceOffset / gtfsLooksPlausible)
 * requires each route's stops to project onto its polyline as a MONOTONIC arc
 * sequence — increasing for the direction matching the shape, decreasing for the
 * reverse (predictions.js orients per direction). A scrambled, non-monotonic
 * polyline (the old rail build unioned all shape variants in file order, e.g. the
 * A Line came out ~186 km) silently disables adherence and makes GTFS-RT get
 * rejected as "past the stop" for that route.
 *
 * This test reads the COMMITTED data artifacts and asserts every route|direction
 * projects monotonically, so a future `node scripts/build-shapes.cjs` that
 * regresses the shapes fails CI instead of quietly degrading half the fleet.
 *
 * Self-contained: it inlines the planar projection + arc math from snap.js and
 * the orientation classifier threshold from predictions.js so it depends only on
 * the data, not on app-module import side effects.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = rel => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const shapes = read('../data/rail-shapes.json');
const trips  = read('../data/trips.json');
const stops  = read('../data/stops.json');

// Mirror utils.js M_PER_DEG_* (LA-basin calibration) and snap.js arc projection.
const M_LAT = 110540;
const M_LNG = 92630;
const planar = (la1, lo1, la2, lo2) => {
    const dy = (la2 - la1) * M_LAT, dx = (lo2 - lo1) * M_LNG;
    return Math.sqrt(dy * dy + dx * dx);
};
function cumArc(pts) {
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + planar(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    return cum;
}
// arcMeters of the projection of (lng,lat) onto the polyline — same isotropic
// metre-space segment projection as snap.snapToRoute.
function snapArc(pts, cum, lng, lat) {
    let bi = 0, bd = Infinity, bt = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        const ay = pts[i][0], ax = pts[i][1], by = pts[i + 1][0], bx = pts[i + 1][1];
        const aby = (by - ay) * M_LAT, abx = (bx - ax) * M_LNG;
        const qy = (lat - ay) * M_LAT, qx = (lng - ax) * M_LNG;
        const ab2 = aby * aby + abx * abx;
        const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (qy * aby + qx * abx) / ab2));
        const cy = ay + t * (by - ay), cx = ax + t * (bx - ax);
        const dy = (lat - cy) * M_LAT, dx = (lng - cx) * M_LNG;
        const d = dy * dy + dx * dx;
        if (d < bd) { bd = d; bi = i; bt = t; }
    }
    return cum[bi] + bt * planar(pts[bi][0], pts[bi][1], pts[bi + 1][0], pts[bi + 1][1]);
}

// Best (longest) trip per route|dir, mirroring initPredictions' cache build.
function bestTrips() {
    const best = {};
    for (const t of Object.values(trips)) {
        if (t.rc == null || t.dir == null || !t.stops?.length) continue;
        const k = `${t.rc}|${t.dir}`;
        if (!best[k] || t.stops.length > best[k].stops.length) best[k] = t;
    }
    return best;
}

// Same threshold predictions._computeArcOrientation uses to flag a cache unreliable.
const UNRELIABLE_FRACTION = 0.15;

describe('rail-shapes.json — stops project monotonically per route|direction', () => {
    const best = bestTrips();
    const keys = Object.keys(best).filter(k => {
        const rc = k.split('|')[0];
        return shapes[rc]?.length > 1;
    });

    it('has route|direction combinations to check', () => {
        expect(keys.length).toBeGreaterThan(0);
    });

    it.each(keys)('%s projects to a monotonic arc sequence', key => {
        const [rc] = key.split('|');
        const pts = shapes[rc];
        const cum = cumArc(pts);
        const arcs = best[key].stops
            .filter(Boolean)
            .map(sid => {
                const s = stops[sid] ?? stops[String(sid).replace(/\D+$/, '')];
                return s && Number.isFinite(s.lat) && Number.isFinite(s.lon) ? snapArc(pts, cum, s.lon, s.lat) : null;
            })
            .filter(a => a != null);

        if (arcs.length < 3) return; // too few stops to assess

        let inc = 0, dec = 0;
        for (let i = 1; i < arcs.length; i++) {
            if (arcs[i] > arcs[i - 1]) inc++;
            else if (arcs[i] < arcs[i - 1]) dec++;
        }
        const reversals = Math.min(inc, dec) / (inc + dec);
        // A clean directional shape has ~0 reversals; allow the same 15% slack
        // production treats as still-usable. A scrambled union (old A Line ≈ 47%)
        // fails here, matching predictions.js marking that cache arcUnreliable.
        expect(reversals, `${key}: inc=${inc} dec=${dec} reversals=${(reversals * 100).toFixed(0)}%`)
            .toBeLessThanOrEqual(UNRELIABLE_FRACTION);
    });
});
