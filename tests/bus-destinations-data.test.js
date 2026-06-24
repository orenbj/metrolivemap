import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Contract test for the SHIPPED data/bus-destinations.json. The runtime
// (resolveBusDestination) matches these keys against the live feed's
// splitRouteId(routeId) — a bare numeric code — plus a literal direction 0/1.
// If a future GTFS rebuild changes the bus route_code shape or drops
// direction_id, the keys silently stop matching and the nearby-bus labels
// revert to the terminus-stop fallback with NO runtime error. These assertions
// fail the build instead, surfacing the regression in the weekly-rebuild PR.
const map = JSON.parse(readFileSync(
    join(process.cwd(), 'data', 'bus-destinations.json'), 'utf8'));

describe('data/bus-destinations.json contract', () => {
    it('has the expected top-level shape', () => {
        expect(Array.isArray(map.dests)).toBe(true);
        expect(typeof map.byRouteDir).toBe('object');
        expect(typeof map.byTrip).toBe('object');
    });

    it('destination strings are non-empty, unique, and single-line', () => {
        expect(map.dests.length).toBeGreaterThan(100);
        for (const d of map.dests) {
            expect(typeof d).toBe('string');
            expect(d.trim()).not.toBe('');
            expect(d.length).toBeLessThanOrEqual(80);
        }
        expect(new Set(map.dests).size).toBe(map.dests.length); // no dups
    });

    it('every byRouteDir key is `bareRoute|0|1` — the runtime match contract', () => {
        const keys = Object.keys(map.byRouteDir);
        expect(keys.length).toBeGreaterThan(100);
        for (const k of keys) {
            // bare numeric route + "|" + direction 0 or 1; NO suffix/prefix.
            expect(k).toMatch(/^\d+\|[01]$/);
        }
    });

    it('byTrip keys are non-empty trip ids', () => {
        for (const t of Object.keys(map.byTrip)) {
            expect(t.length).toBeGreaterThan(0);
            expect(/\d/.test(t)).toBe(true);
        }
    });

    it('every index points into dests (no dangling references)', () => {
        const N = map.dests.length;
        const valid = v => Number.isInteger(v) && v >= 0 && v < N;
        for (const v of Object.values(map.byRouteDir)) expect(valid(v)).toBe(true);
        for (const v of Object.values(map.byTrip))     expect(valid(v)).toBe(true);
    });
});
