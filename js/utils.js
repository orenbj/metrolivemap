/**
 * utils.js
 * Shared math and string utilities for the Metro Live Map.
 */

// Calibrated for LA basin. Metro's service area spans 33.5°N (Long Beach) to
// 34.4°N (Lancaster); these constants minimize the worst-case error across that
// range. Verified 2026-05-10: 92630 implies an effective latitude of ~33.68°N
// (just south of downtown LA, near Compton). This biases the constant slightly
// higher than the 111320·cos(lat) value at every latitude north of 33.68°N —
// distances come out 0.4–0.9% longer than spherical truth at 34°N, ~0.9% longer
// at Lancaster. The bias is conservative for spike rejection (tightens the
// "this fix is implausibly far" gate) and immaterial for snap deviation (the
// snap arc itself is the source of truth; planar deviation is a sanity check).
/** Mean meters per degree of latitude. Standard value ~111,132 m/° at the equator
 *  is essentially constant worldwide; 110540 is rounded slightly low to pair
 *  with M_PER_DEG_LNG_LA's calibration. */
export const M_PER_DEG_LAT    = 110540;
/** Mean meters per degree of longitude at the codebase's calibration latitude
 *  of ~33.68°N (mid LA basin). Computed from 111320·cos(33.68°) ≈ 92,630. */
export const M_PER_DEG_LNG_LA = 92630;


/**
 * Normalize a unix timestamp to seconds. Accepts both seconds and milliseconds.
 * GTFS-RT spec is seconds, but Metro feeds have historically sent ms in some
 * fields, so a defensive normalize-at-the-boundary keeps downstream math
 * uniform. Values above 1e10 (≈ year 2286) are treated as milliseconds.
 *
 * Single source of truth — previously duplicated in api.js, tripUpdates.js,
 * and alerts.js as three near-identical copies. Consolidated here so a future
 * fix only needs one edit. Also accepts ISO-8601 strings (Metro's alerts API
 * emits these for `activePeriods[*].{start,end}`) so callers don't need a
 * separate string-branch wrapper.
 *
 * Negative inputs collapse to `NaN` so downstream validity gates
 * (`Number.isFinite(ts)` checks in api.js, `end < now` in alerts.js) reject
 * them uniformly. Previously a negative ts (clock skew, feed garbage) passed
 * straight through and the `recordFeedDrop('invalidTs')` counter under-reported
 * because `Number.isFinite(-1) === true`. Zero is preserved because it's a
 * valid Unix epoch and used as a sentinel in alerts.js for "no start time".
 *
 * @param {number|string} ts  Unix seconds, Unix ms, or ISO-8601 string
 * @returns {number}          Unix seconds, or NaN for unparseable / negative input
 */
// Suppress repeated warnings — Metro is the only producer, so if one timestamp
// is malformed many likely are. One warn is enough to alert a developer the
// next time they open the console; quiet thereafter.
let _normalizeTimestampWarned = false;

export function normalizeTimestamp(ts) {
    if (typeof ts === 'string') {
        const parsed = Math.floor(new Date(ts).getTime() / 1000);
        if (parsed >= 0) return parsed;
        // Surface unparseable strings to the dev console once per session so
        // feed-side timestamp regressions don't fail silently. Tests can reset
        // via _resetNormalizeTimestampWarning() below.
        if (!_normalizeTimestampWarned) {
            _normalizeTimestampWarned = true;
            console.warn('[utils] normalizeTimestamp: unparseable string value', ts);
        }
        return NaN;
    }
    if (typeof ts !== 'number' || ts < 0) return NaN;
    return ts > 1e10 ? Math.floor(ts / 1000) : ts;
}

/** Test hook to reset the once-per-session warn flag. */
export function _resetNormalizeTimestampWarning() {
    _normalizeTimestampWarned = false;
}

/**
 * Strip the optional dash-suffix from a GTFS-RT route id (e.g. "801-13095"
 * → "801"). Metro publishes one canonical route_id family per line plus
 * service-pattern variants; the suffix encodes the variant and is irrelevant
 * for our route-level logic. Always String-casts first so non-string input
 * doesn't throw on .split.
 * @param {*} raw
 * @returns {string}
 */
export function splitRouteId(raw) {
    return String(raw ?? '').split('-')[0];
}

/**
 * Planar approximation of distance in meters between two points.
 * @param {number} lat1 @param {number} lng1
 * @param {number} lat2 @param {number} lng2
 * @returns {number} Distance in meters
 */
export function planarMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
    const dLng = (lng2 - lng1) * M_PER_DEG_LNG_LA;
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * Spherical bearing from start to end in degrees [0, 360).
 * Returns `null` when the two points are coincident — `atan2(0,0)` would
 * otherwise quietly produce `0` (north), which propagates through callers
 * like `lngLatAtArc` and silently rotates DR markers to north when a
 * polyline contains adjacent duplicate vertices. Existing callers already
 * null-check the result (stations.resolveBoardingSlotFromPolyline,
 * markers _arcTick) so widening the contract is safe.
 * @param {number} startLng @param {number} startLat
 * @param {number} endLng   @param {number} endLat
 * @returns {number|null}
 */
export function computeBearing(startLng, startLat, endLng, endLat) {
    // Tight coincidence threshold — ~1 cm at LA latitude. This catches
    // exact-duplicate vertices and pure float noise without ever triggering
    // on legitimately close-but-distinct points.
    if (Math.abs(endLng - startLng) < 1e-9 && Math.abs(endLat - startLat) < 1e-9) {
        return null;
    }
    const y = Math.sin((endLng - startLng) * Math.PI / 180) * Math.cos(endLat * Math.PI / 180);
    const x = Math.cos(startLat * Math.PI / 180) * Math.sin(endLat * Math.PI / 180) -
              Math.sin(startLat * Math.PI / 180) * Math.cos(endLat * Math.PI / 180) * Math.cos((endLng - startLng) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Strip line-brand suffixes and optionally the trailing "Station" word.
 * @param {string} name Raw stop name from GTFS or GTFS-RT
 * @param {boolean} [stripStation=true] Remove " Station" suffix
 * @returns {string} Display-ready station name
 */
export function cleanStationName(name, stripStation = true) {
    let clean = String(name || '')
        .replace(/\s*-\s*(Metro\s+)?[A-Z][\w]*[\s-]Lines?.*$/i, '')
        .replace(/\s*-\s*(Metro\s+)?[A-Z](\s*[&,]\s*[A-Z])*\s+Lines?.*$/i, '')
        .replace(/\s+[A-Z]-Line\s+Station\s*$/i, '')
        .replace(/\s*\/\s*Ethel\s+Bradley\b.*/i, '')
        .replace(/\s*-\s*(Upper|Lower)\s+Level\b.*/i, '')
        .replace(/\bTransit\s+Center\b/i, 'TC')
        .trim();

    if (stripStation && !/^union station$/i.test(clean)) {
        const stripped = clean.replace(/\s*\bStation\b/i, '').trim();
        // Guard "Union Station" -> "Union" by ensuring result length
        if (stripped.length >= 5) clean = stripped;
    }
    return clean;
}

const RE_STOP_SUFFIX = /_[NSEW]$/i;
/** Strip directional suffix (_N, _S, _E, _W) from a stop ID. */
export const normalizeStopId = s => String(s).replace(RE_STOP_SUFFIX, '');

// GTFS-RT currentStatus can arrive as integer (1) or string ('STOPPED_AT').
/** @param {number|string} status GTFS-RT currentStatus value @returns {boolean} */
export const isStoppedAt  = status => status === 1 || status === 'STOPPED_AT';
/** @param {number|string} status GTFS-RT currentStatus value @returns {boolean} */
export const isArrivingAt = status => status === 0 || status === 'INCOMING_AT';

/**
 * Stopped-at predicate that honors the misfire override set by markers.js
 * `_applySnap` when the feed reports STOPPED_AT but the vehicle is clearly
 * moving. Use this instead of `isStoppedAt(marker.properties.currentStatus)`
 * anywhere predictions / station rendering needs the marker's *effective*
 * status, not the raw feed value.
 *
 * @param {Object} marker Vehicle marker with .properties.{currentStatus, _misfireOverride}
 * @returns {boolean}
 */
export const isEffectivelyStopped = marker =>
    isStoppedAt(marker?.properties?.currentStatus) && !marker?.properties?._misfireOverride;

// Registry for setVisibleInterval — all callers share one visibilitychange listener
// instead of each registering its own, preventing unbounded listener accumulation.
const _visRegistry = [];
let   _visListenerActive = false;

function _attachVisListener() {
    if (_visListenerActive) return;
    _visListenerActive = true;
    document.addEventListener('visibilitychange', () => {
        for (const e of _visRegistry) {
            if (document.hidden) {
                clearInterval(e.id);
                e.id = null;
            } else {
                // clearInterval(null) is a safe no-op — covers both the
                // hide→show transition (we just cleared the timer) and the
                // hidden-on-load transition (setVisibleInterval skipped the
                // initial setInterval, see comment there).
                clearInterval(e.id);
                e.fn();
                e.id = setInterval(e.fn, e.ms);
            }
        }
    });
}

let _visIntervalSeq = 0;

/**
 * Like setInterval but pauses while the tab is hidden and fires immediately on resume.
 * All callers share one visibilitychange listener to avoid unbounded listener accumulation.
 *
 * Optional `key` makes the registration idempotent — if a caller re-registers
 * under the same key (e.g. a module-init function called twice), the prior
 * interval is cancelled instead of stacking alongside the new one. New callers
 * that may run more than once should pass a stable string key.
 *
 * @param {Function} fn Callback to invoke on each tick
 * @param {number} ms   Interval in milliseconds
 * @param {string|null} [key] Optional dedup key; same key replaces prior registration
 * @returns {number} entryId — pass to clearVisibleInterval to cancel
 */
export function setVisibleInterval(fn, ms, key = null) {
    _attachVisListener();
    if (key) {
        const i = _visRegistry.findIndex(e => e.key === key);
        if (i >= 0) {
            clearInterval(_visRegistry[i].id);
            _visRegistry.splice(i, 1);
        }
    }
    const entryId = ++_visIntervalSeq;
    // Skip the initial setInterval when the document is already hidden — the
    // visibilitychange listener will start the timer when the tab gains focus.
    // Without this guard a setVisibleInterval registered while the page loaded
    // hidden (typical "open link in new tab" flow) ticks at full cadence until
    // the user focuses the tab, which defeats the whole point of the API.
    const id = document.hidden ? null : setInterval(fn, ms);
    _visRegistry.push({ fn, ms, id, key, entryId });
    return entryId;
}

/**
 * Cancel a registration created by setVisibleInterval. No-op for unknown ids.
 * @param {number} entryId Value returned by setVisibleInterval
 */
export function clearVisibleInterval(entryId) {
    const i = _visRegistry.findIndex(e => e.entryId === entryId);
    if (i < 0) return;
    clearInterval(_visRegistry[i].id);
    _visRegistry.splice(i, 1);
}

// Dev observability hook — lets the ?debug=1 long-session logger read the
// registry size without exporting the array itself.
if (typeof window !== 'undefined') {
    window.__visRegistrySize = () => _visRegistry.length;
}

/**
 * Exponential backoff delay with ±20% jitter for WebSocket reconnects.
 * @param {number} attempt Current reconnect attempt (reset to 0 after a successful connection)
 * @param {number} base    Base delay in ms
 * @param {number} max     Maximum delay cap in ms
 * @returns {number} Delay in milliseconds
 */
export function wsBackoffDelay(attempt, base, max) {
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(base * Math.pow(2, attempt), max) * jitter;
}

/**
 * Returns true for G Line (901) and J Line (910) bus rapid transit routes.
 * @param {string|number} routeCode
 * @returns {boolean}
 */
export function isBusRoute(routeCode) {
    // 950 is the J Line San Pedro extension variant. GTFS sometimes
    // distinguishes it from 910 (Harbor Gateway) — when present, it's a bus,
    // not rail. Without this case, dwell padding and snap distance fall
    // through to the rail defaults in predictions.js / markers.js.
    return routeCode === '901' || routeCode === '910' || routeCode === '950';
}

/**
 * Heavy-rail subway routes (B Line, D Line) — fully grade-separated, never
 * stop mid-segment. Light rail (A/C/E/K) has at-grade crossings and traffic
 * signals where speed=0 mid-segment is real, so it is intentionally excluded.
 * @param {string|number} routeCode
 * @returns {boolean}
 */
export function isHeavyRail(routeCode) {
    return routeCode === '802' || routeCode === '805';
}

/**
 * fetch() wrapper that aborts after `ms` milliseconds. Hardens static-data and
 * REST polling paths against hung servers (native fetch has no built-in timeout).
 * Rejects with an AbortError when the timer fires; otherwise behaves like fetch.
 * @param {string|URL|Request} input
 * @param {number} [ms=10000] Timeout in milliseconds
 * @param {RequestInit} [init] Optional fetch init (signal will be merged)
 * @returns {Promise<Response>}
 */
export function fetchWithTimeout(input, ms = 10000, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(input, { ...init, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

/**
 * Escape a value for safe insertion into HTML.
 * @param {*} str Value to escape (null/undefined returns '')
 * @returns {string}
 */
export function escHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
