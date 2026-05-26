import { cleanStationName, isStoppedAt, isEffectivelyStopped, normalizeStopId, isBusRoute, isHeavyRail } from './utils.js';
import { snapToRoute, hasShapeData } from './snap.js';
import {
    ETA_MAX_SPEED_MPS, ETA_PLAUSIBILITY_GRACE_S,
    ETA_PROXIMITY_OVERRIDE_M, ETA_MIN_APPROACH_SPEED_MPS,
    ETA_DEPARTURE_LAG_S,
    GTFS_ENTRY_STALENESS_S, VEHICLE_MARKER_TTL_S, PAST_ARRIVAL_GRACE_S,
    ETA_INTERMEDIATE_DWELL_S, ETA_INTERMEDIATE_DWELL_BUS_S,
    ADHERENCE_TAPER_K, TERMINUS_DISPLAY_OVERRIDES,
    RAIL_SNAP_MAX_M, HEAVY_RAIL_SNAP_MAX_M, BUS_SNAP_MAX_DEVIATION_M,
    FRESH_LIVE_S,
} from './config.js';
import { getSpeedMultiplier } from './scheduleCalibration.js';
import { tripTerminusByTripId } from './tripUpdates.js';

const RE_TRAIL_NONDIG = /\D+$/;
const RE_HAS_DIGIT    = /\d/;

// Hard cap on the raw adherence offset (seconds either side of schedule).
// 600 = 10 minutes, the practical envelope for routine GPS pathology and
// dispatcher-driven holds. Beyond this we treat the discrepancy as a
// schedule-deviation (likely a trip pattern change or feed corruption)
// rather than a vehicle running late, and let GTFS-RT carry the ETA alone.
// Tighter caps over-pulled normal late-running into an early ETA; looser
// caps let GPS spikes briefly inject minutes of artificial lateness.
const MAX_ADHERENCE_OFFSET_S = 600;

const routeStops = {};

/**
 * Return the per-(route, direction) stop/time cache built by initPredictions.
 * Used by markers.js as a fallback when a marker's trip_id is not present in
 * masterTripsData (e.g. B Line owl-service trips whose IDs are out of sync
 * with the static GTFS schedule). Returns undefined if no cache exists.
 *
 * @param {string} rc Route code, e.g. '802'
 * @param {number} dir Direction id, 0 or 1
 * @returns {{stops: string[], times: number[], arcMeters?: (number|null)[]}|undefined}
 */
export function getRouteCache(rc, dir) {
    if (!rc || dir == null) return undefined;
    return routeStops[`${rc}|${dir}`];
}

/**
 * Return the trip's stop sequence + scheduled times, falling back to the
 * per-(route, direction) cache when the static trip data isn't available.
 * Used by markers.js for any operation that needs an ordered stop list
 * (segment timing, kinematic speed estimate) — keeps the fallback policy
 * defined in one place. Returned values may still be empty or mismatched;
 * callers should validate `stops?.length === scheduledTimes?.length` before use.
 *
 * @param {string} tripId  Vehicle's reported trip_id
 * @param {string} rc      Route code, e.g. '802'
 * @param {number} dir     Direction id, 0 or 1
 * @returns {{stops: string[]|undefined, scheduledTimes: number[]|undefined}}
 */
export function getTripStops(tripId, rc, dir) {
    const trip            = window.masterTripsData?.[tripId];
    let   stops           = trip?.stops;
    let   scheduledTimes  = trip?.scheduledTimes;
    if (!stops?.length || scheduledTimes?.length !== stops.length) {
        const cache = getRouteCache(rc, dir);
        if (cache?.stops?.length && cache.times?.length === cache.stops.length) {
            stops          = cache.stops;
            scheduledTimes = cache.times;
        }
    }
    return { stops, scheduledTimes };
}

/**
 * Pre-process window.masterTripsData into per-(route, direction) stop/time lookup
 * tables and compute arc-meter positions for each stop (used in kinematic ETA).
 * Must be called after stops.json and trips.json are loaded.
 */
/**
 * Clear the route-stops cache (per-`${rc}|${dir}` map populated by
 * initPredictions). Called when GTFS data reloads at midnight so the
 * next initPredictions() call rebuilds from the new masterTripsData
 * instead of returning yesterday's cached stop sequences.
 */
export function _clearRouteStopsCache() {
    for (const k in routeStops) delete routeStops[k];
}

export function initPredictions() {
    const trips = window.masterTripsData;
    if (!trips) return;

    // Idempotence guard: clear the cache before rebuilding. If initPredictions
    // is called twice in quick succession with masterTripsData partially
    // refreshed (e.g. two service-date rollovers detected within 60 s, or a
    // dev-time re-import), the rebuild would otherwise interleave old and new
    // sequences silently. Unconditional clear costs O(routes×directions),
    // ~16 entries — negligible.
    _clearRouteStopsCache();

    const best = {};
    for (const [tripId, trip] of Object.entries(trips)) {
        const { rc, dir, stops, scheduledTimes } = trip;
        if (rc == null || dir == null || !stops?.length || !scheduledTimes?.length) continue;
        const key = `${rc}|${dir}`;
        if (!best[key] || stops.length > best[key].stops.length) best[key] = { ...trip, tripId };
    }

    for (const [key, trip] of Object.entries(best)) {
        if (trip.stops.length !== trip.scheduledTimes.length) continue;
        routeStops[key] = {
            stops: trip.stops.map(String),
            times: trip.scheduledTimes,
        };
    }

    // Precompute stop arc-meters for kinematic ETA (best-effort; null if shapes not yet loaded)
    let arcRouteDirs = 0, arcStops = 0, arcMissed = 0;
    for (const [key, cache] of Object.entries(routeStops)) {
        const [rc] = key.split('|');
        if (!hasShapeData(rc)) continue;
        cache.arcMeters = cache.stops.map(stopId => {
            const stop = window.masterStopsData?.[stopId];
            if (!stop) { arcMissed++; return null; }
            // Treat missing/non-finite coords as a cache miss too. snapToRoute
            // would otherwise be called with undefined and silently return the
            // route origin (arcMeters=0), corrupting every adherence and ETA
            // calculation for segments touching this stop.
            if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
                arcMissed++;
                return null;
            }
            return snapToRoute(rc, stop.lon, stop.lat)?.arcMeters ?? null;
        });
        arcRouteDirs++;
        arcStops += cache.arcMeters.filter(v => v !== null).length;
    }
    // D-1: warn if a significant fraction of stops are absent from stops.json.
    const arcTotal = arcStops + arcMissed;
    if (arcTotal > 0 && arcMissed / arcTotal > 0.2) {
        console.warn(`[Metro Live Map] ${arcMissed}/${arcTotal} stop IDs missing from stops.json — static data may be stale.`);
    }
}

/**
 * Tiered ETA selector. Returns the GTFS-RT-derived ETA when one is present
 * (the caller has already filtered out stale/implausible entries upstream)
 * and falls back to the calc-derived ETA otherwise.
 *
 * Why this is a function and not just `gtfsEtaS ?? calcEtaS`:
 *   - Keeps a single named seam where every (calc, gtfs) pair gets resolved,
 *     so future audits / instrumentation only need to wrap one call site.
 *   - Documents the policy explicitly. The old name "_blendArrivals" is kept
 *     so the import surface and test sites don't churn — but the math is no
 *     longer a blend.
 *
 * Why we don't blend at all:
 *   The 2026-05 offline sweep (docs/blend-tuning-2026-05.md, 57,954 paired
 *   snapshots) showed calc adds essentially no signal once GTFS-RT is
 *   present — 0% weight beyond 5 min, 10% near, marginal MAE improvement
 *   at the cost of within60s% degradation. Calc's real value is the
 *   fallback case, which is what this function now expresses.
 *
 *   The plausibility / staleness / origin-stop guards that used to choose
 *   between calc and GTFS-RT still live in getScheduledArrivals /
 *   getArrivalBreakdown — they hand this function either the trusted GTFS
 *   value or null. So `gtfsEtaS != null` means "the caller has already
 *   decided GTFS-RT is the right answer here."
 *
 * @param {number|null} calcEtaS   Calc-derived ETA (unix seconds), or null
 * @param {number|null} gtfsEtaS   GTFS-RT arrival unix seconds, or null
 *                                 (caller already filtered stale/implausible)
 * @param {number}      _horizonSec  Reserved for future use (kept for caller
 *                                   compatibility; ignored under the tier policy)
 * @param {number}      _nowS        Reserved for future use (same reason)
 * @returns {number|null}          GTFS-RT ETA if available, else calc, else null
 */
// eslint-disable-next-line no-unused-vars
export function _blendArrivals(calcEtaS, gtfsEtaS, _horizonSec, _nowS) {
    if (gtfsEtaS != null) return gtfsEtaS;
    return calcEtaS;
}

/**
 * Apply the adherence-taper cap to a calc ETA. The taper limits how much of
 * the raw adherence offset (which can be ±600 s) flows into the displayed
 * ETA, scaling the cap proportionally to remaining travel time.
 *
 * Why: a vehicle 5 min late with 30 s remaining to its next stop should NOT
 * show ETA = now + 30 s + 300 s = 5.5 min — it physically arrives in ~30 s.
 * Capping at K × remainingTime keeps near-stop ETAs realistic while letting
 * downstream stops (with larger remainingTime) express most of the cascade.
 *
 * Used in production by getScheduledArrivals and (mirrored) by
 * getArrivalBreakdown's _offsetCapped diagnostic.
 *
 * @param {number} schedEta         Schedule-derived ETA (unix seconds)
 * @param {number} adherenceOffset  Raw signed offset from computeTripAdherenceOffset
 * @param {number} now              Current unix seconds
 * @returns {number} Tapered, now-clamped calc ETA
 */
function _applyTaperedOffset(schedEta, adherenceOffset, now) {
    const remainingTime = Math.max(0, schedEta - now);
    const maxOffset     = ADHERENCE_TAPER_K * remainingTime;
    const cappedOffset  = Math.sign(adherenceOffset) * Math.min(Math.abs(adherenceOffset), maxOffset);
    return Math.max(now, schedEta + cappedOffset);
}

const dirsToTry = d => d != null ? [d] : [0, 1];

/**
 * Find the index of targetId in the stops array with fuzzy matching.
 * Tries: exact match → directional suffix strip → digit prefix match.
 * @param {string[]} stops    Ordered stop ID array for a route direction
 * @param {string|number} targetId Stop ID to locate
 * @returns {number} Index into stops, or -1 if not found
 */
export function findIdx(stops, targetId) {
    const t = String(targetId);
    let idx = stops.indexOf(t);
    if (idx !== -1) return idx;

    const stripped = normalizeStopId(t);
    if (stripped !== t) {
        idx = stops.indexOf(stripped);
        if (idx !== -1) return idx;
        idx = stops.findIndex(s => normalizeStopId(s) === stripped);
        if (idx !== -1) return idx;
    }

    const noTrail = t.replace(RE_TRAIL_NONDIG, '');
    if (noTrail && noTrail !== t && noTrail !== stripped) {
        idx = stops.indexOf(noTrail);
        if (idx !== -1) return idx;
    }

    if (t.length >= 5) {
        // Only match if the longer ID is the shorter one plus a non-numeric suffix (e.g. "80204N")
        idx = stops.findIndex(s => {
            const [longer, shorter] = s.length >= t.length ? [s, t] : [t, s];
            return longer.startsWith(shorter) && !RE_HAS_DIGIT.test(longer.slice(shorter.length));
        });
        if (idx !== -1) return idx;
    }
    return -1;
}

/**
 * Seconds since `statusChangedAt`, plus a constant departure-lag offset that
 * models door-closing / passenger-settling time at stops. Single source of
 * truth for the lag arithmetic — used by both `interStopRemainingSeconds` and
 * `computeTripAdherenceOffset`. If they ever drift apart, blended ETAs shift
 * silently because both paths feed the same downstream blend.
 * @param {number} statusChangedAt Unix seconds the marker last changed currentStatus.
 * @param {number} now             Unix seconds (caller-controlled for testability).
 * @returns {number} Elapsed seconds + ETA_DEPARTURE_LAG_S.
 */
export function _elapsedWithLag(statusChangedAt, now) {
    return (now - statusChangedAt) + ETA_DEPARTURE_LAG_S;
}

/**
 * Compute seconds remaining to travel from current arc position to the next stop.
 * @param {number} arcM  Current arc position along the shape (metres from start).
 * @param {number} stopArcM  Arc position of the target stop (metres).
 * @param {number} speedMs  Current speed estimate (m/s).
 * @returns {number} Seconds remaining; 0 if already past the stop.
 */
export function interStopRemainingSeconds(statusChangedAt, now, times, idx, routeCode, directionId) {
    if (statusChangedAt == null || idx <= 0) return null;
    const rawGap = times[idx] - times[idx - 1];
    if (rawGap <= 0) return null;
    // Apply per-(route, direction) schedule speed multiplier learned from observed
    // inter-stop segment times (TheTransitClock-style EWMA). Corrects systematic
    // GTFS schedule optimism; falls back to 1.0 until MIN_OBS_FOR_USE observations warm the model.
    const multiplier    = getSpeedMultiplier(routeCode, directionId);
    const interStopGap  = rawGap * multiplier;
    const timeInTransit = Math.min(_elapsedWithLag(statusChangedAt, now), interStopGap);
    return Math.max(0, interStopGap - timeInTransit);
}

/**
 * Measure how many seconds this vehicle is running ahead (negative) or behind
 * (positive) its timetable based on GPS arc position vs. the scheduled position
 * in the current inter-stop segment.
 *
 * Sign convention: **positive = late, negative = early.** Downstream callers
 * (`_applyTaperedOffset`, `getSecondsToNextStop`) add the offset to `schedEta`,
 * so a positive offset pushes the ETA into the future (vehicle is behind).
 *
 * Two branches:
 *   - In-segment (elapsed ≤ scheduled gap): arc-position offset converted to time.
 *     A vehicle behind where it should be at this point in the segment shows positive.
 *   - Overrun (elapsed > scheduled gap): vehicle should already have arrived.
 *     Express full lateness as (elapsed − gap) + (remainingArc / schedSpeed),
 *     so multi-segment delays flow through to all downstream ETAs instead of
 *     being silently clamped at one segment's worth of lateness.
 *
 * Clamped to ±600s to bound GPS pathology, but otherwise lateness flows freely.
 * Returns 0 when required data is absent or snap quality is poor.
 */
export function computeTripAdherenceOffset(marker, cache, nextIdx, now) {
    if (!cache.arcMeters || !marker.lastSnap || nextIdx <= 0) return 0;

    const nextArc = cache.arcMeters[nextIdx];
    const prevArc = cache.arcMeters[nextIdx - 1];
    if (nextArc == null || prevArc == null) return 0;

    // Folded-arc guard: terminal loops or reverse-arc segments can produce prevArc > nextArc.
    // The signed math below (schedExpectedArc, remainingDist) assumes prevArc < nextArc, so
    // return 0 rather than compute a wrong-sign offset on these exotic segments.
    if (prevArc > nextArc) return 0;
    const interStopDist = nextArc - prevArc;
    const interStopGap  = cache.times[nextIdx] - cache.times[nextIdx - 1];
    if (interStopDist <= 0 || interStopGap <= 0) return 0;

    // Snap must be within the current inter-stop segment.
    // If it's outside (GPS noise snapped to the wrong part of the track) the offset
    // would be wildly wrong — just return 0 and rely on the schedule alone.
    const snapArc = marker.lastSnap.arcMeters;
    if (snapArc < prevArc || snapArc > nextArc) return 0;

    const { statusChangedAt } = marker.properties;
    if (statusChangedAt == null) return 0;

    // Snap-quality gate: only skip adherence when GPS is so far off the guideway
    // that the snap itself is unreliable. The gate MUST mirror the snap-acceptance
    // threshold in markers.js (`_applySnap`) — bus = BUS_SNAP_MAX_M, heavy rail =
    // HEAVY_RAIL_SNAP_MAX_M (250 m, looser to tolerate tunnel GPS scatter on B/D),
    // light rail = RAIL_SNAP_MAX_M (150 m). The previous code used RAIL_SNAP_MAX_M
    // for ALL rail, silently rejecting heavy-rail snaps in the 150-250 m band —
    // precisely the tunnel regime where adherence matters most. The inter-stop
    // segment guard below already catches snaps that mapped to the wrong stop.
    const dev      = marker.lastSnapDeviationM;
    const _rc      = marker.properties?.route_code;
    const devLimit = isBusRoute(_rc)  ? BUS_SNAP_MAX_DEVIATION_M
                   : isHeavyRail(_rc) ? HEAVY_RAIL_SNAP_MAX_M
                   :                    RAIL_SNAP_MAX_M;
    if (dev == null || dev > devLimit) return 0;

    const elapsedSinceLastStatus = _elapsedWithLag(statusChangedAt, now);
    const schedSpeed = interStopDist / interStopGap;

    if (elapsedSinceLastStatus > interStopGap) {
        // Vehicle ran past its scheduled segment arrival without logging STOPPED_AT.
        // The old Math.min cap silently capped at ~interStopGap, hiding multi-minute
        // delays. Express the full overrun: how long past schedule + time still needed
        // to cover remaining arc at scheduled speed.
        const remainingDist = nextArc - snapArc;
        const remainingTime = Math.max(0, remainingDist / schedSpeed);
        const overrun       = elapsedSinceLastStatus - interStopGap;
        const raw           = overrun + remainingTime;
        return Math.max(-MAX_ADHERENCE_OFFSET_S, Math.min(MAX_ADHERENCE_OFFSET_S, raw));
    }

    // In-segment path: vehicle is still within its scheduled arrival window.
    const timeInTransit    = elapsedSinceLastStatus;
    const schedExpectedArc = prevArc + (timeInTransit / interStopGap) * interStopDist;

    // Positive arcDelta = vehicle ahead of schedule; negate for offset sign convention.
    const arcDelta = snapArc - schedExpectedArc;
    const raw      = -(arcDelta / schedSpeed);

    return Math.max(-MAX_ADHERENCE_OFFSET_S, Math.min(MAX_ADHERENCE_OFFSET_S, raw));
}

/**
 * Sanity-check a Tier-1 GTFS-RT arrival against the vehicle's physical position.
 * Returns false only when the reported arrival is implausibly soon given the
 * arc-distance to the stop. Returns true (trust feed) when required data is missing.
 * @param {Object} marker     Vehicle marker with lastSnap
 * @param {Object} cache      Route stop cache with arcMeters
 * @param {number} targetIdx  Index of the target stop in cache.stops
 * @param {Object} gtfsEntry  Arrival entry from masterArrivalsData
 * @param {number} now        Current unix seconds
 * @returns {boolean}
 */
export function gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now) {
    if (!cache.arcMeters || !marker.lastSnap) return true;
    const stopArc    = cache.arcMeters[targetIdx];
    const vehicleArc = marker.lastSnap.arcMeters;
    if (stopArc == null || vehicleArc == null) return true;

    const distMeters = stopArc - vehicleArc;
    // Vehicle past the stop: only plausible if the reported arrival is in the
    // past (the vehicle has departed and the feed agrees). A future reported
    // arrival when the vehicle is already downstream is a clear feed/snap lag —
    // reject so we fall through to calc/blend instead of rendering "2 min" for
    // a train pulling out of the station. The 30 m tolerance covers the brief
    // snap overshoot just before STOPPED_AT fires on station approach.
    if (distMeters <= -30) {
        return gtfsEntry.arrivalUnix <= now + ETA_PLAUSIBILITY_GRACE_S;
    }
    if (distMeters <= 0) return true;     // at / just past stop — keep behavior

    const reported     = gtfsEntry.arrivalUnix - now;
    const minPlausible = distMeters / ETA_MAX_SPEED_MPS;

    // Lower-bound: feed cannot predict arrival faster than physics allows.
    if (reported < minPlausible - ETA_PLAUSIBILITY_GRACE_S) return false;

    // Upper-bound: when the vehicle is close to the stop AND moving, the feed
    // cannot predict an arrival much slower than (distance / current speed).
    // Catches the "marker at platform but GTFS still says 2 min" feed-lag case
    // where trip_updates' predicted_arrival_time hasn't been recomputed since
    // the last broadcast even though vehicle_position is fresh.
    //
    // Speed-source freshness: smoothedSpeed is written by markers.js on every
    // GPS update. If the marker hasn't been refreshed within the last
    // FRESH_LIVE_S window, the smoothed value is stale (vehicle could have
    // braked since); ignore it and fall back to the conservative floor.
    if (distMeters < ETA_PROXIMITY_OVERRIDE_M) {
        const markerTs = Number(marker.timestamp) || 0;
        const speedIsFresh = markerTs > 0 && (now - markerTs) <= FRESH_LIVE_S;
        const speed = speedIsFresh
            ? Math.max(Number(marker.properties?.smoothedSpeed) || 0, ETA_MIN_APPROACH_SPEED_MPS)
            : ETA_MIN_APPROACH_SPEED_MPS;
        const maxPlausible = distMeters / speed;
        if (reported > maxPlausible + ETA_PLAUSIBILITY_GRACE_S) return false;
    }

    return true;
}

/**
 * Compute a schedule-derived ETA for a stop using static GTFS times scaled by the
 * current speed multiplier from scheduleCalibration.
 * @param {string} tripId
 * @param {number} stopSeq  GTFS stop_sequence of the target stop.
 * @param {number} directionId  0 or 1.
 * @returns {number|null} Unix timestamp (seconds) of predicted arrival, or null if unavailable.
 */
function computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, routeCode, directionId) {
    const { statusChangedAt } = marker.properties;
    const multiplier = getSpeedMultiplier(routeCode, directionId);

    if (nextIdx === targetIdx) {
        if (stopped) return now;
        const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx, routeCode, directionId);
        return remaining != null ? now + remaining : now;
    }

    const rawGap = cache.times[targetIdx] - cache.times[nextIdx];
    if (rawGap < 0) return null;
    // Scale multi-stop gap by the same per-(route, direction) multiplier used in
    // interStopRemainingSeconds so long-horizon ETAs stay consistent with near-stop ETAs.
    const gap = rawGap * multiplier;

    // Pad for unmodeled dwell at intermediate stops. Metro GTFS uses point-times
    // (arrival == departure) at non-timepoint stops, so schedule gaps contain no dwell.
    const intermediateStops = Math.max(0, targetIdx - nextIdx - 1);
    const dwellPad = intermediateStops * (isBusRoute(routeCode) ? ETA_INTERMEDIATE_DWELL_BUS_S : ETA_INTERMEDIATE_DWELL_S);

    if (stopped) return now + Math.max(0, gap + dwellPad);

    const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx, routeCode, directionId);
    // remaining == null means we have no evidence the vehicle is in motion
    // (statusChangedAt missing, or the next stop is the trip origin). The
    // ETA_DEPARTURE_LAG_S correction belongs only on the with-evidence path —
    // applying it here would bias the prediction earlier with no justification.
    if (remaining == null) return now + Math.max(0, gap + dwellPad);
    return now + Math.max(0, remaining + gap + dwellPad);
}


/**
 * Return upcoming arrivals at a stop. Two-tier policy (PR #192 simplified the
 * older blend to a tier fallback after the 2026-05 sweep showed calc adds no
 * material signal once GTFS-RT is present):
 *   - Tier 1: GTFS-RT arrival, plausibility-checked against the vehicle's
 *     physical position (gtfsLooksPlausible).
 *   - Tier 2: GPS-corrected schedule ETA (computeScheduleEta tapered by
 *     computeTripAdherenceOffset) — used when Tier 1 is absent, stale, or
 *     fails the plausibility check.
 * Results are sorted ascending by ETA.
 *
 * @param {string|number} targetStopId
 * @returns {Array<{ routeId, directionId, vehicleId, tripId, arrivalUnix }>}
 */
export function getScheduledArrivals(targetStopId) {
    const sid = String(targetStopId);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    // Snapshot GTFS-RT predictions already known for this stop
    const gtfsList      = window.masterArrivalsData?.get(sid) ?? [];
    const gtfsByTripId  = new Map(gtfsList.map(a => [a.tripId, a]));
    const coveredTripIds = new Set();

    // sid is constant per call — cache targetIdx per route+dir to avoid repeated O(N) scans
    const targetIdxCache = {};

    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;

        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;

        // VEHICLE_MARKER_TTL_S (180s) is intentionally independent of the
        // FRESH_* visual tiers in markers.js — this is an algorithmic gate
        // (predictions can't trust a 180s-old position) and lives between
        // the `stale` (90s) and `expired` (300s) visual thresholds.
        if (now - (marker.timestamp ?? 0) > VEHICLE_MARKER_TTL_S) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        // Without a known direction we can't reliably tell whether the target stop
        // is ahead of or behind the vehicle. Trying both dirs risks phantom ETAs
        // (e.g. a westbound train near the east terminus generates eastbound arrivals
        // for every station whose schedule index happens to be >= nextIdx in dir=0).
        // Vehicles with unknown direction can still surface via GTFS-RT entries
        // appended below, which carry their own arrivalUnix.
        if (preferredDir == null) continue;
        const dirs         = dirsToTry(preferredDir);

        for (const dir of dirs) {
            const cacheKey = `${route_code}|${dir}`;
            const cache = routeStops[cacheKey];
            if (!cache) continue;

            const stopped = isEffectivelyStopped(marker);

            const nextIdx = findIdx(cache.stops, vehicleNextStop);

            // sid is constant per call — memoize targetIdx per route+dir to avoid
            // repeated O(N) scans across all vehicles for the same cache.
            if (!(cacheKey in targetIdxCache)) targetIdxCache[cacheKey] = findIdx(cache.stops, sid);
            const targetIdx = targetIdxCache[cacheKey];
            if (nextIdx === -1 || targetIdx === -1) continue;
            if (targetIdx < nextIdx) continue;

            // Trip-level schedule adherence: measure the vehicle's running offset
            // once and apply it (tapered) to all stops — next stop and all downstream
            // ETAs. The taper caps the offset at ADHERENCE_TAPER_K × remainingTime
            // so a 5-min-late train doesn't inflate its 30-s-away ETA to 5.5 min,
            // while downstream stops with larger remainingTime still express most
            // of the cascading lateness.
            const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);

            const schedEta = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, route_code, dir);
            let calcEta = null;
            if (schedEta != null) {
                calcEta = _applyTaperedOffset(schedEta, adherenceOffset, now);
            }

            // Tier 1 — GTFS-RT by tripId: blend GTFS-RT and calc, favoring GTFS-RT.
            // 2026-05-07 v6 audit (515 arrivals, 3460 snapshots): GTFS-RT wins 76%
            // of head-to-head matchups; MAE 20s vs calc 48.5s. Gap widens with horizon:
            //   <30s:  GTFS 97% vs calc 92% within60s  → keep 30% calc (smooths jitter)
            //   1–2min: GTFS 95% vs calc 78%            → 10% calc
            //   2–5min: GTFS 86% vs calc 51%            → pure GTFS
            // GTFS also converges (MAE first→last: 26s→10s); calc plateaus (47s→44s).
            //
            // Plausibility check still falls back to calc when GTFS-RT contradicts
            // physical position. Staleness gate skips the blend if GTFS-RT is stale.
            //
            // Origin-stop guard: a vehicle STOPPED_AT the first stop (nextIdx=0) is
            // sitting at the terminus doing a layover. We don't know when it departs,
            // so calc always underestimates (it uses travel time only, not dwell time).
            // Don't let calc override GTFS-RT in that case.
            const atOrigin = nextIdx === 0 && stopped;
            const calcEtaForBlend = atOrigin ? null : calcEta;

            const gtfsEntry = gtfsByTripId.get(trip_id);
            if (gtfsEntry) {
                const gtfsStale = now - (gtfsEntry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S;
                let arrivalUnix;
                if (gtfsStale) {
                    arrivalUnix = calcEtaForBlend;
                } else if (calcEtaForBlend != null && !gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now)) {
                    arrivalUnix = calcEtaForBlend;
                } else if (calcEtaForBlend != null) {
                    const gtfsHorizon = gtfsEntry.arrivalUnix - now;
                    arrivalUnix = _blendArrivals(calcEtaForBlend, gtfsEntry.arrivalUnix, gtfsHorizon, now);
                } else {
                    arrivalUnix = gtfsEntry.arrivalUnix;
                }
                // Mark covered regardless so the GTFS-only loop below never re-appends
                // a stale entry for a vehicle we already have a live position for.
                coveredTripIds.add(trip_id);
                if (arrivalUnix != null) {
                    results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id, arrivalUnix });
                }
                break;
            }

            // Tier 2 — no GTFS-RT match: use calc (suppressed for origin-stop vehicles)
            if (calcEtaForBlend == null) break;
            results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id, arrivalUnix: calcEtaForBlend });
            break;
        }
    }

    // Append GTFS-only entries — trains GTFS-RT sees that our vehicle-position
    // pipeline missed (e.g. vehicles turning around at end-of-line, or IDs that
    // didn't match any active marker).
    // Staleness gate (L-1): skip entries not refreshed within GTFS_ENTRY_STALENESS_S
    // to prevent zombie arrivals when the trip_updates feed hangs.
    for (const [tripId, entry] of gtfsByTripId) {
        if (coveredTripIds.has(tripId)) continue;
        // Use the shared past-arrival grace so trains still pulling out of a
        // station don't vanish from one popup refresh while the prune loop is
        // still keeping them in masterArrivalsData.
        if (entry.arrivalUnix < now - PAST_ARRIVAL_GRACE_S) continue;
        if (now - (entry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S) continue;
        results.push({ ...entry });
    }

    results.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Keep only the 2 closest vehicles per route+direction
    const countPerDir = {};
    return results.filter(a => {
        const k = `${a.routeId}|${a.directionId}`;
        countPerDir[k] = (countPerDir[k] ?? 0) + 1;
        return countPerDir[k] <= 2;
    });
}

/**
 * Like getScheduledArrivals but returns { calcEta, gtfsEta } separately
 * so callers can compare the two sources. Used by the ETA accuracy test.
 * gtfsEta is null when no fresh GTFS-RT entry exists for that vehicle.
 */
export function getArrivalBreakdown(targetStopId) {
    const sid = String(targetStopId);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    const gtfsList     = window.masterArrivalsData?.get(sid) ?? [];
    const gtfsByTripId = new Map(gtfsList.map(a => [a.tripId, a]));
    const targetIdxCache = {};

    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;
        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;
        if (now - (marker.timestamp ?? 0) > VEHICLE_MARKER_TTL_S) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        if (preferredDir == null) continue;

        for (const dir of dirsToTry(preferredDir)) {
            const cacheKey = `${route_code}|${dir}`;
            const cache = routeStops[cacheKey];
            if (!cache) continue;

            const stopped  = isEffectivelyStopped(marker);
            const nextIdx  = findIdx(cache.stops, vehicleNextStop);
            if (!(cacheKey in targetIdxCache)) targetIdxCache[cacheKey] = findIdx(cache.stops, sid);
            const targetIdx = targetIdxCache[cacheKey];
            if (nextIdx === -1 || targetIdx === -1 || targetIdx < nextIdx) continue;

            const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
            const schedEta        = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, route_code, dir);
            // Production now applies the taper here as well — match exactly so
            // the harness measures user-visible ETAs, not a divergent calc value.
            let rawCalcEta = null;
            if (schedEta != null) {
                rawCalcEta = _applyTaperedOffset(schedEta, adherenceOffset, now);
            }
            // Suppress calc for origin-stop vehicles (same guard as getScheduledArrivals)
            const calcEta    = (nextIdx === 0 && stopped) ? null : rawCalcEta;
            const multiplier = getSpeedMultiplier(route_code, dir);

            const gtfsEntry = gtfsByTripId.get(trip_id);
            const gtfsEta   = (gtfsEntry && now - (gtfsEntry.lastIngestUnix ?? 0) <= GTFS_ENTRY_STALENESS_S)
                ? gtfsEntry.arrivalUnix
                : null;

            // Compute blendEta and record WHICH tier fired. Mirrors the
            // tier policy in getScheduledArrivals's _blendArrivals + its
            // upstream plausibility/staleness/origin-stop guards. The tier
            // string is captured per row so the live-accuracy harness can
            // measure per-tier MAE (especially "calc when it's the actual
            // displayed prediction"), not just aggregate blend MAE.
            let blendEta = null;
            let blendTier = null;     // 'gtfs' | 'calc' | 'gtfs-stale' | 'gtfs-implausible' | 'origin-suppressed' | 'no-data'
            if (gtfsEntry) {
                const gtfsAge = now - (gtfsEntry.lastIngestUnix ?? 0);
                const gtfsStale = gtfsAge > GTFS_ENTRY_STALENESS_S;
                if (gtfsStale) {
                    blendEta = calcEta;
                    blendTier = calcEta != null ? 'gtfs-stale' : 'no-data';
                } else if (calcEta != null && !gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now)) {
                    blendEta = calcEta;
                    blendTier = 'gtfs-implausible';
                } else if (calcEta != null) {
                    const gtfsHorizon = gtfsEntry.arrivalUnix - now;
                    blendEta = _blendArrivals(calcEta, gtfsEntry.arrivalUnix, gtfsHorizon, now);
                    // Under the simplified tier policy, _blendArrivals returns
                    // gtfsEta when present; that's the canonical "Tier 1" case.
                    blendTier = 'gtfs';
                } else {
                    // calc suppressed (origin-stop) but GTFS is fresh + plausible.
                    blendEta = gtfsEta;
                    blendTier = nextIdx === 0 && stopped ? 'origin-suppressed' : 'gtfs';
                }
            } else if (calcEta != null) {
                blendEta = calcEta;
                blendTier = 'calc';
            } else {
                blendEta = null;
                blendTier = 'no-data';
            }

            const gtfsAgeS = gtfsEntry ? (now - (gtfsEntry.lastIngestUnix ?? 0)) : null;

            // Taper diagnostics: was the raw offset larger than the cap that
            // calcEta actually applied? (True ⇒ taper limited adherence's effect.)
            const remainingTime = schedEta != null ? Math.max(0, schedEta - now) : 0;
            const maxOffset     = ADHERENCE_TAPER_K * remainingTime;
            const _wasCapped    = Math.abs(adherenceOffset) > maxOffset;

            results.push({
                routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id,
                calcEta, gtfsEta, blendEta,
                // diagnostics — consumed by tests/eta-live-accuracy.js
                _intermediateStops: Math.max(0, targetIdx - nextIdx - 1),
                _adherenceOffsetS:  Math.round(adherenceOffset),
                _atOrigin:          nextIdx === 0 && stopped,
                _speedMultiplier:   Math.round(multiplier * 100) / 100,
                _offsetCapped:      _wasCapped,
                _snapDeviationM:    marker.lastSnapDeviationM ?? null,
                _blendTier:         blendTier,
                _gtfsAgeS:          gtfsAgeS != null ? Math.round(gtfsAgeS) : null,
            });
            break;
        }
    }

    results.sort((a, b) => (a.calcEta ?? Infinity) - (b.calcEta ?? Infinity));
    return results;
}

/**
 * Return estimated seconds until the vehicle reaches its current next stop,
 * accounting for schedule calibration. Returns 0 if STOPPED_AT, null if unknown.
 * @param {Object} marker Vehicle marker with properties
 * @returns {number|null}
 */
export function getSecondsToNextStop(marker) {
    const { trip_id, route_code, stopId, statusChangedAt, direction_id } = marker.properties ?? {};
    if (!trip_id || !route_code || !stopId) return null;

    // isEffectivelyStopped (vs raw isStoppedAt) returns 0 only when the vehicle
    // is *genuinely* at the stop — a STOPPED_AT-misfiring vehicle (feed says
    // "at stop" but observed motion proves otherwise) keeps producing a real
    // schedule-derived ETA instead of misleading the rider with "Now". Aligns
    // with getScheduledArrivals' use of isEffectivelyStopped.
    if (isEffectivelyStopped(marker)) return 0;

    const now = Math.floor(Date.now() / 1000);
    const tripMeta     = window.masterTripsData?.[trip_id];
    const preferredDir = tripMeta?.dir ?? (direction_id != null ? Number(direction_id) : null);
    // Mirror the safety guard in getScheduledArrivals (line 504): without a
    // known direction, dirsToTry would iterate both and the first cache hit
    // would win — risking a westbound train's "next stop" being computed
    // against the eastbound sequence. Return null instead of a wrong ETA.
    if (preferredDir == null) return null;
    const dirs         = dirsToTry(preferredDir);

    for (const dir of dirs) {
        const cache = routeStops[`${route_code}|${dir}`];
        if (!cache) continue;

        const nextIdx = findIdx(cache.stops, String(stopId));
        if (nextIdx === -1) continue;

        const raw = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx, route_code, dir);
        if (raw == null) return null;
        const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
        // Use the same tapered offset as getScheduledArrivals — raw offset can be ±600 s
        // which would wildly inflate the "next stop" ETA displayed in the vehicle popup.
        const schedEta = now + raw;
        return Math.max(0, _applyTaperedOffset(schedEta, adherenceOffset, now) - now);
    }
    return null;
}

/**
 * Return the last stop ID in the scheduled stop sequence for a route+direction.
 * @param {string} routeCode
 * @param {number} directionId 0 or 1
 * @returns {string|null}
 */
export function getTerminalStopId(routeCode, directionId) {
    const cache = routeStops[`${routeCode}|${directionId}`];
    if (!cache?.stops?.length) return null;
    for (let i = cache.stops.length - 1; i >= 0; i--) {
        if (cache.stops[i]) return cache.stops[i];
    }
    return null;
}

/**
 * Return a cleaned display name for the terminal stop of a route+direction.
 * @param {string} routeCode
 * @param {number} directionId
 * @returns {string|null}
 */
export function getTerminalName(routeCode, directionId) {
    const override = TERMINUS_DISPLAY_OVERRIDES[`${routeCode}|${directionId}`];
    if (override) return override;
    const lastStopId = getTerminalStopId(routeCode, directionId);
    if (!lastStopId) return null;
    const stop = window.masterStopsData?.[String(lastStopId)];
    return stop?.name ? cleanStationName(stop.name) : null;
}

/**
 * Resolve a trip's destination label via the canonical cascade. Used by station
 * popup rows (stations.js) and vehicle popups (ui.js). Previously each module
 * implemented its own cascade with subtly different ordering — stations.js put
 * `getTerminalName` (schedule-derived, authoritative) first while ui.js put it
 * last, so the same trip could surface different labels depending on which
 * popup the rider opened. This helper is the one ordering both call sites use.
 *
 * Cascade:
 *   1. Schedule-derived terminus (`getTerminalName`) — authoritative; covers
 *      every static-GTFS trip and folds in TERMINUS_DISPLAY_OVERRIDES.
 *   2. Live trip.dest, pre-cleaned by the caller via `cleanDestination`. The
 *      cleaning lives in ui.js to keep this helper pure (no cross-module dep
 *      cycle predictions.js → ui.js).
 *   3. Last stop in `tripInfo.stops` — name from `masterStopsData`.
 *   4. Live `tripTerminusByTripId` (trip_updates feed) — covers J Line variants
 *      and city buses folded into station groups that lack static trip data.
 *
 * Returns `null` when no source produces a name; callers supply their own
 * fallback (direction label, "Dir 0", etc.).
 *
 * @param {string}      routeCode
 * @param {number}      directionId       0 or 1
 * @param {string|null} tripId            optional, used for live-feed lookup
 * @param {object|null} tripInfo          masterTripsData entry, if any
 * @param {string|null} cleanedTripDest   `cleanDestination(tripInfo.dest)` pre-applied
 * @returns {string|null}
 */
export function resolveTripDestination(routeCode, directionId, tripId, tripInfo, cleanedTripDest) {
    const structural = getTerminalName(routeCode, directionId);
    if (structural) return structural;
    if (cleanedTripDest) return cleanedTripDest;
    if (tripInfo?.stops) {
        const lastStopId = [...tripInfo.stops].reverse().find(s => s);
        const stop = lastStopId ? window.masterStopsData?.[String(lastStopId)] : null;
        if (stop?.name) return cleanStationName(stop.name);
    }
    if (tripId) {
        const liveTermStopId = tripTerminusByTripId.get(String(tripId));
        const stop = liveTermStopId ? window.masterStopsData?.[String(liveTermStopId)] : null;
        if (stop?.name) return cleanStationName(stop.name);
    }
    return null;
}

/**
 * Returns true if any of the given stop IDs is the first stop of routeCode|dir.
 * @param {string[]} stopIds
 * @param {string} routeCode
 * @param {number} dir
 * @returns {boolean}
 */
export function isOriginStop(stopIds, routeCode, dir) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    return stopIds.some(sid => findIdx(cache.stops, sid) === 0);
}

/**
 * Returns true when this vehicle is STOPPED_AT the origin (idx=0) of its own
 * route+direction. Route-aware: a K Line train at Expo/Crenshaw is at origin,
 * but an E Line train at the same station is mid-route and not suppressed.
 * @param {Object} props Marker properties
 * @returns {boolean}
 */
export function isAtOwnOriginStop(props) {
    if (!props || !isStoppedAt(props.currentStatus)) return false;
    const { route_code, stopId, trip_id } = props;
    if (!route_code || !stopId) return false;
    const tripMeta     = window.masterTripsData?.[trip_id];
    const preferredDir = tripMeta?.dir ?? props.direction_id;
    if (preferredDir == null) return false;
    const cache = routeStops[`${route_code}|${preferredDir}`];
    if (!cache?.stops?.length) return false;
    return findIdx(cache.stops, String(stopId)) === 0;
}

/**
 * Return all (stopId, routeCode, dir) tuples where stopId is the origin (idx=0)
 * of that route+direction. Used by stations.js to render boarding badges.
 * @returns {Array<{ stopId: string, routeCode: string, dir: number }>}
 */
export function getAllOriginStops() {
    const result = [];
    for (const [key, cache] of Object.entries(routeStops)) {
        const [routeCode, dirStr] = key.split('|');
        const originStopId = cache.stops?.[0];
        if (originStopId) result.push({ stopId: String(originStopId), routeCode, dir: Number(dirStr) });
    }
    return result;
}

/**
 * Returns true if any of the given stop IDs is the last stop of routeCode|dir.
 * @param {string[]} stopIds
 * @param {string} routeCode
 * @param {number} dir
 * @returns {boolean}
 */
export function isTerminalStop(stopIds, routeCode, dir) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    const lastIdx = cache.stops.length - 1;
    return stopIds.some(sid => findIdx(cache.stops, sid) === lastIdx);
}

/**
 * Returns true if any of the given stop IDs falls within the last `n` stops
 * of routeCode|dir (not counting the terminal itself, which isTerminalStop handles).
 * Used to suppress empty "destination = San Pedro" rows at stops that are already
 * physically within the destination area.
 * @param {string[]} stopIds
 * @param {string} routeCode
 * @param {number} dir
 * @param {number} [n=1]  number of stops before the terminal to suppress
 * @returns {boolean}
 */
export function isNearTerminalStop(stopIds, routeCode, dir, n = 1) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    const lastIdx = cache.stops.length - 1;
    return stopIds.some(sid => {
        const idx = findIdx(cache.stops, sid);
        return idx >= 0 && idx >= lastIdx - n && idx < lastIdx;
    });
}

/**
 * Return vehicles boarding at the origin terminus for any of the given stop IDs.
 * Combines two sources:
 *   1. Active markers STOPPED_AT origin (live VP feed)
 *   2. Fresh GTFS-RT trip_updates entries at origin with no covering marker
 *      (bridges the layover gap when the VP feed is silent)
 * Each entry includes departureUnix when known (from trip_updates).
 *
 * **Staleness asymmetry between tiers (intentional):** Tier 1 uses
 * VEHICLE_MARKER_TTL_S (180s); Tier 2 uses GTFS_ENTRY_STALENESS_S (90s). The
 * 90s gap is a feature: if the VP feed dies but trip_updates stays fresh, a
 * Tier-2 boarding badge appears for up to 90s without a corresponding marker.
 * This is the "layover gap bridge" and is the whole point of Tier 2 — riders
 * still see "next train at 12:34" while the VP feed is silent. The downside
 * is a brief window where a badge can claim a departure that no longer has a
 * vehicle on the way; deemed acceptable because trip_updates is authoritative
 * for scheduled service and stales out within 90s anyway.
 *
 * @param {string[]} stopIds
 * @returns {Array<{ routeCode, directionId, vehicleId, tripId, departureUnix }>}
 */
export function getBoardingVehicles(stopIds) {
    const now = Math.floor(Date.now() / 1000);
    const results = [];
    const seenTripIds = new Set();
    const stopIdSet = new Set(stopIds.map(String));

    // Tier 1: active markers STOPPED_AT origin
    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;
        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;
        if (now - (marker.timestamp ?? 0) > VEHICLE_MARKER_TTL_S) continue;

        if (!isEffectivelyStopped(marker)) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        const dirs         = dirsToTry(preferredDir);

        for (const dir of dirs) {
            const cache = routeStops[`${route_code}|${dir}`];
            if (!cache) continue;
            const nextIdx = findIdx(cache.stops, vehicleNextStop);
            if (nextIdx !== 0) continue;
            if (!stopIds.some(sid => findIdx(cache.stops, sid) === 0)) continue;

            // Look up scheduled departure from GTFS-RT trip_updates if available.
            const gtfsList  = window.masterArrivalsData?.get(String(vehicleNextStop)) ?? [];
            const gtfsEntry = gtfsList.find(e => e.tripId === trip_id);
            const departureUnix = gtfsEntry && now - (gtfsEntry.lastIngestUnix ?? 0) <= GTFS_ENTRY_STALENESS_S
                ? gtfsEntry.arrivalUnix
                : null;

            seenTripIds.add(trip_id);
            results.push({
                routeId: route_code, directionId: dir,
                vehicleId: vehicle_id, tripId: trip_id,
                stopId: String(vehicleNextStop), departureUnix,
            });
            break;
        }
    }

    // Tier 2: GTFS-only trip_updates at origin stops (bridges VP layover gap).
    // For each requested stopId that is an origin for some route+dir, find fresh
    // trip_updates entries for that origin whose tripId is not already covered.
    // Only include trains likely physically dwelling — departure within 10 min.
    // Scheduled-but-not-yet-here trains (departing in 25+ min) are filtered out;
    // they'll show up as normal arrivals at upstream stops, not as "boarding".
    const BOARDING_MAX_HORIZON_S = 600; // 10 min
    for (const sid of stopIdSet) {
        const gtfsList = window.masterArrivalsData?.get(sid) ?? [];
        for (const entry of gtfsList) {
            if (!entry?.tripId) continue;
            if (seenTripIds.has(entry.tripId)) continue;
            if (now - (entry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S) continue;
            // Allow entries from now onward (train still dwelling) up to BOARDING_MAX_HORIZON_S.
            if (entry.arrivalUnix < now - PAST_ARRIVAL_GRACE_S) continue;
            if (entry.arrivalUnix - now > BOARDING_MAX_HORIZON_S) continue;

            const tripMeta = window.masterTripsData?.[entry.tripId];
            if (!tripMeta) continue;
            const routeCode = String(tripMeta.rc ?? entry.routeId ?? '');
            const dir       = tripMeta.dir ?? entry.directionId;
            if (!routeCode || dir == null) continue;

            // Verify this stopId is actually idx=0 for this route+dir (route-aware).
            const cache = routeStops[`${routeCode}|${dir}`];
            if (!cache?.stops?.length) continue;
            if (findIdx(cache.stops, sid) !== 0) continue;

            seenTripIds.add(entry.tripId);
            results.push({
                routeId: routeCode, directionId: dir,
                vehicleId: entry.vehicleId ?? null, tripId: entry.tripId,
                stopId: sid, departureUnix: entry.arrivalUnix,
                gtfsOnly: true,
            });
        }
    }

    return results;
}
