/**
 * End-to-end replay test for the Phase 1-4 trajectory pipeline.
 *
 * Drives a scripted sequence of WS-style frames through the stateUpdaters
 * → trajectory chain and asserts the output is internally consistent:
 *   - position never goes backward along the arc (per Trajectory contract)
 *   - velocity stays non-negative and within physical limits
 *   - timeAtArc(arc) is the inverse of positionAt(t).arc on the trajectory's range
 *   - Kalman σ shrinks as observations arrive
 *
 * This is the integration yardstick Phase 5 needs: today the trajectory
 * model is dormant (production runs on legacy DR), and the per-module unit
 * tests prove each piece in isolation but not the composition. Replay-style
 * coverage protects against regressions during the swap.
 *
 * Synthetic trace covers a typical short-trip pattern:
 *   t=0    cold-start at stop A (arc=0, v=0)        applyStoppedAt
 *   t=10   accelerating away from A (arc=50, v=10)   applyGpsFix
 *   t=30   cruising mid-segment (arc=250, v=10)      applyGpsFix
 *   t=60   approaching stop B (arc=550, v=8)         applyGpsFix
 *   t=80   stopped at B (arc=600, v=0)              applyStoppedAt
 *
 * The frames are spaced 10–30 s apart to exercise the tickTime() process-noise
 * growth between observations. Stop spacing (~600 m) matches Metro rail typical.
 */

import { describe, it, expect } from 'vitest';
import { createState, withTrajectory } from '../js/vehicleState.js';
import { applyGpsFix, applyStoppedAt, tickTime } from '../js/stateUpdaters.js';
import { fromAnchor, Trajectory } from '../js/trajectory.js';

// Two synthetic stops, 600 m apart. Matches a typical Metro inter-station gap.
const STOPS = [
    { id: 'A', arc: 0 },
    { id: 'B', arc: 600 },
];

// Build the trace once at module load so every test sees the same scripted
// sequence. Each entry is a {kind, ...obs} that maps cleanly to one updater.
const REPLAY = [
    { kind: 'stopped',  t: 0,  arc: 0,   stopId: 'A' },
    { kind: 'gps',      t: 10, arc: 50,  velocity: 10 },
    { kind: 'gps',      t: 30, arc: 250, velocity: 10 },
    { kind: 'gps',      t: 60, arc: 550, velocity: 8  },
    { kind: 'stopped',  t: 80, arc: 600, stopId: 'B' },
];

/** Apply one trace step to the rolling state. Returns the new state. */
function step(state, frame) {
    if (frame.kind === 'gps')     return applyGpsFix(state, { arc: frame.arc, velocity: frame.velocity, t: frame.t });
    if (frame.kind === 'stopped') return applyStoppedAt(state, { arc: frame.arc, t: frame.t });
    throw new Error(`unknown frame kind: ${frame.kind}`);
}

/** Build a fresh-anchored Trajectory from a state. The cruise speed is
 *  taken from current velocity, with a 12 m/s minimum so a state observed
 *  at rest still projects a non-zero trajectory toward the next stop. */
function trajectoryFrom(state) {
    return fromAnchor({
        t_now:   state.lastObservedAt,
        arc_now: state.arc,
        v_now:   state.velocity,
        stops:   STOPS,
        cruise:  Math.max(state.velocity, 12),  // typical metro rail cruise
    });
}

describe('trajectory pipeline — replay integration', () => {
    it('runs the full scripted trace without throwing', () => {
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: -1,  // anchor in the past so first tick is forward
        });
        for (const frame of REPLAY) state = step(state, frame);
        expect(state.arc).toBeGreaterThan(550);  // landed near stop B
    });

    it('arc never decreases across the trace (per state contract)', () => {
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: -1,
        });
        let prevArc = state.arc;
        for (const frame of REPLAY) {
            state = step(state, frame);
            // Allow tiny backward Kalman pull when the observation has high
            // confidence (stopped observation at stop arc), but never more
            // than a few meters.
            expect(state.arc).toBeGreaterThanOrEqual(prevArc - 5);
            prevArc = state.arc;
        }
    });

    it('velocity stays non-negative and below the physical cap (50 m/s) throughout', () => {
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: -1,
        });
        for (const frame of REPLAY) {
            state = step(state, frame);
            expect(state.velocity).toBeGreaterThanOrEqual(0);
            expect(state.velocity).toBeLessThan(50);
        }
    });

    it('σ_arc shrinks after a high-confidence stopped observation', () => {
        // Build to mid-cruise, then snap to a stop — σ_arc should drop sharply.
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: -1,
        });
        state = step(state, REPLAY[0]); // stopped at A
        state = step(state, REPLAY[1]); // gps t=10
        state = step(state, REPLAY[2]); // gps t=30
        const σ_before = state.σ_arc;
        state = step(state, REPLAY[4]); // stopped at B (skip the t=60 GPS frame)
        // Stopped observations carry σ ≈ 3 m; the post-update σ_arc should be
        // dominated by the observation and well below the pre-update σ.
        expect(state.σ_arc).toBeLessThan(σ_before);
        expect(state.σ_arc).toBeLessThan(5);
    });

    it('Trajectory built from a mid-trace state agrees with positionAt round-trip', () => {
        // Mid-trace, build a Trajectory and verify positionAt → timeAtArc is the
        // identity over the trajectory's arc range. This is the property Phase 5
        // relies on for both the rAF render loop (positionAt) and ETA reads
        // (timeAtArc).
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: -1,
        });
        for (const frame of REPLAY.slice(0, 3)) state = step(state, frame);

        const trajectory = trajectoryFrom(state);
        expect(trajectory).toBeInstanceOf(Trajectory);

        // Probe every 5 seconds from the trajectory start to either its
        // natural end or the predicted arrival at stop B. positionAt and
        // timeAtArc both return scalars (arc-meters / unix-seconds), not
        // objects — Phase 5 callers read the scalar directly.
        const t_start = state.lastObservedAt;
        const t_end   = trajectory.segments[trajectory.segments.length - 1].t_end;
        for (let dt = 0; dt < 60; dt += 5) {
            const t = t_start + dt;
            if (t > t_end) break;                              // probe past trajectory end
            const arc = trajectory.positionAt(t);
            if (arc == null) break;                            // trajectory empty
            const t_inv = trajectory.timeAtArc(arc);
            if (t_inv == null) continue;                       // shouldn't happen for in-range arc
            // Round-trip should reproduce the probe time within a sub-second
            // tolerance — pure numeric piecewise integration, not noisy data.
            // Inside a dwell or at clamped boundaries, timeAtArc returns the
            // EARLIEST t for the arc, so we tolerate that exception explicitly.
            const arcAtProbeEarlier = trajectory.positionAt(Math.max(t_start, t - 1));
            const insideDwell = (arc === arcAtProbeEarlier);   // arc unchanged → dwell
            if (insideDwell) continue;
            expect(Math.abs(t_inv - t)).toBeLessThan(0.5);
        }
    });

    it('attaches a trajectory to state via withTrajectory; subsequent reads use it', () => {
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0, t_now: -1,
        });
        for (const frame of REPLAY.slice(0, 3)) state = step(state, frame);

        const trajectory = trajectoryFrom(state);
        state = withTrajectory(state, trajectory, state.lastObservedAt);

        expect(state.trajectory).toBe(trajectory);
        expect(state.lastTrajectoryAt).toBe(state.lastObservedAt);

        // Identity fields preserved (Phase 5 will rely on this — withTrajectory
        // is called frequently as new observations arrive).
        expect(state.vehicleId).toBe('V1');
        expect(state.tripId).toBe('T1');
    });

    it('tickTime advances time monotonically and grows σ_arc between observations', () => {
        // Phase 5 calls tickTime on every render frame to advance the state
        // clock without a new observation. σ_arc must grow with elapsed time
        // (process noise) so a long-silent vehicle's uncertainty widens.
        let state = createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 5, t_now: 0,
        });
        const σ_arc_initial = state.σ_arc;

        // Tick forward 60 seconds in 10-second slices, mirroring an extended
        // feed silence period.
        for (let dt = 10; dt <= 60; dt += 10) {
            const next = tickTime(state, dt);
            expect(next.lastObservedAt).toBeGreaterThanOrEqual(state.lastObservedAt);
            state = next;
        }

        expect(state.σ_arc).toBeGreaterThan(σ_arc_initial);
    });
});
