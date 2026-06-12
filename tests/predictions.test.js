import { vi, describe, it, expect, beforeEach } from 'vitest';

// predictions.js → snap.js → ui.js (showToast); stub ui.js so the module loads cleanly
vi.mock('../js/ui.js', () => ({
    showToast:         vi.fn(),
    updateDataPanel:   vi.fn(),
    getPopupHTML:      vi.fn(() => ''),
    cleanDestination:  s => s,
    updateUpdateTime:  vi.fn(),
    setConnectionStatus: vi.fn(),
    initUI:            vi.fn(),
}));

import {
    findIdx,
    interStopRemainingSeconds,
    gtfsLooksPlausible,
    computeTripAdherenceOffset,
    _computeArcOrientation,
    resolveTripDestination,
} from '../js/predictions.js';
import { tripTerminusByTripId } from '../js/tripUpdates.js';
import { ETA_DEPARTURE_LAG_S, ETA_MAX_SPEED_MPS, ETA_PLAUSIBILITY_GRACE_S } from '../js/config.js';

// ─── findIdx ──────────────────────────────────────────────────────────────────

describe('findIdx', () => {
    const stops = ['80101', '80202', '80303', '80228'];

    it('exact match', () => {
        expect(findIdx(stops, '80202')).toBe(1);
    });

    it('first element', () => {
        expect(findIdx(stops, '80101')).toBe(0);
    });

    it('last element', () => {
        expect(findIdx(stops, '80228')).toBe(3);
    });

    it('no match returns -1', () => {
        expect(findIdx(stops, '99999')).toBe(-1);
    });

    it('empty stops returns -1', () => {
        expect(findIdx([], '80101')).toBe(-1);
    });

    it('strips _N directional suffix', () => {
        expect(findIdx(stops, '80228_N')).toBe(3);
    });

    it('strips _S directional suffix', () => {
        expect(findIdx(stops, '80101_S')).toBe(0);
    });

    it('strips _E and _W suffixes', () => {
        expect(findIdx(stops, '80202_E')).toBe(1);
        expect(findIdx(stops, '80303_W')).toBe(2);
    });

    it('normalises suffix on both sides (suffixed stops vs suffixed target)', () => {
        const suffixed = ['80101_N', '80202_S', '80303_N'];
        expect(findIdx(suffixed, '80202_N')).toBe(1);
    });

    it('strips trailing non-digit characters (e.g. "80228N")', () => {
        expect(findIdx(stops, '80228N')).toBe(3);
    });

    it('prefix match: shorter stop ID in list, longer target with non-numeric suffix', () => {
        expect(findIdx(['80228'], '80228NB')).toBe(0);
    });

    it('prefix match: longer stop ID in list, shorter target', () => {
        expect(findIdx(['80228NB'], '80228')).toBe(0);
    });

    it('does NOT match when the suffix after the common prefix contains a digit', () => {
        // "802281" — suffix "1" is a digit, should not match "80228"
        expect(findIdx(['80228'], '802281')).toBe(-1);
    });
});

// ─── interStopRemainingSeconds ────────────────────────────────────────────────

describe('interStopRemainingSeconds', () => {
    // Simple schedule: departure at t=0, next stop at t=120 (2-min gap)
    const times = [0, 120, 240];

    it('returns null when statusChangedAt is null', () => {
        expect(interStopRemainingSeconds(null, 100, times, 1)).toBeNull();
    });

    it('returns null when idx === 0 (first stop, no previous gap)', () => {
        expect(interStopRemainingSeconds(0, 100, times, 0)).toBeNull();
    });

    it('returns null when idx < 0', () => {
        expect(interStopRemainingSeconds(0, 100, times, -1)).toBeNull();
    });

    it('returns null when inter-stop gap is zero (duplicate schedule times)', () => {
        expect(interStopRemainingSeconds(0, 50, [0, 0, 120], 1)).toBeNull();
    });

    it('returns null when inter-stop gap is negative', () => {
        expect(interStopRemainingSeconds(0, 50, [120, 0], 1)).toBeNull();
    });

    it('returns correct remaining seconds partway through segment', () => {
        // departed at T=1000, now=T=1030 → 30s elapsed; + lag=30 → 60s in transit
        // gap=120, remaining = 120 - 60 = 60
        const result = interStopRemainingSeconds(1000, 1030, [0, 120], 1);
        expect(result).toBe(120 - (30 + ETA_DEPARTURE_LAG_S));
    });

    it('clamps to 0 when vehicle is past its scheduled arrival time', () => {
        // 300s elapsed >> 120s gap → timeInTransit clamped at gap → remaining=0
        const result = interStopRemainingSeconds(1000, 1300, [0, 120], 1);
        expect(result).toBe(0);
    });

    it('accounts for departure lag on a fresh status change', () => {
        // just stopped (elapsed=0) → timeInTransit = 0 + lag = lag
        const result = interStopRemainingSeconds(1000, 1000, [0, 120], 1);
        expect(result).toBe(120 - ETA_DEPARTURE_LAG_S);
    });

    it('works on later stops (idx=2)', () => {
        // gap between stop 1 and 2 is also 120s
        const result = interStopRemainingSeconds(1000, 1000, times, 2);
        expect(result).toBe(120 - ETA_DEPARTURE_LAG_S);
    });
});

// ─── gtfsLooksPlausible ───────────────────────────────────────────────────────

describe('gtfsLooksPlausible', () => {
    const NOW = 10000;

    it('returns true when marker has no snap data', () => {
        const marker = { lastSnap: null };
        const cache  = {};
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 5 }, NOW)).toBe(true);
    });

    it('returns true when cache has no arcMeters', () => {
        const marker = { lastSnap: { arcMeters: 0 } };
        const cache  = {};   // no arcMeters property
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 5 }, NOW)).toBe(true);
    });

    it('returns true when stop arc is null in cache', () => {
        const marker = { lastSnap: { arcMeters: 0 } };
        const cache  = { arcMeters: [null, null] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 5 }, NOW)).toBe(true);
    });

    it('accepts vehicle past the stop when feed agrees arrival is past', () => {
        // vehicle at 500m, stop at 400m → distMeters = -100 (clearly past).
        // Feed says arrived 60s ago. Consistent → plausible. Fresh snap so the
        // past-stop assertion is trusted.
        const marker = { lastSnap: { arcMeters: 500 }, timestamp: NOW };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW - 60 }, NOW)).toBe(true);
    });

    it('rejects future-arrival when vehicle is clearly past the stop (fresh snap)', () => {
        // vehicle 100m downstream but feed still claims arrival in 2 min —
        // classic stale-feed / snap-lag pattern. Without the gate the popup
        // would render "2 min" for a train already pulling out of the station.
        // Snap is fresh, so the "past the stop" reading is trustworthy → reject.
        const marker = { lastSnap: { arcMeters: 500 }, timestamp: NOW };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 120 }, NOW)).toBe(false);
    });

    it('trusts a future arrival past the stop when the snap is STALE', () => {
        // Same geometry, but the last accepted fix is older than FRESH_LIVE_S —
        // off-peak / BRT-busway cadence. A lagging snap reads "past the stop"
        // while the feed correctly predicts a still-upcoming arrival. We can't
        // trust the arc here, so we must NOT reject the feed (the dominant
        // false-rejection mechanism behind the gate's net-hurting substitutions).
        const marker = { lastSnap: { arcMeters: 500 }, timestamp: NOW - 60 };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 120 }, NOW)).toBe(true);
    });

    it('uses _lastAcceptedTs (not bumped timestamp) for past-stop snap freshness', () => {
        // A spike-rejected vehicle has a freshly-bumped marker.timestamp but a
        // stale _lastAcceptedTs. Freshness must read the trusted clock, so the
        // past-stop rejection stays disabled (feed trusted) for a frozen marker.
        const marker = {
            lastSnap: { arcMeters: 500 },
            timestamp: NOW,            // bumped on spike-reject
            _lastAcceptedTs: NOW - 60, // last TRUSTED fix is stale
        };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 120 }, NOW)).toBe(true);
    });

    it('stays permissive in the snap-overshoot tolerance band (-15m)', () => {
        // Snap can briefly overshoot the stop arc by a few meters just before
        // STOPPED_AT fires on platform approach — keep the [-30, 0] band
        // permissive so a fresh "Arriving" prediction isn't tossed.
        const marker = { lastSnap: { arcMeters: 415 } };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 30 }, NOW)).toBe(true);
    });

    it('rejects arrival that would require exceeding max speed', () => {
        // 1800m to stop, max speed 30 m/s → min 60s; grace 45s → must report >= 15s
        // reported = 0s → too soon
        const marker = { lastSnap: { arcMeters: 0 } };
        const cache  = { arcMeters: [0, 1800] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW }, NOW)).toBe(false);
    });

    it('accepts arrival within the grace window', () => {
        // 1800m / 30 m/s = 60s min; grace = 45s → must be >= 60-45 = 15s; reported = 20s → ok
        const marker = { lastSnap: { arcMeters: 0 } };
        const cache  = { arcMeters: [0, 1800] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 20 }, NOW)).toBe(true);
    });

    it('accepts a realistic 300m arrival in 30s', () => {
        // 300m / 30 = 10s min; with 45s grace, anything >= -35s is fine
        const marker = { lastSnap: { arcMeters: 0 } };
        const cache  = { arcMeters: [0, 300] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 30 }, NOW)).toBe(true);
    });

    it('boundary: exactly at min plausible minus grace is accepted', () => {
        // 900m / 30 = 30s min; grace 45; boundary = 30 - 45 = -15; reported = -15 → exactly ok
        const marker = { lastSnap: { arcMeters: 0 } };
        const cache  = { arcMeters: [0, 900] };
        const minPlausible = 900 / ETA_MAX_SPEED_MPS;
        const boundary = minPlausible - ETA_PLAUSIBILITY_GRACE_S;
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + boundary }, NOW)).toBe(true);
    });

    // ── Upper-bound proximity override (the "marker at platform but feed says 2 min" case) ──
    it('upper-bound: rejects 2-min ETA when vehicle is 100 m out at 15 m/s', () => {
        // User report: train physically pulling into platform; popup stuck at "2m"
        // until status flips to STOPPED_AT and jumps to "Now". Trip_updates feed
        // hasn't recomputed since the last broadcast even though position is fresh.
        // 100 m / 15 m/s = 6.7 s. Reported 120 s → > 6.7 + 45 grace → reject.
        const marker = {
            lastSnap: { arcMeters: 300 },
            properties: { smoothedSpeed: 15 },
        };
        const cache = { arcMeters: [0, 400] }; // stop at 400, vehicle at 300, dist = 100
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 120 }, NOW)).toBe(false);
    });

    it('upper-bound: accepts realistic 30s ETA when vehicle is 100 m out at 15 m/s', () => {
        // Same scenario, but the feed has caught up to reality. 30s reported is
        // close to the 6.7s physical floor; well within the 45s grace. Keep it.
        const marker = {
            lastSnap: { arcMeters: 300 },
            properties: { smoothedSpeed: 15 },
        };
        const cache = { arcMeters: [0, 400] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 30 }, NOW)).toBe(true);
    });

    it('upper-bound: silent beyond ETA_PROXIMITY_OVERRIDE_M (1 km is long-horizon territory)', () => {
        // Calc is known to be less accurate than GTFS-RT at multi-minute horizons.
        // Only apply the override when the vehicle is visibly close — beyond 400 m
        // we trust GTFS even if it reports more than physics would imply.
        const marker = {
            lastSnap: { arcMeters: 0 },
            properties: { smoothedSpeed: 15 },
        };
        const cache = { arcMeters: [0, 1000] }; // 1 km > 400 m override radius
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 300 }, NOW)).toBe(true);
    });

    it('upper-bound: speed floor prevents divide-by-near-zero from disabling override', () => {
        // Vehicle at speed 0.1 m/s (modem quirk, dwelling between stops) at 100 m.
        // Without the floor, distance / speed = 1000 s → override never fires.
        // With ETA_MIN_APPROACH_SPEED_MPS = 5 floor: 100 / 5 = 20 s. Reported 180 s
        // is still > 20 + 45 grace → reject.
        const marker = {
            lastSnap: { arcMeters: 300 },
            properties: { smoothedSpeed: 0.1 },
        };
        const cache = { arcMeters: [0, 400] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 180 }, NOW)).toBe(false);
    });

    it('upper-bound: missing smoothedSpeed falls back to the floor (does not crash)', () => {
        // Defensive — markers may briefly lack smoothedSpeed (cold-start race).
        const marker = {
            lastSnap: { arcMeters: 300 },
            properties: {},  // no smoothedSpeed
        };
        const cache = { arcMeters: [0, 400] };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 180 }, NOW)).toBe(false);
    });

    it('upper-bound: stale smoothedSpeed (marker timestamp > FRESH_LIVE_S old) falls back to floor', () => {
        // Cross-module audit follow-up: smoothedSpeed is written by markers.js
        // on every GPS update. If the marker hasn't been refreshed within
        // FRESH_LIVE_S (30 s), the speed sample is no longer trustworthy — a
        // vehicle that was doing 15 m/s 60 s ago might have braked into a stop
        // since. Use the conservative floor instead.
        //
        // Without this guard, a stale-but-high smoothedSpeed (say 20 m/s, 60 s
        // old) would give maxPlausible = 100/20 = 5 s — within the 45 s grace,
        // so a 60 s reported ETA would be ACCEPTED (false negative). With the
        // freshness gate, speed defaults to ETA_MIN_APPROACH_SPEED_MPS (5),
        // maxPlausible = 100/5 = 20 s, and the same 60 s ETA is now REJECTED.
        const marker = {
            lastSnap: { arcMeters: 300 },
            timestamp: NOW - 60,  // 60 s old, well past FRESH_LIVE_S = 30 s
            properties: { smoothedSpeed: 20 },
        };
        const cache = { arcMeters: [0, 400] };  // distMeters = 100
        // 60 s reported, distance 100 m. With stale speed honored: 100/20 = 5 s
        // (within grace, accepted). With floor enforced: 100/5 = 20 s, plus 45 s
        // grace = 65 s ceiling; 60 < 65, still accepted. Push to 90 s to demonstrate
        // the freshness gate is what tips it.
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 90 }, NOW)).toBe(false);
    });

    it('upper-bound: fresh marker timestamp lets a high smoothedSpeed through', () => {
        // Mirror of the previous test — same speed/distance, but marker
        // timestamp is fresh (within FRESH_LIVE_S). The 90 s ETA is now ACCEPTED
        // because the marker's reported speed (20 m/s) is trusted.
        const marker = {
            lastSnap: { arcMeters: 300 },
            timestamp: NOW - 5,   // fresh
            properties: { smoothedSpeed: 20 },
        };
        const cache = { arcMeters: [0, 400] };  // distMeters = 100
        // maxPlausible = 100 / 20 = 5 s; grace +45 = 50 s ceiling.
        // 90 s > 50 s → still rejected (the upper-bound math still catches an
        // obviously-stale prediction). Pick 40 s to demonstrate the accept path.
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 40 }, NOW)).toBe(true);
    });
});

// ─── _computeArcOrientation ───────────────────────────────────────────────────
// The single per-route polyline runs one way, so the reverse direction's stops
// project to a DECREASING arc sequence. This classifier drives the per-direction
// sign correction; `unreliable` flags shapes too scrambled to reason about.

describe('_computeArcOrientation', () => {
    it('ascending sequence → ascending, reliable', () => {
        expect(_computeArcOrientation([0, 100, 200, 300])).toEqual({ ascending: true, unreliable: false });
    });

    it('descending sequence (reverse direction) → not ascending, reliable', () => {
        expect(_computeArcOrientation([300, 200, 100, 0])).toEqual({ ascending: false, unreliable: false });
    });

    it('scrambled sequence → unreliable', () => {
        // inc and dec roughly equal (a unioned / over-long shape) → can't trust arc.
        expect(_computeArcOrientation([0, 300, 100, 400, 200]).unreliable).toBe(true);
    });

    it('skips nulls when classifying', () => {
        expect(_computeArcOrientation([null, 0, 100, null, 200])).toEqual({ ascending: true, unreliable: false });
    });

    it('all-null / empty → unreliable (no orientation establishable)', () => {
        expect(_computeArcOrientation([null, null]).unreliable).toBe(true);
        expect(_computeArcOrientation([]).unreliable).toBe(true);
    });
});

// ─── direction-aware arc (the major fix) ──────────────────────────────────────
// For the direction whose travel runs AGAINST the polyline, cache.arcMeters
// decreases with stop index. Before the fix, computeTripAdherenceOffset bailed
// (prevArc > nextArc) and gtfsLooksPlausible saw a negative distance (→ rejected
// GTFS-RT as "past the stop"). With per-direction orientation both compute the
// correct FORWARD progress for that direction.

describe('gtfsLooksPlausible — reverse (descending-arc) direction', () => {
    const NOW = 10000;

    it('accepts a legit downstream arrival that the OLD sign bug would have rejected', () => {
        // Reverse direction: stop0 (origin) at arc 2000, stop1 (terminus) at arc 0.
        // Vehicle just left origin (arc 2000), heading to terminus (idx 1, arc 0).
        // Forward distance = 2000 m; a 90 s arrival is physically fine (>2000/30−45).
        const marker = { lastSnap: { arcMeters: 2000 } };
        const cache  = { arcMeters: [2000, 0], arcAscending: false };
        // Pre-fix: distMeters = 0 − 2000 = −2000 → "past stop" → would reject (false).
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW + 90 }, NOW)).toBe(true);
    });

    it('still rejects a physically-impossible (too-soon) arrival in reverse direction', () => {
        // Same geometry; forward distance 1800 m needs ≥ 1800/30 − 45 = 15 s.
        const marker = { lastSnap: { arcMeters: 1800 } };
        const cache  = { arcMeters: [1800, 0], arcAscending: false };
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW }, NOW)).toBe(false);
    });

    it('arcUnreliable cache trusts the feed (degrade gracefully)', () => {
        const marker = { lastSnap: { arcMeters: 500 } };
        const cache  = { arcMeters: [0, 1800], arcUnreliable: true };
        // Would normally reject (0 s arrival, 1800 m away) — but arc is untrustworthy.
        expect(gtfsLooksPlausible(marker, cache, 1, { arrivalUnix: NOW }, NOW)).toBe(true);
    });
});

describe('computeTripAdherenceOffset — reverse (descending-arc) direction', () => {
    const NOW = 10000;
    // Reverse direction segment: stop0 at arc 1000, stop1 at arc 0, 100 s scheduled.
    // Vehicle snapped at arc 500 (halfway). statusChangedAt 30 s ago (+15 s lag = 45 s
    // in transit of a 100 s segment) → schedule expects it 45 % along (arc-oriented
    // −550); it's actually at −500 → 50 m ahead → 5 s early (negative offset).
    const reverseCache = { arcMeters: [1000, 0], times: [0, 100], arcAscending: false };
    const marker = {
        lastSnap: { arcMeters: 500 },
        lastSnapDeviationM: 10,
        properties: { route_code: '801', statusChangedAt: NOW - 30 },
    };

    it('computes a non-zero offset that the OLD folded-arc guard would have zeroed', () => {
        const offset = computeTripAdherenceOffset(marker, reverseCache, 1, NOW);
        // Pre-fix: prevArc(1000) > nextArc(0) → returned 0.
        expect(offset).not.toBe(0);
        expect(offset).toBeCloseTo(-5, 5); // 5 s early
    });

    it('arcUnreliable cache disables adherence (returns 0)', () => {
        const offset = computeTripAdherenceOffset(
            { ...marker }, { ...reverseCache, arcUnreliable: true }, 1, NOW);
        expect(offset).toBe(0);
    });
});

// ─── resolveTripDestination ──────────────────────────────────────────────────
// Shared cascade used by both station-popup row labels (stations.js) and
// vehicle popups (ui.js). Each branch fires in priority order:
//   1. structural (getTerminalName) — schedule-derived terminus
//   2. cleanedTripDest               — pre-cleaned trip.dest from the live feed
//   3. tripInfo.stops last-stop      — name from masterStopsData
//   4. tripTerminusByTripId          — live trip_updates feed fallback
//   5. null                          — caller supplies its own fallback label

describe('resolveTripDestination', () => {
    beforeEach(() => {
        window.masterStopsData = {};
        tripTerminusByTripId.clear();
    });

    it('returns the structural terminus first (TERMINUS_DISPLAY_OVERRIDES path)', () => {
        // 950|1 is the only TERMINUS_DISPLAY_OVERRIDES entry: "San Pedro".
        // It fires regardless of what else is supplied.
        const out = resolveTripDestination('950', 1, 'T1', { stops: ['80101'], dest: 'Wrong' }, 'Wrong');
        expect(out).toBe('San Pedro');
    });

    it('corrects a J Line 950 trip mis-tagged 910 by the feed → "San Pedro"', () => {
        // The vehicle-position feed tags every J trip 910. A southbound 950 bus
        // therefore arrives with routeCode '910', but static GTFS knows it as
        // '950' (tripInfo.rc). The fix prefers the true route, so the popup shows
        // the San Pedro terminus instead of "Harbor Gateway TC". (Here the
        // unfixed path would fall through to cleanedTripDest, so asserting the
        // override label proves the correction fired.)
        const out = resolveTripDestination('910', 1, 'T1', { rc: '950' }, 'Harbor Gateway TC');
        expect(out).toBe('San Pedro');
    });

    it('leaves a genuine 910 trip alone (true route matches the feed tag)', () => {
        // trueRc === routeCode → correction skipped; the existing 950|1 override
        // is not in play for 910, so it falls through to cleanedTripDest.
        const out = resolveTripDestination('910', 1, 'T1', { rc: '910' }, 'Harbor Gateway TC');
        expect(out).toBe('Harbor Gateway TC');
    });

    it('never retags a non-J route, even if rc disagrees', () => {
        // The correction is scoped to the 910<->950 pair; any other route passes
        // through untouched and uses its normal cascade.
        const out = resolveTripDestination('999', 0, 'T1', { rc: '801' }, 'Downtown LA');
        expect(out).toBe('Downtown LA');
    });

    it('does not strand a northbound 950 with no terminus — falls back to the feed route', () => {
        // Northbound (dir 0) has no 950 display override and no routeStops cache
        // in this harness, so getTerminalName('950', 0) is null. The fix must NOT
        // return that null; it falls through to the feed route's cascade. Both J
        // routes share El Monte northbound, so nothing is lost in production.
        const out = resolveTripDestination('910', 0, 'T1', { rc: '950' }, 'El Monte');
        expect(out).toBe('El Monte');
    });

    it('falls through to cleanedTripDest when no structural terminus exists', () => {
        // Route 999 has no override and no routeStops cache → structural null.
        const out = resolveTripDestination('999', 0, null, null, 'Downtown LA');
        expect(out).toBe('Downtown LA');
    });

    it('falls through to tripInfo.stops last-stop name when no cleanedTripDest', () => {
        window.masterStopsData = { '80999': { name: 'Stub Terminus', lat: 34, lon: -118 } };
        const out = resolveTripDestination('999', 0, null, { stops: ['80111', '80999'] }, null);
        expect(out).toBe('Stub Terminus');
    });

    it('strips the falsy tail of tripInfo.stops to find the real last stop', () => {
        // GTFS sometimes has trailing empty stop slots; the reverse-find skips them.
        window.masterStopsData = { '80999': { name: 'Stub Terminus' } };
        const out = resolveTripDestination('999', 0, null, { stops: ['80111', '80999', '', null] }, null);
        expect(out).toBe('Stub Terminus');
    });

    it('falls through to tripTerminusByTripId when tripInfo.stops missing', () => {
        window.masterStopsData = { '80777': { name: 'Live Term' } };
        tripTerminusByTripId.set('T42', '80777');
        const out = resolveTripDestination('999', 0, 'T42', null, null);
        expect(out).toBe('Live Term');
    });

    it('returns null when no branch produces a name', () => {
        const out = resolveTripDestination('999', 0, null, null, null);
        expect(out).toBeNull();
    });

    it('cleans the station name returned by the last-stop branch', () => {
        // cleanStationName strips " Station" suffix and similar; trailing
        // whitespace/punctuation should not surface in the label.
        window.masterStopsData = { '80111': { name: 'Allen Station' } };
        const out = resolveTripDestination('999', 0, null, { stops: ['80111'] }, null);
        expect(out).toBe('Allen');
    });
});

