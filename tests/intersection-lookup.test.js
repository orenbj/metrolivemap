/**
 * Tests for js/intersections.js — the at-grade-crossing proximity lookup
 * that lets markers.js distinguish "stopped at a real intersection" from
 * "speed=0 due to GPS dropout in a tunnel or elevated section."
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    nearestIntersectionM,
    isNearIntersection,
    _seedForTests,
    _resetForTests,
} from '../js/intersections.js';
import { INTERSECTION_PROX_M } from '../js/config.js';

beforeEach(() => {
    _resetForTests();
});

describe('nearestIntersectionM', () => {
    it('returns Infinity when no data is loaded', () => {
        expect(nearestIntersectionM(34.05, -118.25)).toBe(Infinity);
    });

    it('returns Infinity for non-finite inputs', () => {
        _seedForTests([{ lat: 34.05, lng: -118.25, type: 'gated' }]);
        expect(nearestIntersectionM(NaN, -118.25)).toBe(Infinity);
        expect(nearestIntersectionM(34.05, NaN)).toBe(Infinity);
    });

    it('finds the nearest of two points', () => {
        _seedForTests([
            { name: 'A', lat: 34.000, lng: -118.250, type: 'gated' },
            { name: 'B', lat: 34.010, lng: -118.250, type: 'gated' },
        ]);
        // Query at lat 34.0095 (very near B) → distance ≈ planar(0.0005°) ≈ 55 m
        const d = nearestIntersectionM(34.0095, -118.250);
        expect(d).toBeGreaterThan(40);
        expect(d).toBeLessThan(70);
    });

    it('scans neighbouring buckets so a point near a bucket edge is still found', () => {
        // BUCKET_DEG = 0.01. A point at lat=34.005 sits in bucket row floor(3400.5)=3400.
        // A query at lat=34.0049999 sits in row 3400 too — same bucket, trivial.
        // But a query at lat=34.015 (row 3401) querying a point in row 3400 must
        // still find it via the 3×3 bucket scan.
        _seedForTests([
            { name: 'edge', lat: 34.0099, lng: -118.250, type: 'gated' },
        ]);
        const d = nearestIntersectionM(34.0101, -118.250); // ~22 m apart, different bucket
        expect(d).toBeLessThan(40);
    });

    it('returns Infinity for a query far from all indexed points', () => {
        _seedForTests([{ lat: 34.00, lng: -118.25, type: 'gated' }]);
        // 1° lat ≈ 111 km — well outside the 3×3 ≈ 3.3 km scan window
        const d = nearestIntersectionM(35.00, -118.25);
        expect(d).toBe(Infinity);
    });
});

describe('isNearIntersection', () => {
    it('returns false when no data is loaded (fail-open default)', () => {
        // markers.js relies on this: if the data file failed to fetch we want
        // the DR fallback path to run for light-rail speed=0, not a freeze.
        expect(isNearIntersection(34.05, -118.25)).toBe(false);
    });

    it('returns true within INTERSECTION_PROX_M', () => {
        _seedForTests([{ name: 'X', lat: 34.00, lng: -118.25, type: 'gated' }]);
        // Same point → distance 0 → near
        expect(isNearIntersection(34.00, -118.25)).toBe(true);
    });

    it('returns false beyond INTERSECTION_PROX_M', () => {
        _seedForTests([{ name: 'X', lat: 34.00, lng: -118.25, type: 'gated' }]);
        // Offset ~100 m north — well past 50 m threshold
        const farLat = 34.00 + 100 / 111_111;
        expect(isNearIntersection(farLat, -118.25)).toBe(false);
    });

    it('threshold matches INTERSECTION_PROX_M from config', () => {
        _seedForTests([{ name: 'X', lat: 34.00, lng: -118.25, type: 'gated' }]);
        const justInsideLat  = 34.00 + (INTERSECTION_PROX_M - 5) / 111_111;
        const justOutsideLat = 34.00 + (INTERSECTION_PROX_M + 5) / 111_111;
        expect(isNearIntersection(justInsideLat,  -118.25)).toBe(true);
        expect(isNearIntersection(justOutsideLat, -118.25)).toBe(false);
    });
});
