import {
    FRESH_EXPIRE_S, FRESH_CHECK_INTERVAL_MS, SPIKE_BYPASS_S,
    MAX_PLAUSIBLE_SPEED_MPS, STATIONARY_SPEED_MPS,
    GPS_SPIKE_STOP_RADIUS_M,
    TERMINUS_LINGER_S, TERMINUS_FADE_MS,
    FINAL_STOP_HOLD_M, RAIL_SNAP_MAX_M, HEAVY_RAIL_SNAP_MAX_M, BUS_SNAP_MAX_M, BRT_SNAP_MAX_M,
    STOPPED_AT_STOP_SNAP_MAX_M,
    SPIKE_REANCHOR_STREAK, STOP_LAG_REANCHOR_STOPS, DOWNSTREAM_MIN_METERS,
    COLD_START_MAX_OFFROUTE_M,
    GLIDE_MIN_MS, GLIDE_MAX_MS,
    POS_JITTER_DEADBAND_M, POS_JITTER_DWELL_DEADBAND_M,
    POS_JITTER_BACKWARD_RELEASE_M, POS_JITTER_BACKWARD_STREAK,
    MARKER_HARD_TTL_MS, NO_TIMESTAMP_GRACE_MS, MARKER_COUNT_CAP,
    TRIP_COVERAGE_CHECK_INTERVAL_MS, MARKER_FADE_DOWN_MS, MARKER_FADE_UP_MS,
    routeHexColors, FALLBACK_ROUTE_COLOR,
} from './config.js';
import { getTerminalStopId, getSecondsToNextStop, getScheduledArrivals, isOriginStop, isAtOwnOriginStop, getRouteCache, findIdx } from './predictions.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { toggleFollow, decorateFollowButton } from './followVehicle.js';
import { setActivePopup, notifyPopupClosed } from './popups.js';
import { snapToRoute, hasShapeData, lngLatAtArc, resolveShapeKey } from './snap.js';
import { computeBearing, planarMeters, isStoppedAt, normalizeStopId, setVisibleInterval, isBusRoute, isBrtRoute, isHeavyRail } from './utils.js';
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
// Keyed by "routeCode|color|terminus" — bounded to ~route-count × 2 terminus combos
// (~20-40 entries in practice), so no eviction is needed for normal sessions.
const _svgUrlCache = new Map();
let _openVehiclePopups = 0;

const _TIER_OPACITY = { live: 1, stale: 0.5, expired: 0 };

// Shared easing for both motion paths (arcGlide along a polyline, animateMarker
// straight-line). TRUE cubic-in-out: the second half is cubic-out, NOT
// quadratic — a quadratic tail put a velocity kink at t=0.5 (on-screen speed
// dropped 33% instantly, derivative 3→2) and added ~2% mean lag. The
// velocity-continuity at t=0.5 is pinned by tests/glide-invariant.test.js, so
// keep this the single definition.
function cubicInOutEase(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

setVisibleInterval(() => {
    if (_openVehiclePopups === 0) return;
    const now = Date.now() / 1000;
    document.querySelectorAll('.pv2-time[data-ts]').forEach(el => {
        const age = Math.max(0, Math.floor(now - Number(el.dataset.ts)));
        el.querySelector('.pv2-secs').textContent = age + 's ago';
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
/**
 * Resolve the per-direction shape key for a marker's CURRENT update.
 * Coalesces the frame's direction_id with the marker's last-known direction
 * (marker.properties.direction_id still holds the PRIOR frame's value here —
 * it isn't refreshed until later in updateExistingMarker) so a single
 * null-direction frame can't flip a split route's marker into the bare arc
 * space mid-glide, which would jump fromArc/toArc between two different
 * polylines. Direction is constant per trip, so the coalesced value is the
 * stable, correct one. Returns the bare code for non-split routes / unknown
 * direction — i.e. exactly the pre-split arc space.
 */
function _markerShapeKey(marker, vehicle) {
    const dir = vehicle?.properties?.direction_id ?? marker?.properties?.direction_id;
    return resolveShapeKey(vehicle.properties.route_code, dir);
}

export function computeHeading(marker, vehicle, newLng, newLat) {
    const props       = vehicle.properties;
    const prevHeading = marker.properties?.Heading;
    const speed       = Number(props.position_speed) || 0;

    // Hold heading when nearly stationary — prevents arrow jitter at stops.
    // Skip if a snap tangent is available: tangent is stable (polyline-derived, not GPS)
    // so it can safely correct a stale heading without causing jitter.
    if (prevHeading != null && speed < STATIONARY_SPEED_MPS && !marker.lastSnap?.tangentForward)
        return prevHeading;

    // Hold heading within FINAL_STOP_HOLD_M of EITHER the trip's first OR
    // last stop — both are degenerate-bearing zones, and the first-stop hold
    // is what catches the terminus-flip bug: Metro's feed routinely switches
    // a vehicle's tripId from the inbound trip to the outbound RETURN trip
    // *before* the train physically arrives at the terminus. The instant
    // that tripId switches:
    //   • props.direction_id flips
    //   • the trip's stops sequence reverses
    //   • downstreamBearing / upstreamBearing both reverse
    //   • the heading-resolution chain resolves to the OPPOSITE direction
    //   • marker rotates 180° on screen mid-approach (user-reported, D Line
    //     at Union Station — "flipped around as it entered Union Station")
    // Since the new trip's FIRST stop IS the terminus the train is
    // approaching, distance-to-first-stop falls below FINAL_STOP_HOLD_M
    // around the same moment the trip switches. Holding prevHeading during
    // this window keeps the arrow correct until GPS velocity confirms the
    // actual direction reversal (which happens after the dwell, when the
    // train physically starts moving the other way).
    if (prevHeading != null) {
        const trip = window.masterTripsData?.[props.trip_id];
        if (trip?.stops?.length) {
            const firstStop = window.masterStopsData?.[String(trip.stops[0])];
            const finalStop = window.masterStopsData?.[String(trip.stops[trip.stops.length - 1])];
            const nearFirst = firstStop
                && planarMeters(newLat, newLng, firstStop.lat, firstStop.lon) < FINAL_STOP_HOLD_M;
            const nearLast  = finalStop
                && planarMeters(newLat, newLng, finalStop.lat, finalStop.lon) < FINAL_STOP_HOLD_M;
            if (nearFirst || nearLast) return prevHeading;
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
        const snap = snapToRoute(_markerShapeKey(marker, vehicle), newLng, newLat);
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
function makeTerminusSvgUrl(color, routeCode) {
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

function markerSvgUrl(routeCode, color, terminus = false) {
    const key = `${routeCode}|${color}|${terminus}`;
    if (_svgUrlCache.has(key)) return _svgUrlCache.get(key);
    let url;
    if (terminus) url = makeTerminusSvgUrl(color, routeCode);
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
    // Feed stopIds sometimes carry a directional suffix ("80228_N") absent from
    // masterStopsData — fall back to the normalized id (matches bearingToStop).
    // Without this the near-stop bypass of the impossible-speed gate silently
    // never fires for suffixed stops, so a legitimate tunnel-emergence teleport
    // near the platform gets rejected.
    const stop = stopId == null ? null
        : (window.masterStopsData?.[String(stopId)] ?? window.masterStopsData?.[normalizeStopId(String(stopId))]);
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

// Revenue rail lines that own a polyline in rail-shapes.json. BRT (901/910/950,
// physically buses) and the inactive 806 alignment are excluded — the cross-line
// guard only reasons about the six light/heavy-rail lines.
const RAIL_LINE_CODES = ['801', '802', '803', '804', '805', '807'];

// Interlining: line pairs that legitimately share track, so a vehicle of one
// snapping onto the other's polyline is NOT a cross-line spike. Symmetric map.
//   A(801) ↔ E(804) — Regional Connector shared segment (7th/Metro–Little Tokyo)
//   B(802) ↔ D(805) — Wilshire/Vermont–Union Station heavy-rail tunnel
//   C(803) ↔ K(807) — Aviation/Century–Redondo Beach shared segment
const INTERLINE_PARTNERS = {
    '801': new Set(['804']), '804': new Set(['801']),
    '802': new Set(['805']), '805': new Set(['802']),
    '803': new Set(['807']), '807': new Set(['803']),
};

const _railSnapMax = rc => (isHeavyRail(rc) ? HEAVY_RAIL_SNAP_MAX_M : RAIL_SNAP_MAX_M);

/**
 * Cross-line spike guard — "a vehicle cannot be on a different line."
 *
 * True when the GPS fix is clearly OFF the vehicle's own rail line yet snaps
 * cleanly onto a DIFFERENT, non-interlined rail line. A fix on the vehicle's own
 * line (the normal case), on an interlined partner's shared track, or generically
 * off-route (near no line) returns false. Only rail vehicles with shape data are
 * checked; buses / BRT return false immediately.
 *
 * Cost: the multi-line scan runs ONLY when the own-line snap already exceeds the
 * route's snap tolerance (off-route) — a rare path — so steady-state cost is one
 * own-line snap. Complements the (now looser) kinematic spike gates with a purely
 * geometric check that even a forced pull must respect.
 *
 * @param {Object} vehicle Feature with .properties.route_code + geometry
 * @param {number} lng
 * @param {number} lat
 * @returns {boolean} true → reject (fix is on the wrong line)
 */
export function isOnDifferentLine(vehicle, lng, lat) {
    const rc = String(vehicle.properties.route_code);
    if (!RAIL_LINE_CODES.includes(rc) || !hasShapeData(rc)) return false;

    const ownSnap = snapToRoute(rc, lng, lat);
    if (!ownSnap) return false;
    const dOwn = planarMeters(ownSnap.snappedLat, ownSnap.snappedLng, lat, lng);
    // On its own line within tolerance → fine, skip the expensive scan.
    if (dOwn <= _railSnapMax(rc)) return false;

    // Off its own line. Is it cleanly ON a different, non-interlined line?
    const partners = INTERLINE_PARTNERS[rc];
    for (const other of RAIL_LINE_CODES) {
        if (other === rc || partners?.has(other) || !hasShapeData(other)) continue;
        const s = snapToRoute(other, lng, lat);
        if (!s) continue;
        const d = planarMeters(s.snappedLat, s.snappedLng, lat, lng);
        // Within THAT line's tolerance AND closer to it than to its own line.
        if (d <= _railSnapMax(other) && d < dOwn) return true;
    }
    return false;
}

/**
 * Decide whether a new GPS fix should be rejected as a spike.
 *
 * ONE gate remains: a physically-impossible straight-line speed (~110 mph),
 * bypassed when the fix lands near the declared stop. The map must TRACK the
 * feed, not second-guess it — anything slower than impossible is trusted.
 *
 * The rail arc-distance gate and the predict-then-validate gate were REMOVED
 * (the "trust the feed" audit): both rejected legitimate forward catch-ups — a
 * feed that lagged underground then jumped a stop or two forward — which left
 * the marker sitting stations behind its own NEXT STOP label (the exact symptom
 * riders reported, with prod showing the train ahead of us). "Obviously wrong
 * location" is still caught geometrically elsewhere and does NOT live here:
 *   • cross-line guard (isOnDifferentLine) — fix on a different line's track
 *   • >5 km re-anchor in _applyVelocityCorrections — catastrophic jump
 *   • cold-start off-route gate (_isColdStartSpike) — first fix far off any line
 *   • snap tolerance — a fix too far from its own polyline never snaps
 * Do NOT re-add a kinematic arc/predict gate here: it cannot tell a real feed
 * catch-up from a glitch, so it always trades a rare false-accept for a constant
 * false-reject that drags the whole map behind reality.
 *
 * Falls through to false (accept) when the marker has no usable reference state.
 * Exported for unit testing — production callers go through updateExistingMarker.
 * @param {Object} marker  Vehicle marker with getLngLat, lastSnap
 * @param {Object} vehicle Feature with .properties (route_code, stopId, …)
 * @param {number} newLng  New fix longitude
 * @param {number} newLat  New fix latitude
 * @param {number} newTs   New fix unix seconds
 * @param {number} prevTs  Previous fix unix seconds
 * @returns {boolean} true → reject the fix
 */
export function isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs) {
    // Measure elapsed from the last ACCEPTED fix, not the passed prevTs. prevTs
    // is marker.timestamp, which is bumped on every spike-REJECTED frame — but
    // the reference POSITION below (marker.lastSnap) only advances on ACCEPTANCE.
    // Pairing the two scales the speed budget with the real time the reference
    // has been held; with no rejections _lastAcceptedTs === prevTs.
    const refTs   = marker._lastAcceptedTs ?? prevTs;
    const elapsed = Math.max(newTs - refTs, 0);

    // Use the last accepted GPS snap as the reference position, NOT getLngLat().
    // getLngLat() returns the marker's VISUAL position, which mid-glide sits
    // partway between the previous and latest snap — using it as the spike
    // reference makes a valid re-acquisition look like a backward spike.
    //
    // No snap (non-BRT buses always; off-route rail): prefer the last ACCEPTED
    // straight-line target (_targetLng/_targetLat, written by _applySnap on every
    // accepted frame) over getLngLat(), for the same reason. elapsed above is
    // measured from _lastAcceptedTs — pairing it with the mid-glide visual
    // position pads the distance with the un-traversed glide remainder, so a bus
    // on a normal catch-up after a long inter-fix gap reads over
    // MAX_PLAUSIBLE_SPEED_MPS and freezes for a cycle (false reject). The visual
    // position remains the cold-path fallback only.
    const ref = marker.lastSnap
        ? { lat: marker.lastSnap.snappedLat, lng: marker.lastSnap.snappedLng }
        : (marker._targetLat != null
            ? { lat: marker._targetLat, lng: marker._targetLng }
            : marker.getLngLat());
    const distMeters = planarMeters(ref.lat, ref.lng, newLat, newLng);

    // Impossible-speed gate (the only one left) — measured from the last GPS
    // anchor, not the visual position.
    if (elapsed > 0 && distMeters / elapsed > MAX_PLAUSIBLE_SPEED_MPS) {
        // Near the declared stop → plausible teleport across a feed gap; accept.
        if (!_nearStop(vehicle, newLng, newLat)) return true;
    }

    return false;
}

let _lastTripCoverageCheck = 0;

/**
 * Ingest a batch of raw vehicle position features from a WebSocket frame.
 * For each feature: validates, spike-rejects, snaps to polyline, computes heading
 * (see computeHeading), creates or updates the map marker, and triggers the
 * arc-glide (rail) / straight-line (bus) animation toward the new GPS fix.
 * @param {{ features: Object[] }} data  Parsed GeoJSON FeatureCollection frame
 * @param {maplibregl.Map} map
 * @see computeHeading
 */
export function processVehicleData(data, map) {
    // Pre-bootstrap guard. Two WS sockets open in sequence inside main.js's
    // dataPromise.then() chain; a frame arriving on the first socket before
    // masterStopsData finishes loading would silently degrade marker creation
    // (optional-chained stop lookups return undefined → snap / adherence
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
                if (vid) console.warn(`[markers] Marker skipped — no trip_id for vehicle ${vid}`);
                return false;
            }
            return true;
        })
        .forEach(vehicle => {
            const ts = Math.floor(Number(vehicle.properties.timestamp));
            if (nowSec - ts > FRESH_EXPIRE_S) {
                recordMarkerDrop('staleAge');
                return;
            }

            const markerKey = vehicle.properties.trip_id;
            const existing = markers[markerKey];
            if (existing) {
                const prevTs = Math.floor(Number(existing.timestamp));
                // Wall-clock ordering only (no sequence numbers in GTFS-RT feed).
                // Vehicle clock skew / NTP corrections could theoretically reorder frames,
                // but Metro's feed is reliable enough that this is acceptable.
                if (ts > prevTs) {
                    // Don't mutate marker.timestamp here — the spike filter needs the
                    // previous timestamp to compute elapsed. updateExistingMarker
                    // advances it after the fix is accepted (or rejected as a spike).
                    updateExistingMarker(vehicle, map, markerKey, prevTs);
                } else {
                    // Re-broadcast of same/older timestamp — feed-level redundancy that
                    // shouldn't reset the fade clock or mutate state.
                    recordMarkerDrop('olderTs');
                }
            } else {
                // Cross-line guard on COLD START too — a mis-tagged vehicle
                // (wrong route_code) must not SPAWN on another line's track any
                // more than a long-running marker may move onto one. Purely
                // geometric, needs no reference, so first frames are valid input.
                const [coldLng, coldLat] = vehicle.geometry.coordinates;
                if (isOnDifferentLine(vehicle, coldLng, coldLat)) {
                    recordMarkerDrop('crossLineSpike');
                    return;
                }
                // Cold-start spike gate — drop obvious bad first frames so a
                // corrupt fix doesn't paint a marker thousands of meters off-track.
                if (_isColdStartSpike(vehicle)) {
                    recordMarkerDrop('coldStartSpike');
                    return;
                }

                // This fix is VALID and about to spawn a marker for a NEW
                // trip_id. If a marker for the SAME physical train already
                // exists under the OLD trip_id (a terminus turnaround OR a
                // mid-route trip reassignment), it's a superseded DUPLICATE —
                // fade it out so one train never renders twice and a
                // followed/clicked popup can't lock onto the stale copy.
                // Symptom this fixes: the same vehicle number at two positions,
                // one fresh and one tens of seconds stale (common when a D Line
                // train's trip_id changes in the tunnel, the old fix a station
                // back). Runs AFTER the guards so a rejected mis-tagged fix can
                // never strand the legit marker.
                //
                // "Same train" = same NON-EMPTY vehicle_id AND same route_code:
                //  - vehicle_id is ~53% populated (feed audit); a bare id match
                //    would fuse two DISTINCT id-less vehicles, so require a real id.
                //  - vehicle ids are unique only within a MODE, so scope to
                //    route_code to avoid fusing a rail car with a BRT bus sharing
                //    an id at a hub.
                // No distance check (the old TERMINUS_TURNAROUND_RADIUS_M proxy):
                // a real id+route match is conclusively the same train, and the
                // duplicate that triggers this is FAR apart. Fading the old
                // marker also expedites the cleanup that would otherwise let the
                // stale twin linger up to FRESH_EXPIRE_S.
                _supersedeDuplicateTrip(vehicle, markerKey);

                createNewMarker(vehicle, map, markerKey);
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
                console.warn(`[markers] ${missed.length}/${liveIds.length} live trip IDs missing from trips.json — static data may be stale. Sample: ${missed.slice(0, 5).join(', ')}`);
            }
        }
    }
}

/**
 * Cold-start spike gate: brand-new markers have no prior reference fix, so
 * isGpsSpike()'s warm-marker check (the impossible straight-line-speed gate) is
 * skipped via isFirstFix. A corrupt first frame would otherwise place the
 * marker hundreds-to-thousands of metres off-track.
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

function createNewMarker(vehicle, map, markerKey) {
    const { vehicle_id, route_code, trip_id, timestamp } = vehicle.properties;
    const isBus = isBusRoute(route_code);

    if (markers[markerKey]) {
        // Kill any in-flight glide BEFORE the replacement is registered: an
        // orphaned rAF tick reads `markers[markerKey]` afresh each frame, so
        // left alive it would adopt the NEW marker and drag it along the old
        // marker's stale glide. (Defensive — no live call path replaces an
        // existing marker today, but the tick's late-binding lookup makes
        // this a one-line guarantee worth keeping.)
        _cancelGlide(markerKey);
        markers[markerKey]._removed = true;
        // Close the popup explicitly so its 'close' handler fires and the
        // _openVehiclePopups counter is decremented. MapLibre's marker.remove()
        // tears down the popup DOM but does not reliably fire 'close', which
        // would otherwise leak a +1 into the counter on every marker
        // replacement-with-open-popup — accumulating into perpetual
        // setVisibleInterval work for the per-second popup-age refresh.
        markers[markerKey].getPopup?.()?.remove();
        markers[markerKey].remove();
        delete markers[markerKey];
    }
    // Cancel any in-flight fade for this trip_id so the orphan DOM element
    // doesn't coexist with the new marker for the 1200 ms fade duration.
    const fading = _fadingMarkers.get(markerKey);
    if (fading) {
        clearTimeout(fading.timeoutId);
        fading.marker._removed = true;
        fading.marker.getPopup?.()?.remove();
        fading.marker.remove();
        _fadingMarkers.delete(markerKey);
    }
    // Belt-and-suspenders sweep — kill any orphan DOM that carries this
    // trip_id but isn't in `markers[]` or `_fadingMarkers`. Without this
    // hard sweep, an edge case where a marker was removed from the markers
    // object without its DOM being cleaned (e.g. an in-flight rAF callback
    // referencing a stale marker reference whose underlying DOM is still
    // attached) leaves "trail" icons visible at past positions across WS
    // frames. The query is bounded — at most ~200 active vehicles, so
    // this is cheap to run every cold-start frame.
    // CSS.escape the feed-derived id — a stray quote/bracket in a trip_id would
    // otherwise throw a SyntaxError from the selector and abort the whole frame.
    // (stations.js escapes its attribute selectors the same way.)
    document.querySelectorAll(`.marker[data-trip="${CSS.escape(String(trip_id))}"]`).forEach(el => {
        el.parentNode?.removeChild(el);
    });

    const el = document.createElement('div');
    el.className = 'marker';
    el.setAttribute('data-route', route_code);
    el.setAttribute('data-trip', trip_id);
    el.setAttribute('data-mode', isBus ? 'bus' : 'rail');
    el.setAttribute('data-timestamp', timestamp);
    el.setAttribute('data-vehicle-id', vehicle_id);
    const sizeExpr = isBus
        ? 'calc(var(--vehicle-size, 24px) * 0.85)'
        : 'var(--vehicle-size, 24px)';
    el.style.cssText = `width:${sizeExpr};height:${sizeExpr};background-repeat:no-repeat;background-size:contain;background-position:center;cursor:pointer;`;

    const brandColor = routeHexColors[route_code] ?? FALLBACK_ROUTE_COLOR;
    const terminus0 = isAtTerminus(vehicle.properties);
    el.style.backgroundImage = markerSvgUrl(route_code, brandColor, terminus0);

    const [rawLng, rawLat] = vehicle.geometry.coordinates;
    const ts = Math.floor(Number(timestamp));
    // Cold-start: snap the marker to the polyline if the route has shape data,
    // so it spawns on the track rather than at the raw GPS coordinate. This is
    // the GPS-only equivalent of what updateExistingMarker does via _applySnap
    // on subsequent frames.
    //
    // Captures `_initialSnap` for later assignment to `marker.lastSnap` and
    // `marker._currentArc` so the FIRST WS update has a real `fromArc` to glide
    // from. Without that capture, the first update's `arcGlide` reads
    // `fromArc = _currentArc (undef) ?? _prevSnap?.arcMeters (undef) ??
    // lastSnap.arcMeters (the NEW arc)` — all three nullish-fall-throughs land
    // on the new arc, fromArc === toArc, the no-op short-circuit fires, and
    // every cold-start vehicle teleports rather than gliding into its first
    // update. That's the bug riders described as "they all teleport to the
    // next GPS update."
    let lng = rawLng, lat = rawLat;
    let _initialSnap = null;
    let _initialSnapDistM = null;
    const _rcStr = route_code != null ? String(route_code) : '';
    if (_rcStr && hasShapeData(_rcStr)) {
        // Cold start: no marker yet, so resolve the direction key straight from
        // the first frame (falls back to bare when direction is unknown).
        const _snap = snapToRoute(resolveShapeKey(_rcStr, vehicle.properties.direction_id), rawLng, rawLat);
        if (_snap) {
            const _snapDistM = planarMeters(_snap.snappedLat, _snap.snappedLng, rawLat, rawLng);
            const _snapMaxM = isBrtRoute(_rcStr) ? BRT_SNAP_MAX_M
                : isBusRoute(_rcStr) ? BUS_SNAP_MAX_M
                : isHeavyRail(_rcStr) ? HEAVY_RAIL_SNAP_MAX_M
                : RAIL_SNAP_MAX_M;
            if (_snapDistM < _snapMaxM) {
                lng = _snap.snappedLng;
                lat = _snap.snappedLat;
                _initialSnap = _snap;
                _initialSnapDistM = _snapDistM;
            }
        }
    }

    const vehicleLabel = isBus ? 'Bus ID ' : 'Train Car #';
    const { stopId, currentStatus, direction_id, currentStopSequence } = vehicle.properties;
    const secToNextStop = getSecondsToNextStop({ properties: { ...vehicle.properties, statusChangedAt: ts } });
    const popupHtml = getPopupHTML({
        routeCode: route_code, vehicleId: vehicle_id, vehicleLabel, timestamp,
        stopId, currentStatus, directionId: direction_id, tripId: trip_id,
        currentStopSequence, secToNextStop,
    });

    // maxWidth matches the .vehicle-popup CSS clamp (240px) — it was 300 here
    // while the CSS won at 240, leaving a misleading dead config value.
    // closeButton: false — on this glance card the × earned nothing: every
    // real dismiss path exists without it (map tap via closeOnClick, opening
    // any other popup via the popups.js registry, hover-out on desktop,
    // marker expiry), and on coarse pointers its 44px WCAG floor overlapped
    // the destination header's cardinal letter on the 240px card. Vehicle
    // markers aren't keyboard-focusable, so no keyboard path is lost. The
    // STATION popup keeps its × deliberately (pinned reading surface; focus
    // moves to it on open) — do not remove that one.
    const popup = new maplibregl.Popup({ offset: 15, maxWidth: '240px', closeButton: false, className: 'vehicle-popup' }).setHTML(popupHtml); // safe: feed values escaped via escapeHtml() in getPopupHTML
    // Single active popup: opening this closes any other open popup — a station,
    // bike, micro, or ANOTHER vehicle marker (MapLibre marker popups never
    // closed each other) — via the coordinator in js/popups.js. Replaces the
    // former explicit `popup.on('open', closeStationPopup)`, which only handled
    // the station case.
    const closeThisPopup = () => popup.remove();
    popup.on('open',  () => setActivePopup(closeThisPopup));
    popup.on('open',  () => _openVehiclePopups++);
    popup.on('open',  () => {
        // Rebuild with a fresh ETA/next-stop on open. updatePopup skips closed
        // popups (the isOpen gate), so the HTML baked at marker creation can be
        // minutes stale by the time the rider opens it — rebuild here so the first
        // thing shown is current. marker.properties is the same cached source the
        // 5 s refresh tick uses, kept in sync by updateExistingMarker.
        updatePopup({ properties: marker.properties }, markerKey);
        // Sync the age display from data-ts immediately on open so it shows the
        // correct value rather than the stale baked-in secsSince from HTML generation.
        const pEl = popup.getElement();
        if (!pEl) return;
        const now = Date.now() / 1000;
        pEl.querySelectorAll('.pv2-time[data-ts]').forEach(timeEl => {
            const age = Math.max(0, Math.floor(now - Number(timeEl.dataset.ts)));
            timeEl.querySelector('.pv2-secs').textContent = age + 's ago';
            const dot = timeEl.querySelector('.pv2-dot');
            if (dot) dot.dataset.tier = getFreshnessTierFromAge(age);
        });
        // Follow button: a delegated click on the popup CONTAINER (survives the
        // setHTML refreshes that replace the button itself), wired once.
        if (!pEl.dataset.followWired) {
            pEl.dataset.followWired = '1';
            pEl.addEventListener('click', (ev) => {
                if (!ev.target.closest('.pv2-follow-btn')) return;
                ev.stopPropagation();
                toggleFollow(markerKey);
                decorateFollowButton(pEl, markerKey);   // immediate visual feedback
            });
        }
        decorateFollowButton(pEl, markerKey);
    });
    popup.on('close', () => { notifyPopupClosed(closeThisPopup); _openVehiclePopups = Math.max(0, _openVehiclePopups - 1); });

    const marker = new maplibregl.Marker({
        element: el,
        anchor: 'center',
        rotationAlignment: 'map',
        pitchAlignment: 'map',
        // Without this, MapLibre rounds the transform to whole CSS pixels on
        // every setLngLat (it skips rounding only during camera 'move' events)
        // — so glides advanced in 1-px hops every 160 ms–1.3 s (3 device px on
        // DPR-3 phones) while panning was subpixel-smooth: visibly steppy
        // motion, inconsistent with the camera. Positional error was ≤0.71 px
        // (placement was never wrong — this is pure smoothness). Cost: a hint
        // of fractional-px blur on idle markers, negligible for an
        // anti-aliased SVG disc.
        subpixelPositioning: true,
    })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);

    marker._removed = false;
    marker._createdAtMs = Date.now();
    // Persist the cold-start snap so the FIRST WS update's arcGlide has a
    // real `fromArc` (the cold-start arc) and a real `_prevSnap` (this snap)
    // to interpolate against. Without these writes the first glide is a no-op
    // teleport — see the long comment in the snap block above.
    if (_initialSnap) {
        marker.lastSnap = _initialSnap;
        marker.lastSnapDeviationM = _initialSnapDistM;
        marker._currentArc = _initialSnap.arcMeters;
        // Tag the arc with the shape space it was measured in (fly detector +
        // future arc-space guard) — the spawn snap used this key.
        marker._currentArcKey = resolveShapeKey(String(route_code), vehicle.properties.direction_id);
    }
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
    // Visual freshness tier is derived from _lastAcceptedTs (last GPS-accepted fix),
    // NOT marker.timestamp. marker.timestamp is bumped on spike-rejected frames so
    // isStaleRef never fires during a rejection streak; using it for the visual tier
    // would keep a frozen marker green while its GPS is bad. _lastAcceptedTs only
    // advances on acceptance, so the green/gray/gone state tracks trusted position age.
    marker._lastAcceptedTs = ts;
    marker.route_code = route_code;
    marker.vehicleLabel = vehicleLabel;
    marker.validFixCount = 0;
    // Consecutive spike-rejection counter — drives the re-anchor escape hatch
    // in updateExistingMarker so a marker can't stay frozen indefinitely.
    marker._consecutiveSpikes = 0;
    marker.atTerminus = terminus0;
    // Staleness state: _lastFreshTs is the GPS reading time of the last
    // strictly-newer fix (re-broadcasts of an old reading don't bump it).
    // Used only by spike-rejection (SPIKE_BYPASS_S) — NOT visual freshness.
    // Visual state is driven by `_tier` via getFreshnessTier(marker, now).
    marker._lastFreshTs = ts;
    // Explicit `false` (not undefined) for the episode-gated observability
    // flag. Used by the vehicleNoArrivalMatch counter so the first frame
    // emits cleanly on cold start.
    marker._noArrivalMatchRecorded = false;
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
    const _stoppedAt = isStoppedAt(vehicle.properties.currentStatus);
    // Per-direction shape key — used for BOTH the position snap and the
    // STOPPED_AT stop snap so the resulting arcMeters live in one arc space
    // (the same one _applyVelocityCorrections glides in).
    const _shapeKey = _markerShapeKey(marker, vehicle);

    // Snap to polyline before computing heading so downstreamBearing()
    // is called from the track centerline, not the GPS-jitter offset.
    let targetLng = newLng;
    let targetLat = newLat;
    if (hasShapeData(vehicle.properties.route_code)) {
        // Continuity reference: the previous accepted snap arc, but ONLY when it
        // lives in THIS frame's shape space (_currentArcKey === _shapeKey) — a
        // direction flip leaves lastSnap in the old, reversed arc space, where it
        // would be a meaningless bias (the arc-space guard handles flips). Lets
        // snapToRoute reject a kilometres-off "wrong pass of the line" snap where
        // the alignment runs near itself, without holding back a real move.
        const _refArc = (marker._currentArcKey === _shapeKey && Number.isFinite(marker.lastSnap?.arcMeters))
            ? marker.lastSnap.arcMeters : null;
        let snap = snapToRoute(_shapeKey, newLng, newLat, _refArc);
        if (snap) {
            const snapDistM = planarMeters(snap.snappedLat, snap.snappedLng, newLat, newLng);
            const _rc = vehicle.properties.route_code;
            const snapMaxM = isBrtRoute(_rc) ? BRT_SNAP_MAX_M
                : isBusRoute(_rc) ? BUS_SNAP_MAX_M
                : isHeavyRail(_rc) ? HEAVY_RAIL_SNAP_MAX_M
                : RAIL_SNAP_MAX_M;
            if (snapDistM < snapMaxM) {
                marker._prevSnap = marker.lastSnap;
                // Preserve last-known tangent when the new snap window collapses
                // to a degenerate point (sub-1m segment near a terminal loop).
                if (snap.tangentForward == null && marker.lastSnap?.tangentForward != null) {
                    snap = { ...snap, tangentForward: marker.lastSnap.tangentForward };
                }

                marker.lastSnap = snap;
                marker.lastSnapDeviationM = snapDistM;
                targetLng = snap.snappedLng;
                targetLat = snap.snappedLat;
                marker.getElement().removeAttribute('data-off-route');
                marker._offRouteRecorded = false;
            } else {
                // Off-route detour: clear snap so heading helpers don't use
                // a stale arc projection along the guideway.
                marker._prevSnap = null;
                marker.lastSnap = null;
                marker.lastSnapDeviationM = null;
                // _currentArc must die with the snap — it's the arc where the
                // vehicle LEFT the polyline, and during the detour the marker
                // moves via the straight-line branch which never updates it.
                // Left alive, it (a) becomes the rail glide's fromArc on rejoin,
                // visibly jumping the marker BACK to the exit point before
                // gliding forward, and (b) feeds _stopLagFromDeclared as the
                // "visible arc", so once the declared stop pulls ≥2 stops ahead
                // of the frozen exit arc, forceGpsRefresh fires EVERY frame —
                // and with lastSnap null that takes the bus branch, where
                // forcePull TELEPORTS: an off-route J Line bus jerks frame to
                // frame instead of gliding, while stopLagReanchor inflates.
                // Cleared, the lag helper returns null (no arc reference) for
                // the whole episode, and the rejoin glide's fromArc chain falls
                // through to the fresh snap arc — a clean no-op placement at
                // the rejoin point.
                marker._currentArc = null;
                marker.getElement().setAttribute('data-off-route', 'true');
                // Episode-gated: one record per transition INTO off-route, not per frame.
                if (!marker._offRouteRecorded) {
                    recordMarkerDrop('offRoute');
                    marker._offRouteRecorded = true;
                }
            }
        }
    }

    if (_stoppedAt) {
        // Suffix-aware lookup (see _nearStop) so a STOPPED_AT anchor still resolves
        // when the feed stopId carries a directional suffix not in masterStopsData.
        const _sid = String(vehicle.properties.stopId);
        const stop = window.masterStopsData?.[_sid] ?? window.masterStopsData?.[normalizeStopId(_sid)];
        if (stop?.lat && stop?.lon) {
            const _rc = vehicle.properties.route_code;
            if (hasShapeData(_rc)) {
                const stopSnap = snapToRoute(_shapeKey, stop.lon, stop.lat);
                const offBy = stopSnap
                    ? planarMeters(stop.lat, stop.lon, stopSnap.snappedLat, stopSnap.snappedLng)
                    : Infinity;
                // offBy measures the STOP's own distance from the polyline. A
                // tight gate (30 m, not the 150 m GPS-acceptance threshold):
                // when the polyline demonstrably doesn't pass the platform,
                // the raw stop coordinates beat a sideways projection — see
                // STOPPED_AT_STOP_SNAP_MAX_M in config.js.
                if (stopSnap && offBy <= STOPPED_AT_STOP_SNAP_MAX_M) {
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

    // Stash the previous fix's target so the bus (straight-line) branch of
    // _applyVelocityCorrections can measure the REAL inter-fix move for its
    // re-anchor speed gate — not the lagging visual position (mirrors the rail
    // branch's prevSnapArc). Undefined on the first update → that branch falls
    // back to the visual distance.
    marker._prevTargetLng = marker._targetLng;
    marker._prevTargetLat = marker._targetLat;
    marker._targetLng = targetLng;
    marker._targetLat = targetLat;
    marker._terminusNow = isAtTerminus(vehicle.properties);
}

/**
 * Minimum displacement (metres) a new fix must move the marker before the glide
 * follows it. A fixed band sized to the (speed-independent) GPS noise floor —
 * widened only when the feed reports the vehicle is stationary, where SNR→0 and
 * dwell excursions run larger. Exported for unit testing.
 * @param {number} speedMps  Reported speed (m/s).
 * @returns {number} Deadband in metres.
 */
export function effectiveJitterDeadbandM(speedMps) {
    return speedMps < STATIONARY_SPEED_MPS ? POS_JITTER_DWELL_DEADBAND_M : POS_JITTER_DEADBAND_M;
}

/**
 * How far a reference arc lags behind the feed-DECLARED stop, in whole stops,
 * for rail with shape data. Drives the stop-lag GPS-refresh override.
 *
 * The symptom: a marker sits stations behind its own NEXT STOP popup label —
 * most visibly on the downtown tunnel (Regional Connector / B/D subway). The
 * feed carries the correct position (a page refresh spawns a fresh marker that
 * skips the spike check and lands right), but the spike gate / jitter-hold block
 * the forward move on the long-running marker, freezing it behind the label.
 *
 * The caller (`updateExistingMarker`) passes `marker._currentArc` — the marker's
 * VISIBLE arc — so the lag keys off the user-visible symptom: "the dot the rider
 * sees is N stations behind the label." `stopsAhead` counts stops whose arc lies
 * between `fromArc` and the declared stop's arc INCLUSIVE of the declared stop
 * (travel-direction aware). A normal IN_TRANSIT_TO marker is exactly 1 stop ahead
 * of itself (the declared next stop), so only a value ≥ 2 means "a whole extra
 * station behind." When that fires, the caller force-accepts the incoming GPS and
 * teleports to it — superseding every other gate, exactly as a refresh would.
 *
 * @param {number} fromArc  Reference arc to measure the lag from (the caller
 *        passes the marker's VISIBLE arc, `marker._currentArc`).
 * @returns {{stopsAhead:number, declaredArc:number, prevArc:(number|null), stopped:boolean, ascending:boolean}|null}
 *          null when arc reasoning isn't available (no shape, unreliable arc,
 *          unknown stop, missing arc, missing reference arc). `prevArc`/`declaredArc`
 *          /`stopped` are retained for callers/tests that need the stop geometry;
 *          the GPS-refresh override uses only `stopsAhead`.
 */
export function _stopLagFromDeclared(marker, vehicle, fromArc) {
    const rc = vehicle.properties.route_code;
    if (!hasShapeData(rc)) return null;
    const cache = getRouteCache(rc, vehicle.properties.direction_id);
    if (!cache?.arcMeters || cache.arcUnreliable) return null;
    const stopId = vehicle.properties.stopId;
    if (stopId == null) return null;
    // Fuzzy match (exact → suffix-strip → digit-prefix), same as every other
    // feed-stopId-vs-cache.stops lookup in predictions.js — Metro's vehicle-feed
    // and static stop IDs differ by directional suffixes, so a bare indexOf would
    // silently miss and disable the correction on those stops.
    const idx = findIdx(cache.stops, stopId);
    if (idx < 0) return null;
    const declaredArc = cache.arcMeters[idx];
    if (declaredArc == null) return null;
    const refArc = fromArc ?? marker.lastSnap?.arcMeters ?? marker._currentArc;
    if (refArc == null) return null;

    const stopped = isStoppedAt(vehicle.properties.currentStatus);
    // Forward progress is INCREASING arc unless this direction projects backward
    // along the single shared polyline (arcAscending === false).
    const ascending = cache.arcAscending !== false;
    const ahead = ascending ? declaredArc - refArc : refArc - declaredArc;
    if (ahead <= 0) return { stopsAhead: 0, declaredArc, prevArc: null, stopped, ascending };

    let stopsAhead = 0;
    for (const a of cache.arcMeters) {
        if (a == null) continue;
        const counts = ascending ? (a > refArc && a <= declaredArc) : (a < refArc && a >= declaredArc);
        if (counts) stopsAhead++;
    }
    // cache.stops is always in travel/sequence order, so the stop just before the
    // declared one is idx-1 regardless of whether arcs ascend or descend.
    const prevArc = idx > 0 ? cache.arcMeters[idx - 1] : null;
    return { stopsAhead, declaredArc, prevArc, stopped, ascending };
}

/**
 * STOPPED_AT declared-stop forward-anchor target (rail/BRT).
 *
 * When the feed declares the vehicle STOPPED_AT a stop ("At Station X") that lies
 * FORWARD of BOTH the dot's visible arc AND the (often lagging/frozen) GPS snap,
 * return that stop's arc so _applyVelocityCorrections glides the dot INTO the
 * station — instead of leaving it stranded behind X and then dragging it straight
 * PAST X to the next, post-departure GPS fix (the "skip the station" symptom).
 * This honors the feed's DECLARED position (the sanctioned re-anchor exception in
 * CLAUDE.md), not extrapolation: X is a real feed-reported fix, and the dot ends
 * ON it (never past it).
 *
 * Forward-only and orientation-aware (via lag.ascending), and gated on the GPS
 * lagging behind the declaration — so a FRESH GPS already at/past the stop is
 * never pulled backward, and a stale STOPPED_AT (vehicle already departed) does
 * not yank the dot back. Self-limiting: once the dot reaches X the next frame
 * measures zero lag and the anchor disengages, resuming normal GPS tracking.
 *
 * Pure decision logic (no side effects) so it is unit-testable without a map.
 * Buses already anchor to the declared stop via _applySnap (which sets the
 * straight-line target to the stop coords on STOPPED_AT); this brings rail/BRT —
 * whose glide targets the polyline arc — to parity.
 *
 * @param {object|null} lag     _stopLagFromDeclared result (null → no anchor)
 * @param {number|null} visArc  marker._currentArc — the dot's visible arc
 * @param {number|null} gpsArc  marker.lastSnap.arcMeters — the new GPS snap arc
 * @returns {number|null} declared-stop arc to glide to, or null (use GPS snap)
 */
export function _declaredStopAnchorArc(lag, visArc, gpsArc) {
    if (!lag?.stopped || lag.declaredArc == null || gpsArc == null) return null;
    const ref = visArc != null ? visArc : gpsArc;
    const ascending = lag.ascending !== false;
    const isForward = (a, b) => ascending ? a > b : a < b;
    return (isForward(lag.declaredArc, ref) && isForward(lag.declaredArc, gpsArc))
        ? lag.declaredArc
        : null;
}

/**
 * Compute heading + speed, then dispatch to the correct motion handler:
 *   - distMeters > 5000 m → teleport via setLngLat (catastrophic catch-up)
 *   - rail with shape data → arcGlide along the polyline
 *   - everything else (buses, off-route) → animateMarker straight-line glide
 *
 * No DR / no projection / no extrapolation. The glide is bounded between
 * the marker's current visual position and the new snapped GPS position —
 * it cannot move past the latest GPS fix.
 *
 * Reads:  marker._targetLng, marker._targetLat, marker._terminusNow
 * Mutates: marker.properties.Heading, marker.properties.speed,
 *          marker.properties.smoothedSpeed
 * @param {Object} marker
 * @param {Object} vehicle  Full vehicle Feature
 * @param {string} markerKey
 * @param {number} prevAcceptedTs  Unix seconds of the previous ACCEPTED fix —
 *        the reference position the glide actually departs from. NOT
 *        marker.timestamp (bumped on rejected frames): the gap drives glide
 *        duration and the GLIDE_MAX_MS teleport test, so it must measure the
 *        span between the two fixes being interpolated. Equal to the previous
 *        frame's ts in steady state.
 * @param {boolean} isFirstFix
 * @param {boolean} isStaleRef
 * @param {boolean} [forcePull]  When true (stop-lag GPS-refresh override), pull
 *        the marker to the new GPS snap even though the jitter-hold would normally
 *        hold it. On RAIL this glides the full distance (gap-matched, smooth — not
 *        a teleport); only a hard discontinuity (>5 km / stale ref / >60 s gap)
 *        still teleports. On BUS (no polyline) it teleports.
 * @param {number|null} [anchorArc]  STOPPED_AT declared-stop forward-anchor target
 *        (rail/BRT). When non-null, the marker glides to THIS arc (the feed-declared
 *        stop) instead of the GPS snap, and the jitter-hold is bypassed — so a dot
 *        stranded behind a station it's declared STOPPED_AT pulls INTO the station
 *        rather than being dragged past it on the next fix. See _declaredStopAnchorArc.
 */
export function _applyVelocityCorrections(marker, vehicle, markerKey, prevAcceptedTs, isFirstFix, isStaleRef, forcePull = false, anchorArc = null) {
    const newTs = Math.floor(Number(vehicle.properties.timestamp));
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
    // EWMA speed smoothing for downstream ETA approach-speed (predictions.js).
    // Cold start (no prior reading): seed directly. Alpha 0.3 dampens
    // one-off noisy GPS speed reports without lagging real acceleration too far.
    const _SPEED_EWMA_ALPHA = 0.3;
    const _rawSpd = Number(vehicle.properties.position_speed) || 0;
    const _prevSmoothed = Number(marker.properties.smoothedSpeed);
    marker.properties.smoothedSpeed = Number.isFinite(_prevSmoothed)
        ? _SPEED_EWMA_ALPHA * _rawSpd + (1 - _SPEED_EWMA_ALPHA) * _prevSmoothed
        : _rawSpd;

    const elapsed = Math.max(newTs - prevAcceptedTs, 1);

    const diffLng = targetLng - current.lng;
    const diffLat = targetLat - current.lat;
    const distMeters = planarMeters(current.lat, current.lng, targetLat, targetLng);

    // Glide duration tracks the real inter-fix gap, so on-screen speed ≈ the
    // vehicle's real average speed (no "zoom across the line"). Floored for
    // smoothness on rapid re-fixes. See GLIDE_MIN_MS / GLIDE_MAX_MS in config.
    const glideMs = Math.max(elapsed * 1000, GLIDE_MIN_MS);

    // Re-anchor (teleport, no glide) ONLY on a HARD discontinuity — a jump that
    // cannot be shown as plausible motion no matter the duration:
    //   • distMeters > 5000  — huge straight-line jump (service gap / re-spawn)
    //   • isStaleRef         — reference older than SPIKE_BYPASS_S; spike gate
    //                          was bypassed, so trust nothing about continuity
    //   • elapsed*1000 > MAX — gap too long; gliding it either zooms (short
    //                          duration) or crawls on stale data (long one)
    // forcePull is deliberately NOT a hard-reanchor condition: on rail it glides
    // the full distance to the new snap (gap-matched) so the stop-lag correction
    // reads as smooth motion rather than a teleport.
    const hardReanchor = distMeters > 5000 || isStaleRef || elapsed * 1000 > GLIDE_MAX_MS;

    const routeCd = vehicle.properties.route_code;
    // Same per-direction key the snap used — the arc values being glided
    // (fromArc/toArc) are in THIS shape's space, so lngLatAtArc/arcGlide must
    // interpolate on the same polyline or the marker lands on the wrong track.
    const _shapeKey = _markerShapeKey(marker, vehicle);
    if (marker.lastSnap?.arcMeters != null && hasShapeData(routeCd)) {
        // Rail with a valid snap — glide ALONG the polyline arc so the
        // marker stays on the track through curves and never appears
        // off-route. Bounded between the previous snap arc and the new
        // snap arc; cannot extrapolate past GPS.
        const fromArc = marker._currentArc ?? marker._prevSnap?.arcMeters ?? marker.lastSnap.arcMeters;
        // ARC-SPACE GUARD. `_currentArc`/`fromArc` is an arc length in a SPECIFIC
        // shape's coordinate space (`marker._currentArcKey`). When the marker's
        // shape key changes between frames — `resolveShapeKey` returns the generic
        // `801` for direction_id null/1 but the per-direction `801|0` for dir 0,
        // and those polylines are built in REVERSED order (801 arc 0 = Azusa;
        // 801|0 arc 0 = Long Beach) — `fromArc` lands in the wrong space and the
        // glide sweeps up to the whole line (the "fly": e.g. Del Amo's arc is
        // 82.4 km on 801 but 10.5 km on 801|0). The feed flips direction_id
        // intermittently AND populates it over the first frames after load, so
        // this fires mid-line minutes after open, not just at termini. Treat a
        // cross-space arc as a hard discontinuity: re-anchor to the fresh snap on
        // the NEW shape (the marker is already at that physical spot, so the
        // teleport is invisible) instead of gliding from a meaningless fromArc.
        const _arcSpaceMismatch = marker._currentArcKey != null && marker._currentArcKey !== _shapeKey;
        // STOPPED_AT forward anchor: glide to the feed-declared stop instead of the
        // (lagging/frozen) GPS snap when one is supplied. anchorArc is pre-vetted
        // forward-only and orientation-aware by _declaredStopAnchorArc; arcGlide
        // interpolates either arc direction, so no orientation handling here.
        const toArc   = anchorArc != null ? anchorArc : marker.lastSnap.arcMeters;

        // Re-anchor (teleport) ONLY on a hard discontinuity (>5 km / stale ref /
        // gap > GLIDE_MAX_MS). The old "implausible implied arc-speed" sub-gate was
        // removed alongside the isGpsSpike arc gate: it re-anchored legitimate
        // forward catch-ups and, paired with the catch-up rate-limit below, dragged
        // the marker behind reality. With the rate-limit gone the glide now spans
        // the FULL fromArc→toArc each cycle, so the marker always lands on the
        // latest GPS fix — gap-matched duration keeps that smooth, not a zoom.
        if (hardReanchor || _arcSpaceMismatch) {
            recordMarkerDrop(_arcSpaceMismatch ? 'arcSpaceReanchor' : 'hardReanchor');   // teleport, not a drop — see feedStats
            const endPos = lngLatAtArc(_shapeKey, toArc);
            if (endPos) marker.setLngLat([endPos.lng, endPos.lat]);
            else marker.setLngLat([targetLng, targetLat]);
            marker.setRotation(dispHeading);
            marker._currentArc = toArc;
            marker._currentArcKey = _shapeKey;   // arc now in this frame's shape space
            marker._backwardStreak = 0;   // fresh anchor — stale streak is meaningless
            updateMarkerTimestamp(marker, vehicle);
            return;
        }
        // Jitter hold: a BACKWARD move (or, when dwelling, a sub-deadband forward
        // nudge) is GPS noise on a fixed guideway. Hold the committed visual arc
        // instead of stepping backward / shuffling in place. The vehicle is still
        // reporting, so keep freshness live; heading still refines. forcePull and
        // the declared-stop anchor bypass the hold so they always advance.
        //
        // ORIENTATION: there is ONE shared polyline per route, so HALF the routes'
        // directions travel in DECREASING arc (e.g. A Line dir 0 runs 93 km → 0;
        // J Line 910/950 dir 0 likewise). For those, a forward move has toArc <
        // fromArc, so a raw `toArc - fromArc < deadband` test read every forward
        // step as "backward" and FROZE the marker — it only lurched ahead when the
        // 5 km re-anchor or a stop-lag forcePull fired, i.e. the "stuck, then jumps
        // past the station" bug. Measure progress in the TRAVEL direction via the
        // route's arc orientation (cache.arcAscending) so both directions glide.
        // Ascending stays byte-identical (toArc - fromArc). When orientation is
        // unreliable — OR the cache is MISSING entirely (direction_id momentarily
        // null, or a trip absent from static GTFS: owl trips, fresh service-date
        // gaps) — fall back to |delta| so a real move still glides (only true
        // sub-deadband jitter is held) rather than risk re-freezing. A missing
        // cache must NOT take the oriented branch: `undefined?.arcAscending !==
        // false` evaluates true, silently assuming ASCENDING and re-introducing
        // the freeze on every descending-arc direction — precisely on the trips
        // the orientation tests can't see.
        const _cache = getRouteCache(routeCd, vehicle.properties.direction_id);
        const _deadband = effectiveJitterDeadbandM(_rawSpd);
        const _orientedKnown = !(_cache == null || _cache.arcUnreliable);
        const _orientedDelta = _orientedKnown
            ? (_cache.arcAscending !== false ? toArc - fromArc : fromArc - toArc)
            : Math.abs(toArc - fromArc);
        const _held = _orientedDelta < _deadband;
        if (!forcePull && anchorArc == null && _held) {
            // BACKWARD-RELEASE: the hold is one-sided, and unbounded that meant
            // backward motion could NEVER render — a real reversal (single-
            // tracking) froze the dot for minutes, and an accepted forward GPS
            // spike became sticky (every corrective backward fix held, dot
            // parked AHEAD of the feed, shown green). When the feed insists —
            // a large oriented backward delta on consecutive ACCEPTED fixes —
            // trust it and glide back (these are accepted positions; gliding
            // to them is tracking the feed, not a kinematic reject). Only
            // possible when orientation is known: the |delta| fallback can't
            // tell backward from forward (and already glides real moves).
            const _bigBackward = _orientedKnown && _orientedDelta < -POS_JITTER_BACKWARD_RELEASE_M;
            if (_bigBackward) {
                marker._backwardStreak = (marker._backwardStreak ?? 0) + 1;
                if (marker._backwardStreak >= POS_JITTER_BACKWARD_STREAK) {
                    marker._backwardStreak = 0;
                    recordMarkerDrop('backwardRelease');   // a correction count, not a drop
                    // fall through to the glide below
                } else {
                    marker.setRotation(dispHeading);
                    updateMarkerTimestamp(marker, vehicle);
                    return;
                }
            } else {
                // Ordinary sub-deadband jitter (or a small backward blip) —
                // hold, and break any pending backward streak: the rule is
                // STRICTLY consecutive large-backward fixes.
                marker._backwardStreak = 0;
                marker.setRotation(dispHeading);
                updateMarkerTimestamp(marker, vehicle);
                return;
            }
        } else {
            marker._backwardStreak = 0;   // forward progress / forced pull — streak over
        }
        // Observability: the dot is gliding to the feed-DECLARED stop arc
        // (sanctioned forward anchor) rather than the GPS snap.
        if (anchorArc != null) recordMarkerDrop('declaredAnchor');
        // Glide the FULL distance to the new snap, gap-matched. No rate-limit: the
        // marker tracks the feed exactly. (A catch-up cap used to throttle this to
        // ~1 station/cycle, so a marker that had fallen behind could never close
        // the gap on a moving train — the perpetual-lag bug.)
        _recordFly(marker, vehicle, { shapeKey: _shapeKey, fromArc, toArc, glideMs, distMeters, newTs, prevAcceptedTs, forcePull, anchorArc });
        arcGlide(markerKey, fromArc, toArc, dispStart, dispHeading, glideMs, _shapeKey, () => {
            if (!markers[markerKey]) return;
            updateMarkerTimestamp(marker, vehicle);
        });
        return;
    }

    // Bus (no shape data) or off-route rail — straight-line lat/lng glide.
    // The straight-line interpolation can cut corners on curving streets but
    // it's the only option without a polyline. Gap-matched duration, same as
    // arcGlide, so on-screen speed tracks real speed.
    // Speed gate from the REAL inter-fix move (previous target → new target),
    // not the lagging visual `current` — same fix as the rail branch. Falls back
    // to the visual distance on the first update (no previous target yet).
    const moveDistMeters = (marker._prevTargetLat != null)
        ? planarMeters(marker._prevTargetLat, marker._prevTargetLng, targetLat, targetLng)
        : distMeters;
    // forcePull teleports on bus: the straight-line catch-up below is NOT rate-
    // limited, so a forced multi-stop pull would zoom / cut across blocks. (In
    // practice stop-lag is rail-only — hasShapeData gates _stopLagFromDeclared —
    // so this is defensive.)
    const reanchorBus = hardReanchor || forcePull || moveDistMeters / elapsed > MAX_PLAUSIBLE_SPEED_MPS;
    if (reanchorBus) {
        recordMarkerDrop('hardReanchor');   // teleport, not a drop
        marker.setLngLat([targetLng, targetLat]);
        marker.setRotation(dispHeading);
        updateMarkerTimestamp(marker, vehicle);
        return;
    }
    // Jitter hold (no polyline → straight-line distance): hold when the move is
    // below the noise band — kills the in-place shuffle at stops, same as rail.
    // Measure the REAL inter-fix move (moveDistMeters: previous target → new
    // target), NOT the lagging visual `distMeters`. On a quick refresh the visual
    // delta is inflated by the un-traversed glide remainder, so a genuinely
    // stationary bus (real move below the deadband) would falsely re-glide in
    // place instead of being held.
    if (moveDistMeters < effectiveJitterDeadbandM(_rawSpd)) {
        marker.setRotation(dispHeading);
        updateMarkerTimestamp(marker, vehicle);
        return;
    }
    // Gap-matched duration (no duration cap — a stretched duration crawls in the
    // ease-in when interrupted, the rail "stuck" bug). Straight-line catch-up for
    // an off-route vehicle isn't rate-limited here (rare path); the speed gate
    // above still rejects implausible REAL moves.
    animateMarker(markerKey, current, diffLng, diffLat, targetLng, targetLat, dispStart, dispHeading, glideMs, () => {
        if (!markers[markerKey]) return;
        updateMarkerTimestamp(marker, vehicle);
    });
}

/**
 * Apply terminus heading override: when a marker enters or leaves the terminus
 * state, swap the SVG icon and lock rotation to 0 (no directional arrow at
 * terminal holds). Reads marker._terminusNow (set by _applySnap).
 *
 * Mutates: DOM backgroundImage, marker.atTerminus, marker rotation.
 * @param {Object} marker
 * @param {Object} vehicle  Full vehicle Feature
 */
export function _applyTerminusHeading(marker, vehicle) {
    const terminusNow = marker._terminusNow;
    if (terminusNow !== marker.atTerminus) {
        const brandColor = routeHexColors[marker.route_code] ?? FALLBACK_ROUTE_COLOR;
        marker.getElement().style.backgroundImage = markerSvgUrl(marker.route_code, brandColor, terminusNow);
        marker.atTerminus = terminusNow;
        if (terminusNow) marker.setRotation(0);
    }
}

/**
 * Cancel a marker's in-flight glide (arcGlide or animateMarker): cancel the
 * rAF, drop the registry entry, and delete the stashed onComplete so a
 * cancelled glide can never fire updateMarkerTimestamp with superseded vehicle
 * data. The canonical cancel — updateExistingMarker uses it on every frame;
 * exported so the glide-invariant tests can interrupt a glide exactly the way
 * production does (the `animations` registry itself stays module-private).
 * @param {string} markerKey
 */
export function _cancelGlide(markerKey) {
    if (!animations[markerKey]) return;
    cancelAnimationFrame(animations[markerKey]);
    delete animations[markerKey];
    delete markers[markerKey]?._animateMarkerOnComplete;
    // Drop the mid-glide z-raise: if the superseding frame HOLDS instead of
    // starting a new glide, the stale raise would otherwise stick until the
    // next completed glide.
    const _el = markers[markerKey]?.getElement?.();
    if (_el) _el.style.zIndex = '';
}

function updateExistingMarker(vehicle, map, markerKey, prevTs) {
    const marker = markers[markerKey];
    if (!marker) return;

    // NOTE: the in-flight glide is NOT cancelled here. It used to be — which
    // meant a frame REJECTED by the cross-line/spike gates below stranded the
    // marker mid-glide, parked between fixes, never reaching the last ACCEPTED
    // GPS (violating "the marker always ends each cycle ON the latest accepted
    // fix"). The cancel now happens on the ACCEPT path (just before _applySnap)
    // so a superseding frame still kills the old glide before starting its own;
    // reject paths instead let the old glide finish carrying the marker to the
    // last accepted fix, dropping only its completion callback (below) so the
    // OLD frame's updateMarkerTimestamp can't re-stamp after we bump
    // marker.timestamp here.

    const [newLng, newLat] = vehicle.geometry.coordinates;
    const newTs = Math.floor(Number(vehicle.properties.timestamp));

    // Skip spike check on the first real update (no velocity/snap reference yet) or
    // when the marker reference has gone stale and needs a fresh anchor.
    // SPIKE_BYPASS_S is decoupled from the FRESH_* visual tiers: this is an
    // algorithmic gate (when velocity history can no longer validate a fix),
    // not a UX one.
    const isFirstFix = !(marker.validFixCount > 0);
    const isStaleRef = (newTs - (marker.timestamp ?? newTs)) > SPIKE_BYPASS_S;
    // Consecutive-rejection escape hatch. A one-off spike is rejected (good),
    // but a SUSTAINED streak means the "spike" IS the new reality the arc-jump
    // / speed gate can't tell from noise — classically a B/D train emerging
    // from a tunnel far ahead of its last surface fix. The SPIKE_BYPASS_S
    // staleness bypass can't catch this because each rejection below bumps
    // `marker.timestamp = newTs`, so `isStaleRef` (measured from it) never goes
    // true while the feed keeps sending. Without this hatch the marker stays
    // frozen until a page refresh (a fresh marker skips the spike check) — the
    // exact "B Line vehicle jumps forward on refresh" report. See
    // SPIKE_REANCHOR_STREAK in config.js.
    const forceReanchor = (marker._consecutiveSpikes ?? 0) >= SPIKE_REANCHOR_STREAK;
    // Stop-lag GPS refresh — SUPERSEDES every other gate. When the feed-declared
    // next/current stop is >= STOP_LAG_REANCHOR_STOPS stations ahead of the marker's
    // VISIBLE position (_currentArc), the dot is sitting stops behind its own NEXT STOP
    // label. The feed carries the correct position — a page refresh lands a fresh marker
    // (which skips the spike check) right where it should be — but the spike gate / jitter
    // -hold are blocking the forward move on the long-running marker. So force-accept this
    // fix and pull the marker to the incoming GPS, exactly as a refresh would: bypass
    // isGpsSpike below AND force the pull in _applyVelocityCorrections (bypassing the
    // jitter-hold / implausible-speed gates). On rail the pull GLIDES via the catch-up
    // rate-limit (smooth, bounded) rather than teleporting, so a multi-station correction
    // reads as fast motion, not a jump. Measured from the VISIBLE arc (not the GPS snap)
    // so it keys off the user-visible symptom; a normal IN_TRANSIT marker is only 1 stop
    // ahead of itself, so 2+ means a genuine multi-station lag. Self-clears over the next
    // few frames as the catch-up glide advances _currentArc past the threshold.
    const lag = _stopLagFromDeclared(marker, vehicle, marker._currentArc);
    const forceGpsRefresh = (lag?.stopsAhead ?? 0) >= STOP_LAG_REANCHOR_STOPS;
    // STOPPED_AT declared-stop forward anchor (see _declaredStopAnchorArc). When the
    // feed says the vehicle is STOPPED_AT a stop ahead of the dot, accept the fix
    // (bypass the spike gate, like forceGpsRefresh) so even a frozen/stale GPS frame
    // reaches the anchor; the final forward-vs-GPS decision is made post-snap below.
    const declaredAnchorPending = !!(lag?.stopped && (lag?.stopsAhead ?? 0) >= 1);
    // Cross-line guard — "a vehicle cannot be on a different line." A purely
    // geometric check that SUPERSEDES every force bypass (forceReanchor /
    // forceGpsRefresh / isStaleRef): a forced pull or streak escape-hatch must
    // never land the marker on another line's track. Hold position WITHOUT
    // advancing timestamps so a persistently mis-tagged vehicle ages out via the
    // freshness tier / cleanup TTL rather than being drawn on the wrong line.
    // No `!isFirstFix` gate: a mis-tagged vehicle's FIRST update must not render
    // on the wrong line either (it previously got up to ~90 s of green wrong-line
    // display before subsequent frames were held). The guard is purely geometric
    // — it needs no velocity/snap reference, so first fixes are valid input.
    if (isOnDifferentLine(vehicle, newLng, newLat)) {
        recordMarkerDrop('crossLineSpike');
        // Let any in-flight glide finish reaching the last ACCEPTED fix; drop
        // only its completion callback (see note at top of function).
        delete marker._animateMarkerOnComplete;
        // Render the popup from cached state, not the off-line fix (whose stopId
        // would belong to the wrong line).
        updatePopup({ properties: marker.properties }, markerKey);
        return;
    }
    if (!isFirstFix && !isStaleRef && !forceReanchor && !forceGpsRefresh && !declaredAnchorPending && isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs)) {
        recordMarkerDrop('spike');
        marker._consecutiveSpikes = (marker._consecutiveSpikes ?? 0) + 1;
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
        // Let any in-flight glide finish reaching the last ACCEPTED fix; drop
        // only its completion callback (see note at top of function).
        delete marker._animateMarkerOnComplete;
        // Render popup from cached marker state, NOT from the spike's vehicle data.
        // A GPS spike often reports a far-ahead stop in the feed, which would show the
        // wrong "next stop" label while the marker position is correctly held in place.
        updatePopup({ properties: marker.properties }, markerKey);
        return;
    }
    // Observability (corrections, not drops):
    //  - stopLagReanchor: EPISODE-gated, not per-frame. Under a frozen GPS the
    //    lag condition holds every frame, so a per-frame bump turned a
    //    correction COUNT into a duration measure (10×/min per stuck vehicle),
    //    useless for rate analysis. Count one per episode — the transition
    //    into the lagging state — cleared once forceGpsRefresh goes false.
    if (forceGpsRefresh) {
        if (!marker._stopLagEpisode) { recordMarkerDrop('stopLagReanchor'); marker._stopLagEpisode = true; }
    } else {
        marker._stopLagEpisode = false;
    }
    //  - streakForceAccept: the SPIKE_REANCHOR_STREAK escape hatch fired (a
    //    sustained rejection streak force-accepted this fix). Believed
    //    near-zero post trust-the-feed; counting proves it.
    if (forceReanchor) recordMarkerDrop('streakForceAccept');
    // Fix accepted (or force-re-anchored / first / stale-bypassed) — reset the streak.
    // Capture whether we were mid-streak BEFORE clearing it: with the time-scaled
    // spike budget (see isGpsSpike), a multi-cycle catch-up can now be accepted on
    // its own merits before the streak reaches SPIKE_REANCHOR_STREAK, so the
    // smoothedSpeed reseed below must cover that path too, not just forceReanchor.
    const endedSpikeStreak = (marker._consecutiveSpikes ?? 0) > 0;
    marker._consecutiveSpikes = 0;
    marker.validFixCount = (marker.validFixCount ?? 0) + 1;

    // After any spike streak ends — the forceReanchor escape hatch OR a catch-up
    // accepted by the time-scaled budget — the smoothedSpeed EWMA still holds the
    // pre-streak value. Reseed it so the kinematic ETA doesn't use a stale speed
    // for the first few updates after tunnel re-emergence or GPS re-acquisition.
    if (forceReanchor || endedSpikeStreak) marker.properties.smoothedSpeed = undefined;

    // Track strictly-newer GPS readings for spike-rejection. (marker.timestamp is
    // bumped on rejected frames too so isStaleRef never fires during a streak.)
    const prevFreshTs = marker._lastFreshTs ?? 0;
    if (newTs > prevFreshTs) marker._lastFreshTs = newTs;
    // Capture the LAST ACCEPTED ts before overwriting: the glide duration must
    // span the gap between the two fixes actually being interpolated. prevTs
    // (= marker.timestamp) is bumped on REJECTED frames, so after a rejection
    // streak it under-measures the gap while the glide distance spans back to
    // the last accepted fix — the catch-up then animated at K× real speed, and
    // the GLIDE_MAX_MS teleport decision was made against the wrong gap (a 70 s
    // real gap split by one rejected frame at 35 s glided instead of honestly
    // teleporting). Mirrors the isGpsSpike `_lastAcceptedTs` fix. Steady state
    // is unchanged (_lastAcceptedTs === prevTs when nothing was rejected).
    const prevAcceptedTs = marker._lastAcceptedTs ?? prevTs;
    // _lastAcceptedTs advances only on accepted fixes — this drives the visual
    // freshness tier so a frozen marker with bad GPS goes gray/gone correctly.
    marker._lastAcceptedTs = newTs;
    marker.timestamp = newTs;

    // Re-apply freshness tier so a marker that was faded due to a feed gap
    // immediately reflects the new arrival. Idempotent if tier didn't change.
    const nowSec = Math.floor(Date.now() / 1000);
    applyFreshness(marker, getFreshnessTier(marker, nowSec));

    // Frame ACCEPTED — now the old glide is superseded: cancel it (rAF chain +
    // completion callback) before applying the new target. Doing this only on
    // the accept path is what lets rejected frames above leave the glide
    // running to the last accepted fix.
    _cancelGlide(markerKey);

    _applySnap(marker, vehicle);
    // marker.lastSnap.arcMeters is now the fresh GPS snap; resolve the STOPPED_AT
    // declared-stop forward anchor against it (rail/BRT only — bus lag is null).
    const anchorArc = _declaredStopAnchorArc(lag, marker._currentArc, marker.lastSnap?.arcMeters);
    // forceGpsRefresh → pull toward the freshly-snapped GPS, bypassing the jitter-
    // hold. anchorArc → glide to the feed-declared stop instead. On rail both glide
    // (gap-matched, smooth) rather than teleporting — see _applyVelocityCorrections.
    _applyVelocityCorrections(marker, vehicle, markerKey, prevAcceptedTs, isFirstFix, isStaleRef, forceGpsRefresh, anchorArc);

    const prevStopId = String(marker.properties.stopId ?? '');
    marker.properties.stopId = vehicle.properties.stopId;
    if (String(vehicle.properties.stopId ?? '') !== prevStopId) {
        // Episode boundary for vehicleNoArrivalMatch: the next-stop changed,
        // so the question "does trip_updates have a prediction for this stop?"
        // must be answered fresh.
        marker._noArrivalMatchRecorded = false;
        // NOTE: `statusChangedAt` is set on STOP-ID change, not currentStatus
        // change — i.e. it marks when the vehicle ENTERED the current inter-stop
        // segment (departed the previous stop). That is exactly the time-base
        // interStopRemainingSeconds wants (`now - statusChangedAt` = elapsed in
        // the segment). The name is historical; do not "fix" it to track
        // currentStatus or the inter-stop ETA timer breaks.
        marker.properties.statusChangedAt = newTs;
    }
    // Always write — including when the new value is null. Previously we
    // only wrote when non-null, which retained a STALE direction across feed
    // frames where direction_id was momentarily omitted. Downstream paths
    // (computeHeading, station-popup column placement) would then read the
    // OLD direction and route the train into the wrong direction column on
    // the popup, risking a rider boarding the wrong way.
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
    const hidden  = isAtOwnOriginStop(props);
    el.style.visibility   = hidden ? 'hidden' : 'visible';
    el.style.pointerEvents = hidden ? 'none' : '';
}

function updateMarkerTimestamp(marker, vehicle) {
    if (vehicle.properties) {
        const newTs = Math.floor(Number(vehicle.properties.timestamp));
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
    }
}

function updatePopup(vehicle, markerKey) {
    const marker = markers[markerKey];
    const popup = marker?.getPopup();
    if (!popup) return;
    // Hot path: skip the ETA scan + HTML rebuild for CLOSED popups. updatePopup
    // runs once per marker per WS frame (the call at the end of
    // updateExistingMarker), and at most one vehicle popup is open at a time
    // (single-active-popup, js/popups.js) — so on a fleet of hundreds this turns
    // hundreds of getVehicleEtaSecs/getScheduledArrivals scans per frame into one.
    // A popup opened LATER is rebuilt fresh by the popup.on('open') handler in
    // createNewMarker, so it never shows the ETA baked in at marker creation.
    if (!popup.isOpen()) return;
    const { stopId, currentStatus, direction_id, currentStopSequence } = vehicle.properties;
    const tripId = marker.properties.trip_id;

    const secToNextStop = getVehicleEtaSecs(marker);
    const boardingDepSecs = getBoardingDepSecs(marker);
    // Freshness dot + age footer must reflect the last *accepted* GPS fix, NOT
    // marker.timestamp. On a spike-rejected frame marker.timestamp is bumped to
    // the rejected newTs (so isStaleRef never trips during a rejection streak),
    // which would paint a green "Data fresh" dot on a frozen marker even though
    // its opacity correctly dims via getFreshnessTier → _lastAcceptedTs. Seeding
    // from _lastAcceptedTs keeps the dot, the age footer, and the per-second
    // refresh (which reads the rendered data-ts) all on the trusted-position age.
    const freshnessTs = marker._lastAcceptedTs ?? marker.timestamp;
    const popupHtml = getPopupHTML({
        routeCode: marker.route_code, vehicleId: vehicle.properties.vehicle_id,
        vehicleLabel: marker.vehicleLabel, timestamp: freshnessTs,
        stopId, currentStatus, directionId: direction_id, tripId, currentStopSequence,
        secToNextStop, boardingDepSecs, etaSource: marker._etaSource,
    });
    // Read prevTs BEFORE setHTML so the comparison below has the old value.
    const prevTs = Number(popup.getElement()?.querySelector('.pv2-time[data-ts]')?.dataset.ts) || 0;
    popup.setHTML(popupHtml); // safe: feed values escaped via escapeHtml() in getPopupHTML
    // setHTML replaced the Follow button — restore its follow-state label.
    decorateFollowButton(popup.getElement(), markerKey);
    // Sync data-ts to the freshest available trusted timestamp: max(prevTs, freshnessTs).
    // freshnessTs (== _lastAcceptedTs) only advances on ACCEPTED fixes — NOT marker.timestamp,
    // which is bumped on spike rejections and would otherwise drag the age back to "fresh".
    // - When a fresh GPS fix has advanced _lastAcceptedTs, the popup updates to the new
    //   age (a legitimate "backwards" jump that signals live data).
    // - When prevTs is somehow newer than freshnessTs (a no-op refresh that re-bakes
    //   the same value, or a transient DOM/state mismatch), preservation protects against
    //   a false-backwards visual blip. Prior behavior unconditionally pinned to prevTs,
    //   which froze the age counter at popup-open forever even as fresh fixes arrived.
    const liveTs = Math.max(prevTs, freshnessTs || 0);
    if (liveTs > 0) {
        const timeEl = popup.getElement()?.querySelector('.pv2-time[data-ts]');
        if (timeEl) {
            timeEl.dataset.ts = String(liveTs);
            const age = Math.max(0, Math.floor(Date.now() / 1000 - liveTs));
            timeEl.querySelector('.pv2-secs').textContent = age + 's ago';
        }
    }
}

// Returns seconds until this vehicle reaches its next stop, using the same
// GTFS-RT + calc logic as the station popup (so both always agree).
export function getVehicleEtaSecs(marker) {
    const { stopId, vehicle_id, trip_id, currentStatus } = marker.properties ?? {};
    // `_etaSource` is a debug breadcrumb (read by getPopupHTML when the
    // mlm_debug_eta flag is set) recording which tier produced the ETA shown
    // in the popup: 'gtfs-rt' (trip_updates match), 'calc' (schedule/distance
    // fallback), 'stopped' (STOPPED_AT → 0), or 'none' (no stopId).
    if (!stopId) { marker._etaSource = 'none'; return null; }
    if (isStoppedAt(currentStatus)) { marker._etaSource = 'stopped'; return 0; }
    const now = Math.floor(Date.now() / 1000);
    const arrivals = getScheduledArrivals(String(stopId));
    // Join on tripId — always present and unique (the marker is keyed by it).
    // Only ALSO match vehicleId when it's a real, non-empty id: the VP feed sets
    // vehicle_id to null when Metro omits vehicle.id and trip_updates sets it '',
    // so a bare `a.vehicleId === vehicle_id` would let a foreign empty/null-id
    // arrival (sorted sooner) shadow this vehicle's own entry and show a wrong ETA.
    const entry = arrivals.find(a => a.tripId === trip_id || (vehicle_id != null && vehicle_id !== '' && a.vehicleId === vehicle_id));
    // _etaSource reflects the tier that ACTUALLY produced the ETA (getScheduledArrivals
    // tags each entry with `source`), so the [RT]/[calc] debug tag stays honest
    // even when a matched entry fell back to calc.
    if (entry) { marker._etaSource = entry.source ?? 'gtfs-rt'; return Math.max(0, entry.arrivalUnix - now); }
    // No trip_updates match for this vehicle's declared next stop. If the
    // feed has predictions for OTHER vehicles at the same stop, this is the
    // reverse of `ghostArrivals` — trip_updates lost the prediction for this
    // vehicle while still active on the stop. Episode-gated so a sustained
    // divergence doesn't flood the 60s report tick.
    if (
        !marker._noArrivalMatchRecorded
        && arrivals.length > 0
        && currentStatus === 'IN_TRANSIT_TO'
    ) {
        recordMarkerDrop('vehicleNoArrivalMatch');
        marker._noArrivalMatchRecorded = true;
    }
    marker._etaSource = 'calc';
    return getSecondsToNextStop(marker);
}

// Returns seconds until departure when a vehicle is boarding at an origin terminus,
// or null when the vehicle isn't at an origin terminus (caller shows normal ETA).
function getBoardingDepSecs(marker) {
    const { stopId, vehicle_id, trip_id, route_code, direction_id, currentStatus } = marker.properties ?? {};
    if (!isStoppedAt(currentStatus) || !stopId || !route_code) return null;
    const dir = direction_id != null ? Number(direction_id) : null;
    if (dir === null) return null;
    if (!isOriginStop([String(stopId)], route_code, dir)) return null;
    const now  = Math.floor(Date.now() / 1000);
    const list = window.masterArrivalsData?.get(String(stopId)) ?? [];
    // Only ALSO match on vehicleId when it's a real, non-empty id — mirror the
    // guard in getVehicleEtaSecs. The VP feed sets vehicle_id to null and
    // trip_updates sets it '' when Metro omits vehicle.id, so a bare
    // `e.vehicleId === vehicle_id` would let a foreign empty/null-id arrival
    // shadow this train's own departure and show a wrong boarding ETA.
    const dep  = list.find(e => e.tripId === trip_id || (vehicle_id != null && vehicle_id !== '' && e.vehicleId === vehicle_id));
    return dep ? Math.max(0, dep.arrivalUnix - now) : 0;
}


/**
 * Arc-aware glide between two arc positions on a route polyline. Used for
 * RAIL markers when a new WS frame arrives — instead of teleporting from the
 * old snapped position to the new one (jarring) or animating in straight
 * lat/lng (cuts corners on curves), the marker walks ALONG the polyline arc
 * for the duration of the glide.
 *
 * Bounded between `fromArc` and `toArc`. Cannot extrapolate. When the glide
 * completes, the marker sits at `toArc` until the next WS frame arrives.
 *
 * Cancellation: if a new WS frame arrives mid-glide, the caller cancels via
 * `cancelAnimationFrame(animations[markerKey])` + `delete animations[key]`,
 * then starts a fresh `arcGlide` from the marker's CURRENT visual arc to
 * the new target arc. The `_animateMarkerOnComplete` flag is used the same
 * way as in `animateMarker` for safe cold-start onComplete suppression.
 *
 * @param {string} markerKey
 * @param {number} fromArc       Starting arc-meters position.
 * @param {number} toArc         Target arc-meters position.
 * @param {number} startHeading  Initial heading (deg).
 * @param {number} targetHeading Final heading (deg).
 * @param {number} durationMs    Glide duration in ms (gap-matched, GLIDE_MIN_MS..GLIDE_MAX_MS).
 * @param {string} routeCd       Route code for lngLatAtArc lookup.
 * @param {() => void} [onComplete]  Fires once at the final tick if the
 *   marker is still alive and not cancelled.
 */
// ── Fly detector (observability; OFF the rider path) ────────────────────────
// A rail arc-glide whose IMPLIED on-screen speed exceeds any real train
// (FLY_DEBUG_MAX_MPS) is a "fly": the marker animates a huge arc across a tiny
// gap-matched window. Route geometry is ruled out as a cause (snaps are always
// arc-close to truth; no polyline self-overlap or <5 km detour), so the trigger
// is dynamic. This records each fly's full state to a localStorage ring
// (`mlm_flyLog`, dump via `JSON.parse(localStorage.mlm_flyLog)`) so an
// intermittent occurrence is diagnosable after the fact:
//   • keyMismatch=true  → fromArc was committed under a DIFFERENT shape key
//                         than this glide runs on (arc-space bug)
//   • keyMismatch=false → the marker lagged and is catching up in one glide
//                         whose gap (gapS) doesn't reflect the arc distance
// The per-glide cost is one speed comparison; localStorage is read-modify-write
// only on an actual fly (rare), so no in-memory cache is kept (it would just
// risk diverging from an externally-cleared ring). Console line additionally
// gated on mlm_debug_fly === '1'. Pure observability — no behavior change.
const FLY_DEBUG_MAX_MPS = 60;   // ~216 km/h on screen; real trains peak ~30 m/s
export function _recordFly(marker, vehicle, { shapeKey, fromArc, toArc, glideMs, distMeters, newTs, prevAcceptedTs, forcePull, anchorArc }) {
    if (!Number.isFinite(fromArc) || !Number.isFinite(toArc) || !(glideMs > 0)) return;
    const arcGapM = Math.abs(toArc - fromArc);
    const implMps = arcGapM / (glideMs / 1000);
    if (implMps < FLY_DEBUG_MAX_MPS) return;   // not a fly — the only per-glide cost
    if (typeof localStorage === 'undefined') return;
    const p = vehicle.properties || {};
    const arcKey = marker._currentArcKey ?? null;
    const rec = {
        t: Math.floor(Date.now() / 1000),
        route: p.route_code, dir: p.direction_id ?? null, trip: p.trip_id, veh: p.vehicle_id,
        shapeKey, arcKey, keyMismatch: arcKey != null && arcKey !== shapeKey,
        fromArc: Math.round(fromArc), toArc: Math.round(toArc), arcGapM: Math.round(arcGapM),
        distM: Math.round(distMeters), glideMs: Math.round(glideMs),
        gapS: Math.round(newTs - prevAcceptedTs), implMps: Math.round(implMps),
        snapDevM: marker.lastSnapDeviationM != null ? Math.round(marker.lastSnapDeviationM) : null,
        forcePull: !!forcePull, anchor: anchorArc != null,
    };
    try {
        const raw = localStorage.getItem('mlm_flyLog');
        const log = raw ? JSON.parse(raw) : [];
        log.push(rec);
        if (log.length > 150) log.splice(0, log.length - 150);
        localStorage.setItem('mlm_flyLog', JSON.stringify(log));
        if (localStorage.getItem('mlm_debug_fly') === '1') {
            console.warn(`[FLY] ${rec.route} dir${rec.dir} ${rec.implMps}m/s arcGap=${rec.arcGapM}m distM=${rec.distM} gap=${rec.gapS}s keyMismatch=${rec.keyMismatch} shape=${rec.shapeKey} arcKey=${rec.arcKey}`, rec);
        }
    } catch { /* best-effort observability — never disturb the glide */ }
}

function arcGlide(markerKey, fromArc, toArc, startHeading, targetHeading, durationMs, routeCd, onComplete) {
    const m0 = markers[markerKey];
    if (!m0) return;

    // No-op glide (fromArc === toArc or both NaN): snap rotation, sync the
    // tracked arc, fire onComplete synchronously. Without the explicit
    // _currentArc write here, a marker's first WS frame after spawn could
    // leave _currentArc undefined — subsequent frames would then have no
    // valid fromArc to interpolate from, falling back to lastSnap.arcMeters
    // (which is the NEW arc, making the next glide a no-op too).
    if (!Number.isFinite(fromArc) || !Number.isFinite(toArc) || Math.abs(toArc - fromArc) < 0.5) {
        const endArc = Number.isFinite(toArc) ? toArc : (Number.isFinite(fromArc) ? fromArc : null);
        if (endArc != null) {
            const endPos = lngLatAtArc(routeCd, endArc);
            if (endPos) m0.setLngLat([endPos.lng, endPos.lat]);
            m0._currentArc = endArc;
            m0._currentArcKey = routeCd;
        }
        m0.setRotation(targetHeading);
        if (onComplete) onComplete();
        return;
    }

    if (onComplete) m0._animateMarkerOnComplete = onComplete;

    // Z-order at meets: two opposite-direction trains on the same centerline
    // polyline are EXACTLY coincident at a meet, and the top marker fully
    // eclipses the other — with z decided by arbitrary DOM insertion order.
    // Raise the MOVING marker one step within its own layer band (rail 2→3,
    // BRT/bus 1→2 — never across bands, so a gliding bus still renders under
    // a dwelling train) and restore at completion: a dwelling/held vehicle
    // drops back to its class z, so the train actually in motion is the one
    // the rider sees. Zero accuracy cost — this moves paint order, never the
    // dot (the audit explicitly rejected a geometric direction offset, whose
    // heading source is stale exactly at the stations where meets happen).
    const _zEl = m0.getElement?.();
    if (_zEl) _zEl.style.zIndex = isBusRoute(m0.route_code) ? '2' : '3';

    // Rotation model — keep it simple: lerp startHeading → targetHeading over
    // the glide. Both endpoints were resolved by computeHeading() (which uses
    // next-station downstreamBearing as the disambiguator), so honoring them
    // verbatim is the most direct way to "point the arrow at the next stop."
    //
    // The earlier per-frame polyline-tangent approach (PRs #260/#261) tried
    // to follow curves more accurately but kept breaking: arcSign flipped on
    // snap wobble, tangent could be 180° off near endpoints, and the result
    // was an arrow that systematically pointed wrong on screen. The visual
    // benefit of curve-following over a 1 s glide is tiny — the simple lerp
    // matches what buses already do (animateMarker) and is rock-solid.
    const headingDelta = _shortestBearingDelta(targetHeading, startHeading);
    const skipHeadingAnim = Math.abs(headingDelta) < 1;

    // NO prefers-reduced-motion gate here. The arc-glide IS the vehicle motion
    // model — it represents a real train moving along its track between GPS
    // fixes, which WCAG 2.3.3 explicitly exempts ("motion essential to the
    // information being conveyed"). Gating it turns every vehicle into a
    // teleport for the large population of users who run "Reduce Motion" at
    // the OS level (default-on for many macOS/iOS accessibility setups), which
    // is exactly the regression that made markers jump frame-to-frame after
    // the DR→glide refactor. The pre-#257 DR integrator was never gated for
    // the same reason. (Decorative TRANSITIONS — e.g. map flyTo — may still
    // honor reduced-motion; vehicle position interpolation is not decorative.)
    const startMs = performance.now();
    function tick() {
        const m = markers[markerKey];
        if (!m) { delete animations[markerKey]; return; }
        const elapsed = performance.now() - startMs;
        const t = Math.min(1, elapsed / durationMs);
        const eased = cubicInOutEase(t);
        const curArc = fromArc + eased * (toArc - fromArc);
        const pos = lngLatAtArc(routeCd, curArc);
        // _currentArc tracks the RENDERED position — advance it only when the
        // arc actually painted. lngLatAtArc returns null solely during the
        // midnight shape-cache reload race; advancing the arc while the DOM is
        // frozen would make the next glide depart from a position the rider
        // never saw.
        if (pos) {
            m.setLngLat([pos.lng, pos.lat]);
            m._currentArc = curArc;
            m._currentArcKey = routeCd;
        }
        if (!skipHeadingAnim) {
            m.setRotation((startHeading + eased * headingDelta + 360) % 360);
        }
        if (t < 1) {
            animations[markerKey] = requestAnimationFrame(tick);
        } else {
            const endPos = lngLatAtArc(routeCd, toArc);
            if (endPos) {
                m.setLngLat([endPos.lng, endPos.lat]);
                m._currentArc = toArc;
                m._currentArcKey = routeCd;
            }
            m.setRotation(targetHeading);
            m.getElement?.()?.style && (m.getElement().style.zIndex = '');  // back to class z — dwelling markers yield to moving ones
            delete animations[markerKey];
            const cb = m._animateMarkerOnComplete;
            delete m._animateMarkerOnComplete;
            if (cb) cb();
        }
    }
    animations[markerKey] = requestAnimationFrame(tick);
}

/**
 * Straight-line lat/lng glide. Used for buses (no shape data) and off-route
 * rail markers where there's no polyline to interpolate along. Cuts corners
 * on curving paths — that's the trade-off for not having shape data.
 *
 * Wall-clock-time-based (NOT frame-count-based) so glide duration is the
 * same on 60 Hz and 120 Hz displays. Matches `arcGlide` timing semantics.
 *
 * Calls `onComplete` synchronously from the final tick; if cancelled
 * mid-flight (caller deletes `animations[markerKey]` and/or
 * `markers[markerKey]._animateMarkerOnComplete`), nothing fires.
 *
 * @param {string} markerKey
 * @param {{lng:number, lat:number}} startCoords
 * @param {number} diffLng / diffLat   Total deltas to animate over `durationMs`.
 * @param {number} targetLng / targetLat   Snapped end position.
 * @param {number} startHeading / targetHeading
 * @param {number} durationMs          Glide duration in ms (gap-matched, GLIDE_MIN_MS..GLIDE_MAX_MS).
 * @param {() => void} [onComplete]
 */
function animateMarker(markerKey, startCoords, diffLng, diffLat, targetLng, targetLat, startHeading, targetHeading, durationMs, onComplete) {
    const headingDelta = _shortestBearingDelta(targetHeading, startHeading);
    const skipHeadingAnim = Math.abs(headingDelta) < 1;
    const m0 = markers[markerKey];
    if (m0 && skipHeadingAnim) m0.setRotation(targetHeading);
    if (m0 && onComplete) m0._animateMarkerOnComplete = onComplete;
    // Z-order at meets — same raise/restore as arcGlide (bus band 1→2).
    const _zEl = m0?.getElement?.();
    if (_zEl) _zEl.style.zIndex = isBusRoute(m0.route_code) ? '2' : '3';

    // NO prefers-reduced-motion gate — same rationale as arcGlide. This is the
    // bus / off-route-rail motion model (real vehicle movement between GPS
    // fixes), not a decorative transition. Gating it teleported every bus for
    // Reduce-Motion users. Cold-start no longer routes through animateMarker
    // (it uses a direct setLngLat in createNewMarker), so there is no
    // transition-animation caller left to gate anyway.
    const startMs = performance.now();
    function animate() {
        const m = markers[markerKey];
        if (!m) { delete animations[markerKey]; return; }
        const elapsed = performance.now() - startMs;
        const t = Math.min(1, elapsed / durationMs);
        const eased = cubicInOutEase(t);
        m.setLngLat([startCoords.lng + eased * diffLng, startCoords.lat + eased * diffLat]);
        if (!skipHeadingAnim) {
            m.setRotation((startHeading + eased * headingDelta + 360) % 360);
        }
        if (t < 1) {
            animations[markerKey] = requestAnimationFrame(animate);
        } else {
            if (targetLng != null && targetLat != null) m.setLngLat([targetLng, targetLat]);
            m.setRotation(targetHeading);
            m.getElement?.()?.style && (m.getElement().style.zIndex = '');
            delete animations[markerKey];
            const cb = m._animateMarkerOnComplete;
            delete m._animateMarkerOnComplete;
            if (cb) cb();
        }
    }
    animations[markerKey] = requestAnimationFrame(animate);
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
 * @param {'live'|'stale'|'expired'} tier
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
    // MUST be a string: MapLibre's _updateOpacity early-out compares this
    // against element.style.opacity (always a string) with !== — a numeric
    // value is permanently unequal, defeating the early-out and re-writing
    // style.opacity on every _update (every glide tick × every marker).
    marker._opacity = String(op);

    if (animated) {
        // Slow fade DOWN (less jarring), quick restore UP (responsive feel).
        const durMs = op < prevOp ? MARKER_FADE_DOWN_MS : MARKER_FADE_UP_MS;
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
/**
 * Fade out any EXISTING marker that is the same physical train as `vehicle`
 * (same NON-EMPTY vehicle_id + same route_code) under a DIFFERENT trip_id — a
 * superseded duplicate. Called from processVehicleData when a new trip_id's
 * VALID fix is about to spawn a marker. See the supersede comment at the call
 * site for the full rationale. Exported for tests.
 * @param {Object} vehicle    GeoJSON feature with .properties (vehicle_id, route_code).
 * @param {string} markerKey  trip_id of the new marker (excluded from the match).
 */
export function _supersedeDuplicateTrip(vehicle, markerKey) {
    const vid = vehicle?.properties?.vehicle_id;
    if (vid == null || vid === '') return;
    const rc = String(vehicle.properties.route_code ?? '');
    for (const key in markers) {
        if (key !== markerKey
            && markers[key].properties.vehicle_id === vid
            && String(markers[key].properties.route_code ?? '') === rc) {
            _fadeOutAndRemove(key);
            break;
        }
    }
}

export function _fadeOutAndRemove(markerKey, durMs = 1200) {
    const m = markers[markerKey];
    if (!m || m._fadingOut) return;
    m._fadingOut = true;

    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
        delete animations[markerKey];
    }
    // Drop from the markers map now so getScheduledArrivals/data-panel/etc.
    // stop counting this vehicle immediately. The DOM element fades out
    // independently of logical state.
    delete markers[markerKey];

    const el = m.getElement?.();
    if (!el) { m._removed = true; m.getPopup?.()?.remove(); m.remove(); return; }
    // Disable interaction during fade so a popup can't open on a vehicle
    // that's about to vanish.
    el.style.pointerEvents = 'none';
    m._opacity             = '0';   // string — see the applyFreshness note
    el.style.transition    = `opacity ${durMs}ms ease-out`;
    el.style.opacity       = '0';
    // Track the fade so createNewMarker can cancel and clean up the orphan
    // DOM if a fresh frame for the same trip_id arrives during the fade.
    const timeoutId = setTimeout(() => {
        m._removed = true;
        // Fire the popup's 'close' handler before tearing down the marker so
        // the _openVehiclePopups counter stays balanced — MapLibre's
        // marker.remove() doesn't guarantee a 'close' event on an open popup.
        m.getPopup?.()?.remove();
        m.remove();
        _fadingMarkers.delete(markerKey);
    }, durMs);
    _fadingMarkers.set(markerKey, { marker: m, timeoutId });
}

/**
 * Periodic cleanup loop (FRESH_CHECK_INTERVAL_MS). For each marker:
 *   - tier === 'expired' (age ≥ FRESH_EXPIRE_S) → fade-out + remove from DOM
 *   - end-of-line linger past TERMINUS_LINGER_S → fade-out (terminus shorter)
 *   - otherwise → apply visual freshness tier (live/stale)
 *
 * Tier is derived via `getFreshnessTier(m, nowSec)`, which reads
 * `marker._lastAcceptedTs` (the last GPS-ACCEPTED fix), NOT `marker.timestamp`.
 * `marker.timestamp` is bumped on spike-rejected frames (so `isStaleRef` never
 * trips during a rejection streak), so driving the visual fade off it would keep
 * a frozen marker with bad GPS green; `_lastAcceptedTs` advances only on trusted
 * fixes, so the fade clock tracks the age of the last position we believe.
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
                // No DR watchdog — without a continuous integrator, "live tier
                // but no rAF" is the normal state between WS frames. The marker
                // sits at its last GPS position until the next frame arrives.
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

        // Paranoid popup-leak harness (#253). `_openVehiclePopups` is bumped on
        // popup open/close; it must equal the number of .vehicle-popup DOM
        // nodes. If MapLibre ever drops a 'close' on marker removal without the
        // explicit getPopup().remove() (the CLAUDE.md contract), the two
        // diverge and the counter would silently leak upward — short-circuiting
        // the per-second popup-age refresh. Record the divergence so a real
        // leak surfaces in feed-stats instead of going unnoticed. Scoped to
        // .vehicle-popup so station/bike popups (tracked separately) don't
        // count as false orphans.
        try {
            if (typeof document !== 'undefined') {
                const domVehiclePopups = document.querySelectorAll('.vehicle-popup').length;
                if (domVehiclePopups !== _openVehiclePopups) recordMarkerDrop('popupDOMOrphan');
            }
        } catch { /* DOM unavailable (tests / SSR) — skip the check */ }
    }, FRESH_CHECK_INTERVAL_MS, 'markers:cleanup');

    // No visibility-resume hook needed — without a continuous DR integrator,
    // there's nothing to re-prime when the tab becomes visible. The next WS
    // frame will land on the existing marker and trigger a normal glide.
}

