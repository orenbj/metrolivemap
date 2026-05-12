/**
 * @module dwellModel
 *
 * Per-(stop, route, direction) dwell duration learner. The trajectory builder
 * (Phase 1's `fromAnchor`) consumes one number per stop — the seconds a
 * vehicle holds its position there. The legacy architecture models this as
 * zero, which is a primary source of the systematic calc bias the live-
 * accuracy harness keeps surfacing (calc consistently ~37 s early).
 *
 * This module supplies that number. Two layers:
 *
 *   1. **Fallback defaults** — a flat per-mode value (rail vs bus) used when
 *      no observation exists for a key yet. Conservative; better than zero
 *      but won't reflect the difference between Pico Station (high dwell)
 *      and a low-traffic outbound stop.
 *
 *   2. **Online learning** — bounded EWMA over observed STOPPED_AT durations.
 *      Each observed dwell folds into the per-key mean with α weight.
 *      A warmup gate keeps the fallback in force until N observations have
 *      accumulated, so the model doesn't trust a single noisy first reading.
 *
 * Optional **timepoint flag** marks stops where the scheduled departure is
 * binding — early vehicles hold there until the scheduled time. The Phase 1
 * builder consumes this via the `scheduled_time` field on the stop record;
 * this module just remembers which stops have the flag set.
 *
 * Phase 4 of the trajectory-model overhaul (docs/trajectory-overhaul.md).
 * Self-contained class — no globals, no DOM, no MapLibre, no `window.*`.
 * Not yet imported by any other module.
 *
 * ## Why a class and not module-level state
 *
 * `scheduleCalibration.js` keeps state at module scope and provides functional
 * accessors. That makes tests order-dependent and bites every time we add
 * new behaviour. The new modules in the overhaul (Trajectory, VehicleState,
 * stateUpdaters) all avoid module-level state. DwellModel follows suit:
 * tests instantiate their own model with a unique storage key (or no key) so
 * they cannot leak through localStorage either.
 */

const DEFAULT_OPTIONS = Object.freeze({
    storageKey:        null,                       // null = no persistence (tests)
    ewmaAlpha:         0.20,                       // EWMA weight on each new obs
    minObsForUse:      3,                          // warmup gate: trust learned value after N obs
    minObservedSec:    5,                          // reject sub-5-s readings (pass-through)
    maxObservedSec:    300,                        // reject > 5 min (terminus layover, breakdown)
    minDwellSec:       0,                          // clamp learned mean ≥ 0
    maxDwellSec:       120,                        // clamp learned mean ≤ 2 min
    maxAgeMs:          7 * 24 * 60 * 60 * 1000,    // entries older than this fall back to default
    saveThrottleMs:    30_000,
    defaultRailDwellS: 30,                         // baseline before learning kicks in
    defaultBusDwellS:  15,
});

/**
 * Build a canonical key for a (stopId, routeId, directionId) triple.
 * Each component is coerced to string and falsy/null/undefined direction
 * normalises to '?' (rare; mostly defensive against partial GTFS metadata).
 */
function _key(stopId, routeId, directionId) {
    return `${stopId}|${routeId}|${directionId ?? '?'}`;
}

export class DwellModel {
    constructor(options = {}) {
        // Shallow-merge over defaults; reject obvious garbage so a misconfigured
        // call site can't silently disable the warmup gate or set negative α.
        const opts = { ...DEFAULT_OPTIONS, ...options };
        if (!(opts.ewmaAlpha > 0 && opts.ewmaAlpha <= 1)) {
            throw new Error('DwellModel: ewmaAlpha must be in (0, 1]');
        }
        if (!(opts.minObsForUse >= 1)) throw new Error('DwellModel: minObsForUse must be ≥ 1');
        if (!(opts.minObservedSec >= 0 && opts.maxObservedSec > opts.minObservedSec)) {
            throw new Error('DwellModel: observation bounds must be 0 ≤ min < max');
        }
        if (!(opts.maxDwellSec > opts.minDwellSec)) {
            throw new Error('DwellModel: dwell bounds must be min < max');
        }
        this._opts = opts;
        this._entries    = new Map();   // key → { mean, n, lastUpdated }
        this._timepoints = new Set();   // canonical keys of timepoint stops
        this._saveTimer  = null;
        if (opts.storageKey) this._load();
    }

    // ── Observation ─────────────────────────────────────────────────────────

    /**
     * Fold one observed dwell duration into the per-(stop, route, dir) EWMA.
     * Out-of-range observations are silently dropped — terminus layovers and
     * speed=0 pass-throughs both produce dwell observations that would skew
     * the learned mean if accepted.
     *
     * @param {Object} obs
     * @param {string} obs.stopId
     * @param {string} obs.routeId
     * @param {number} obs.directionId   0 | 1
     * @param {number} obs.observedSec   wall-clock seconds the vehicle was STOPPED_AT
     * @param {number} [obs.t]           unix seconds; defaults to Date.now()/1000
     * @returns {boolean} true if the observation was accepted
     */
    record({ stopId, routeId, directionId, observedSec, t }) {
        if (!stopId || !routeId) return false;
        if (!Number.isFinite(observedSec)) return false;
        if (observedSec < this._opts.minObservedSec) return false;
        if (observedSec > this._opts.maxObservedSec) return false;

        const k = _key(stopId, routeId, directionId);
        const now = Number.isFinite(t) ? t : Date.now() / 1000;
        const prev = this._entries.get(k);

        if (!prev) {
            // First observation seeds the mean directly. EWMA only kicks in
            // on the second observation onward, otherwise the very first
            // reading is artificially diluted by the (implicit zero) seed.
            this._entries.set(k, { mean: observedSec, n: 1, lastUpdated: now });
        } else {
            const blended = this._opts.ewmaAlpha * observedSec + (1 - this._opts.ewmaAlpha) * prev.mean;
            const clamped = Math.max(this._opts.minDwellSec,
                              Math.min(this._opts.maxDwellSec, blended));
            this._entries.set(k, { mean: clamped, n: prev.n + 1, lastUpdated: now });
        }

        this._scheduleSave();
        return true;
    }

    // ── Queries ─────────────────────────────────────────────────────────────

    /**
     * Return the dwell estimate (seconds) for a (stop, route, dir) triple.
     * Falls back to the per-mode default until N observations have warmed
     * the entry. Falls back also if the entry has aged past maxAgeMs.
     *
     * @param {Object} q
     * @param {string} q.stopId
     * @param {string} q.routeId
     * @param {number} q.directionId
     * @param {boolean} [q.isBus=false]    pick the bus default vs rail default
     * @param {number} [q.t]               for age-since-update check
     * @returns {number} seconds
     */
    get({ stopId, routeId, directionId, isBus = false, t }) {
        const k = _key(stopId, routeId, directionId);
        const entry = this._entries.get(k);
        const fallback = isBus ? this._opts.defaultBusDwellS : this._opts.defaultRailDwellS;

        if (!entry) return fallback;
        if (entry.n < this._opts.minObsForUse) return fallback;

        // Age gate: stale entries fall back to the default rather than
        // perpetuating a value learned weeks ago against current operations.
        const now = Number.isFinite(t) ? t : Date.now() / 1000;
        if ((now - entry.lastUpdated) * 1000 > this._opts.maxAgeMs) return fallback;

        return entry.mean;
    }

    /**
     * Raw entry for inspection / tests. Returns null when the key is unknown.
     * The `isWarm` flag mirrors the warmup gate used by `get()`.
     *
     * @returns {{ mean: number, n: number, lastUpdated: number, isWarm: boolean }|null}
     */
    getEntry({ stopId, routeId, directionId }) {
        const k = _key(stopId, routeId, directionId);
        const entry = this._entries.get(k);
        if (!entry) return null;
        return {
            mean:        entry.mean,
            n:           entry.n,
            lastUpdated: entry.lastUpdated,
            isWarm:      entry.n >= this._opts.minObsForUse,
        };
    }

    // ── Timepoint flag ──────────────────────────────────────────────────────

    /**
     * Whether early vehicles must hold at this (stop, route, dir) until the
     * scheduled departure. GTFS encodes this in `stop_times.timepoint`.
     */
    isTimepoint({ stopId, routeId, directionId }) {
        return this._timepoints.has(_key(stopId, routeId, directionId));
    }

    setTimepoint({ stopId, routeId, directionId, value }) {
        const k = _key(stopId, routeId, directionId);
        if (value) this._timepoints.add(k);
        else       this._timepoints.delete(k);
        this._scheduleSave();
    }

    /**
     * Bulk import from GTFS stop_times data. Each row contains stopId, routeId,
     * directionId, dwellSec (from arrival/departure deltas), and isTimepoint.
     * Existing entries are NOT overwritten — observed data outweighs schedule.
     */
    seedFromGtfs(rows) {
        if (!Array.isArray(rows)) return 0;
        let seeded = 0;
        for (const row of rows) {
            const { stopId, routeId, directionId, dwellSec, isTimepoint } = row ?? {};
            if (!stopId || !routeId) continue;
            const k = _key(stopId, routeId, directionId);
            if (Number.isFinite(dwellSec)
                && dwellSec >= this._opts.minDwellSec
                && dwellSec <= this._opts.maxDwellSec
                && !this._entries.has(k)) {
                // Seed with n=0 so `get()` still falls back to the default
                // until real observations warm it — schedule dwell is a coarse
                // baseline, observed dwell is what we ultimately trust.
                this._entries.set(k, { mean: dwellSec, n: 0, lastUpdated: 0 });
                seeded++;
            }
            if (isTimepoint) this._timepoints.add(k);
        }
        this._scheduleSave();
        return seeded;
    }

    // ── Introspection / lifecycle ───────────────────────────────────────────

    /**
     * Plain-object snapshot of the current state. Useful for tests, telemetry,
     * and the developer console; never call on a hot path.
     */
    snapshot() {
        return {
            numEntries:  this._entries.size,
            numTimepoints: this._timepoints.size,
            entries:     Object.fromEntries(this._entries),
            timepoints:  [...this._timepoints],
        };
    }

    /** Drop all learned state. Mostly for tests. */
    clear() {
        this._entries.clear();
        this._timepoints.clear();
        this._scheduleSave();
    }

    // ── Persistence ─────────────────────────────────────────────────────────

    _scheduleSave() {
        if (!this._opts.storageKey) return;
        if (this._saveTimer !== null) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._save();
        }, this._opts.saveThrottleMs);
    }

    /** Force an immediate write to localStorage. */
    flush() {
        if (this._saveTimer !== null) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._save();
    }

    _save() {
        if (!this._opts.storageKey) return;
        try {
            const payload = {
                entries:    Object.fromEntries(this._entries),
                timepoints: [...this._timepoints],
            };
            globalThis.localStorage?.setItem(this._opts.storageKey, JSON.stringify(payload));
        } catch { /* quota / unavailable — ignore */ }
    }

    _load() {
        try {
            const raw = globalThis.localStorage?.getItem(this._opts.storageKey);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;

            // Validate each entry: refuse to load a corrupted shape that would
            // propagate NaN through the EWMA on the next observation.
            if (parsed.entries && typeof parsed.entries === 'object') {
                for (const [k, v] of Object.entries(parsed.entries)) {
                    if (v && typeof v === 'object'
                        && Number.isFinite(v.mean) && Number.isFinite(v.n)
                        && Number.isFinite(v.lastUpdated)) {
                        this._entries.set(k, { mean: v.mean, n: v.n, lastUpdated: v.lastUpdated });
                    }
                }
            }
            if (Array.isArray(parsed.timepoints)) {
                for (const k of parsed.timepoints) {
                    if (typeof k === 'string') this._timepoints.add(k);
                }
            }
        } catch { /* malformed — start clean */ }
    }
}
