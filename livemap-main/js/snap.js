/**
 * snap.js — GTFS Shape Snapping (oriented-tangent edition)
 *
 * Loads rail-shapes.json (pre-built from GTFS shapes.txt + trips.txt) and
 * exposes snapToRoute(routeCode, lng, lat) which returns:
 *   { snappedLng, snappedLat, arcIndex, arcMeters, tangentForward }
 *
 * `tangentForward` is the bearing of the polyline at the snapped point in the
 * direction of *increasing arc index*. Callers flip it (+180°) when the
 * vehicle's direction of travel runs against the stored polyline ordering.
 *
 * Per-route, we also precompute `dir0IncreasesArc[routeCode]`: whether
 * direction_id=0 corresponds to increasing or decreasing arc index along the
 * stored polyline. This is the foundation for unambiguous heading: combine
 * "direction along polyline" (from arc-progression history or direction_id)
 * with the polyline tangent and you get a deterministically correct bearing.
 */

import { computeBearing } from './utils.js';
import { showToast } from './ui.js';
import { routeDirectionLabels } from './config.js';

const DIRECTION_BEARINGS = {
    'Northbound': 0,
    'Southbound': 180,
    'Eastbound': 90,
    'Westbound': 270,
    'Southbound / Eastbound': 135,
    'Northbound / Westbound': 315,
};

// In-memory cache: routeCode → [[lat, lng], ...]
const shapeData = {};
// Parallel array per route: cumulative meters from pts[0] to pts[i]
const arcLengths = {};
// Whether direction_id=0 corresponds to increasing arc index along stored polyline
const dir0IncreasesArc = {};
let loadPromise = null;

// Mean meters per degree at LA latitude (~34°). Good enough for tangent length comparisons.
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_LA = 92500;

function planarMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
    const dLng = (lng2 - lng1) * M_PER_DEG_LNG_LA;
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

function precomputeRoute(code, pts) {
    // Cumulative arc-length
    const cum = new Float64Array(pts.length);
    cum[0] = 0;
    for (let i = 1; i < pts.length; i++) {
        cum[i] = cum[i - 1] + planarMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    }
    arcLengths[code] = cum;

    // Determine dir0IncreasesArc: does direction_id=0 travel from pts[0] → pts[last]?
    // Strategy: compute the gross bearing of the polyline (start → end) and compare
    // to the cardinal implied by routeDirectionLabels[code][0]. Compound directions
    // (135°, 315°) are accepted within ±67.5°; pure cardinals within ±45°.
    const labels = routeDirectionLabels[code];
    let dir0Increases = true; // safe default
    if (labels && labels[0] != null) {
        const cardinal = DIRECTION_BEARINGS[labels[0]];
        if (cardinal != null) {
            const start = pts[0];
            const end = pts[pts.length - 1];
            const grossBearing = computeBearing(start[1], start[0], end[1], end[0]);
            // Angular distance to cardinal vs. to (cardinal + 180)
            const diffForward = Math.abs(((grossBearing - cardinal + 540) % 360) - 180);
            const diffReverse = Math.abs(((grossBearing - (cardinal + 180) + 540) % 360) - 180);
            dir0Increases = diffForward <= diffReverse;
        }
    }
    dir0IncreasesArc[code] = dir0Increases;
}

/**
 * Load shapes once. Called from main.js at startup.
 * Returns a Promise that resolves when data is ready.
 */
export function loadShapes() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch('./data/rail-shapes.json')
        .then(r => r.json())
        .then(data => {
            for (const [code, pts] of Object.entries(data)) {
                if (pts && pts.length > 1) {
                    shapeData[code] = pts;
                    precomputeRoute(code, pts);
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

export function hasShapeData(routeCode) {
    return Boolean(shapeData[routeCode]?.length);
}

/**
 * Returns whether direction_id=0 travels with increasing arc index for this
 * route. Callers use this with arc-progression history to determine the
 * vehicle's direction of travel along the polyline.
 */
export function dir0Increases(routeCode) {
    return dir0IncreasesArc[routeCode] !== false; // default true if unknown
}

/**
 * Snap a raw GPS coordinate to the nearest point on the route polyline.
 *
 * Returns:
 *   {
 *     snappedLng, snappedLat,
 *     arcIndex,        // index into shapeData[routeCode]
 *     arcMeters,       // cumulative arc length at the snapped point
 *     tangentForward,  // bearing of polyline tangent in direction of INCREASING arc index
 *     endpointTangent, // true if snap is near either end of the polyline (one-sided window)
 *   }
 * or null if no shape data.
 */
export function snapToRoute(routeCode, lng, lat) {
    const pts = shapeData[routeCode];
    if (!pts || pts.length < 2) return null;

    // Segment projection snap: find the closest point on any line segment, not just
    // the nearest vertex. This keeps the marker visually on the track on long segments.
    let bestIdx = 0;
    let bestDist = Infinity;
    let bestT = 0; // interpolation parameter along the best segment [0, 1]

    for (let i = 0; i < pts.length - 1; i++) {
        const ay = pts[i][0],  ax = pts[i][1];   // lat, lng of segment start
        const by = pts[i+1][0], bx = pts[i+1][1]; // lat, lng of segment end
        const aby = by - ay, abx = bx - ax;
        const ab2 = aby * aby + abx * abx;
        const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1,
            ((lat - ay) * aby + (lng - ax) * abx) / ab2
        ));
        const cy = ay + t * aby, cx = ax + t * abx;
        const d = (lat - cy) * (lat - cy) + (lng - cx) * (lng - cx);
        if (d < bestDist) { bestDist = d; bestIdx = i; bestT = t; }
    }

    // Interpolate the snapped position along the best segment
    const snappedLat = pts[bestIdx][0] + bestT * (pts[bestIdx + 1][0] - pts[bestIdx][0]);
    const snappedLng = pts[bestIdx][1] + bestT * (pts[bestIdx + 1][1] - pts[bestIdx][1]);
    const snappedArcMeters = arcLengths[routeCode][bestIdx] +
        bestT * planarMeters(pts[bestIdx][0], pts[bestIdx][1], pts[bestIdx + 1][0], pts[bestIdx + 1][1]);

    // Tangent window: ±3 points around the snap vertex. Near endpoints, expand asymmetrically.
    const WINDOW = 3;
    const lastIdx = pts.length - 1;
    let i0 = bestIdx - WINDOW;
    let i1 = bestIdx + WINDOW + 1; // +1 because bestIdx is a segment index
    let endpointTangent = false;
    if (i0 < 0) {
        i1 = Math.min(lastIdx, i1 - i0); // shift the window forward
        i0 = 0;
        endpointTangent = true;
    }
    if (i1 > lastIdx) {
        i0 = Math.max(0, i0 - (i1 - lastIdx));
        i1 = lastIdx;
        endpointTangent = true;
    }
    if (i0 === i1) {
        // Single-point polyline edge case (shouldn't happen with length≥2, but be safe)
        i1 = Math.min(lastIdx, i0 + 1);
        if (i0 === i1) i0 = Math.max(0, i1 - 1);
    }

    const from = pts[i0];
    const to = pts[i1];
    const tangentForward = computeBearing(from[1], from[0], to[1], to[0]);

    return {
        snappedLat,
        snappedLng,
        arcIndex: bestIdx,
        arcMeters: snappedArcMeters,
        tangentForward,
        endpointTangent,
    };
}
