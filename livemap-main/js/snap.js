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

import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, DIRECTION_BEARINGS } from './utils.js';
import { showToast } from './ui.js';
import { routeDirectionLabels } from './config.js';

// In-memory cache: routeCode → [[lat, lng], ...]
export const shapeData = {};
// Parallel array per route: cumulative meters from pts[0] to pts[i]
export const arcLengths = {};
// Whether direction_id=0 corresponds to increasing arc index along stored polyline
export const dir0IncreasesArc = {};
// Per-(routeCode|stopId) cache of pre-snapped station arc position.
// Populated once after trips.json + stops.json + shapes are all loaded.
// Value: { arcMeters, snappedLat, snappedLng } or null if station is too far from polyline.
export const stationArc = new Map();
let loadPromise = null;

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
 * Pre-snap every station served by every route to that route's polyline,
 * caching the station's along-track arc position. Lets predictions.js compute
 * true track distance (|stationArc − vehicleArc|) instead of planar distance ×
 * a curvature fudge factor. Stations farther than 250 m from the polyline are
 * skipped (likely a stop served by buses on the route only, or a data quirk).
 *
 * Idempotent: safe to call after data refresh.
 */
const STATION_SNAP_MAX_M = 250;
export function precomputeStationArcs(stops, trips) {
    if (!stops || !trips) return;
    stationArc.clear();
    // Build {routeCode → Set<stopId>} from trips.json
    const routeStops = new Map();
    for (const trip of Object.values(trips)) {
        const rc = trip?.rc;
        if (!rc || !shapeData[rc]) continue;
        let set = routeStops.get(rc);
        if (!set) { set = new Set(); routeStops.set(rc, set); }
        (trip.stops || []).forEach(s => set.add(String(s)));
    }
    let snapped = 0, skipped = 0;
    for (const [rc, stopIds] of routeStops) {
        for (const sid of stopIds) {
            const stop = stops[sid];
            if (!stop?.lat || !stop?.lon) { skipped++; continue; }
            const snap = snapToRoute(rc, stop.lon, stop.lat);
            if (!snap) { skipped++; continue; }
            const offM = planarMeters(stop.lat, stop.lon, snap.snappedLat, snap.snappedLng);
            if (offM > STATION_SNAP_MAX_M) { skipped++; continue; }
            stationArc.set(`${rc}|${sid}`, {
                arcMeters: snap.arcMeters,
                snappedLat: snap.snappedLat,
                snappedLng: snap.snappedLng,
            });
            snapped++;
        }
    }
    console.log(`[snap] Pre-snapped ${snapped} (route, stop) pairs to track polylines (${skipped} skipped).`);
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
        // Scale to approximate meters so the projection is isotropic.
        // Without this, the degree-space metric over-weights N-S deviations
        // (~19% at LA latitude) and can snap to the wrong segment at curves.
        const aby = (by - ay) * M_PER_DEG_LAT;
        const abx = (bx - ax) * M_PER_DEG_LNG_LA;
        const qy  = (lat - ay) * M_PER_DEG_LAT;
        const qx  = (lng - ax) * M_PER_DEG_LNG_LA;
        const ab2 = aby * aby + abx * abx;
        const t = ab2 === 0 ? 0 : Math.max(0, Math.min(1, (qy * aby + qx * abx) / ab2));
        // Projected point back in degree-space for position interpolation.
        const cy = ay + t * (by - ay), cx = ax + t * (bx - ax);
        const dLat = (lat - cy) * M_PER_DEG_LAT;
        const dLng = (lng - cx) * M_PER_DEG_LNG_LA;
        const d = dLat * dLat + dLng * dLng;
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
