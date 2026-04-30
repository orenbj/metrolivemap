import { markers } from './markers.js';
import { planarMeters, snapToRoute, stationArc, shapeData } from './snap.js';

const AVG_RAIL_SPEED_MPS = 12; // ~26 mph
const AVG_BUS_SPEED_MPS = 8;  // ~18 mph
const STATION_DWELL_PENALTY_SEC = 25;  // added per intermediate stop
const AUDIT_TOLERANCE_SEC = 240;       // 4 mins: geometric must beat GTFS-RT by this to override
const BUS_CURVATURE_FACTOR = 1.3;      // planar fallback for routes with no shape coverage
const ARC_SANITY_RATIO = 4;            // if arcDist > planar × this, snap landed on wrong segment

// EMA coefficients. α=0.3 follows the standard "trailing 3-tick" smoothing —
// stable enough to suppress ±1m flicker, responsive enough to track real changes.
const SPEED_EMA_ALPHA = 0.3;
const ETA_EMA_ALPHA   = 0.3;
const ETA_EMA_MAX_AGE_SEC   = 30;   // cold-start if last sample is older than this
const ETA_EMA_NEAR_SEC      = 120;  // skip ETA EMA entirely within 2 min — precision > smoothness
const ETA_EMA_PRUNE_AGE_SEC = 120;  // garbage-collect entries older than this
const SPEED_MIN_VALID = 1;   // m/s — below this is GPS idle noise
const SPEED_MAX_VALID = 35;  // m/s — above this is a GPS spike (~78 mph)

// Per-vehicle smoothed speed. { ema: number, lastSeenSec: number }
const vehicleSpeedEma = new Map();

// Per-vehicle snap result, valid for one tick so a multi-stop station group
// shares a single snap per vehicle instead of recomputing N times.
// { tickId, arcMeters, routeCode }
const vehicleSnapCache = new Map();

// Per-(vehicle, stop) smoothed ETA. Suppresses the pill jumping between e.g.
// 4m and ~4m on consecutive GPS updates. { etaUnix, lastSeenSec }
const etaEma = new Map();

// Per-vehicle, per-tick ETA cache for monotonicity enforcement.
// Ensures a stop further along the route never shows an earlier arrival than
// a stop the same vehicle will reach first.
// Key: vehicleId, Value: { tickId, stops: Map<stopIndex, etaUnix> }
const vehicleTickEtas = new Map();
const MIN_INTER_STOP_SEC = 30; // conservative floor — prevents inversions without distorting correct ETAs

// Monotonic tick id, bumped at most once per wall-clock second.
let currentTickId = 0;
let lastTickWallSec = 0;

function bumpTickIfNeeded(nowSec) {
    if (nowSec !== lastTickWallSec) {
        currentTickId++;
        lastTickWallSec = nowSec;
    }
}

function smoothedSpeed(vehicleId, rawSpeed) {
    const v = Number(rawSpeed);
    const prev = vehicleSpeedEma.get(vehicleId);
    if (Number.isFinite(v) && v >= SPEED_MIN_VALID && v <= SPEED_MAX_VALID) {
        const prevEma = prev?.ema ?? null;
        const next = prevEma == null ? v : SPEED_EMA_ALPHA * v + (1 - SPEED_EMA_ALPHA) * prevEma;
        vehicleSpeedEma.set(vehicleId, { ema: next, lastSeenSec: lastTickWallSec });
        return next;
    }
    // Speed sample invalid — return previous EMA without updating it.
    return prev != null ? prev.ema : null;
}

function snapVehicleCached(vehicleId, routeCode, lng, lat) {
    const cached = vehicleSnapCache.get(vehicleId);
    if (cached && cached.tickId === currentTickId && cached.routeCode === routeCode) {
        return cached;
    }
    const snap = snapToRoute(routeCode, lng, lat);
    if (!snap) return null;
    const entry = { tickId: currentTickId, arcMeters: snap.arcMeters, routeCode };
    vehicleSnapCache.set(vehicleId, entry);
    return entry;
}

function smoothEta(vehicleId, stopId, rawEtaUnix, nowSec) {
    const key = `${vehicleId}|${stopId}`;
    const secAway = rawEtaUnix - nowSec;

    // Within 2 minutes precision matters more than flicker suppression.
    // EMA would only smooth us away from the true imminent arrival.
    if (secAway < ETA_EMA_NEAR_SEC) {
        etaEma.set(key, { etaUnix: rawEtaUnix, lastSeenSec: nowSec });
        return Math.round(rawEtaUnix);
    }

    const prev = etaEma.get(key);
    let smoothed;
    if (prev && nowSec - prev.lastSeenSec <= ETA_EMA_MAX_AGE_SEC) {
        smoothed = ETA_EMA_ALPHA * rawEtaUnix + (1 - ETA_EMA_ALPHA) * prev.etaUnix;
    } else {
        smoothed = rawEtaUnix; // cold start — never carry stale history across long gaps
    }
    etaEma.set(key, { etaUnix: smoothed, lastSeenSec: nowSec });
    return Math.round(smoothed);
}

function enforceMonotonicity(vehicleId, stopIndex, etaUnix) {
    let entry = vehicleTickEtas.get(vehicleId);
    if (!entry || entry.tickId !== currentTickId) {
        entry = { tickId: currentTickId, stops: new Map() };
        vehicleTickEtas.set(vehicleId, entry);
    }
    let floor = -Infinity;
    for (const [idx, eta] of entry.stops) {
        if (idx < stopIndex) {
            floor = Math.max(floor, eta + (stopIndex - idx) * MIN_INTER_STOP_SEC);
        }
    }
    const result = floor > -Infinity ? Math.max(etaUnix, floor) : etaUnix;
    entry.stops.set(stopIndex, result);
    return result;
}

function prune(nowSec) {
    for (const [key, val] of etaEma) {
        if (nowSec - val.lastSeenSec > ETA_EMA_PRUNE_AGE_SEC) etaEma.delete(key);
    }
    // vehicleSpeedEma grows forever without this — vehicles that left service
    // would otherwise accumulate stale entries and corrupt reused IDs.
    for (const [key, val] of vehicleSpeedEma) {
        if (nowSec - val.lastSeenSec > ETA_EMA_PRUNE_AGE_SEC) vehicleSpeedEma.delete(key);
    }
    // vehicleSnapCache entries from old ticks are harmless but tidy up anyway.
    for (const [key, val] of vehicleSnapCache) {
        if (currentTickId - val.tickId > 60) vehicleSnapCache.delete(key);
    }
    for (const [key, val] of vehicleTickEtas) {
        if (currentTickId - val.tickId > 2) vehicleTickEtas.delete(key);
    }
}

/**
 * Returns an array of predicted arrivals for a given stopId.
 * Fuses Metro's GTFS-RT TripUpdates with our live geometric GPS tracking.
 *
 * Geometric ETA path:
 *   1. Snap the vehicle to its route's polyline (cached per tick).
 *   2. Look up the station's pre-computed arc position on the same polyline.
 *   3. distanceMeters = |stationArc − vehicleArc| (true along-track meters).
 *      Sanity-checked against 4× planar distance; falls back to planar if bad snap.
 *   4. ETA = distanceMeters / smoothed-speed + intermediate-stop dwell penalty.
 *   5. EMA-smooth the ETA (skipped within 2 min to protect near-arrival accuracy).
 *
 * Routes without shape coverage (currently only 950) fall back to
 * planar distance × BUS_CURVATURE_FACTOR.
 *
 * GTFS-RT override rule: geometric replaces the agency feed only when it
 * gives an EARLIER arrival (Metro is lagging) by > AUDIT_TOLERANCE_SEC, or
 * when the GTFS-RT prediction is already in the past. Ghost Arrivals (vehicles
 * on the map but absent from the feed) always use the geometric estimate.
 */
export function getHybridArrivals(stopId) {
    const now = Math.floor(Date.now() / 1000);
    bumpTickIfNeeded(now);

    const baseArrivals = window.masterArrivalsData?.get(String(stopId)) || [];
    const hybridArrivals = [];
    const targetStation = window.masterStopsData?.[String(stopId)];

    if (!targetStation) return baseArrivals;

    // Index baseline arrivals by vehicleId for O(1) audit lookups.
    const baseByVehicle = new Map();
    baseArrivals.forEach(a => baseByVehicle.set(String(a.vehicleId), a));

    for (const markerKey in markers) {
        const marker = markers[markerKey];
        const { route_code, trip_id, speed } = marker.properties;
        const vehicleId = String(marker.properties.vehicle_id);

        if (!trip_id || marker.properties.agency === 'metrolink') continue;

        const trip = window.masterTripsData?.[trip_id];
        if (!trip) continue;

        const targetStopIndex = trip.stops.indexOf(String(stopId));

        // Locate the vehicle's current position in the trip by matching the reported
        // stopId (the next/current stop per GTFS-RT) against trip.stops[].
        // This is more reliable than using currentStopSequence, whose values come
        // from GTFS stop_sequence which is not guaranteed to be consecutive — using
        // stopSequence-1 as an array index silently breaks when sequences have gaps.
        const reportedStopId = String(marker.properties.stopId ?? '');
        const stopIdIndex = reportedStopId ? trip.stops.indexOf(reportedStopId) : -1;
        const currentSequenceIndex = stopIdIndex >= 0 ? stopIdIndex : 0;

        // Skip stops not on this trip, or where the train has already passed.
        if (targetStopIndex === -1 || targetStopIndex < currentSequenceIndex) continue;

        const trainCoords = marker.getLngLat();
        // isBus is still used for speed floor and planar fallback curvature factor.
        // It is no longer used to block arc-distance — buses on routes 901/910 have
        // shape data loaded and benefit from the same geometry path as rail.
        const isBus = ['901', '910', '950'].includes(route_code);

        // ── Distance ─────────────────────────────────────────────────────────────
        let distanceMeters;
        const planarDist = planarMeters(
            trainCoords.lat, trainCoords.lng,
            targetStation.lat, targetStation.lon
        );

        if (shapeData[route_code]?.length) {
            const stationEntry = stationArc.get(`${route_code}|${stopId}`);
            const vSnap = snapVehicleCached(vehicleId, route_code, trainCoords.lng, trainCoords.lat);
            if (stationEntry && vSnap) {
                const arcDistRaw = Math.abs(stationEntry.arcMeters - vSnap.arcMeters);
                // Sanity check: if the snap landed on a coincidentally nearby segment
                // on the far end of the route, arc distance will be >> planar. Fall
                // back to planar + curvature factor in that case.
                const curvature = isBus ? BUS_CURVATURE_FACTOR : 1.2;
                distanceMeters = arcDistRaw <= planarDist * ARC_SANITY_RATIO
                    ? arcDistRaw
                    : planarDist * curvature;
            } else {
                // Station not pre-snapped (off-route stop) or snap failed.
                distanceMeters = planarDist * (isBus ? BUS_CURVATURE_FACTOR : 1.2);
            }
        } else {
            // No shape data for this route (e.g., route 950).
            distanceMeters = planarDist * BUS_CURVATURE_FACTOR;
        }

        // ── Speed ────────────────────────────────────────────────────────────────
        const smoothed = smoothedSpeed(vehicleId, speed);
        const activeSpeed = (smoothed != null && smoothed >= SPEED_MIN_VALID)
            ? Math.max(smoothed, isBus ? 3 : 4)  // floor prevents div-by-tiny when crawling
            : (isBus ? AVG_BUS_SPEED_MPS : AVG_RAIL_SPEED_MPS);

        const timeSeconds = Math.round(distanceMeters / activeSpeed);

        const intermediateStops = targetStopIndex - currentSequenceIndex;
        const dwellPenalty = intermediateStops > 0
            ? intermediateStops * STATION_DWELL_PENALTY_SEC
            : 0;

        const rawEtaUnix = now + timeSeconds + dwellPenalty;
        const geometricEtaUnix = smoothEta(vehicleId, stopId, rawEtaUnix, now);

        // ── Merge ────────────────────────────────────────────────────────────────
        const baseArrival = baseByVehicle.get(vehicleId);

        if (baseArrival) {
            const diff = Math.abs(baseArrival.arrivalUnix - geometricEtaUnix);
            // Override GTFS-RT only when:
            //   (a) GTFS-RT prediction is already in the past (stale feed), OR
            //   (b) Geometric is EARLIER than GTFS-RT by > AUDIT_TOLERANCE_SEC
            //       (Metro's feed is lagging behind the train's real position).
            // Never override when geometric is later — that means our speed/distance
            // estimate is noisy and the agency's real-time feed is more reliable.
            const stale = baseArrival.arrivalUnix < now;
            const geometricIsEarlier = geometricEtaUnix < baseArrival.arrivalUnix;
            if (stale || (diff > AUDIT_TOLERANCE_SEC && geometricIsEarlier)) {
                hybridArrivals.push({
                    ...baseArrival,
                    arrivalUnix: enforceMonotonicity(vehicleId, targetStopIndex, geometricEtaUnix),
                    isLiveEstimate: true,
                });
            } else {
                hybridArrivals.push({
                    ...baseArrival,
                    arrivalUnix: enforceMonotonicity(vehicleId, targetStopIndex, baseArrival.arrivalUnix),
                    isLiveEstimate: false,
                });
            }
            baseByVehicle.delete(vehicleId);
        } else {
            // Ghost Arrival — vehicle is on the map but Metro's feed missed it.
            hybridArrivals.push({
                routeId:     route_code,
                directionId: trip.dir,
                vehicleId:   vehicleId,
                tripId:      trip_id,
                arrivalUnix: enforceMonotonicity(vehicleId, targetStopIndex, geometricEtaUnix),
                isLiveEstimate: true,
            });
        }
    }

    // Append base arrivals for vehicles not seen on the live map.
    baseByVehicle.forEach(arrival => {
        hybridArrivals.push({ ...arrival, isLiveEstimate: false });
    });

    hybridArrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Periodic GC — every ~30 s of map usage. Skip tick 0 (nothing to prune yet).
    if (currentTickId > 0 && currentTickId % 30 === 0) prune(now);

    return hybridArrivals;
}
