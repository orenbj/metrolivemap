/**
 * Regression for the decreasing-arc freeze + the STOPPED_AT declared-stop anchor.
 *
 * There is ONE shared polyline per route, so half the routes' directions travel
 * in DECREASING arc (e.g. A Line dir 0, J Line 910/950 dir 0). The jitter-hold
 * used to test `toArc - fromArc < deadband` with no orientation term, so every
 * forward step of a decreasing-arc train read as "backward" and the marker FROZE
 * until a 5 km re-anchor / stop-lag forcePull yanked it forward — the "stuck,
 * then jumps past the station" bug. The hold is now orientation-aware
 * (cache.arcAscending), and STOPPED_AT can anchor the dot to the declared stop.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

// Controllable route cache so we can pin arc orientation per test.
const _routeCache = { current: null };
vi.mock('../js/predictions.js', async (importActual) => {
    const actual = await importActual();
    return {
        findIdx: actual.findIdx,
        getRouteCache: vi.fn(() => _routeCache.current),
        getTerminalStopId: vi.fn(() => null),
        getSecondsToNextStop: vi.fn(() => null),
        getScheduledArrivals: vi.fn(() => []),
        isOriginStop: vi.fn(() => false),
        isAtOwnOriginStop: vi.fn(() => false),
    };
});

import { markers, _applyVelocityCorrections, _declaredStopAnchorArc, _applySnap, _stopLagFromDeclared } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import { shapeData, precomputeRoute, lngLatAtArc } from '../js/snap.js';

const RC = 'ARC_ORIENT_TEST';

// Straight N-S route; arc INCREASES northward (index order). lngLatAtArc resolves.
function buildRoute() {
    const DEG = 100 / 110_540;
    const pts = Array.from({ length: 30 }, (_, i) => [34.0 + i * DEG, -118.2]); // [lat,lng]
    shapeData[RC] = pts;
    precomputeRoute(RC, pts);
}

beforeEach(() => {
    installGlobals();
    for (const k of Object.keys(markers)) delete markers[k];
    buildRoute();
    _routeCache.current = null;
});

// Run one fix and report whether the marker GLIDED (vs held). Place the marker
// visually at fromArc and the incoming fix at toArc (both resolved on the route).
function frame({ fromArc, toArc, ascending, anchorArc = null, speed = 12, noCache = false }) {
    // noCache simulates getRouteCache returning undefined — direction_id
    // momentarily null, or a trip absent from static GTFS (owl trips).
    _routeCache.current = noCache
        ? null
        : { arcAscending: ascending, arcUnreliable: false, stops: [], arcMeters: [] };
    const key = 'F-1';
    const ptFrom = lngLatAtArc(RC, fromArc);
    const ptTo = lngLatAtArc(RC, toArc);
    const marker = makeMarker({ tripId: key, routeCode: RC, speed, lastSnap: { arcMeters: toArc } });
    marker._currentArc = fromArc;
    marker.setLngLat([ptFrom.lng, ptFrom.lat]);
    marker._targetLng = ptTo.lng;
    marker._targetLat = ptTo.lat;
    markers[key] = marker;
    const newTs = Math.floor(Date.now() / 1000);
    const vehicle = makeFeature({ tripId: key, routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed });
    _applyVelocityCorrections(marker, vehicle, key, newTs - 5, /*isFirstFix*/ false, /*isStaleRef*/ false, /*forcePull*/ false, anchorArc);
    return typeof marker._animateMarkerOnComplete === 'function'; // glide started?
}

describe('_applyVelocityCorrections — orientation-aware jitter hold', () => {
    it('GLIDES a forward move on a DECREASING-arc direction (the freeze bug fix)', () => {
        // Forward = arc decreases (900 -> 400). Pre-fix this froze the marker.
        expect(frame({ fromArc: 900, toArc: 400, ascending: false })).toBe(true);
    });

    it('HOLDS a backward move on a DECREASING-arc direction (arc increases = backward)', () => {
        // Backward for a decreasing-arc train = arc INCREASES (400 -> 900).
        expect(frame({ fromArc: 400, toArc: 900, ascending: false })).toBe(false);
    });

    it('GLIDES a forward move on an ASCENDING direction (unchanged control)', () => {
        expect(frame({ fromArc: 400, toArc: 900, ascending: true })).toBe(true);
    });

    it('HOLDS a backward move on an ASCENDING direction (unchanged control)', () => {
        expect(frame({ fromArc: 900, toArc: 400, ascending: true })).toBe(false);
    });
});

describe('_applyVelocityCorrections — jitter hold with a MISSING route cache', () => {
    // getRouteCache can return undefined (direction_id null for a frame, or a
    // trip absent from static GTFS — owl trips, fresh service-date gaps). The
    // hold must then use the orientation-agnostic |delta| fallback, NOT assume
    // ascending: `undefined?.arcAscending !== false` is true, so the old code
    // silently took the oriented branch and re-froze every DECREASING-arc
    // direction — the exact "stuck, then jumps past the station" bug, on
    // precisely the trips the orientation tests above can't cover.
    it('GLIDES a forward move on a DECREASING-arc direction when the cache is missing', () => {
        expect(frame({ fromArc: 900, toArc: 400, ascending: undefined, noCache: true })).toBe(true);
    });

    it('GLIDES a forward move on an ASCENDING direction when the cache is missing', () => {
        expect(frame({ fromArc: 400, toArc: 900, ascending: undefined, noCache: true })).toBe(true);
    });

    it('still HOLDS true sub-deadband jitter when the cache is missing (dwelling vehicle)', () => {
        // The moving deadband is 0 (every real move glides), so a |delta| hold
        // only exists while DWELLING (speed < STATIONARY_SPEED_MPS → 25 m band).
        // |delta| = 2 m of stationary GPS shuffle — held in either orientation.
        expect(frame({ fromArc: 900, toArc: 902, ascending: undefined, noCache: true, speed: 0 })).toBe(false);
    });
});

describe('_applySnap — off-route entry invalidates _currentArc (detour bug)', () => {
    const DEG = 100 / 110_540; // ~100 m in degrees latitude (route step from buildRoute)

    function makeOnRouteMarker(arc) {
        const pt = lngLatAtArc(RC, arc);
        const marker = makeMarker({
            tripId: 'OFF-1', routeCode: RC,
            lastSnap: { arcMeters: arc, snappedLat: pt.lat, snappedLng: pt.lng, tangentForward: 0 },
        });
        marker._currentArc = arc;
        marker.setLngLat([pt.lng, pt.lat]);
        markers['OFF-1'] = marker;
        return marker;
    }

    it('clears _currentArc together with lastSnap when the fix exceeds the snap tolerance', () => {
        const marker = makeOnRouteMarker(500);
        // Fix ~1.1 km EAST of the N-S polyline — far past every snap tolerance.
        const exit = lngLatAtArc(RC, 500);
        const vehicle = makeFeature({ tripId: 'OFF-1', routeCode: RC, lngLat: [exit.lng + 12 * DEG, exit.lat] });
        _applySnap(marker, vehicle);
        expect(marker.lastSnap).toBeNull();
        // The stale exit arc must die with the snap. Left alive it becomes the
        // rejoin glide's fromArc (visible backward jump to the exit point) and
        // keeps feeding _stopLagFromDeclared as the "visible arc" (per-frame
        // forced teleports through the bus branch for the whole detour).
        expect(marker._currentArc).toBeNull();
        expect(marker.getElement().getAttribute('data-off-route')).toBe('true');
    });

    it('disables the stop-lag override for the whole off-route episode', () => {
        const marker = makeOnRouteMarker(500);
        const exit = lngLatAtArc(RC, 500);
        const offVehicle = makeFeature({
            tripId: 'OFF-1', routeCode: RC, stopId: 'S20',
            lngLat: [exit.lng + 12 * DEG, exit.lat],
        });
        // Route cache with real stops so the lag helper WOULD fire if it had an
        // arc reference: declared stop S20 sits 2+ stops past the exit arc.
        _routeCache.current = {
            arcAscending: true, arcUnreliable: false,
            stops: ['S5', 'S10', 'S20'], arcMeters: [500, 1000, 2000],
        };
        _applySnap(marker, offVehicle);
        // Off-route: no snap, no visible arc → lag must be null (no reference),
        // not a stopsAhead>=2 result that would force a teleport EVERY frame.
        expect(_stopLagFromDeclared(marker, offVehicle, marker._currentArc)).toBeNull();
    });

    it('keeps _currentArc across an ON-route update (control)', () => {
        const marker = makeOnRouteMarker(500);
        const next = lngLatAtArc(RC, 600);
        const vehicle = makeFeature({ tripId: 'OFF-1', routeCode: RC, lngLat: [next.lng, next.lat] });
        _applySnap(marker, vehicle);
        expect(marker.lastSnap).not.toBeNull();
        expect(marker._currentArc).toBe(500); // untouched — only the glide advances it
        expect(marker.getElement().hasAttribute('data-off-route')).toBe(false);
    });
});

describe('_declaredStopAnchorArc — STOPPED_AT forward-anchor decision', () => {
    const lag = (o) => ({ stopped: true, declaredArc: 2000, ascending: true, stopsAhead: 1, prevArc: null, ...o });

    it('returns the declared arc when STOPPED_AT a stop ahead of dot AND ahead of GPS (ascending)', () => {
        // dot at 1000, GPS lagging at 1500, declared stop at 2000 → anchor to 2000.
        expect(_declaredStopAnchorArc(lag(), 1000, 1500)).toBe(2000);
    });

    it('returns null when the GPS is already at/past the declared stop (no backward pull)', () => {
        // GPS fresh at 2500 (past the declared 2000) → trust GPS, do not anchor back.
        expect(_declaredStopAnchorArc(lag(), 1000, 2500)).toBeNull();
    });

    it('returns null when the declared stop is behind the dot', () => {
        expect(_declaredStopAnchorArc(lag(), 2500, 2400)).toBeNull();
    });

    it('is orientation-aware on a DECREASING-arc direction', () => {
        // Descending: forward = smaller arc. Declared 1000 is forward of dot 2000
        // and forward of GPS 1500 → anchor to 1000.
        const l = lag({ declaredArc: 1000, ascending: false });
        expect(_declaredStopAnchorArc(l, 2000, 1500)).toBe(1000);
        // GPS already past (smaller than declared) → no anchor.
        expect(_declaredStopAnchorArc(l, 2000, 800)).toBeNull();
    });

    it('returns null when not STOPPED_AT', () => {
        expect(_declaredStopAnchorArc(lag({ stopped: false }), 1000, 1500)).toBeNull();
    });

    it('returns null on missing lag / arc data', () => {
        expect(_declaredStopAnchorArc(null, 1000, 1500)).toBeNull();
        expect(_declaredStopAnchorArc(lag({ declaredArc: null }), 1000, 1500)).toBeNull();
        expect(_declaredStopAnchorArc(lag(), 1000, null)).toBeNull();
    });
});

describe('_applyVelocityCorrections — bounded backward release (single-tracking / sticky-spike fix)', () => {
    // The jitter hold is one-sided; unbounded that meant backward motion could
    // NEVER render — a real reversal froze the dot for minutes, and an accepted
    // forward GPS spike became sticky (every corrective backward fix held).
    // Release rule: oriented backward delta > POS_JITTER_BACKWARD_RELEASE_M
    // (75 m) on POS_JITTER_BACKWARD_STREAK (2) CONSECUTIVE accepted fixes →
    // glide back to the feed. Anything below the bound stays held forever;
    // any non-large-backward frame breaks the streak.
    const KEY = 'BR-1';

    function makeHeldMarker(fromArc) {
        const ptFrom = lngLatAtArc(RC, fromArc);
        const marker = makeMarker({ tripId: KEY, routeCode: RC, speed: 12 });
        marker._currentArc = fromArc;
        marker.setLngLat([ptFrom.lng, ptFrom.lat]);
        markers[KEY] = marker;
        return marker;
    }

    // Apply one accepted fix to an EXISTING marker; returns true if it glided.
    let _tsSeq = 0;
    function fix(marker, { toArc, ascending, speed = 12 }) {
        _routeCache.current = { arcAscending: ascending, arcUnreliable: false, stops: [], arcMeters: [] };
        const ptTo = lngLatAtArc(RC, toArc);
        marker.lastSnap = { arcMeters: toArc };
        marker._targetLng = ptTo.lng;
        marker._targetLat = ptTo.lat;
        delete marker._animateMarkerOnComplete;   // clean glide probe per fix
        const newTs = Math.floor(Date.now() / 1000) + (_tsSeq += 5);
        const vehicle = makeFeature({ tripId: KEY, routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed });
        _applyVelocityCorrections(marker, vehicle, KEY, newTs - 5, false, false, false, null);
        return typeof marker._animateMarkerOnComplete === 'function';
    }

    it('holds the FIRST large backward fix, releases on the SECOND consecutive one (ascending)', () => {
        const m = makeHeldMarker(900);
        expect(fix(m, { toArc: 700, ascending: true })).toBe(false);  // held, streak 1
        expect(fix(m, { toArc: 700, ascending: true })).toBe(true);   // feed insists → glide back
    });

    it('same release on a DECREASING-arc direction (backward = arc increases)', () => {
        const m = makeHeldMarker(400);
        expect(fix(m, { toArc: 600, ascending: false })).toBe(false);
        expect(fix(m, { toArc: 600, ascending: false })).toBe(true);
    });

    it('NEVER releases sub-bound backward noise, regardless of persistence', () => {
        // 50 m backward < POS_JITTER_BACKWARD_RELEASE_M (75) — ordinary GPS
        // scatter on a fixed guideway; three in a row stay held.
        const m = makeHeldMarker(900);
        expect(fix(m, { toArc: 850, ascending: true })).toBe(false);
        expect(fix(m, { toArc: 850, ascending: true })).toBe(false);
        expect(fix(m, { toArc: 850, ascending: true })).toBe(false);
    });

    it('a small backward blip BREAKS the streak (rule is strictly consecutive)', () => {
        const m = makeHeldMarker(900);
        expect(fix(m, { toArc: 700, ascending: true })).toBe(false);  // big backward, streak 1
        expect(fix(m, { toArc: 890, ascending: true })).toBe(false);  // small blip — held, streak reset
        expect(fix(m, { toArc: 700, ascending: true })).toBe(false);  // big backward again — streak 1, still held
    });

    it('forward progress BREAKS the streak', () => {
        const m = makeHeldMarker(900);
        expect(fix(m, { toArc: 700, ascending: true })).toBe(false);  // big backward, streak 1
        expect(fix(m, { toArc: 1000, ascending: true })).toBe(true);  // forward — glides, streak reset
        expect(fix(m, { toArc: 700, ascending: true })).toBe(false);  // big backward — streak restarts at 1
    });

    it('does not release via the orientation-agnostic |delta| fallback (cannot tell backward from forward)', () => {
        // Missing cache → |delta| path: a 200 m move GLIDES there anyway (real
        // moves aren't held by the fallback), so release logic must not engage.
        // Verify the streak counter stays untouched through fallback frames.
        const m = makeHeldMarker(900);
        _routeCache.current = null;
        const ptTo = lngLatAtArc(RC, 700);
        m.lastSnap = { arcMeters: 700 };
        m._targetLng = ptTo.lng;
        m._targetLat = ptTo.lat;
        const newTs = Math.floor(Date.now() / 1000) + (_tsSeq += 5);
        const vehicle = makeFeature({ tripId: KEY, routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed: 12 });
        _applyVelocityCorrections(m, vehicle, KEY, newTs - 5, false, false, false, null);
        expect(typeof m._animateMarkerOnComplete === 'function').toBe(true); // glided (fallback)
        expect(m._backwardStreak ?? 0).toBe(0);                              // no streak engaged
    });
});
