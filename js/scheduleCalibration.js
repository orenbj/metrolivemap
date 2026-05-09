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

const STORAGE_KEY      = 'metro-livemap.scheduleSpeedV1';
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
const MAX_AGE_MS       = 7 * 24 * 60 * 60 * 1000; // stale after 7 days of no updates
const SAVE_THROTTLE_MS = 30_000; // write to localStorage at most once per 30 s

let state   = loadState();
let saveTimer = null;
const _rejectCounts = {};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
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
    const prev  = state[key] ?? { multiplier: 1.0, observations: 0, updatedAt: 0 };

    // On first observation, seed directly; thereafter blend with EWMA.
    // Clamp the output defensively: both inputs are bounded but belt-and-suspenders
    // ensures the stored multiplier never leaks outside [MIN_RATIO, MAX_RATIO] even
    // if prev.multiplier was somehow corrupted (e.g. by an older localStorage entry).
    const m = Math.max(MIN_RATIO, Math.min(MAX_RATIO,
        prev.observations === 0
            ? ratio
            : ALPHA * ratio + (1 - ALPHA) * prev.multiplier
    ));

    state[key] = { multiplier: m, observations: prev.observations + 1, updatedAt: Date.now() };
    scheduleSave();
}

/**
 * Return the learned travel-time multiplier for a (route, direction) pair.
 * Returns 1.0 (no correction) until MIN_OBS_FOR_USE observations have
 * accumulated or the entry has aged past MAX_AGE_MS.
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
    return entry.multiplier;
}

/**
 * Return a snapshot of current calibration state (for debugging / test diagnostics).
 * Safe to call from the browser console: `getCalibrationSnapshot()` exposed on `window`
 * (e.g. window.scheduleState).
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
