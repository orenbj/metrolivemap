import {
    VEHICLE_SIZE_PX, STALE_THRESHOLD_SEC, STALE_CHECK_INTERVAL_MS, MOVEMENT_THRESHOLD,
    STATIONARY_SPEED_MPS, MAX_PLAUSIBLE_SPEED_MPS, ARC_PROGRESSION_MIN_METERS,
    BUS_HISTORY_MIN_METERS, HISTORY_RING_SIZE, GPS_NOISE_FLOOR_DEG,
    routeHexColors, routeDirectionLabels,
} from './config.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { closeStationPopup } from './stations.js';
import { snapToRoute, hasShapeData, dir0Increases } from './snap.js';
import { computeBearing, IS_HOVER_DEVICE } from './utils.js';

export const markers = {};
const animations = {};

// Mean meters per degree at LA latitude (~34°). Sufficient precision for tangent
// length comparisons and predict-validate windows; not used for routing.
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_LA = 92500;

function planarMeters(lat1, lng1, lat2, lng2) {
    const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
    const dLng = (lng2 - lng1) * M_PER_DEG_LNG_LA;
    return Math.sqrt(dLat * dLat + dLng * dLng);
}

const DIRECTION_BEARINGS = {
    'Northbound': 0,
    'Southbound': 180,
    'Eastbound': 90,
    'Westbound': 270,
    'Southbound / Eastbound': 135,
    'Northbound / Westbound': 315,
};

function directionIdToBearing(routeCode, directionId) {
    const labels = routeDirectionLabels[routeCode];
    if (!labels) return null;
    const label = labels[directionId];
    if (!label) return null;
    return DIRECTION_BEARINGS[label] ?? null;
}

// Minimum distance to a stop before its bearing is considered non-degenerate.
const DOWNSTREAM_MIN_METERS = 50;

/**
 * Bearing from current position to a single stop.
 * Returns null if stop data is missing or the stop is too close.
 */
function bearingToStop(stopId, fromLng, fromLat) {
    if (!stopId) return null;
    const stop = window.masterStopsData?.[String(stopId)];
    if (!stop?.lat || !stop?.lon) return null;
    if (planarMeters(fromLat, fromLng, stop.lat, stop.lon) < DOWNSTREAM_MIN_METERS) return null;
    return computeBearing(fromLng, fromLat, stop.lon, stop.lat);
}

/**
 * Compute the bearing from the current position toward the vehicle's immediate
 * direction of travel, using the most local available signal:
 *
 *   1. Bearing to next stop (props.stopId) — most local, most accurate.
 *   2. Walk forward through the trip's stop sequence to find the first stop
 *      that is ≥ DOWNSTREAM_MIN_METERS away. This handles the case where the
 *      vehicle is right on top of the next stop (degenerate bearing) or when
 *      stopId hasn't refreshed yet after a stop departure.
 *
 * Returns null if no usable stop data is available.
 */
function downstreamBearing(props, fromLng, fromLat) {
    // 1. Next stop — immediate ground truth
    const nextBearing = bearingToStop(props.stopId, fromLng, fromLat);
    if (nextBearing != null) return nextBearing;

    // 2. Walk forward through the trip's stop sequence
    const trip = window.masterTripsData?.[props.trip_id];
    if (!trip?.stops?.length) return null;

    // Find the index of the current stop in the trip sequence, then scan ahead.
    // Using stopId lookup is more reliable than trusting currentStopSequence numbering.
    let startIdx = 0;
    if (props.stopId) {
        const idx = trip.stops.findIndex(s => String(s) === String(props.stopId));
        if (idx >= 0) startIdx = idx;
    }

    for (let i = startIdx; i < trip.stops.length; i++) {
        const b = bearingToStop(trip.stops[i], fromLng, fromLat);
        if (b != null) return b;
    }

    return null;
}

function isStationaryStatus(status) {
    return status === 1 || status === 'STOPPED_AT';
}

function pushHistory(buf, entry) {
    buf.push(entry);
    if (buf.length > HISTORY_RING_SIZE) buf.shift();
}

/**
 * Compute heading for a vehicle marker.
 *
 * Signal priority (same logic for both rail and bus):
 *
 *   0. Stationary hold — speed < 0.5 m/s or STOPPED_AT: keep last heading.
 *      Exception: cold-start has no last heading, so we still compute.
 *
 *   0b. Terminus-zone hold — within 150 m of the trip's final stop AND we have
 *       a previous heading: hold it. Prevents degenerate bearing flips as the
 *       vehicle decelerates into the platform. Once a new trip_id is assigned
 *       the marker is recreated and heading derives cleanly.
 *
 *   1. Bearing to next stop (downstreamBearing) — the immediate ground truth.
 *      For rail: orients the polyline tangent (smooth curve following).
 *      For bus: used directly as the heading.
 *
 *   2. Bearing to final destination — backup when next-stop and all forward
 *      stops in the sequence are degenerate (vehicle sitting right on top of
 *      them). For rail: orients tangent. For bus: used directly.
 *
 *   3. Rail only — arc-progression history → direction_id + dir0IncreasesArc.
 *      Bus only — vector-mean of recent displacement history.
 *
 *   4. Last resort — direction_id cardinal → position_bearing → prev or 0.
 */
function computeHeading(marker, vehicle, newLng, newLat, newTs) {
    const props      = vehicle.properties;
    const routeCode  = props.route_code;
    const speed      = Number(props.position_speed) || 0;
    const status     = props.currentStatus;
    const directionId = props.direction_id;

    const stationary  = speed < STATIONARY_SPEED_MPS || isStationaryStatus(status);
    const prevHeading = marker.properties?.Heading;

    // ── Stationary hold ─────────────────────────────────────────────────────
    if (stationary && prevHeading != null) return prevHeading;

    // ── Terminus-zone hold ───────────────────────────────────────────────────
    // Hold heading when within 150 m of the trip's final stop. Prevents the
    // bearing-to-stop signal from becoming degenerate as the vehicle arrives.
    if (prevHeading != null) {
        const trip = window.masterTripsData?.[props.trip_id];
        if (trip?.stops?.length) {
            const finalStop = window.masterStopsData?.[String(trip.stops[trip.stops.length - 1])];
            if (finalStop && planarMeters(newLat, newLng, finalStop.lat, finalStop.lon) < 150) {
                return prevHeading;
            }
        }
    }

    // ── RAIL: polyline tangent oriented by downstream bearing ────────────────
    if (hasShapeData(routeCode)) {
        const snap = snapToRoute(routeCode, newLng, newLat);
        if (!snap) return prevHeading ?? 0;

        if (!marker.arcHistory) marker.arcHistory = [];
        pushHistory(marker.arcHistory, { arcIndex: snap.arcIndex, arcMeters: snap.arcMeters, ts: newTs });

        // Record direction-of-travel from a reference bearing (for arc-progression fallback).
        function recordDirection(refBearing) {
            const fwd = snap.tangentForward;
            const diffFwd = Math.abs(((fwd - refBearing + 540) % 360) - 180);
            marker.dirAlongPolylineIncreasing = diffFwd <= 90;
        }

        // 1. Next stop (or walk-forward) — primary.
        // Compute bearing from the SNAPPED position (not raw GPS) so the arrow
        // points along the track, not along the GPS-jitter offset. Position is
        // also rendered at the snapped point, so heading and position agree.
        const dsBearing = downstreamBearing(props, snap.snappedLng, snap.snappedLat);
        if (dsBearing != null) { recordDirection(dsBearing); return dsBearing; }

        // 2. Final destination — backup when all stops are degenerate
        const trip = window.masterTripsData?.[props.trip_id];
        if (trip?.stops?.length) {
            const finalStop = window.masterStopsData?.[String(trip.stops[trip.stops.length - 1])];
            if (finalStop) {
                const dist = planarMeters(snap.snappedLat, snap.snappedLng, finalStop.lat, finalStop.lon);
                if (dist >= DOWNSTREAM_MIN_METERS) {
                    const destBearing = computeBearing(snap.snappedLng, snap.snappedLat, finalStop.lon, finalStop.lat);
                    recordDirection(destBearing);
                    return destBearing;
                }
            }
        }

        // 3. Arc-progression history
        let increasing = null;
        const hist = marker.arcHistory;
        if (hist.length >= 2) {
            const newest = hist[hist.length - 1];
            for (let i = 0; i < hist.length - 1; i++) {
                if (Math.abs(newest.arcMeters - hist[i].arcMeters) >= ARC_PROGRESSION_MIN_METERS) {
                    increasing = newest.arcMeters > hist[i].arcMeters;
                    break;
                }
            }
        }

        // 4. direction_id prior
        if (increasing == null && directionId != null) {
            const dir0Inc = dir0Increases(routeCode);
            increasing = (Number(directionId) === 0) === dir0Inc;
        }

        if (increasing == null) increasing = marker.dirAlongPolylineIncreasing ?? true;
        marker.dirAlongPolylineIncreasing = increasing;
        return increasing ? snap.tangentForward : (snap.tangentForward + 180) % 360;
    }

    // ── BUS: bearing-to-next-stop primary, vector-mean fallback ─────────────
    if (!marker.posHistory) marker.posHistory = [];

    // Stop-sequence regression → direction reversal: clear movement history
    const seq = props.currentStopSequence;
    if (seq != null && marker.lastStopSequence != null && Number(seq) < Number(marker.lastStopSequence)) {
        marker.posHistory = [];
    }
    if (seq != null) marker.lastStopSequence = Number(seq);

    pushHistory(marker.posHistory, { lng: newLng, lat: newLat, ts: newTs, speed });

    // 1. Next stop bearing — primary
    const dsBearing = downstreamBearing(props, newLng, newLat);
    if (dsBearing != null) return dsBearing;

    // 2. Final destination bearing — backup
    const busTrip = window.masterTripsData?.[props.trip_id];
    if (busTrip?.stops?.length) {
        const finalStop = window.masterStopsData?.[String(busTrip.stops[busTrip.stops.length - 1])];
        if (finalStop && planarMeters(newLat, newLng, finalStop.lat, finalStop.lon) >= DOWNSTREAM_MIN_METERS) {
            return computeBearing(newLng, newLat, finalStop.lon, finalStop.lat);
        }
    }

    // 3. Vector-mean of recent displacements
    let sumDLng = 0, sumDLat = 0, totalMeters = 0;
    for (let i = 1; i < marker.posHistory.length; i++) {
        const a = marker.posHistory[i - 1];
        const b = marker.posHistory[i];
        sumDLng += (b.lng - a.lng);
        sumDLat += (b.lat - a.lat);
        totalMeters += planarMeters(a.lat, a.lng, b.lat, b.lng);
    }
    if (totalMeters >= BUS_HISTORY_MIN_METERS && (sumDLng !== 0 || sumDLat !== 0)) {
        return computeBearing(newLng, newLat, newLng + sumDLng, newLat + sumDLat);
    }

    // 4. direction_id cardinal → position_bearing → prev
    const cardinal = directionId != null ? directionIdToBearing(routeCode, Number(directionId)) : null;
    if (cardinal != null) return cardinal;

    const apiBearing = Number(props.position_bearing);
    if (Number.isFinite(apiBearing) && apiBearing >= 0 && apiBearing < 360
            && speed > 1 && !isStationaryStatus(status)) return apiBearing;

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

// Metrolink — pentagon
function makePentagonSvgUrl(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">
        <path d="M 25 4 L 39 18 L 39 46 Q 39 48 37 48 L 13 48 Q 11 48 11 46 L 11 18 Z"
              fill="${color}" stroke="#ffffff" stroke-width="3.5" stroke-linejoin="round"/>
    </svg>`;
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
}

function markerSvgUrl(agency, routeCode, color) {
    if (agency === 'metrolink') return makePentagonSvgUrl(color);
    if (['901', '910'].includes(routeCode)) return makeSquareSvgUrl(color);
    return makeArrowSvgUrl(color);
}

/**
 * Predict-then-validate GPS outlier rejection.
 *
 * If we have a previous accepted velocity, predict the expected next position
 * and accept the new fix when it falls inside a tolerance circle whose radius
 * grows with elapsed time and the noise floor. Falls back to the simpler
 * speed-window check when no prior velocity exists (cold start).
 *
 * Always rejects implausibly fast implied speeds (>MAX_PLAUSIBLE_SPEED_MPS).
 *
 * @returns {boolean} true if the new fix should be REJECTED.
 */
function isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs) {
    const elapsed = Math.max(newTs - prevTs, 0);
    const distMeters = planarMeters(marker.getLngLat().lat, marker.getLngLat().lng, newLat, newLng);

    // Implausible speed gate (cheap)
    if (elapsed > 0 && distMeters / elapsed > MAX_PLAUSIBLE_SPEED_MPS) {
        // Secondary: if the new fix is within ~5 km of the next/current stop, the
        // vehicle plausibly teleported across a feed gap — let it through.
        const stopId = vehicle.properties.stopId;
        const stop = stopId != null ? window.masterStopsData?.[String(stopId)] : null;
        if (stop) {
            const distToStop = planarMeters(newLat, newLng, stop.lat, stop.lon);
            if (distToStop > 5000) return true;
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
        if (errMeters > tolerance && distMeters > 200) {
            // Secondary check: if new position is far from next stop, it's a spike.
            const stopId = vehicle.properties.stopId;
            const stop = stopId != null ? window.masterStopsData?.[String(stopId)] : null;
            if (stop) {
                const distToStop = planarMeters(newLat, newLng, stop.lat, stop.lon);
                if (distToStop > 5000) return true;
            }
            // No stop data → trust the prediction failure
            else return true;
        }
    }

    return false;
}

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
                        if (dist < 1000) { // <1 km
                            oldMarkerKey = key;
                            isTerminusTurnaround = true;
                            break;
                        }
                    }
                }

                if (isTerminusTurnaround && oldMarkerKey) {
                    // Terminus turnaround = new trip in opposite direction. Don't carry old
                    // heading — let the new computeHeading derive it from direction_id and
                    // the (now opposite) arc-progression once movement begins.
                    markers[oldMarkerKey].remove();
                    delete markers[oldMarkerKey];
                }
                createNewMarker(vehicle, features, map, markerKey);
            }
        });

    updateDataPanel(markers);
}

function createNewMarker(vehicle, features, map, markerKey) {
    const { vehicle_id, route_code, trip_id, timestamp } = vehicle.properties;
    const agency = vehicle.properties.agency || 'metro';
    const isMetrolink = agency === 'metrolink';
    const isBus = !isMetrolink && ['901', '910'].includes(route_code);

    if (markers[markerKey]) {
        markers[markerKey].remove();
        delete markers[markerKey];
    }

    const el = document.createElement('div');
    el.className = 'marker';
    el.setAttribute('data-route', route_code);
    el.setAttribute('data-trip', trip_id);
    el.setAttribute('data-mode', isMetrolink ? 'metrolink' : (isBus ? 'bus' : 'rail'));
    el.setAttribute('data-agency', agency);
    el.setAttribute('data-timestamp', timestamp);
    el.setAttribute('data-vehicle-id', vehicle_id);
    const sizeExpr = isBus
        ? 'calc(var(--vehicle-size, 24px) * 0.85)'
        : 'var(--vehicle-size, 24px)';
    el.style.cssText = `width:${sizeExpr};height:${sizeExpr};background-repeat:no-repeat;background-size:contain;background-position:center;cursor:pointer;`;

    const brandColor = routeHexColors[route_code] || '#231f20';
    el.style.backgroundImage = markerSvgUrl(agency, route_code, brandColor);

    const [lng, lat] = vehicle.geometry.coordinates;
    const ts = parseInt(timestamp);

    const vehicleLabel = isMetrolink ? 'Train #' : (isBus ? 'Bus ID ' : 'Train Car #');
    const { stopId, currentStatus, direction_id, currentStopSequence } = vehicle.properties;
    const popupHtml = getPopupHTML(route_code, vehicle_id, vehicleLabel, timestamp, stopId, currentStatus, direction_id, trip_id, currentStopSequence, agency);
    const popup = new maplibregl.Popup({ offset: 15 }).setHTML(popupHtml);
    popup.on('open', closeStationPopup);

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
        vehicle_id, trip_id,
        // Heading is intentionally undefined on cold start so computeHeading
        // does not treat "0" as a real prior bearing under the stationary-hold rule.
        Heading: undefined,
        speed: vehicle.properties.position_speed,
    };
    marker.timestamp = ts;
    marker.route_code = route_code;
    marker.arcHistory = [];
    marker.posHistory = [];
    marker.lastStopSequence = currentStopSequence != null ? Number(currentStopSequence) : null;
    marker.lastVelocity = null;

    // Initial heading derivation. computeHeading wants the marker to already have
    // its current LngLat set (it is) — pass new = current to indicate cold start.
    const heading = computeHeading(marker, vehicle, lng, lat, ts);
    marker.properties.Heading = heading;
    marker.setRotation(heading);

    // Hover tooltip (desktop only): show popup on mouseenter, dismiss on
    // mouseleave unless the user has already clicked to pin it open.
    if (IS_HOVER_DEVICE) {
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
    }

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

    if (isGpsSpike(marker, vehicle, newLng, newLat, newTs, prevTs)) {
        // Spike — advance timestamp/popup but hold position & heading.
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
        updatePopup(vehicle, markerKey);
        return;
    }

    // Now safe to advance the recorded timestamp.
    marker.timestamp = newTs;

    // Heading: derived fresh each frame from authoritative signals (see computeHeading).
    const newHeading = computeHeading(marker, vehicle, newLng, newLat, newTs);
    const startHeading = marker.properties.Heading ?? newHeading;

    marker.properties.Heading = newHeading;
    marker.properties.speed = vehicle.properties.position_speed;

    // Snap position to track. Reject snap if >~500 m from raw GPS (loop-route mismatch guard).
    let targetLng = newLng;
    let targetLat = newLat;
    if (hasShapeData(vehicle.properties.route_code)) {
        const snap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (snap) {
            const snapDistM = planarMeters(snap.snappedLat, snap.snappedLng, newLat, newLng);
            if (snapDistM < 500) {
                targetLng = snap.snappedLng;
                targetLat = snap.snappedLat;
            }
        }
    }

    // Update last-velocity for next predict-then-validate
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
        marker.setRotation(newHeading);
        updateMarkerTimestamp(marker, vehicle);
    } else {
        animateMarker(markerKey, current, diffLng, diffLat, targetLng, targetLat, startHeading, newHeading, 60)
            .then(() => updateMarkerTimestamp(marker, vehicle));
    }

    marker.properties.stopId = vehicle.properties.stopId;
    updatePopup(vehicle, markerKey);
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
    const isMetrolink = agency === 'metrolink';
    const isBus = !isMetrolink && ['901', '910'].includes(marker.route_code);
    const vehicleLabel = isMetrolink ? 'Train #' : (isBus ? 'Bus ID ' : 'Train Car #');
    const { stopId, currentStatus, direction_id, currentStopSequence } = vehicle.properties;
    const tripId = marker.properties.trip_id;
    const popupHtml = getPopupHTML(marker.route_code, vehicle.properties.vehicle_id, vehicleLabel, marker.timestamp, stopId, currentStatus, direction_id, tripId, currentStopSequence, agency);
    popup.setHTML(popupHtml);
}

/**
 * Animate position (cubic-eased) AND heading (shortest signed arc) over `steps` frames.
 * Heading interpolation handles 0/360 wrap correctly; small (<1°) deltas snap.
 */
function animateMarker(markerKey, startCoords, diffLng, diffLat, targetLng, targetLat, startHeading, targetHeading, steps) {
    return new Promise(resolve => {
        const headingDelta = ((targetHeading - startHeading + 540) % 360) - 180;
        const skipHeadingAnim = Math.abs(headingDelta) < 1;
        const m0 = markers[markerKey];
        if (m0 && skipHeadingAnim) m0.setRotation(targetHeading);

        let i = 0;
        function animate() {
            const m = markers[markerKey];
            if (!m) {
                delete animations[markerKey];
                return resolve();
            }
            if (i <= steps) {
                const progress = i / steps;
                const eased = progress < 0.5
                    ? 4 * progress * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                m.setLngLat([
                    startCoords.lng + eased * diffLng,
                    startCoords.lat + eased * diffLat,
                ]);
                if (!skipHeadingAnim) {
                    m.setRotation((startHeading + eased * headingDelta + 360) % 360);
                }
                i++;
                animations[markerKey] = requestAnimationFrame(animate);
            } else {
                if (targetLng != null && targetLat != null) {
                    m.setLngLat([targetLng, targetLat]);
                }
                m.setRotation(targetHeading);
                delete animations[markerKey];
                resolve();
            }
        }
        animate();
    });
}

export function initMarkerCleanup() {
    setInterval(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        let removedAny = false;
        for (const markerKey in markers) {
            if (markers[markerKey]?.timestamp && nowSec - markers[markerKey].timestamp > STALE_THRESHOLD_SEC) {
                if (animations[markerKey]) {
                    cancelAnimationFrame(animations[markerKey]);
                    delete animations[markerKey];
                }
                markers[markerKey].remove();
                delete markers[markerKey];
                removedAny = true;
            }
        }
        if (removedAny) updateDataPanel(markers);
    }, STALE_CHECK_INTERVAL_MS);
}
