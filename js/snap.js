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

function precomputeRoute(code, pts) {
    const cum = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + planarMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    arcLengths[code] = cum;
}

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
            console.log(`[snap] Loaded shapes for routes: ${Object.keys(shapeData).join(', ')}`);
        })
        .catch(err => {
            console.warn('[snap] Failed to load rail-shapes.json:', err);
            showToast('Rail shape data unavailable — train headings may be less accurate.');
        });
    return loadPromise;
}

export function hasShapeData(routeCode) {
    return Boolean(shapeData[routeCode]?.length);
}

/**
 * Snap a GPS coordinate to the nearest point on the route polyline.
 * Returns { snappedLng, snappedLat, arcIndex, arcMeters, tangentForward, endpointTangent }
 * or null if no shape data exists for the route.
 */
export function snapToRoute(routeCode, lng, lat) {
    const pts = shapeData[routeCode];
    if (!pts || pts.length < 2) return null;

    // Segment projection: find closest point on any segment (not just nearest vertex).
    // Isotropic metre-space projection avoids over-weighting N-S deviations at LA latitude.
    let bestIdx = 0, bestDist = Infinity, bestT = 0;

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
        if (d < bestDist) { bestDist = d; bestIdx = i; bestT = t; }
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

    return {
        snappedLat,
        snappedLng,
        arcIndex: bestIdx,
        arcMeters: snappedArcMeters,
        tangentForward: computeBearing(pts[i0][1], pts[i0][0], pts[i1][1], pts[i1][0]),
        endpointTangent,
    };
}
