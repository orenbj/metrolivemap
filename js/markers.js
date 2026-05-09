import {
    STALE_THRESHOLD_SEC, STALE_CHECK_INTERVAL_MS, STALE_FADE_START_SEC, STALE_REF_SEC,
    MAX_PLAUSIBLE_SPEED_MPS, GPS_NOISE_FLOOR_DEG, STATIONARY_SPEED_MPS,
    GPS_SPIKE_STOP_RADIUS_M, GPS_SPIKE_MIN_DIST_M, TERMINUS_TURNAROUND_RADIUS_M,
    TERMINUS_LINGER_S, TERMINUS_FADE_MS,
    FINAL_STOP_HOLD_M, RAIL_SNAP_MAX_M, BUS_SNAP_MAX_M, HEAVY_RAIL_STOPPED_AT_MAX_M,
    DR_SPEED_FACTOR, RAIL_MAX_SPEED_MPS,
    RAIL_ARC_SPIKE_NOISE_M, DR_MAX_SECONDS, DR_MAX_SECONDS_RAIL, DOWNSTREAM_MIN_METERS,
    DR_SPEED_ALPHA, DR_DECEL_ZONE_M, DR_DECEL_RATE_MPS2, DR_HEAVY_RAIL_FALLBACK_MPS,
    STALE_LIVE_WINDOW_S,
    routeHexColors,
} from './config.js';
import { getTerminalStopId, getSecondsToNextStop, getScheduledArrivals, isOriginStop, isAtOwnOriginStop, findIdx, getRouteCache } from './predictions.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { closeStationPopup } from './stations.js';
import { snapToRoute, hasShapeData, lngLatAtArc } from './snap.js';
import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, isStoppedAt, normalizeStopId, setVisibleInterval, isBusRoute, isHeavyRail } from './utils.js';
import { recordSegmentTime } from './scheduleCalibration.js';
import { recordMarkerDrop } from './feedStats.js';

/**
 * Live vehicle markers keyed by trip_id. Also exposed as window.vehicleMarkers
 * for cross-module access without circular imports.
 * @type {Object.<string, maplibregl.Marker & { properties: Object, timestamp: number }>}
 */
export const markers = {};
window.vehicleMarkers = markers;
const animations = {};
// Keyed by "agency|routeCode|color|terminus" — bounded to ~route-count × 2 terminus combos
// (~20-40 entries in practice), so no eviction is needed for normal sessions.
const _svgUrlCache = new Map();
let _openVehiclePopups = 0;

setVisibleInterval(() => {
    if (_openVehiclePopups === 0) return;
    const now = Date.now() / 1000;
    document.querySelectorAll('.pv2-time[data-ts]').forEach(el => {
        const age = Math.max(0, Math.floor(now - Number(el.dataset.ts)));
        el.querySelector('.pv2-secs').textContent = age + 's';
        el.querySelector('.pv2-dot').style.background = age >= STALE_FADE_START_SEC ? '#9ca3af' : '';
    });
}, 1000);

// Refresh ETA in open vehicle popup every 5s — keeps it ticking when the VP feed is stale.
setVisibleInterval(() => {
    if (_openVehiclePopups === 0) return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const [key, marker] of Object.entries(markers)) {
        if (marker.getPopup()?.isOpen()) {
            if ((nowSec - (marker.timestamp ?? 0)) > STALE_THRESHOLD_SEC) break;
            updatePopup({ properties: marker.properties }, key);
            break;
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
 * Resolve the marker's display heading via a priority chain:
 *   1. Hold previous heading when stationary (and no fresh snap tangent)
 *   2. Hold previous heading near the trip's final stop (degenerate bearing)
 *   3. Use snap tangent + downstreamBearing to disambiguate ±180°
 *   4. Fall back to downstreamBearing alone (off-route, busway, first fix)
 *   5. Cold-start snap when shape data is available but lastSnap isn't set
 *   6. Final fallback: previous heading or 0
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
    // Use downstreamBearing only to resolve the ±180° forward/reverse ambiguity —
    // the same pattern startDeadReckoning already uses for arc direction.
    const tangent = marker.lastSnap?.tangentForward;
    const isEndpointTangent = marker.lastSnap?.endpointTangent === true;
    if (tangent != null) {
        const downstream = downstreamBearing(props, newLng, newLat);
        if (downstream != null) {
            // Endpoint-window tangents are computed from an asymmetric span that
            // can include a turnout, loop, or stub track — direction is unreliable.
            // Prefer the downstream-stop bearing outright in that case.
            if (isEndpointTangent) return downstream;
            const delta = _shortestBearingDelta(downstream, tangent);
            return Math.abs(delta) < 90 ? tangent : (tangent + 180) % 360;
        }
        // No downstream reference — tangent direction is ambiguous (±180°).
        // Prefer the previously resolved heading over the raw tangent to avoid flips.
        return prevHeading ?? tangent;
    }

    // Fallback: no snap data (off-route, busway, first fix) — use downstream bearing.
    const downstream = downstreamBearing(props, newLng, newLat);
    if (downstream != null) return downstream;

    // Cold-start: snap to get tangent if lastSnap not yet available.
    if (prevHeading == null && hasShapeData(props.route_code)) {
        const snap = snapToRoute(props.route_code, newLng, newLat);
        if (snap?.tangentForward != null) return snap.tangentForward;
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
            if (nowSec - ts > STALE_THRESHOLD_SEC) {
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

function createNewMarker(vehicle, features, map, markerKey) {
    const { vehicle_id, route_code, trip_id, timestamp } = vehicle.properties;
    const agency = vehicle.properties.agency || 'metro';
    const isBus = isBusRoute(route_code);

    if (markers[markerKey]) {
        markers[markerKey]._removed = true;
        markers[markerKey].remove();
        delete markers[markerKey];
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
    // _isStale is the single source of truth for fade — driven by the cleanup
    // loop and by updateExistingMarker, never by map gestures or popup paths.
    marker._lastFreshTs = ts;
    // Start stale if the initial reading is older than STALE_LIVE_WINDOW_S — this
    // prevents a batch of old/replayed positions (e.g., on WS reconnect) from
    // appearing fully opaque before the feed delivers genuinely current data.
    const _nowSec = Math.floor(Date.now() / 1000);
    const _startStale = (_nowSec - ts) > STALE_LIVE_WINDOW_S;
    marker._isStale = _startStale;
    if (_startStale) {
        marker._opacity  = 0.5;
        el.style.opacity = '0.5';
        el.setAttribute('data-stale', '1');
    }
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
            const snapMaxM = isBusRoute(vehicle.properties.route_code) ? BUS_SNAP_MAX_M : RAIL_SNAP_MAX_M;
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
        updateMarkerTimestamp(marker, vehicle);
    } else {
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

    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
        delete animations[markerKey];
    }

    const [newLng, newLat] = vehicle.geometry.coordinates;
    const newTs = parseInt(vehicle.properties.timestamp, 10);

    // Skip spike check on the first real update (no velocity/snap reference yet) or
    // when the marker reference has gone stale and needs a fresh anchor.
    const isFirstFix = !(marker.validFixCount > 0);
    const isStaleRef = (newTs - (marker.timestamp ?? newTs)) > STALE_REF_SEC;
    if (!isFirstFix && !isStaleRef && isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs)) {
        recordMarkerDrop('spike');
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
        // Clear lastVelocity so the next fix isn't measured against a now-stale
        // prediction reference. Without this, persistent GPS corruption (off-track
        // drift, urban-canyon multipath) causes every subsequent fix to be rejected
        // as a spike too — the marker freezes until STALE_REF_SEC bypasses the
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

    // Only count this as a "fresh" reading if newTs is strictly newer than the
    // last one we believed — feeds routinely re-broadcast the prior GPS reading
    // with the same (or older) timestamp, and those must NOT bump the fade
    // clock. _lastFreshTs is what the cleanup loop reads.
    const prevFreshTs = marker._lastFreshTs ?? 0;
    if (newTs > prevFreshTs) marker._lastFreshTs = newTs;
    marker.timestamp = newTs;

    // Restore opacity only when (a) we just received a strictly-newer reading
    // AND (b) that reading is current enough to count as "fresh data" (< STALE_LIVE_WINDOW_S old).
    // STALE_LIVE_WINDOW_S (20s) << STALE_FADE_START_SEC (60s): this prevents a WS reconnect
    // batch of 30–60s-old replayed positions from immediately un-fading stale markers.
    // Only genuinely current data (< 20s old, as delivered during normal live operation)
    // can restore full opacity. Map gestures and popup-close paths never trigger this.
    const nowSec = Math.floor(Date.now() / 1000);
    if (newTs > prevFreshTs && nowSec - newTs < STALE_LIVE_WINDOW_S) {
        setMarkerStale(marker, false);
    }

    _applySnap(marker, vehicle);
    _applyVelocityCorrections(marker, vehicle, markerKey, prevTs, isFirstFix, isStaleRef);

    const prevStopId = marker.properties.stopId;
    marker.properties.stopId = vehicle.properties.stopId;
    if (vehicle.properties.stopId !== prevStopId) {
        // Record observed inter-stop segment time for schedule calibration (EWMA multiplier).
        // Indices are derived from trip.stops by stopId lookup so this works even when
        // the GTFS-RT feed omits currentStopSequence (the prior implementation gated on
        // currentStopSequence and silently never fired for vehicles missing that field).
        // Only fires on adjacent-stop transitions to exclude skipped stops, GPS
        // repositioning, or terminus turnarounds.
        const tripId_c       = vehicle.properties.trip_id ?? marker.properties.trip_id;
        const trip           = window.masterTripsData?.[tripId_c];
        const rc             = vehicle.properties.route_code ?? marker.route_code;
        const dir            = vehicle.properties.direction_id != null
            ? Number(vehicle.properties.direction_id)
            : marker.properties.direction_id;
        // Fallback to per-(route, direction) cache when trip_id is absent from
        // masterTripsData (e.g. B Line owl-service trip IDs that don't match
        // the static GTFS build). Mirrors the same fallback predictions.js uses.
        let stops          = trip?.stops;
        let scheduledTimes = trip?.scheduledTimes;
        if (!stops?.length || scheduledTimes?.length !== stops.length) {
            const cache = getRouteCache(rc, dir);
            if (cache?.stops?.length && cache.times?.length === cache.stops.length) {
                stops          = cache.stops;
                scheduledTimes = cache.times;
            }
        }
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
    if (vehicle.properties.direction_id != null)
        marker.properties.direction_id = Number(vehicle.properties.direction_id);
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
    popup.setHTML(popupHtml); // safe: feed values escaped via escapeHtml() in getPopupHTML
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
 * Fallback DR for routes without shape data (G/J busway): straight-line projection
 * along the marker's heading at smoothed speed × DR_SPEED_FACTOR. Caps at 0.9× the
 * distance to the next stop, or speed × DR_MAX_SECONDS when no stop is known.
 * Pause-but-keep-alive on transient zero-speed reads. Exported for unit testing.
 * @param {string} markerKey trip_id key in the module-level markers object
 */
export function startBearingDeadReckoning(markerKey) {
    const m = markers[markerKey];
    if (!m || isStoppedAt(m.properties?.currentStatus)) return;
    // Busway has no shape data, so lastSnap is always null — Heading is the only
    // sensible source. computeHeading has already disambiguated it via downstreamBearing.
    const bearing = m?.properties?.Heading;
    const speed   = (Number(m?.properties?.smoothedSpeed ?? m?.properties?.speed) || 0) * DR_SPEED_FACTOR;
    if (bearing == null || speed < STATIONARY_SPEED_MPS) return;

    const baseLng = m.getLngLat().lng;
    const baseLat = m.getLngLat().lat;
    const rad     = bearing * Math.PI / 180;
    const sinB    = Math.sin(rad);
    const cosB    = Math.cos(rad);

    const nextStop = window.masterStopsData?.[String(m.properties?.stopId)];
    const maxDist  = nextStop
        ? planarMeters(baseLat, baseLng, nextStop.lat, nextStop.lon) * 0.9
        : speed * DR_MAX_SECONDS;

    const t0 = performance.now();
    // Generation token: a newer DR start increments _drGen, so this loop's tick
    // exits if a fresher loop has taken over (prevents duplicate rAF chains
    // from racing each other when frames arrive mid-tick).
    const gen = (m._drGen = (m._drGen ?? 0) + 1);

    function drTick() {
        if (!markers[markerKey] || markers[markerKey]._drGen !== gen) return;
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed > DR_MAX_SECONDS) { delete animations[markerKey]; return; }

        // Pause-but-keep-alive: skip the move on a transient zero-speed read but
        // keep the rAF chain running so DR resumes the moment speed comes back.
        // Without this, a single noisy zero from the feed kills DR until the next
        // GPS fix arrives — visible as a "frozen" marker between refreshes.
        const _p = markers[markerKey].properties;
        if ((Number(_p?.smoothedSpeed ?? _p?.speed) || 0) >= STATIONARY_SPEED_MPS) {
            const dist = Math.min(speed * elapsed, maxDist);
            markers[markerKey].setLngLat([
                baseLng + (dist * sinB) / M_PER_DEG_LNG_LA,
                baseLat + (dist * cosB) / M_PER_DEG_LAT,
            ]);
        }
        animations[markerKey] = requestAnimationFrame(drTick);
    }

    animations[markerKey] = requestAnimationFrame(drTick);
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

    const tripId = props.trip_id;
    const trip   = window.masterTripsData?.[tripId];
    let stops          = trip?.stops;
    let scheduledTimes = trip?.scheduledTimes;
    // Same fallback as updateExistingMarker: route cache covers trips whose IDs
    // aren't in the static GTFS build (e.g. owl-service B Line trips).
    if (!stops?.length || scheduledTimes?.length !== stops.length) {
        const dir   = props.direction_id != null ? Number(props.direction_id) : null;
        const cache = getRouteCache(String(routeCd), dir);
        if (cache?.stops?.length && cache.times?.length === cache.stops.length) {
            stops          = cache.stops;
            scheduledTimes = cache.times;
        }
    }
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
    if (isStoppedAt(m.properties?.currentStatus)) {
        if (!heavy) return;
        const stop = window.masterStopsData?.[String(m.properties?.stopId)];
        const here = m.getLngLat();
        if (!stop?.lat || !stop?.lon ||
            planarMeters(here.lat, here.lng, stop.lat, stop.lon) <= HEAVY_RAIL_STOPPED_AT_MAX_M) {
            return;
        }
        // Past the proximity gate → fall through and dead-reckon anyway.
    }

    if (!snap) return;
    // Heavy-rail effective speed: when GPS is silent (tunnel), fall back to the
    // average scheduled segment speed so the marker keeps moving toward the next
    // stop. Light rail is intentionally excluded — speed=0 at a red light is real.
    const speed = heavy && rawSpeed < STATIONARY_SPEED_MPS
        ? (_heavyRailScheduleSpeed(m, snap, routeCd) ?? DR_HEAVY_RAIL_FALLBACK_MPS)
        : rawSpeed;
    if (speed < STATIONARY_SPEED_MPS) return;

    // Busway routes have no shape data — use straight-line projection.
    if (!hasShapeData(routeCd)) {
        return startBearingDeadReckoning(markerKey);
    }

    // Arc direction: use downstreamBearing() from the snapped position as primary —
    // it resolves trip stop order and is always in the correct travel direction.
    // Used only to determine same-vs-opposite vs the polyline tangent (never for rotation).
    // Falls back to consecutive arc-diff, then heading comparison.
    let arcSign = +1;
    const fwdBearing = downstreamBearing(m.properties, snap.snappedLng, snap.snappedLat);
    if (fwdBearing != null) {
        const delta = _shortestBearingDelta(fwdBearing, snap.tangentForward);
        arcSign = Math.abs(delta) < 90 ? +1 : -1;
    } else {
        // Fallback: use previous snap direction if current snap has no tangent (degenerate polyline segment)
        // or when downstreamBearing() is unavailable (no stop data, first fix, owl-service trips).
        const prevSnap = m._prevSnap;
        if (prevSnap && Math.abs(snap.arcMeters - prevSnap.arcMeters) > 5) {
            arcSign = snap.arcMeters > prevSnap.arcMeters ? +1 : -1;
        } else {
            const heading = m.properties?.Heading ?? snap.tangentForward;
            const delta   = _shortestBearingDelta(heading, snap.tangentForward);
            arcSign = Math.abs(delta) < 90 ? +1 : -1;
        }
    }

    // Pre-compute next-stop arc cap once at DR start.
    // Only valid when the stop is actually ahead in the direction of travel —
    // STOPPED_AT sends stopId = current station, which would be at baseArc and
    // cause an immediate backward jump if applied unconditionally.
    // Use 1m minimum (not 5m) so a GPS fix close to the stop still gets a cap.
    let stopArcCap = null;
    const nextStop = window.masterStopsData?.[String(m.properties?.stopId)];
    if (nextStop?.lat && nextStop?.lon) {
        const stopSnap = snapToRoute(routeCd, nextStop.lon, nextStop.lat);
        if (stopSnap) {
            const capAhead = arcSign > 0 ? stopSnap.arcMeters > snap.arcMeters + 1
                                         : stopSnap.arcMeters < snap.arcMeters - 1;
            if (capAhead) stopArcCap = stopSnap.arcMeters;
        }
    }

    // Trip-sequence fallback: if stopId didn't yield a cap (missing, wrong, or already
    // passed), walk the trip's ordered stops and use the first one ahead in travel direction.
    // Prevents the fallback-speed DR from coasting past stations with no deceleration target.
    if (stopArcCap === null && heavy) {
        const trip = window.masterTripsData?.[m.properties?.trip_id];
        if (trip?.stops) {
            for (const sid of trip.stops) {
                const s = window.masterStopsData?.[String(sid)];
                if (!s?.lat || !s?.lon) continue;
                const sSnap = snapToRoute(routeCd, s.lon, s.lat);
                if (!sSnap) continue;
                const ahead = arcSign > 0
                    ? sSnap.arcMeters > snap.arcMeters + 1
                    : sSnap.arcMeters < snap.arcMeters - 1;
                if (ahead) { stopArcCap = sSnap.arcMeters; break; }
            }
        }
    }

    const baseArc = snap.arcMeters;
    const t0 = performance.now();
    // Generation token: see startBearingDeadReckoning. Prevents stale rAF
    // chains from racing the active loop when frames arrive mid-tick.
    const gen = (m._drGen = (m._drGen ?? 0) + 1);

    // Pre-compute kinematic deceleration constants for use inside drTick.
    // Phase 1: free travel at `speed` until t_decel seconds.
    // Phase 2: decelerate from `speed` at DR_DECEL_RATE_MPS2 starting at decelStartArc.
    // _decelZone is the actual physics distance to decel from `speed` to 0:
    // v²/(2a). Using the static DR_DECEL_ZONE_M constant caused the marker to
    // freeze short of the stop when v² / (2a) < DR_DECEL_ZONE_M (heavy-rail
    // fallback v=11, a=1 → physics distance 60.5m vs constant 150m → marker
    // stopped 89.5m before La Cienega at t≈30s, matching observed bug).
    // Capped at DR_DECEL_ZONE_M so high-speed approaches don't reserve more
    // than the configured visual ramp.
    const _totalDist     = stopArcCap != null ? Math.abs(stopArcCap - baseArc) : null;
    const _physicsDecelM = (speed * speed) / (2 * DR_DECEL_RATE_MPS2);
    const _decelZone     = Math.min(_physicsDecelM, DR_DECEL_ZONE_M, _totalDist ?? _physicsDecelM);
    const _decelStartArc = stopArcCap != null
        ? stopArcCap - arcSign * _decelZone
        : null;
    const _t_decel = (speed > 0 && _totalDist != null && _totalDist > _decelZone)
        ? (_totalDist - _decelZone) / speed
        : 0;
    const _t_stop = speed / DR_DECEL_RATE_MPS2; // time to reach v=0 from decel zone entry

    function drTick() {
        if (!markers[markerKey] || markers[markerKey]._drGen !== gen) return;
        const elapsed = (performance.now() - t0) / 1000;
        // When a stop cap is known, run until the kinematic decel reaches it.
        // Without a cap (unknown territory), keep the fixed ceiling as a safety valve.
        const _effectiveDrMax = stopArcCap != null ? _t_decel + _t_stop + 10 : drMaxSec;
        if (elapsed > _effectiveDrMax) {
            delete animations[markerKey];
            return;
        }

        // Pause-but-keep-alive: a transient zero-speed read shouldn't kill DR —
        // skip the move this frame and re-test next frame so DR resumes the moment
        // speed comes back. Without this, a single noisy zero from the feed leaves
        // the marker frozen until the next GPS fix arrives.
        // Heavy rail (B/D) skips this pause entirely: it's grade-separated and a
        // mid-tunnel speed=0 read is always GPS dropout, never a real stop.
        const _p = markers[markerKey].properties;
        if (!heavy && (Number(_p?.smoothedSpeed ?? _p?.speed) || 0) < STATIONARY_SPEED_MPS) {
            animations[markerKey] = requestAnimationFrame(drTick);
            return;
        }

        let targetArc = baseArc + arcSign * speed * elapsed;

        // Ramp speed to zero over the final DR_DECEL_ZONE_M to prevent overshooting the stop.
        // Kinematic deceleration ramp in the final DR_DECEL_ZONE_M before the stop.
        // Replaces the hard stop-cap with v(t) = v₀ − a·t physics so the marker
        // visibly slows instead of coasting at full speed to a hard wall.
        if (stopArcCap != null && _decelStartArc != null) {
            const pastDecel = arcSign > 0
                ? targetArc >= _decelStartArc
                : targetArc <= _decelStartArc;

            if (pastDecel && speed > 0) {
                const t_in = Math.min(elapsed - _t_decel, _t_stop);
                const decelPos = _decelStartArc + arcSign * (
                    speed * t_in - 0.5 * DR_DECEL_RATE_MPS2 * t_in * t_in
                );
                targetArc = arcSign > 0
                    ? Math.min(Math.max(_decelStartArc, decelPos), stopArcCap)
                    : Math.max(Math.min(_decelStartArc, decelPos), stopArcCap);
            } else {
                targetArc = arcSign > 0
                    ? Math.min(targetArc, stopArcCap)
                    : Math.max(targetArc, stopArcCap);
            }
        } else if (stopArcCap != null) {
            targetArc = arcSign > 0
                ? Math.min(targetArc, stopArcCap)
                : Math.max(targetArc, stopArcCap);
        }

        const pos = lngLatAtArc(routeCd, targetArc);
        if (!pos) { delete animations[markerKey]; return; }

        markers[markerKey].setLngLat([pos.lng, pos.lat]);

        // Heading: use local polyline tangent at the dead-reckoned position.
        // This naturally rotates through curves without pointing diagonally at
        // the next stop the way a direct great-circle bearing would.
        if (!markers[markerKey].atTerminus && pos.tangent != null) {
            markers[markerKey].setRotation(arcSign > 0 ? pos.tangent : (pos.tangent + 180) % 360);
        }

        animations[markerKey] = requestAnimationFrame(drTick);
    }

    animations[markerKey] = requestAnimationFrame(drTick);
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
 * Single source of truth for stale fade. Stores boolean state on the marker
 * object so it survives DOM events (zoom, pan, layer rebuilds), feed
 * re-broadcasts, and popup-close paths — anything other than this function
 * setting the flag false. Idempotent: matching state is a no-op.
 * @param {Object} marker maplibre marker with attached state
 * @param {boolean} stale  true to fade to 0.5, false to restore to 1
 */
function setMarkerStale(marker, stale) {
    if (!marker || marker._isStale === stale) return;
    marker._isStale = stale;
    const el = marker.getElement?.();
    if (!el) return;
    const durMs = stale ? 1500 : 500;
    // Keep MapLibre's internal _opacity in sync so _update() (fired on every
    // zoom/pan) doesn't overwrite the inline opacity we set below.
    marker._opacity = stale ? 0.5 : 1;
    el.style.transition = `opacity ${durMs}ms`;
    el.style.opacity    = stale ? '0.5' : '1';
    if (stale) el.setAttribute('data-stale', '1');
    else       el.removeAttribute('data-stale');
    // Clear the inline transition after the animation completes so unrelated
    // opacity changes (boarding highlights, etc.) use the CSS default.
    setTimeout(() => { if (marker._isStale === stale) el.style.transition = ''; }, durMs);
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
function _fadeOutAndRemove(markerKey, durMs = 1200) {
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
    if (!el) { m._removed = true; m.remove(); return; }
    // Disable interaction during fade so a popup can't open on a vehicle
    // that's about to vanish.
    el.style.pointerEvents = 'none';
    m._opacity             = 0;
    el.style.transition    = `opacity ${durMs}ms ease-out`;
    el.style.opacity       = '0';
    setTimeout(() => { m._removed = true; m.remove(); }, durMs);
}

/**
 * Start a periodic cleanup interval (STALE_CHECK_INTERVAL_MS) that removes
 * markers older than STALE_THRESHOLD_SEC and fades markers older than
 * STALE_FADE_START_SEC. Also updates the data panel after any removal.
 */
export function initMarkerCleanup() {
    setVisibleInterval(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        let removedAny = false;
        for (const markerKey in markers) {
            const m = markers[markerKey];
            if (!m?.timestamp) continue;
            const age = nowSec - m.timestamp;

            if (age > STALE_THRESHOLD_SEC) {
                _fadeOutAndRemove(markerKey);
                removedAny = true;
            } else if (m._endOfLineSinceTs && (nowSec - m._endOfLineSinceTs) >= TERMINUS_LINGER_S) {
                // Vehicle has been parked at the last stop of its trip past the
                // grace window — fade it out. End-of-line vehicles otherwise
                // sit at full opacity until the 300s general staleness gate,
                // which clutters terminus stations.
                _fadeOutAndRemove(markerKey, TERMINUS_FADE_MS);
                removedAny = true;
            } else {
                // Drive fade from _lastFreshTs (last strictly-newer GPS reading),
                // not marker.timestamp — feeds routinely re-broadcast the last
                // reading, which would otherwise reset the fade clock.
                const freshAge = nowSec - (m._lastFreshTs ?? m.timestamp);
                setMarkerStale(m, freshAge >= STALE_FADE_START_SEC);

                // Animation watchdog: feed is alive (recent fresh frame) but no
                // active rAF loop means DR died (timeout, race, exception). Restart
                // it from the current snap so the marker keeps moving instead of
                // sitting frozen until the user reloads. Idempotent: startDR will
                // no-op if speed/snap conditions aren't met.
                if (freshAge < STALE_LIVE_WINDOW_S && !animations[markerKey]) {
                    if (m.lastSnap) startDeadReckoning(markerKey);
                    else            startBearingDeadReckoning(markerKey);
                }
            }
        }
        if (removedAny) updateDataPanel(markers);
    }, STALE_CHECK_INTERVAL_MS);
}

/**
 * Restore full opacity on a vehicle marker (called when a station popup is closed
 * to un-dim markers that were not part of the boarding highlight set). Honors
 * the stale flag — a stale vehicle stays faded even when the popup closes.
 * @param {string} markerKey trip_id key in the markers object
 */
export function restoreMarkerOpacity(markerKey) {
    const m = markers[markerKey];
    if (!m) return;
    if (m._isStale) return;
    m.getElement().style.opacity = 1;
}
