/**
 * snap.js — GTFS Shape Snapping
 *
 * Loads rail-shapes.json (pre-built from GTFS shapes.txt + trips.txt) and
 * exposes snapToRoute(routeCode, lng, lat) which returns:
 *   { snappedLng, snappedLat, bearing }
 *
 * The bearing is the tangent of the polyline at the snapped point, giving
 * a precise, noise-free heading regardless of GPS scatter.
 *
 * Snapping replaces canonical bearings and trajectory calculations as the
 * PRIMARY source of heading for all routes that have shape data.
 */

import { computeBearing } from './utils.js';
import { showToast } from './ui.js';

// In-memory cache: routeCode → Float32Array pair [lat0,lng0, lat1,lng1, ...]
const shapeData = {};  // routeCode → [[lat, lng], ...]
let loadPromise = null;

/**
 * Load shapes once.  Called from main.js at startup.
 * Returns a Promise that resolves when data is ready.
 */
export function loadShapes() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch('./js/rail-shapes.json')
        .then(r => r.json())
        .then(data => {
            for (const [code, pts] of Object.entries(data)) {
                if (pts && pts.length > 0) {
                    shapeData[code] = pts; // [[lat,lng], ...]
                }
            }
            console.log(`[snap] Loaded shape data for routes: ${Object.keys(shapeData).join(', ')}`);
        })
        .catch(err => {
            console.warn('[snap] Failed to load rail-shapes.json:', err);
            showToast('Rail shape data unavailable — train headings may be less accurate.');
        });
    return loadPromise;
}

/**
 * Returns true if shape data is available for a route.
 */
export function hasShapeData(routeCode) {
    return Boolean(shapeData[routeCode]?.length);
}

/**
 * Snap a raw GPS coordinate to the nearest point on the route polyline.
 *
 * Returns { snappedLng, snappedLat, bearing } or null if no shape data.
 *
 * bearing is derived from the local tangent of the polyline segment,
 * giving a smooth, track-aligned heading.
 */
export function snapToRoute(routeCode, lng, lat) {
    const pts = shapeData[routeCode];
    if (!pts || pts.length === 0) return null;

    let bestIdx = 0;
    let bestDist = Infinity;

    // Find nearest point (O(n) — fast enough for up to ~7k points)
    for (let i = 0; i < pts.length; i++) {
        const dlat = pts[i][0] - lat;
        const dlng = pts[i][1] - lng;
        const d = dlat * dlat + dlng * dlng; // squared distance (no sqrt needed for comparison)
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }

    const snapped = pts[bestIdx];

    // Derive bearing from the local tangent.
    // Use a window of ±3 points around the snap to smooth out any kinks.
    const i0 = Math.max(0, bestIdx - 3);
    const i1 = Math.min(pts.length - 1, bestIdx + 3);
    const from = pts[i0];
    const to   = pts[i1];

    const bearing = computeBearing(from[1], from[0], to[1], to[0]);

    return {
        snappedLat: snapped[0],
        snappedLng: snapped[1],
        bearing,
        segmentFrom: from,
        segmentTo:   to,
    };
}



