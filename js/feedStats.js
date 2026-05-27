/**
 * feedStats.js
 * In-memory rolling counters for the vehicle-position pipeline. Used to detect
 * when feed cadence or accept-rate has degraded. Counters reset every interval;
 * one summary line is logged per feed each tick.
 *
 * Each report tick also appends a structured snapshot to a localStorage ring
 * buffer (key FEED_STATS_RING_KEY, max FEED_STATS_RING_MAX entries = 24 h).
 * Open the console and run JSON.parse(localStorage.feedStatsRing) to see
 * actual rates across the session — counters used to evaporate after each
 * console.info line.
 *
 * Exports:
 *   recordReceived(url)         — every onmessage frame in api.js
 *   recordAccepted(url)         — frame that successfully updated a marker
 *   recordFeedDrop(url, reason) — drops in api.js processAndUpdate gates
 *   recordMarkerDrop(reason)    — drops in markers.js (staleAge / olderTs / spike)
 *   startFeedStatsReporter()    — register the 60s setVisibleInterval
 *   readFeedStatsRing()         — parse the localStorage ring (returns [])
 *   clearFeedStatsRing()        — wipe the ring (debugging / test setup)
 *   FEED_STATS_RING_KEY         — the localStorage key (for the headless harness)
 */

import { setVisibleInterval } from './utils.js';

const REPORT_INTERVAL_MS = 60_000;
const REPORT_INTERVAL_S  = REPORT_INTERVAL_MS / 1000;

// ── Persistent ring buffer ──────────────────────────────────────────────────
// One entry per _report() tick with activity. 1440 entries × ~300 B ≈ 430 KB,
// well within the 5–10 MB localStorage quota every modern browser provides.
// Silent intervals are skipped so the ring isn't padded with zero rows.
export const FEED_STATS_RING_KEY = 'feedStatsRing';
export const FEED_STATS_RING_MAX = 1440; // 24 h × 60 min

function _appendRing(entry) {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(FEED_STATS_RING_KEY);
        const ring = raw ? JSON.parse(raw) : [];
        ring.push(entry);
        // Drop oldest entries when over capacity. splice keeps the underlying
        // array reference so any in-page debugger references stay live.
        if (ring.length > FEED_STATS_RING_MAX) ring.splice(0, ring.length - FEED_STATS_RING_MAX);
        localStorage.setItem(FEED_STATS_RING_KEY, JSON.stringify(ring));
    } catch {
        // Quota errors, JSON parse errors, storage-disabled contexts — the
        // ring is best-effort observability and must never crash the report
        // tick that produces the regular console line.
    }
}

export function readFeedStatsRing() {
    if (typeof localStorage === 'undefined') return [];
    try {
        const raw = localStorage.getItem(FEED_STATS_RING_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

export function clearFeedStatsRing() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(FEED_STATS_RING_KEY); } catch { /* noop */ }
}

const _feedStats   = new Map(); // url → counter object (see _emptyCounters)
// Per-marker drop / freeze counters. Two conceptual groups:
//   ingest drops — frame rejected at WS arrival (staleAge / olderTs / spike / coldStartSpike).
//                  Recorded once per rejected frame.
//   freeze episodes — marker spent time visibly stuck on screen. Episode-gated:
//                  one record per pause-session, NOT per frame. A 30 s intersection
//                  pause increments intersectionPause by 1, not by 1800.
// NOTE: when adding a counter here, also append it to scripts/analyze-ring.js
// MARKER_KEYS — the offline analyzer silently omits unknown ring fields.
const _markerStats = {
    // ingest drops (existing)
    staleAge: 0, olderTs: 0, spike: 0, coldStartSpike: 0,
    // pre-bootstrap drop: WS frame arrived before masterStopsData finished
    // loading. Should only fire briefly during cold start; persistent
    // non-zero counts indicate a regression in main.js's dataPromise.then
    // sequencing.
    preBootstrap: 0,
    // freeze episodes (added for the freeze audit — see plan).
    // watchdogBus / bearingBudgetExhausted were retired with the bearing-DR
    // removal — buses without shape data no longer run a continuous
    // integrator, so neither failure mode exists.
    watchdogRail: 0,
    offRoute: 0,
    noSnap: 0,
    intersectionPause: 0,
    stoppedAtMisfire: 0,
    animateMarkerRace: 0,
    // stopIdLag: feed reports IN_TRANSIT_TO but the snap arc has already
    // moved past the declared next stop's arc by ≥ STOP_ID_LAG_MARGIN_M.
    // Episode-gated (one record per lagging-stopId window); the per-marker
    // flag is cleared in updateMarkerTimestamp when the feed's stopId
    // actually changes. Pure observability — answers "how often is Metro's
    // stopId lagging the train's real position?", which informs whether to
    // ever override the popup label or ETA lookups with a GPS-inferred next
    // stop. STOPPED_AT cases are deliberately excluded (that's stoppedAtMisfire's
    // domain). Cited counts feed the localStorage rollup ring for offline review.
    stopIdLag: 0,
    // Declared-stop clamp: the snap arc landed past the feed's declared next
    // stop and was pulled back to the stop's arc. Per-frame counter (not
    // episode-gated). Post-PR-narrowing (2026-05-21) the clamp only fires for
    // STOPPED_AT vehicles that aren't in a misfire, so the baseline is near
    // zero everywhere — brief spikes are normal when a STOPPED_AT vehicle's
    // GPS jitters past the platform arc. Sustained non-zero between stations
    // means a STOPPED_AT misfire pattern slipped past the gate; investigate.
    declaredStopClamp: 0,
    // vehicleNoArrivalMatch: a live vehicle marker is IN_TRANSIT_TO with a
    // finite stopId, the trip_updates feed has predictions for OTHER vehicles
    // at that stop, but none matches THIS vehicle's vehicle_id or trip_id.
    // Sustained non-zero is the smoking gun for the reverse of ghostArrivals
    // (vehicle_positions knows about a vehicle that trip_updates has lost the
    // prediction for). Episode-gated via marker._noArrivalMatchRecorded;
    // cleared in updateExistingMarker when the feed's stopId actually advances.
    // STOPPED_AT cases are deliberately excluded (boarding/dwell windows have
    // their own gating elsewhere).
    vehicleNoArrivalMatch: 0,
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
        drops: { noPosition: 0, nonFinite: 0, noTripId: 0, invalidTs: 0, futureTs: 0, jsonParse: 0 },
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
            // Metro's trip_updates feed publishes schedule-derived entries for
            // trips that haven't been assigned to a live vehicle yet, using
            // synthetic vehicle IDs of the form "block_<N>_schedBasedVehicle".
            // These are NOT divergence — by design they have no live marker.
            // The 2026-05-26 feed-reliability audit flagged ~1,484 such
            // entries in a 20-minute capture, swamping the genuine-divergence
            // signal this counter is meant to surface.
            if (String(a.vehicleId).endsWith('_schedBasedVehicle')) continue;
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
    // Per-feed snapshot — built INSIDE the loop so the reset can fire
    // immediately after each feed is summarized (matches the original control
    // flow). Only feeds with traffic in the elapsed minute land in the ring.
    const _feedSnapshot = {};
    for (const [url, s] of _feedStats) {
        if (s.received === 0 && s.accepted === 0) continue; // skip silent intervals
        const cadence = (s.received / REPORT_INTERVAL_S).toFixed(1);
        const d = s.drops;
        console.info(
            `[feed-stats] ${_shortName(url)}: rcv=${s.received} acc=${s.accepted} ` +
            `drop(noPos=${d.noPosition} nonFin=${d.nonFinite} noTrip=${d.noTripId} invTs=${d.invalidTs} futTs=${d.futureTs} jsonParse=${d.jsonParse}) ` +
            `cadence=${cadence}/s`
        );
        _feedSnapshot[_shortName(url)] = {
            rcv: s.received,
            acc: s.accepted,
            drops: { ...d },
            cadence: Number(cadence),
        };
        _feedStats.set(url, _emptyCounters());
    }
    const m = _markerStats;
    // Snapshot ALL marker counters (including zeros) before the reset so the
    // ring is unambiguous about absent-vs-zero in post-hoc analysis.
    const _markerSnapshot = { ...m };
    if (Object.values(m).some(v => v > 0)) {
        const ingest = `staleAge=${m.staleAge} olderTs=${m.olderTs} spike=${m.spike} coldStartSpike=${m.coldStartSpike} preBootstrap=${m.preBootstrap}`;
        const freeze = `watchdogRail=${m.watchdogRail} ` +
                       `offRoute=${m.offRoute} noSnap=${m.noSnap} ` +
                       `intersectionPause=${m.intersectionPause} ` +
                       `stoppedAtMisfire=${m.stoppedAtMisfire} animateMarkerRace=${m.animateMarkerRace} ` +
                       `stopIdLag=${m.stopIdLag} declaredStopClamp=${m.declaredStopClamp} ` +
                       `vehicleNoArrivalMatch=${m.vehicleNoArrivalMatch}`;
        console.info(`[feed-stats] markers: ingest(${ingest}) freeze(${freeze})`);
        for (const k of Object.keys(m)) m[k] = 0;
    }
    if (_ghostArrivals > 0) {
        console.warn(`[feed-stats] ghost arrivals: ${_ghostArrivals} (trip_updates entries with no matching marker)`);
    }

    // Persist one ring entry per non-silent tick. The activity gate matches
    // the console-line gates above (any feed produced output OR any marker
    // counter was non-zero OR there were ghosts) so the on-disk ring tracks
    // the same set of intervals an operator would see in the log.
    const _hasActivity = Object.keys(_feedSnapshot).length > 0
        || Object.values(_markerSnapshot).some(v => v > 0)
        || _ghostArrivals > 0;
    if (_hasActivity) {
        _appendRing({
            t: Math.floor(Date.now() / 1000),
            feeds: _feedSnapshot,
            markers: _markerSnapshot,
            ghosts: _ghostArrivals,
        });
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
