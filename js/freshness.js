/**
 * Per-vehicle freshness tier classification.
 *
 * Single source of truth for every per-vehicle VISUAL state: marker opacity
 * (via _TIER_OPACITY in markers.js) and popup status-dot color (via the
 * .pv2-dot[data-tier="…"] CSS rules in index-style.css).
 *
 * Decoupled by design from:
 *   - DR motion watchdog (DR_MAX_SECONDS) — a frozen marker can still be live
 *   - Spike-rejection bypass (SPIKE_BYPASS_S) — algorithmic, not visual
 *   - ETA TTL (VEHICLE_MARKER_TTL_S) — predictions own their own freshness gate
 *
 * This lives in its own module so markers.js and ui.js can both import it
 * without creating a circular dependency (markers.js → ui.js → markers.js).
 */

import { FRESH_LIVE_S, FRESH_AGING_S, FRESH_EXPIRE_S } from './config.js';

/**
 * Classify a vehicle's freshness from its WS-arrival age (seconds).
 * @param {number} ageSec
 * @returns {'live'|'aging'|'stale'|'expired'}
 */
export function getFreshnessTierFromAge(ageSec) {
    if (ageSec >= FRESH_EXPIRE_S) return 'expired';
    if (ageSec >= FRESH_AGING_S)  return 'stale';
    if (ageSec >= FRESH_LIVE_S)   return 'aging';
    return 'live';
}

/**
 * Convenience: read marker.timestamp and compute tier vs now.
 * @param {Object} marker — must have .timestamp (unix seconds)
 * @param {number} nowSec — current unix seconds
 */
export function getFreshnessTier(marker, nowSec) {
    return getFreshnessTierFromAge(nowSec - (marker?.timestamp ?? 0));
}
