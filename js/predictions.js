import { cleanStationName, isStoppedAt, normalizeStopId, isBusRoute } from './utils.js';
import { snapToRoute, hasShapeData } from './snap.js';
import {
    ETA_MAX_SPEED_MPS, ETA_PLAUSIBILITY_GRACE_S,
    ETA_DEPARTURE_LAG_S,
    GTFS_ENTRY_STALENESS_S, VEHICLE_MARKER_TTL_S,
    ETA_INTERMEDIATE_DWELL_S, ETA_INTERMEDIATE_DWELL_BUS_S,
    ADHERENCE_TAPER_K,
} from './config.js';
import { getSpeedMultiplier } from './scheduleCalibration.js';

const RE_TRAIL_NONDIG = /\D+$/;
const RE_HAS_DIGIT    = /\d/;

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
 * Pre-process window.masterTripsData into per-(route, direction) stop/time lookup
 * tables and compute arc-meter positions for each stop (used in kinematic ETA).
 * Must be called after stops.json and trips.json are loaded.
 */
export function initPredictions() {
    const trips = window.masterTripsData;
    if (!trips) return;

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
 * Dead-reckon the remaining seconds until a vehicle reaches its next stop.
 * Uses the feed's statusChangedAt timestamp (when this stopId last appeared)
 * plus an ETA_DEPARTURE_LAG_S departure lag to estimate how far through the inter-stop segment
 * the vehicle currently is.
 * Returns null when the required data isn't available (no statusChangedAt,
 * first stop with no prior gap, or zero-length segment in the schedule).
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
    const timeInTransit = Math.min((now - statusChangedAt) + ETA_DEPARTURE_LAG_S, interStopGap);
    return Math.max(0, interStopGap - timeInTransit);
}

/**
 * Measure how many seconds this vehicle is running ahead (negative) or behind
 * (positive) its timetable based on GPS arc position vs. the scheduled position
 * in the current inter-stop segment.
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

    // Snap-quality gate: a bad snap (GPS far from polyline) produces a wildly wrong
    // arc-position, making any offset calculation meaningless. Gate first so we don't
    // do work we're about to discard.
    const dev      = marker.lastSnapDeviationM;
    const devLimit = isBusRoute(marker.properties?.route_code) ? 120 : 80;
    if (dev == null || dev > devLimit) return 0;

    const elapsedSinceLastStatus = (now - statusChangedAt) + ETA_DEPARTURE_LAG_S;
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
        return Math.max(-600, Math.min(600, raw));
    }

    // In-segment path: vehicle is still within its scheduled arrival window.
    const timeInTransit    = elapsedSinceLastStatus;
    const schedExpectedArc = prevArc + (timeInTransit / interStopGap) * interStopDist;

    // Positive arcDelta = vehicle ahead of schedule; negate for offset sign convention.
    const arcDelta = snapArc - schedExpectedArc;
    const raw      = -(arcDelta / schedSpeed);

    return Math.max(-600, Math.min(600, raw));
}

/**
 * Sanity-check a Tier-1 GTFS-RT arrival against the vehicle's physical position.
 * Returns false only when the reported arrival is implausibly soon given the
 * arc-distance to the stop. Caller should fall back to calcEta in that case.
 * Returns true (trust feed) whenever required data is missing.
 */
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
    if (distMeters <= 0) return true;     // vehicle past stop / loop turnaround

    const minPlausible = distMeters / ETA_MAX_SPEED_MPS;
    const reported     = gtfsEntry.arrivalUnix - now;

    return reported >= minPlausible - ETA_PLAUSIBILITY_GRACE_S;
}

/**
 * Schedule dead-reckoning ETA (Tier 3 / original logic).
 * Returns unix seconds or null.
 */
function computeScheduleEta(marker, cache, nextIdx, targetIdx, isStoppedAt, now, routeCode, directionId) {
    const { statusChangedAt } = marker.properties;
    const multiplier = getSpeedMultiplier(routeCode, directionId);

    if (nextIdx === targetIdx) {
        if (isStoppedAt) return now;
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

    if (isStoppedAt) return now + Math.max(0, gap + dwellPad);

    const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx, routeCode, directionId);
    if (remaining == null) return now + Math.max(0, gap - ETA_DEPARTURE_LAG_S + dwellPad);
    return now + Math.max(0, remaining + gap + dwellPad);
}

/**
 * Return upcoming arrivals at a stop, merging GTFS-RT and schedule-based ETAs.
 * Tier 1: GTFS-RT arrival (plausibility-checked). Tier 2: GPS-corrected schedule.
 * Tier 3: fallback schedule ETA. Results are sorted ascending by ETA.
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

            const stopped = isStoppedAt(marker.properties.currentStatus);

            const nextIdx = findIdx(cache.stops, vehicleNextStop);

            // sid is constant per call — memoize targetIdx per route+dir to avoid
            // repeated O(N) scans across all vehicles for the same cache.
            if (!(cacheKey in targetIdxCache)) targetIdxCache[cacheKey] = findIdx(cache.stops, sid);
            const targetIdx = targetIdxCache[cacheKey];
            if (nextIdx === -1 || targetIdx === -1) continue;
            if (targetIdx < nextIdx) continue;

            // Trip-level schedule adherence: measure the vehicle's running offset once
            // and apply it uniformly to all stops — next stop and all downstream ETAs.
            // Uncapped by design: a train running 5+ min late should show that delay
            // at every station, not just the immediate next stop.
            const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);

            const schedEta = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, route_code, dir);
            // Adherence taper (OBA #127 bug class): cap the applied offset so it never
            // exceeds the vehicle's remaining scheduled travel time. Eliminates close-range
            // overshoot where a +100s offset on a bus 15s away would predict 115s.
            let calcEta = null;
            if (schedEta != null) {
                const remainingTime = Math.max(0, schedEta - now);
                const maxOffset     = ADHERENCE_TAPER_K * remainingTime;
                const sign          = Math.sign(adherenceOffset);
                const cappedOffset  = sign * Math.min(Math.abs(adherenceOffset), maxOffset);
                calcEta = Math.max(now, schedEta + cappedOffset);
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
                    const calcHorizon = calcEtaForBlend - now;

                    // Stale-replay guard: GTFS entries can replay after a feed reconnect
                    // with an old arrivalUnix. If GTFS predicts >2× longer than calc and
                    // we're within 5 min, the entry is almost certainly stale.
                    // (2026-05-07 worst case: gtfsHorizon=1529s vs calcHorizon=103s)
                    if (calcHorizon < 300 && gtfsHorizon > 2 * calcHorizon + 60) {
                        arrivalUnix = calcEtaForBlend;
                    } else {
                        // Horizon-adaptive blend weights: calc contribution fades as
                        // horizon grows, where calc noise dominates and GTFS dominates.
                        const w = gtfsHorizon < 60  ? 0.7   // 30% calc: smooths near-arrival jitter
                                : gtfsHorizon < 300 ? 0.9   // 10% calc: GTFS dominates mid-range
                                :                    1.0;  // pure GTFS beyond 5 min

                        // If both sources still disagree by >120s after weighting, calc is
                        // likely a large outlier — use GTFS-RT alone.
                        const disagreementSec = Math.abs(gtfsEntry.arrivalUnix - calcEtaForBlend);
                        arrivalUnix = disagreementSec > 120
                            ? gtfsEntry.arrivalUnix
                            : w * gtfsEntry.arrivalUnix + (1 - w) * calcEtaForBlend;
                    }
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

            // Tier 2/3 — no GTFS-RT match: use calc (suppressed for origin-stop vehicles)
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
        if (entry.arrivalUnix <= now) continue;
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

            const stopped  = isStoppedAt(marker.properties.currentStatus);
            const nextIdx  = findIdx(cache.stops, vehicleNextStop);
            if (!(cacheKey in targetIdxCache)) targetIdxCache[cacheKey] = findIdx(cache.stops, sid);
            const targetIdx = targetIdxCache[cacheKey];
            if (nextIdx === -1 || targetIdx === -1 || targetIdx < nextIdx) continue;

            const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
            const schedEta        = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, route_code, dir);
            // Adherence taper (same logic as getScheduledArrivals)
            let rawCalcEta   = null;
            let cappedOffset = adherenceOffset;
            if (schedEta != null) {
                const remainingTime = Math.max(0, schedEta - now);
                const maxOffset     = ADHERENCE_TAPER_K * remainingTime;
                const sign          = Math.sign(adherenceOffset);
                cappedOffset        = sign * Math.min(Math.abs(adherenceOffset), maxOffset);
                rawCalcEta          = Math.max(now, schedEta + cappedOffset);
            }
            // Suppress calc for origin-stop vehicles (same guard as getScheduledArrivals)
            const calcEta    = (nextIdx === 0 && stopped) ? null : rawCalcEta;
            const multiplier = getSpeedMultiplier(route_code, dir);

            const gtfsEntry = gtfsByTripId.get(trip_id);
            const gtfsEta   = (gtfsEntry && now - (gtfsEntry.lastIngestUnix ?? 0) <= GTFS_ENTRY_STALENESS_S)
                ? gtfsEntry.arrivalUnix
                : null;

            results.push({
                routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id,
                calcEta, gtfsEta,
                // diagnostics — consumed by tests/eta-live-accuracy.js
                _intermediateStops: Math.max(0, targetIdx - nextIdx - 1),
                _adherenceOffsetS:  Math.round(adherenceOffset),
                _atOrigin:          nextIdx === 0 && stopped,
                _speedMultiplier:   Math.round(multiplier * 100) / 100,
                _offsetCapped:      Math.abs(cappedOffset) < Math.abs(adherenceOffset),
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
    const { trip_id, route_code, currentStatus, stopId, statusChangedAt, direction_id } = marker.properties ?? {};
    if (!trip_id || !route_code || !stopId) return null;

    if (isStoppedAt(currentStatus)) return 0;

    const now = Math.floor(Date.now() / 1000);
    const tripMeta     = window.masterTripsData?.[trip_id];
    const preferredDir = tripMeta?.dir ?? (direction_id != null ? Number(direction_id) : null);
    const dirs         = dirsToTry(preferredDir);

    for (const dir of dirs) {
        const cache = routeStops[`${route_code}|${dir}`];
        if (!cache) continue;

        const nextIdx = findIdx(cache.stops, String(stopId));
        if (nextIdx === -1) continue;

        const raw = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx, route_code, dir);
        if (raw == null) return null;
        const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
        return Math.max(0, raw + adherenceOffset);
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
    const lastStopId = getTerminalStopId(routeCode, directionId);
    if (!lastStopId) return null;
    const stop = window.masterStopsData?.[String(lastStopId)];
    return stop?.name ? cleanStationName(stop.name) : null;
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
 * Return vehicles boarding at the origin terminus for any of the given stop IDs.
 * Combines two sources:
 *   1. Active markers STOPPED_AT origin (live VP feed)
 *   2. Fresh GTFS-RT trip_updates entries at origin with no covering marker
 *      (bridges the layover gap when the VP feed is silent)
 * Each entry includes departureUnix when known (from trip_updates).
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

        if (!isStoppedAt(marker.properties.currentStatus)) continue;

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
            if (entry.arrivalUnix < now - 30) continue;
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
