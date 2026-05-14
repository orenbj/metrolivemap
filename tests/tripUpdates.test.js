import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast:           vi.fn(),
    setConnectionStatus: vi.fn(),
    updateDataPanel:     vi.fn(),
    getPopupHTML:        vi.fn(() => ''),
    cleanDestination:    s => s,
    updateUpdateTime:    vi.fn(),
    initUI:              vi.fn(),
    removeLoadingScreen: vi.fn(),
}));

import { processUpdate, tripTerminusByTripId, pruneStaleArrivals } from '../js/tripUpdates.js';
import { makeRawTripUpdate } from './_fixtures/markers.js';
import { resetGlobals } from './_helpers/globals.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    resetGlobals();
    tripTerminusByTripId.clear();
});

describe('processUpdate — validation', () => {
    it('ignores messages with no tripUpdate', () => {
        processUpdate({}, null);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores messages with empty stopTimeUpdate array', () => {
        processUpdate({ tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [] } }, null);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores stopTimeUpdate entries missing stopId', () => {
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ arrival: { time: NOW() + 60 } }],
        });
        processUpdate(msg, null);
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
        processUpdate(msg, null);
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('ignores entries with arrivalUnix=0 (sentinel)', () => {
        const msg = makeRawTripUpdate({
            stopTimeUpdates: [{ stopId: '80202', arrival: { time: 0 } }],
        });
        processUpdate(msg, null);
        expect(window.masterArrivalsData.size).toBe(0);
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

describe('processUpdate — route filter', () => {
    it('skips updates whose routeId is not in the filter set', () => {
        processUpdate(makeRawTripUpdate({ routeId: '901' }), new Set(['801']));
        expect(window.masterArrivalsData.size).toBe(0);
    });

    it('passes updates whose routeId IS in the filter set', () => {
        processUpdate(makeRawTripUpdate({ routeId: '801' }), new Set(['801']));
        expect(window.masterArrivalsData.size).toBe(1);
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
        }), null);
        expect(tripTerminusByTripId.get('TR-A-1')).toBe('80303');
    });

    it('does not register a terminus when tripId is empty', () => {
        processUpdate(makeRawTripUpdate({
            tripId: '',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 30 } }],
        }), null);
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

        // Simulate time advancing past the past-arrival grace so all current
        // entries become stale. pruneStaleArrivals deletes them from the
        // arrivals store, then prunes the terminus map to the (empty) set of
        // surviving tripIds.
        pruneStaleArrivals(NOW() + 300);
        expect(window.masterArrivalsData.size).toBe(0);
        expect(tripTerminusByTripId.size).toBe(0);
    });

    it('keeps terminus entries for trips that still have fresh arrivals', () => {
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-1',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 30 } }],
        }), null);
        processUpdate(makeRawTripUpdate({
            tripId: 'TR-A-2',
            stopTimeUpdates: [{ stopId: '80303', arrival: { time: NOW() + 600 } }],
        }), null);
        expect(tripTerminusByTripId.size).toBe(2);

        // Advance past TR-A-1's arrival but not TR-A-2's.
        pruneStaleArrivals(NOW() + 120);
        expect(tripTerminusByTripId.has('TR-A-1')).toBe(false);
        expect(tripTerminusByTripId.has('TR-A-2')).toBe(true);
    });
});
