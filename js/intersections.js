/**
 * intersections.js — LA Metro light-rail at-grade crossings lookup.
 *
 * Loads data/light-rail-intersections.json (263 points: gated + traffic-light)
 * and exposes a nearest-intersection query used by markers.js to disambiguate
 * "stopped at a real intersection" from "speed=0 due to GPS dropout in a
 * tunnel or elevated section."
 *
 * Fail-open: if the fetch fails (or hasn't completed yet), the index is empty
 * and isNearIntersection() returns false. Callers interpret that as "no
 * intersection evidence" — the DR fallback path runs. Bootstrapped from
 * main.js via loadIntersections().
 */

import { planarMeters } from './utils.js';
import { INTERSECTION_PROX_M } from './config.js';

const _points = [];   // {lat, lng, type, name}[] — flat array, linear scan
let _loadPromise = null;

function _index(points) {
    _points.length = 0;
    for (const p of points) {
        if (Number.isFinite(p?.lat) && Number.isFinite(p?.lng)) _points.push(p);
    }
}

/**
 * Fetch and index the intersections JSON. Returns a shared promise — safe to
 * call multiple times. A failed fetch leaves the index empty (fail-open).
 */
export function loadIntersections() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = fetch('./data/light-rail-intersections.json')
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(_index)
        .catch(err => console.warn('[intersections] Failed to load:', err));
    return _loadPromise;
}

/**
 * Distance (meters) to the nearest known light-rail at-grade crossing.
 * Linear scan over ~263 points — ~5 μs per call.
 */
export function nearestIntersectionM(lat, lng) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return Infinity;
    let best = Infinity;
    for (const p of _points) {
        const d = planarMeters(lat, lng, p.lat, p.lng);
        if (d < best) best = d;
    }
    return best;
}

/**
 * True if `(lat, lng)` is within `INTERSECTION_PROX_M` of an indexed crossing.
 * Returns false when the index is empty (fail-open).
 */
export function isNearIntersection(lat, lng) {
    return nearestIntersectionM(lat, lng) <= INTERSECTION_PROX_M;
}

// ── Test hooks ──────────────────────────────────────────────────────────────
export function _seedForTests(points) {
    _index(points);
    _loadPromise = Promise.resolve();
}

export function _resetForTests() {
    _points.length = 0;
    _loadPromise = null;
}
