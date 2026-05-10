/**
 * intersections.js — LA Metro light-rail at-grade crossings lookup.
 *
 * Loads data/light-rail-intersections.json (263 points: gated + traffic-light)
 * and exposes a fast nearest-intersection query used by markers.js to
 * disambiguate "stopped at a real intersection" from "speed=0 due to GPS
 * dropout in a tunnel or elevated section."
 *
 * Design:
 *   - Grid hash keyed by 0.01° bucket (~1.1 km cells). 263 points → ~10
 *     buckets average; nearest-point lookup checks the surrounding 9 buckets,
 *     <0.1 ms in practice.
 *   - Safe-default fallback: if data hasn't loaded yet (or fetch failed),
 *     isNearIntersection() returns false. Callers should interpret that as
 *     "no intersection evidence" — the DR fallback path will run.
 *   - Bootstrapped from main.js via loadIntersections().
 */

import { planarMeters } from './utils.js';
import { INTERSECTION_PROX_M } from './config.js';

const BUCKET_DEG = 0.01;          // ~1.1 km north-south
const _buckets   = new Map();     // key = "lat_idx:lng_idx" → array of {lat, lng, type, name}
let _loaded      = false;
let _loadPromise = null;

function _bucketKey(lat, lng) {
    return `${Math.floor(lat / BUCKET_DEG)}:${Math.floor(lng / BUCKET_DEG)}`;
}

function _index(points) {
    _buckets.clear();
    for (const p of points) {
        if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
        const k = _bucketKey(p.lat, p.lng);
        if (!_buckets.has(k)) _buckets.set(k, []);
        _buckets.get(k).push(p);
    }
    _loaded = true;
}

/**
 * Fetch and index the intersections JSON. Returns a shared promise — safe to
 * call multiple times. Failure leaves _loaded=false so isNearIntersection
 * returns false (fail-open to DR fallback).
 * @returns {Promise<void>}
 */
export function loadIntersections() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch('./data/light-rail-intersections.json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(_index)
        .catch(err => {
            console.warn('[intersections] Failed to load:', err);
        });
    return _loadPromise;
}

/**
 * Distance (meters) to the nearest known light-rail intersection point.
 * Returns Infinity if none indexed or if no point exists within the scanned
 * neighbourhood (3×3 buckets ≈ 3.3 km square — sufficient given typical
 * intersection density along Metro corridors).
 * @param {number} lat
 * @param {number} lng
 * @returns {number}
 */
export function nearestIntersectionM(lat, lng) {
    if (!_loaded || !Number.isFinite(lat) || !Number.isFinite(lng)) return Infinity;
    const li = Math.floor(lat / BUCKET_DEG);
    const gi = Math.floor(lng / BUCKET_DEG);
    let best = Infinity;
    for (let dl = -1; dl <= 1; dl++) {
        for (let dg = -1; dg <= 1; dg++) {
            const k = `${li + dl}:${gi + dg}`;
            const arr = _buckets.get(k);
            if (!arr) continue;
            for (const p of arr) {
                const d = planarMeters(lat, lng, p.lat, p.lng);
                if (d < best) best = d;
            }
        }
    }
    return best;
}

/**
 * Convenience: is the given position within INTERSECTION_PROX_M of an
 * indexed intersection point? Returns false when data hasn't loaded
 * (fail-open to DR fallback — see module docstring).
 * @param {number} lat
 * @param {number} lng
 * @returns {boolean}
 */
export function isNearIntersection(lat, lng) {
    return nearestIntersectionM(lat, lng) <= INTERSECTION_PROX_M;
}

/**
 * Test-only: synchronously seed the index from an array. Bypasses fetch.
 * @param {Array<{lat:number, lng:number, type?:string, name?:string}>} points
 */
export function _seedForTests(points) {
    _index(points);
    _loadPromise = Promise.resolve();
}

/**
 * Test-only: clear the index back to unloaded state.
 */
export function _resetForTests() {
    _buckets.clear();
    _loaded = false;
    _loadPromise = null;
}
