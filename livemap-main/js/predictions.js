import { markers } from './markers.js';
import { planarMeters, snapToRoute, stationArc, shapeData } from './snap.js';
import { isUnscheduledTrip } from './tripUpdates.js';

const AVG_RAIL_SPEED_MPS = 12; // ~26 mph
const AVG_BUS_SPEED_MPS = 8;  // ~18 mph
const STATION_DWELL_PENALTY_SEC = 25;  // added per intermediate stop
const AUDIT_TOLERANCE_SEC = 240;       // 4 mins: blended must beat GTFS-RT by this to override
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

// Confidence-weighted blend between geometric (near) and timetable (far).
// Below BLEND_DIST_MIN_M → 100% geometric; above BLEND_DIST_MAX_M → 100% timetable.
const BLEND_DIST_MIN_M = 1000;
const BLEND_DIST_MAX_M = 3000;

// If the computed schedule delay exceeds this, the schedule is blown (short-turn,
// express, intervention) and propagating the delay forward is a statistical fallacy.
// Force blendW=0 (pure geometric + GTFS-RT) when |delay| exceeds this threshold.
const MAX_VALID_DELAY_SEC = 1800; // 30 minutes

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

// ── Timetable helpers ─────────────────────────────────────────────────────────

/**
 * Find the pair of adjacent trip stops (i, j) whose arc positions bracket
 * vehicleArcMeters, stepping through trip._arcs[] from stop 0 to stop N-1.
 *
 * Handles both direction_id=0 (arcs increasing) and direction_id=1 (decreasing).
 * Skips consecutive pairs where either arc or scheduled time is null.
 *
 * Returns { i, j, frac } where frac ∈ [0,1] linearly interpolates between them,
 * or null if no valid bracket exists (vehicle off-route, cold-start, all nulls).
 */
function findScheduleBracket(trip, vehicleArcMeters) {
    const arcs  = trip._arcs;
    const times = trip.scheduledTimes;
    if (!arcs || !times) return null;

    let prev = null; // { i, arc }
    for (let j = 0; j < arcs.length; j++) {
        const arc  = arcs[j];
        const time = times[j];
        if (arc == null || time == null) {
            prev = null; // gap breaks continuity — reset
            continue;
        }
        if (prev !== null) {
            const lo = Math.min(prev.arc, arc);
            const hi = Math.max(prev.arc, arc);
            if (lo <= vehicleArcMeters && vehicleArcMeters <= hi) {
                const span = arc - prev.arc;
                const frac = span !== 0
                    ? Math.max(0, Math.min(1, (vehicleArcMeters - prev.arc) / span))
                    : 0;
                return { i: prev.i, j, frac };
            }
        }
        prev = { i: j, arc };
    }
    return null;
}

/**
 * Compute a timetable-based ETA for a vehicle at targetStopIndex.
 *
 * Algorithm (stateless, per-tick):
 *   1. Find where on the schedule the vehicle currently sits (arc interpolation).
 *   2. T_sched = scheduled time at that arc position.
 *   3. delay = now − T_sched  (positive = late, negative = early).
 *   4. ETA = scheduled_time(target) + delay.
 *
 * Returns null when timetable data is unavailable or the vehicle is off-route.
 */
function computeTimetableEta(trip, targetStopIndex, vehicleArcMeters, now) {
    if (!trip._arcs || !trip.scheduledTimes) return null;
    const targetSec = trip.scheduledTimes[targetStopIndex];
    if (targetSec == null) return null;

    const bracket = findScheduleBracket(trip, vehicleArcMeters);
    if (!bracket) return null;

    const { i, j, frac } = bracket;
    const timeI = trip.scheduledTimes[i];
    const timeJ = trip.scheduledTimes[j];
    if (timeI == null || timeJ == null) return null;

    // Interpolated scheduled time (seconds since local midnight) at the vehicle's position.
    const tSchedAtVehicle = timeI + frac * (timeJ - timeI);

    // Anchor to LA (Pacific) midnight — GTFS schedule times are always in Pacific time.
    // Using browser local time would silently corrupt the delay calculation for any
    // user outside the Pacific timezone.
    const laParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(now * 1000));
    const laSecondsOfDay = Number(laParts.find(p => p.type === 'hour').value)   * 3600
                         + Number(laParts.find(p => p.type === 'minute').value) * 60
                         + Number(laParts.find(p => p.type === 'second').value);
    let baseUnix = now - laSecondsOfDay;
    const nowSecOfDay = laSecondsOfDay;

    // Midnight-wrap: if the scheduled time belongs to an adjacent calendar day,
    // shift the base so delay arithmetic lands on the correct day.
    if (tSchedAtVehicle - nowSecOfDay > 12 * 3600) {
        baseUnix -= 86400; // schedule is from "yesterday" (we crossed midnight)
    } else if (nowSecOfDay - tSchedAtVehicle > 12 * 3600) {
        baseUnix += 86400; // schedule extends past midnight into "tomorrow"
    }

    const delay = now - (baseUnix + tSchedAtVehicle);

    // If the vehicle is running >30 min off-schedule, the timetable is blown.
    // Dispatchers may short-turn, run express, or pull the vehicle — projecting
    // a static delay forward across all downstream stops becomes unreliable.
    if (Math.abs(delay) > MAX_VALID_DELAY_SEC) return null;

    return Math.round(baseUnix + targetSec + delay);
}

/**
 * Blend geometric and timetable ETAs based on how far the vehicle is from
 * the target stop:
 *   < BLEND_DIST_MIN_M  → 100% geometric (live momentum is ground truth)
 *   > BLEND_DIST_MAX_M  → 100% timetable (schedule absorbs systemic delays)
 *   in between          → linear interpolation
 *
 * Returns { blended, weight } where weight is the timetable fraction (0–1).
 */
function blendEtas(geometricEtaUnix, timetableEtaUnix, distanceMeters) {
    const w = Math.max(0, Math.min(1,
        (distanceMeters - BLEND_DIST_MIN_M) / (BLEND_DIST_MAX_M - BLEND_DIST_MIN_M)
    ));
    return {
        blended: Math.round((1 - w) * geometricEtaUnix + w * timetableEtaUnix),
        weight: w,
    };
}

// ── Stop ID normalization (Landmine 2) ───────────────────────────────────────
// GTFS-RT may report parent station IDs (e.g., "80201") while trips.json uses
// child platform IDs (e.g., "80201_N"), or vice versa. indexOf() silently
// returns -1 on mismatch, defeating the Next Stop primary path entirely.
function findStopIdx(trip, rawStopId) {
    const exact = trip.stops.indexOf(rawStopId);
    if (exact !== -1) return exact;
    // Try stripping a trailing directional/platform suffix from the GTFS-RT ID.
    const base = rawStopId.replace(/[_-][A-Za-z0-9]+$/, '');
    if (base !== rawStopId) {
        const baseIdx = trip.stops.indexOf(base);
        if (baseIdx !== -1) return baseIdx;
    }
    // Or the inverse: trips.json uses suffixed IDs, GTFS-RT uses the base.
    return trip.stops.findIndex(s =>
        s.startsWith(rawStopId + '_') || s.startsWith(rawStopId + '-')
    );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an array of predicted arrivals for a given stopId.
 * Fuses Metro's GTFS-RT TripUpdates with a tri-source prediction engine:
 *
 * Source A — Geometric ETA (near-field, <1 km):
 *   arc-distance / smoothed-speed + per-stop dwell penalty.
 *   Ground truth when a vehicle is close and moving at known speed.
 *
 * Source B — Timetable ETA (far-field, >3 km):
 *   Stateless continuous-variance model: snap vehicle to polyline,
 *   interpolate where on the static schedule that arc position falls,
 *   derive current delay, project to target stop's scheduled time.
 *   Absorbs systemic delays (dwell, signal holds) that geometry misses.
 *
 * Sources A+B are blended linearly across a 1–3 km transition window.
 *
 * Source C — GTFS-RT Auditor (always):
 *   Metro's TripUpdates feed is the authoritative baseline. The blended
 *   estimate overrides it only when it is EARLIER by > AUDIT_TOLERANCE_SEC
 *   (Metro's feed is lagging) or the feed prediction is already in the past.
 *   Ghost Arrivals (on-map vehicles absent from the feed) always use blended.
 */
export function getHybridArrivals(stopId) {
    const now = Math.floor(Date.now() / 1000);
    bumpTickIfNeeded(now);

    // LA Pacific midnight, computed once per call (shared across all vehicles in this tick).
    const laParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(now * 1000));
    const laSecondsOfDay = Number(laParts.find(p => p.type === 'hour').value)   * 3600
                         + Number(laParts.find(p => p.type === 'minute').value) * 60
                         + Number(laParts.find(p => p.type === 'second').value);
    const baseUnix = now - laSecondsOfDay;

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
        if (targetStopIndex === -1) continue;

        const trainCoords = marker.getLngLat();
        const isBus = ['901', '910', '950'].includes(route_code);

        // ── Next Stop ID from GTFS-RT VehiclePositions ───────────────────────────
        // The agency's feed already knows which stop each vehicle is at or heading to.
        // Use this directly instead of re-deriving position from GPS snap + arc math.
        const reportedStopId = String(marker.properties.stopId ?? '');
        const currentStopIdx = reportedStopId ? findStopIdx(trip, reportedStopId) : -1;

        // ── Has-passed check ─────────────────────────────────────────────────────
        let hasPassed = false;
        if (currentStopIdx !== -1) {
            // Primary: stop index is unambiguous — no GPS snap or arc math needed.
            hasPassed = targetStopIndex < currentStopIdx;
        } else if (shapeData[route_code]?.length) {
            // Fallback when Next Stop ID not found in trips.json: arc-based direction.
            const sEntry = stationArc.get(`${route_code}|${stopId}`);
            const vSnap  = snapVehicleCached(vehicleId, route_code, trainCoords.lng, trainCoords.lat);
            if (sEntry && vSnap && trip._arcs) {
                let firstArc = null, lastArc = null;
                for (const a of trip._arcs) { if (a != null) { firstArc = a; break; } }
                for (let k = trip._arcs.length - 1; k >= 0; k--) { if (trip._arcs[k] != null) { lastArc = trip._arcs[k]; break; } }
                if (firstArc !== null && lastArc !== null && firstArc !== lastArc) {
                    const incArc = firstArc < lastArc;
                    hasPassed = incArc
                        ? vSnap.arcMeters > sEntry.arcMeters + 300
                        : vSnap.arcMeters < sEntry.arcMeters - 300;
                }
            }
        }
        if (hasPassed) continue;

        // ── ETA Computation ──────────────────────────────────────────────────────
        let timetableEta = null;
        let rawGeometric = null;
        let blendW       = 0;

        const hasSchedule = !!trip.scheduledTimes && !isUnscheduledTrip(trip_id);

        // Primary: Metro Bridge — schedule gap anchored to Metro's own arrival prediction.
        // ETA = anchorUnix + (scheduledTimes[target] − scheduledTimes[current]).
        //
        // anchorUnix = Metro's GTFS-RT arrival time at currentStopIdx (the next stop).
        // For IN_TRANSIT_TO vehicles this accounts for remaining travel time to that stop.
        // Falls back to `now` when Metro has no prediction (ghost train at current stop).
        if (currentStopIdx !== -1 && hasSchedule) {
            const currentSchedSec = trip.scheduledTimes[currentStopIdx];
            const targetSchedSec  = trip.scheduledTimes[targetStopIndex];
            if (currentSchedSec != null && targetSchedSec != null) {
                const currentStopId = trip.stops[currentStopIdx];
                const arrivalsAtCurrentStop = window.masterArrivalsData?.get(String(currentStopId));
                const feedAtCurrent = arrivalsAtCurrentStop?.find(a => String(a.vehicleId) === vehicleId);
                // Use Metro's future-looking anchor; if feed is stale/absent, fall back to now.
                const anchorUnix = feedAtCurrent && feedAtCurrent.arrivalUnix > now
                    ? feedAtCurrent.arrivalUnix
                    : now;
                const delay = anchorUnix - (baseUnix + currentSchedSec);
                if (Math.abs(delay) <= MAX_VALID_DELAY_SEC) {
                    timetableEta = Math.round(anchorUnix + (targetSchedSec - currentSchedSec));
                    blendW = 1;
                }
            }
        }

        // Fallback: GPS arc position + schedule bracket (Next Stop ID unavailable).
        if (timetableEta === null && hasSchedule && trip._arcs && shapeData[route_code]?.length) {
            const vSnap = snapVehicleCached(vehicleId, route_code, trainCoords.lng, trainCoords.lat);
            if (vSnap) {
                timetableEta = computeTimetableEta(trip, targetStopIndex, vSnap.arcMeters, now);
                if (timetableEta !== null) blendW = 1;
            }
        }

        if (timetableEta === null) {
            // Geometric fallback: planar distance / avg speed.
            const smoothed = smoothedSpeed(vehicleId, speed);
            const activeSpeed = (smoothed != null && smoothed >= SPEED_MIN_VALID)
                ? Math.max(smoothed, isBus ? 3 : 4)
                : (isBus ? AVG_BUS_SPEED_MPS : AVG_RAIL_SPEED_MPS);
            const planarDist = planarMeters(
                trainCoords.lat, trainCoords.lng,
                targetStation.lat, targetStation.lon
            );
            rawGeometric = now + Math.round(planarDist * (isBus ? BUS_CURVATURE_FACTOR : 1.2) / activeSpeed);
        }

        const rawEta = timetableEta ?? rawGeometric;
        const blendedEtaUnix = smoothEta(vehicleId, stopId, rawEta, now);

        // ── Merge ────────────────────────────────────────────────────────────────
        const baseArrival = baseByVehicle.get(vehicleId);

        if (baseArrival) {
            const diff = Math.abs(baseArrival.arrivalUnix - blendedEtaUnix);
            // Override GTFS-RT only when:
            //   (a) GTFS-RT prediction is already in the past (stale feed), OR
            //   (b) Blended is EARLIER than GTFS-RT by > AUDIT_TOLERANCE_SEC
            //       (Metro's feed is lagging behind the train's real position).
            // Never override when blended is later — the agency's real-time feed
            // is still more reliable as a conservative baseline.
            const stale = baseArrival.arrivalUnix < now;
            const blendedIsEarlier = blendedEtaUnix < baseArrival.arrivalUnix;
            if (stale || (diff > AUDIT_TOLERANCE_SEC && blendedIsEarlier)) {
                hybridArrivals.push({
                    ...baseArrival,
                    arrivalUnix: enforceMonotonicity(vehicleId, targetStopIndex, blendedEtaUnix),
                    isLiveEstimate: true,
                    _dbgGtfsRt:    baseArrival.arrivalUnix,
                    _dbgGeometric: rawGeometric,
                    _dbgTimetable: timetableEta,
                    _dbgBlendW:    blendW,
                });
            } else {
                hybridArrivals.push({
                    ...baseArrival,
                    arrivalUnix: enforceMonotonicity(vehicleId, targetStopIndex, baseArrival.arrivalUnix),
                    isLiveEstimate: false,
                    _dbgGtfsRt:    baseArrival.arrivalUnix,
                    _dbgGeometric: rawGeometric,
                    _dbgTimetable: timetableEta,
                    _dbgBlendW:    blendW,
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
                arrivalUnix: enforceMonotonicity(vehicleId, targetStopIndex, blendedEtaUnix),
                isLiveEstimate: true,
                _dbgGtfsRt:    null,
                _dbgGeometric: rawGeometric,
                _dbgTimetable: timetableEta,
                _dbgBlendW:    blendW,
            });
        }
    }

    // Append base arrivals for vehicles not seen on the live map.
    baseByVehicle.forEach(arrival => {
        hybridArrivals.push({
            ...arrival,
            isLiveEstimate: false,
            _dbgGtfsRt:    arrival.arrivalUnix,
            _dbgGeometric: null,
            _dbgTimetable: null,
            _dbgBlendW:    0,
        });
    });

    hybridArrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Periodic GC — every ~30 s of map usage. Skip tick 0 (nothing to prune yet).
    if (currentTickId > 0 && currentTickId % 30 === 0) prune(now);

    return hybridArrivals;
}
