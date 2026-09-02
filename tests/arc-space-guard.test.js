/**
 * Arc-space guard (the "fly" fix). `_currentArc` is an arc length in a SPECIFIC
 * shape's coordinate space (`marker._currentArcKey`). `resolveShapeKey` returns
 * the generic shape (`RC`) for direction_id null/1 but a per-direction shape
 * (`RC|0`) for dir 0, and Metro's per-direction polylines are built REVERSED —
 * so when direction_id flips or populates after load, `fromArc` lands in the
 * wrong space and the glide would sweep most of the line (the fly). The guard
 * detects the cross-space arc and hard-reanchors to the fresh snap on the new
 * shape instead of gliding from a meaningless `fromArc`.
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

import { markers, _applyVelocityCorrections } from '../js/markers.js';
import { makeMarker, makeFeature } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import { shapeData, precomputeRoute, lngLatAtArc } from '../js/snap.js';

const M_PER_DEG_LAT = 110_540;
const RC = 'AS_GENERIC';     // generic shape (arc 0 = south)
const RC0 = 'AS_GENERIC|0';  // per-direction shape, REVERSED (arc 0 = north)

// 30-vertex N-S route (~2.9 km). RC ascends northward; RC|0 is the SAME track
// reversed, so a physical point near RC arc 0 sits near RC|0 arc L.
function buildRoutes() {
    const DEG = 100 / M_PER_DEG_LAT;
    const pts = Array.from({ length: 30 }, (_, i) => [34.0 + i * DEG, -118.2]);
    shapeData[RC] = pts; precomputeRoute(RC, pts);
    const rev = [...pts].reverse();
    shapeData[RC0] = rev; precomputeRoute(RC0, rev);
}

let _rafQueue;
beforeEach(() => {
    installGlobals();
    buildRoutes();
    for (const k of Object.keys(markers)) delete markers[k];
    _rafQueue = new Map();
    let id = 1;
    vi.stubGlobal('requestAnimationFrame', (cb) => { _rafQueue.set(id, cb); return id++; });
    vi.stubGlobal('cancelAnimationFrame', (i) => { _rafQueue.delete(i); });
    vi.spyOn(performance, 'now').mockImplementation(() => 0);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function runFrame({ key = 'AS-1', currentArc, currentArcKey, snapArc, dir,
                   markerDir = dir, lastKnownDir }) {
    const ptFrom = lngLatAtArc(currentArcKey || RC0, currentArc);
    const ptTo   = lngLatAtArc(RC0, snapArc);
    const marker = makeMarker({ tripId: key, routeCode: RC, speed: 12, lastSnap: { arcMeters: snapArc },
                                directionId: markerDir });
    marker._currentArc = currentArc;
    marker._currentArcKey = currentArcKey;
    if (lastKnownDir !== undefined) marker._lastKnownDir = lastKnownDir;
    marker.setLngLat([ptFrom.lng, ptFrom.lat]);
    marker._targetLng = ptTo.lng;
    marker._targetLat = ptTo.lat;
    markers[key] = marker;
    const newTs = Math.floor(Date.now() / 1000);
    const vehicle = makeFeature({ tripId: key, routeCode: RC, lngLat: [ptTo.lng, ptTo.lat], timestamp: newTs, speed: 12, directionId: dir });
    _applyVelocityCorrections(marker, vehicle, key, newTs - 5, false, false);
    return marker;
}

describe('arc-space guard', () => {
    it('re-anchors (no cross-space glide) when _currentArc was committed under a DIFFERENT shape key', () => {
        // Marker physically near the SOUTH end, arc committed under generic RC
        // (arc ~200). This frame is dir 0 → shape resolves to RC|0 (reversed),
        // where the true snap of that same physical point is near arc L (~2700).
        // Without the guard, arcGlide(200 → 2700) on RC|0 flies the whole line.
        const m = runFrame({ currentArc: 200, currentArcKey: RC, snapArc: 2700, dir: 0 });
        // Re-anchor is synchronous: _currentArc jumps straight to the snap, the
        // key is corrected to the new space, and NO glide animation is queued.
        expect(m._currentArc).toBe(2700);
        expect(m._currentArcKey).toBe(RC0);
        expect(_rafQueue.size).toBe(0);   // a glide would have queued a rAF tick
    });

    it('glides normally when the committed key MATCHES the frame shape (no false re-anchor)', () => {
        // Same shape both sides → no mismatch → ordinary short glide.
        const m = runFrame({ currentArc: 2600, currentArcKey: RC0, snapArc: 2700, dir: 0 });
        expect(m._currentArc).toBe(2600);   // still at fromArc; glide queued, not teleported
        expect(_rafQueue.size).toBeGreaterThan(0);
    });

    it('does not re-anchor a fresh marker whose arc key is unset', () => {
        const m = runFrame({ currentArc: 2600, currentArcKey: undefined, snapArc: 2700, dir: 0 });
        expect(_rafQueue.size).toBeGreaterThan(0);   // null key ⇒ no mismatch ⇒ glide
        expect(m._currentArc).toBe(2600);
    });
});

/**
 * The direction fallback that keeps the arc space alive across a run of
 * direction-less frames (R9-05, PR #597).
 *
 * `_markerShapeKey` coalesces the frame's `direction_id` with the marker's
 * `_lastKnownDir` — a field updated ONLY on non-null-direction frames. It
 * deliberately does NOT fall back to `marker.properties.direction_id`, because
 * that one is nulled on every direction-less frame so the popup column reflects
 * the current frame. Using it as the memory erases itself after a single null
 * frame.
 *
 * CLAUDE.md says "Do NOT 'simplify' the fallback back to
 * marker.properties.direction_id — that reintroduces the bug", and yet deleting
 * the fallback outright left the whole suite green. The cost of that gap is the
 * historical "fly": on a split route the bare and per-direction polylines are
 * built in REVERSED order, so resolving the bare key mid-run puts `fromArc` in
 * the wrong space and the marker sweeps most of the line — twice, on the way
 * out and back.
 */
describe('_lastKnownDir keeps the arc space through null-direction frames', () => {
    it('holds the per-direction shape when the frame omits direction_id', () => {
        // The state a run of direction-less frames actually produces: the
        // marker's OWN direction_id has already been nulled, and only
        // _lastKnownDir still remembers this trip is dir 0.
        const m = runFrame({
            currentArc: 2600, currentArcKey: RC0, snapArc: 2700,
            dir: null, markerDir: null, lastKnownDir: 0,
        });
        // Same arc space on both sides ⇒ ordinary glide. Reading the nulled
        // properties.direction_id instead would resolve the BARE key, read as a
        // shape-key mismatch, and hard-reanchor.
        expect(m._currentArc, 'must still be gliding from its committed arc').toBe(2600);
        expect(_rafQueue.size, 'a teleport here is the "fly" bug').toBeGreaterThan(0);
    });

    it('survives TWO consecutive null-direction frames', () => {
        // One null frame was already survivable via the old fallback; it is the
        // SECOND that flipped the arc space, which is why the memory has to be
        // a separate field rather than the per-frame property.
        let m;
        for (let i = 0; i < 2; i++) {
            m = runFrame({
                key: 'AS-RUN', currentArc: 2600, currentArcKey: RC0, snapArc: 2700,
                dir: null, markerDir: null, lastKnownDir: 0,
            });
        }
        expect(m._currentArc).toBe(2600);
        expect(_rafQueue.size).toBeGreaterThan(0);
    });

    it('still re-anchors when the direction genuinely CHANGES (not a false hold)', () => {
        // The memory must not outrank a real direction the frame declares —
        // otherwise it would suppress the arc-space guard it exists to support.
        const m = runFrame({
            currentArc: 200, currentArcKey: RC, snapArc: 2700,
            dir: 0, markerDir: null, lastKnownDir: 1,
        });
        expect(m._currentArcKey).toBe(RC0);
        expect(_rafQueue.size, 'a declared direction still wins').toBe(0);
    });

    it('falls back to the bare space when direction was never known', () => {
        // A marker with no direction memory at all resolves the bare key, which
        // is the documented pre-split behaviour — not a crash, not a hold.
        const m = runFrame({
            currentArc: 2600, currentArcKey: RC, snapArc: 2700,
            dir: null, markerDir: null, lastKnownDir: null,
        });
        expect(m._currentArc, 'bare key matches the committed bare key ⇒ glide').toBe(2600);
        expect(_rafQueue.size).toBeGreaterThan(0);
    });
});
