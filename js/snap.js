/**
 * snap.js — GTFS Shape Snapping
 *
 * Loads rail-shapes.json and exposes snapToRoute(routeCode, lng, lat) which
 * returns the snapped position and polyline tangent bearing at that point.
 */

import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA } from './utils.js';
import { showToast } from './ui.js';

// In-memory cache: routeCode → [[lat, lng], ...]
export const shapeData = {};
// Cumulative arc lengths per route: routeCode → Float64Array
export const arcLengths = {};

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
    loadPromise = fetch('./data/rail-shapes.json')
        .then(r => r.json())
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
 * Project a lat/lng point onto the nearest segment of a shape polyline.
 *
 * Note: `tangentForward` may be `null` when the polyline has consecutive
 * zero-length segments (duplicate vertices) around the snap location and
 * the window-expansion fallback can't find a non-degenerate span. Callers
 * (markers.js arc-glide, predictions.js bearing computations) should
 * tolerate null and fall back to a previously-known tangent.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Array<[number,number]>} pts  Shape points as [lat, lng] pairs
 *   (matches the storage layout in `shapeData` — see the top-of-file note).
 * @returns {{ arcM: number, lat: number, lng: number, dist: number, tangentBearing: number|null }|null}
 */
export function snapToRoute(routeCode, lng, lat) {
    const pts = shapeData[routeCode];
    if (!pts || pts.length < 2) return null;

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
 * Interpolate a lat/lng position at a given arc distance along a shape.
 * @param {Array<[number,number]>} pts  Shape points as [lat, lng] pairs
 *   (matches the storage layout in `shapeData`).
 * @param {number} arcM  Target arc distance (metres from start).
 * @returns {{ lat: number, lng: number }|null}
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
