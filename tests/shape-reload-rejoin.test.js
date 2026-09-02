/**
 * A marker must not carry a stale arc across a shape-cache gap (R1-05).
 *
 * `_currentArc` is a distance along a SPECIFIC polyline. While shape data is
 * missing the marker moves by straight line and nothing updates that number, so
 * it goes on pointing at wherever the vehicle was when the shapes vanished. The
 * moment shapes come back it becomes the rail glide's `fromArc` and the dot
 * visibly REWINDS to that old position before gliding forward again.
 *
 * This shipped with R1-03 deliberately. Until R1-03, a failed shape load could
 * never recover, so the only rejoin moment was the once-a-day service-date
 * rollover. R1-03's retry creates one mid-session, for every rail marker at
 * once — turning a rare cosmetic blip into a visible fleet-wide backward jump.
 *
 * The off-route branch already clears the same state for the same reason; this
 * mirrors it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shapes = { has: true };
vi.mock('../js/snap.js', async (orig) => {
    const actual = await orig();
    return {
        ...actual,
        hasShapeData: (rc) => shapes.has && String(rc) === '801',
        snapToRoute: () => (shapes.has ? { snappedLng: -118, snappedLat: 34, arcMeters: 40350, tangentForward: 0 } : null),
        resolveShapeKey: (rc) => String(rc),
        lngLatAtArcPos: () => ({ lng: -118, lat: 34 }),
    };
});
vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());

import { _applySnap } from '../js/markers.js';

function frame(lng = -118, lat = 34) {
    return {
        geometry: { coordinates: [lng, lat] },
        properties: { route_code: '801', direction_id: 0, currentStatus: 'IN_TRANSIT_TO', stopId: 's1', trip_id: 't1' },
    };
}

function markerAt(arc) {
    return {
        properties: { route_code: '801', direction_id: 0, trip_id: 't1' },
        _currentArc: arc,
        _currentArcKey: '801',
        _lastKnownDir: 0,
        lastSnap: { arcMeters: arc, tangentForward: 0 },
        lastSnapDeviationM: 3,
        getElement: () => ({ setAttribute: () => {}, removeAttribute: () => {}, hasAttribute: () => false }),
    };
}

beforeEach(() => { shapes.has = true; window.masterStopsData = {}; });

describe('arc state does not survive a shape-cache gap', () => {
    it('is cleared while shape data is unavailable', () => {
        const m = markerAt(40000);
        shapes.has = false;
        _applySnap(m, frame());
        expect(m._currentArc, 'a stale arc becomes the rejoin glide fromArc').toBeNull();
        expect(m.lastSnap).toBeNull();
    });

    it('so the rejoin after shapes return starts from the FRESH arc, not the old one', () => {
        const m = markerAt(40000);
        shapes.has = false;
        _applySnap(m, frame());          // gap: arc state dropped
        shapes.has = true;
        _applySnap(m, frame());          // shapes back
        // 40350 is the fresh snap; 40000 was the pre-gap arc the dot would have
        // rewound to.
        expect(m.lastSnap?.arcMeters).toBe(40350);
        expect(m._currentArc).not.toBe(40000);
    });

    it('leaves a normal frame with shape data untouched', () => {
        const m = markerAt(40000);
        _applySnap(m, frame());
        expect(m.lastSnap?.arcMeters, 'the ordinary path must still snap').toBe(40350);
    });
});
