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
// Per-marker drop / freeze counters. Two conceptual groups:
//   ingest drops — frame rejected at WS arrival (staleAge / olderTs / spike / coldStartSpike).
//                  Recorded once per rejected frame.
//   freeze episodes — marker spent time visibly stuck on screen. Episode-gated:
//                  one record per pause-session, NOT per frame. A 30 s intersection
//                  pause increments intersectionPause by 1, not by 1800.
const _markerStats = {
    // ingest drops (existing)
    staleAge: 0, olderTs: 0, spike: 0, coldStartSpike: 0,
    // pre-bootstrap drop: WS frame arrived before masterStopsData finished
    // loading. Should only fire briefly during cold start; persistent
    // non-zero counts indicate a regression in main.js's dataPromise.then
    // sequencing.
    preBootstrap: 0,
    // freeze episodes (added for the freeze audit — see plan)
    watchdogRail: 0, watchdogBus: 0,
    offRoute: 0,
    noSnap: 0,
    intersectionPause: 0,
    bearingBudgetExhausted: 0,
    stoppedAtMisfire: 0,
    animateMarkerRace: 0,
    // Declared-stop clamp: the snap arc landed past the feed's declared next
    // stop and was pulled back to the stop's arc. Per-frame counter (not
    // episode-gated). Post-PR-narrowing (2026-05-21) the clamp only fires for
    // STOPPED_AT vehicles that aren't in a misfire, so the baseline is near
    // zero everywhere — brief spikes are normal when a STOPPED_AT vehicle's
    // GPS jitters past the platform arc. Sustained non-zero between stations
    // means a STOPPED_AT misfire pattern slipped past the gate; investigate.
    declaredStopClamp: 0,
};
// Ghost arrivals: count of trip_updates entries (recently ingested) whose
// vehicleId has no matching live marker. A non-zero count is the smoking gun
// for the feed-divergence bug — the trip_updates feed knows about a vehicle
// the vehicle_positions feed has lost track of. Refreshed on every _report
// tick by _scanGhostArrivals(). Today's mitigation is the periodic-reconnect
// (every ~5 min) which kicks both sockets — a sustained non-zero ghost count
// between reconnects is the signal to investigate.
let _ghostArrivals = 0;
let   _started     = false;

function _emptyCounters() {
    return {
        received: 0,
        accepted: 0,
        drops: { noPosition: 0, nonFinite: 0, noTripId: 0, invalidTs: 0, jsonParse: 0 },
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

// Exported for tests — the 60s interval invokes it in production via
// startFeedStatsReporter. Calling it directly lets tests verify counter
// initialization, log-line shape, and reset behaviour without juggling timers.
export function _report() {
    _ghostArrivals = scanGhostArrivals();
    for (const [url, s] of _feedStats) {
        if (s.received === 0 && s.accepted === 0) continue; // skip silent intervals
        const cadence = (s.received / REPORT_INTERVAL_S).toFixed(1);
        const d = s.drops;
        console.info(
            `[feed-stats] ${_shortName(url)}: rcv=${s.received} acc=${s.accepted} ` +
            `drop(noPos=${d.noPosition} nonFin=${d.nonFinite} noTrip=${d.noTripId} invTs=${d.invalidTs} jsonParse=${d.jsonParse}) ` +
            `cadence=${cadence}/s`
        );
        _feedStats.set(url, _emptyCounters());
    }
    const m = _markerStats;
    if (Object.values(m).some(v => v > 0)) {
        const ingest = `staleAge=${m.staleAge} olderTs=${m.olderTs} spike=${m.spike} coldStartSpike=${m.coldStartSpike} preBootstrap=${m.preBootstrap}`;
        const freeze = `watchdogRail=${m.watchdogRail} watchdogBus=${m.watchdogBus} ` +
                       `offRoute=${m.offRoute} noSnap=${m.noSnap} ` +
                       `intersectionPause=${m.intersectionPause} ` +
                       `bearingBudgetExhausted=${m.bearingBudgetExhausted} ` +
                       `stoppedAtMisfire=${m.stoppedAtMisfire} animateMarkerRace=${m.animateMarkerRace} ` +
                       `declaredStopClamp=${m.declaredStopClamp}`;
        console.info(`[feed-stats] markers: ingest(${ingest}) freeze(${freeze})`);
        for (const k of Object.keys(m)) m[k] = 0;
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
