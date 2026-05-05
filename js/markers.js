import {
    STALE_THRESHOLD_SEC, STALE_CHECK_INTERVAL_MS, STALE_FADE_START_SEC,
    MAX_PLAUSIBLE_SPEED_MPS, GPS_NOISE_FLOOR_DEG, STATIONARY_SPEED_MPS,
    GPS_SPIKE_STOP_RADIUS_M, GPS_SPIKE_MIN_DIST_M, TERMINUS_TURNAROUND_RADIUS_M,
    FINAL_STOP_HOLD_M, RAIL_SNAP_MAX_M, BUS_SNAP_MAX_M, DR_SPEED_FACTOR, RAIL_MAX_SPEED_MPS,
    RAIL_ARC_SPIKE_NOISE_M, DR_MAX_SECONDS, DOWNSTREAM_MIN_METERS,
    DR_SPEED_ALPHA, DR_DECEL_ZONE_M, DR_DECEL_RATE_MPS2,
    routeHexColors,
} from './config.js';
import { getTerminalStopId, getSecondsToNextStop, getScheduledArrivals, isOriginStop, isAtOwnOriginStop } from './predictions.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { closeStationPopup } from './stations.js';
import { snapToRoute, hasShapeData, lngLatAtArc } from './snap.js';
import { computeBearing, planarMeters, M_PER_DEG_LAT, M_PER_DEG_LNG_LA, isStoppedAt, normalizeStopId, setVisibleInterval, isBusRoute } from './utils.js';

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
    if (!trip?.stops?.length) return null;

    // Determine where to start scanning: STOPPED_AT → skip current stop (idx+1).
    let startIdx = 0;
    if (props.stopId) {
        const norm = normalizeStopId(props.stopId);
        const idx = trip.stops.findIndex(s => normalizeStopId(s) === norm);
        if (idx >= 0) startIdx = stopped ? idx + 1 : idx;
    }

    for (let i = startIdx; i < trip.stops.length; i++) {
        const b = bearingToStop(trip.stops[i], fromLng, fromLat);
        if (b != null) return b;
    }

    return null;
}

function computeHeading(marker, vehicle, newLng, newLat) {
    const props       = vehicle.properties;
    const prevHeading = marker.properties?.Heading;
    const speed       = Number(props.position_speed) || 0;

    // Hold heading when nearly stationary — snap tangent has no inherent direction
    // (could be ±180° off) so it can't safely correct a dwell heading.
    if (prevHeading != null && speed < STATIONARY_SPEED_MPS)
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
    if (tangent != null) {
        const downstream = downstreamBearing(props, newLng, newLat);
        if (downstream != null) {
            const delta = ((downstream - tangent + 540) % 360) - 180;
            return Math.abs(delta) < 90 ? tangent : (tangent + 180) % 360;
        }
        return tangent;
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

// Returns true if the new GPS fix should be rejected as a spike.
function isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs) {
    const elapsed = Math.max(newTs - prevTs, 0);
    const distMeters = planarMeters(marker.getLngLat().lat, marker.getLngLat().lng, newLat, newLng);

    // Rail arc-distance gate: snap both positions to the polyline and check whether
    // the arc jump is physically achievable. Far tighter than straight-line speed for
    // multi-stop teleports where the stop happens to be within 5 km of the bad fix.
    // Only applies to routes with shape data (all Metro rail); busway unaffected.
    if (hasShapeData(vehicle.properties.route_code) && marker.lastSnap) {
        const newSnap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (newSnap) {
            const arcJumpM = Math.abs(newSnap.arcMeters - marker.lastSnap.arcMeters);
            // Allow at least 30 s of travel on fresh timestamps; add 500 m for snap noise.
            const maxArcM = RAIL_MAX_SPEED_MPS * Math.max(elapsed, 30) + RAIL_ARC_SPIKE_NOISE_M;
            if (arcJumpM > maxArcM) return true;
        }
    }

    // Implausible speed gate (cheap)
    if (elapsed > 0 && distMeters / elapsed > MAX_PLAUSIBLE_SPEED_MPS) {
        // Secondary: if the new fix is within ~5 km of the next/current stop, the
        // vehicle plausibly teleported across a feed gap — let it through.
        const stopId = vehicle.properties.stopId;
        const stop = stopId != null ? window.masterStopsData?.[String(stopId)] : null;
        if (stop) {
            const distToStop = planarMeters(newLat, newLng, stop.lat, stop.lon);
            if (distToStop > GPS_SPIKE_STOP_RADIUS_M) return true;
        } else {
            return true;
        }
    }

    // Predict-then-validate: if we have last velocity, the new fix should be
    // near where we'd expect.
    const lastV = marker.lastVelocity;
    if (lastV && elapsed > 0) {
        const predLng = marker.getLngLat().lng + lastV.dLng * elapsed;
        const predLat = marker.getLngLat().lat + lastV.dLat * elapsed;
        const errMeters = planarMeters(predLat, predLng, newLat, newLng);
        // Tolerance: noise floor + speed × elapsed × 1.5 (50% acceleration headroom)
        const speed = lastV.speedMps || 0;
        const noiseM = GPS_NOISE_FLOOR_DEG * M_PER_DEG_LAT;
        const tolerance = Math.max(noiseM, speed * elapsed * 1.5 + noiseM);
        if (errMeters > tolerance && distMeters > GPS_SPIKE_MIN_DIST_M) {
            // Secondary check: if new position is far from next stop, it's a spike.
            const stopId = vehicle.properties.stopId;
            const stop = stopId != null ? window.masterStopsData?.[String(stopId)] : null;
            if (stop) {
                const distToStop = planarMeters(newLat, newLng, stop.lat, stop.lon);
                if (distToStop > GPS_SPIKE_STOP_RADIUS_M) return true;
            }
            // No stop data → trust the prediction failure
            else return true;
        }
    }

    return false;
}

let _lastTripCoverageCheck = 0;
const TRIP_COVERAGE_CHECK_INTERVAL_MS = 300_000; // re-run every 5 min to catch post-deploy drift

export function processVehicleData(data, features, map) {
    const nowSec = Math.floor(Date.now() / 1000);
    data.features
        .filter(v => v.properties?.trip_id)
        .forEach(vehicle => {
            const ts = parseInt(vehicle.properties.timestamp);
            if (nowSec - ts > STALE_THRESHOLD_SEC) return;

            const markerKey = vehicle.properties.trip_id;
            const existing = markers[markerKey];
            if (existing) {
                const prevTs = parseInt(existing.timestamp);
                // Wall-clock ordering only (no sequence numbers in GTFS-RT feed).
                // Vehicle clock skew / NTP corrections could theoretically reorder frames,
                // but Metro's feed is reliable enough that this is acceptable.
                if (ts > prevTs) {
                    // Don't mutate marker.timestamp here — the spike filter needs the
                    // previous timestamp to compute elapsed. updateExistingMarker
                    // advances it after the fix is accepted (or rejected as a spike).
                    updateExistingMarker(vehicle, features, map, markerKey, prevTs);
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
                    markers[oldMarkerKey].remove();
                    delete markers[oldMarkerKey];
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
    const ts = parseInt(timestamp);

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

function updateExistingMarker(vehicle, features, map, markerKey, prevTs) {
    const marker = markers[markerKey];
    if (!marker) return;

    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
        delete animations[markerKey];
    }

    const current = marker.getLngLat();
    const [newLng, newLat] = vehicle.geometry.coordinates;
    const newTs = parseInt(vehicle.properties.timestamp);

    // Skip spike check on the first real update (no velocity/snap reference yet) or
    // when the marker reference has gone stale and needs a fresh anchor.
    const isFirstFix = !(marker.validFixCount > 0);
    const isStaleRef = (newTs - (marker.timestamp ?? newTs)) > STALE_FADE_START_SEC;
    if (!isFirstFix && !isStaleRef && isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs)) {
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
        updatePopup(vehicle, markerKey);
        return;
    }
    marker.validFixCount = (marker.validFixCount ?? 0) + 1;

    marker.timestamp = newTs;
    // Only restore opacity if this is a genuinely fresh fix — repeated stale
    // timestamps from the feed shouldn't cancel the fade.
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - newTs < STALE_FADE_START_SEC) {
        const el = marker.getElement();
        el.removeAttribute('data-stale');
        el.style.transition = '';
        el.style.opacity = 1;
    }

    // Snap to polyline before computing heading so downstreamBearing()
    // is called from the track centerline, not the GPS-jitter offset.
    let targetLng = newLng;
    let targetLat = newLat;
    if (hasShapeData(vehicle.properties.route_code)) {
        const snap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (snap) {
            const snapDistM = planarMeters(snap.snappedLat, snap.snappedLng, newLat, newLng);
            const snapMaxM = isBusRoute(vehicle.properties.route_code) ? BUS_SNAP_MAX_M : RAIL_SNAP_MAX_M;
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

    const terminusNow = isAtTerminus(vehicle.properties);

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

    if (distMeters > 5000) { // huge legitimate gap — teleport
        marker.setLngLat([targetLng, targetLat]);
        marker.setRotation(dispHeading);
        updateMarkerTimestamp(marker, vehicle);
    } else {
        animateMarker(markerKey, current, diffLng, diffLat, targetLng, targetLat, dispStart, dispHeading, 60)
            .then(() => {
                updateMarkerTimestamp(marker, vehicle);
                startDeadReckoning(markerKey);
            });
    }

    const prevStopId = marker.properties.stopId;
    marker.properties.stopId = vehicle.properties.stopId;
    if (vehicle.properties.stopId !== prevStopId) {
        marker.properties.statusChangedAt = newTs;
    }
    if (vehicle.properties.direction_id != null)
        marker.properties.direction_id = Number(vehicle.properties.direction_id);
    marker.properties.currentStatus = vehicle.properties.currentStatus ?? null;

    if (terminusNow !== marker.atTerminus) {
        const brandColor = routeHexColors[marker.route_code] || '#231f20';
        marker.getElement().style.backgroundImage = markerSvgUrl(vehicle.properties.agency || 'metro', marker.route_code, brandColor, terminusNow);
        marker.atTerminus = terminusNow;
        if (terminusNow) marker.setRotation(0);
    }

    applyOriginVisibility(marker, marker.properties);

    updatePopup(vehicle, markerKey);
}

// Suppress visible marker when STOPPED_AT the route's own origin (idx=0). The
// marker object stays alive — only its DOM element is hidden — so popups, ETAs,
// and highlights still work. Boarding badges in stations.js take over the visual.
function applyOriginVisibility(marker, props) {
    const el = marker.getElement?.();
    if (!el) return;
    const hidden = isAtOwnOriginStop(props);
    el.style.visibility   = hidden ? 'hidden' : 'visible';
    el.style.pointerEvents = hidden ? 'none' : '';
}

function updateMarkerTimestamp(marker, vehicle) {
    if (vehicle.properties) {
        const newTs = parseInt(vehicle.properties.timestamp);
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

// Fallback DR for routes without shape data (G/J busway): straight-line projection.
function startBearingDeadReckoning(markerKey) {
    const m = markers[markerKey];
    if (!m || isStoppedAt(m.properties?.currentStatus)) return;
    const bearing = m?.lastSnap?.tangentForward;
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

    function drTick() {
        if (!markers[markerKey]) return;
        // Pause DR if vehicle has come to a full stop (e.g. red light on grade-running segment).
        // Use smoothedSpeed so brief noise zeros don't kill an in-progress animation.
        const _p = markers[markerKey].properties;
        if ((Number(_p?.smoothedSpeed ?? _p?.speed) || 0) < STATIONARY_SPEED_MPS) {
            delete animations[markerKey]; return;
        }
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed > DR_MAX_SECONDS) { delete animations[markerKey]; return; }

        const dist = Math.min(speed * elapsed, maxDist);
        markers[markerKey].setLngLat([
            baseLng + (dist * sinB) / M_PER_DEG_LNG_LA,
            baseLat + (dist * cosB) / M_PER_DEG_LAT,
        ]);
        animations[markerKey] = requestAnimationFrame(drTick);
    }

    animations[markerKey] = requestAnimationFrame(drTick);
}

// Arc-progression DR for rail routes: walks the polyline in arc-distance so the
// marker stays on the track through curves. Heading flex recomputes each frame
// from the dead-reckoned position toward the next scheduled stop.
function startDeadReckoning(markerKey) {
    const m        = markers[markerKey];
    if (!m || isStoppedAt(m.properties?.currentStatus)) return;
    const snap     = m?.lastSnap;
    const speed    = (Number(m?.properties?.smoothedSpeed ?? m?.properties?.speed) || 0) * DR_SPEED_FACTOR;
    const routeCd  = m?.route_code;

    if (!snap || speed < STATIONARY_SPEED_MPS) return;

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
        const delta = ((fwdBearing - snap.tangentForward + 540) % 360) - 180;
        arcSign = Math.abs(delta) < 90 ? +1 : -1;
    } else {
        const prevSnap = m._prevSnap;
        if (prevSnap && Math.abs(snap.arcMeters - prevSnap.arcMeters) > 5) {
            arcSign = snap.arcMeters > prevSnap.arcMeters ? +1 : -1;
        } else {
            const heading = m.properties?.Heading ?? snap.tangentForward;
            const delta   = ((heading - snap.tangentForward + 540) % 360) - 180;
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

    const baseArc = snap.arcMeters;
    const t0 = performance.now();

    // Pre-compute kinematic deceleration constants for use inside drTick.
    // Phase 1: free travel at `speed` until t_decel seconds.
    // Phase 2: decelerate from `speed` at DR_DECEL_RATE_MPS2 starting at decelStartArc.
    const _totalDist     = stopArcCap != null ? Math.abs(stopArcCap - baseArc) : null;
    const _decelZone     = Math.min(DR_DECEL_ZONE_M, _totalDist ?? DR_DECEL_ZONE_M);
    const _decelStartArc = stopArcCap != null
        ? stopArcCap - arcSign * _decelZone
        : null;
    const _t_decel = (speed > 0 && _totalDist != null && _totalDist > DR_DECEL_ZONE_M)
        ? (_totalDist - DR_DECEL_ZONE_M) / speed
        : 0;
    const _t_stop = speed / DR_DECEL_RATE_MPS2; // time to reach v=0 from decel zone entry

    function drTick() {
        if (!markers[markerKey]) return;
        // Pause DR if vehicle has come to a full stop (e.g. red light on grade-running segment).
        // Use smoothedSpeed so brief noise zeros don't kill an in-progress animation.
        const _p = markers[markerKey].properties;
        if ((Number(_p?.smoothedSpeed ?? _p?.speed) || 0) < STATIONARY_SPEED_MPS) {
            delete animations[markerKey]; return;
        }
        const elapsed = (performance.now() - t0) / 1000;
        if (elapsed > DR_MAX_SECONDS) { delete animations[markerKey]; return; }

        let targetArc = baseArc + arcSign * speed * elapsed;

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
        const headingDelta = ((targetHeading - startHeading + 540) % 360) - 180;
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

export function initMarkerCleanup() {
    setVisibleInterval(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        let removedAny = false;
        for (const markerKey in markers) {
            const m = markers[markerKey];
            if (!m?.timestamp) continue;
            const age = nowSec - m.timestamp;

            if (age > STALE_THRESHOLD_SEC) {
                if (animations[markerKey]) {
                    cancelAnimationFrame(animations[markerKey]);
                    delete animations[markerKey];
                }
                m.remove();
                delete markers[markerKey];
                removedAny = true;
            } else {
                const el = m.getElement();
                if (age >= STALE_FADE_START_SEC) {
                    if (!el.hasAttribute('data-stale')) {
                        el.setAttribute('data-stale', '1');
                        el.style.transition = 'opacity 1.5s';
                        el.style.opacity = '0.5';
                        setTimeout(() => { el.style.transition = ''; }, 1500);
                    }
                } else {
                    el.removeAttribute('data-stale');
                    el.style.transition = '';
                    el.style.opacity = '1';
                }
            }
        }
        if (removedAny) updateDataPanel(markers);
    }, STALE_CHECK_INTERVAL_MS);
}

export function restoreMarkerOpacity(markerKey) {
    if (markers[markerKey]) markers[markerKey].getElement().style.opacity = 1;
}
