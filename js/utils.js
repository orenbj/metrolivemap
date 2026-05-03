/**
 * utils.js
 * Shared math and string utilities for the Metro Live Map.
 */

// Mean meters per degree at LA latitude (~34.05°N).
export const M_PER_DEG_LAT    = 110540;
export const M_PER_DEG_LNG_LA = 92630;


/**
 * Planar approximation of distance in meters between two points.
 */
export function planarMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
    const dLng = (lng2 - lng1) * M_PER_DEG_LNG_LA;
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * Spherical bearing between two points in degrees (0-360).
 */
export function computeBearing(startLng, startLat, endLng, endLat) {
    const y = Math.sin((endLng - startLng) * Math.PI / 180) * Math.cos(endLat * Math.PI / 180);
    const x = Math.cos(startLat * Math.PI / 180) * Math.sin(endLat * Math.PI / 180) -
              Math.sin(startLat * Math.PI / 180) * Math.cos(endLat * Math.PI / 180) * Math.cos((endLng - startLng) * Math.PI / 180);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/**
 * Unified station name cleaning logic.
 * Strips line-brand suffixes and optionally trailing "Station".
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
export const normalizeStopId = s => String(s).replace(RE_STOP_SUFFIX, '');

// GTFS-RT currentStatus can arrive as integer (1) or string ('STOPPED_AT').
export const isStoppedAt  = status => status === 1 || status === 'STOPPED_AT';
export const isArrivingAt = status => status === 0 || status === 'INCOMING_AT';

// Like setInterval but pauses while the tab is hidden and fires immediately on resume.
export function setVisibleInterval(fn, ms) {
    let id = setInterval(fn, ms);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { clearInterval(id); id = null; }
        else { fn(); id = setInterval(fn, ms); }
    });
}

// Exponential backoff with ±20% jitter for WebSocket reconnects.
// Pass attempt=0 after a successful connection so the next reconnect starts at base delay.
export function wsBackoffDelay(attempt, base, max) {
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.min(base * Math.pow(2, attempt), max) * jitter;
}

export function escHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
