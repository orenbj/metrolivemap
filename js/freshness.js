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
 * Convenience: read the marker's RECEIPT clock (_lastAcceptedWallMs, the
 * wall-clock moment of the last ACCEPTED fix) and compute the tier vs now.
 *
 * This is the SAME clock the popup footer dot + "Xs ago" use, so the marker
 * opacity, the popup dot, and the "Xs ago" number never disagree. (The old
 * split — opacity on _lastAcceptedTs, popup on _lastAcceptedWallMs — let a
 * feed-lagged train fade gray on the map while its popup still read green
 * "45s ago": the feed's GPS timestamp lags ~40s+ in the downtown tunnel.)
 *
 * Receipt time keeps the anti-spike safety that motivated the original
 * _lastAcceptedTs choice: it advances ONLY on accepted fixes (a spike-rejection
 * streak, or frozen-GPS `olderTs` rejections, never reset it), so a genuinely
 * stuck/bad-GPS marker still ages to gray/expired. The only behavior that
 * changes is that a live train on a lagging feed stays green — which is correct,
 * it IS live. (Predictions own a SEPARATE freshness gate that still reads
 * _lastAcceptedTs — a data-staleness question, not a visual one.)
 *
 * _lastAcceptedWallMs is milliseconds; everything else here is unix seconds.
 *
 * @param {Object} marker — has ._lastAcceptedWallMs (ms) or ._lastAcceptedTs / .timestamp (s)
 * @param {number} nowSec — current unix seconds
 * @returns {'live'|'stale'|'expired'}
 */
export function getFreshnessTier(marker, nowSec) {
    const ts = marker?._lastAcceptedWallMs != null
        ? marker._lastAcceptedWallMs / 1000
        : (marker?._lastAcceptedTs ?? marker?.timestamp ?? 0);
    return getFreshnessTierFromAge(nowSec - ts);
}
