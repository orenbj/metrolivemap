/**
 * Tests for js/stations.js exports — currently just compute8Cardinal, the pure
 * helper that powers the "Nearby buses" direction suffix. Other stations.js
 * surface area (popup rendering, station merging) is exercised end-to-end via
 * the live app rather than unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { compute8Cardinal } from '../js/stations.js';

// LA basin reference latitude — used so the cos(lat) longitude scaling kicks in
// like it does in production. At 34°N, 1° of longitude ≈ 83% of 1° of latitude
// in metres; the helper corrects for this internally.
const LAT = 34.05;
const LON = -118.25;

// One degree of latitude ≈ 111 km, so 0.01° ≈ 1.1 km — well outside the ~50 m
// null zone the helper applies for "too close to label".
const STEP = 0.01;

describe('compute8Cardinal', () => {
    it('returns N for a terminus due north', () => {
        expect(compute8Cardinal(LAT, LON, LAT + STEP, LON)).toBe('N');
    });

    it('returns S for a terminus due south', () => {
        expect(compute8Cardinal(LAT, LON, LAT - STEP, LON)).toBe('S');
    });

    it('returns E for a terminus due east', () => {
        expect(compute8Cardinal(LAT, LON, LAT, LON + STEP)).toBe('E');
    });

    it('returns W for a terminus due west', () => {
        expect(compute8Cardinal(LAT, LON, LAT, LON - STEP)).toBe('W');
    });

    it('returns NE for a terminus equally north and east (after cos-lat scaling)', () => {
        // dLat = +STEP, dLon scaled by cos(lat) ≈ 0.829 ⇒ supply dLon = STEP / cos(lat)
        // so that the cos-corrected magnitudes match.
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT + STEP, LON + dLonRaw)).toBe('NE');
    });

    it('returns SE for a terminus south + east', () => {
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT - STEP, LON + dLonRaw)).toBe('SE');
    });

    it('returns SW for a terminus south + west', () => {
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT - STEP, LON - dLonRaw)).toBe('SW');
    });

    it('returns NW for a terminus north + west', () => {
        const dLonRaw = STEP / Math.cos((LAT * Math.PI) / 180);
        expect(compute8Cardinal(LAT, LON, LAT + STEP, LON - dLonRaw)).toBe('NW');
    });

    it('classifies a westbound trip slightly south as W (the bug-class fix)', () => {
        // The old 4-bucket magnitude test would return Southbound here because
        // |dLat| in degrees is bigger than |dLon|, even though after the cos(lat)
        // scaling the eastbound component dominates. 8-bucket bearing classification
        // resolves it to the closer cardinal — W when dLon ≫ dLat in metres.
        // dLat = -0.002° (~ 220 m south), dLon = -0.02° unscaled (~ 1850 m west).
        expect(compute8Cardinal(LAT, LON, LAT - 0.002, LON - 0.02)).toBe('W');
    });

    it('returns null inside the ~50 m null zone (terminus too close)', () => {
        expect(compute8Cardinal(LAT, LON, LAT + 0.0001, LON + 0.0001)).toBeNull();
    });

    it('returns null when station coords are not finite', () => {
        expect(compute8Cardinal(NaN, LON, LAT + STEP, LON)).toBeNull();
        expect(compute8Cardinal(LAT, undefined, LAT + STEP, LON)).toBeNull();
    });

    it('returns null when terminus coords are not finite', () => {
        expect(compute8Cardinal(LAT, LON, NaN, LON)).toBeNull();
        expect(compute8Cardinal(LAT, LON, LAT + STEP, null)).toBeNull();
    });
});
