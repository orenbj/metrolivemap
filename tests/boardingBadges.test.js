/**
 * Tests for js/boardingBadges.js exports — the boarding-badge slot layout
 * system (8-cardinal SLOTS table + zoom-aware sizing, the manual override
 * list for termini polyline geometry mis-aims, polyline-tangent-derived
 * placement, badge collision avoidance across alert/access/boarding, and
 * the boarding-pill accessible name + departure-countdown formatters).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { chooseBadgeSlots, resolveBoardingSlot, SLOTS, BOARDING_SLOT_OVERRIDES, slotConfig, bearingToSlot, resolveBoardingSlotFromPolyline, _formatDeparture, boardingBadgeScale, _entryHTML } from '../js/boardingBadges.js';
import { precomputeRoute, _clearShapeCache, shapeData } from '../js/snap.js';

// Loaded by loadShapes() in production; tests populate it manually because
// precomputeRoute() only fills arcLengths, not shapeData.
function _stubShape(code, pts) {
    shapeData[code] = pts;
    precomputeRoute(code, pts);
}

describe('_entryHTML — boarding pill accessible name', () => {
    it('names a rail route by its letter and includes the departure time', () => {
        const html = _entryHTML({ routeCode: '804', depLabel: '5 min' });
        expect(html).toContain('role="img"');
        expect(html).toContain('aria-label="E Line, departs 5 min"');
    });

    it('names a bus route by its number', () => {
        const html = _entryHTML({ routeCode: '720', depLabel: 'Now' });
        expect(html).toContain('aria-label="Line 720, departs Now"');
    });

    it('degrades gracefully when the departure label is missing', () => {
        const html = _entryHTML({ routeCode: '801', depLabel: '' });
        expect(html).toContain('aria-label="A Line, departure time unavailable"');
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

    it('places alert + access opposite the boarding badge for every slot direction', () => {
        // Generalised version of the earlier "24 combinations" test. The
        // boarding slot can now be any of the 8 cardinals (polyline-driven
        // placement returns the full set), and chooseBadgeSlots must never
        // double-book a slot — verified for all 32 active combinations.
        const allSlots = ['TL','T','TR','R','BR','B','BL','L'];
        for (const hasBoarding of [true, false]) {
            const boardingSlots = hasBoarding ? allSlots : ['TR'];
            for (const boardingSlot of boardingSlots) {
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

describe('resolveBoardingSlot (manual fallback)', () => {
    it('returns TR for stations not in the override list', () => {
        // Most rail termini now resolve via polyline geometry; the manual
        // list is reserved for bus-route termini (no shape data) plus a
        // couple of multi-terminus hubs where polyline-derived slot mis-aims.
        expect(resolveBoardingSlot('7th St / Metro Center')).toBe('TR');
        expect(resolveBoardingSlot('Downtown Santa Monica')).toBe('TR');   // now polyline-driven
        expect(resolveBoardingSlot('')).toBe('TR');
        expect(resolveBoardingSlot(undefined)).toBe('TR');
    });

    it('resolves the bus-only J-Line termini that have no shape data', () => {
        expect(resolveBoardingSlot('Harbor Gateway Transit Center')).toBe('B');
        expect(resolveBoardingSlot('San Pedro')).toBe('B');
        expect(resolveBoardingSlot('El Monte Station')).toBe('R');
    });

    it('resolves G-Line bus-only termini', () => {
        expect(resolveBoardingSlot('Chatsworth')).toBe('L');
        expect(resolveBoardingSlot('North Hollywood')).toBe('R');  // B/G terminus — east of station
    });

    it('overrides hub-terminus slots that polyline geometry mis-aims', () => {
        expect(resolveBoardingSlot('Union Station')).toBe('R');     // multi-line east terminus
        expect(resolveBoardingSlot('LAX/Metro Transit Center')).toBe('L');  // K/C west terminus
        expect(resolveBoardingSlot('Downtown Long Beach')).toBe('B'); // A south terminus
        expect(resolveBoardingSlot('Atlantic')).toBe('R');          // E east terminus — line curves in, force east
    });

    it('matches case-insensitively against a lowercased substring', () => {
        expect(resolveBoardingSlot('CHATSWORTH STATION')).toBe('L');
        expect(resolveBoardingSlot('Some El Monte busway stop')).toBe('R');
        expect(resolveBoardingSlot('Pomona Transit Center')).toBe('R');
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

    it('only uses cardinal-edge slots as overrides (never the TR default)', () => {
        // L/R/B/T are cardinal-edge slots; TR/TL/BL/BR are diagonal default
        // territory. The override list is reserved for placements that the
        // polyline-tangent algorithm can't reach (bus routes, hub termini).
        for (const o of BOARDING_SLOT_OVERRIDES) {
            expect(['L', 'R', 'B', 'T']).toContain(o.slot);
        }
    });
});

describe('slotConfig (zoom-aware offset)', () => {
    it('scales the offset linearly with the px argument while keeping anchor stable', () => {
        const small = slotConfig('TR', 14);
        const big   = slotConfig('TR', 22);
        expect(small.anchor).toBe('bottom-left');
        expect(big.anchor).toBe('bottom-left');
        expect(small.offset).toEqual([14, -14]);
        expect(big.offset).toEqual([22, -22]);
    });

    it('uses zero on the perpendicular axis for the 4 edge slots', () => {
        expect(slotConfig('T', 20).offset).toEqual([0, -20]);
        expect(slotConfig('R', 20).offset).toEqual([20, 0]);
        expect(slotConfig('B', 20).offset).toEqual([0, 20]);
        expect(slotConfig('L', 20).offset).toEqual([-20, 0]);
    });

    it('returns null for unknown slot keys', () => {
        expect(slotConfig('XX', 14)).toBeNull();
    });
});

describe('boardingBadgeScale (zoom-aware pill size)', () => {
    it('is full size (1.0) at and above the high-zoom cap', () => {
        expect(boardingBadgeScale(15)).toBeCloseTo(1, 5);
        expect(boardingBadgeScale(18)).toBeCloseTo(1, 5);  // clamped, never grows past 1
    });

    it('sits at the minimum scale at and below the badge min-zoom', () => {
        expect(boardingBadgeScale(9)).toBeCloseTo(0.7, 5);
        expect(boardingBadgeScale(5)).toBeCloseTo(0.7, 5);  // clamped, never below the floor
    });

    it('interpolates linearly between the floor and full size', () => {
        // Midpoint of zoom 9→15 is 12 → halfway between 0.7 and 1.0 = 0.85.
        expect(boardingBadgeScale(12)).toBeCloseTo(0.85, 5);
    });

    it('never shrinks below the floor or grows above 1 across the zoom range', () => {
        for (let z = 0; z <= 22; z += 0.5) {
            const s = boardingBadgeScale(z);
            expect(s).toBeGreaterThanOrEqual(0.7);
            expect(s).toBeLessThanOrEqual(1);
        }
    });
});

describe('bearingToSlot', () => {
    it('maps each of the 8 cardinal bearings to the matching slot', () => {
        // 0° = north → badge should be ABOVE the dot → slot T
        expect(bearingToSlot(0)).toBe('T');
        expect(bearingToSlot(45)).toBe('TR');
        expect(bearingToSlot(90)).toBe('R');
        expect(bearingToSlot(135)).toBe('BR');
        expect(bearingToSlot(180)).toBe('B');
        expect(bearingToSlot(225)).toBe('BL');
        expect(bearingToSlot(270)).toBe('L');
        expect(bearingToSlot(315)).toBe('TL');
    });

    it('snaps an off-axis bearing to the nearest of the 8 buckets', () => {
        expect(bearingToSlot(10)).toBe('T');      // closer to N than NE
        expect(bearingToSlot(35)).toBe('TR');     // closer to NE than N
        expect(bearingToSlot(89)).toBe('R');      // just east of NE-E boundary
        expect(bearingToSlot(193)).toBe('B');     // just south of S
    });

    it('normalises negative bearings into [0, 360)', () => {
        expect(bearingToSlot(-90)).toBe('L');     // -90 ≡ 270
        expect(bearingToSlot(-45)).toBe('TL');    // -45 ≡ 315
    });

    it('handles 360-wraparound by mod-360', () => {
        expect(bearingToSlot(360)).toBe('T');
        expect(bearingToSlot(720)).toBe('T');
        expect(bearingToSlot(450)).toBe('R');     // 450 mod 360 = 90 → R
    });

    it('returns null for non-finite input', () => {
        expect(bearingToSlot(null)).toBeNull();
        expect(bearingToSlot(undefined)).toBeNull();
        expect(bearingToSlot(NaN)).toBeNull();
        expect(bearingToSlot(Infinity)).toBeNull();
    });
});

describe('resolveBoardingSlotFromPolyline', () => {
    // Build a synthetic east-west polyline ending at Santa Monica-ish
    // coords. The terminus is at the EAST end; polyline extends west.
    // (Note: tests use realistic lat/lng so planarMeters / bearing math
    // behave like production.)
    const SM_LAT = 34.04;
    const SM_LNG = -118.50;
    beforeAll(() => {
        _clearShapeCache();
        // Line ends at SM, comes in from the east. The terminus is the LAST point.
        // West-of-SM points → polyline extends WEST of the terminus.
        _stubShape('801-test', [
            [SM_LAT, SM_LNG - 0.02],  // 2 km west
            [SM_LAT, SM_LNG - 0.01],  // 1 km west
            [SM_LAT, SM_LNG - 0.005], // 0.5 km west
            [SM_LAT, SM_LNG],         // SM (last point)
        ]);
        // North-south line ending at a southern terminus (line approaches
        // from the north). Polyline extends NORTH from terminus.
        _stubShape('804-test', [
            [34.20, -118.25],
            [34.15, -118.25],
            [34.10, -118.25],
            [34.05, -118.25],        // terminus (last point, southern end)
        ]);
    });

    it('places badge OPPOSITE the polyline direction for a west-terminus', () => {
        // Polyline extends WEST from SM terminus → badge should be on the EAST side.
        const slot = resolveBoardingSlotFromPolyline('801-test', SM_LAT, SM_LNG);
        // Polyline bearing FROM terminus TO probe ≈ 270° (W);
        // badge sits at OPPOSITE = 90° (E) → slot R.
        expect(slot).toBe('R');
    });

    it('places badge OPPOSITE the polyline direction for a south-terminus', () => {
        // Polyline extends NORTH from terminus → badge sits on the SOUTH side.
        const slot = resolveBoardingSlotFromPolyline('804-test', 34.05, -118.25);
        expect(slot).toBe('B');
    });

    it('returns null when the route has no shape data', () => {
        expect(resolveBoardingSlotFromPolyline('999-no-shape', 34.0, -118.0)).toBeNull();
    });

    it('returns null for missing route code', () => {
        expect(resolveBoardingSlotFromPolyline('', 34.0, -118.0)).toBeNull();
        expect(resolveBoardingSlotFromPolyline(null, 34.0, -118.0)).toBeNull();
    });
});


describe('_formatDeparture', () => {
    const NOW = 1_700_000_000;

    it('null departureUnix → empty string', () => {
        expect(_formatDeparture(null, NOW)).toBe('');
    });

    it('departing now / overdue → "Now"', () => {
        expect(_formatDeparture(NOW, NOW)).toBe('Now');
        expect(_formatDeparture(NOW - 30, NOW)).toBe('Now');
    });

    it('20s out → "<1m" (no longer "Now")', () => {
        expect(_formatDeparture(NOW + 20, NOW)).toBe('<1m');
    });

    it('59s out → "<1m"', () => {
        expect(_formatDeparture(NOW + 59, NOW)).toBe('<1m');
    });

    it('120s out → "2m"', () => {
        expect(_formatDeparture(NOW + 120, NOW)).toBe('2m');
    });
});
