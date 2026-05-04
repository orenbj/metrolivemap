import { cleanStationName, isStoppedAt, normalizeStopId } from './utils.js';
import { snapToRoute, hasShapeData } from './snap.js';
import {
    ETA_MAX_SPEED_MPS, ETA_PLAUSIBILITY_GRACE_S,
    ETA_DEPARTURE_LAG_S,
    GTFS_ENTRY_STALENESS_S, VEHICLE_MARKER_TTL_S,
} from './config.js';

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
export function interStopRemainingSeconds(statusChangedAt, now, times, idx) {
    if (statusChangedAt == null || idx <= 0) return null;
    const interStopGap = times[idx] - times[idx - 1];
    if (interStopGap <= 0) return null;
    const timeInTransit = Math.min((now - statusChangedAt) + ETA_DEPARTURE_LAG_S, interStopGap);
    return Math.max(0, interStopGap - timeInTransit);
}

/**
 * Measure how many seconds this vehicle is running ahead (negative) or behind
 * (positive) its timetable based on GPS arc position vs. the scheduled position
 * in the current inter-stop segment.
 *
 * Returns the vehicle's schedule adherence offset in seconds (positive = late,
 * negative = early). Uncapped so a train running 5+ min late shows that delay
 * at every downstream stop. Returns 0 when required data is absent.
 */
function computeTripAdherenceOffset(marker, cache, nextIdx, now) {
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

    const timeInTransit    = Math.min((now - statusChangedAt) + ETA_DEPARTURE_LAG_S, interStopGap);
    const schedExpectedArc = prevArc + (timeInTransit / interStopGap) * interStopDist;

    // Positive arcDelta = vehicle ahead; convert to time and negate for offset sign.
    // Cap at ±interStopGap so the correction never exceeds one full segment.
    const arcDelta   = snapArc - schedExpectedArc;
    const schedSpeed = interStopDist / interStopGap;
    const raw = -(arcDelta / schedSpeed);
    return Math.max(-interStopGap, Math.min(interStopGap, raw));
}

/**
 * Sanity-check a Tier-1 GTFS-RT arrival against the vehicle's physical position.
 * Returns false only when the reported arrival is implausibly soon given the
 * arc-distance to the stop. Caller should fall back to calcEta in that case.
 * Returns true (trust feed) whenever required data is missing.
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
    if (remaining == null) return now + Math.max(0, gap - ETA_DEPARTURE_LAG_S);
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

            const schedEta = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now);
            const calcEta  = schedEta != null
                ? Math.max(now, schedEta + adherenceOffset)
                : null;

            // Tier 1 — GTFS-RT by tripId: use whichever source is sooner.
            // GPS sanity check: if reported arrival contradicts physical position
            // implausibly, fall back to calcEta instead of trusting the feed.
            // Staleness gate (L-2): if the entry hasn't been refreshed within
            // GTFS_ENTRY_STALENESS_S, skip the blend and rely on calcEta only.
            const gtfsEntry = gtfsByTripId.get(trip_id);
            if (gtfsEntry) {
                const gtfsStale = now - (gtfsEntry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S;
                let arrivalUnix;
                if (gtfsStale) {
                    arrivalUnix = calcEta;
                } else if (calcEta != null && !gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now)) {
                    arrivalUnix = calcEta;
                } else if (calcEta != null) {
                    arrivalUnix = Math.min(gtfsEntry.arrivalUnix, calcEta);
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

            // Tier 2/3 — no GTFS-RT match: use calc
            if (calcEta == null) break;
            results.push({ routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id, arrivalUnix: calcEta });
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

        const raw = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
        if (raw == null) return null;
        const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
        return Math.max(0, raw + adherenceOffset);
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
