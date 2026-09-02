import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    // markers.js imports this for the marker accessible name (R6-02); a mock
    // missing it fails the module load, not the assertion.
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
    showToast:           vi.fn(),
    setConnectionStatus: vi.fn(),
    updateDataPanel:     vi.fn(),
    getPopupHTML:        vi.fn(() => ''),
    cleanDestination:    s => s,
    updateUpdateTime:    vi.fn(),
    initUI:              vi.fn(),
    removeLoadingScreen: vi.fn(),
}));

import { processUpdate, tripTerminusByTripId, pruneStaleArrivals, _purgeTripArrivals } from '../js/tripUpdates.js';
import { makeRawTripUpdate } from './_fixtures/markers.js';
import { resetGlobals } from './_helpers/globals.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    resetGlobals();
    tripTerminusByTripId.clear();
});

describe('processUpdate — validation', () => {
    it('ignores messages with no tripUpdate', () => {
        processUpdate({});
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores messages with empty stopTimeUpdate array', () => {
        processUpdate({ tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [] } });
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores stopTimeUpdate entries missing stopId', () => {
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ arrival: { time: NOW() + 60 } }],
        });
        processUpdate(msg);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores entries whose arrival time is clearly past (>PAST_ARRIVAL_GRACE_S)', () => {
        // 90 s ago — well past the 60 s grace window. The grace exists so a
        // vehicle the feed says arrived ~30 s ago (and may still be at the
        // platform) isn't dropped; tests must use a value beyond that.
        const past = NOW() - 90;
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: past } }],
        });
        processUpdate(msg);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores entries with arrivalUnix=0 (sentinel)', () => {
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: 0 } }],
        });
        processUpdate(msg);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('drops the entire trip when scheduleRelationship === CANCELED', () => {
        // A CANCELED trip is not running. Its stopTimeUpdate entries must
        // never land in masterArrivalsData — otherwise rider popups show an
        // ETA for a train that's been called off.
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: NOW() + 120 } }],
        });
        msg.tripUpdate.trip.scheduleRelationship = 'CANCELED';
        processUpdate(msg);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('omits individual stops with scheduleRelationship === SKIPPED while keeping siblings', () => {
        // SKIPPED on a stopTimeUpdate means the train will pass through that
        // stop without serving it. Rider must not see an arrival pill for it,
        // but the same trip's other stops (SCHEDULED) keep their pills.
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [
                { stopId: '80202', arrival: { time: NOW() + 120 }, scheduleRelationship: 'SKIPPED' },
                { stopId: '80303', arrival: { time: NOW() + 180 } },
            ],
        });
        processUpdate(msg);
        expect(window.masterArrivalsData.has('80202')).toBe(false);
        expect(window.masterArrivalsData.get('80303')).toHaveLength(1);
    });

    it('drops arrivals beyond MAX_ARRIVAL_HORIZON_S while keeping a normal near-future one', () => {
        // A feed glitch (or seconds/ms unit-mismatch that looks like a plausible
        // seconds value) could put an arrival hours out and never prune. The
        // symmetric upper-bound guard (mirror of api.js's future-frame gate) must
        // drop it; a normal minutes-out prediction is unaffected.
        const farFuture = NOW() + 5 * 60 * 60; // 5 h — past the 4 h horizon
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [
                { stopId: '80202', arrival: { time: farFuture } },
                { stopId: '80303', arrival: { time: NOW() + 180 } },
            ],
        });
        processUpdate(msg);
        expect(window.masterArrivalsData.has('80202')).toBe(false);
        expect(window.masterArrivalsData.get('80303')).toHaveLength(1);
    });

    it('keeps a stop with a garbage arrival but a valid departure (NaN no longer defeats the ?? fallback)', () => {
        // normalizeTimestamp(negative) → NaN, and `NaN ?? _dep` keeps NaN (?? only
        // catches null/undefined), so the old code dropped the WHOLE stop even
        // though it had a perfectly valid departure. arrivalUnix must fall back to
        // the departure instead.
        const dep = NOW() + 120;
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: -5 }, departure: { time: dep } }],
        });
        processUpdate(msg);
        expect(window.masterArrivalsData.has('80202')).toBe(true);
        const entry = window.masterArrivalsData.get('80202')[0];
        expect(entry.departureUnix).toBe(dep);
        expect(entry.arrivalUnix).toBe(dep);   // fell back to departure
    });
});

describe('processUpdate — CANCELED purges already-ingested arrivals', () => {
    it("removes a trip's earlier arrivals when it later flips to CANCELED", () => {
        // Frame 1 (SCHEDULED): the trip ingests arrivals at two downstream stops.
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [
                { stopId: '80202', arrival: { time: NOW() + 120 } },
                { stopId: '80303', arrival: { time: NOW() + 240 } },
            ],
        }), null);
        expect(window.masterArrivalsData.get('80202')).toHaveLength(1);
        expect(window.masterArrivalsData.get('80303')).toHaveLength(1);

        // Frame 2: the same trip flips to CANCELED (operator swap / pull). Its
        // phantom ETAs must be purged immediately, not linger at each downstream
        // stop until the predicted time individually passes.
        const cancel = makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [
                { stopId: '80202', arrival: { time: NOW() + 120 } },
                { stopId: '80303', arrival: { time: NOW() + 240 } },
            ],
        });
        cancel.tripUpdate.trip.scheduleRelationship = 'CANCELED';
        processUpdate(cancel);
        expect(window.masterArrivalsData.has('80202')).toBe(false);
        expect(window.masterArrivalsData.has('80303')).toBe(false);
    });

    it("purges only the canceled trip, keeping a sibling trip's arrival at the same stop", () => {
        const t = NOW() + 120;
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1', vehicleId: 'V1',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t } }],
        }), null);
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-2', vehicleId: 'V2',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t + 60 } }],
        }), null);
        expect(window.masterArrivalsData.get('80202')).toHaveLength(2);

        const cancel = makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t } }],
        });
        cancel.tripUpdate.trip.scheduleRelationship = 'CANCELED';
        processUpdate(cancel);
        const list = window.masterArrivalsData.get('80202');
        expect(list).toHaveLength(1);
        expect(list[0].tripId).toBe('TR-A-2');
    });

    it('does not throw on a CANCELED frame carrying no stopTimeUpdate', () => {
        // Real CANCELED frames frequently omit the stop list entirely — the
        // path must short-circuit safely (the staleness gate is the backstop).
        expect(() => processUpdate({
            tripUpdate: { trip: { tripId: 'TR-A-1', scheduleRelationship: 'CANCELED' } },
        })).not.toThrow();
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('_purgeTripArrivals is a no-op for an empty tripId', () => {
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: NOW() + 120 } }],
        }), null);
        _purgeTripArrivals('', [{ stopId: '80202' }]);
        expect(window.masterArrivalsData.get('80202')).toHaveLength(1);
    });
});

describe('processUpdate — upsert behavior', () => {
    it('inserts a new arrival entry for an empty stop', () => {
        const arrival = NOW() + 120;
        processUpdate(makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: arrival } }],
        }), null);
        const list = window.masterArrivalsData.get('80202');
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
            tripId: 'TR-A-1',
            routeId: '801',
            directionId: 0,
            vehicleId: 'V1',
            arrivalUnix: arrival,
        });
        expect(list[0].lastIngestUnix).toBeGreaterThan(0);
    });

    it('strips routeId suffix after dash (e.g. "801-Northbound" → "801")', () => {
        processUpdate(makeRawTripUpdate({
            routeId: '801-Northbound',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: NOW() + 60 } }],
        }), null);
        expect(window.masterArrivalsData.get('80202')[0].routeId).toBe('801');
    });

    it('corrects a 950 San Pedro trip mis-tagged 910 by the feed, using static GTFS', () => {
        // Metro tags every J Line trip 910; static GTFS knows this one is 950.
        window.masterTripsData = { 'JT-SP': { rc: '950', dir: 1 } };
        processUpdate(makeRawTripUpdate({
            tripId: 'JT-SP', routeId: '910', directionId: 1,
            stopTimeUpdates: [{ stopId: '2315', arrival: { time: NOW() + 600 } }],
        }), null);
        expect(window.masterArrivalsData.get('2315')[0].routeId).toBe('950');
    });

    it('leaves a genuine 910 trip as 910 (static agrees)', () => {
        window.masterTripsData = { 'JT-HG': { rc: '910', dir: 1 } };
        processUpdate(makeRawTripUpdate({
            tripId: 'JT-HG', routeId: '910', directionId: 1,
            stopTimeUpdates: [{ stopId: '2315', arrival: { time: NOW() + 600 } }],
        }), null);
        expect(window.masterArrivalsData.get('2315')[0].routeId).toBe('910');
    });

    it('falls back to the feed tag when the J trip is absent from static GTFS', () => {
        window.masterTripsData = {};
        processUpdate(makeRawTripUpdate({
            tripId: 'JT-UNKNOWN', routeId: '910', directionId: 1,
            stopTimeUpdates: [{ stopId: '2315', arrival: { time: NOW() + 600 } }],
        }), null);
        expect(window.masterArrivalsData.get('2315')[0].routeId).toBe('910');
    });

    it('never retags a non-J route even if static GTFS disagrees', () => {
        // Defensive: the correction is scoped to the 910<->950 pair only.
        window.masterTripsData = { 'TR-A-1': { rc: '802', dir: 0 } };
        processUpdate(makeRawTripUpdate({
            routeId: '801',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: NOW() + 60 } }],
        }), null);
        expect(window.masterArrivalsData.get('80202')[0].routeId).toBe('801');
    });

    it('updates an existing entry (same vehicleId+routeId) instead of duplicating', () => {
        const t1 = NOW() + 60;
        const t2 = NOW() + 90;
        processUpdate(makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t1 } }],
        }), null);
        processUpdate(makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t2 } }],
        }), null);
        const list = window.masterArrivalsData.get('80202');
        expect(list).toHaveLength(1);
        expect(list[0].arrivalUnix).toBe(t2);
    });

    it('appends a separate entry for a different vehicleId on the same stop', () => {
        const t = NOW() + 60;
        processUpdate(makeRawTripUpdate({
            vehicleId: 'V1',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t } }],
        }), null);
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-2', vehicleId: 'V2',
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: t + 30 } }],
        }), null);
        expect(window.masterArrivalsData.get('80202')).toHaveLength(2);
    });

    it('keeps a layover entry alive by departure when arrival is already past the grace window', () => {
        // First/layover stop: the train arrived 2 min ago (past the 60 s grace)
        // but its scheduled departure is still 5 min out. Liveness uses the LATER
        // of the two, so the entry survives the whole dwell rather than vanishing
        // mid-layover and blanking the boarding badge.
        const arr = NOW() - 120;
        const dep = NOW() + 300;
        processUpdate(makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: arr }, departure: { time: dep } }],
        }), null);
        const list = window.masterArrivalsData.get('80202');
        expect(list).toHaveLength(1);
        expect(list[0].departureUnix).toBe(dep);
    });

    it('prunes a layover entry once its departure is also past', () => {
        const arr = NOW() - 120;
        const dep = NOW() + 60;
        processUpdate(makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: arr }, departure: { time: dep } }],
        }), null);
        expect(window.masterArrivalsData.get('80202')).toHaveLength(1);
        // Past departure + grace: now correctly pruned (the liveness model agrees
        // between ingest and prune).
        pruneStaleArrivals(dep + 120);
        expect(window.masterArrivalsData.has('80202')).toBe(false);
    });

    it('falls back to departure.time when arrival.time is absent', () => {
        const t = NOW() + 90;
        processUpdate({
            tripUpdate: {
                trip: { tripId: 'TR-A-1', routeId: '801', directionId: 0 },
                vehicle: { id: 'V1' },
                stopTimeUpdate: [{ stopId: '80202', departure: { time: t } }],
            },
        }, null);
        expect(window.masterArrivalsData.get('80202')[0].arrivalUnix).toBe(t);
    });

    it('preserves directionId=null when feed omits it (does NOT default to 0)', () => {
        processUpdate({
            tripUpdate: {
                trip: { tripId: 'TR-A-1', routeId: '801' /* no directionId */ },
                vehicle: { id: 'V1' },
                stopTimeUpdate: [{ stopId: '80202', arrival: { time: NOW() + 60 } }],
            },
        }, null);
        expect(window.masterArrivalsData.get('80202')[0].directionId).toBeNull();
    });
});

describe('processUpdate — terminus tracking', () => {
    it('records the last stopTimeUpdate stopId as the trip terminus', () => {
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [
                { stopId: '80101', arrival: { time: NOW() + 30 } },
                { stopId: '80202', arrival: { time: NOW() + 90 } },
                { stopId: '80303', arrival: { time: NOW() + 180 } },
            ],
        }));
        expect(tripTerminusByTripId.get('TR-A-1')).toBe('80303');
    });

    it('does not register a terminus when tripId is empty', () => {
        processUpdate(makeRawTripUpdate({
            tripId: '',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 30 } }],
        }));
        expect(tripTerminusByTripId.size).toBe(0);
    });
});

describe('pruneStaleArrivals — bounded growth of tripTerminusByTripId', () => {
    it('drops terminus entries for trips no longer in masterArrivalsData', () => {
        // Two trips currently in the arrivals store; both register terminuses.
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [
                { stopId: '80101', arrival: { time: NOW() + 30 } },
                { stopId: '80303', arrival: { time: NOW() + 180 } },
            ],
        }), null);
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-2',
            stopTimeUpdates: [
                { stopId: '80101', arrival: { time: NOW() + 60 } },
                { stopId: '80303', arrival: { time: NOW() + 240 } },
            ],
        }), null);
        expect(tripTerminusByTripId.size).toBe(2);

        // Simulate time advancing past both the past-arrival grace (60 s) and the
        // terminus TTL (FRESH_EXPIRE_S = 300 s). pruneStaleArrivals deletes the
        // stale arrivals, then prunes terminus entries older than 300 s.
        pruneStaleArrivals(NOW() + 301);
        expect(window.masterArrivalsData.size).toBe(0);
        expect(tripTerminusByTripId.size).toBe(0);
    });

    it('keeps terminus entries alive for FRESH_EXPIRE_S past their last update', () => {
        // Regression: under the prior implementation, terminus entries were
        // pruned in lockstep with masterArrivalsData (cutoff PAST_ARRIVAL_GRACE_S
        // = 60 s past arrival). Vehicle markers stay visible until 300 s, so
        // destination labels blanked out during the window between arrivals-prune
        // and marker-removal. New behavior: terminus entries live for
        // FRESH_EXPIRE_S (300 s) past their last ingest, decoupled from arrivals.
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 30 } }],
        }), null);
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-2',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 600 } }],
        }), null);
        expect(tripTerminusByTripId.size).toBe(2);

        // Advance 120 s. TR-A-1's arrival (NOW+30) is past its grace, so the
        // arrival entry is pruned — but the terminus must remain because the
        // last update was only 120 s ago, well within FRESH_EXPIRE_S (300 s).
        pruneStaleArrivals(NOW() + 120);
        expect(tripTerminusByTripId.has('TR-A-1')).toBe(true);
        expect(tripTerminusByTripId.has('TR-A-2')).toBe(true);
    });

    it('drops terminus entries only after FRESH_EXPIRE_S of silence', () => {
        // Trip stops being updated; after the marker's visible lifetime has
        // elapsed without any new ingest, the terminus entry should be pruned to
        // bound map size.
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-3',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 30 } }],
        }), null);
        expect(tripTerminusByTripId.has('TR-A-3')).toBe(true);

        // Just before FRESH_EXPIRE_S — must still be present (marker still visible).
        pruneStaleArrivals(NOW() + 299);
        expect(tripTerminusByTripId.has('TR-A-3')).toBe(true);

        // Just past FRESH_EXPIRE_S — marker removed, so prune the terminus.
        pruneStaleArrivals(NOW() + 301);
        expect(tripTerminusByTripId.has('TR-A-3')).toBe(false);
    });
});
