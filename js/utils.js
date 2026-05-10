/**
 * utils.js
 * Shared math and string utilities for the Metro Live Map.
 */

// Calibrated for LA basin (33.5°–34.4°N); ~0.1% error elsewhere in Metro's service area.
/** Mean meters per degree of latitude (constant worldwide). */
export const M_PER_DEG_LAT    = 110540;
/** Mean meters per degree of longitude at LA's latitude (~34°N). */
export const M_PER_DEG_LNG_LA = 92630;


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
 * @param {number} startLng @param {number} startLat
 * @param {number} endLng   @param {number} endLat
 * @returns {number}
 */
export function computeBearing(startLng, startLat, endLng, endLat) {
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

// Registry for setVisibleInterval — all callers share one visibilitychange listener
// instead of each registering its own, preventing unbounded listener accumulation.
const _visRegistry = [];
let   _visListenerActive = false;

function _attachVisListener() {
    if (_visListenerActive) return;
    _visListenerActive = true;
    document.addEventListener('visibilitychange', () => {
        for (const e of _visRegistry) {
            if (document.hidden) { clearInterval(e.id); e.id = null; }
            else {
                // Clear before re-setting: if the page loaded while the tab was
                // already hidden, setVisibleInterval already started an interval
                // (e.id is non-null). Without clearing it first, two intervals
                // would run concurrently after the tab comes into focus.
                clearInterval(e.id);
                e.fn();
                e.id = setInterval(e.fn, e.ms);
            }
        }
    });
}

/**
 * Like setInterval but pauses while the tab is hidden and fires immediately on resume.
 * All callers share one visibilitychange listener to avoid unbounded listener accumulation.
 * Runs for the lifetime of the page; there is no cancellation mechanism.
 * @param {Function} fn Callback to invoke on each tick
 * @param {number} ms   Interval in milliseconds
 */
export function setVisibleInterval(fn, ms) {
    _attachVisListener();
    const entry = { fn, ms, id: setInterval(fn, ms) };
    _visRegistry.push(entry);
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
    return routeCode === '901' || routeCode === '910';
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
