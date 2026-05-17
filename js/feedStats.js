/**
 * feedStats.js
 * In-memory rolling counters for the vehicle-position pipeline. Used to detect
 * when feed cadence or accept-rate has degraded. Counters reset every interval;
 * one summary line is logged per feed each tick.
 *
 * Exports:
 *   recordReceived(url)         — every onmessage frame in api.js
 *   recordAccepted(url)         — frame that successfully updated a marker
 *   recordFeedDrop(url, reason) — drops in api.js processAndUpdate gates
 *   recordMarkerDrop(reason)    — drops in markers.js (staleAge / olderTs / spike)
 *   startFeedStatsReporter()    — register the 60s setVisibleInterval
 */

import { setVisibleInterval } from './utils.js';

const REPORT_INTERVAL_MS = 60_000;
const REPORT_INTERVAL_S  = REPORT_INTERVAL_MS / 1000;

const _feedStats   = new Map(); // url → counter object (see _emptyCounters)
const _markerStats = { staleAge: 0, olderTs: 0, spike: 0, coldStartSpike: 0 };
// Ghost arrivals: count of trip_updates entries (recently ingested) whose
// vehicleId has no matching live marker. A non-zero count is the smoking gun
// for the feed-divergence bug — the trip_updates feed knows about a vehicle
// the vehicle_positions feed has lost track of. Refreshed on every _report
// tick by _scanGhostArrivals(). If this trends > 0 between periodic-reconnect
// rotations, the Phase 2 divergence-triggered reconnect is needed.
let _ghostArrivals = 0;
let   _started     = false;

function _emptyCounters() {
    return {
        received: 0,
        accepted: 0,
        drops: { noPosition: 0, nonFinite: 0, noTripId: 0, invalidTs: 0 },
    };
}

function _stats(url) {
    let s = _feedStats.get(url);
    if (!s) { s = _emptyCounters(); _feedStats.set(url, s); }
    return s;
}

export function recordReceived(url)         { _stats(url).received++; }
export function recordAccepted(url)         { _stats(url).accepted++; }
export function recordFeedDrop(url, reason) {
    const s = _stats(url);
    if (Object.hasOwn(s.drops, reason)) s.drops[reason]++;
}
export function recordMarkerDrop(reason) {
    if (Object.hasOwn(_markerStats, reason)) _markerStats[reason]++;
}

// wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions → LACMTA_Rail
function _shortName(url) {
    const m = url.match(/\/ws\/([^/]+)/);
    return m ? m[1] : url;
}

/**
 * Count masterArrivalsData entries that reference a vehicleId not present in
 * window.vehicleMarkers. Skips entries with empty vehicleId (Metro frequently
 * omits vehicle.id — counting these would produce a constant baseline of
 * false positives) and entries whose ingest is older than 60s (no recent
 * activity, so absence of a marker is expected).
 *
 * Falls back to tripId membership before counting a ghost — if a marker
 * exists under the same trip_id but a different vehicle_id (e.g. Metro
 * re-assigned the vehicle), we shouldn't flag it as a ghost.
 *
 * Exposed for tests.
 * @param {number} [nowSec=now] override clock for deterministic tests
 * @returns {number} ghost-arrival count
 */
export function scanGhostArrivals(nowSec = Math.floor(Date.now() / 1000)) {
    if (!window.masterArrivalsData || !window.vehicleMarkers) return 0;
    const markerVids = new Set();
    const markerTids = new Set();
    for (const m of Object.values(window.vehicleMarkers)) {
        const p = m?.properties ?? {};
        if (p.vehicle_id) markerVids.add(String(p.vehicle_id));
        if (p.trip_id)    markerTids.add(String(p.trip_id));
    }
    let count = 0;
    for (const arrivals of window.masterArrivalsData.values()) {
        for (const a of arrivals) {
            if (!a.vehicleId) continue;                                          // Metro often omits vehicle.id
            if (!a.lastIngestUnix || nowSec - a.lastIngestUnix > 60) continue;   // ingest too old to expect a marker
            if (markerVids.has(String(a.vehicleId))) continue;
            if (a.tripId && markerTids.has(String(a.tripId))) continue;
            count++;
        }
    }
    return count;
}

function _report() {
    _ghostArrivals = scanGhostArrivals();
    for (const [url, s] of _feedStats) {
        if (s.received === 0 && s.accepted === 0) continue; // skip silent intervals
        const cadence = (s.received / REPORT_INTERVAL_S).toFixed(1);
        const d = s.drops;
        console.info(
            `[feed-stats] ${_shortName(url)}: rcv=${s.received} acc=${s.accepted} ` +
            `drop(noPos=${d.noPosition} nonFin=${d.nonFinite} noTrip=${d.noTripId} invTs=${d.invalidTs}) ` +
            `cadence=${cadence}/s`
        );
        _feedStats.set(url, _emptyCounters());
    }
    const m = _markerStats;
    if (m.staleAge || m.olderTs || m.spike || m.coldStartSpike) {
        console.info(`[feed-stats] markers: drop(staleAge=${m.staleAge} olderTs=${m.olderTs} spike=${m.spike} coldStartSpike=${m.coldStartSpike})`);
        m.staleAge = 0; m.olderTs = 0; m.spike = 0; m.coldStartSpike = 0;
    }
    if (_ghostArrivals > 0) {
        console.warn(`[feed-stats] ghost arrivals: ${_ghostArrivals} (trip_updates entries with no matching marker)`);
    }
}

/**
 * Start the 60-second log reporter. Idempotent. Pauses on hidden tab via
 * setVisibleInterval, so counters only report while the tab is visible.
 */
export function startFeedStatsReporter() {
    if (_started) return;
    _started = true;
    setVisibleInterval(_report, REPORT_INTERVAL_MS, 'feedStats:report');
    _maybeStartDebugCounter();
}

/**
 * Long-session debug counter. Gated by ?debug=1 URL param so it's off in
 * production. Logs marker/arrivals/intervals sizes once per minute so a
 * multi-hour session can be verified — none of these should trend upward.
 */
function _maybeStartDebugCounter() {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('debug') !== '1') return;
    setVisibleInterval(() => {
        const markerCount = Object.keys(window.vehicleMarkers ?? {}).length;
        const arrivalsCount = [...(window.masterArrivalsData?.values() ?? [])]
            .reduce((s, list) => s + list.length, 0);
        const stops = window.masterArrivalsData?.size ?? 0;
        const intervals = window.__visRegistrySize?.() ?? 'n/a';
        console.log(`[debug] markers=${markerCount} arrivals=${arrivalsCount} ` +
                    `stops=${stops} intervals=${intervals}`);
    }, 60_000, 'debug:counts');
}
