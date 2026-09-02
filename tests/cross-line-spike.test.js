/**
 * Tests for isOnDifferentLine() — the cross-line spike guard in markers.js.
 *
 * "A vehicle cannot be on a different line." A purely geometric reject: when a
 * GPS fix is clearly OFF the vehicle's own rail line yet snaps cleanly onto a
 * DIFFERENT, non-interlined rail line, the fix is dropped (it would draw the
 * marker on the wrong line). Interlined pairs share track and are exempt:
 *   A(801) ↔ E(804), B(802) ↔ D(805), C(803) ↔ K(807).
 *
 * snap.js is mocked so each route reports a controlled snap distance from the
 * query point; planarMeters / isHeavyRail are the real implementations.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));
vi.mock('../js/predictions.js', () => ({
    getTerminalStopId: vi.fn(() => null), getSecondsToNextStop: vi.fn(() => null),
    getScheduledArrivals: vi.fn(() => []), isOriginStop: vi.fn(() => false),
    isAtOwnOriginStop: vi.fn(() => false), getRouteCache: vi.fn(() => null),
    findIdx: vi.fn(() => -1),
}));

// Per-route snap distance (metres) from the query point. A route absent from the
// map has no shape data. The mock builds a snapped point at the configured
// distance by offsetting latitude (1° lat ≈ 110_540 m), so the REAL planarMeters
// recovers that distance.
const _snapDist = {};
vi.mock('../js/snap.js', () => ({
    hasShapeData: rc => _snapDist[rc] !== undefined,
    snapToRoute: (rc, lng, lat) => {
        const d = _snapDist[rc];
        if (d === undefined) return null;
        return { snappedLat: lat + d / 110_540, snappedLng: lng, arcMeters: 0, tangentForward: 0 };
    },
    lngLatAtArc: vi.fn(() => null),
}));

import { isOnDifferentLine } from '../js/markers.js';

const veh = rc => ({ properties: { route_code: rc }, geometry: { coordinates: [-118.2, 34.0] } });
const LNG = -118.2, LAT = 34.0;

beforeEach(() => {
    for (const k of Object.keys(_snapDist)) delete _snapDist[k];
    // Default: every rail line has shape data, all far away unless overridden.
    for (const rc of ['801', '802', '803', '804', '805', '807']) _snapDist[rc] = 9999;
});

describe('isOnDifferentLine — accepts own-line and interlined fixes', () => {
    it('returns false when the fix is on the vehicle\'s own line (within tolerance)', () => {
        _snapDist['801'] = 50; // A Line snap 50 m < RAIL_SNAP_MAX_M (150)
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(false);
    });

    it('returns false on an interlined partner\'s shared track (A off-own but on E)', () => {
        _snapDist['801'] = 300; // off A's own line
        _snapDist['804'] = 40;  // but on E — interlined with A → exempt
        // every other line far (9999)
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(false);
    });

    it('returns false for B(802) off-own but on its interline partner D(805)', () => {
        _snapDist['802'] = 400; // off B (heavy-rail max 250)
        _snapDist['805'] = 30;  // on D — interlined with B → exempt
        expect(isOnDifferentLine(veh('802'), LNG, LAT)).toBe(false);
    });

    it('returns false when generically off-route (near no other line)', () => {
        _snapDist['801'] = 300; // off A
        // all others remain 9999 → not on any line, just off-route
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(false);
    });

    it('accepts a couplet fix that is far from the BARE shape but near its split (rc|0)', () => {
        // Long Beach one-way couplet: dir-0 A-Line train is hundreds of metres
        // from the bare (canonical-direction) 801 shape but ON its own 801|0
        // split. Own-line distance is the MIN over bare+splits, so the guard
        // must not flag it — even though a stray 803 is nearby.
        _snapDist['801']   = 400; // far from canonical-direction shape
        _snapDist['801|0'] = 40;  // but on its own non-canonical-direction split
        _snapDist['803']   = 120; // C Line incidentally near — must NOT win
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(false);
    });
});

describe('isOnDifferentLine — rejects cross-line fixes', () => {
    it('returns true when A(801) is off its own line but clean on C(803)', () => {
        _snapDist['801'] = 300; // off A
        _snapDist['803'] = 40;  // on C — NOT interlined with A → reject
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(true);
    });

    it('returns true for heavy-rail B(802) off-own but on non-interlined C(803)', () => {
        _snapDist['802'] = 300; // off B (> heavy max 250)
        _snapDist['803'] = 100; // on C (< 150) and closer than own → reject
        expect(isOnDifferentLine(veh('802'), LNG, LAT)).toBe(true);
    });

    it('uses the OTHER line\'s tolerance — a 140 m C snap counts as on-C', () => {
        _snapDist['801'] = 300;
        _snapDist['803'] = 140; // < RAIL_SNAP_MAX_M (150)
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(true);
    });

    it('does NOT flag when the nearest other line is still beyond tolerance', () => {
        _snapDist['801'] = 300;
        _snapDist['803'] = 160; // > 150 → not "on" C
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(false);
    });
});

describe('isOnDifferentLine — non-rail and missing-data guards', () => {
    it('returns false for a bus route (no cross-line concept)', () => {
        _snapDist['2'] = 5; // a bus snap, but 2 is not a rail line code
        expect(isOnDifferentLine(veh('2'), LNG, LAT)).toBe(false);
    });

    it('returns false for BRT (910 / J Line) even though it has a shape', () => {
        _snapDist['910'] = 5;
        expect(isOnDifferentLine(veh('910'), LNG, LAT)).toBe(false);
    });

    it('returns false when the vehicle\'s own line has no shape data', () => {
        delete _snapDist['801'];
        expect(isOnDifferentLine(veh('801'), LNG, LAT)).toBe(false);
    });

    it('accepts a numeric route_code (String-cast at the boundary)', () => {
        _snapDist['801'] = 300;
        _snapDist['803'] = 40;
        expect(isOnDifferentLine({ properties: { route_code: 801 }, geometry: { coordinates: [LNG, LAT] } }, LNG, LAT)).toBe(true);
    });
});
