import { markers } from './markers.js';
import { cleanStationName } from './utils.js';

// ── Route stop sequences ──────────────────────────────────────────────────────
// Built once from masterTripsData. For each route+dir, pick the longest trip
// and store stops + cumulative schedule gap in seconds from stop[0].
// All trips on the same route have the same inter-stop gaps (geometry-driven),
// so we can compute ETAs without knowing which specific trip a vehicle is on.

const routeStops = new Map(); // "routeCode|dir" → { stops: string[], cum: number[] }

function ensureRouteStops() {
    if (routeStops.size > 0 || !window.masterTripsData) return;
    const best = new Map();
    for (const trip of Object.values(window.masterTripsData)) {
        if (!trip.rc || trip.dir == null || !trip.stops?.length || !trip.scheduledTimes?.length) continue;
        const key = `${trip.rc}|${trip.dir}`;
        const ex = best.get(key);
        if (!ex || trip.stops.length > ex.stops.length) best.set(key, trip);
    }
    for (const [key, trip] of best) {
        const cum = [0];
        for (let i = 1; i < trip.stops.length; i++) {
            cum.push(cum[i - 1] + Math.max(0, (trip.scheduledTimes[i] ?? 0) - (trip.scheduledTimes[i - 1] ?? 0)));
        }
        routeStops.set(key, { stops: trip.stops.map(String), cum });
    }
}

// ── Stop index lookup with suffix normalisation ───────────────────────────────
function findIdx(stops, rawId) {
    const exact = stops.indexOf(rawId);
    if (exact !== -1) return exact;
    const base = rawId.replace(/[_-][A-Za-z0-9]+$/, '');
    if (base !== rawId) { const i = stops.indexOf(base); if (i !== -1) return i; }
    const stripped = rawId.replace(/[A-Za-z]+$/, '');
    if (stripped !== rawId && stripped.length > 0) { const i = stops.indexOf(stripped); if (i !== -1) return i; }
    return stops.findIndex(s =>
        s.startsWith(rawId + '_') || s.startsWith(rawId + '-') ||
        (s.startsWith(rawId) && s.length > rawId.length && /^[A-Za-z]/.test(s[rawId.length]))
    );
}

/**
 * Returns { gap: seconds, dir } if fromStop comes at or before toStop in
 * either direction's sequence for this route, otherwise null.
 * gap === 0 means the vehicle's next stop IS the target station.
 * Also implicitly guards transfer stations: a vehicle on route A will never
 * match a target stop that isn't in route A's stop sequence.
 */
function getStopGap(routeCode, fromStopId, toStopId) {
    ensureRouteStops();
    for (const dir of [0, 1]) {
        const rs = routeStops.get(`${routeCode}|${dir}`);
        if (!rs) continue;
        const fromIdx = findIdx(rs.stops, fromStopId);
        if (fromIdx === -1) continue;
        const toIdx = findIdx(rs.stops, toStopId);
        if (toIdx === -1 || toIdx < fromIdx) continue;
        return { gap: rs.cum[toIdx] - rs.cum[fromIdx], dir };
    }
    return null;
}

// ── Flip-time cache (terminus dwell before reversing) ─────────────────────────
const flipTimeCache = new Map();
function getFlipTime(routeCode, terminusStopId) {
    const key = `${routeCode}|${terminusStopId}`;
    if (flipTimeCache.has(key)) return flipTimeCache.get(key);
    const arrivals = [], departures = [];
    for (const trip of Object.values(window.masterTripsData ?? {})) {
        if (trip.rc !== routeCode) continue;
        const last = trip.stops.length - 1;
        if (trip.stops[last] === terminusStopId && trip.scheduledTimes?.[last] != null)
            arrivals.push(trip.scheduledTimes[last]);
        if (trip.stops[0] === terminusStopId && trip.scheduledTimes?.[0] != null)
            departures.push(trip.scheduledTimes[0]);
    }
    arrivals.sort((a, b) => a - b);
    departures.sort((a, b) => a - b);
    const gaps = [];
    let di = 0;
    for (const arr of arrivals) {
        while (di < departures.length && departures[di] < arr) di++;
        if (di < departures.length) gaps.push(departures[di] - arr);
    }
    if (!gaps.length) { flipTimeCache.set(key, null); return null; }
    gaps.sort((a, b) => a - b);
    const result = gaps[Math.floor(gaps.length / 2)] + 120;
    flipTimeCache.set(key, result);
    return result;
}

// ── Turnaround predictions ────────────────────────────────────────────────────
function getTurnaroundArrivals(targetId, now) {
    const arrivals = [];
    for (const markerKey in markers) {
        const marker = markers[markerKey];
        const { route_code, trip_id, vehicle_id } = marker.properties;
        const vehicleId = String(vehicle_id);
        const nextStopRaw = String(marker.properties.stopId ?? '');
        if (!nextStopRaw || !route_code) continue;

        // Vehicle is past the target if targetId comes before nextStop
        const pastResult = getStopGap(route_code, targetId, nextStopRaw);
        if (!pastResult || pastResult.gap === 0) continue;

        const rs = routeStops.get(`${route_code}|${pastResult.dir}`);
        if (!rs) continue;
        const terminusStopId = rs.stops[rs.stops.length - 1];

        const terminusArrivals = window.masterArrivalsData?.get(terminusStopId) ?? [];
        const vTerminus = terminusArrivals.find(a => String(a.vehicleId) === vehicleId);
        if (!vTerminus || vTerminus.arrivalUnix <= now - 60) continue;

        const returnResult = getStopGap(route_code, terminusStopId, targetId);
        if (!returnResult) continue;

        const flipTime = getFlipTime(route_code, terminusStopId);
        if (flipTime == null) continue;

        const etaUnix = Math.max(now, vTerminus.arrivalUnix) + flipTime + returnResult.gap;
        arrivals.push({
            vehicleId, routeId: route_code, directionId: returnResult.dir,
            tripId: trip_id, arrivalUnix: etaUnix, isLiveEstimate: true,
        });
    }
    return arrivals;
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * Returns predicted arrivals for a given stopId.
 *
 * For each live vehicle, uses getStopGap(route, vehicleNextStop → targetStop)
 * to compute: ETA = GTFS-RT anchor at vehicleNextStop + schedule gap to target.
 * No trip_id lookup needed — gap is the same across all trips on a route.
 */
export function getHybridArrivals(stopId) {
    ensureRouteStops();
    const now = Math.floor(Date.now() / 1000);
    const targetId = String(stopId);
    const candidates = [];
    const seenVehicles = new Set();

    for (const markerKey in markers) {
        const marker = markers[markerKey];
        const { route_code, trip_id, vehicle_id } = marker.properties;
        const vehicleId = String(vehicle_id);
        if (!route_code) continue;

        const nextStopRaw = String(marker.properties.stopId ?? '');
        if (!nextStopRaw) continue;

        // getStopGap returns null if:
        //   • route doesn't serve this target stop (handles transfer station isolation)
        //   • vehicle has already passed the target
        const result = getStopGap(route_code, nextStopRaw, targetId);
        if (!result) continue;

        const anchorArrivals = window.masterArrivalsData?.get(nextStopRaw) ?? [];
        const anchorEntry = anchorArrivals.find(a => String(a.vehicleId) === vehicleId);
        const anchorTime = (anchorEntry && anchorEntry.arrivalUnix > now)
            ? anchorEntry.arrivalUnix
            : now;

        const etaUnix = anchorTime + result.gap;
        if (etaUnix < now - 60) continue;

        candidates.push({
            vehicleId, routeId: route_code, directionId: result.dir,
            tripId: trip_id, arrivalUnix: etaUnix, isLiveEstimate: true,
        });
    }

    // Sort by ETA, keep 2 soonest per direction
    candidates.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
    const dirCount = {};
    const arrivals = [];
    for (const c of candidates) {
        if ((dirCount[c.directionId] ?? 0) >= 2) continue;
        dirCount[c.directionId] = (dirCount[c.directionId] ?? 0) + 1;
        seenVehicles.add(c.vehicleId);
        arrivals.push(c);
    }

    // Turnaround: trains past target that will return after flipping at terminus
    for (const a of getTurnaroundArrivals(targetId, now)) {
        if (!seenVehicles.has(a.vehicleId)) {
            seenVehicles.add(a.vehicleId);
            arrivals.push(a);
        }
    }

    // GTFS-RT fallback for off-map vehicles
    const baseArrivals = window.masterArrivalsData?.get(targetId) ?? [];
    for (const arrival of baseArrivals) {
        if (seenVehicles.has(String(arrival.vehicleId))) continue;
        if (arrival.arrivalUnix < now - 60) continue;
        arrivals.push({ ...arrival, isLiveEstimate: false });
    }

    arrivals.sort((a, b) => a.arrivalUnix - b.arrivalUnix);
    return arrivals;
}
