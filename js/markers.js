import {
    FRESH_EXPIRE_S, FRESH_CHECK_INTERVAL_MS, SPIKE_BYPASS_S,
    MAX_PLAUSIBLE_SPEED_MPS, GPS_NOISE_FLOOR_DEG, STATIONARY_SPEED_MPS,
    GPS_SPIKE_STOP_RADIUS_M, GPS_SPIKE_MIN_DIST_M, TERMINUS_TURNAROUND_RADIUS_M,
    TERMINUS_LINGER_S, TERMINUS_FADE_MS,
    FINAL_STOP_HOLD_M, RAIL_SNAP_MAX_M, HEAVY_RAIL_SNAP_MAX_M, BUS_SNAP_MAX_M, HEAVY_RAIL_STOPPED_AT_MAX_M,
    RAIL_MAX_SPEED_MPS,
    RAIL_ARC_SPIKE_NOISE_M, DOWNSTREAM_MIN_METERS,
    COLD_START_MAX_OFFROUTE_M,
    MARKER_HARD_TTL_MS, NO_TIMESTAMP_GRACE_MS, MARKER_COUNT_CAP,
    routeHexColors,
} from './config.js';
import { getTerminalStopId, getSecondsToNextStop, getScheduledArrivals, isOriginStop, isAtOwnOriginStop, findIdx, getRouteCache, getTripStops } from './predictions.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { closeStationPopup } from './stations.js';
import { snapToRoute, hasShapeData } from './snap.js';
import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, isStoppedAt, normalizeStopId, setVisibleInterval, isBusRoute, isHeavyRail } from './utils.js';
import { recordSegmentTime } from './scheduleCalibration.js';
import { recordMarkerDrop } from './feedStats.js';
import { getFreshnessTier, getFreshnessTierFromAge } from './freshness.js';
import { updateAnimationFor, clearAnimationFor } from './animationWiring.js';
import { blendEtaForNextStop } from './predictions.js';
// Re-export so existing callers (and tests) can keep importing from markers.js.
export { getFreshnessTier, getFreshnessTierFromAge };

/**
 * Live vehicle markers keyed by trip_id. Also exposed as window.vehicleMarkers
 * for cross-module access without circular imports.
 * @type {Object.<string, maplibregl.Marker & { properties: Object, timestamp: number }>}
 */
export const markers = {};
window.vehicleMarkers = markers;
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
    // and catch the failure modes documented in docs/trajectory-overhaul.md:
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
    if (['901', '910'].includes(routeCode)) {
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

function isAtTerminus(props) {
    if (!isStoppedAt(props.currentStatus)) return false;
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
function _isAtEndOfLine(props) {
    if (!isStoppedAt(props.currentStatus)) return false;
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
    else if (['901', '910'].includes(routeCode)) url = makeSquareSvgUrl(color);
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
    const terminus0 = isAtTerminus(vehicle.properties);
    el.style.backgroundImage = markerSvgUrl(agency, route_code, brandColor, terminus0);

    const [lng, lat] = vehicle.geometry.coordinates;
    const ts = parseInt(timestamp, 10);

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
    marker._endOfLineSinceTs = _isAtEndOfLine(marker.properties)
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
export function _applySnap(marker, vehicle) {
    const [newLng, newLat] = vehicle.geometry.coordinates;

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
                marker.lastSnap = snap;
                marker.lastSnapDeviationM = snapDistM;
                targetLng = snap.snappedLng;
                targetLat = snap.snappedLat;
                marker.getElement().removeAttribute('data-off-route');
            } else {
                // Off-route detour: clear snap so DR doesn't project along the guideway
                marker._prevSnap = null;
                marker.lastSnap = null;
                marker.lastSnapDeviationM = null;
                marker.getElement().setAttribute('data-off-route', 'true');
            }
        }
    }

    // When stopped at a station, snap to the stop's known coordinates to
    // prevent GPS jitter from drifting the marker away from the platform.
    if (isStoppedAt(vehicle.properties.currentStatus)) {
        const stop = window.masterStopsData?.[String(vehicle.properties.stopId)];
        if (stop?.lat && stop?.lon) {
            targetLng = stop.lon;
            targetLat = stop.lat;
        }
    }

    marker._targetLng = targetLng;
    marker._targetLat = targetLat;
    marker._terminusNow = isAtTerminus(vehicle.properties);
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
    const dispHeading = terminusNow ? 0 : newHeading;

    marker.properties.Heading = newHeading;
    marker.properties.speed = vehicle.properties.position_speed;

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
        // Re-anchor lastSnap to the marker's kept visual position so the next
        // animation rebuild starts from where the marker actually is — without
        // this, the next renderLoop tick would teleport the marker to the
        // behind-GPS snap on the next frame.
        const _curSnap = snapToRoute(vehicle.properties.route_code, current.lng, current.lat);
        if (_curSnap) {
            if (_curSnap.tangentForward == null && marker.lastSnap?.tangentForward != null) {
                _curSnap.tangentForward = marker.lastSnap.tangentForward;
            }
            marker._prevSnap = marker.lastSnap;
            marker.lastSnap = _curSnap;
        }
        // Null the velocity reference so the next spike check doesn't validate
        // against a backward delta as if it were a forward prediction.
        marker.lastVelocity = null;
    } else if (distMeters > 5000) { // huge legitimate gap — teleport
        marker.setLngLat([targetLng, targetLat]);
        marker.setRotation(dispHeading);
    }
    // Normal path: the renderLoop will animate from the new snap position on
    // its next frame (≤16 ms). No DR call needed — animation is purely a
    // function of the Trajectory + time.
    updateMarkerTimestamp(marker, vehicle);
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

    // Phase 5b: refresh the animation anchor for this trip. blendEtaForNextStop
    // returns the SAME blend ETA the popup will show at this vehicle's next
    // stop, so the marker's animation arrival time and the popup's "0s"
    // moment agree by construction. Skipped on the very first fix of a
    // marker (no lastSnap yet — createNewMarker doesn't call _applySnap,
    // so the second frame is the first one to arrive here with snap set).
    if (marker.lastSnap) {
        const blendEtaUnix = blendEtaForNextStop(marker, nowSec);
        updateAnimationFor({
            tripId:       String(vehicle.properties.trip_id),
            routeCode:    String(vehicle.properties.route_code),
            directionId:  vehicle.properties.direction_id,
            nextStopId:   vehicle.properties.stopId,
            currentArc:   marker.lastSnap.arcMeters,
            blendEtaUnix,
            nowUnix:      nowSec,
            gpsSpeedMps:  Number.isFinite(vehicle.properties.speed) ? vehicle.properties.speed : null,
            gpsTimestamp: newTs,
        });
    }

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
    marker.properties.currentStatus = vehicle.properties.currentStatus ?? null;

    // End-of-line dwell tracking: when a vehicle becomes stopped at the last
    // stop of its current trip, record the time so the cleanup loop can fade
    // it out after TERMINUS_LINGER_S. Cleared as soon as the vehicle leaves
    // that state (status changes, stop changes, or trip changes).
    if (_isAtEndOfLine(marker.properties)) {
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
    const hidden = isAtOwnOriginStop(props);
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
function getVehicleEtaSecs(marker) {
    const { stopId, currentStatus, vehicle_id, trip_id } = marker.properties ?? {};
    if (!stopId) return null;
    if (isStoppedAt(currentStatus)) return 0;
    const now = Math.floor(Date.now() / 1000);
    const arrivals = getScheduledArrivals(String(stopId));
    const entry = arrivals.find(a => a.vehicleId === vehicle_id || a.tripId === trip_id);
    if (entry) return Math.max(0, entry.arrivalUnix - now);
    return getSecondsToNextStop(marker);
}

// Returns seconds until departure when a vehicle is boarding at an origin terminus,
// or null when the vehicle isn't at an origin terminus (caller shows normal ETA).
function getBoardingDepSecs(marker) {
    const { stopId, currentStatus, vehicle_id, trip_id, route_code, direction_id } = marker.properties ?? {};
    if (!isStoppedAt(currentStatus) || !stopId || !route_code) return null;
    const dir = direction_id != null ? Number(direction_id) : null;
    if (dir === null) return null;
    if (!isOriginStop([String(stopId)], route_code, dir)) return null;
    const now  = Math.floor(Date.now() / 1000);
    const list = window.masterArrivalsData?.get(String(stopId)) ?? [];
    const dep  = list.find(e => e.tripId === trip_id || e.vehicleId === vehicle_id);
    return dep ? Math.max(0, dep.arrivalUnix - now) : 0;
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

    // Drop from the markers map now so getScheduledArrivals/data-panel/etc.
    // stop counting this vehicle immediately. The DOM element fades out
    // independently of logical state.
    delete markers[markerKey];

    // Parallel removal from the Phase 5b animation store. Without this,
    // every terminus turnaround leaks a frozen Trajectory entry; the
    // renderLoop would also keep firing setLngLat on a vanished marker
    // via the cached vehicleMarkers entry. State lifecycle must mirror
    // marker lifecycle exactly.
    clearAnimationFor(markerKey);

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
                // No DR watchdog needed under Phase 5b — the renderLoop is a
                // single module-level rAF, not per-marker, so it can't "die"
                // for one vehicle while still running others.
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

    // No visibility-resume hook needed under Phase 5b — the renderLoop's
    // single module-level rAF resumes naturally when the tab becomes
    // visible and reads the trajectory at `now`, which is correct
    // regardless of how long the tab was hidden.
}

