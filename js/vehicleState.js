/**
 * @module vehicleState
 *
 * Per-vehicle state container. Wraps a {@link Trajectory} with Kalman-style
 * point estimate + uncertainty for arc and velocity, plus identity fields and
 * timestamps. The store keyed by vehicle identifier replaces the module-level
 * `markers[]` bag-of-properties used today.
 *
 * Phase 2 of the trajectory-model overhaul (docs/trajectory-overhaul.md).
 * Pure data + small helpers — no globals, no DOM, no MapLibre, no `window.*`.
 * Not imported by any other module yet; lives standalone until Phase 5.
 *
 * ## Immutability
 *
 * Each `VehicleState` is `Object.freeze`d on creation. Updates return a new
 * frozen state via {@link withUpdate} rather than mutating in place. Together
 * with Trajectory's existing immutability, this means a 60 fps render-loop
 * caller can read `state.trajectory.positionAt(t)` without racing against a
 * concurrent WS-driven observation update — at worst it sees the previous
 * state for one frame, then the new one on the next.
 *
 * The store itself is mutable (Map under the hood), but its only mutation
 * points are `set` / `archive`, which swap an entire frozen state at once.
 *
 * ## State shape
 *
 *   {
 *     // Identity
 *     vehicleId,      // string — primary key
 *     tripId,         // string — GTFS trip ID
 *     routeId,        // string — GTFS route_code (e.g. '801', '910')
 *     directionId,    // 0 | 1
 *
 *     // Kalman point estimate
 *     arc,            // current arc position (m along polyline)
 *     velocity,       // current velocity (m/s, non-negative)
 *
 *     // 1-sigma uncertainties (Phase 3 observation updaters write these)
 *     σ_arc,          // position uncertainty (m)
 *     σ_v,            // velocity uncertainty (m/s)
 *
 *     // Learned offset (Phase 4/6 populate this)
 *     bias,           // per-(route, dir, time-of-day) seconds offset
 *
 *     // Forward projection — see Trajectory; null if not yet built
 *     trajectory,     // Trajectory | null
 *
 *     // Bookkeeping
 *     createdAt,      // unix seconds (state.set time)
 *     lastObservedAt, // unix seconds (last observation update)
 *     lastTrajectoryAt, // unix seconds (last setTrajectory)
 *   }
 *
 * All seconds are unix seconds. All distances are metres along the polyline.
 *
 * ## Why frozen POJOs and not a class
 *
 * The shape is what callers care about. A class would tempt us to add methods
 * that gradually accrete state-mutating behaviour. Pure POJOs + helper
 * functions keep observation logic (Phase 3) explicit at every call site and
 * trivially serialisable for debugging / persistence later.
 */

/**
 * Construct a fresh, frozen VehicleState. Required fields validated; optional
 * fields default to sensible values.
 *
 * @param {Object} fields
 * @param {string} fields.vehicleId
 * @param {string} fields.tripId
 * @param {string} fields.routeId
 * @param {number} fields.directionId    0 or 1
 * @param {number} fields.arc            arc-meters along route polyline
 * @param {number} fields.velocity       m/s, non-negative
 * @param {number} [fields.σ_arc=10]     initial position uncertainty (m)
 * @param {number} [fields.σ_v=2]        initial velocity uncertainty (m/s)
 * @param {number} [fields.bias=0]       learned per-route offset (s)
 * @param {*}      [fields.trajectory=null]   Trajectory instance
 * @param {number} [fields.t_now]        unix seconds; defaults to Date.now()/1000
 * @returns {Readonly<Object>} a frozen VehicleState
 */
export function createState(fields) {
    if (!fields || typeof fields !== 'object') {
        throw new Error('createState: fields object is required');
    }
    const {
        vehicleId, tripId, routeId, directionId,
        arc, velocity,
        σ_arc = 10, σ_v = 2, bias = 0,
        trajectory = null,
        t_now,
    } = fields;

    if (typeof vehicleId !== 'string' || !vehicleId) throw new Error('createState: vehicleId must be a non-empty string');
    if (typeof tripId    !== 'string' || !tripId)    throw new Error('createState: tripId must be a non-empty string');
    if (typeof routeId   !== 'string' || !routeId)   throw new Error('createState: routeId must be a non-empty string');
    if (directionId !== 0 && directionId !== 1)      throw new Error('createState: directionId must be 0 or 1');
    if (!Number.isFinite(arc))                       throw new Error('createState: arc must be finite');
    if (!Number.isFinite(velocity) || velocity < 0)  throw new Error('createState: velocity must be a non-negative finite number');
    if (!(σ_arc > 0))                                throw new Error('createState: σ_arc must be positive');
    if (!(σ_v   > 0))                                throw new Error('createState: σ_v must be positive');
    if (!Number.isFinite(bias))                      throw new Error('createState: bias must be finite');

    const now = Number.isFinite(t_now) ? t_now : Date.now() / 1000;

    return Object.freeze({
        vehicleId, tripId, routeId, directionId,
        arc, velocity,
        σ_arc, σ_v, bias,
        trajectory,
        createdAt:        now,
        lastObservedAt:   now,
        lastTrajectoryAt: trajectory != null ? now : null,
    });
}

/**
 * Return a new frozen state with `patch` fields shallow-merged over `state`.
 * Validates that critical invariants are preserved (velocity ≥ 0, σ > 0,
 * identity fields unchanged).
 *
 * Phase 3 observation updaters use this internally to produce the new state
 * each time they apply a measurement.
 *
 * @param {Readonly<Object>} state
 * @param {Object} patch
 * @returns {Readonly<Object>} a new frozen state
 */
export function withUpdate(state, patch) {
    if (!state) throw new Error('withUpdate: state is required');
    if (!patch || typeof patch !== 'object') throw new Error('withUpdate: patch object is required');

    // Identity fields are immutable for the life of a state. Reassigning them
    // is almost certainly a bug (caller confused two vehicles); refuse loudly.
    for (const k of ['vehicleId', 'tripId', 'routeId', 'directionId']) {
        if (k in patch && patch[k] !== state[k]) {
            throw new Error(`withUpdate: cannot reassign identity field "${k}" (use createState for a new vehicle)`);
        }
    }

    const next = { ...state, ...patch };

    // Re-validate the invariants createState enforces, since patch could violate them.
    if (!Number.isFinite(next.arc))                              throw new Error('withUpdate: arc must remain finite');
    if (!Number.isFinite(next.velocity) || next.velocity < 0)    throw new Error('withUpdate: velocity must remain non-negative');
    if (!(next.σ_arc > 0))                                       throw new Error('withUpdate: σ_arc must remain positive');
    if (!(next.σ_v   > 0))                                       throw new Error('withUpdate: σ_v must remain positive');
    if (!Number.isFinite(next.bias))                             throw new Error('withUpdate: bias must remain finite');

    return Object.freeze(next);
}

/**
 * Convenience: replace the trajectory on a state and stamp `lastTrajectoryAt`.
 * Use after rebuilding the trajectory in response to an observation.
 *
 * @param {Readonly<Object>} state
 * @param {*}                trajectory   Trajectory instance, or null to clear
 * @param {number}           [t_now]      unix seconds; defaults to Date.now()/1000
 * @returns {Readonly<Object>}
 */
export function withTrajectory(state, trajectory, t_now) {
    const now = Number.isFinite(t_now) ? t_now : Date.now() / 1000;
    return withUpdate(state, {
        trajectory,
        lastTrajectoryAt: trajectory != null ? now : null,
    });
}

// ── Store ───────────────────────────────────────────────────────────────────

/**
 * Keyed container of {@link createState VehicleState} objects. Replaces the
 * module-level `markers[]` bag-of-properties used by the legacy architecture.
 *
 * Pure storage — no rendering, no map coupling, no globals. Stores immutable
 * (frozen) state objects; the only mutations are `set` / `archive` swapping
 * one entire state for another.
 *
 * The default key is `vehicleId`. Callers that need to key by `tripId` or
 * any other field can pass an explicit `keyFn` to the constructor.
 */
export class VehicleStateStore {
    /**
     * @param {Object} [opts]
     * @param {Function} [opts.keyFn]  state → string key. Default: state.vehicleId.
     */
    constructor({ keyFn = s => s.vehicleId } = {}) {
        if (typeof keyFn !== 'function') throw new Error('VehicleStateStore: keyFn must be a function');
        this._keyFn   = keyFn;
        this._states  = new Map();
        // Separate Map for archived states keeps the live-iteration path
        // (Phase 5 render loop) free of stale entries while preserving recent
        // history for debugging / late-arriving observation reconciliation.
        this._archived = new Map();
    }

    /** Insert or replace a state. Returns the stored state. */
    set(state) {
        if (!state || !Object.isFrozen(state)) {
            throw new Error('VehicleStateStore.set: expected a frozen VehicleState (use createState/withUpdate)');
        }
        const key = this._keyFn(state);
        if (!key) throw new Error('VehicleStateStore.set: keyFn returned a falsy key');
        // If this key was archived, un-archive it (vehicle came back).
        this._archived.delete(key);
        this._states.set(key, state);
        return state;
    }

    /** @returns {Readonly<Object>|null} the state for `key`, or null. */
    get(key) {
        return this._states.get(key) ?? null;
    }

    /** @returns {boolean} true if `key` has a live state. */
    has(key) {
        return this._states.has(key);
    }

    /** @returns {number} number of live states. */
    get size() {
        return this._states.size;
    }

    /** @returns {Iterable<Readonly<Object>>} live states (insertion order). */
    values() {
        return this._states.values();
    }

    /** @returns {Iterable<string>} live keys. */
    keys() {
        return this._states.keys();
    }

    /**
     * Move a state to the archived pool. The state is removed from `values()`
     * iteration and `has(key)` returns false, but `getArchived(key)` retains
     * it. Useful for end-of-line vehicles whose trajectory has just completed.
     *
     * @param {string} key
     * @returns {boolean} true if a state was archived; false if no such key
     */
    archive(key) {
        const state = this._states.get(key);
        if (!state) return false;
        this._states.delete(key);
        this._archived.set(key, state);
        return true;
    }

    /** @returns {Readonly<Object>|null} the archived state for `key`, or null. */
    getArchived(key) {
        return this._archived.get(key) ?? null;
    }

    /** Permanently remove from both live and archived pools. */
    delete(key) {
        const wasLive = this._states.delete(key);
        const wasArchived = this._archived.delete(key);
        return wasLive || wasArchived;
    }

    /** Drop archived states older than `olderThanSec`. */
    pruneArchived(olderThanSec) {
        const cutoff = Date.now() / 1000 - olderThanSec;
        let removed = 0;
        for (const [k, s] of this._archived) {
            if (s.lastObservedAt < cutoff) {
                this._archived.delete(k);
                removed++;
            }
        }
        return removed;
    }

    /** Clear all live and archived states. Mostly for tests. */
    clear() {
        this._states.clear();
        this._archived.clear();
    }
}
