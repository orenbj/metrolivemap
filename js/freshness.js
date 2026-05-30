/**
 * Per-vehicle freshness tier classification.
 *
 * Single source of truth for every per-vehicle VISUAL state: marker opacity
 * (via _TIER_OPACITY in markers.js) and popup status-dot color (via the
 * .pv2-dot[data-tier="…"] CSS rules in index-style.css).
 *
 * Decoupled by design from:
 *   - Spike-rejection bypass (SPIKE_BYPASS_S) — algorithmic, not visual
 *   - ETA TTL (VEHICLE_MARKER_TTL_S) — predictions own their own freshness gate
 *
 * This lives in its own module so markers.js and ui.js can both import it
 * without creating a circular dependency (markers.js → ui.js → markers.js).
 */

import { FRESH_STALE_S, FRESH_EXPIRE_S } from './config.js';

/**
 * Classify a vehicle's freshness from its WS-arrival age (seconds).
 *
 * Three tiers (was four; `aging` was collapsed in the KISS pass —
 * it had no behavioral consumers and rendered identically to live).
 *
 * @param {number} ageSec
 * @returns {'live'|'stale'|'expired'}
 */
export function getFreshnessTierFromAge(ageSec) {
    // Inclusive lower bounds: age exactly at a boundary enters the next tier.
    // Pinned by tests/freshness-tier.test.js — change the boundary semantics
    // and the boundary cases there break.
    if (ageSec >= FRESH_EXPIRE_S) return 'expired';
    if (ageSec >= FRESH_STALE_S)  return 'stale';
    return 'live';
}

/**
 * Convenience: read marker._lastAcceptedTs (or .timestamp as fallback) and
 * compute tier vs now.
 *
 * _lastAcceptedTs tracks only GPS-accepted fixes; marker.timestamp is also
 * bumped on spike-rejected frames so isStaleRef (algorithmic gate) never fires
 * during a rejection streak. Using _lastAcceptedTs here means the visual tier
 * (green/gray/gone) reflects the age of the last TRUSTED position, not the last
 * heard-from time — a frozen marker whose GPS is bad goes gray/gone correctly.
 *
 * @param {Object} marker — must have ._lastAcceptedTs or .timestamp (unix seconds)
 * @param {number} nowSec — current unix seconds
 * @returns {'live'|'stale'|'expired'}
 */
export function getFreshnessTier(marker, nowSec) {
    const ts = marker?._lastAcceptedTs ?? marker?.timestamp ?? 0;
    return getFreshnessTierFromAge(nowSec - ts);
}
