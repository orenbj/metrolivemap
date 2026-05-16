/**
 * @module trajectory
 *
 * Trajectory primitive: piecewise-defined function from time (unix seconds) to
 * arc-meters along a route polyline, with `positionAt(t)`, `timeAtArc(arc)`,
 * and `velocityAt(t)` evaluators.
 *
 * Phase 1 of the trajectory-model overhaul (docs/trajectory-overhaul.md).
 * Pure function — no globals, no DOM, no MapLibre, no `window.*`. Not yet
 * wired to any other module; lives standalone until Phase 5 swaps it in for
 * `markers.js` DR integration and `predictions.js` ETA blending.
 *
 * Once constructed, a Trajectory is **immutable**. Subsequent state changes
 * (new GPS fix, feed update) produce a new Trajectory rather than mutate an
 * existing one. This keeps `positionAt(t)` referentially transparent so we
 * can call it at 60 fps from a `requestAnimationFrame` loop without worrying
 * about concurrent mutation by WS frames.
 *
 * ## Segment model
 *
 * Trajectories are a sequence of contiguous segments. Each segment has a kind
 * that determines how position/velocity evolve over its time interval:
 *
 *   - `free`:  constant velocity. arc(t) = arc_start + v · (t − t_start)
 *   - `decel`: kinematic decel to zero at the next stop.
 *              arc(t) = arc_start + v_start·dt − 0.5·a·dt²
 *              v(t)   = v_start − a·dt
 *   - `dwell`: position constant for a fixed duration (operator boarding time).
 *              arc(t) = arc_start, v = 0
 *   - `hold`:  position constant until the scheduled departure time (early
 *              vehicles wait at timepoints). arc(t) = arc_start, v = 0
 *
 * Segments are contiguous: `seg[i].t_end === seg[i+1].t_start`,
 * `seg[i].arc_end === seg[i+1].arc_start`. Arc is monotonically non-decreasing.
 *
 * ## Sign / direction convention
 *
 * Arc increases in the trip's direction of travel. The Trajectory is unitless
 * about which compass direction "forward" is — the caller's snap layer maps
 * arc to lat/lng. This keeps Trajectory itself agnostic to N/S/E/W flips,
 * which are a heading-resolution concern handled elsewhere.
 */

const DEFAULT_DECEL_MPS2 = 1.0; // m/s²; conservative single value for v1
const EPSILON_S    = 1e-6;       // segment duration floor (skip degenerate segs)
const EPSILON_ARC  = 1e-3;       // arc distance floor (1 mm)

/**
 * Maximum arc discontinuity (in metres) the constructor will silently snap
 * between adjacent segments. Above this threshold the constructor throws —
 * the trajectory is rejected and the caller falls back to legacy DR / blend.
 *
 * Tradeoff: the cache.arcMeters / fromAnchor assembly is supposed to produce
 * perfectly contiguous segments, but production live-accuracy captures show
 * occasional ~10–20 m gaps between adjacent segments (see live-accuracy
 * workflow run 25970275823, 2026-05-16). The exact source is unidentified —
 * candidates include polyline-shape rebuild drift at terminals where
 * arcMeters values are snapped from a different shape revision, and stop
 * positions that project onto the polyline within a few metres of each other
 * (the rare two-stops-at-essentially-the-same-arc case).
 *
 * Three options were on the table:
 *   (a) tighten fromAnchor to guarantee `arc_start === prev.arc_end` by
 *       construction (the right long-term fix, but requires root-causing
 *       the assembly drift first);
 *   (b) loosen EPSILON_ARC globally — too coarse, hides real bugs;
 *   (c) auto-snap arc_start to prev.arc_end within a bounded tolerance
 *       (this choice).
 *
 * Option (c) is a compromise: we lose ~10–20 m of position fidelity for ONE
 * frame at each gap boundary (the segment's kinematic evaluator still uses
 * its original `arc_end`, so position jumps by the gap amount at t_end),
 * but the trajectory is returned instead of thrown — which is what the
 * Phase 8 A/B harness needs to capture trajectory-side ETAs at all on
 * affected vehicles.
 *
 * Tolerance picked at 50 m: well above any float / snap noise (sub-mm) and
 * above the empirically observed gaps (≤25 m so far), but well below a real
 * polyline corruption (a wrong-shape attach would be measured in hundreds
 * of metres or full route segments). Catastrophic gaps still surface as a
 * thrown error — we want to see those, not silently degrade ETAs.
 */
const ARC_SNAP_TOLERANCE_M = 50;

export class Trajectory {
    /**
     * @param {Array<Object>} segments  Ordered, contiguous segments
     * @throws if segments are non-contiguous or non-monotonic
     */
    constructor(segments) {
        const segs = Array.isArray(segments) ? segments : [];

        // Validate contiguity + monotonicity. Cheap; runs once at construction
        // and saves a class of "trajectory looks fine but evaluator is wrong"
        // bugs from confusing failure modes later.
        // Defensive copy so snapping below doesn't mutate caller-owned objects.
        const out = segs.slice();
        for (let i = 1; i < out.length; i++) {
            const prev = out[i - 1];
            const cur  = out[i];
            if (Math.abs(cur.t_start - prev.t_end) > EPSILON_S) _throwGap('t', i, prev.t_end, cur.t_start);

            const arcGap = cur.arc_start - prev.arc_end;
            const absGap = Math.abs(arcGap);
            if (absGap > ARC_SNAP_TOLERANCE_M) _throwGap('arc', i, prev.arc_end, cur.arc_start);
            if (absGap > EPSILON_ARC) {
                // In-tolerance discontinuity — snap arc_start to prev.arc_end.
                // The segment's internal kinematics (v_start, a, dt, arc_end)
                // are preserved, so the within-segment evaluator stays
                // self-consistent; the visible cost is a one-frame ≤ gap-sized
                // position jump at t_end as we transition into the next segment.
                out[i] = { ...cur, arc_start: prev.arc_end };
            }
        }

        this._segs = out;
        // Cache binary-search keys to avoid an extra layer of access per evaluator call.
        this._t_starts   = out.map(s => s.t_start);
        this._arc_starts = out.map(s => s.arc_start);
    }

    /**
     * Position (arc-meters along the route) at time `t` (unix seconds).
     * Clamps to the trajectory's t-range: returns `arc_start` of the first
     * segment for t before, `arc_end` of the last for t after.
     *
     * @param {number} t  Unix seconds (any monotonic time origin works)
     * @returns {number|null} arc-meters, or null if the trajectory is empty
     */
    positionAt(t) {
        if (!this._segs.length) return null;
        const first = this._segs[0];
        if (t <= first.t_start) return first.arc_start;
        const last = this._segs[this._segs.length - 1];
        if (t >= last.t_end) return last.arc_end;
        return _segPositionAt(this._segs[this._findSegByT(t)], t);
    }

    /**
     * Velocity (m/s) at time `t`. Returns 0 outside the trajectory's time range
     * (vehicle assumed parked before start / after end).
     *
     * @param {number} t  Unix seconds
     * @returns {number|null} m/s, or null if the trajectory is empty
     */
    velocityAt(t) {
        if (!this._segs.length) return null;
        // Strict-inequality clamps: at exact t_start the first segment's
        // v_start is the right answer (vehicle is "moving as the trajectory
        // begins"), not zero. At exact t_end of a terminal decel segment the
        // evaluator returns 0 naturally.
        if (t < this._segs[0].t_start) return 0;
        const last = this._segs[this._segs.length - 1];
        if (t > last.t_end) return 0;
        return _segVelocityAt(this._segs[this._findSegByT(t)], t);
    }

    /**
     * Time (unix seconds) at which the vehicle first reaches `arc` along the
     * route. Inverse of `positionAt` on the trajectory's arc range. Clamps
     * to t_start of the first segment for arc before, t_end of the last for
     * arc after.
     *
     * Within a dwell or hold (arc is constant for a range of t), returns the
     * EARLIEST time the vehicle reached that arc — the dwell's t_start.
     *
     * @param {number} arc  Arc-meters along the route
     * @returns {number|null} unix seconds, or null if the trajectory is empty
     */
    timeAtArc(arc) {
        if (!this._segs.length) return null;
        const first = this._segs[0];
        if (arc <= first.arc_start) return first.t_start;
        const last = this._segs[this._segs.length - 1];
        if (arc >= last.arc_end) return last.t_end;
        return _segTimeAtArc(this._segs[this._findSegByArc(arc)], arc);
    }

    // ── Diagnostic / test accessors (do not consume externally) ─────────────

    /** @returns {Array<Object>} a defensive copy of the internal segment list. */
    get segments() { return this._segs.slice(); }

    // ── Internal: binary search ─────────────────────────────────────────────
    // Each evaluator hits these once per call. Branch-free upper-bound search
    // on a small ordered array; O(log n) and trivial inside a 60 fps tick.

    _findSegByT(t) {
        let lo = 0, hi = this._t_starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this._t_starts[mid] <= t) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    _findSegByArc(arc) {
        let lo = 0, hi = this._arc_starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this._arc_starts[mid] <= arc) lo = mid; else hi = mid - 1;
        }
        return lo;
    }
}

// ── Per-segment evaluators ──────────────────────────────────────────────────

function _segPositionAt(seg, t) {
    const dt = t - seg.t_start;
    switch (seg.kind) {
        case 'free':
            return seg.arc_start + seg.v_start * dt;
        case 'decel': {
            const a = seg.a;
            // arc(t) = arc_start + v_start·dt − 0.5·a·dt²
            // Numerical safety: clamp to arc_end if dt overshoots (segment must
            // not advance arc past its declared end — guards against float drift).
            const arc = seg.arc_start + seg.v_start * dt - 0.5 * a * dt * dt;
            return Math.min(seg.arc_end, arc);
        }
        case 'dwell':
        case 'hold':
            return seg.arc_start;
        default:
            throw new Error(`Unknown segment kind: ${seg.kind}`);
    }
}

function _segVelocityAt(seg, t) {
    const dt = t - seg.t_start;
    switch (seg.kind) {
        case 'free':  return seg.v_start;
        case 'decel': return Math.max(0, seg.v_start - seg.a * dt);
        case 'dwell':
        case 'hold':  return 0;
        default: throw new Error(`Unknown segment kind: ${seg.kind}`);
    }
}

function _segTimeAtArc(seg, arc) {
    const darc = arc - seg.arc_start;
    switch (seg.kind) {
        case 'free':
            // free segment guarantees v_start > 0 (otherwise we'd be in dwell/hold)
            return seg.t_start + darc / seg.v_start;
        case 'decel': {
            // arc − arc_start = v_start·dt − 0.5·a·dt²
            // Solve quadratic: 0.5·a·dt² − v_start·dt + darc = 0
            // We want the SMALLER non-negative root — the first time the
            // decelerating vehicle reaches that arc, before it would stop.
            const a = seg.a, v = seg.v_start;
            const discriminant = v * v - 2 * a * darc;
            if (discriminant < 0) {
                // Float drift past the segment's stopping point. Return t_end.
                return seg.t_end;
            }
            const dt = (v - Math.sqrt(discriminant)) / a;
            return seg.t_start + dt;
        }
        case 'dwell':
        case 'hold':
            // arc is constant across the segment — first time we reached it
            // is the segment's start.
            return seg.t_start;
        default: throw new Error(`Unknown segment kind: ${seg.kind}`);
    }
}

function _throwGap(dim, idx, end, start) {
    throw new Error(`Trajectory segment ${idx}: discontinuous ${dim} (prev end=${end}, this start=${start})`);
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Construct a Trajectory from physical parameters: a starting state (anchor)
 * and a list of upcoming stops with optional dwells and scheduled times.
 *
 * The builder emits, for each stop ahead of `arc_now`:
 *   1. A `free` segment cruising at the segment's velocity (caller-provided)
 *   2. A `decel` segment kinematically slowing to zero at the stop
 *   3. A `dwell` segment of the stop's configured duration (may be zero)
 *   4. A `hold` segment if the vehicle would otherwise depart before its
 *      scheduled time at that stop
 *
 * Acceleration after a dwell is modelled as instantaneous in v1 — the next
 * free segment starts at full cruise speed. Real-world acceleration takes
 * 5–15 s; modelling it explicitly would require an `accel` segment kind and
 * is deferred until empirical data justifies the complexity.
 *
 * Edge cases handled:
 *   - Anchor already past a stop: that stop is skipped.
 *   - Anchor already inside the decel zone for the next stop: the leading
 *     free segment is omitted; decel starts immediately at the back-computed
 *     velocity that would reach zero at the stop's arc.
 *   - Anchor at zero velocity exactly on a stop arc: starts with a dwell.
 *
 * @param {Object}   p
 * @param {number}   p.t_now         Unix seconds, anchor time
 * @param {number}   p.arc_now       Current arc position (metres)
 * @param {number}   p.v_now         Current velocity (m/s, non-negative)
 * @param {Array<{arc:number, scheduled_time?:number, dwell_s?:number}>} p.stops
 *                                   Ordered upcoming stops, arc strictly increasing
 * @param {number}   [p.decel_rate]  Kinematic decel rate, m/s²  (default 1.0)
 * @param {number|Function} [p.cruise]
 *                                   Cruise speed in m/s. Number = same for all
 *                                   segments. Function = `(stopIdx) => m/s`,
 *                                   one call per stop ahead. Default: `v_now`.
 * @param {number}   [p.horizon_s]   Optional cap on trajectory duration; segments
 *                                   beyond t_now + horizon_s are not emitted.
 * @returns {Trajectory}
 */
export function fromAnchor({
    t_now, arc_now, v_now,
    stops,
    decel_rate = DEFAULT_DECEL_MPS2,
    cruise,
    horizon_s = null,
}) {
    if (!(decel_rate > 0)) throw new Error('fromAnchor: decel_rate must be positive');
    if (!Number.isFinite(t_now) || !Number.isFinite(arc_now) || !Number.isFinite(v_now)) {
        throw new Error('fromAnchor: t_now / arc_now / v_now must be finite');
    }
    if (v_now < 0) throw new Error('fromAnchor: v_now must be non-negative');
    if (!Array.isArray(stops)) throw new Error('fromAnchor: stops must be an array');

    const cruiseFn = typeof cruise === 'function'
        ? cruise
        : (() => Number.isFinite(cruise) ? cruise : v_now);

    const t_horizon = horizon_s != null ? t_now + horizon_s : Infinity;

    const segments = [];
    let t = t_now, arc = arc_now, v = v_now;

    // Filter zero-duration / zero-distance segments at push time. They arise
    // legitimately at boundary anchors (e.g. velocity exactly at decel-zone
    // threshold) and would otherwise add useless cruft the evaluators have
    // to skip past.
    const push = seg => {
        if (seg.t_end - seg.t_start > EPSILON_S) segments.push(seg);
    };

    for (let i = 0; i < stops.length; i++) {
        if (t >= t_horizon) break;

        const stop = stops[i];
        const dist_to_stop = stop.arc - arc;
        if (dist_to_stop < -EPSILON_ARC) continue;          // already past
        if (dist_to_stop > EPSILON_ARC && v <= 0) continue; // stalled between stops; nothing to project

        // Emit free + decel (or decel-only when already inside the decel zone).
        if (v > 0 && dist_to_stop > EPSILON_ARC) {
            const cruise_v_raw = cruiseFn(i);
            // Cruise must be positive and at least the anchor's velocity — we
            // never project a vehicle slowing down arbitrarily mid-segment;
            // that's what decel is for.
            const cruise_v = Math.max(v, Number.isFinite(cruise_v_raw) && cruise_v_raw > 0
                ? cruise_v_raw : v);

            const decel_dist_at_cruise = (cruise_v * cruise_v) / (2 * decel_rate);

            if (decel_dist_at_cruise >= dist_to_stop) {
                // No room for a cruise-then-decel profile. Back-compute the
                // velocity that would kinematically decelerate to zero over
                // exactly `dist_to_stop`. (v_eff = sqrt(2 a dist_to_stop))
                const v_eff   = Math.sqrt(2 * decel_rate * dist_to_stop);
                const decel_dur = v_eff / decel_rate;
                push({
                    kind: 'decel',
                    t_start: t, t_end: t + decel_dur,
                    arc_start: arc, arc_end: stop.arc,
                    v_start: v_eff, v_end: 0,
                    a: decel_rate,
                });
                t  += decel_dur;
                arc = stop.arc;
                v   = 0;
            } else {
                // Standard profile: cruise at cruise_v then decel to zero at stop.
                const free_dist = dist_to_stop - decel_dist_at_cruise;
                const free_dur  = free_dist / cruise_v;
                push({
                    kind: 'free',
                    t_start: t, t_end: t + free_dur,
                    arc_start: arc, arc_end: arc + free_dist,
                    v_start: cruise_v, v_end: cruise_v,
                });
                t  += free_dur;
                arc += free_dist;

                const decel_dur = cruise_v / decel_rate;
                push({
                    kind: 'decel',
                    t_start: t, t_end: t + decel_dur,
                    arc_start: arc, arc_end: stop.arc,
                    v_start: cruise_v, v_end: 0,
                    a: decel_rate,
                });
                t  += decel_dur;
                arc = stop.arc;
                v   = 0;
            }
        }

        // Dwell at the stop (operator boarding time).
        const dwell_s = stop.dwell_s ?? 0;
        if (dwell_s > EPSILON_S) {
            push({
                kind: 'dwell',
                t_start: t, t_end: t + dwell_s,
                arc_start: arc, arc_end: arc,
                v_start: 0, v_end: 0,
            });
            t += dwell_s;
        }

        // Hold until scheduled departure if the model is running early.
        if (stop.scheduled_time != null && t < stop.scheduled_time - EPSILON_S) {
            push({
                kind: 'hold',
                t_start: t, t_end: stop.scheduled_time,
                arc_start: arc, arc_end: arc,
                v_start: 0, v_end: 0,
                scheduled_time: stop.scheduled_time,
            });
            t = stop.scheduled_time;
        }

        // After dwell/hold the vehicle accelerates back to cruise. v1: instant.
        const nextCruise = cruiseFn(i + 1);
        v = Number.isFinite(nextCruise) && nextCruise > 0
            ? nextCruise
            : (v_now > 0 ? v_now : 0);
    }

    return new Trajectory(segments);
}
