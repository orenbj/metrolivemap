/**
 * Regression for the "one train, two trip_ids" duplicate-marker bug.
 *
 * When the feed re-publishes a physical train under a NEW trip_id (terminus
 * turnaround OR a mid-route trip reassignment), the marker for the OLD trip_id
 * is a superseded duplicate. Previously it was only removed when the new fix
 * landed within TERMINUS_TURNAROUND_RADIUS_M (1 km) of the old marker — so a
 * far-apart duplicate (e.g. a D Line train whose trip_id changes in the tunnel
 * while the old fix is a station back) lingered as a second dot with the SAME
 * vehicle number, one fresh and one tens of seconds stale.
 *
 * _supersedeDuplicateTrip now fades the old marker on a real vehicle_id + same
 * route_code match regardless of distance (ids are unique within a mode), and
 * only after the new fix has cleared the cross-line / cold-start guards (so a
 * rejected mis-tag can't strand the legit marker).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { markers, _supersedeDuplicateTrip } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';

const FAR_A = [-118.30, 34.05];   // two positions well over the old 1 km radius apart
const FAR_B = [-118.20, 34.10];

beforeEach(() => {
    vi.useFakeTimers();             // _fadeOutAndRemove schedules a fade timeout
    for (const k in markers) delete markers[k];
});
afterEach(() => { for (const k in markers) delete markers[k]; vi.useRealTimers(); });

describe('_supersedeDuplicateTrip — one train under two trip_ids', () => {
    it('fades the far-apart old-trip marker for the same vehicle (the duplicate bug)', () => {
        markers['T1'] = makeMarker({ tripId: 'T1', vehicleId: 'V9', routeCode: '805', lngLat: FAR_A });
        const newFix = makeFeature({ tripId: 'T2', vehicleId: 'V9', routeCode: '805', lngLat: FAR_B });
        _supersedeDuplicateTrip(newFix, 'T2');
        expect(markers['T1']).toBeUndefined();   // superseded regardless of distance
    });

    it('does NOT touch a different vehicle_id', () => {
        markers['T1'] = makeMarker({ tripId: 'T1', vehicleId: 'V9', routeCode: '805', lngLat: FAR_A });
        _supersedeDuplicateTrip(makeFeature({ tripId: 'T2', vehicleId: 'OTHER', routeCode: '805', lngLat: FAR_B }), 'T2');
        expect(markers['T1']).toBeDefined();
    });

    it('does NOT touch a different route_code (cross-mode id collision)', () => {
        markers['T1'] = makeMarker({ tripId: 'T1', vehicleId: 'V9', routeCode: '805', lngLat: FAR_A });
        _supersedeDuplicateTrip(makeFeature({ tripId: 'T2', vehicleId: 'V9', routeCode: '901', lngLat: FAR_B }), 'T2');
        expect(markers['T1']).toBeDefined();
    });

    it('does nothing for an id-less feed frame (empty vehicle_id never fuses markers)', () => {
        markers['T1'] = makeMarker({ tripId: 'T1', vehicleId: '', routeCode: '805', lngLat: FAR_A });
        _supersedeDuplicateTrip(makeFeature({ tripId: 'T2', vehicleId: '', routeCode: '805', lngLat: FAR_B }), 'T2');
        expect(markers['T1']).toBeDefined();
    });
});
