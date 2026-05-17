/**
 * @module animationStore
 *
 * Singleton Map<tripId, AnimationEntry> keyed by trip_id. Replaces the
 * heavier `phase5State.js` (vehicleStateStore + dwellModel) under the
 * Phase 5b blend-anchored pivot.
 *
 * AnimationEntry:
 *   tripId           string
 *   routeId          string
 *   directionId      0 | 1
 *   trajectory       Trajectory|null     // from animationBuilder.buildAnimationTrajectory
 *   nextStopArc      number|null          // informational; renderLoop relies on
 *                                         // Trajectory's internal arc_end clamp, not
 *                                         // a per-frame cap against this field
 *   lastObservedAt   number               // unix s; staleness gate input
 *   lastBlendEtaUnix number|null          // last blend ETA that drove the build (for debounce)
 *   lastBuildAt      number               // performance.now()-ish ms; debounce window
 *
 * The store is intentionally tiny — there is no per-vehicle Kalman state
 * to maintain. Each entry is a snapshot of "what trajectory should I be
 * animating right now"; entries are rebuilt whenever a fresh WS fix or
 * a fresh blend ETA refresh lands (see animationWiring.updateAnimationFor).
 *
 * Pure module: no DOM, no window globals, no MapLibre. Importable from
 * tests without environment setup.
 */

/** @type {Map<string, Readonly<Object>>} */
export const animations = new Map();

/**
 * @param {string} tripId
 * @returns {Readonly<Object>|null}
 */
export function getAnimation(tripId) {
    return animations.get(String(tripId)) ?? null;
}

/**
 * Stash a freshly-built animation entry. Frozen to prevent accidental
 * mutation by the renderLoop or other consumers.
 *
 * @param {string} tripId
 * @param {Object} entry
 * @returns {Readonly<Object>}
 */
export function setAnimation(tripId, entry) {
    const frozen = Object.freeze({ ...entry, tripId: String(tripId) });
    animations.set(String(tripId), frozen);
    return frozen;
}

/**
 * Remove the animation entry for a trip. Called when a marker is removed
 * (markers._fadeOutAndRemove) so the renderLoop stops trying to animate
 * a vehicle that no longer has a DOM marker.
 *
 * @param {string} tripId
 * @returns {boolean} true if an entry was removed
 */
export function deleteAnimation(tripId) {
    return animations.delete(String(tripId));
}

/**
 * Test-only helper. Production code never calls this; the store survives
 * the whole session and only individual entries are evicted via
 * deleteAnimation.
 */
export function _clearAnimations() {
    animations.clear();
}
