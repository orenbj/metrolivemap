/**
 * scheduleCalibration.js
 * Online learning of per-(route, direction) travel-time multipliers using
 * a bounded EWMA over observed vs scheduled inter-stop segment times.
 *
 * Corrects systematic GTFS schedule optimism (Metro trains run ~5–20% slower
 * than scheduled) without offline calibration or Kalman complexity.
 *
 * References:
 *   TheTransitClock — per-(route, dir, time-of-day) EWMA
 *   Stanford EWMM (Luxenberg & Boyd) — EWMA math
 *   Cathey & Dailey 2003 — bounded-ratio segment-time models
 */

// V2 schema (2026-05-26) — added per-entry `m2` (EWMA of squared residuals)
// alongside the existing mean multiplier. V1 entries lack `m2` and the load
// validator below rejects them; routes re-converge from scratch over 1–2
// service days. The key bump avoids stale V1 multipliers slipping past the
// new variance gate just because their stddev was never measured.
const STORAGE_KEY      = 'metro-livemap.scheduleSpeedV2';
// Bumped 0.15→0.25 (2026-05-07): most active routes now have N≥80 observations;
// faster adaptation lets the model react to schedule changes within ~2 service days
// instead of ~5 without sacrificing stability on well-converged routes.
const ALPHA            = 0.25;   // EWMA weight on each new observation
const MIN_RATIO        = 0.7;    // floor — observed can't be < 70% of scheduled
const MAX_RATIO        = 1.7;    // ceiling — observed can't be > 170% of scheduled
                                 // Bumped from 1.5 (2026-05-06): v6 audit showed A/C/E
                                 // saturating at 1.30 with -141s long-horizon early bias.
                                 // Headroom lets the model express slower trips.
// Absolute delay cap: if observed − scheduled > 300 s the vehicle was almost
// certainly held at a station (signal hold, platform dwell, incident), not
// running systematically slowly. Ratios near 3× on short segments (e.g. 30 s
// scheduled → 90 s observed) would also exceed 300 s only unrealistically;
// for long segments (200 s scheduled → 500 s observed, ratio=2.5) the ratio
// guard passes but the absolute delay betrays an exceptional event. Reject so
// incidents don't pull the EWMA toward MAX_RATIO and inflate future ETAs.
const MAX_DELAY_ABS_S  = 300;
const MIN_OBS_FOR_USE  = 5;      // use multiplier = 1.0 until N observations warm the model
// Variance gate: if the EWMA of squared residuals exceeds this stddev (in
// units of the ratio itself, ~18% spread around the mean), the multiplier
// is too uncertain to apply — the route's actual run-time wanders wildly
// relative to schedule, so trusting the noisy mean would inflate ETA error
// in both directions. Conservative initial default; tune from the offline
// 57,954-snapshot dataset (docs/blend-tuning-2026-05.md) once variance has
// been collected long enough to characterise per-route stddev distribution.
const MAX_STDDEV       = 0.18;
const MAX_AGE_MS       = 7 * 24 * 60 * 60 * 1000; // stale after 7 days of no updates
const SAVE_THROTTLE_MS = 30_000; // write to localStorage at most once per 30 s

let state   = loadState();
let saveTimer = null;
const _rejectCounts = {};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        // Validate shape: each entry must be an object with numeric fields.
        // A corrupt or wrong-typed entry (e.g. a bare number) would cause NaN
        // to propagate through the EWMA silently.
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        const clean = {};
        for (const [k, v] of Object.entries(parsed)) {
            // V2 requires `m2` (EWMA squared-residual) in addition to the
            // V1 fields. Entries without it are silently dropped — the
            // STORAGE_KEY bump above means we shouldn't actually see V1
            // shapes here, but the defensive check guards against
            // partial-write corruption and forward-compat slip-ups.
            if (typeof v === 'object' && v !== null &&
                Number.isFinite(v.multiplier) && Number.isFinite(v.observations) &&
                Number.isFinite(v.m2)) {
                clean[k] = v;
            }
        }
        return clean;
    } catch {
        return {};
    }
}

function scheduleSave() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* quota */ }
        saveTimer = null;
    }, SAVE_THROTTLE_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record an observed inter-stop segment time against its scheduled counterpart.
 *
 * @param {string} routeCode   e.g. "801", "901"
 * @param {number} directionId 0 or 1
 * @param {number} observedSec Wall-clock seconds actually taken
 * @param {number} scheduledSec GTFS scheduled seconds for the same segment
 */
export function recordSegmentTime(routeCode, directionId, observedSec, scheduledSec) {
    if (!routeCode || directionId == null) return;
    if (!Number.isFinite(observedSec) || !Number.isFinite(scheduledSec)) return;
    // Defensive: scheduledSec must be strictly positive. The range gate
    // below (< 10) already rejects zero in current call paths, but a future
    // relaxation of that bound — or a rounding edge case that produces
    // exactly zero — would let division at line 102 produce Infinity. The
    // outlier gate (rawRatio > MAX_RATIO) currently catches Infinity by
    // coincidence; the defensive check makes that resilience explicit.
    if (scheduledSec <= 0) return;
    // Guard rails: skip implausibly short scheduled gaps and outlier observations
    if (scheduledSec < 10 || observedSec < 15 || observedSec > 600) {
        const k = `${routeCode}:range`;
        _rejectCounts[k] = (_rejectCounts[k] ?? 0) + 1;
        return;
    }
    // Absolute delay cap: reject incident-held observations that the ratio guard
    // alone would miss on longer scheduled segments (e.g. 200 s scheduled, 510 s
    // observed → ratio=2.55 passes 3.0 filter but delay=310 s signals an event).
    if (observedSec - scheduledSec > MAX_DELAY_ABS_S) {
        const k = `${routeCode}:delay`;
        _rejectCounts[k] = (_rejectCounts[k] ?? 0) + 1;
        return;
    }
    // Reject raw-ratio outliers before clamping — prevents stale/jump GPS reads from
    // poisoning the EWMA seed (e.g. 4s observed / 300s scheduled = 0.01, clamped to 0.7).
    const rawRatio = observedSec / scheduledSec;
    if (rawRatio < 0.3 || rawRatio > 3.0) {
        const k = `${routeCode}:ratio`;
        _rejectCounts[k] = (_rejectCounts[k] ?? 0) + 1;
        return;
    }

    const ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, rawRatio));
    const key   = `${routeCode}|${directionId}`;
    const prev  = state[key] ?? { multiplier: 1.0, m2: 0, observations: 0, updatedAt: 0 };

    // On first observation, seed directly; thereafter blend with EWMA.
    // Clamp the output defensively: both inputs are bounded but belt-and-suspenders
    // ensures the stored multiplier never leaks outside [MIN_RATIO, MAX_RATIO] even
    // if prev.multiplier was somehow corrupted (e.g. by an older localStorage entry).
    const m = Math.max(MIN_RATIO, Math.min(MAX_RATIO,
        prev.observations === 0
            ? ratio
            : ALPHA * ratio + (1 - ALPHA) * prev.multiplier
    ));

    // EWMA of squared residuals against the *previous* mean — gives a
    // dispersion estimate that lags the mean by one sample (vs Welford,
    // which is unbiased but stateful in a way the bounded-ratio model
    // doesn't need). On the first observation there's no residual yet
    // (residual = 0), which keeps cold-start m2 honest about uncertainty
    // — high m2 only accumulates as repeated observations diverge.
    const residual = ratio - prev.multiplier;
    const m2 = prev.observations === 0
        ? 0
        : ALPHA * residual * residual + (1 - ALPHA) * (prev.m2 ?? 0);

    state[key] = {
        multiplier:   m,
        m2,
        observations: prev.observations + 1,
        updatedAt:    Date.now(),
    };
    scheduleSave();
}

/**
 * Return the learned travel-time multiplier for a (route, direction) pair.
 * Returns 1.0 (no correction) when:
 *   • route/direction key is missing,
 *   • the entry has aged past MAX_AGE_MS (~7 days),
 *   • fewer than MIN_OBS_FOR_USE observations have accumulated,
 *   • the observed-vs-scheduled ratio's stddev exceeds MAX_STDDEV (the route
 *     is too noisy for the mean to be a trustworthy "correction" — applying
 *     it would inflate ETA error in both directions).
 *
 * @param {string} routeCode
 * @param {number|null} directionId
 * @returns {number} multiplier ∈ [MIN_RATIO, MAX_RATIO]
 */
export function getSpeedMultiplier(routeCode, directionId) {
    if (!routeCode || directionId == null) return 1.0;
    const entry = state[`${routeCode}|${directionId}`];
    if (!entry) return 1.0;
    if (Date.now() - entry.updatedAt > MAX_AGE_MS) return 1.0;
    if (entry.observations < MIN_OBS_FOR_USE) return 1.0;
    if (Math.sqrt(entry.m2 ?? 0) > MAX_STDDEV) return 1.0;
    return entry.multiplier;
}

/**
 * Return a snapshot of current calibration state (for debugging / test diagnostics).
 * Exposed on `window` (see bottom of this file) so it's callable from the
 * browser console as `window.getCalibrationSnapshot()`.
 *
 * Per-entry shape: `{ multiplier, m2, observations, updatedAt }` where
 * `multiplier` is the EWMA mean of the observed/scheduled ratio and
 * `m2` is the EWMA of squared residuals against the previous mean.
 * Compute stddev as `Math.sqrt(entry.m2)` for a quick dispersion read.
 */
export function getCalibrationSnapshot() {
    return JSON.parse(JSON.stringify(state));
}

/**
 * Return per-route rejection counts for recordSegmentTime, keyed by
 * "routeCode:reason" (reason: "range" | "delay" | "ratio"). Used to diagnose routes
 * with zero calibration entries (e.g. B Line showing pctActive=0% in harness).
 * Call from console: getCalibrationRejectStats()
 */
export function getCalibrationRejectStats() {
    return { ..._rejectCounts };
}

// Expose on window for easy console inspection
window.getCalibrationSnapshot    = getCalibrationSnapshot;
window.getCalibrationRejectStats = getCalibrationRejectStats;

/**
 * Test-only: clear in-memory state, any pending save timer, and persisted
 * storage. Lightweight alternative to `vi.resetModules()`; used by
 * tests/scheduleCalibration.test.js.
 */
export function _resetForTest() {
    state = {};
    if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
