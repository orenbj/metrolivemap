/**
 * @module animationWiring
 *
 * Resolve the inputs `animationBuilder.buildAnimationTrajectory` needs
 * (route cache lookup, next-stop arc, schedule fallback speed) and stash
 * the result in `animationStore`. Called from:
 *
 *   - `markers.js` — after every WS vehicle fix that updates marker.lastSnap.
 *     The GPS fix is the highest-frequency anchor refresh.
 *   - `predictions.js getScheduledArrivals` — after computing a blend ETA
 *     for a vehicle at its current next stop. This is the popup-driven
 *     refresh (one per visible station/vehicle popup, ~5 s tick).
 *
 * Idempotent within a 250 ms debounce window when the inputs haven't
 * changed — popup refresh + WS fix can land in quick succession; we
 * don't need to rebuild the trajectory in both calls.
 *
 * Pure-ish: depends on `getRouteCache` from predictions.js and the
 * animationStore singleton. No DOM, no window globals beyond
 * `masterStopsData` (consulted via predictions.getRouteCache).
 */

import { getRouteCache, findIdx } from './predictions.js';
import { buildAnimationTrajectory } from './animationBuilder.js';
import { animations, setAnimation, deleteAnimation } from './animationStore.js';
import { getSpeedMultiplier } from './scheduleCalibration.js';

/**
 * Minimum time between rebuilds for an unchanged (blendEtaUnix,
 * nextStopArc) pair. Without this, the popup refresh path can call
 * `updateAnimationFor` repeatedly within the same 5 s tick (one call per
 * visible trip per refresh) and we'd be allocating a fresh Trajectory
 * each time for no benefit.
 */
const REFRESH_DEBOUNCE_MS = 250;

/**
 * Refresh (or seed) the animation entry for tripId.
 *
 * @param {Object} params
 * @param {string} params.tripId
 * @param {string|number} params.routeCode
 * @param {number|string} params.directionId
 * @param {string|number} params.nextStopId
 * @param {number} params.currentArc       Vehicle's last snapped arc (m)
 * @param {number|null} params.blendEtaUnix  Per-trip blend ETA at next stop, or null
 * @param {number} params.nowUnix
 * @param {number|null} [params.gpsSpeedMps]
 * @param {number|null} [params.gpsTimestamp]
 * @returns {Readonly<Object>|null}  The updated entry, or null when inputs are insufficient.
 */
export function updateAnimationFor({
    tripId, routeCode, directionId, nextStopId,
    currentArc, blendEtaUnix, nowUnix,
    gpsSpeedMps = null, gpsTimestamp = null,
}) {
    if (!tripId || !routeCode || directionId == null || !nextStopId) return null;

    const dir = Number(directionId);
    const cache = getRouteCache(String(routeCode), dir);
    if (!cache?.arcMeters?.length) return null;

    const stopIdx = findIdx(cache.stops, String(nextStopId));
    if (stopIdx < 0) return null;
    const nextStopArc = cache.arcMeters[stopIdx];
    if (!Number.isFinite(nextStopArc)) return null;

    // Debounce: popup refresh path may call multiple times in quick
    // succession with identical inputs.
    const existing = animations.get(String(tripId));
    if (existing
        && (Date.now() - existing.lastBuildAt) < REFRESH_DEBOUNCE_MS
        && existing.lastBlendEtaUnix === blendEtaUnix
        && existing.nextStopArc === nextStopArc) {
        return existing;
    }

    // Schedule-derived fallback cruise speed, for when blendEtaUnix is null
    // (cold-start vehicle that hasn't surfaced in masterArrivalsData yet).
    // Same arithmetic the legacy trajectoryBuilder used: dist/dt across
    // the segment leading INTO this stop, optionally divided by the
    // per-route speed-calibration multiplier so the fallback honors
    // observed adherence.
    let fallbackSpeedMps = null;
    if (stopIdx > 0) {
        const prevArc = cache.arcMeters[stopIdx - 1];
        const prevTime = cache.times?.[stopIdx - 1];
        const curTime  = cache.times?.[stopIdx];
        if (Number.isFinite(prevArc) && Number.isFinite(prevTime) && Number.isFinite(curTime)) {
            const dt = curTime - prevTime;
            if (dt > 0) {
                const mult = getSpeedMultiplier(String(routeCode), dir) || 1;
                fallbackSpeedMps = ((nextStopArc - prevArc) / dt) / mult;
            }
        }
    }

    const trajectory = buildAnimationTrajectory({
        routeCode: String(routeCode), nowUnix, currentArc, nextStopArc,
        blendEtaUnix, fallbackSpeedMps,
        gpsSpeedMps, gpsTimestamp,
    });
    if (!trajectory) return null;

    return setAnimation(tripId, {
        tripId: String(tripId),
        routeId: String(routeCode),
        directionId: dir,
        trajectory,
        nextStopArc,
        lastObservedAt: nowUnix,
        lastBlendEtaUnix: Number.isFinite(blendEtaUnix) ? blendEtaUnix : null,
        lastBuildAt: Date.now(),
    });
}

/**
 * Remove the animation entry for tripId. Called from `_fadeOutAndRemove`
 * in markers.js so the renderLoop stops trying to animate a vanished
 * marker.
 *
 * @param {string} tripId
 */
export function clearAnimationFor(tripId) {
    deleteAnimation(tripId);
}

// Exported for tests.
export const _DEBOUNCE_MS = REFRESH_DEBOUNCE_MS;
