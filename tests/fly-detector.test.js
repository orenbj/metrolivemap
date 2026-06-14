/**
 * Tests for the fly detector (_recordFly in markers.js) — the observability
 * hook that captures rail arc-glides whose implied on-screen speed is
 * physically impossible (a "fly"). Pins the speed threshold and the
 * keyMismatch flag, since post-hoc diagnosis reads exactly those fields out
 * of the mlm_flyLog ring.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _recordFly } from '../js/markers.js';

const RING = 'mlm_flyLog';
const ring = () => { const r = localStorage.getItem(RING); return r ? JSON.parse(r) : []; };
const veh = (props = {}) => ({ properties: { route_code: '801', direction_id: 0, trip_id: 'T', vehicle_id: 'V', ...props } });

// glideMs chosen so the implied speed lands above/below the 60 m/s threshold.
// arcGap / (glideMs/1000) = implied m/s.
describe('fly detector', () => {
    beforeEach(() => { localStorage.removeItem(RING); localStorage.removeItem('mlm_debug_fly'); });

    it('records a fly when implied on-screen speed is impossible (huge arc, tiny gap)', () => {
        // 25 km arc in a 5 s glide → 5000 m/s. Long Beach-area → Union-style fly.
        _recordFly({ _currentArcKey: '801', lastSnapDeviationM: 12 }, veh(), {
            shapeKey: '801', fromArc: 5000, toArc: 30000, glideMs: 5000, distMeters: 800,
            newTs: 1000, prevAcceptedTs: 995, forcePull: false, anchorArc: null });
        const log = ring();
        expect(log).toHaveLength(1);
        expect(log[0].implMps).toBe(5000);
        expect(log[0].arcGapM).toBe(25000);
        expect(log[0].gapS).toBe(5);
        expect(log[0].keyMismatch).toBe(false);   // arcKey '801' === shapeKey '801'
    });

    it('does NOT record an ordinary glide (real-speed catch-up)', () => {
        // 150 m over 6 s → 25 m/s, a normal train. Below threshold → no record.
        _recordFly({ _currentArcKey: '801' }, veh(), { shapeKey: '801', fromArc: 1000, toArc: 1150, glideMs: 6000, distMeters: 150, newTs: 1006, prevAcceptedTs: 1000, forcePull: false, anchorArc: null });
        expect(ring()).toHaveLength(0);
    });

    it('flags keyMismatch when fromArc was committed under a different shape key', () => {
        // _currentArc was set under 801|0 but this glide runs on 801 (reversed space).
        _recordFly({ _currentArcKey: '801|0' }, veh({ direction_id: 1 }), {
            shapeKey: '801', fromArc: 0, toArc: 90000, glideMs: 5000, distMeters: 500,
            newTs: 1000, prevAcceptedTs: 995, forcePull: false, anchorArc: null });
        const log = ring();
        expect(log).toHaveLength(1);
        expect(log[0].keyMismatch).toBe(true);
        expect(log[0].shapeKey).toBe('801');
        expect(log[0].arcKey).toBe('801|0');
    });

    it('caps the ring at 150 entries (oldest dropped)', () => {
        for (let i = 0; i < 160; i++) {
            _recordFly({ _currentArcKey: '801' }, veh({ trip_id: `T${i}` }), { shapeKey: '801', fromArc: 0, toArc: 25000, glideMs: 1000, distMeters: 100, newTs: 1000, prevAcceptedTs: 999, forcePull: false, anchorArc: null });
        }
        const log = ring();
        expect(log).toHaveLength(150);
        expect(log[log.length - 1].trip).toBe('T159');   // newest retained
    });

    it('does not throw on non-finite arcs', () => {
        expect(() => _recordFly({ _currentArcKey: '801' }, veh(), { shapeKey: '801', fromArc: NaN, toArc: 5, glideMs: 1000, distMeters: 0, newTs: 1, prevAcceptedTs: 0, forcePull: false, anchorArc: null })).not.toThrow();
        expect(ring()).toHaveLength(0);
    });
});
