/**
 * snap.js — GTFS Shape Snapping
 *
 * Loads rail-shapes.json and exposes snapToRoute(routeCode, lng, lat) which
 * returns the snapped position and polyline tangent bearing at that point.
 */

import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, fetchWithTimeout } from './utils.js';
import { showToast } from './ui.js';

// In-memory cache: routeCode → [[lat, lng], ...]
export const shapeData = {};
// Cumulative arc lengths per route: routeCode → Float64Array
export const arcLengths = {};

// Continuity-snap tuning. A bare global-nearest snap can grab the WRONG pass of
// a polyline that runs near itself (the A Line alignment approaches within tens
// of metres of an arc ~12 km away at one spot) — a 59 m-off GPS fix lands on the
// far arc and the marker glides 12 km along the track. When a prior arc is known
// and the global-nearest snap would jump more than this many metres in ARC from
// it, we look for a comparable-quality snap that's continuous with the prior arc.
const ARC_CONTINUITY_JUMP_M = 1500;
// A candidate snap whose GPS deviation is within this many metres of the
// global-best deviation counts as "comparable quality"; among those we prefer
// the one closest in arc to the prior position. Kept well below any real
// inter-fix movement so a genuine catch-up (whose near-arc snap deviates far
// from the new GPS) is never preferred — only a true self-approach has two
// comparable snaps at very different arcs.
const ARC_CONTINUITY_SLACK_M = 60;

let loadPromise = null;

/**
 * Clear cached rail shape data and reset the load promise so the next
 * loadShapes() call re-fetches. Called when GTFS data reloads at midnight.
 * In practice rail alignments rarely change overnight (the JSON is a built
 * artifact), so this is mostly defensive — but cheap to call and avoids
 * the next-day app continuing to use yesterday's polylines if Metro ever
 * publishes a fresh build.
 */
export function _clearShapeCache() {
    for (const k in shapeData)   delete shapeData[k];
    for (const k in arcLengths)  delete arcLengths[k];
    loadPromise = null;
}

/**
 * Precompute cumulative arc lengths (meters) for a route polyline and cache them.
 * Must be called before snapToRoute or lngLatAtArc will work for this route.
 * @param {string} code Route code (e.g. "801")
 * @param {Array<[number, number]>} pts Array of [lat, lng] polyline points
 */
export function precomputeRoute(code, pts) {
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + planarMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    arcLengths[code] = cum;
}

/**
 * Fetch and parse data/rail-shapes.json, populating shapeData and arcLengths.
 * Returns a shared promise — safe to call multiple times.
 * @returns {Promise<void>}
 */
export function loadShapes() {
    if (loadPromise) return loadPromise;
    loadPromise = fetchWithTimeout('./data/rail-shapes.json', 15000)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
            for (const [code, pts] of Object.entries(data)) {
                if (pts?.length > 1) {
                    shapeData[code] = pts;
                    precomputeRoute(code, pts);
                }
            }
        })
        .catch(err => {
            console.warn('[snap] Failed to load rail-shapes.json:', err);
            showToast('Rail shape data unavailable — train headings may be less accurate.');
        });
    return loadPromise;
}

/**
 * Returns true if polyline shape data has been loaded for the given route.
 * @param {string} routeCode
 * @returns {boolean}
 */
export function hasShapeData(routeCode) {
    return Boolean(shapeData[routeCode]?.length);
}

/**
 * Resolve the shape key for a route + travel direction.
 *
 * rail-shapes.json stores a bare `${routeCode}` polyline (the canonical /
 * longest-overall shape, which is one direction's alignment) plus, for routes
 * whose two directions diverge enough to matter (one-way couplets, loop
 * terminals — see build-shapes.cjs `DIRECTION_SPLIT_MIN_M`), a separate
 * `${routeCode}|${dir}` polyline for the NON-canonical direction. The canonical
 * direction has no `|dir` key and is served by the bare shape via the fallback
 * here, so a vehicle always snaps to its OWN direction's track.
 *
 * Returns the bare code when direction is unknown (null/undefined) or the route
 * isn't split — i.e. exactly the pre-split behaviour — so this is a safe drop-in
 * for any per-vehicle arc call. All arc math for a given marker MUST use the
 * same resolved key (snap, glide `lngLatAtArc`, stop-arc cache) so the arc
 * space stays coherent; `arcLengths` is keyed identically.
 *
 * @param {string} routeCode
 * @param {number|string|null|undefined} dir  GTFS direction_id (0 or 1)
 * @returns {string} the shape key to pass to snapToRoute / lngLatAtArc
 */
export function resolveShapeKey(routeCode, dir) {
    if (dir !== 0 && dir !== 1 && dir !== '0' && dir !== '1') return routeCode;
    const key = `${routeCode}|${dir}`;
    return shapeData[key] ? key : routeCode;
}

/**
 * Project a lat/lng point onto the nearest segment of a shape polyline.
 *
 * Note: `tangentForward` may be `null` when the polyline has consecutive
 * zero-length segments (duplicate vertices) around the snap location and
 * the window-expansion fallback can't find a non-degenerate span. Callers
 * (markers.js arc-glide, predictions.js bearing computations) should
 * tolerate null and fall back to a previously-known tangent.
 *
 * @param {string} routeCode  Key into `shapeData` (points stored as [lat, lng]
 *   pairs — see the top-of-file note).
 * @param {number} lng
 * @param {number} lat
 * @returns {{ snappedLat: number, snappedLng: number, arcIndex: number,
 *   arcMeters: number, tangentForward: number|null, endpointTangent: boolean }|null}
 *   null when the route has no usable shape.
 */
export function snapToRoute(routeCode, lng, lat, nearArc = null) {
    const pts = shapeData[routeCode];
    if (!pts || pts.length < 2) return null;
    const arcs = arcLengths[routeCode];

    // Arc distance to the snap point on segment i at parameter t.
    const arcAt = (i, t) => arcs[i] +
        t * planarMeters(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);

    // Segment projection: find closest point on any segment (not just nearest vertex).
    // Isotropic metre-space projection avoids over-weighting N-S deviations at LA latitude.
    let bestIdx = 0, _bestDistSq = Infinity, bestT = 0;

    for (let i = 0; i < pts.length - 1; i++) {
        const ay = pts[i][0],   ax = pts[i][1];
        const by = pts[i+1][0], bx = pts[i+1][1];
        const aby = (by - ay) * M_PER_DEG_LAT;
        const abx = (bx - ax) * M_PER_DEG_LNG_LA;
        const qy  = (lat - ay) * M_PER_DEG_LAT;
        const qx  = (lng - ax) * M_PER_DEG_LNG_LA;
        const ab2 = aby * aby + abx * abx;
        const t   = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (qy * aby + qx * abx) / ab2));
        const cy  = ay + t * (by - ay), cx = ax + t * (bx - ax);
        const dLat = (lat - cy) * M_PER_DEG_LAT;
        const dLng = (lng - cx) * M_PER_DEG_LNG_LA;
        const d = dLat * dLat + dLng * dLng;
        if (d < _bestDistSq) { _bestDistSq = d; bestIdx = i; bestT = t; }
    }

    // Continuity preference. The global-nearest snap above is stateless, so on a
    // self-approaching alignment it can pick an arc kilometres from where the
    // marker actually is (the "fly to the wrong arc" bug). When a prior arc is
    // known AND the global snap jumps more than ARC_CONTINUITY_JUMP_M from it,
    // re-scan for the snap CLOSEST IN ARC to nearArc among segments whose GPS
    // deviation is within ARC_CONTINUITY_SLACK_M of the global best — i.e. a
    // comparable-quality snap on the near pass of the line. A genuine long-gap
    // catch-up has no such comparable near-arc snap (its near-arc projection
    // deviates far from the new GPS), so it still snaps to the real far arc.
    if (nearArc != null && arcs && Math.abs(arcAt(bestIdx, bestT) - nearArc) > ARC_CONTINUITY_JUMP_M) {
        const slack = Math.sqrt(_bestDistSq) + ARC_CONTINUITY_SLACK_M;
        const slackSq = slack * slack;
        let cIdx = -1, cT = 0, cArcDiff = Math.abs(arcAt(bestIdx, bestT) - nearArc);
        for (let i = 0; i < pts.length - 1; i++) {
            const ay = pts[i][0],   ax = pts[i][1];
            const by = pts[i+1][0], bx = pts[i+1][1];
            const aby = (by - ay) * M_PER_DEG_LAT;
            const abx = (bx - ax) * M_PER_DEG_LNG_LA;
            const qy  = (lat - ay) * M_PER_DEG_LAT;
            const qx  = (lng - ax) * M_PER_DEG_LNG_LA;
            const ab2 = aby * aby + abx * abx;
            const t   = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (qy * aby + qx * abx) / ab2));
            const cy  = ay + t * (by - ay), cx = ax + t * (bx - ax);
            const dLat = (lat - cy) * M_PER_DEG_LAT;
            const dLng = (lng - cx) * M_PER_DEG_LNG_LA;
            if (dLat * dLat + dLng * dLng > slackSq) continue;   // not comparable quality
            const diff = Math.abs(arcAt(i, t) - nearArc);
            if (diff < cArcDiff) { cArcDiff = diff; cIdx = i; cT = t; }
        }
        if (cIdx >= 0) { bestIdx = cIdx; bestT = cT; }
    }

    const snappedLat = pts[bestIdx][0] + bestT * (pts[bestIdx + 1][0] - pts[bestIdx][0]);
    const snappedLng = pts[bestIdx][1] + bestT * (pts[bestIdx + 1][1] - pts[bestIdx][1]);
    const snappedArcMeters = arcLengths[routeCode][bestIdx] +
        bestT * planarMeters(pts[bestIdx][0], pts[bestIdx][1], pts[bestIdx + 1][0], pts[bestIdx + 1][1]);

    // Tangent: ±3 points around snap vertex, expanded asymmetrically near endpoints
    const WINDOW = 3;
    const lastIdx = pts.length - 1;
    let i0 = bestIdx - WINDOW;
    let i1 = bestIdx + WINDOW + 1;
    let endpointTangent = false;
    if (i0 < 0)       { i1 = Math.min(lastIdx, i1 - i0); i0 = 0; endpointTangent = true; }
    if (i1 > lastIdx) { i0 = Math.max(0, i0 - (i1 - lastIdx)); i1 = lastIdx; endpointTangent = true; }
    if (i0 === i1)    { i1 = Math.min(lastIdx, i0 + 1); if (i0 === i1) i0 = Math.max(0, i1 - 1); }

    // Degenerate guard: don't emit a bearing when the window collapses to a single point
    // or the spanning arc is sub-meter (float noise). Caller preserves last-known tangent.
    const tangentDist = planarMeters(pts[i0][0], pts[i0][1], pts[i1][0], pts[i1][1]);
    const tangentForward = (i0 !== i1 && tangentDist >= 1.0)
        ? computeBearing(pts[i0][1], pts[i0][0], pts[i1][1], pts[i1][0])
        : null;

    return {
        snappedLat,
        snappedLng,
        arcIndex: bestIdx,
        arcMeters: snappedArcMeters,
        tangentForward,
        endpointTangent,
    };
}

/**
 * Position-only counterpart to `lngLatAtArc` — returns just `{ lat, lng }`, no
 * `tangent`. The `arcGlide` rAF tick calls this for every gliding marker every
 * frame and drives heading from a precomputed lerp, so it never reads the
 * bearing; skipping the `computeBearing` trig here removes the largest per-frame
 * CPU cost on a busy map. The position math is byte-identical to `lngLatAtArc`
 * (pinned by tests/snap.test.js). Cold-path callers that need the bearing keep
 * using `lngLatAtArc`.
 * @returns {{ lat: number, lng: number }|null} null when the route has no shape.
 */
export function lngLatAtArcPos(routeCode, target) {
    const pts  = shapeData[routeCode];
    const arcs = arcLengths[routeCode];
    if (!pts || !arcs || pts.length < 2) return null;

    if (target <= arcs[0])   return { lat: pts[0][0], lng: pts[0][1] };
    const last = arcs.length - 1;
    if (target >= arcs[last]) return { lat: pts[last][0], lng: pts[last][1] };

    let lo = 0, hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arcs[mid] <= target) lo = mid; else hi = mid;
    }
    const span = arcs[hi] - arcs[lo];
    const t    = span > 0 ? (target - arcs[lo]) / span : 0;
    return {
        lat: pts[lo][0] + t * (pts[hi][0] - pts[lo][0]),
        lng: pts[lo][1] + t * (pts[hi][1] - pts[lo][1]),
    };
}

/**
 * Interpolate a lat/lng position at a given arc distance along a shape.
 * Clamps to the polyline endpoints (a target before the start / past the end
 * returns the endpoint itself, never extrapolates).
 * @param {string} routeCode  Key into `shapeData` / `arcLengths`.
 * @param {number} target  Target arc distance (metres from start).
 * @returns {{ lat: number, lng: number, tangent: number|null }|null}
 *   null when the route has no usable shape.
 */
export function lngLatAtArc(routeCode, target) {
    const pts  = shapeData[routeCode];
    const arcs = arcLengths[routeCode];
    if (!pts || !arcs) return null;
    if (pts.length < 2) return null;

    if (target <= arcs[0]) {
        return {
            lat: pts[0][0], lng: pts[0][1],
            tangent: computeBearing(pts[0][1], pts[0][0], pts[1][1], pts[1][0]),
        };
    }
    const last = arcs.length - 1;
    if (target >= arcs[last]) {
        return {
            lat: pts[last][0], lng: pts[last][1],
            tangent: computeBearing(pts[last - 1][1], pts[last - 1][0], pts[last][1], pts[last][0]),
        };
    }

    let lo = 0, hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arcs[mid] <= target) lo = mid; else hi = mid;
    }
    const span = arcs[hi] - arcs[lo];
    const t    = span > 0 ? (target - arcs[lo]) / span : 0;
    return {
        lat:     pts[lo][0] + t * (pts[hi][0] - pts[lo][0]),
        lng:     pts[lo][1] + t * (pts[hi][1] - pts[lo][1]),
        tangent: computeBearing(pts[lo][1], pts[lo][0], pts[hi][1], pts[hi][0]),
    };
}
