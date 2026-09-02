/**
 * SKIPPED-stop suppression has to hold on BOTH paths (R2-03).
 *
 * `stu.scheduleRelationship === 'SKIPPED'` means the train passes that platform
 * without serving it. Ingest omitted such stops, which is necessary but was not
 * sufficient, in two ways:
 *
 *   (a) Omitting is not purging. A stop already ingested as SCHEDULED kept its
 *       original entry when a later frame flagged it SKIPPED, so consumers went
 *       on rendering the original predicted time as a live GTFS-RT pill until it
 *       aged out — up to 90 s of a confident arrival for a train that will not
 *       stop.
 *   (b) The schedule/distance ("calc") tier fires precisely WHEN there is no
 *       GTFS-RT entry for a trip at a stop — which is exactly the state a
 *       SKIPPED declaration produces. So for any trip with a live marker (the
 *       normal case) the ingest gate did not merely fail to help: it routed
 *       every skipped stop straight into a calc arrival. This is the dominant
 *       half.
 *
 * Note the asymmetry with CANCELED, which is easy to get wrong: a canceled trip
 * serves NO stop, so it purges wholesale; a SKIPPED declaration must purge
 * exactly one (tripId, stopId) pair and leave the same frame's SCHEDULED
 * siblings alone.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
}));

import { processUpdate, isStopSkipped, _resetSkippedStopsForTest } from '../js/tripUpdates.js';
import { initPredictions, getScheduledArrivals } from '../js/predictions.js';

const NOW = () => Math.floor(Date.now() / 1000);
const STOPS = ['s0', 's1', 's2', 's3'];

function frame(stopTimeUpdate, { tripId = 't1' } = {}) {
    return {
        tripUpdate: {
            trip: { tripId, routeId: '802', directionId: 0, scheduleRelationship: 'SCHEDULED' },
            vehicle: { id: 'v1' },
            timestamp: NOW(),
            stopTimeUpdate,
        },
    };
}

beforeEach(() => {
    _resetSkippedStopsForTest();
    window.masterArrivalsData = new Map();
    window.masterStopsData = Object.fromEntries(
        STOPS.map((s, i) => [s, { name: `Stop ${i}`, lat: 34 + i / 100, lon: -118 }]),
    );
    window.masterTripsData = {
        t1: { rc: '802', dir: 0, stops: STOPS, scheduledTimes: STOPS.map((_, i) => i * 300) },
    };
    window.vehicleMarkers = {};
    initPredictions();
});

describe('a stop re-flagged SKIPPED loses its already-ingested arrival (a)', () => {
    it('purges the entry a previous frame wrote', () => {
        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 180 } }]));
        expect(window.masterArrivalsData.get('s2'), 'precondition: the stop was ingested').toHaveLength(1);

        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' }]));
        const list = window.masterArrivalsData.get('s2') ?? [];
        expect(list.some(e => e.tripId === 't1'), 'a stale pill for a skipped stop must not survive').toBe(false);
    });

    it('leaves the same frame\'s SCHEDULED siblings alone', () => {
        // The CANCELED path purges every stop in the frame; SKIPPED must not.
        processUpdate(frame([
            { stopId: 's1', arrival: { time: NOW() + 120 } },
            { stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' },
            { stopId: 's3', arrival: { time: NOW() + 240 } },
        ]));
        expect(window.masterArrivalsData.get('s1')).toHaveLength(1);
        expect(window.masterArrivalsData.has('s2')).toBe(false);
        expect(window.masterArrivalsData.get('s3')).toHaveLength(1);
    });

    it('does not disturb ANOTHER trip\'s arrival at the skipped stop', () => {
        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 300 } }], { tripId: 't-other' }));
        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' }]));
        const list = window.masterArrivalsData.get('s2') ?? [];
        expect(list.map(e => e.tripId)).toEqual(['t-other']);
    });
});

describe('the calc tier is suppressed for a skipped stop (b)', () => {
    /** A live marker one stop upstream — the state that triggers the calc tier. */
    function markerApproaching(nextStop = 's1') {
        window.vehicleMarkers = {
            t1: {
                properties: {
                    trip_id: 't1', route_code: '802', direction_id: 0,
                    stopId: nextStop, vehicle_id: 'v1', currentStatus: 'IN_TRANSIT_TO',
                },
                _lastAcceptedTs: NOW(), timestamp: NOW(),
                getLngLat: () => ({ lng: -118, lat: 34 }),
            },
        };
    }

    it('does not invent a calc arrival for a stop the latest frame skipped', () => {
        processUpdate(frame([
            { stopId: 's1', arrival: { time: NOW() + 60 } },
            { stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' },
        ]));
        markerApproaching('s1');

        const rows = getScheduledArrivals('s2');
        expect(rows.some(r => r.tripId === 't1'),
            'a train running express past this platform must not show an ETA there').toBe(false);
    });

    it('a normal stop on the same trip still gets its calc row (control)', () => {
        processUpdate(frame([
            { stopId: 's1', arrival: { time: NOW() + 60 } },
            { stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' },
        ]));
        markerApproaching('s1');
        expect(getScheduledArrivals('s3').some(r => r.tripId === 't1'),
            'suppression must be per-stop, not per-trip').toBe(true);
    });

    it('recovers as soon as the feed stops flagging the stop', () => {
        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' }]));
        expect(isStopSkipped('t1', 's2')).toBe(true);
        // The next frame no longer mentions it as skipped — the set is rebuilt
        // wholesale, so the claim evaporates rather than lingering.
        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 180 } }]));
        expect(isStopSkipped('t1', 's2')).toBe(false);
    });
});

describe('the skip claim ages out like every other trip_updates fact', () => {
    it('stops being believed once the trip goes silent past the staleness window', () => {
        // A stale "it will skip" claim is no more trustworthy than a stale ETA,
        // and the registry must not pin a trip forever after its feed dies.
        processUpdate(frame([{ stopId: 's2', arrival: { time: NOW() + 180 }, scheduleRelationship: 'SKIPPED' }]));
        expect(isStopSkipped('t1', 's2')).toBe(true);

        const realNow = Date.now;
        try {
            Date.now = () => realNow() + 91_000;   // past GTFS_ENTRY_STALENESS_S
            expect(isStopSkipped('t1', 's2')).toBe(false);
        } finally {
            Date.now = realNow;
        }
    });

    it('is inert for a trip that never skipped anything', () => {
        processUpdate(frame([{ stopId: 's1', arrival: { time: NOW() + 60 } }]));
        expect(isStopSkipped('t1', 's1')).toBe(false);
        expect(isStopSkipped('unknown-trip', 's1')).toBe(false);
    });
});
