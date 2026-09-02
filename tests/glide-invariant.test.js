/**
 * The motion model's CRITICAL INVARIANT (CLAUDE.md): the marker is bound
 * between two known GPS positions — it NEVER moves past the latest GPS fix,
 * cannot extrapolate, cannot overshoot. Until now this was pinned only by
 * prose; these tests drive the real arcGlide / animateMarker easing loops with
 * a stubbed requestAnimationFrame + performance.now clock and assert it
 * numerically, tick by tick:
 *
 *   1. every intermediate position stays within [fromArc, toArc] — no
 *      overshoot past the fix, no backward excursion behind the start;
 *   2. progress is monotone (the easing never reverses);
 *   3. the FINAL tick lands exactly ON the fix (lngLatAtArc(toArc) — via glide
 *      or the t=1 hard set), so the dot can never end a cycle disagreeing with
 *      its own popup label;
 *   4. an interrupted glide (next WS frame mid-flight) hands off from the
 *      marker's current visual arc (_currentArc) — no jump — and the SECOND
 *      glide still lands exactly on the newer fix, never past it;
 *   5. the bus straight-line glide (animateMarker) obeys the same bounds.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
    // markers.js imports this for the marker accessible name (R6-02); a mock
    // missing it fails the module load, not the assertion.
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

// Route cache: ascending, reliable — keeps the jitter-hold out of the way so
// these tests exercise ONLY the glide kinematics.
vi.mock('../js/predictions.js', async (importActual) => {
    const actual = await importActual();
    return {
        findIdx: actual.findIdx,
        getRouteCache: vi.fn(() => ({ arcAscending: true, arcUnreliable: false, stops: [], arcMeters: [] })),
        getTerminalStopId: vi.fn(() => null),
        getSecondsToNextStop: vi.fn(() => null),
        getScheduledArrivals: vi.fn(() => []),
        isOriginStop: vi.fn(() => false),
        isAtOwnOriginStop: vi.fn(() => false),
    };
});

import { markers, _applyVelocityCorrections, _cancelGlide } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import { shapeData, precomputeRoute, lngLatAtArc } from '../js/snap.js';

const RC = 'GLIDE_INV_TEST';
const M_PER_DEG_LAT = 110_540; // matches buildRoute's spacing constant

// Straight N-S route, ~100 m per vertex, 30 vertices (~2.9 km). Arc increases
// northward, so a marker's arc position can be recovered from its latitude.
function buildRoute() {
    const DEG = 100 / M_PER_DEG_LAT;
    const pts = Array.from({ length: 30 }, (_, i) => [34.0 + i * DEG, -118.2]); // [lat,lng]
    shapeData[RC] = pts;
    precomputeRoute(RC, pts);
}

const latToArc = (lat) => (lat - 34.0) * M_PER_DEG_LAT;

// ── Deterministic rAF + clock ────────────────────────────────────────────────
// requestAnimationFrame callbacks queue here; step(dt) advances the virtual
// clock and runs everything queued BEFORE the step (snapshot semantics — a
// callback re-arming itself lands in the NEXT step, like real frames).
let _now;
let _nextRafId;
let _rafQueue; // Map<id, cb>

function step(dtMs) {
    _now += dtMs;
    const batch = [..._rafQueue.entries()];
    _rafQueue.clear();
    for (const [, cb] of batch) cb(_now);
}

beforeEach(() => {
    installGlobals();
    buildRoute();
    for (const k of Object.keys(markers)) delete markers[k];
    _now = 0;
    _nextRafId = 1;
    _rafQueue = new Map();
    vi.stubGlobal('requestAnimationFrame', (cb) => { const id = _nextRafId++; _rafQueue.set(id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (id) => { _rafQueue.delete(id); });
    vi.spyOn(performance, 'now').mockImplementation(() => _now);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// Place a marker visually at fromArc with an accepted fix at toArc, run one
// _applyVelocityCorrections frame (gap-matched glideMs = gapS * 1000), and
// return the marker. The glide is now queued on the stubbed rAF.
function startGlide({ key = 'G-1', fromArc, toArc, gapS = 10, speed = 12 }) {
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
    _applyVelocityCorrections(marker, vehicle, key, newTs - gapS, false, false);
    return marker;
}

describe('arcGlide — never past the latest GPS fix', () => {
    it('every tick stays within [fromArc, toArc], progress is monotone, and the final tick lands EXACTLY on the fix', () => {
        const fromArc = 200, toArc = 900, gapS = 10; // glideMs = 10_000
        const marker = startGlide({ fromArc, toArc, gapS });
        expect(_rafQueue.size).toBe(1); // glide armed

        let prevArc = fromArc;
        // 16 ms frames across the whole 10 s glide, plus margin past the end.
        for (let i = 0; i < Math.ceil(10_000 / 16) + 5 && _rafQueue.size > 0; i++) {
            step(16);
            const arc = latToArc(marker.getLngLat().lat);
            // (1) bounded: never past the fix, never behind the start
            expect(arc).toBeLessThanOrEqual(toArc + 1e-6);
            expect(arc).toBeGreaterThanOrEqual(fromArc - 1e-6);
            // (2) monotone: the easing never reverses
            expect(arc).toBeGreaterThanOrEqual(prevArc - 1e-6);
            prevArc = arc;
        }
        // (3) glide complete — the marker sits EXACTLY on lngLatAtArc(toArc)
        expect(_rafQueue.size).toBe(0);
        const end = lngLatAtArc(RC, toArc);
        expect(marker.getLngLat().lat).toBe(end.lat);
        expect(marker.getLngLat().lng).toBe(end.lng);
        expect(marker._currentArc).toBe(toArc);
        expect(marker._animateMarkerOnComplete).toBeUndefined(); // onComplete consumed
    });

    it('a glide interrupted by the next WS frame hands off from _currentArc and lands exactly on the NEWER fix', () => {
        const marker = startGlide({ key: 'G-2', fromArc: 100, toArc: 1000, gapS: 10 });

        // Advance 4 s into the 10 s glide (cubic ease-in → well short of halfway).
        for (let i = 0; i < 250; i++) step(16);
        const midArc = latToArc(marker.getLngLat().lat);
        expect(midArc).toBeGreaterThan(100);
        expect(midArc).toBeLessThan(1000);
        expect(marker._currentArc).toBeCloseTo(midArc, 6);

        // Next WS frame arrives mid-flight: production cancels the in-flight
        // glide (updateExistingMarker → _cancelGlide) and starts a fresh one
        // from the marker's current VISUAL arc toward the newer fix.
        _cancelGlide('G-2');
        const newToArc = 1400;
        const ptTo = lngLatAtArc(RC, newToArc);
        marker.lastSnap = { arcMeters: newToArc };
        marker._targetLng = ptTo.lng;
        marker._targetLat = ptTo.lat;
        const newTs = Math.floor(Date.now() / 1000);
        const vehicle = makeFeature({ tripId: 'G-2', routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed: 12 });
        _applyVelocityCorrections(marker, vehicle, 'G-2', newTs - 10, false, false);

        // (4) handoff: the new glide starts at the interrupted visual position —
        // the very first tick must not jump (within one 16 ms frame's motion).
        step(16);
        const handoffArc = latToArc(marker.getLngLat().lat);
        expect(Math.abs(handoffArc - midArc)).toBeLessThan(5);

        let prevArc = handoffArc;
        for (let i = 0; i < Math.ceil(10_000 / 16) + 5 && _rafQueue.size > 0; i++) {
            step(16);
            const arc = latToArc(marker.getLngLat().lat);
            expect(arc).toBeLessThanOrEqual(newToArc + 1e-6); // still never past the fix
            expect(arc).toBeGreaterThanOrEqual(prevArc - 1e-6);
            prevArc = arc;
        }
        const end = lngLatAtArc(RC, newToArc);
        expect(marker.getLngLat().lat).toBe(end.lat);
        expect(marker._currentArc).toBe(newToArc);
    });
});

describe('arcGlide — easing velocity continuity (the cubic-in/quad-out kink)', () => {
    it('on-screen speed has NO discontinuity at the glide midpoint', () => {
        // The easing used to be cubic-IN / QUADRATIC-out: position-continuous
        // but with a velocity kink at t=0.5 — an instantaneous 33 % speed drop
        // (normalized derivative 3.0 → 2.0) on EVERY glide, visible as a
        // mid-glide lurch. True cubic-in-out is C1 (derivative 3.0 on both
        // sides of the midpoint). Pin it numerically: with fixed 16 ms steps,
        // consecutive per-step arc deltas around the midpoint must change
        // smoothly (< 5 % step-to-step) — the old kink showed up as a single
        // ~33 % drop between adjacent steps.
        const fromArc = 100, toArc = 800, gapS = 10; // 10 s glide, 625 steps
        const marker = startGlide({ key: 'EK-1', fromArc, toArc, gapS });

        const arcs = [latToArc(marker.getLngLat().lat)];
        const totalSteps = Math.ceil(10_000 / 16);
        for (let i = 0; i < totalSteps && _rafQueue.size > 0; i++) {
            step(16);
            arcs.push(latToArc(marker.getLngLat().lat));
        }

        // Per-step velocities in the middle band (t ∈ ~[0.4, 0.6]) where the
        // kink lived. Skip the extremes (deltas → 0 there, ratios degenerate).
        const lo = Math.floor(totalSteps * 0.4), hi = Math.ceil(totalSteps * 0.6);
        for (let i = lo + 1; i < hi; i++) {
            const d1 = arcs[i] - arcs[i - 1];
            const d2 = arcs[i + 1] - arcs[i];
            expect(d1).toBeGreaterThan(0);
            const ratio = d2 / d1;
            expect(Math.abs(ratio - 1), `velocity step at frame ${i}: ${d1.toFixed(3)} → ${d2.toFixed(3)} m/frame`).toBeLessThan(0.05);
        }
    });
});

describe('animateMarker (bus straight-line) — same bounds', () => {
    const BUS_RC = '720'; // no shape data → straight-line branch

    it('never overshoots the target and lands exactly on it', () => {
        const DEG_PER_M = 1 / M_PER_DEG_LAT;
        const fromLat = 34.0, toLat = 34.0 + 600 * DEG_PER_M; // 600 m move
        const marker = makeMarker({ tripId: 'B-1', routeCode: BUS_RC, lngLat: [-118.2, fromLat], speed: 12 });
        markers['B-1'] = marker;
        // _applySnap normally writes these per frame: _target* is THIS frame's
        // glide target, _prevTarget* the previous accepted one (the speed gate
        // measures the real inter-fix move: 600 m / 60 s = 10 m/s — plausible).
        marker._prevTargetLng = -118.2;
        marker._prevTargetLat = fromLat;
        marker._targetLng = -118.2;
        marker._targetLat = toLat;
        const newTs = Math.floor(Date.now() / 1000);
        const vehicle = makeFeature({ tripId: 'B-1', routeCode: BUS_RC, lngLat: [-118.2, toLat], timestamp: newTs, speed: 12 });
        _applyVelocityCorrections(marker, vehicle, 'B-1', newTs - 60, false, false);
        expect(_rafQueue.size).toBe(1); // glided, not teleported

        let prevLat = fromLat;
        for (let i = 0; i < Math.ceil(60_000 / 16) + 5 && _rafQueue.size > 0; i++) {
            step(16);
            const lat = marker.getLngLat().lat;
            expect(lat).toBeLessThanOrEqual(toLat + 1e-12);  // (5) never past the fix
            expect(lat).toBeGreaterThanOrEqual(prevLat - 1e-12);
            prevLat = lat;
        }
        expect(_rafQueue.size).toBe(0);
        expect(marker.getLngLat().lat).toBeCloseTo(toLat, 12);
    });
});

// The glide tests above prove the kinematics; these pin the OTHER branch — the
// hard re-anchor (teleport) that fires when the gap from the last ACCEPTED fix
// exceeds GLIDE_MAX_MS (a jump no glide duration can honestly show). Previously
// only the glide path was exercised; the teleport decision had no test.
describe('arcGlide — hard re-anchor (teleport) past GLIDE_MAX_MS', () => {
    it('GLIDES for a gap within GLIDE_MAX_MS (60 s)', () => {
        const marker = startGlide({ key: 'TP-1', fromArc: 100, toArc: 900, gapS: 30 });
        expect(_rafQueue.size).toBe(1);                              // glide armed, not teleport
        expect(latToArc(marker.getLngLat().lat)).toBeCloseTo(100, 0); // still at the start
        expect(marker._currentArc).not.toBe(900);
    });

    it('TELEPORTS (no glide) for a gap exceeding GLIDE_MAX_MS', () => {
        const marker = startGlide({ key: 'TP-2', fromArc: 100, toArc: 900, gapS: 90 });
        const end = lngLatAtArc(RC, 900);
        expect(_rafQueue.size).toBe(0);                  // no glide — hard re-anchor
        expect(marker._currentArc).toBe(900);            // jumped straight onto the fix
        expect(marker.getLngLat().lat).toBeCloseTo(end.lat, 6);
    });

    it('measures the gap from the last ACCEPTED fix, not marker.timestamp (rejected-frame split)', () => {
        // A rejected frame bumped marker.timestamp to ~now, but the last ACCEPTED
        // fix was 90 s ago. The teleport test keys off the accepted-fix clock
        // (prevAcceptedTs) — otherwise a ~70-90 s real gap split by one rejected
        // frame would fake-glide across the blackout instead of teleporting.
        const fromArc = 100, toArc = 900, key = 'TP-3';
        const ptFrom = lngLatAtArc(RC, fromArc);
        const ptTo   = lngLatAtArc(RC, toArc);
        const marker = makeMarker({ tripId: key, routeCode: RC, speed: 12, lastSnap: { arcMeters: toArc } });
        marker._currentArc = fromArc;
        marker.setLngLat([ptFrom.lng, ptFrom.lat]);
        marker._targetLng = ptTo.lng;
        marker._targetLat = ptTo.lat;
        markers[key] = marker;
        const newTs = Math.floor(Date.now() / 1000);
        marker.timestamp = newTs - 5;   // bumped by a RECENT rejected frame
        const vehicle = makeFeature({ tripId: key, routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed: 12 });
        _applyVelocityCorrections(marker, vehicle, key, newTs - 90, false, false); // last ACCEPTED 90 s ago
        expect(_rafQueue.size).toBe(0);        // teleported — used the 90 s accepted gap
        expect(marker._currentArc).toBe(900);
    });
});
