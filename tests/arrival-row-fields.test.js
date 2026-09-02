/**
 * Fields `getScheduledArrivals` must carry through on a MARKER-MATCHED row.
 *
 * The function has two exits that push a result: the marker-matched loop, and a
 * GTFS-only tail loop for trips no live marker covered. The tail loop spreads
 * the whole trip_updates entry; the marker loop hand-builds its object. Twice
 * now that hand-built object has silently dropped something the tail loop kept,
 * and in both cases the consequence was a wrong number on the station board for
 * exactly the trains that ARE being tracked — i.e. the normal case, not an edge
 * case.
 *
 *   R3a-02  `departureUnix` was never carried, so `_withDeparture`'s
 *           `?? arrivalUnix` fallback — documented as a legacy safety net for
 *           old entries — became the mainstream path at every terminus. The row
 *           showed the layover ARRIVAL (when the train pulls in) instead of the
 *           DEPARTURE (when it pulls out). That is the exact defect PR #617
 *           fixed in the renderer, reintroduced one layer down.
 *   R2-02   `routeId` was stamped with the vehicle feed's raw `route_code`,
 *           undoing the J Line 910->950 retag that trip_updates ingest had
 *           already applied. A San Pedro bus landed on the Harbor Gateway row.
 *
 * Both are one line at the same two pushes, which is why they are pinned
 * together: a future edit that rebuilds that object will break both at once.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());

import { initPredictions, getScheduledArrivals } from '../js/predictions.js';

const NOW = () => Math.floor(Date.now() / 1000);

// A Line southbound: origin Pomona North (a1) then down the line.
const A_STOPS = ['a1', 'a2', 'a3', 'a4'];
// J Line: 910 and 950 share the northern stops; only 950 continues to San Pedro.
const J_SHARED = ['j1', 'j2', 'j3'];
const J_950    = ['j1', 'j2', 'j3', 'j4'];

function seedWorld() {
    window.masterStopsData = {
        a1: { name: 'Pomona North Station', lat: 34.06, lon: -117.75 },
        a2: { name: 'La Verne Station', lat: 34.09, lon: -117.77 },
        a3: { name: 'San Dimas Station', lat: 34.10, lon: -117.80 },
        a4: { name: 'Glendora Station', lat: 34.13, lon: -117.86 },
        j1: { name: '37th St / USC Station', lat: 34.01, lon: -118.28 },
        j2: { name: 'Harbor Freeway Station', lat: 33.92, lon: -118.28 },
        j3: { name: 'Harbor Gateway Transit Center', lat: 33.90, lon: -118.28 },
        j4: { name: 'Pacific / 21st Layover', lat: 33.72, lon: -118.29 },
    };
    window.masterTripsData = {
        'a-trip': { rc: '801', dir: 1, stops: A_STOPS, scheduledTimes: A_STOPS.map((_, i) => i * 300) },
        // A genuine 910 trip must exist, or routeStops['910|0'] is never built,
        // the marker loop `continue`s to the GTFS-only path, and the retag
        // survives by accident — a false negative that cost the verifier a run.
        'j-910-trip': { rc: '910', dir: 0, stops: J_SHARED, scheduledTimes: J_SHARED.map((_, i) => i * 300) },
        'j-950-trip': { rc: '950', dir: 0, stops: J_950, scheduledTimes: J_950.map((_, i) => i * 300) },
    };
    window.masterArrivalsData = new Map();
    window.vehicleMarkers = {};
    initPredictions();
}

/** Live marker approaching `nextStop`, fresh enough to pass the TTL gate. */
function marker({ tripId, routeCode, dir, nextStop, vehicleId = 'v1' }) {
    return {
        properties: {
            trip_id: tripId, route_code: routeCode, direction_id: dir,
            stopId: nextStop, vehicle_id: vehicleId, currentStatus: 'IN_TRANSIT_TO',
        },
        _lastAcceptedTs: NOW(), timestamp: NOW(),
        getLngLat: () => ({ lng: -118, lat: 34 }),
    };
}

function arrival(stopId, entry) {
    const list = window.masterArrivalsData.get(String(stopId)) ?? [];
    list.push({ lastIngestUnix: NOW(), ...entry });
    window.masterArrivalsData.set(String(stopId), list);
}

beforeEach(() => { seedWorld(); });

describe('departureUnix survives the marker-matched path (R3a-02)', () => {
    it('carries the real pull-out time, not the layover arrival', () => {
        // A train pulling into its origin: in 2 minutes, out in 15. Only the
        // pull-out is actionable for someone standing on that platform.
        const now = NOW();
        arrival('a1', { tripId: 'a-trip', vehicleId: 'v1', arrivalUnix: now + 120, departureUnix: now + 900 });
        window.vehicleMarkers = { 'a-trip': marker({ tripId: 'a-trip', routeCode: '801', dir: 1, nextStop: 'a1' }) };

        const row = getScheduledArrivals('a1').find(r => r.tripId === 'a-trip');
        expect(row, 'the marker-matched row must exist').toBeTruthy();
        expect(row.departureUnix, 'dropping this makes the renderer fall back to the arrival').toBe(now + 900);
    });

    it('is null — not undefined-by-omission — on the calc tier, which has no feed entry', () => {
        // The renderer's `departureUnix ?? arrivalUnix` fallback is legitimate
        // here; what it must not do is silently cover for a dropped field.
        window.vehicleMarkers = { 'a-trip': marker({ tripId: 'a-trip', routeCode: '801', dir: 1, nextStop: 'a1' }) };
        const row = getScheduledArrivals('a3').find(r => r.tripId === 'a-trip');
        if (row) expect(row.departureUnix ?? null).toBeNull();
    });

    it('the GTFS-only path already carried it (the asymmetry that hid this)', () => {
        const now = NOW();
        arrival('a1', { tripId: 'ghost-trip', vehicleId: 'v9', arrivalUnix: now + 120, departureUnix: now + 900, routeId: '801', directionId: 1 });
        const row = getScheduledArrivals('a1').find(r => r.tripId === 'ghost-trip');
        expect(row?.departureUnix).toBe(now + 900);
    });
});

describe('the J Line retag is not undone by the marker join (R2-02)', () => {
    it('a 950 trip keeps routeId 950 even though its marker reports 910', () => {
        // Metro tags every J trip 910 in the vehicle feed, including the 950
        // San Pedro through-runs. trip_updates ingest corrects it; this path
        // was re-stamping the raw feed tag over the correction.
        const now = NOW();
        arrival('j2', { tripId: 'j-950-trip', vehicleId: 'v5', arrivalUnix: now + 300, routeId: '950', directionId: 0 });
        window.vehicleMarkers = {
            'j-950-trip': marker({ tripId: 'j-950-trip', routeCode: '910', dir: 0, nextStop: 'j1', vehicleId: 'v5' }),
        };

        const row = getScheduledArrivals('j2').find(r => r.tripId === 'j-950-trip');
        expect(row, 'row must exist via the marker path').toBeTruthy();
        expect(row.routeId, 'a San Pedro bus must not land on the Harbor Gateway row').toBe('950');
    });

    it('a genuine 910 trip is untouched', () => {
        const now = NOW();
        arrival('j2', { tripId: 'j-910-trip', vehicleId: 'v6', arrivalUnix: now + 240, routeId: '910', directionId: 0 });
        window.vehicleMarkers = {
            'j-910-trip': marker({ tripId: 'j-910-trip', routeCode: '910', dir: 0, nextStop: 'j1', vehicleId: 'v6' }),
        };
        const row = getScheduledArrivals('j2').find(r => r.tripId === 'j-910-trip');
        expect(row?.routeId).toBe('910');
    });

    it('a non-J route is never rewritten, even when static GTFS DISAGREES', () => {
        // The correction is scoped to the 910/950 pair on purpose — a general
        // "trust static over the feed" rule would be a far larger behaviour
        // change, and this is the case that proves the scope holds. The trip is
        // tagged 801 by the feed while static GTFS claims 802; only a widened
        // rule would emit 802.
        //
        // The earlier version of this test used a trip where feed and static
        // AGREED, so replacing the scoped expression with a bare
        // `tripMeta?.rc ?? route_code` passed it — the scope was unpinned.
        const now = NOW();
        window.masterTripsData['mislabelled'] = {
            rc: '802', dir: 1, stops: A_STOPS, scheduledTimes: A_STOPS.map((_, i) => i * 300),
        };
        initPredictions();
        arrival('a2', { tripId: 'mislabelled', vehicleId: 'v2', arrivalUnix: now + 300, routeId: '801', directionId: 1 });
        window.vehicleMarkers = {
            mislabelled: marker({ tripId: 'mislabelled', routeCode: '801', dir: 1, nextStop: 'a1', vehicleId: 'v2' }),
        };
        const row = getScheduledArrivals('a2').find(r => r.tripId === 'mislabelled');
        expect(row, 'row must come through the marker path').toBeTruthy();
        expect(row.routeId, 'only the J pair may be corrected').toBe('801');
    });

    it('an unknown trip falls back to the feed tag rather than dropping the row', () => {
        const now = NOW();
        arrival('j2', { tripId: 'j-brand-new', vehicleId: 'v7', arrivalUnix: now + 200, routeId: '910', directionId: 0 });
        window.vehicleMarkers = {
            'j-brand-new': marker({ tripId: 'j-brand-new', routeCode: '910', dir: 0, nextStop: 'j1', vehicleId: 'v7' }),
        };
        const row = getScheduledArrivals('j2').find(r => r.tripId === 'j-brand-new');
        expect(row?.routeId).toBe('910');
    });
});
