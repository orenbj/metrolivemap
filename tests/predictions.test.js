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
        // Feed says arrived 60s ago. Consistent → plausible.
        const marker = { lastSnap: { arcMeters: 500 } };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW - 60 }, NOW)).toBe(true);
    });

    it('rejects future-arrival when vehicle is clearly past the stop', () => {
        // vehicle 100m downstream but feed still claims arrival in 2 min —
        // classic stale-feed / snap-lag pattern. Without the gate the popup
        // would render "2 min" for a train already pulling out of the station.
        const marker = { lastSnap: { arcMeters: 500 } };
        const cache  = { arcMeters: [400] };
        expect(gtfsLooksPlausible(marker, cache, 0, { arrivalUnix: NOW + 120 }, NOW)).toBe(false);
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

