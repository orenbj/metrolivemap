/**
 * Back-computing a terminus departure from a downstream live prediction.
 *
 * Reported: a terminus row read "—" while the next stop down the line showed
 * real ETAs for the same trains — and no vehicle icon was visible between the
 * two stations, so those trains had not simply "already left". That points at
 * masterArrivalsData being EMPTY at the terminus while the next stop is
 * populated: Metro's trip_updates does not reliably carry a stop_time_update
 * for a trip's first stop before its train pulls out.
 *
 * getDerivedOriginDepartures reconstructs it using only DIFFERENCES inside one
 * trip's own scheduledTimes:
 *
 *     departure(origin) ≈ livePrediction(stop k) − (schedTime[k] − schedTime[0])
 *
 * Using a difference (not an absolute timetable lookup) means no service-date
 * base is needed — nothing to get wrong around midnight, DST, or owl trips —
 * and anchoring to a LIVE prediction makes the answer inherit the delay that
 * trip is actually running.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/snap.js', () => ({
    snapToRoute: () => null, hasShapeData: () => false, resolveShapeKey: () => null,
}));
vi.mock('../js/tripUpdates.js', () => ({ tripTerminusByTripId: new Map() }));

import { initPredictions, getDerivedOriginDepartures } from '../js/predictions.js';

const NOW = 1_700_000_000;
// E Line eastbound: DTSM (origin) → 17th St → 26th St. Scheduled 120 s DTSM→17th.
const ORIGIN = '80139', NEXT = '80138', THIRD = '80137';

function seedTrips(extra = {}) {
    globalThis.window = globalThis.window || {};
    window.masterStopsData = {};
    window.masterTripsData = {
        // Longest trip defines the 804|0 route cache.
        full: { rc: '804', dir: 0, dest: 'Atlantic',
                stops: [ORIGIN, NEXT, THIRD], scheduledTimes: [0, 120, 300] },
        ...extra,
    };
    initPredictions();
}

beforeEach(() => { window.masterArrivalsData = new Map(); });

describe('getDerivedOriginDepartures', () => {
    it('derives the terminus departure from the next stop\'s live arrival', () => {
        seedTrips();
        // Train predicted at 17th St in 21 min; scheduled hop is 2 min, so it
        // must leave DTSM in ~19 min — the number the terminus showed as "—".
        // (Real data: the 804|0 DTSM->17th hop is 180 s; 120 s here keeps the
        // fixture arithmetic obvious. Verified against data/trips.json.)
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 21 * 60, lastIngestUnix: NOW },
        ]);
        const out = getDerivedOriginDepartures([ORIGIN], '804', 0, NOW);
        expect(out).toHaveLength(1);
        expect(out[0].departureUnix).toBe(NOW + 21 * 60 - 120);
        expect(out[0].derived).toBe(true);
    });

    it('inherits the trip\'s real delay (anchored to live, not to the timetable)', () => {
        seedTrips();
        // Same trip running 10 min late: the derived departure moves with it.
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 31 * 60, lastIngestUnix: NOW },
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)[0].departureUnix)
            .toBe(NOW + 31 * 60 - 120);
    });

    it('uses the TRIP\'s own scheduledTimes, not the route cache\'s representative trip', () => {
        // An express whose first hop is 60 s, against the cache's 120 s.
        seedTrips({ exp: { rc: '804', dir: 0, dest: 'Atlantic',
                           stops: [ORIGIN, NEXT], scheduledTimes: [0, 60] } });
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'exp', arrivalUnix: NOW + 600, lastIngestUnix: NOW },
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)[0].departureUnix)
            .toBe(NOW + 600 - 60);
    });

    it('skips trips that do not START at this origin (a short-turn passing through)', () => {
        seedTrips({ shortTurn: { rc: '804', dir: 0, dest: 'Atlantic',
                                 stops: [NEXT, THIRD], scheduledTimes: [0, 180] } });
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'shortTurn', arrivalUnix: NOW + 300, lastIngestUnix: NOW },
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)).toEqual([]);
    });

    it('skips stale predictions', () => {
        seedTrips();
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 1200, lastIngestUnix: NOW - 9999 },
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)).toEqual([]);
    });

    it('drops a derived departure already in the past', () => {
        seedTrips();
        // Arrival 30 s out minus a 120 s hop → departed ~90 s ago.
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 30, lastIngestUnix: NOW },
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)).toEqual([]);
    });

    it('returns nothing when the requested group is not the origin', () => {
        seedTrips();
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 1200, lastIngestUnix: NOW },
        ]);
        expect(getDerivedOriginDepartures([NEXT], '804', 0, NOW)).toEqual([]);
    });

    it('dedupes a trip predicted at several downstream stops, keeping one departure', () => {
        seedTrips();
        window.masterArrivalsData.set(NEXT,  [{ tripId: 'full', arrivalUnix: NOW + 1200, lastIngestUnix: NOW }]);
        window.masterArrivalsData.set(THIRD, [{ tripId: 'full', arrivalUnix: NOW + 1380, lastIngestUnix: NOW }]);
        const out = getDerivedOriginDepartures([ORIGIN], '804', 0, NOW);
        expect(out).toHaveLength(1);
        expect(out[0].departureUnix).toBe(NOW + 1200 - 120);   // nearest stop wins
    });

    it('sorts multiple derived departures soonest-first', () => {
        seedTrips({ later: { rc: '804', dir: 0, dest: 'Atlantic',
                             stops: [ORIGIN, NEXT, THIRD], scheduledTimes: [0, 120, 300] } });
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'later', arrivalUnix: NOW + 40 * 60, lastIngestUnix: NOW },
            { tripId: 'full',  arrivalUnix: NOW + 21 * 60, lastIngestUnix: NOW },
        ]);
        const out = getDerivedOriginDepartures([ORIGIN], '804', 0, NOW);
        expect(out.map(o => o.tripId)).toEqual(['full', 'later']);
    });
});

describe('getDerivedOriginDepartures — adversarial-review regressions', () => {
    it('does NOT leak another route sharing the same origin platform into this row', () => {
        // Real geometry, verified against data/trips.json: B Line 802|1 and D
        // Line 805|1 BOTH originate at Union Station (stop 80214). A stop-
        // sequence test alone therefore cannot separate them, and the D Line
        // train would have rendered under "B Line → North Hollywood".
        globalThis.window = globalThis.window || {};
        window.masterStopsData = {};
        window.masterTripsData = {
            bTrip: { rc: '802', dir: 1, dest: 'North Hollywood',
                     stops: ['80214', '80213'], scheduledTimes: [0, 120] },
            dTrip: { rc: '805', dir: 1, dest: 'Wilshire / La Cienega',
                     stops: ['80214', '80213'], scheduledTimes: [0, 120] },
        };
        initPredictions();
        window.masterArrivalsData = new Map([
            ['80213', [{ tripId: 'dTrip', arrivalUnix: NOW + 900, lastIngestUnix: NOW }]],
        ]);
        // Asking for the B Line row must not return the D Line's trip.
        expect(getDerivedOriginDepartures(['80214'], '802', 1, NOW)).toEqual([]);
        // …and the D Line's own row still resolves it.
        expect(getDerivedOriginDepartures(['80214'], '805', 1, NOW).map(o => o.tripId))
            .toEqual(['dTrip']);
    });

    it('does NOT invent a departure for a train already past the first stop', () => {
        // A trip predicted at stop 2 but NOT stop 1 has already passed stop 1,
        // so it has left the terminus. Back-computing from stop 2 would show a
        // future departure for a train that is gone.
        seedTrips();
        window.masterArrivalsData.set(THIRD, [
            { tripId: 'full', arrivalUnix: NOW + 1200, lastIngestUnix: NOW },
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)).toEqual([]);
    });

    it('does NOT render "Now" for a train that pulled out seconds ago', () => {
        // Derived departure lands just inside the 60 s past-grace that a REAL
        // feed entry would keep. An estimate that says "Now" tells a rider on
        // the platform to board a train that has already left.
        seedTrips();
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 70, lastIngestUnix: NOW },  // → NOW-50
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)).toEqual([]);
    });

    it('accepts a departure exactly at now', () => {
        seedTrips();
        window.masterArrivalsData.set(NEXT, [
            { tripId: 'full', arrivalUnix: NOW + 120, lastIngestUnix: NOW },  // → NOW
        ]);
        expect(getDerivedOriginDepartures([ORIGIN], '804', 0, NOW)[0].departureUnix).toBe(NOW);
    });
});
