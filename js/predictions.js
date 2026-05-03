import { cleanStationName, isStoppedAt, normalizeStopId } from './utils.js';
import { snapToRoute, hasShapeData } from './snap.js';

const RE_TRAIL_NONDIG = /\D+$/;
const RE_HAS_DIGIT    = /\d/;

const routeStops = {};

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
    console.log(`[predictions] schedule cache: ${Object.keys(routeStops).length} route-dirs`);

    // Precompute stop arc-meters for kinematic ETA (best-effort; null if shapes not yet loaded)
    let arcRouteDirs = 0, arcStops = 0;
    for (const [key, cache] of Object.entries(routeStops)) {
        const [rc] = key.split('|');
        if (!hasShapeData(rc)) continue;
        cache.arcMeters = cache.stops.map(stopId => {
            const stop = window.masterStopsData?.[stopId];
            if (!stop) return null;
            return snapToRoute(rc, stop.lon, stop.lat)?.arcMeters ?? null;
        });
        arcRouteDirs++;
        arcStops += cache.arcMeters.filter(v => v !== null).length;
    }
    if (arcRouteDirs > 0) {
        console.log(`[predictions] arc cache: ${arcRouteDirs} route-dirs (${arcStops} stops)`);
    }
}

const dirsToTry = d => d != null ? [d] : [0, 1];

function findIdx(stops, targetId) {
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
 * plus a 30s departure lag to estimate how far through the inter-stop segment
 * the vehicle currently is.
 * Returns null when the required data isn't available (no statusChangedAt,
 * first stop with no prior gap, or zero-length segment in the schedule).
 */
function interStopRemainingSeconds(statusChangedAt, now, times, idx) {
    if (statusChangedAt == null || idx <= 0) return null;
    const interStopGap = times[idx] - times[idx - 1];
    if (interStopGap <= 0) return null;
    const timeInTransit = Math.min((now - statusChangedAt) + 30, interStopGap);
    return Math.max(0, interStopGap - timeInTransit);
}

/**
 * Apply a GPS-derived schedule-deviation correction to a schedule ETA.
 * The schedule is always the base; GPS tells us whether the vehicle is
 * running ahead or behind the timetable and nudges the estimate accordingly.
 * Capped at ±60s so stale or noisy GPS never causes wild swings.
 * Returns the corrected unix-second ETA (or the original if GPS data is absent).
 */
function applyGpsCorrection(schedEta, marker, cache, nextIdx, now) {
    if (!cache.arcMeters || !marker.lastSnap || nextIdx <= 0) return schedEta;

    const nextArc = cache.arcMeters[nextIdx];
    const prevArc = cache.arcMeters[nextIdx - 1];
    if (nextArc == null || prevArc == null) return schedEta;

    const interStopDist = nextArc - prevArc;
    const interStopGap  = cache.times[nextIdx] - cache.times[nextIdx - 1];
    if (interStopDist <= 0 || interStopGap <= 0) return schedEta;

    const { statusChangedAt } = marker.properties;
    if (statusChangedAt == null) return schedEta;

    // Where the schedule expects the vehicle to be right now
    const timeInTransit   = Math.min((now - statusChangedAt) + 30, interStopGap);
    const schedExpectedArc = prevArc + (timeInTransit / interStopGap) * interStopDist;

    // Positive = vehicle is ahead of schedule; negative = behind
    const arcDelta = marker.lastSnap.arcMeters - schedExpectedArc;

    // Convert arc offset to time using scheduled speed (more stable than live GPS speed)
    const schedSpeed = interStopDist / interStopGap;
    const correctionSec = Math.max(-60, Math.min(60, arcDelta / schedSpeed));

    return Math.max(now, schedEta - correctionSec);
}

/**
 * Sanity-check a Tier-1 GTFS-RT arrival against the vehicle's physical position.
 * Returns false only when the reported arrival is implausibly soon given the
 * arc-distance to the stop. Caller should fall back to calcEta in that case.
 * Returns true (trust feed) whenever required data is missing.
 */
function gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now) {
    if (!cache.arcMeters || !marker.lastSnap) return true;
    const stopArc    = cache.arcMeters[targetIdx];
    const vehicleArc = marker.lastSnap.arcMeters;
    if (stopArc == null || vehicleArc == null) return true;

    const distMeters = stopArc - vehicleArc;
    if (distMeters <= 0) return true;     // vehicle past stop / loop turnaround

    const MAX_SPEED_MPS = 30;             // ~108 km/h, generous upper bound
    const GRACE_S       = 45;             // dwell + sensor lag + arc snap noise
    const minPlausible  = distMeters / MAX_SPEED_MPS;
    const reported      = gtfsEntry.arrivalUnix - now;

    return reported >= minPlausible - GRACE_S;
}

/**
 * Schedule dead-reckoning ETA (Tier 3 / original logic).
 * Returns unix seconds or null.
 */
function computeScheduleEta(marker, cache, nextIdx, targetIdx, isStoppedAt, now) {
    const { statusChangedAt } = marker.properties;

    if (nextIdx === targetIdx) {
        if (isStoppedAt) return now;
        const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
        return remaining != null ? now + remaining : now;
    }

    const gap = cache.times[targetIdx] - cache.times[nextIdx];
    if (gap < 0) return null;
    if (isStoppedAt) return now + Math.max(0, gap);

    const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
    if (remaining == null) return now + Math.max(0, gap - 30);
    return now + Math.max(0, remaining + gap);
}

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

        if (now - (marker.timestamp ?? 0) > 180) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
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

            // Schedule ETA, corrected by GPS position deviation where available
            const schedEta = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now);
            const calcEta  = schedEta != null
                ? applyGpsCorrection(schedEta, marker, cache, nextIdx, now)
                : null;

            // Tier 1 — GTFS-RT by tripId: use whichever source is sooner.
            // GPS sanity check: if reported arrival contradicts physical position
            // implausibly, fall back to calcEta instead of trusting the feed.
            const gtfsEntry = gtfsByTripId.get(trip_id);
            if (gtfsEntry) {
                let arrivalUnix;
                if (calcEta != null && !gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now)) {
                    arrivalUnix = calcEta;
                } else if (calcEta != null) {
                    arrivalUnix = Math.min(gtfsEntry.arrivalUnix, calcEta);
                } else {
                    arrivalUnix = gtfsEntry.arrivalUnix;
                }
                results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id, arrivalUnix });
                coveredTripIds.add(trip_id);
                break;
            }

            // Tier 2/3 — no GTFS-RT match: use calc
            if (calcEta == null) break;
            results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id, arrivalUnix: calcEta });
            break;
        }
    }

    // Append GTFS-only entries — trains GTFS-RT sees that our vehicle-position
    // pipeline missed (e.g. vehicles turning around at end-of-line, or IDs that
    // didn't match any active marker).
    for (const [tripId, entry] of gtfsByTripId) {
        if (coveredTripIds.has(tripId)) continue;
        if (entry.arrivalUnix <= now) continue;
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

        return interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
    }
    return null;
}

export function getTerminalStopId(routeCode, directionId) {
    const cache = routeStops[`${routeCode}|${directionId}`];
    if (!cache?.stops?.length) return null;
    for (let i = cache.stops.length - 1; i >= 0; i--) {
        if (cache.stops[i]) return cache.stops[i];
    }
    return null;
}

export function getTerminalName(routeCode, directionId) {
    const lastStopId = getTerminalStopId(routeCode, directionId);
    if (!lastStopId) return null;
    const stop = window.masterStopsData?.[String(lastStopId)];
    return stop?.name ? cleanStationName(stop.name) : null;
}

// Returns true if any of the given stop IDs is the first stop of routeCode|dir.
export function isOriginStop(stopIds, routeCode, dir) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    return stopIds.some(sid => findIdx(cache.stops, sid) === 0);
}

// Returns true if any of the given stop IDs is the last stop of routeCode|dir.
export function isTerminalStop(stopIds, routeCode, dir) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    const lastIdx = cache.stops.length - 1;
    return stopIds.some(sid => findIdx(cache.stops, sid) === lastIdx);
}

// Returns vehicles that are STOPPED_AT the origin terminus for any of the given stop IDs.
export function getBoardingVehicles(stopIds) {
    const now = Math.floor(Date.now() / 1000);
    const results = [];
    const seen = new Set();

    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;
        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;
        if (now - (marker.timestamp ?? 0) > 180) continue;

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

            const key = `${vehicle_id}-${route_code}-${dir}`;
            if (!seen.has(key)) {
                seen.add(key);
                results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id });
            }
            break;
        }
    }
    return results;
}
