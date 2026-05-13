/**
 * Tests for js/stations.js exports — currently just compute8Cardinal, the pure
 * helper that powers the "Nearby buses" direction suffix. Other stations.js
 * surface area (popup rendering, station merging) is exercised end-to-end via
 * the live app rather than unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { compute8Cardinal, chooseBadgeSlots, resolveBoardingSlot, SLOTS, BOARDING_SLOT_OVERRIDES } from '../js/stations.js';

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

describe('chooseBadgeSlots', () => {
    it('places alert + access on the left when no boarding badge is present', () => {
        const slots = chooseBadgeSlots({ hasBoarding: false, hasAlert: true, hasAccess: true });
        expect(slots).toEqual({ alert: 'TL', access: 'BL' });
    });

    it('places alert TL, access BL for default boarding (TR)', () => {
        const slots = chooseBadgeSlots({ hasBoarding: true, boardingSlot: 'TR', hasAlert: true, hasAccess: true });
        expect(slots).toEqual({ boarding: 'TR', alert: 'TL', access: 'BL' });
    });

    it('pushes alert + access to the right corners when boarding is forced left', () => {
        const slots = chooseBadgeSlots({ hasBoarding: true, boardingSlot: 'L', hasAlert: true, hasAccess: true });
        expect(slots).toEqual({ boarding: 'L', alert: 'TR', access: 'BR' });
    });

    it('keeps alert + access along the top when boarding is forced below', () => {
        const slots = chooseBadgeSlots({ hasBoarding: true, boardingSlot: 'B', hasAlert: true, hasAccess: true });
        expect(slots).toEqual({ boarding: 'B', alert: 'TL', access: 'TR' });
    });

    it('omits absent badges (alert only)', () => {
        const slots = chooseBadgeSlots({ hasBoarding: false, hasAlert: true, hasAccess: false });
        expect(slots).toEqual({ alert: 'TL' });
    });

    it('omits absent badges (access only)', () => {
        const slots = chooseBadgeSlots({ hasBoarding: false, hasAlert: false, hasAccess: true });
        expect(slots).toEqual({ access: 'BL' });
    });

    it('omits absent badges (boarding only)', () => {
        const slots = chooseBadgeSlots({ hasBoarding: true, boardingSlot: 'TR', hasAlert: false, hasAccess: false });
        expect(slots).toEqual({ boarding: 'TR' });
    });

    it('never assigns the same slot to two badges across all 24 active combinations', () => {
        for (const hasBoarding of [true, false]) {
            for (const boardingSlot of ['TR', 'L', 'B']) {
                for (const hasAlert of [true, false]) {
                    for (const hasAccess of [true, false]) {
                        const slots = chooseBadgeSlots({ hasBoarding, boardingSlot, hasAlert, hasAccess });
                        const used = Object.values(slots);
                        expect(new Set(used).size).toBe(used.length);
                    }
                }
            }
        }
    });
});

describe('resolveBoardingSlot', () => {
    it('returns TR for stations not in the override list', () => {
        expect(resolveBoardingSlot('Union Station')).toBe('TR');
        expect(resolveBoardingSlot('7th St / Metro Center')).toBe('TR');
        expect(resolveBoardingSlot('')).toBe('TR');
        expect(resolveBoardingSlot(undefined)).toBe('TR');
    });

    it('resolves the original left-anchored termini to L', () => {
        expect(resolveBoardingSlot('Downtown Santa Monica')).toBe('L');
        expect(resolveBoardingSlot('LAX/Metro Transit Center')).toBe('L');
        expect(resolveBoardingSlot('Aviation/LAX')).toBe('L');
        expect(resolveBoardingSlot('La Cienega/Jefferson')).toBe('L');
        expect(resolveBoardingSlot('Chatsworth')).toBe('L');
    });

    it('resolves the original below-anchored termini to B', () => {
        expect(resolveBoardingSlot('Redondo Beach')).toBe('B');
        expect(resolveBoardingSlot('Downtown Long Beach')).toBe('B');
        expect(resolveBoardingSlot('Harbor Gateway Transit Center')).toBe('B');
        expect(resolveBoardingSlot('San Pedro')).toBe('B');
    });

    it('resolves the newly-added termini', () => {
        expect(resolveBoardingSlot('Norwalk')).toBe('B');
        expect(resolveBoardingSlot('North Hollywood')).toBe('B');
        expect(resolveBoardingSlot('Atlantic Station')).toBe('L');
        expect(resolveBoardingSlot('El Monte Station')).toBe('L');
    });

    it('matches case-insensitively against the lowercased substring', () => {
        expect(resolveBoardingSlot('SANTA MONICA TERMINUS')).toBe('L');
        expect(resolveBoardingSlot('Some El Monte busway stop')).toBe('L');
    });
});

describe('SLOTS table', () => {
    it('defines all eight cardinal slots used by the layout function', () => {
        expect(Object.keys(SLOTS).sort()).toEqual(['B', 'BL', 'BR', 'L', 'R', 'T', 'TL', 'TR']);
    });

    it('places each badge in the visually-expected quadrant', () => {
        // anchor:'bottom-left' + positive offset → badge sits upper-right of dot
        expect(SLOTS.TR.anchor).toBe('bottom-left');
        expect(SLOTS.TR.offset[0]).toBeGreaterThan(0);  // right
        expect(SLOTS.TR.offset[1]).toBeLessThan(0);     // up

        // anchor:'bottom-right' + negative offset → badge sits upper-left
        expect(SLOTS.TL.anchor).toBe('bottom-right');
        expect(SLOTS.TL.offset[0]).toBeLessThan(0);
        expect(SLOTS.TL.offset[1]).toBeLessThan(0);

        // anchor:'top-right' + offsets → badge sits lower-left
        expect(SLOTS.BL.anchor).toBe('top-right');
        expect(SLOTS.BL.offset[0]).toBeLessThan(0);
        expect(SLOTS.BL.offset[1]).toBeGreaterThan(0);

        // anchor:'top-left' + offsets → badge sits lower-right
        expect(SLOTS.BR.anchor).toBe('top-left');
        expect(SLOTS.BR.offset[0]).toBeGreaterThan(0);
        expect(SLOTS.BR.offset[1]).toBeGreaterThan(0);

        // Edge slots: L (left-mid), R (right-mid), T (above), B (below)
        expect(SLOTS.L.anchor).toBe('right');
        expect(SLOTS.L.offset[0]).toBeLessThan(0);
        expect(SLOTS.B.anchor).toBe('top');
        expect(SLOTS.B.offset[1]).toBeGreaterThan(0);
    });

    it('uses a consistent offset magnitude across all corners', () => {
        const mag = Math.abs(SLOTS.TR.offset[0]);
        expect(mag).toBeGreaterThan(0);
        for (const slot of Object.values(SLOTS)) {
            for (const v of slot.offset) {
                if (v !== 0) expect(Math.abs(v)).toBe(mag);
            }
        }
    });
});

describe('BOARDING_SLOT_OVERRIDES', () => {
    it('only references slot keys that exist in SLOTS', () => {
        for (const o of BOARDING_SLOT_OVERRIDES) {
            expect(SLOTS).toHaveProperty(o.slot);
        }
    });

    it('only uses L or B as override slots (never TR — that is the default)', () => {
        for (const o of BOARDING_SLOT_OVERRIDES) {
            expect(['L', 'B']).toContain(o.slot);
        }
    });
});
