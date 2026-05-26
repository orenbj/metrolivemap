import { describe, it, expect } from 'vitest';
import { _preserveActiveTrips } from '../js/serviceDate.js';

// Helper: shape a minimal marker the way main.js / markers.js produce them.
const marker = tripId => ({ properties: { trip_id: tripId } });

describe('_preserveActiveTrips — cross-midnight owl trip preservation', () => {
    it('preserves a tripId active on the map but missing from new trips', () => {
        const oldTrips = { 'OWL-A-1': { rc: '801', dir: 0, stops: ['S0','S1'] } };
        const newTrips = { 'TR-MORNING-1': { rc: '801', dir: 0, stops: ['S0','S1'] } };
        const markers  = { 'OWL-A-1': marker('OWL-A-1') };

        const preserved = _preserveActiveTrips(oldTrips, newTrips, markers);

        expect(preserved).toBe(1);
        expect(newTrips['OWL-A-1']).toBeDefined();
        expect(newTrips['OWL-A-1'].rc).toBe('801');
        // New trip untouched.
        expect(newTrips['TR-MORNING-1']).toBeDefined();
    });

    it('does NOT overwrite a tripId that exists in the new trips (safety against recycling)', () => {
        const oldTrips = { 'TR-1': { rc: '801', dir: 0, stops: ['OLD'] } };
        const newTrips = { 'TR-1': { rc: '801', dir: 0, stops: ['NEW'] } };
        const markers  = { 'TR-1': marker('TR-1') };

        const preserved = _preserveActiveTrips(oldTrips, newTrips, markers);

        expect(preserved).toBe(0);
        expect(newTrips['TR-1'].stops).toEqual(['NEW']);
    });

    it('skips markers whose trip_id is missing from BOTH old and new trips', () => {
        // A stale marker referencing a vanished trip — nothing to preserve.
        const oldTrips = {};
        const newTrips = { 'TR-NEW': { rc: '801', dir: 0 } };
        const markers  = { 'STALE': marker('STALE') };

        const preserved = _preserveActiveTrips(oldTrips, newTrips, markers);

        expect(preserved).toBe(0);
        expect(newTrips['STALE']).toBeUndefined();
    });

    it('handles multiple active owl trips simultaneously', () => {
        const oldTrips = {
            'OWL-A-1': { rc: '801', dir: 0 },
            'OWL-E-1': { rc: '805', dir: 1 },
            'INACTIVE': { rc: '807', dir: 0 },   // not active on map, must NOT be preserved
        };
        const newTrips = {};
        const markers = {
            'OWL-A-1': marker('OWL-A-1'),
            'OWL-E-1': marker('OWL-E-1'),
        };

        const preserved = _preserveActiveTrips(oldTrips, newTrips, markers);

        expect(preserved).toBe(2);
        expect(newTrips['OWL-A-1']).toBeDefined();
        expect(newTrips['OWL-E-1']).toBeDefined();
        expect(newTrips['INACTIVE']).toBeUndefined();
    });

    it('ignores markers with missing/null trip_id', () => {
        const oldTrips = { 'OWL-1': { rc: '801' } };
        const newTrips = {};
        const markers = {
            'OWL-1': marker('OWL-1'),
            'BROKEN': { properties: {} },
            'ALSO_BROKEN': { properties: { trip_id: null } },
            'NO_PROPS': {},
        };

        const preserved = _preserveActiveTrips(oldTrips, newTrips, markers);

        expect(preserved).toBe(1);
        expect(newTrips['OWL-1']).toBeDefined();
    });

    it('returns 0 when any argument is null/undefined (defensive)', () => {
        expect(_preserveActiveTrips(null, {}, {})).toBe(0);
        expect(_preserveActiveTrips({}, null, {})).toBe(0);
        expect(_preserveActiveTrips({}, {}, null)).toBe(0);
    });

    it('coerces numeric tripIds via String() to match marker.properties.trip_id form', () => {
        // CLAUDE.md documents that vehicle_id / trip_id / stopId / route_code
        // are String-cast at the api.js boundary, but tests should cover the
        // defensive path here in case a future regression slips a number
        // through.
        const oldTrips = { '64297706': { rc: '804', dir: 1 } };
        const newTrips = {};
        const markers  = { 'OWL': { properties: { trip_id: 64297706 } } };

        const preserved = _preserveActiveTrips(oldTrips, newTrips, markers);

        expect(preserved).toBe(1);
        expect(newTrips['64297706']).toBeDefined();
    });
});
