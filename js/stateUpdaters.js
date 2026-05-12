/**
 * @module stateUpdaters
 *
 * Observation updaters for {@link VehicleState}. Each function takes a state
 * and an observation, applies a Kalman-style update, and returns a new
 * frozen state. The Kalman gain replaces the hand-tuned band weights that
 * `_blendArrivals` uses in the legacy architecture — when an observation is
 * tighter than the prior (small σ), it dominates; when it's noisier, the
 * prior dominates. Per-source variances are hardcoded in this phase and
 * learned online in Phase 6.
 *
 * Phase 3 of the trajectory-model overhaul (docs/trajectory-overhaul.md).
 * Pure functions — no globals, no DOM, no MapLibre, no `window.*`. Not yet
 * imported by any other module.
 *
 * ## Model
 *
 * State holds `(arc, velocity, σ_arc, σ_v)` as a 2-D Gaussian belief over
 * the vehicle's current arc-position and forward velocity. (We treat arc
 * and velocity as decoupled for v1 — a full 2-D filter with cross-covariance
 * is overkill until we see real data showing it matters.)
 *
 * Each frame:
 *
 *   1. `tickTime(state, t)` — propagate state forward to time `t`.
 *      Arc advances by `v · dt`; velocity is held; both σs inflate.
 *   2. `apply{Gps,StoppedAt,InTransitTo,TripUpdate}(state, obs)` —
 *      fold the observation in via per-dimension scalar Kalman update.
 *
 * Each updater calls `tickTime` internally to align state to the
 * observation's timestamp, so callers don't have to remember the order.
 *
 * ## Variance defaults
 *
 * Conservative defaults tuned by inspection rather than data; Phase 6
 * replaces these with learned per-route values. Order of magnitude only.
 *
 *   - σ_gps_arc   ≈  8 m  (urban GPS noise floor + snap residual)
 *   - σ_gps_v     ≈  1.5 m/s (feed-reported speed jitter)
 *   - σ_stopped   ≈  3 m, 0.5 m/s  (high confidence: feed-confirmed dwell)
 *   - σ_in_transit ≈ 3 m  (one-sided constraint, only fires when state has crossed)
 *   - process_arc ≈  0.6 m/√s   (diffusion: vehicle does unexpected things)
 *   - process_v   ≈  0.4 m/s/√s (velocity wander)
 *
 * ## Velocity clamping
 *
 * After every update, velocity is clamped to `[0, +∞)`. A Kalman correction
 * on a noisy observation can produce a small negative velocity; vehicles
 * don't drive backward in our model. The clamp is a minor non-linearity
 * that breaks textbook Kalman optimality but matters far less than the
 * physical constraint.
 */

import { withUpdate } from './vehicleState.js';

// ── Variance defaults (Phase 6 will replace via learned per-route table) ────

export const DEFAULT_VARIANCES = Object.freeze({
    gps_σ_arc:           8,
    gps_σ_v:             1.5,
    stopped_σ_arc:       3,
    stopped_σ_v:         0.5,
    in_transit_σ_arc:    3,
    process_noise_arc:   0.6,   // m / √s
    process_noise_v:     0.4,   // (m/s) / √s
});

// ── Scalar Kalman update ────────────────────────────────────────────────────

/**
 * One-dimensional Kalman correction. Given a Gaussian prior `N(μ, σ²)` and an
 * observation `N(z, σ_obs²)`, returns the posterior `N(μ', σ'²)`.
 *
 *   K = σ² / (σ² + σ_obs²)
 *   μ' = μ + K · (z − μ)
 *   σ'² = (1 − K) · σ²
 *
 * Exported because the variance-learner in Phase 6 will need the same shape.
 *
 * @param {number} mu       prior mean
 * @param {number} sigma    prior standard deviation (> 0)
 * @param {number} z        observation
 * @param {number} sigmaObs observation standard deviation (> 0)
 * @returns {{ mu: number, sigma: number, gain: number }}
 */
export function kalmanUpdate1d(mu, sigma, z, sigmaObs) {
    if (!(sigma > 0))     throw new Error('kalmanUpdate1d: prior sigma must be positive');
    if (!(sigmaObs > 0))  throw new Error('kalmanUpdate1d: obs sigma must be positive');
    const v_prior = sigma * sigma;
    const v_obs   = sigmaObs * sigmaObs;
    const gain    = v_prior / (v_prior + v_obs);
    return {
        mu:    mu + gain * (z - mu),
        sigma: Math.sqrt((1 - gain) * v_prior),
        gain,
    };
}

// ── tickTime ────────────────────────────────────────────────────────────────

/**
 * Forward-propagate the state to wall-clock time `t`. Arc advances by
 * `velocity · dt`; velocity is held (no process model for v drift in v1);
 * both standard deviations inflate.
 *
 * σ_arc² grows by:
 *   - `(σ_v · dt)²` — the prior's velocity uncertainty integrated into position
 *   - `process_noise_arc² · dt` — diffusion (random walk)
 *
 * σ_v² grows by:
 *   - `process_noise_v² · dt`
 *
 * dt ≤ 0 is a no-op (returns the same state). This matters because observations
 * can arrive out of order — a stale frame should not "rewind" the filter.
 *
 * @param {Readonly<Object>} state
 * @param {number}           t           wall-clock unix seconds
 * @param {Object}           [variances] per-route variance overrides
 * @returns {Readonly<Object>}
 */
export function tickTime(state, t, variances = DEFAULT_VARIANCES) {
    if (!Number.isFinite(t)) throw new Error('tickTime: t must be finite');
    const dt = t - state.lastObservedAt;
    if (dt <= 0) return state;

    const arc = state.arc + state.velocity * dt;
    const σ_arc = Math.sqrt(
        state.σ_arc * state.σ_arc
        + (state.σ_v * dt) * (state.σ_v * dt)
        + variances.process_noise_arc * variances.process_noise_arc * dt
    );
    const σ_v = Math.sqrt(
        state.σ_v * state.σ_v
        + variances.process_noise_v * variances.process_noise_v * dt
    );

    return withUpdate(state, { arc, σ_arc, σ_v, lastObservedAt: t });
}

// ── applyGpsFix ─────────────────────────────────────────────────────────────

/**
 * Fold a GPS observation into the state. Caller is responsible for snapping
 * the raw lat/lng to the route polyline (via snap.js) and providing the
 * resulting arc + a variance reflecting GPS noise plus snap residual.
 *
 * Arc and velocity update independently as scalar Kalman corrections.
 * Velocity is clamped to `[0, +∞)` after the update.
 *
 * @param {Readonly<Object>} state
 * @param {Object}   obs
 * @param {number}   obs.arc           snapped arc-meters
 * @param {number}   obs.velocity      m/s (non-negative)
 * @param {number}   obs.t             wall-clock unix seconds
 * @param {number}   [obs.σ_arc]       observation arc σ (default from variances)
 * @param {number}   [obs.σ_v]         observation velocity σ
 * @param {Object}   [variances]
 * @returns {Readonly<Object>}
 */
export function applyGpsFix(state, obs, variances = DEFAULT_VARIANCES) {
    _requireFiniteObs(obs, ['arc', 'velocity', 't']);
    if (obs.velocity < 0) throw new Error('applyGpsFix: obs.velocity must be non-negative');

    const σ_arc_obs = obs.σ_arc ?? variances.gps_σ_arc;
    const σ_v_obs   = obs.σ_v   ?? variances.gps_σ_v;

    const ticked = tickTime(state, obs.t, variances);
    const arcUp  = kalmanUpdate1d(ticked.arc,      ticked.σ_arc, obs.arc,      σ_arc_obs);
    const vUp    = kalmanUpdate1d(ticked.velocity, ticked.σ_v,   obs.velocity, σ_v_obs);

    return withUpdate(ticked, {
        arc:      arcUp.mu,
        velocity: Math.max(0, vUp.mu),
        σ_arc:    arcUp.sigma,
        σ_v:      vUp.sigma,
    });
}

// ── applyStoppedAt ──────────────────────────────────────────────────────────

/**
 * The feed has confirmed STOPPED_AT a known stop. Both arc and velocity get
 * a high-confidence observation: arc = stop.arc, velocity = 0.
 *
 * In practice, σ_stopped is small (~3 m / ~0.5 m/s) so the Kalman gain
 * approaches 1 — the state is mostly pulled to the stop.
 *
 * Note: the caller is responsible for resolving stopId → stop.arc via
 * snap.js / masterStopsData. This updater is pure.
 *
 * @param {Readonly<Object>} state
 * @param {Object}   obs
 * @param {number}   obs.arc      the stop's arc-meters
 * @param {number}   obs.t        wall-clock unix seconds
 * @param {number}   [obs.σ_arc]
 * @param {number}   [obs.σ_v]
 * @param {Object}   [variances]
 * @returns {Readonly<Object>}
 */
export function applyStoppedAt(state, obs, variances = DEFAULT_VARIANCES) {
    _requireFiniteObs(obs, ['arc', 't']);
    const σ_arc_obs = obs.σ_arc ?? variances.stopped_σ_arc;
    const σ_v_obs   = obs.σ_v   ?? variances.stopped_σ_v;

    const ticked = tickTime(state, obs.t, variances);
    const arcUp  = kalmanUpdate1d(ticked.arc,      ticked.σ_arc, obs.arc, σ_arc_obs);
    const vUp    = kalmanUpdate1d(ticked.velocity, ticked.σ_v,   0,        σ_v_obs);

    return withUpdate(ticked, {
        arc:      arcUp.mu,
        velocity: Math.max(0, vUp.mu),
        σ_arc:    arcUp.sigma,
        σ_v:      vUp.sigma,
    });
}

// ── applyInTransitTo ────────────────────────────────────────────────────────

/**
 * The feed reports IN_TRANSIT_TO a known stop. This is a **one-sided
 * constraint** — vehicle's arc must be < stop.arc — not a point observation.
 * V1 implementation: if our current estimate has crossed the stop's arc
 * (typically from a noisy GPS or from DR coasting past), pull it back.
 * Otherwise no-op (just stamps lastObservedAt via tickTime).
 *
 * A full Bayesian treatment would use a truncated Gaussian; that requires
 * sampling or analytic moment-matching. Deferred until empirical data
 * justifies the complexity.
 *
 * @param {Readonly<Object>} state
 * @param {Object}   obs
 * @param {number}   obs.stopArc    upper bound on arc
 * @param {number}   obs.t
 * @param {number}   [obs.σ_arc]    σ to assign when the clamp fires
 * @param {Object}   [variances]
 * @returns {Readonly<Object>}
 */
export function applyInTransitTo(state, obs, variances = DEFAULT_VARIANCES) {
    _requireFiniteObs(obs, ['stopArc', 't']);
    const σ_arc_obs = obs.σ_arc ?? variances.in_transit_σ_arc;

    const ticked = tickTime(state, obs.t, variances);
    if (ticked.arc <= obs.stopArc) return ticked;

    // We've crossed the upper bound. Pull arc back to stopArc; tighten σ_arc
    // to reflect the constraint (only as tight as the observation, not tighter).
    return withUpdate(ticked, {
        arc:   obs.stopArc,
        σ_arc: Math.min(ticked.σ_arc, σ_arc_obs),
    });
}

// ── applyTripUpdate ─────────────────────────────────────────────────────────

/**
 * GTFS-RT trip_update — predicted arrival at stopArc at etaUnix.
 *
 * In the full architecture (Phase 5 wiring) trip_updates primarily shape
 * the trajectory's segment-end times, not the state's current (arc, v)
 * point estimate. So in v1 this updater is intentionally minimal: it stamps
 * lastObservedAt and returns. Phase 5 + Phase 6 expand this to fold the
 * GTFS-RT prediction into a learned bias offset and adjust trajectory anchors.
 *
 * Kept as a separate function so the call sites are explicit at Phase 5
 * integration time — easier to find and extend than a comment in a switch.
 *
 * @param {Readonly<Object>} state
 * @param {Object}   obs
 * @param {number}   obs.stopArc
 * @param {number}   obs.etaUnix    predicted arrival time
 * @param {number}   obs.t          current time (for the tick)
 * @param {number}   [obs.σ_gtfs]   ETA uncertainty in seconds (unused in v1)
 * @param {Object}   [variances]
 * @returns {Readonly<Object>}
 */
export function applyTripUpdate(state, obs, variances = DEFAULT_VARIANCES) {
    _requireFiniteObs(obs, ['stopArc', 'etaUnix', 't']);
    return tickTime(state, obs.t, variances);
}

// ── Internal helpers ────────────────────────────────────────────────────────

function _requireFiniteObs(obs, fields) {
    if (!obs || typeof obs !== 'object') throw new Error('obs object is required');
    for (const k of fields) {
        if (!Number.isFinite(obs[k])) {
            throw new Error(`obs.${k} must be a finite number (got ${obs[k]})`);
        }
    }
}
