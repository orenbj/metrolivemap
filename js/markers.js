import {
    FRESH_EXPIRE_S, FRESH_CHECK_INTERVAL_MS, SPIKE_BYPASS_S,
    MAX_PLAUSIBLE_SPEED_MPS, GPS_NOISE_FLOOR_DEG, STATIONARY_SPEED_MPS,
    GPS_SPIKE_STOP_RADIUS_M, GPS_SPIKE_MIN_DIST_M, TERMINUS_TURNAROUND_RADIUS_M,
    TERMINUS_LINGER_S, TERMINUS_FADE_MS,
    FINAL_STOP_HOLD_M, RAIL_SNAP_MAX_M, HEAVY_RAIL_SNAP_MAX_M, BUS_SNAP_MAX_M, HEAVY_RAIL_STOPPED_AT_MAX_M,
    STOPPED_AT_MISFIRE_SPEED_MPS, STOPPED_AT_MISFIRE_AGE_S, STOPPED_AT_MISFIRE_ARC_DELTA_M,
    DR_SPEED_FACTOR, RAIL_MAX_SPEED_MPS,
    RAIL_ARC_SPIKE_NOISE_M, DR_MAX_SECONDS, DR_MAX_SECONDS_RAIL, DOWNSTREAM_MIN_METERS,
    DR_SPEED_ALPHA, DR_SPEED_GLIDE_TAU_S, DR_DECEL_ZONE_M, DR_DECEL_RATE_MPS2, DR_HEAVY_RAIL_FALLBACK_MPS,
    COLD_START_MAX_OFFROUTE_M,
    MARKER_HARD_TTL_MS, NO_TIMESTAMP_GRACE_MS, MARKER_COUNT_CAP,
    routeHexColors,
} from './config.js';
import { getTerminalStopId, getSecondsToNextStop, getScheduledArrivals, isOriginStop, isAtOwnOriginStop, findIdx, getRouteCache, getTripStops } from './predictions.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { closeStationPopup } from './stations.js';
import { snapToRoute, hasShapeData, lngLatAtArc } from './snap.js';
import { isNearIntersection } from './intersections.js';
import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, isStoppedAt, isEffectivelyStopped, normalizeStopId, setVisibleInterval, isBusRoute, isHeavyRail } from './utils.js';
import { recordSegmentTime } from './scheduleCalibration.js';
import { recordMarkerDrop } from './feedStats.js';
import { getFreshnessTier, getFreshnessTierFromAge } from './freshness.js';
// Re-export so existing callers (and tests) can keep importing from markers.js.
export { getFreshnessTier, getFreshnessTierFromAge };

/**
 * Live vehicle markers keyed by trip_id. Also exposed as window.vehicleMarkers
 * for cross-module access without circular imports.
 * @type {Object.<string, maplibregl.Marker & { properties: Object, timestamp: number }>}
 */
export const markers = {};
window.vehicleMarkers = markers;
const animations = {};
// In-flight fade-outs. Keyed by markerKey while DOM is fading after the
// logical marker has been deleted from `markers`. Used by createNewMarker
// to cancel a pending fade and clean up the orphan DOM element when a
// fresh frame arrives mid-fade — without this, the fading old element
// coexisted with the new marker for the 1200 ms fade duration.
const _fadingMarkers = new Map();

// Vehicle motion is functional (representing real-world movement of a tracked
// bus/train), not decorative animation — `prefers-reduced-motion` is intended
// to suppress vestibular-trigger animations (parallax, modal slides, page
// transitions), not informational motion that mirrors a video's playback.
// Map zoom/pan transitions remain controlled by MapLibre and are unaffected.
//
// Keyed by "agency|routeCode|color|terminus" — bounded to ~route-count × 2 terminus combos
// (~20-40 entries in practice), so no eviction is needed for normal sessions.
const _svgUrlCache = new Map();
let _openVehiclePopups = 0;

const _TIER_OPACITY = { live: 1, aging: 1, stale: 0.5, expired: 0 };

setVisibleInterval(() => {
    if (_openVehiclePopups === 0) return;
    const now = Date.now() / 1000;
    document.querySelectorAll('.pv2-time[data-ts]').forEach(el => {
        const age = Math.max(0, Math.floor(now - Number(el.dataset.ts)));
        el.querySelector('.pv2-secs').textContent = age + 's';
        // Update popup dot tier so its color (driven by CSS [data-tier]) tracks
        // the per-vehicle age while the popup is open.
        const dot = el.querySelector('.pv2-dot');
        if (dot) dot.dataset.tier = getFreshnessTierFromAge(age);
    });
}, 1000);

// Refresh ETA in open vehicle popup every 5s — keeps it ticking when the VP feed is stale.
setVisibleInterval(() => {
    if (_openVehiclePopups === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [key, marker] of Object.entries(markers)) {
        if (marker.getPopup()?.isOpen()) {
            if ((nowSec - (marker.timestamp ?? 0)) > FRESH_EXPIRE_S) continue;
            updatePopup({ properties: marker.properties }, key);
        }
    }
}, 5000);

function bearingToStop(stopId, fromLng, fromLat) {
    if (!stopId) return null;
    const sid = String(stopId);
    // Live feed sometimes appends a directional suffix (e.g. "80228_N") not present in stops.json
    const stop = window.masterStopsData?.[sid]
               ?? window.masterStopsData?.[normalizeStopId(sid)];
    if (!stop?.lat || !stop?.lon) return null;
    if (planarMeters(fromLat, fromLng, stop.lat, stop.lon) < DOWNSTREAM_MIN_METERS) return null;
    return computeBearing(fromLng, fromLat, stop.lon, stop.lat);
}

// Bearing toward the next non-degenerate stop in the trip sequence.
function downstreamBearing(props, fromLng, fromLat) {
    const stopped = isStoppedAt(props.currentStatus);

    // For IN_TRANSIT_TO: try bearing to the declared next stop first.
    if (!stopped) {
        const nextBearing = bearingToStop(props.stopId, fromLng, fromLat);
        if (nextBearing != null) return nextBearing;
    }

    const trip = window.masterTripsData?.[props.trip_id];
    let stops = trip?.stops;

    // Route-cache fallback: handles trips whose IDs aren't in the static GTFS build
    // (e.g. B Line owl-service trips). Without this, STOPPED_AT vehicles on those
    // routes return null here → raw tangentForward is used unresolved → 180° flip.
    if (!stops?.length) {
        const dir = props.direction_id;
        const cache = getRouteCache(String(props.route_code ?? ''), dir != null ? Number(dir) : null);
        if (cache?.stops?.length) stops = cache.stops;
    }
    if (!stops?.length) return null;

    // Determine where to start scanning: STOPPED_AT → skip current stop (idx+1).
    let startIdx = 0;
    if (props.stopId) {
        const norm = normalizeStopId(props.stopId);
        const idx = stops.findIndex(s => normalizeStopId(s) === norm);
        if (idx >= 0) startIdx = stopped ? idx + 1 : idx;
    }

    for (let i = startIdx; i < stops.length; i++) {
        const b = bearingToStop(stops[i], fromLng, fromLat);
        if (b != null) return b;
    }

    return null;
}

/**
 * Bearing FROM the most recent valid upstream trip stop TO the marker's
 * current position. Reliable as a "direction of travel" reference because the
 * train has demonstrably been past those stops — unlike downstreamBearing,
 * which relies on a feed-supplied stopId that can lag (point backward after a
 * station pass) or be missing entirely (terminus, stops.length scan).
 *
 * Walks the trip's stop sequence backward from `props.stopId`, skipping stops
 * closer than DOWNSTREAM_MIN_METERS (their bearings would be near-degenerate).
 * Returns null when no usable upstream stop exists (first stop of trip,
 * missing trip data, or all upstream stops too close).
 */
function upstreamBearing(props, fromLng, fromLat) {
    const trip = window.masterTripsData?.[props.trip_id];
    let stops = trip?.stops;
    if (!stops?.length) {
        const dir = props.direction_id;
        const cache = getRouteCache(String(props.route_code ?? ''), dir != null ? Number(dir) : null);
        if (cache?.stops?.length) stops = cache.stops;
    }
    if (!stops?.length || !props.stopId) return null;

    const norm = normalizeStopId(props.stopId);
    const curIdx = stops.findIndex(s => normalizeStopId(s) === norm);
    // curIdx <= 0 covers: stopId not in trip (-1) and first stop of trip (0).
    if (curIdx <= 0) return null;

    for (let i = curIdx - 1; i >= 0; i--) {
        const sid = stops[i];
        const stop = window.masterStopsData?.[String(sid)]
                  ?? window.masterStopsData?.[normalizeStopId(sid)];
        if (!stop?.lat || !stop?.lon) continue;
        if (planarMeters(fromLat, fromLng, stop.lat, stop.lon) < DOWNSTREAM_MIN_METERS) continue;
        // Bearing FROM upstream stop TO here = direction the train has been moving.
        return computeBearing(stop.lon, stop.lat, fromLng, fromLat);
    }
    return null;
}

/**
 * Arc cap enforcing the user-facing invariant: a vehicle marker must NEVER
 * visually pass a stop while the popup says the vehicle is AT that stop.
 *
 * Scope — STOPPED_AT only, AND only when the STOPPED_AT signal is trusted
 * (not a detected misfire). The popup labels STOPPED_AT as "At stop" and
 * IN_TRANSIT_TO as "Next stop" (Metro's feed never emits INCOMING_AT):
 *   • IN_TRANSIT_TO → no clamp. The feed's stopId routinely lags a stop or
 *     two behind a moving train, so clamping in-transit markers yanked them
 *     backward onto platforms they had already left ("too aggressively pulled
 *     to the next stop", user feedback 2026-05-21).
 *   • STOPPED_AT + misfire → no clamp. A STOPPED_AT misfire means the feed
 *     wrongly claims the vehicle is stopped while observed motion proves
 *     otherwise (speed sustained > 1 m/s, or the snap arc has drifted while
 *     the status hasn't changed). The misfire bypass exists to let DR keep
 *     the marker moving in this case; without this gate the clamp pinned
 *     `_drCurrentArc` at the stale declared stop and DR ran with no effect.
 *   • STOPPED_AT + no misfire → clamp engages. Marker is pinned at the
 *     platform so it matches the "At stop" popup label.
 *
 * DR still bounds in-transit coasting via the scan-first-ahead fallback —
 * that caps at the next physical stop, it never yanks a marker backward.
 *
 * Returns { arc, ascends } or null:
 *   • arc      — the arc value of the declared stop on the trip's polyline
 *   • ascends  — true if trip-sequence arcs ascend (typical dir=0), false if
 *                they descend (dir=1 trips traversing a shape defined for
 *                dir=0). Driven by the cache data, not by direction_id alone,
 *                so it's robust to per-route shape conventions.
 *   • null     — when no clamp can be applied: vehicle not STOPPED_AT, in a
 *                STOPPED_AT misfire, no stopId, stop not in the trip's cache,
 *                direction missing, or arc data unavailable. Callers fall
 *                back to the legacy scan-first-ahead behavior.
 *
 * @param {Object}  props      Vehicle/marker .properties bag.
 * @param {boolean} [isMisfire=false]  Caller-detected STOPPED_AT misfire.
 *                  Pass true when the misfire heuristic has fired so the
 *                  clamp doesn't undo the misfire bypass.
 *
 * Exported for unit testing.
 */
export function _declaredStopArcCap(props, isMisfire = false) {
    if (!props?.stopId) return null;
    // Gate on STOPPED_AT ("At stop"). For IN_TRANSIT_TO ("Next stop") the
    // marker must be free to follow GPS — see the doc comment above.
    if (!isStoppedAt(props.currentStatus)) return null;
    // STOPPED_AT-misfire bypass: observed motion contradicts the feed's
    // stopped flag, so don't pin the marker at the (stale) declared stop.
    if (isMisfire) return null;
    const routeCd = props?.route_code != null ? String(props.route_code) : '';
    const dir     = props?.direction_id;
    if (!routeCd || dir == null) return null;

    const cache = getRouteCache(routeCd, dir);
    if (!cache?.stops?.length || !cache?.arcMeters?.length) return null;

    const norm = normalizeStopId(props.stopId);
    const idx  = cache.stops.findIndex(s => normalizeStopId(s) === norm);
    if (idx < 0) return null;
    const arc = cache.arcMeters[idx];
    if (arc == null) return null;

    // Determine trip-sequence arc direction by finding ANY two non-null
    // adjacent arcs and comparing them. Falls back to ascending=true when
    // the cache only contains a single non-null arc (unusual but possible
    // on degenerate single-stop trips).
    let ascends = true;
    for (let i = 0; i < cache.arcMeters.length - 1; i++) {
        const a = cache.arcMeters[i], b = cache.arcMeters[i + 1];
        if (a != null && b != null && a !== b) { ascends = b > a; break; }
    }
    return { arc, ascends };
}

/**
 * Resolve the marker's display heading via a priority chain:
 *   1. Hold previous heading when stationary (and no fresh snap tangent)
 *   2. Hold previous heading near the trip's final stop (degenerate bearing)
 *   3. Use snap tangent + (downstream | upstream) bearing for ±180° disambiguation.
 *      When both bearings disagree by > 90°, prefer upstream — downstream is
 *      most likely pointing at a stop the train has already passed.
 *   4. No tangent: downstream cross-checked with upstream (same > 90° rule),
 *      then either alone if only one is available.
 *   5. Cold-start snap when shape data is available but lastSnap isn't set;
 *      upstream disambiguates if available.
 *   6. Final fallback: previous heading or 0.
 * Exported for unit testing — production callers go through updateExistingMarker.
 * @param {Object} marker
 * @param {Object} vehicle
 * @param {number} newLng
 * @param {number} newLat
 * @returns {number} heading in degrees [0, 360)
 */
export function computeHeading(marker, vehicle, newLng, newLat) {
    const props       = vehicle.properties;
    const prevHeading = marker.properties?.Heading;
    const speed       = Number(props.position_speed) || 0;

    // Hold heading when nearly stationary — prevents arrow jitter at stops.
    // Skip if a snap tangent is available: tangent is stable (polyline-derived, not GPS)
    // so it can safely correct a stale heading without causing jitter.
    if (prevHeading != null && speed < STATIONARY_SPEED_MPS && !marker.lastSnap?.tangentForward)
        return prevHeading;

    // Hold heading within 150 m of the trip's final stop (degenerate bearing zone).
    if (prevHeading != null) {
        const trip = window.masterTripsData?.[props.trip_id];
        if (trip?.stops?.length) {
            const finalStop = window.masterStopsData?.[String(trip.stops[trip.stops.length - 1])];
            if (finalStop && planarMeters(newLat, newLng, finalStop.lat, finalStop.lon) < FINAL_STOP_HOLD_M)
                return prevHeading;
        }
    }

    // Primary: polyline tangent keeps the arrow aligned to the track on curves.
    // downstreamBearing and upstreamBearing together resolve the ±180° ambiguity
    // and catch four failure modes:
    //   • A. STOPPED_AT terminus → no downstream stops; upstream still works
    //   • B. All downstream stops < DOWNSTREAM_MIN_METERS → upstream is farther
    //   • C. Cold-start with no lastSnap → upstream disambiguates the snap below
    //   • D. Stale stopId points backward → downstream/upstream disagree by >90°,
    //         trust upstream (train has demonstrably been past those stops)
    const tangent = marker.lastSnap?.tangentForward;
    const isEndpointTangent = marker.lastSnap?.endpointTangent === true;
    if (tangent != null) {
        const downstream = downstreamBearing(props, newLng, newLat);
        const upstream   = upstreamBearing(props, newLng, newLat);

        // Pick the reference bearing for disambiguation. If both are available
        // and they disagree by > 90°, one of them is behind us — the most
        // common cause is a lagged stopId after a station pass (downstream
        // points at a stop the train just left). Trust upstream in that case.
        let reference;
        if (downstream != null && upstream != null) {
            const refDelta = _shortestBearingDelta(downstream, upstream);
            reference = Math.abs(refDelta) > 90 ? upstream : downstream;
        } else {
            reference = downstream ?? upstream;
        }

        if (reference != null) {
            // Endpoint-window tangents are computed from an asymmetric span
            // that can include a turnout, loop, or stub track — direction is
            // unreliable. Prefer the disambiguator outright in that case.
            if (isEndpointTangent) return reference;
            const delta = _shortestBearingDelta(reference, tangent);
            return Math.abs(delta) < 90 ? tangent : (tangent + 180) % 360;
        }
        // No reference of either kind — prefer prevHeading over raw tangent.
        return prevHeading ?? tangent;
    }

    // Fallback: no snap data (off-route, busway, first fix) — use downstream
    // bearing, but cross-check against upstream in case stopId is lagged and
    // points backward. If both are available and disagree by >90°, trust
    // upstream (vector D when tangent is also unavailable).
    const downstream = downstreamBearing(props, newLng, newLat);
    const upstream   = upstreamBearing(props, newLng, newLat);
    if (downstream != null && upstream != null) {
        const refDelta = _shortestBearingDelta(downstream, upstream);
        return Math.abs(refDelta) > 90 ? upstream : downstream;
    }
    if (downstream != null) return downstream;
    if (upstream != null)   return upstream;

    // Cold-start: snap to get tangent if lastSnap not yet available. Disambiguate
    // with upstream so an endpoint-snap doesn't return a 180°-flipped tangent.
    if (prevHeading == null && hasShapeData(props.route_code)) {
        const snap = snapToRoute(props.route_code, newLng, newLat);
        if (snap?.tangentForward != null) {
            // upstream was already computed above for the downstream branch;
            // reuse it here (covers vector C: cold-start with reverse-tangent).
            if (upstream != null) {
                const delta = _shortestBearingDelta(upstream, snap.tangentForward);
                return Math.abs(delta) < 90 ? snap.tangentForward : (snap.tangentForward + 180) % 360;
            }
            return snap.tangentForward;
        }
    }

    return prevHeading ?? 0;
}

// Metro rail — circle with arrow
function makeArrowSvgUrl(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
        <circle cx="25" cy="25" r="22" fill="${color}" stroke="#ffffff" stroke-width="4"/>
        <path d="M 25 10 L 36 36 L 25 29 L 14 36 Z" fill="#ffffff"/>
    </svg>`;
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

// Metro bus (G/J Line) — square with arrow
function makeSquareSvgUrl(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
        <rect x="4" y="4" width="42" height="42" rx="5" fill="${color}" stroke="#ffffff" stroke-width="4"/>
        <path d="M 25 11 L 35 34 L 25 27 L 15 34 Z" fill="#ffffff"/>
    </svg>`;
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

// Terminus — same outer shape as the moving marker, white square replaces the arrow
function makeTerminusSvgUrl(color, agency, routeCode) {
    let svg;
    if (isBusRoute(routeCode)) {
        // Bus: square-within-square
        svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
            <rect x="4" y="4" width="42" height="42" rx="5" fill="${color}" stroke="#ffffff" stroke-width="4"/>
            <rect x="16" y="16" width="18" height="18" rx="2" fill="#ffffff"/>
        </svg>`;
    } else {
        // Rail: circle with white square inside
        svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
            <circle cx="25" cy="25" r="22" fill="${color}" stroke="#ffffff" stroke-width="4"/>
            <rect x="15" y="15" width="20" height="20" rx="2" fill="#ffffff"/>
        </svg>`;
    }
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

function isAtTerminus(props, isMisfire = false) {
    if (!isStoppedAt(props.currentStatus)) return false;
    // A STOPPED_AT misfire means the feed claims the vehicle is stopped but
    // observed motion proves otherwise — it's not really sitting at the
    // terminus. Skip the terminus rotation/SVG lock so a misfiring vehicle
    // keeps following its true heading.
    if (isMisfire) return false;
    if (!props.stopId) return false;
    const curStop = normalizeStopId(props.stopId);

    // Check against this trip's specific last stop
    const trip = props.trip_id ? window.masterTripsData?.[props.trip_id] : null;
    if (trip?.stops?.length) {
        if (curStop === normalizeStopId(trip.stops[trip.stops.length - 1])) return true;
    }

    // Check if curStop is a known terminus for this route in either direction.
    // Handles "waiting at first stop of new trip" as well as "completed last stop".
    if (props.route_code != null) {
        for (const dir of [0, 1]) {
            const termId = getTerminalStopId(String(props.route_code), dir);
            if (termId && curStop === normalizeStopId(termId)) return true;
        }
    }

    return false;
}

/**
 * Stricter than isAtTerminus(): only true when stopped at the LAST stop of
 * the current trip (end-of-line). Excludes vehicles parked at an origin
 * stop, which are also a "terminus" in the route topology but represent a
 * trip about to start, not one that has finished.
 */
function _isAtEndOfLine(props, isMisfire = false) {
    if (!isStoppedAt(props.currentStatus)) return false;
    // Same rationale as isAtTerminus: a misfiring vehicle isn't really at the
    // last stop. Don't trigger the end-of-line linger/fade cleanup against it.
    if (isMisfire) return false;
    if (!props.stopId || !props.trip_id) return false;
    const trip = window.masterTripsData?.[props.trip_id];
    if (!trip?.stops?.length) return false;
    return normalizeStopId(props.stopId) === normalizeStopId(trip.stops[trip.stops.length - 1]);
}

function markerSvgUrl(agency, routeCode, color, terminus = false) {
    const key = `${agency}|${routeCode}|${color}|${terminus}`;
    if (_svgUrlCache.has(key)) return _svgUrlCache.get(key);
    let url;
    if (terminus) url = makeTerminusSvgUrl(color, agency, routeCode);
    else if (isBusRoute(routeCode)) url = makeSquareSvgUrl(color);
    else url = makeArrowSvgUrl(color);
    _svgUrlCache.set(key, url);
    return url;
}

/**
 * Return true if the new position is within GPS_SPIKE_STOP_RADIUS_M of the
 * vehicle's declared next stop. Used as a "near a stop" escape hatch in the
 * spike-rejection gates so teleports to a platform are not wrongly rejected.
 * @param {Object} vehicle  Feature with .properties.stopId
 * @param {number} newLng
 * @param {number} newLat
 * @returns {boolean}
 */
function _nearStop(vehicle, newLng, newLat) {
    const stopId = vehicle.properties.stopId;
    const stop = stopId != null ? window.masterStopsData?.[String(stopId)] : null;
    if (!stop) return false;
    return planarMeters(newLat, newLng, stop.lat, stop.lon) <= GPS_SPIKE_STOP_RADIUS_M;
}

/**
 * Shortest signed angle from bearing b to bearing a, in degrees [-180, 180].
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function _shortestBearingDelta(a, b) {
    return ((a - b + 540) % 360) - 180;
}

/**
 * Decide whether a new GPS fix should be rejected as a spike.
 * Three independent gates: rail arc-distance jump (when shape data is available),
 * implausible straight-line speed, and predict-then-validate against last velocity.
 * Falls through to false (accept) when the marker has no usable reference state.
 * Exported for unit testing — production callers go through updateExistingMarker.
 * @param {Object} marker  Vehicle marker with getLngLat, lastSnap, lastVelocity
 * @param {Object} vehicle Feature with .properties (route_code, stopId, …)
 * @param {number} newLng  New fix longitude
 * @param {number} newLat  New fix latitude
 * @param {number} newTs   New fix unix seconds
 * @param {number} prevTs  Previous fix unix seconds
 * @returns {boolean} true → reject the fix
 */
export function isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs) {
    const elapsed = Math.max(newTs - prevTs, 0);

    // Use the last accepted GPS snap as the reference position, NOT getLngLat().
    // getLngLat() returns the visual/DR-animated position which can be hundreds of
    // meters ahead of the last GPS anchor after a tunnel transit — using it as the
    // spike reference makes valid re-acquisition fixes look like they're traveling
    // backward at implausible speed or landing far from the prediction.
    const ref = marker.lastSnap
        ? { lat: marker.lastSnap.snappedLat, lng: marker.lastSnap.snappedLng }
        : marker.getLngLat();
    const distMeters = planarMeters(ref.lat, ref.lng, newLat, newLng);

    // Rail arc-distance gate: snap both positions to the polyline and check whether
    // the arc jump is physically achievable. Far tighter than straight-line speed for
    // multi-stop teleports where the stop happens to be within 5 km of the bad fix.
    // Only applies to routes with shape data (all Metro rail); busway unaffected.
    if (hasShapeData(vehicle.properties.route_code) && marker.lastSnap) {
        const newSnap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (newSnap) {
            const arcJumpM = Math.abs(newSnap.arcMeters - marker.lastSnap.arcMeters);
            // Allow at least 30 s of travel on fresh timestamps; add snap-noise margin.
            const maxArcM = RAIL_MAX_SPEED_MPS * Math.max(elapsed, 30) + RAIL_ARC_SPIKE_NOISE_M;
            if (arcJumpM > maxArcM) return true;
        }
    }

    // Implausible speed gate (cheap) — measured from last GPS anchor, not visual position.
    if (elapsed > 0 && distMeters / elapsed > MAX_PLAUSIBLE_SPEED_MPS) {
        // Secondary: if the new fix is within ~5 km of the next/current stop, the
        // vehicle plausibly teleported across a feed gap — let it through.
        if (!_nearStop(vehicle, newLng, newLat)) return true;
    }

    // Predict-then-validate: project from the last GPS anchor (not visual position)
    // so DR-animated advancement doesn't inflate the prediction error.
    const lastV = marker.lastVelocity;
    if (lastV && elapsed > 0) {
        const predLng = ref.lng + lastV.dLng * elapsed;
        const predLat = ref.lat + lastV.dLat * elapsed;
        const errMeters = planarMeters(predLat, predLng, newLat, newLng);
        // Tolerance: noise floor + speed × elapsed × 2.5 (generous headroom for
        // acceleration, deceleration, and GPS scatter after tunnel re-acquisition).
        const speed = lastV.speedMps || 0;
        const noiseM = GPS_NOISE_FLOOR_DEG * M_PER_DEG_LAT;
        const tolerance = Math.max(noiseM, speed * elapsed * 2.5 + noiseM);
        if (errMeters > tolerance && distMeters > GPS_SPIKE_MIN_DIST_M) {
            // Secondary check: if new position is near the declared next stop, let it through.
            if (!_nearStop(vehicle, newLng, newLat)) return true;
        }
    }

    return false;
}

let _lastTripCoverageCheck = 0;
const TRIP_COVERAGE_CHECK_INTERVAL_MS = 300_000; // re-run every 5 min to catch post-deploy drift

/**
 * Ingest a batch of raw vehicle position features from a WebSocket frame.
 * For each feature: validates, spike-rejects, snaps to polyline, computes heading
 * via a priority chain (snap tangent → GPS bearing → dead-reckoning → last known),
 * creates or updates the map marker, and triggers dead-reckoning animation.
 * @param {{ features: Object[] }} data  Parsed GeoJSON FeatureCollection frame
 * @param {Object[]} features            Same features array (pre-extracted for perf)
 * @param {maplibregl.Map} map
 * @see computeHeading
 */
export function processVehicleData(data, features, map) {
    // Pre-bootstrap guard. Two WS sockets open in sequence inside main.js's
    // dataPromise.then() chain; a frame arriving on the first socket before
    // masterStopsData finishes loading would silently degrade marker creation
    // (optional-chained stop lookups return undefined → DR tuning / adherence
    // / terminus detection all fall through to safe-but-wrong defaults).
    // Drop pre-bootstrap frames at the convergence point so the issue
    // surfaces in feed-stats instead of as confusing UI artifacts.
    if (!window.masterStopsData || Object.keys(window.masterStopsData).length === 0) {
        for (const v of data.features ?? []) {
            const vid = v.properties?.vehicle_id;
            if (vid) recordMarkerDrop('preBootstrap');
        }
        return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    data.features
        .filter(v => {
            if (!v.properties?.trip_id) {
                // api.js should have caught this upstream; log here as a second-line guard.
                const vid = v.properties?.vehicle_id;
                if (vid) console.warn(`[Metro Live Map] Marker skipped — no trip_id for vehicle ${vid}`);
                return false;
            }
            return true;
        })
        .forEach(vehicle => {
            const ts = parseInt(vehicle.properties.timestamp, 10);
            if (nowSec - ts > FRESH_EXPIRE_S) {
                recordMarkerDrop('staleAge');
                return;
            }

            const markerKey = vehicle.properties.trip_id;
            const existing = markers[markerKey];
            if (existing) {
                const prevTs = parseInt(existing.timestamp, 10);
                // Wall-clock ordering only (no sequence numbers in GTFS-RT feed).
                // Vehicle clock skew / NTP corrections could theoretically reorder frames,
                // but Metro's feed is reliable enough that this is acceptable.
                if (ts > prevTs) {
                    // Don't mutate marker.timestamp here — the spike filter needs the
                    // previous timestamp to compute elapsed. updateExistingMarker
                    // advances it after the fix is accepted (or rejected as a spike).
                    updateExistingMarker(vehicle, features, map, markerKey, prevTs);
                } else {
                    // Re-broadcast of same/older timestamp — feed-level redundancy that
                    // shouldn't reset the fade clock or mutate state.
                    recordMarkerDrop('olderTs');
                }
            } else {
                // Terminus turnaround: same vehicle_id, new trip_id, similar location?
                let oldMarkerKey = null;
                let isTerminusTurnaround = false;
                for (const key in markers) {
                    if (markers[key].properties.vehicle_id === vehicle.properties.vehicle_id && key !== markerKey) {
                        const oldPos = markers[key].getLngLat();
                        const [newLng, newLat] = vehicle.geometry.coordinates;
                        const dist = planarMeters(oldPos.lat, oldPos.lng, newLat, newLng);
                        if (dist < TERMINUS_TURNAROUND_RADIUS_M) {
                            oldMarkerKey = key;
                            isTerminusTurnaround = true;
                            break;
                        }
                    }
                }

                if (isTerminusTurnaround && oldMarkerKey) {
                    _fadeOutAndRemove(oldMarkerKey);
                }
                // Cold-start spike gate — drop obvious bad first frames so a
                // corrupt fix doesn't paint a marker thousands of meters
                // off-track. Terminus turnarounds bypass (vehicle is known
                // to be at the prior trip's terminus, position is already trusted).
                if (!isTerminusTurnaround && _isColdStartSpike(vehicle)) {
                    recordMarkerDrop('coldStartSpike');
                    return;
                }
                createNewMarker(vehicle, features, map, markerKey);
            }
        });

    updateDataPanel(markers);

    // Periodic diagnostic: warn if a large fraction of live trip IDs are absent from
    // static trips.json (D-1 — catches stale data files after a Metro schedule change).
    const nowMs = Date.now();
    if (nowMs - _lastTripCoverageCheck > TRIP_COVERAGE_CHECK_INTERVAL_MS && Object.keys(markers).length >= 5) {
        _lastTripCoverageCheck = nowMs;
        const trips = window.masterTripsData;
        if (trips) {
            const liveIds = Object.values(markers).map(m => m.properties.trip_id).filter(Boolean);
            const missed  = liveIds.filter(id => !trips[id]);
            if (liveIds.length > 0 && missed.length / liveIds.length > 0.2) {
                console.warn(`[Metro Live Map] ${missed.length}/${liveIds.length} live trip IDs missing from trips.json — static data may be stale. Sample: ${missed.slice(0, 5).join(', ')}`);
            }
        }
    }
}

/**
 * Cold-start spike gate: brand-new markers have no `lastVelocity` so the
 * predict-then-validate filter in isGpsSpike() is bypassed. A corrupt first
 * frame would place the marker hundreds-to-thousands of metres off-track.
 *
 * Gate: snap the candidate position to the route polyline. If the snap
 * distance exceeds COLD_START_MAX_OFFROUTE_M, treat the fix as bad data
 * and reject. The next valid frame for the same trip will retry creation.
 *
 * Bypass: a near-stop teleport (within GPS_SPIKE_STOP_RADIUS_M of the
 * declared next stop) is allowed through, mirroring the warm-marker path.
 * Routes without shape data (none in production today, but defensive)
 * fall through and are accepted.
 *
 * Exported for unit testing.
 * @param {Object} vehicle Feature with .properties.route_code + geometry
 * @returns {boolean} true → reject the cold start
 */
export function _isColdStartSpike(vehicle) {
    const [lng, lat]  = vehicle.geometry.coordinates;
    const routeCode   = vehicle.properties.route_code;
    if (!hasShapeData(routeCode)) return false;
    const snap = snapToRoute(routeCode, lng, lat);
    if (!snap) return false;
    const offRouteM = planarMeters(snap.snappedLat, snap.snappedLng, lat, lng);
    if (offRouteM <= COLD_START_MAX_OFFROUTE_M) return false;
    // Near-stop bypass — same escape hatch as the warm spike filter for
    // legitimate teleports across feed gaps.
    if (_nearStop(vehicle, lng, lat)) return false;
    return true;
}

function createNewMarker(vehicle, features, map, markerKey) {
    const { vehicle_id, route_code, trip_id, timestamp } = vehicle.properties;
    const agency = vehicle.properties.agency || 'metro';
    const isBus = isBusRoute(route_code);

    if (markers[markerKey]) {
        markers[markerKey]._removed = true;
        markers[markerKey].remove();
        delete markers[markerKey];
    }
    // Cancel any in-flight fade for this trip_id so the orphan DOM element
    // doesn't coexist with the new marker for the 1200 ms fade duration.
    const fading = _fadingMarkers.get(markerKey);
    if (fading) {
        clearTimeout(fading.timeoutId);
        fading.marker._removed = true;
        fading.marker.remove();
        _fadingMarkers.delete(markerKey);
    }

    const el = document.createElement('div');
    el.className = 'marker';
    el.setAttribute('data-route', route_code);
    el.setAttribute('data-trip', trip_id);
    el.setAttribute('data-mode', isBus ? 'bus' : 'rail');
    el.setAttribute('data-agency', agency);
    el.setAttribute('data-timestamp', timestamp);
    el.setAttribute('data-vehicle-id', vehicle_id);
    const sizeExpr = isBus
        ? 'calc(var(--vehicle-size, 24px) * 0.85)'
        : 'var(--vehicle-size, 24px)';
    el.style.cssText = `width:${sizeExpr};height:${sizeExpr};background-repeat:no-repeat;background-size:contain;background-position:center;cursor:pointer;`;

    const brandColor = routeHexColors[route_code] || '#231f20';
    // Cold-start misfire is detectable only from speed (no prior marker state
    // for the arc-drift check). Suppresses the terminus SVG swap for a vehicle
    // whose feed says STOPPED_AT at terminus but is clearly already moving.
    const _coldMisfire = (Number(vehicle.properties.position_speed) || 0) > STOPPED_AT_MISFIRE_SPEED_MPS;
    const terminus0 = isAtTerminus(vehicle.properties, _coldMisfire);
    el.style.backgroundImage = markerSvgUrl(agency, route_code, brandColor, terminus0);

    const [rawLng, rawLat] = vehicle.geometry.coordinates;
    const ts = parseInt(timestamp, 10);

    // Cold-start clamp — enforce the "marker never past the stop it's AT"
    // invariant on the very first frame. Only engages for STOPPED_AT vehicles
    // (see _declaredStopArcCap); an IN_TRANSIT_TO first fix renders wherever
    // GPS lands. Without this, a vehicle whose first observed GPS lands past
    // its declared STOPPED_AT stop would render past until the second WS frame
    // arrived (~1 s later) and _applySnap clamped via the updateExistingMarker
    // path. Page reloads create new markers for every active train, so this is
    // the common case where the cold-start window would otherwise show
    // "marker past stop" briefly. The clamp lives here
    // (not as a full _applySnap call) because createNewMarker has not yet
    // populated marker.lastSnap or the various marker._* state _applySnap
    // mutates — minimal-surface fix.
    let lng = rawLng, lat = rawLat;
    const _rcStr = route_code != null ? String(route_code) : '';
    if (_rcStr && hasShapeData(_rcStr)) {
        const _snap = snapToRoute(_rcStr, rawLng, rawLat);
        if (_snap) {
            // Cold-start has no prior arc-drift signal — only the speed
            // trigger of the misfire heuristic can fire here. Reuse the same
            // _coldMisfire derived for the terminus SVG above so the clamp
            // and the SVG agree about whether to honor the STOPPED_AT flag.
            const _cap = _declaredStopArcCap(vehicle.properties, _coldMisfire);
            if (_cap != null) {
                const wouldOvershoot = _cap.ascends
                    ? _snap.arcMeters > _cap.arc
                    : _snap.arcMeters < _cap.arc;
                if (wouldOvershoot) {
                    const _pos = lngLatAtArc(_rcStr, _cap.arc);
                    if (_pos) {
                        lng = _pos.lng;
                        lat = _pos.lat;
                        recordMarkerDrop('declaredStopClamp');
                    }
                }
            }
        }
    }

    const vehicleLabel = isBus ? 'Bus ID ' : 'Train Car #';
    const { stopId, currentStatus, direction_id, currentStopSequence } = vehicle.properties;
    const secToNextStop = getSecondsToNextStop({ properties: { ...vehicle.properties, statusChangedAt: ts } });
    const popupHtml = getPopupHTML(route_code, vehicle_id, vehicleLabel, timestamp, stopId, currentStatus, direction_id, trip_id, currentStopSequence, agency, secToNextStop);

    const popup = new maplibregl.Popup({ offset: 15, maxWidth: '300px', className: 'vehicle-popup' }).setHTML(popupHtml); // safe: feed values escaped via escapeHtml() in getPopupHTML
    popup.on('open',  closeStationPopup);
    popup.on('open',  () => _openVehiclePopups++);
    popup.on('open',  () => {
        // Sync the age display from data-ts immediately on open so it shows the
        // correct value rather than the stale baked-in secsSince from HTML generation.
        const pEl = popup.getElement();
        if (!pEl) return;
        const now = Date.now() / 1000;
        pEl.querySelectorAll('.pv2-time[data-ts]').forEach(timeEl => {
            const age = Math.max(0, Math.floor(now - Number(timeEl.dataset.ts)));
            timeEl.querySelector('.pv2-secs').textContent = age + 's';
            const dot = timeEl.querySelector('.pv2-dot');
            if (dot) dot.dataset.tier = getFreshnessTierFromAge(age);
        });
    });
    popup.on('close', () => { _openVehiclePopups = Math.max(0, _openVehiclePopups - 1); });

    const marker = new maplibregl.Marker({
        element: el,
        anchor: 'center',
        rotationAlignment: 'map',
        pitchAlignment: 'map'
    })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);

    marker._removed = false;
    marker._createdAtMs = Date.now();
    marker.properties = {
        vehicle_id, trip_id, route_code,
        direction_id: direction_id != null ? Number(direction_id) : null,
        currentStatus: vehicle.properties.currentStatus ?? null,
        stopId: vehicle.properties.stopId ?? null,
        statusChangedAt: ts,
        Heading: undefined, // intentionally undefined on cold start
        speed: vehicle.properties.position_speed,
    };
    marker.timestamp = ts;
    marker.route_code = route_code;
    marker.vehicleLabel = vehicleLabel;
    marker.lastVelocity = null;
    marker.validFixCount = 0;
    marker.atTerminus = terminus0;
    // Staleness state: _lastFreshTs is the GPS reading time of the last
    // strictly-newer fix (re-broadcasts of an old reading don't bump it).
    // Used only by spike-rejection (SPIKE_BYPASS_S) — NOT visual freshness.
    // Visual state is driven by `_tier` via getFreshnessTier(marker, now).
    marker._lastFreshTs = ts;
    // Apply initial freshness tier so a marker created from a lagged WS message
    // (e.g. reconnect batch) starts at the correct opacity rather than always
    // rendering fully opaque on creation.
    const _nowSec = Math.floor(Date.now() / 1000);
    applyFreshness(marker, getFreshnessTier(marker, _nowSec), /*animated*/ false);
    // Cold-start: if the very first fix already places the vehicle at the end
    // of its trip, kick off the linger clock so the cleanup loop can fade it
    // out. Most vehicles will not be in this state on creation.
    marker._endOfLineSinceTs = _isAtEndOfLine(marker.properties, _coldMisfire)
        ? Math.floor(Date.now() / 1000)
        : null;

    applyOriginVisibility(marker, vehicle.properties);

    const heading = computeHeading(marker, vehicle, lng, lat);
    marker.properties.Heading = heading;
    marker.setRotation(terminus0 ? 0 : heading);

    // Hover tooltip: show popup on mouseenter, dismiss on
    // mouseleave unless the user has already clicked to pin it open.
    let hoverTimer;
    let openedByHover = false;

    el.addEventListener('mouseenter', () => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            if (marker._removed) return;
            if (!popup.isOpen()) {
                marker.togglePopup();
                openedByHover = true;
            }
        }, 180);
    });

    el.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimer);
        if (openedByHover && popup.isOpen()) {
            marker.togglePopup();
        }
        openedByHover = false;
    });

    // Click pins the popup — mouseleave should no longer close it.
    el.addEventListener('click', () => { openedByHover = false; });

    markers[markerKey] = marker;
}

/**
 * Snap the marker to the nearest polyline point (rail routes) and to the
 * declared stop coordinates when stopped. Stores the snapped target position
 * as marker._targetLng / marker._targetLat for use by _applyVelocityCorrections.
 * Also stores marker._terminusNow (boolean) so _applyTerminusHeading can read it
 * without needing the vehicle feature.
 *
 * Mutates: marker.lastSnap, marker._prevSnap, marker.lastSnapDeviationM,
 *          marker._targetLng, marker._targetLat, marker._terminusNow,
 *          DOM data-off-route attribute.
 * @param {Object} marker
 * @param {Object} vehicle  Full vehicle Feature (geometry + properties)
 */

/**
 * Detect a STOPPED_AT misfire: feed says STOPPED_AT but the vehicle is clearly
 * moving. Two triggers, OR-gated:
 *   1. reportedSpeed > STOPPED_AT_MISFIRE_SPEED_MPS — a fast vehicle being
 *      reported as stopped is a clear feed-side bug.
 *   2. statusChangedAt > STOPPED_AT_MISFIRE_AGE_S ago AND the marker's snap
 *      has moved more than STOPPED_AT_MISFIRE_ARC_DELTA_M along the arc since
 *      the status last changed. Catches slow drifts where the feed is lagged
 *      but the vehicle clearly isn't dwelling at a station any more.
 *
 * The AND-gate in trigger 2 is critical — legitimate end-of-line / mid-line
 * operator-break dwells can run 2-5 min at a terminal stop, so age alone
 * must NOT override the pin. Returns true if misfire detected; caller emits
 * `recordMarkerDrop('stoppedAtMisfire')` once per detection.
 *
 * Pass `reportedSpeed` and `currentTs` from whichever object the caller has
 * available (fresh vehicle in _applySnap, accumulated marker.properties in
 * startDeadReckoning). Decouples the helper from feature/marker object shape.
 */
function _isStoppedAtMisfire(marker, reportedSpeed, currentTs) {
    if (reportedSpeed > STOPPED_AT_MISFIRE_SPEED_MPS) return true;

    const statusChangedAt = marker.properties?.statusChangedAt;
    const arcAtChange     = marker.properties?.arcAtStatusChange;
    const currentArc      = marker.lastSnap?.arcMeters;
    if (!Number.isFinite(statusChangedAt) || !Number.isFinite(arcAtChange) ||
        !Number.isFinite(currentArc) || !Number.isFinite(currentTs)) return false;

    const ageS     = currentTs - statusChangedAt;
    const arcDelta = Math.abs(currentArc - arcAtChange);
    return ageS > STOPPED_AT_MISFIRE_AGE_S && arcDelta > STOPPED_AT_MISFIRE_ARC_DELTA_M;
}

export function _applySnap(marker, vehicle) {
    const [newLng, newLat] = vehicle.geometry.coordinates;

    // Detect STOPPED_AT misfire up front so the declared-stop clamp below can
    // honor the misfire bypass. The misfire predicate depends only on the
    // marker's prior state (speed/age/arc-drift), not on this frame's snap,
    // so it's safe to compute before the snap block. Uses the CURRENT frame's
    // position_speed (vehicle.properties) — the freshest signal we have here,
    // since _applyVelocityCorrections (which would update marker.properties
    // .smoothedSpeed/.speed) hasn't run yet on this frame. startDeadReckoning,
    // which runs AFTER _applyVelocityCorrections, reads the now-updated
    // marker.properties.smoothedSpeed — both consume the same vehicle reading,
    // just through different in-flight stages of the per-frame propagation.
    const _stoppedAt = isStoppedAt(vehicle.properties.currentStatus);
    const _misfire = _stoppedAt && _isStoppedAtMisfire(
        marker,
        Number(vehicle.properties?.position_speed) || 0,
        Number(vehicle.properties?.timestamp),
    );

    // Snap to polyline before computing heading so downstreamBearing()
    // is called from the track centerline, not the GPS-jitter offset.
    let targetLng = newLng;
    let targetLat = newLat;
    if (hasShapeData(vehicle.properties.route_code)) {
        let snap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (snap) {
            const snapDistM = planarMeters(snap.snappedLat, snap.snappedLng, newLat, newLng);
            const _rc = vehicle.properties.route_code;
            const snapMaxM = isBusRoute(_rc) ? BUS_SNAP_MAX_M
                : isHeavyRail(_rc) ? HEAVY_RAIL_SNAP_MAX_M
                : RAIL_SNAP_MAX_M;
            if (snapDistM < snapMaxM) {
                marker._prevSnap = marker.lastSnap;
                // Preserve last-known tangent when the new snap window collapses
                // to a degenerate point (sub-1m segment near a terminal loop).
                // Fallback: use previous snap direction if current snap has no tangent
                // (degenerate polyline segment)
                if (snap.tangentForward == null && marker.lastSnap?.tangentForward != null) {
                    snap = { ...snap, tangentForward: marker.lastSnap.tangentForward };
                }

                // Declared-stop clamp — enforce the user-facing invariant
                // "marker arc ≤ declared stop arc" at the chokepoint. Only
                // engages when the vehicle is STOPPED_AT AND not in a
                // STOPPED_AT misfire (see _declaredStopArcCap); IN_TRANSIT_TO
                // and misfiring markers pass through unclamped. Done BEFORE
                // marker.lastSnap is written so downstream consumers
                // (startDeadReckoning, animateMarker target, ETA/predictions)
                // see a single consistent snap object.
                const _cap = _declaredStopArcCap(vehicle.properties, _misfire);
                if (_cap != null) {
                    const wouldOvershoot = _cap.ascends
                        ? snap.arcMeters > _cap.arc
                        : snap.arcMeters < _cap.arc;
                    if (wouldOvershoot) {
                        const _pos = lngLatAtArc(_rc, _cap.arc);
                        if (_pos) {
                            snap = {
                                ...snap,
                                arcMeters:   _cap.arc,
                                snappedLng:  _pos.lng,
                                snappedLat:  _pos.lat,
                                // Use the local tangent at the clamped arc when
                                // the original snap didn't supply one; preserves
                                // heading disambiguation downstream.
                                tangentForward: snap.tangentForward ?? _pos.tangent ?? null,
                            };
                            recordMarkerDrop('declaredStopClamp');
                        }
                    }
                }

                marker.lastSnap = snap;
                marker.lastSnapDeviationM = snapDistM;
                targetLng = snap.snappedLng;
                targetLat = snap.snappedLat;
                marker.getElement().removeAttribute('data-off-route');
                marker._offRouteRecorded = false;
            } else {
                // Off-route detour: clear snap so DR doesn't project along the guideway
                marker._prevSnap = null;
                marker.lastSnap = null;
                marker.lastSnapDeviationM = null;
                marker.getElement().setAttribute('data-off-route', 'true');
                // Episode-gated: one record per transition INTO off-route, not per frame.
                if (!marker._offRouteRecorded) {
                    recordMarkerDrop('offRoute');
                    marker._offRouteRecorded = true;
                }
            }
        }
    }

    // When stopped at a station, snap to the stop's known coordinates to
    // prevent GPS jitter from drifting the marker away from the platform.
    // For rail, project the station coord onto the route polyline so the
    // marker aligns with the drawn route line (published station coords are
    // platform centroids that can sit a few meters off the polyline). The
    // RAIL_SNAP_MAX_M off-by gate falls back to the published coord when the
    // projection lands too far away — protects against fixture/route mismatches
    // and stations whose published coord is genuinely off-line. Bus published
    // coords are correct as-is (no polyline to project onto).
    // _stoppedAt and _misfire were computed at the top of this function so
    // the declared-stop clamp inside the snap block could honor the misfire
    // bypass; reuse the same values here.
    // Propagate the misfire decision to downstream consumers (predictions.js,
    // stations.js) via marker.properties._misfireOverride, read through the
    // isEffectivelyStopped helper. Without this, predictions kept applying
    // origin-stop suppression on a status markers.js had already determined
    // was unreliable. Always write (true/false) so the flag tracks current
    // state, not a sticky decision.
    marker.properties._misfireOverride = !!_misfire;
    if (_misfire && !marker._stoppedAtMisfireRecorded) {
        // Episode-gated: one record per misfire detection cycle. Cleared when
        // the feed transitions out of STOPPED_AT (see status-tracking code).
        recordMarkerDrop('stoppedAtMisfire');
        marker._stoppedAtMisfireRecorded = true;
    }
    if (_stoppedAt && !_misfire) {
        const stop = window.masterStopsData?.[String(vehicle.properties.stopId)];
        if (stop?.lat && stop?.lon) {
            const _rc = vehicle.properties.route_code;
            if (hasShapeData(_rc)) {
                const stopSnap = snapToRoute(_rc, stop.lon, stop.lat);
                const offBy = stopSnap
                    ? planarMeters(stop.lat, stop.lon, stopSnap.snappedLat, stopSnap.snappedLng)
                    : Infinity;
                if (stopSnap && offBy <= RAIL_SNAP_MAX_M) {
                    targetLng = stopSnap.snappedLng;
                    targetLat = stopSnap.snappedLat;
                } else {
                    targetLng = stop.lon;
                    targetLat = stop.lat;
                }
            } else {
                targetLng = stop.lon;
                targetLat = stop.lat;
            }
        }
    }

    marker._targetLng = targetLng;
    marker._targetLat = targetLat;
    // _misfire was computed above (line ~982) and written to marker.properties._misfireOverride;
    // pass it through so a misfiring vehicle at terminus keeps its true heading.
    marker._terminusNow = isAtTerminus(vehicle.properties, _misfire);
}

/**
 * Compute heading + speed, apply GPS-pullback suppression, then dispatch to
 * the correct motion handler: suppress (re-anchor DR), teleport (>5 km gap),
 * or animate (normal update).
 *
 * Reads:  marker._targetLng, marker._targetLat, marker._terminusNow
 * Mutates: marker.properties.Heading, marker.properties.speed,
 *          marker.properties.smoothedSpeed, marker.lastVelocity,
 *          marker.lastSnap, marker._prevSnap, marker._pullbackRun
 * @param {Object} marker
 * @param {Object} vehicle  Full vehicle Feature
 * @param {string} markerKey
 * @param {number} prevTs   Previous fix unix seconds
 * @param {boolean} isFirstFix
 * @param {boolean} isStaleRef
 */
export function _applyVelocityCorrections(marker, vehicle, markerKey, prevTs, isFirstFix, isStaleRef) {
    const newTs = parseInt(vehicle.properties.timestamp, 10);
    const targetLng = marker._targetLng;
    const targetLat = marker._targetLat;
    const terminusNow = marker._terminusNow;
    const current = marker.getLngLat();

    const newHeading = computeHeading(marker, vehicle, targetLng, targetLat);
    const startHeading = marker.properties.Heading ?? newHeading;
    const dispHeading = terminusNow ? 0 : newHeading;
    const dispStart   = terminusNow ? 0 : startHeading;

    marker.properties.Heading = newHeading;
    marker.properties.speed = vehicle.properties.position_speed;
    // EWMA speed smoothing — dampens jitter from one-off noisy GPS speed reports.
    // Cold start (no prior reading): seed directly so the first DR frame is immediate.
    const _rawSpd = Number(vehicle.properties.position_speed) || 0;
    const _prevSmoothed = Number(marker.properties.smoothedSpeed);
    marker.properties.smoothedSpeed = Number.isFinite(_prevSmoothed)
        ? DR_SPEED_ALPHA * _rawSpd + (1 - DR_SPEED_ALPHA) * _prevSmoothed
        : _rawSpd;

    const elapsed = Math.max(newTs - prevTs, 1);
    marker.lastVelocity = {
        dLng: (targetLng - current.lng) / elapsed,
        dLat: (targetLat - current.lat) / elapsed,
        speedMps: Number(vehicle.properties.position_speed) || 0,
    };

    const diffLng = targetLng - current.lng;
    const diffLat = targetLat - current.lat;
    const distMeters = planarMeters(current.lat, current.lng, targetLat, targetLng);

    // GPS-pullback suppression: when DR has projected the marker ahead of where
    // the next GPS fix actually lands (brief speed dip, sub-cadence GPS lag, light-
    // rail street-running stops at red lights), keep the marker at its current
    // visual position and let GPS catch up on the next fix instead of visibly
    // sliding backward. Skipped on first-fix (no DR history), stale-ref (re-anchor
    // needed), terminus (legitimate reversal), and off-route (lastSnap=null — bus
    // needs GPS truth to recover). Bound the backward-along-heading window: <5m is
    // jitter (animate normally), >150m is a real outlier (animate or trip the spike
    // check on the next fix). Cap consecutive suppressions at PULLBACK_MAX_RUN so a
    // genuinely stuck train isn't held permanently ahead of truth — after the cap,
    // the next backward fix lands normally and the marker corrects.
    const PULLBACK_MAX_RUN = 2;
    let suppressPullback = false;
    const _headingDeg = marker.properties.Heading;
    if (!isFirstFix && !isStaleRef && !terminusNow
        && marker.lastSnap && _headingDeg != null
        && (marker._pullbackRun ?? 0) < PULLBACK_MAX_RUN) {
        const _hRad = _headingDeg * Math.PI / 180;
        const _dxM  = diffLng * M_PER_DEG_LNG_LA;
        const _dyM  = diffLat * M_PER_DEG_LAT;
        const _dot  = _dxM * Math.sin(_hRad) + _dyM * Math.cos(_hRad);
        if (_dot < -5 && _dot > -150) suppressPullback = true;
    }
    marker._pullbackRun = suppressPullback ? (marker._pullbackRun ?? 0) + 1 : 0;

    if (suppressPullback) {
        // Re-anchor lastSnap to the marker's kept (DR-projected) visual position so
        // the next DR projection starts from where the marker actually is — without
        // this, DR would re-base from the behind-GPS snap and instantly teleport
        // the marker back to where we tried to suppress pulling it.
        const _curSnap = snapToRoute(vehicle.properties.route_code, current.lng, current.lat);
        if (_curSnap) {
            if (_curSnap.tangentForward == null && marker.lastSnap?.tangentForward != null) {
                _curSnap.tangentForward = marker.lastSnap.tangentForward;
            }
            marker._prevSnap = marker.lastSnap;
            marker.lastSnap = _curSnap;
        }
        // Null the velocity reference so the next spike check doesn't validate
        // against a backward delta (current-DR-position → behind-GPS) as if it
        // were a forward prediction; first fix path then re-anchors cleanly.
        marker.lastVelocity = null;
        updateMarkerTimestamp(marker, vehicle);
        startDeadReckoning(markerKey);
    } else if (distMeters > 5000) { // huge legitimate gap — teleport
        marker.setLngLat([targetLng, targetLat]);
        marker.setRotation(dispHeading);
        // Clear the integrator state so the running rAF (if any) reseeds at
        // the new GPS arc instead of finishing its trip from a stale baseline.
        marker._drCurrentArc = null;
        updateMarkerTimestamp(marker, vehicle);
        startDeadReckoning(markerKey);
    } else if (marker._drActive) {
        // DR is already running — refresh its params on the marker; the
        // continuous tick picks up new speed/heading/cap on the very next
        // frame. Critically, we do NOT cancel + re-animate, which used to
        // synchronize all vehicles in a WS batch into a visible "pulse".
        updateMarkerTimestamp(marker, vehicle);
        startDeadReckoning(markerKey);
    } else {
        // Cold start: there's no running DR loop yet, so smooth the visible
        // jump from the marker's old position to the new GPS position over
        // ~1 s and then hand off to the continuous DR loop.
        animateMarker(markerKey, current, diffLng, diffLat, targetLng, targetLat, dispStart, dispHeading, 60)
            .then(() => {
                // Cleanup may have removed the marker mid-animation (300s staleness sweep,
                // map re-init). Skip the post-animation writes so we don't resurrect a dead
                // marker key or start an rAF loop that targets a non-existent object.
                if (!markers[markerKey]) return;
                updateMarkerTimestamp(marker, vehicle);
                startDeadReckoning(markerKey);
            });
    }
}

/**
 * Apply terminus heading override: when a marker enters or leaves the terminus
 * state, swap the SVG icon and lock rotation to 0 (no directional arrow at
 * terminal holds). Reads marker._terminusNow (set by _applySnap).
 *
 * Mutates: DOM backgroundImage, marker.atTerminus, marker rotation.
 * @param {Object} marker
 * @param {Object} vehicle  Full vehicle Feature (for agency)
 */
export function _applyTerminusHeading(marker, vehicle) {
    const terminusNow = marker._terminusNow;
    if (terminusNow !== marker.atTerminus) {
        const brandColor = routeHexColors[marker.route_code] || '#231f20';
        marker.getElement().style.backgroundImage = markerSvgUrl(vehicle.properties.agency || 'metro', marker.route_code, brandColor, terminusNow);
        marker.atTerminus = terminusNow;
        if (terminusNow) marker.setRotation(0);
    }
}

function updateExistingMarker(vehicle, features, map, markerKey, prevTs) {
    const marker = markers[markerKey];
    if (!marker) return;

    // Don't cancel the DR rAF here. The continuous-loop design keeps the
    // chain alive across WS updates — startDeadReckoning / startBearingDead-
    // Reckoning write fresh params to the marker and the running tick reads
    // them on the next frame. Cancel/restart per WS would re-introduce the
    // synchronized "pulse" across all vehicles in a feed batch.
    //
    // The one case where we DO cancel is an in-flight cold-start animateMarker
    // (1 s glide from old to new GPS position). _drActive only goes true once
    // that glide resolves and hands off to startDeadReckoning; until then, a
    // second WS update would otherwise race a second animateMarker against
    // the first.
    if (animations[markerKey] && !marker._drActive) {
        // Instrumenting the race: a fresh WS update arrived while a cold-start
        // animateMarker glide was still in flight. The glide's targets are now
        // stale; canceling here is correct but represents a brief visible
        // discontinuity if the new GPS lands far from the previous target.
        recordMarkerDrop('animateMarkerRace');
        cancelAnimationFrame(animations[markerKey]);
        delete animations[markerKey];
    }

    const [newLng, newLat] = vehicle.geometry.coordinates;
    const newTs = parseInt(vehicle.properties.timestamp, 10);

    // Skip spike check on the first real update (no velocity/snap reference yet) or
    // when the marker reference has gone stale and needs a fresh anchor.
    // SPIKE_BYPASS_S is decoupled from the FRESH_* visual tiers: this is an
    // algorithmic gate (when velocity history can no longer validate a fix),
    // not a UX one.
    const isFirstFix = !(marker.validFixCount > 0);
    const isStaleRef = (newTs - (marker.timestamp ?? newTs)) > SPIKE_BYPASS_S;
    if (!isFirstFix && !isStaleRef && isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs)) {
        recordMarkerDrop('spike');
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
        // Clear lastVelocity so the next fix isn't measured against a now-stale
        // prediction reference. Without this, persistent GPS corruption (off-track
        // drift, urban-canyon multipath) causes every subsequent fix to be rejected
        // as a spike too — the marker freezes until SPIKE_BYPASS_S bypasses the
        // check entirely 120s later. A null lastVelocity skips the predict-validate
        // branch in isGpsSpike(), letting a real fix re-anchor the marker; the
        // speed and arc gates still catch genuine teleports.
        marker.lastVelocity = null;
        // Render popup from cached marker state, NOT from the spike's vehicle data.
        // A GPS spike often reports a far-ahead stop in the feed, which would show the
        // wrong "next stop" label while the marker position is correctly held in place.
        updatePopup({ properties: marker.properties }, markerKey);
        return;
    }
    marker.validFixCount = (marker.validFixCount ?? 0) + 1;

    // Track strictly-newer GPS readings for spike-rejection. (Visual freshness
    // tier is derived from `marker.timestamp` — any WS arrival, not just
    // strictly-newer — so a feed re-broadcasting a lagged fix still keeps the
    // marker visually live; previously this gate caused vehicles to remain
    // visually faded even when WS updates were arriving.)
    const prevFreshTs = marker._lastFreshTs ?? 0;
    if (newTs > prevFreshTs) marker._lastFreshTs = newTs;
    marker.timestamp = newTs;

    // Re-apply freshness tier so a marker that was faded due to a feed gap
    // immediately reflects the new arrival. Idempotent if tier didn't change.
    const nowSec = Math.floor(Date.now() / 1000);
    applyFreshness(marker, getFreshnessTier(marker, nowSec));

    _applySnap(marker, vehicle);
    _applyVelocityCorrections(marker, vehicle, markerKey, prevTs, isFirstFix, isStaleRef);

    const prevStopId = String(marker.properties.stopId ?? '');
    marker.properties.stopId = vehicle.properties.stopId;
    if (String(vehicle.properties.stopId ?? '') !== prevStopId) {
        // Record observed inter-stop segment time for schedule calibration (EWMA multiplier).
        // Indices are derived from trip.stops by stopId lookup so this works even when
        // the GTFS-RT feed omits currentStopSequence (the prior implementation gated on
        // currentStopSequence and silently never fired for vehicles missing that field).
        // Only fires on adjacent-stop transitions to exclude skipped stops, GPS
        // repositioning, or terminus turnarounds.
        const tripId_c       = vehicle.properties.trip_id ?? marker.properties.trip_id;
        const rc             = vehicle.properties.route_code ?? marker.route_code;
        const dir            = vehicle.properties.direction_id != null
            ? Number(vehicle.properties.direction_id)
            : marker.properties.direction_id;
        // getTripStops handles the static-GTFS → route-cache fallback for
        // trip IDs that aren't in masterTripsData (e.g. B Line owl-service).
        const { stops, scheduledTimes } = getTripStops(tripId_c, rc, dir);
        const prevStatusChangedAt = marker.properties.statusChangedAt;
        if (prevStatusChangedAt && stops?.length && scheduledTimes?.length === stops.length) {
            // Use findIdx (fuzzy) instead of indexOf (exact) so stop IDs with
            // directional suffixes (e.g. "80402N" in feed vs "80402" in cache)
            // still match.
            const newIdx      = findIdx(stops, vehicle.properties.stopId);
            const prevStopIdx = prevStopId ? findIdx(stops, prevStopId) : -1;
            if (prevStopIdx >= 0 && newIdx === prevStopIdx + 1) {
                const scheduledSec = scheduledTimes[newIdx] - scheduledTimes[prevStopIdx];
                const observedSec  = newTs - prevStatusChangedAt;
                recordSegmentTime(rc, dir, observedSec, scheduledSec);
            }
        }
        marker.properties.statusChangedAt = newTs;
        // Snapshot the arc position at the moment of the status/stop transition.
        // The STOPPED_AT-misfire predicate reads this to detect arc drift while
        // the feed claims the vehicle has been stopped at the same stop.
        marker.properties.arcAtStatusChange = marker.lastSnap?.arcMeters ?? null;
    }
    // Always write — including when the new value is null. Previously we
    // only wrote when non-null, which retained a STALE direction across feed
    // frames where direction_id was momentarily omitted. Downstream paths
    // (computeHeading, arcSign resolution, station-popup column placement)
    // would then read the OLD direction and route the train into the wrong
    // direction column on the popup, risking a rider boarding the wrong way.
    marker.properties.direction_id  = vehicle.properties.direction_id != null
        ? Number(vehicle.properties.direction_id)
        : null;
    // Clear the misfire-recorded flag when the feed transitions OUT of
    // STOPPED_AT so the next detected misfire emits a fresh counter event.
    const _prevStatus = marker.properties.currentStatus;
    marker.properties.currentStatus = vehicle.properties.currentStatus ?? null;
    if (_prevStatus !== marker.properties.currentStatus &&
        !isStoppedAt(marker.properties.currentStatus)) {
        marker._stoppedAtMisfireRecorded = false;
    }

    // End-of-line dwell tracking: when a vehicle becomes stopped at the last
    // stop of its current trip, record the time so the cleanup loop can fade
    // it out after TERMINUS_LINGER_S. Cleared as soon as the vehicle leaves
    // that state (status changes, stop changes, or trip changes). Pass the
    // misfire flag so a vehicle whose STOPPED_AT is a feed glitch (real motion
    // observed) doesn't get scheduled for fade-out while still active.
    if (_isAtEndOfLine(marker.properties, !!marker.properties?._misfireOverride)) {
        if (!marker._endOfLineSinceTs) {
            marker._endOfLineSinceTs = Math.floor(Date.now() / 1000);
        }
    } else {
        marker._endOfLineSinceTs = null;
    }

    _applyTerminusHeading(marker, vehicle);

    applyOriginVisibility(marker, marker.properties);

    updatePopup(vehicle, markerKey);
}

/**
 * Suppress visible marker when STOPPED_AT the route's own origin (idx=0). The
 * marker object stays alive — only its DOM element is hidden — so popups, ETAs,
 * and highlights still work. Boarding badges in stations.js take over the visual.
 * Exported for unit testing.
 * @param {Object} marker  Marker with .getElement()
 * @param {Object} props   Properties bag (route_code, currentStatus, stopId, …)
 */
export function applyOriginVisibility(marker, props) {
    const el = marker.getElement?.();
    if (!el) return;
    // A STOPPED_AT misfire (observed motion contradicts the "at stop" flag)
    // means the vehicle is actually departing — don't hide it. The hide is
    // intended only for vehicles genuinely sitting at their origin platform.
    const misfire = !!marker.properties?._misfireOverride;
    const hidden  = !misfire && isAtOwnOriginStop(props);
    el.style.visibility   = hidden ? 'hidden' : 'visible';
    el.style.pointerEvents = hidden ? 'none' : '';
}

function updateMarkerTimestamp(marker, vehicle) {
    if (vehicle.properties) {
        const newTs = parseInt(vehicle.properties.timestamp, 10);
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
    }
}

function updatePopup(vehicle, markerKey) {
    const marker = markers[markerKey];
    const popup = marker?.getPopup();
    if (!popup) return;
    const agency = vehicle.properties.agency || 'metro';
    const { stopId, currentStatus, direction_id, currentStopSequence } = vehicle.properties;
    const tripId = marker.properties.trip_id;
    const secToNextStop   = getVehicleEtaSecs(marker);
    const boardingDepSecs = getBoardingDepSecs(marker);
    const popupHtml = getPopupHTML(marker.route_code, vehicle.properties.vehicle_id, marker.vehicleLabel, marker.timestamp, stopId, currentStatus, direction_id, tripId, currentStopSequence, agency, secToNextStop, boardingDepSecs);
    // Read prevTs BEFORE setHTML so the comparison below has the old value.
    const prevTs = Number(popup.getElement()?.querySelector('.pv2-time[data-ts]')?.dataset.ts) || 0;
    popup.setHTML(popupHtml); // safe: feed values escaped via escapeHtml() in getPopupHTML
    // Sync data-ts to the freshest available timestamp: max(prevTs, marker.timestamp).
    // - When a fresh GPS fix has bumped marker.timestamp, the popup updates to the new
    //   age (a legitimate "backwards" jump that signals live data).
    // - When prevTs is somehow newer than marker.timestamp (a no-op refresh that re-bakes
    //   the same value, or a transient DOM/state mismatch), preservation protects against
    //   a false-backwards visual blip. Prior behavior unconditionally pinned to prevTs,
    //   which froze the age counter at popup-open forever even as fresh fixes arrived.
    const liveTs = Math.max(prevTs, marker.timestamp || 0);
    if (liveTs > 0) {
        const timeEl = popup.getElement()?.querySelector('.pv2-time[data-ts]');
        if (timeEl) {
            timeEl.dataset.ts = String(liveTs);
            const age = Math.max(0, Math.floor(Date.now() / 1000 - liveTs));
            timeEl.querySelector('.pv2-secs').textContent = age + 's';
        }
    }
}

// Returns seconds until this vehicle reaches its next stop, using the same
// GTFS-RT + GPS-corrected logic as the station popup (so both always agree).
// Uses isEffectivelyStopped (not raw isStoppedAt) so a STOPPED_AT-misfiring
// vehicle keeps showing a live ETA in the popup — matching what
// getScheduledArrivals reports for the same vehicle in the station popup.
function getVehicleEtaSecs(marker) {
    const { stopId, vehicle_id, trip_id } = marker.properties ?? {};
    if (!stopId) return null;
    if (isEffectivelyStopped(marker)) return 0;
    const now = Math.floor(Date.now() / 1000);
    const arrivals = getScheduledArrivals(String(stopId));
    const entry = arrivals.find(a => a.vehicleId === vehicle_id || a.tripId === trip_id);
    if (entry) return Math.max(0, entry.arrivalUnix - now);
    return getSecondsToNextStop(marker);
}

// Returns seconds until departure when a vehicle is boarding at an origin terminus,
// or null when the vehicle isn't at an origin terminus (caller shows normal ETA).
// Boarding semantics require the vehicle to *actually* be at the origin stop,
// so we gate on isEffectivelyStopped (excludes STOPPED_AT misfires that are
// really moving — those should fall back to the normal next-stop ETA).
function getBoardingDepSecs(marker) {
    const { stopId, vehicle_id, trip_id, route_code, direction_id } = marker.properties ?? {};
    if (!isEffectivelyStopped(marker) || !stopId || !route_code) return null;
    const dir = direction_id != null ? Number(direction_id) : null;
    if (dir === null) return null;
    if (!isOriginStop([String(stopId)], route_code, dir)) return null;
    const now  = Math.floor(Date.now() / 1000);
    const list = window.masterArrivalsData?.get(String(stopId)) ?? [];
    const dep  = list.find(e => e.tripId === trip_id || e.vehicleId === vehicle_id);
    return dep ? Math.max(0, dep.arrivalUnix - now) : 0;
}

/**
 * Halt any active DR loop for a marker and clear _drActive. Preserves
 * _drCurrentArc (the integrator state) so a future start() picks up from the
 * last visual position; the rAF handle is dropped so no further frames render.
 */
function _stopDr(markerKey) {
    const m = markers[markerKey];
    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
        delete animations[markerKey];
    }
    if (m) {
        m._drActive = false;
        // Close out any in-progress freeze episodes so they're counted exactly
        // once. Without this, a marker that paused at an intersection (or
        // exhausted its bearing budget) and never recovered would never emit.
        if (m._intersectionPauseStartedAt) {
            recordMarkerDrop('intersectionPause');
            m._intersectionPauseStartedAt = 0;
        }
        if (m._bearingBudgetExhaustedAt) {
            // Don't re-record here — bearing budget exhausted is already counted
            // on the transition into exhaustion. Just clear the flag.
            m._bearingBudgetExhaustedAt = 0;
        }
    }
}

/**
 * Fallback DR for routes without shape data (G/J busway): straight-line projection
 * along the marker's heading at smoothed speed × DR_SPEED_FACTOR. Caps at 0.9× the
 * distance to the next stop, or speed × DR_MAX_SECONDS when no stop is known.
 *
 * Continuous-loop design: the rAF chain runs until DR legitimately halts
 * (STOPPED_AT, watchdog timeout, marker deletion). Each call writes fresh
 * params (m._drBearing, m._drSpeed, m._drMaxRemaining, m._drStartedAt) and
 * ensures the loop is running. _bearingTick reads those params fresh each
 * frame, so velocity/heading updates apply on the next frame (≤16 ms) instead
 * of resetting t0 + restarting the rAF on every WS update — which previously
 * produced a synchronized "pulse" across all vehicles. Exported for tests.
 * @param {string} markerKey trip_id key in the module-level markers object
 */
export function startBearingDeadReckoning(markerKey) {
    const m = markers[markerKey];
    if (!m) return;
    if (isStoppedAt(m.properties?.currentStatus)) {
        _stopDr(markerKey);
        return;
    }
    // Busway has no shape data, so lastSnap is always null — Heading is the only
    // sensible source. computeHeading has already disambiguated it via downstreamBearing.
    const bearing = m?.properties?.Heading;
    const speed   = (Number(m?.properties?.smoothedSpeed ?? m?.properties?.speed) || 0) * DR_SPEED_FACTOR;
    if (bearing == null) return;
    // No cold-start speed gate: _bearingTick's pause-but-keep-alive branch
    // uses the same STATIONARY_SPEED_MPS threshold and the same response
    // (don't advance, reschedule). Spawning the loop and letting it idle
    // costs ~1 rAF call per frame (negligible — closure is cached on the
    // marker as _bearingTickCb). Eliminating this redundant gate lets a bus
    // whose modem reports stale speed=0 cold-start eventually advance as
    // soon as _applyVelocityCorrections's GPS-derived smoothedSpeed crosses
    // the threshold, instead of being frozen until a non-zero feed value.

    const here = m.getLngLat();
    const nextStop = window.masterStopsData?.[String(m.properties?.stopId)];
    const maxDist  = nextStop?.lat
        ? planarMeters(here.lat, here.lng, nextStop.lat, nextStop.lon) * 0.9
        : speed * DR_MAX_SECONDS;

    // Refresh integrator params (read by _bearingTick each frame).
    // _drTargetSpeed is the new "truth" — the tick lerps _drSpeed toward it
    // each frame so velocity transitions are visually smooth across WS updates
    // (no single-frame snap from old smoothed speed to new). On cold start we
    // seed _drSpeed directly so the first frame is immediate.
    m._drMode = 'bearing';
    m._drTargetSpeed = speed;
    m._drBearing = bearing;
    m._drMaxRemaining = maxDist;
    m._drStartedAt = performance.now();
    // Fresh WS update replenishes the budget — clear any previous exhaustion record
    // so the next exhaustion (with a new budget) emits its own freeze-episode record.
    m._bearingBudgetExhaustedAt = 0;

    // First-run / wake-up: seed the dt clock and clear any stale animation
    // handle (e.g. a completed cold-start animateMarker or a fake-timer
    // ghost) so the new rAF chain actually queues. On subsequent calls
    // (loop already integrating) we want fresh params, not a phantom dt jump.
    const wasActive = m._drActive;
    if (!wasActive) {
        m._drSpeed = speed;
        m._drLastTick = performance.now();
        if (animations[markerKey]) {
            cancelAnimationFrame(animations[markerKey]);
            delete animations[markerKey];
        }
    }
    m._drActive = true;
    // Cache the rAF callback once per marker so we don't allocate a fresh
    // closure (and a fresh string key in the closure) on every frame.
    m._bearingTickCb ??= () => _bearingTick(markerKey);

    if (animations[markerKey] == null) {
        animations[markerKey] = requestAnimationFrame(m._bearingTickCb);
    }
}

function _bearingTick(markerKey) {
    const m = markers[markerKey];
    if (!m || !m._drActive) {
        delete animations[markerKey];
        return;
    }
    const now = performance.now();
    // Cap dt to bound jumps when the tab was throttled or the loop resumed
    // after a long pause. A frame longer than 100 ms is treated as 100 ms of
    // forward integration; the next frame catches up via real time.
    const dt = Math.min((now - (m._drLastTick ?? now)) / 1000, 0.1);
    m._drLastTick = now;

    // Watchdog: caps total time since the most recent GPS update. _drStartedAt
    // is reset by every startBearingDeadReckoning call, so the loop only trips
    // this when the WS feed has actually gone silent. Reads m._drMaxSec (set by
    // the caller — bus = DR_MAX_SECONDS, rail-without-shape-data fall-through
    // = DR_MAX_SECONDS_RAIL) instead of hardcoding DR_MAX_SECONDS, so rail
    // fall-throughs from startDeadReckoning get the 60 s rail budget rather
    // than the 20 s bus budget that _arcTick already reads correctly.
    if ((now - (m._drStartedAt ?? now)) / 1000 > (m._drMaxSec ?? DR_MAX_SECONDS)) {
        recordMarkerDrop('watchdogBus');
        _stopDr(markerKey);
        return;
    }

    const liveSpeed = Number(m.properties?.smoothedSpeed ?? m.properties?.speed) || 0;
    if (liveSpeed < STATIONARY_SPEED_MPS) {
        // Pause-but-keep-alive: a transient zero read shouldn't kill DR.
        animations[markerKey] = requestAnimationFrame(m._bearingTickCb);
        return;
    }

    if (!(m._drMaxRemaining > 0)) {
        // Bearing-DR budget exhausted (planar distance to next stop consumed).
        // Episode-gated: one record per transition into exhaustion.
        if (!m._bearingBudgetExhaustedAt) {
            recordMarkerDrop('bearingBudgetExhausted');
            m._bearingBudgetExhaustedAt = now;
        }
        animations[markerKey] = requestAnimationFrame(m._bearingTickCb);
        return;
    }

    // Glide _drSpeed toward _drTargetSpeed with exponential damping. After a
    // WS update bumps the target, the integrator ramps over ~3·τ instead of
    // snapping in one frame — eliminates the visible per-vehicle "jerk".
    const lerp = 1 - Math.exp(-dt / DR_SPEED_GLIDE_TAU_S);
    m._drSpeed += ((m._drTargetSpeed ?? m._drSpeed) - m._drSpeed) * lerp;

    const speed = m._drSpeed;
    const rad   = m._drBearing * Math.PI / 180;
    const advance = Math.min(speed * dt, m._drMaxRemaining);
    m._drMaxRemaining -= advance;

    const here = m.getLngLat();
    m.setLngLat([
        here.lng + (advance * Math.sin(rad)) / M_PER_DEG_LNG_LA,
        here.lat + (advance * Math.cos(rad)) / M_PER_DEG_LAT,
    ]);

    animations[markerKey] = requestAnimationFrame(m._bearingTickCb);
}

/**
 * Average scheduled segment speed (m/s) between the prior stop and the marker's
 * declared next stop. Used as a fallback for heavy rail (B/D) when GPS speed is
 * zero — those lines run in tunnels where the radio drops out but the train is
 * still physically moving. Returns null when stops/scheduledTimes are unavailable
 * or the computed speed isn't sane (capped at RAIL_MAX_SPEED_MPS).
 */
function _heavyRailScheduleSpeed(marker, snap, routeCd) {
    const props = marker?.properties;
    if (!props || !snap || !routeCd) return null;

    const dir = props.direction_id != null ? Number(props.direction_id) : null;
    const { stops, scheduledTimes } = getTripStops(props.trip_id, String(routeCd), dir);
    if (!stops?.length || scheduledTimes?.length !== stops.length) return null;

    const newIdx = findIdx(stops, props.stopId);
    if (newIdx <= 0) return null; // no prior stop to bound the segment

    const prevStop = window.masterStopsData?.[String(stops[newIdx - 1])];
    const nextStop = window.masterStopsData?.[String(stops[newIdx])];
    if (!prevStop?.lat || !prevStop?.lon || !nextStop?.lat || !nextStop?.lon) return null;

    const prevSnap = snapToRoute(routeCd, prevStop.lon, prevStop.lat);
    const nextSnap = snapToRoute(routeCd, nextStop.lon, nextStop.lat);
    if (!prevSnap || !nextSnap) return null;

    const segDistM = Math.abs(nextSnap.arcMeters - prevSnap.arcMeters);
    const segSec   = scheduledTimes[newIdx] - scheduledTimes[newIdx - 1];
    if (!(segDistM > 0) || !(segSec > 0)) return null;

    const v = (segDistM / segSec) * DR_SPEED_FACTOR;
    if (!Number.isFinite(v) || v <= 0) return null;
    return Math.min(v, RAIL_MAX_SPEED_MPS);
}

/**
 * Arc-progression DR for rail routes: walks the polyline in arc-distance so the
 * marker stays on the track through curves. Heading recomputed each frame from
 * the dead-reckoned position's local tangent. Kinematic deceleration ramp in
 * the final DR_DECEL_ZONE_M. Exits after DR_MAX_SECONDS or when the next-stop
 * arc cap is reached. Exported for unit testing.
 * Pauses automatically when speed is zero; resumes on next VP update.
 * @param {string} markerKey trip_id key in the module-level markers object
 */
export function startDeadReckoning(markerKey) {
    const m        = markers[markerKey];
    if (!m) return;
    const snap     = m?.lastSnap;
    const rawSpeed = (Number(m?.properties?.smoothedSpeed ?? m?.properties?.speed) || 0) * DR_SPEED_FACTOR;
    const routeCd  = m?.route_code;
    const isRail   = !isBusRoute(String(routeCd ?? ''));
    const heavy    = isHeavyRail(String(routeCd ?? ''));
    const drMaxSec = isRail ? DR_MAX_SECONDS_RAIL : DR_MAX_SECONDS;

    // Heavy rail (B/D) is fully grade-separated — STOPPED_AT mid-tunnel is always
    // a stale feed flag, never a real stop. Honor STOPPED_AT only when actually
    // within HEAVY_RAIL_STOPPED_AT_MAX_M of the declared stop's coordinates.
    //
    // STOPPED_AT-misfire override (rail + bus): if the feed claims STOPPED_AT
    // but the vehicle is clearly moving (high speed OR long-stopped+arc-moved),
    // skip the halt branch entirely. Same predicate as _applySnap so the snap
    // target and the DR halt decision stay consistent.
    const _drStoppedAt = isStoppedAt(m.properties?.currentStatus);
    const _drMisfire = _drStoppedAt && _isStoppedAtMisfire(
        m,
        Number(m.properties?.smoothedSpeed ?? m.properties?.speed) || 0,
        Number(m.timestamp),
    );
    if (_drStoppedAt && !_drMisfire) {
        if (!heavy) {
            // Light rail STOPPED_AT — vehicle is genuinely at a station; halt DR.
            _stopDr(markerKey);
            return;
        }
        const stop = window.masterStopsData?.[String(m.properties?.stopId)];
        const here = m.getLngLat();
        if (!stop?.lat || !stop?.lon ||
            planarMeters(here.lat, here.lng, stop.lat, stop.lon) <= HEAVY_RAIL_STOPPED_AT_MAX_M) {
            // Heavy rail near declared stop — let the platform proximity hold.
            // Don't kill DR (the loop's pause-but-keep-alive handles transient
            // zero-speed reads), but don't refresh params either.
            return;
        }
        // Past the proximity gate → fall through and dead-reckon anyway.
    }

    if (!snap) {
        recordMarkerDrop('noSnap');
        return;
    }
    // Rail speed=0 fallback. Heavy rail (B/D) is 100 % grade-separated, so
    // GPS=0 is always tunnel dropout — always fall back. Light rail falls back
    // only when the marker is NOT near a known at-grade crossing; near one
    // (gated or traffic-light), GPS=0 is a legitimate red-light/gate stop.
    // Crossing set: data/light-rail-intersections.json.
    const here = m.getLngLat();
    const useFallback = isRail && rawSpeed < STATIONARY_SPEED_MPS &&
                        (heavy || !isNearIntersection(here.lat, here.lng));
    const speed = useFallback
        ? (_heavyRailScheduleSpeed(m, snap, routeCd) ?? DR_HEAVY_RAIL_FALLBACK_MPS)
        : rawSpeed;
    // No cold-start speed gate: _arcTick's pause-but-keep-alive branch uses
    // the same STATIONARY_SPEED_MPS threshold and produces the same
    // user-visible behavior (no advance). Eliminating the redundant gate lets
    // a marker whose feed reports cold-start speed=0 (bus modem quirk, GPS
    // re-acquisition) eventually advance via the GPS-derived smoothedSpeed
    // rather than freezing until a non-zero feed value arrives.

    // Busway routes have no shape data — use straight-line projection. Seed
    // _drMaxSec so _bearingTick's watchdog uses the route-appropriate budget
    // (rail-without-shape-data fall-throughs get DR_MAX_SECONDS_RAIL instead
    // of being truncated to the bus default).
    if (!hasShapeData(routeCd)) {
        m._drMaxSec = drMaxSec;
        return startBearingDeadReckoning(markerKey);
    }

    // Arc direction: compare a "direction of travel" reference bearing against
    // the polyline tangent. arcSign = +1 means walk arc-forward; -1 means walk
    // arc-backward (for trips defined opposite to polyline orientation).
    //
    // **Reference resolution mirrors computeHeading():** downstreamBearing alone
    // is NOT safe — after a station pass the feed's stopId lags 10-30 s and
    // downstream then points BACKWARD at the stop just left, which flips
    // arcSign to the wrong value and the marker traverses the route in reverse
    // until the next stopId update. Cross-check against upstreamBearing (which
    // walks past stops the train has demonstrably visited): when both exist
    // and disagree > 90°, trust upstream — same logic as computeHeading.
    let arcSign = +1;
    const downstream = downstreamBearing(m.properties, snap.snappedLng, snap.snappedLat);
    const upstream   = upstreamBearing(m.properties, snap.snappedLng, snap.snappedLat);

    let reference;
    if (downstream != null && upstream != null) {
        const refDelta = _shortestBearingDelta(downstream, upstream);
        reference = Math.abs(refDelta) > 90 ? upstream : downstream;
    } else {
        reference = downstream ?? upstream;
    }

    if (reference != null && snap.tangentForward != null) {
        const delta = _shortestBearingDelta(reference, snap.tangentForward);
        arcSign = Math.abs(delta) < 90 ? +1 : -1;
    } else {
        // Fallback: use previous snap direction if both bearings unavailable
        // (no stop data, first fix, owl-service trips) or no tangent (degenerate
        // polyline segment).
        const prevSnap = m._prevSnap;
        if (prevSnap && Math.abs(snap.arcMeters - prevSnap.arcMeters) > 5) {
            arcSign = snap.arcMeters > prevSnap.arcMeters ? +1 : -1;
        } else if (m.properties?.Heading != null && snap.tangentForward != null) {
            // Both heading and tangent are known — compare them.
            const delta = _shortestBearingDelta(m.properties.Heading, snap.tangentForward);
            arcSign = Math.abs(delta) < 90 ? +1 : -1;
        } else {
            // Heading or tangent unknown (degenerate segment + cold start). Default to
            // forward; the next snap update will resolve direction via the primary path.
            // Without this guard, _shortestBearingDelta(null, …) → NaN → arcSign = -1
            // would silently send a fresh marker backward.
            arcSign = +1;
        }
    }

    // baseArc = the marker's furthest-along arc position. Cold start uses the
    // fresh snap; warm DR uses whichever is further along in travel direction
    // (max for arcSign=+1, min for -1). The scan fallback below uses this as
    // the reference point — so a fresh GPS snap that lands BEHIND the
    // integrator never re-introduces a cap that's already behind us.
    const drArc = m._drCurrentArc;
    const baseArc = drArc == null
        ? snap.arcMeters
        : (arcSign > 0 ? Math.max(snap.arcMeters, drArc) : Math.min(snap.arcMeters, drArc));

    // Next-stop cap. Priority:
    //   1. Declared stopId, STOPPED_AT only (from the feed) — the user-facing
    //      "marker never past the stop it's AT" invariant. _applySnap has
    //      already clamped snap.arcMeters to this same cap, so by construction
    //      the integrator never starts past it. Returns null for IN_TRANSIT_TO
    //      so an in-transit train is never yanked back to a lagged stopId.
    //   2. Scan first stop ahead of baseArc in travel direction — fallback
    //      for when no declared cap is available (IN_TRANSIT_TO, missing
    //      field, terminus, owl-service trips with non-cached IDs). Bounds
    //      coasting at the next physical stop without yanking backward.
    //
    // Critical: arcs are stored in TRIP-SEQUENCE order, not ascending polyline
    // order. For direction_id = 1 they DESCEND along the polyline. Direction
    // is carried by arcSign — NEVER sort the arcs array, or dir=1 trips will
    // walk backward along the route on every snap update.
    let stopArcCap = null;
    const _declared = _declaredStopArcCap(m.properties, _drMisfire);
    if (_declared != null) {
        stopArcCap = _declared.arc;
    } else {
        const dir   = m.properties?.direction_id;
        const cache = (routeCd != null && dir != null) ? getRouteCache(routeCd, dir) : null;
        const arcs  = cache?.arcMeters;
        if (arcs?.length) {
            if (arcSign > 0) {
                for (const arc of arcs) {
                    if (arc != null && arc > baseArc) { stopArcCap = arc; break; }
                }
            } else {
                for (let i = arcs.length - 1; i >= 0; i--) {
                    const arc = arcs[i];
                    if (arc != null && arc < baseArc) { stopArcCap = arc; break; }
                }
            }
        }
    }

    // Refresh integrator params on the marker. _drTick reads these fresh each
    // frame, so a velocity/direction change from a new WS update applies on
    // the very next frame (≤16 ms) instead of resetting t0 + restarting the
    // rAF — which previously produced a synchronized "pulse" on every batch.
    m._drMode      = 'arc';
    // _drTargetSpeed is the new "truth"; _arcTick lerps _drSpeed toward it
    // each frame so a WS-driven smoothedSpeed change ramps over ~3·τ instead
    // of stepping in one frame. Cold start seeds _drSpeed directly below.
    m._drTargetSpeed = speed;
    m._drArcSign   = arcSign;
    m._drStopArcCap = stopArcCap;
    m._drHeavy     = heavy;
    m._drRouteCd   = routeCd;
    m._drMaxSec    = drMaxSec;
    m._drStartedAt = performance.now();   // reset watchdog on each WS update
    // Invalidate the cached near-intersection result — a fresh fix may have
    // teleported the marker to a different position than the last check.
    m._nearIntersectionAt = 0;

    // First-run / wake-up: seed the integrator at the GPS snap arc and start
    // the dt clock. Any leftover animation handle (e.g. a completed cold-start
    // animateMarker, or a stale handle from a prior test using fake timers)
    // must be cleared so the new rAF chain starts fresh — otherwise the
    // "if animations == null" gate below skips the schedule and the loop
    // never ticks. On re-entry while already active, _drCurrentArc holds the
    // loop's last visual position, so we preserve it (target-chasing).
    const wasActive = m._drActive;
    if (!wasActive || m._drCurrentArc == null) {
        m._drSpeed      = speed;            // seed without easing on cold start
        m._drCurrentArc = snap.arcMeters;
        m._drLastTick   = performance.now();
        if (animations[markerKey]) {
            cancelAnimationFrame(animations[markerKey]);
            delete animations[markerKey];
        }
        // Cold-start: defense-in-depth clamp. _applySnap normally clamps
        // snap.arcMeters first, but callers can land here via a direct
        // lastSnap assignment (tests, edge paths) — re-enforce the invariant
        // so the integrator never STARTS past the declared cap.
        if (stopArcCap != null) {
            m._drCurrentArc = arcSign > 0
                ? Math.min(m._drCurrentArc, stopArcCap)
                : Math.max(m._drCurrentArc, stopArcCap);
        }
    } else if (stopArcCap != null) {
        // Warm DR: enforce the cap against the integrator state too. If the
        // declared stop was just tightened (feed corrected stopId backward,
        // or a previously-unknown declared stopId just appeared and lands
        // behind the integrator's current position), pull _drCurrentArc back
        // so the next frame doesn't render past the declared stop. The
        // per-frame clamp inside _arcTick would do this on the next tick
        // anyway, but applying it here keeps the integrator state and the
        // cap consistent for any same-tick consumer.
        m._drCurrentArc = arcSign > 0
            ? Math.min(m._drCurrentArc, stopArcCap)
            : Math.max(m._drCurrentArc, stopArcCap);
    }
    m._drActive = true;
    // Cache the rAF callback once per marker — eliminates per-frame closure
    // allocations across the integrator loop.
    m._arcTickCb ??= () => _arcTick(markerKey);

    if (animations[markerKey] == null) {
        animations[markerKey] = requestAnimationFrame(m._arcTickCb);
    }
}

function _arcTick(markerKey) {
    const m = markers[markerKey];
    if (!m || !m._drActive) {
        delete animations[markerKey];
        return;
    }
    const now = performance.now();
    // Cap dt at 100 ms to bound jumps when the tab was throttled or the loop
    // resumed from a pause. The next frame catches up via real time.
    const dt = Math.min((now - (m._drLastTick ?? now)) / 1000, 0.1);
    m._drLastTick = now;

    // Watchdog: caps total time since the most recent GPS update. Reset by
    // every startDeadReckoning call, so the loop only trips this when the WS
    // feed has actually gone silent.
    if ((now - (m._drStartedAt ?? now)) / 1000 > (m._drMaxSec ?? DR_MAX_SECONDS)) {
        recordMarkerDrop('watchdogRail');
        _stopDr(markerKey);
        return;
    }

    // Pause-but-keep-alive: light rail at speed=0 near a crossing freezes here.
    // Heavy rail and light-rail-in-tunnel fall through to the integrator, which
    // advances at _drTargetSpeed (set to the fallback in startDeadReckoning).
    //
    // isNearIntersection scans 263 points × planarMeters each call. At 60 fps
    // that's ~16 k planarMeters/sec per stationary light-rail marker — wasted
    // work since a stationary marker's answer can't change frame-to-frame.
    // Throttle the lookup to once per 500 ms; cache the boolean on the marker.
    const _p = m.properties;
    if ((Number(_p?.smoothedSpeed ?? _p?.speed) || 0) < STATIONARY_SPEED_MPS && !m._drHeavy) {
        const lastCheck = m._nearIntersectionAt ?? 0;
        let near;
        if (now - lastCheck < 500) {
            near = m._nearIntersectionCached;
        } else {
            const here = m.getLngLat();
            near = isNearIntersection(here.lat, here.lng);
            m._nearIntersectionAt     = now;
            m._nearIntersectionCached = near;
        }
        if (near) {
            // Episode-gated: one record per pause-session.
            if (!m._intersectionPauseStartedAt) m._intersectionPauseStartedAt = now;
            animations[markerKey] = requestAnimationFrame(m._arcTickCb);
            return;
        }
    }
    // We did NOT pause this frame. If we were paused on a prior frame, emit
    // the close-out record now so the freeze episode is counted exactly once.
    if (m._intersectionPauseStartedAt) {
        recordMarkerDrop('intersectionPause');
        m._intersectionPauseStartedAt = 0;
    }

    // Glide _drSpeed toward _drTargetSpeed with exponential damping. WS-driven
    // target changes ramp over ~3·τ instead of stepping in one frame, removing
    // the visible velocity-snap "jerk" on each batch.
    const lerp = 1 - Math.exp(-dt / DR_SPEED_GLIDE_TAU_S);
    m._drSpeed += ((m._drTargetSpeed ?? m._drSpeed) - m._drSpeed) * lerp;

    const arcSign    = m._drArcSign;
    const stopArcCap = m._drStopArcCap;
    let speed        = m._drSpeed;

    // Instantaneous kinematic decel: speed inside the decel zone is determined
    // by remaining distance via v² = 2·a·s. This replaces the previous closure-
    // captured _decelStartArc / _t_decel / _t_stop state and is mathematically
    // equivalent at every point inside the zone — but reads target speed fresh
    // each frame so an updated GPS speed (or a direction flip) takes effect on
    // the next tick instead of being baked into the constants at DR start.
    if (stopArcCap != null && speed > 0) {
        const remaining = arcSign > 0
            ? Math.max(0, stopArcCap - m._drCurrentArc)
            : Math.max(0, m._drCurrentArc - stopArcCap);
        // Decel zone: bounded above by physics distance v²/(2a) so we don't
        // start braking before it would actually be needed, and by the static
        // DR_DECEL_ZONE_M visual envelope so high-speed approaches don't
        // reserve more ramp than configured.
        const decelZone = Math.min(
            (m._drSpeed * m._drSpeed) / (2 * DR_DECEL_RATE_MPS2),
            DR_DECEL_ZONE_M,
        );
        if (remaining < decelZone) {
            speed = Math.min(speed, Math.sqrt(2 * DR_DECEL_RATE_MPS2 * remaining));
        }
    }

    let nextArc = m._drCurrentArc + arcSign * speed * dt;
    if (stopArcCap != null) {
        // Cap is derived per-startDR from baseArc (the marker's furthest-along
        // position), so by construction stopArcCap > _drCurrentArc in the +1
        // direction (< for -1). No "already past" escape hatch needed.
        nextArc = arcSign > 0
            ? Math.min(nextArc, stopArcCap)
            : Math.max(nextArc, stopArcCap);
    }

    m._drCurrentArc = nextArc;
    const pos = lngLatAtArc(m._drRouteCd, nextArc);
    if (!pos) {
        _stopDr(markerKey);
        return;
    }

    m.setLngLat([pos.lng, pos.lat]);
    // Heading: use the local polyline tangent at the dead-reckoned position so
    // the marker rotates through curves naturally. Choose the ±180° orientation
    // by smallest delta to marker.properties.Heading — the value computeHeading
    // resolved on the last WS frame using upstream+downstream disambiguation.
    // This prevents arcSign (a single flag that can be wrong when downstream
    // is lagged) from silently flipping the arrow 60×/sec; arcSign still governs
    // arc-direction of motion above. Fall back to arcSign-based orientation only
    // when no prior heading exists (cold start before any computeHeading call).
    if (!m.atTerminus && pos.tangent != null) {
        const ref = m.properties?.Heading;
        if (ref != null) {
            const delta = _shortestBearingDelta(ref, pos.tangent);
            m.setRotation(Math.abs(delta) < 90 ? pos.tangent : (pos.tangent + 180) % 360);
        } else {
            m.setRotation(arcSign > 0 ? pos.tangent : (pos.tangent + 180) % 360);
        }
    }

    animations[markerKey] = requestAnimationFrame(m._arcTickCb);
}

function animateMarker(markerKey, startCoords, diffLng, diffLat, targetLng, targetLat, startHeading, targetHeading, steps) {
    return new Promise(resolve => {
        const headingDelta = _shortestBearingDelta(targetHeading, startHeading);
        const skipHeadingAnim = Math.abs(headingDelta) < 1;
        const m0 = markers[markerKey];
        if (m0 && skipHeadingAnim) m0.setRotation(targetHeading);

        let i = 0;
        function animate() {
            const m = markers[markerKey];
            if (!m) { delete animations[markerKey]; return resolve(); }
            if (i <= steps) {
                const progress = i / steps;
                const eased = progress < 0.5
                    ? 4 * progress * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                m.setLngLat([startCoords.lng + eased * diffLng, startCoords.lat + eased * diffLat]);
                if (!skipHeadingAnim)
                    m.setRotation((startHeading + eased * headingDelta + 360) % 360);
                i++;
                animations[markerKey] = requestAnimationFrame(animate);
            } else {
                if (targetLng != null && targetLat != null) m.setLngLat([targetLng, targetLat]);
                m.setRotation(targetHeading);
                delete animations[markerKey];
                resolve();
            }
        }
        animate();
    });
}

/**
 * Apply a visual freshness tier to a marker. Sets opacity per _TIER_OPACITY and
 * stores the tier on the marker so we no-op on idempotent calls.
 *
 * Caller is responsible for routing 'expired' to `_fadeOutAndRemove` —
 * applyFreshness skips it.
 *
 * Keeps MapLibre's internal `_opacity` in sync so `_update()` (fired on every
 * zoom/pan) doesn't overwrite the inline opacity we set.
 *
 * @param {Object} marker
 * @param {'live'|'aging'|'stale'|'expired'} tier
 * @param {boolean} [animated=true]  false for initial render (no fade-in flash)
 */
function applyFreshness(marker, tier, animated = true) {
    if (!marker || tier === 'expired') return;
    const prevTier = marker._tier;
    if (prevTier === tier) return;
    marker._tier = tier;
    const el = marker.getElement?.();
    if (!el) return;

    const op     = _TIER_OPACITY[tier] ?? 1;
    const prevOp = _TIER_OPACITY[prevTier] ?? 1;
    marker._opacity = op;

    if (animated) {
        // Slow fade DOWN (less jarring), quick restore UP (responsive feel).
        const durMs = op < prevOp ? 1500 : 500;
        el.style.transition = `opacity ${durMs}ms`;
        setTimeout(() => { if (marker._tier === tier) el.style.transition = ''; }, durMs);
    } else {
        el.style.transition = '';
    }
    el.style.opacity = String(op);
}

/**
 * Fade a marker to opacity 0 and remove it from the DOM after the animation
 * completes. The logical entry in `markers` is removed synchronously so vehicle
 * counts and the data panel reflect the disappearance immediately; only the
 * DOM element lingers for the fade. Idempotent — repeated calls during the
 * fade are no-ops.
 * @param {string} markerKey trip_id key in the module-level markers object
 * @param {number} durMs     fade duration in ms (default 1200)
 */
export function _fadeOutAndRemove(markerKey, durMs = 1200) {
    const m = markers[markerKey];
    if (!m || m._fadingOut) return;
    m._fadingOut = true;

    // Close out any in-progress freeze episodes so they're counted exactly once
    // even when the marker is removed mid-pause (e.g. fade-out triggered by
    // freshness expiry during an intersection stop).
    if (m._intersectionPauseStartedAt) {
        recordMarkerDrop('intersectionPause');
        m._intersectionPauseStartedAt = 0;
    }

    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
        delete animations[markerKey];
    }
    // Drop from the markers map now so getScheduledArrivals/data-panel/etc.
    // stop counting this vehicle immediately. The DOM element fades out
    // independently of logical state.
    delete markers[markerKey];

    const el = m.getElement?.();
    if (!el) { m._removed = true; m.remove(); return; }
    // Disable interaction during fade so a popup can't open on a vehicle
    // that's about to vanish.
    el.style.pointerEvents = 'none';
    m._opacity             = 0;
    el.style.transition    = `opacity ${durMs}ms ease-out`;
    el.style.opacity       = '0';
    // Track the fade so createNewMarker can cancel and clean up the orphan
    // DOM if a fresh frame for the same trip_id arrives during the fade.
    const timeoutId = setTimeout(() => {
        m._removed = true;
        m.remove();
        _fadingMarkers.delete(markerKey);
    }, durMs);
    _fadingMarkers.set(markerKey, { marker: m, timeoutId });
}

/**
 * Periodic cleanup loop (FRESH_CHECK_INTERVAL_MS). For each marker:
 *   - tier === 'expired' (age ≥ FRESH_EXPIRE_S) → fade-out + remove from DOM
 *   - end-of-line linger past TERMINUS_LINGER_S → fade-out (terminus shorter)
 *   - otherwise → apply visual freshness tier (live/aging/stale) + DR watchdog
 *
 * Tier is derived from `marker.timestamp` (any WS arrival), not `_lastFreshTs`
 * (strictly-newer fix). Feeds routinely re-broadcast the last reading; under
 * the previous model that re-broadcast advanced the "received" clock but not
 * the "fade" clock, making vehicles fade even when packets were arriving for
 * them — the user-visible bug this rewrite targets.
 */
export function initMarkerCleanup() {
    // No explicit init guard needed — the 'markers:cleanup' key passed to
    // setVisibleInterval is itself idempotent (a second call replaces the
    // prior interval instead of stacking).
    setVisibleInterval(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        const nowMs  = Date.now();
        let removedAny = false;

        // Snapshot the keys before iterating — _fadeOutAndRemove deletes
        // entries from `markers` synchronously, and a for…in over a mutated
        // object is engine-defined behaviour (V8 happens to handle it but
        // the spec doesn't promise to visit every original key).
        for (const markerKey of Object.keys(markers)) {
            const m = markers[markerKey];
            if (!m) { delete markers[markerKey]; continue; }

            // Hard wall-clock TTL — catches ghost trips whose feed keeps
            // re-broadcasting GPS forever and so never accrue feed silence
            // to hit FRESH_EXPIRE_S. MARKER_HARD_TTL_MS sits above the longest
            // legitimate end-to-end run (A Line is just over 2 hours, plus
            // layover buffer); anything beyond that is stale state.
            if (m._createdAtMs && (nowMs - m._createdAtMs) > MARKER_HARD_TTL_MS) {
                _fadeOutAndRemove(markerKey);
                removedAny = true;
                continue;
            }

            // Missing-timestamp grace — previously a permanent leak path (the
            // `if (!m?.timestamp) continue;` short-circuit skipped cleanup
            // entirely). Allow a brief grace for ingest races during marker
            // construction, then force-remove.
            if (!m.timestamp) {
                m._noTimestampSinceMs ??= nowMs;
                if (nowMs - m._noTimestampSinceMs > NO_TIMESTAMP_GRACE_MS) {
                    _fadeOutAndRemove(markerKey);
                    removedAny = true;
                }
                continue;
            }
            m._noTimestampSinceMs = null;   // recovered

            const tier = getFreshnessTier(m, nowSec);

            if (tier === 'expired') {
                _fadeOutAndRemove(markerKey);
                removedAny = true;
            } else if (m._endOfLineSinceTs && (nowSec - m._endOfLineSinceTs) >= TERMINUS_LINGER_S) {
                _fadeOutAndRemove(markerKey, TERMINUS_FADE_MS);
                removedAny = true;
            } else {
                applyFreshness(m, tier);

                // DR watchdog: feed is alive (tier === 'live') but no active
                // rAF loop means DR died (timeout, race, exception). Restart
                // it from the current snap so the marker keeps moving instead
                // of sitting frozen. Idempotent: startDR no-ops if speed/snap
                // conditions aren't met. Skip if fading — restarting DR on a
                // fade-out marker leaves animations[markerKey] populated and
                // could re-tick after the DOM is gone.
                if (tier === 'live' && !animations[markerKey] && !m._fadingOut) {
                    if (m.lastSnap) startDeadReckoning(markerKey);
                    else            startBearingDeadReckoning(markerKey);
                }
            }
        }

        // Defensive LRU cap — under normal operation the active fleet is
        // ~200 markers, so 500 is well above legitimate worst-case. If it
        // ever trips, log so we know a leak is at play; evict the oldest
        // (lowest `timestamp`) to keep the visible state bounded.
        const allKeys = Object.keys(markers);
        if (allKeys.length > MARKER_COUNT_CAP) {
            console.warn(`[markers] count cap exceeded (${allKeys.length}) — evicting oldest`);
            const sorted = allKeys
                .map(k => ({ k, ts: markers[k].timestamp || 0 }))
                .sort((a, b) => a.ts - b.ts);
            const excess = allKeys.length - MARKER_COUNT_CAP;
            for (let i = 0; i < excess; i++) {
                _fadeOutAndRemove(sorted[i].k);
                removedAny = true;
            }
        }

        if (removedAny) updateDataPanel(markers);
    }, FRESH_CHECK_INTERVAL_MS, 'markers:cleanup');

    // Visibility-resume DR kick — the rAF integrators are browser-suspended
    // while the tab is hidden. The dt cap in _arcTick/_bearingTick already
    // prevents giant-jump teleports on resume, but a marker whose feed kept
    // flowing while hidden may glide from a stale damped speed. Forcing a
    // param-refresh on resume snaps the integrator to the latest snap target.
    // Idempotent with the watchdog above and the new _fadingOut guard.
    document.addEventListener('visibilitychange', _onVisibilityResume);
}

function _onVisibilityResume() {
    if (document.hidden) return;
    const nowSec = Math.floor(Date.now() / 1000);
    // Snapshot keys to match the cleanup loop's iteration pattern. The body
    // here doesn't mutate `markers`, but `startDeadReckoning` could in theory
    // tear down a marker on a downstream error path — defensive consistency.
    for (const markerKey of Object.keys(markers)) {
        const m = markers[markerKey];
        if (!m || m._fadingOut || !m.timestamp) continue;
        const tier = getFreshnessTier(m, nowSec);
        if (tier !== 'live') continue;
        if (m.lastSnap) startDeadReckoning(markerKey);
        else            startBearingDeadReckoning(markerKey);
    }
}

