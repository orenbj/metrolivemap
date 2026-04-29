import { VEHICLE_SIZE_PX, STALE_THRESHOLD_SEC, STALE_CHECK_INTERVAL_MS, MOVEMENT_THRESHOLD, routeHexColors, routeDirectionLabels } from './config.js';
import { updateDataPanel, getPopupHTML } from './ui.js';
import { closeStationPopup } from './stations.js';
import { snapToRoute, hasShapeData } from './snap.js';
import { computeBearing } from './utils.js';

export const markers = {};
const animations = {};



/**
 * Picks whichever of `bearing` or `bearing+180` is angularly closer to `reference`.
 * This enforces the 270° rule: we tolerate up to ±135° of natural curve drift
 * but will never allow a 180° direction flip.
 */
function alignToReference(bearing, reference) {
    const flipped = (bearing + 180) % 360;
    const diffA = Math.abs(((bearing - reference + 540) % 360) - 180);
    const diffB = Math.abs(((flipped  - reference + 540) % 360) - 180);
    return diffA <= diffB ? bearing : flipped;
}

/** Minimum angular difference between two headings (0–180). */
function angleDiff(a, b) {
    return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Maps a GTFS direction label ("Northbound", "Eastbound", …) to a cardinal bearing.
 * Returns null for compound or unknown labels.
 */
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

/**
 * Computes the best heading for a vehicle marker.
 *
 * KEY DESIGN: Direction is sticky (270° rule). Once established via
 * existingHeading, we align snap to it — the arrow can follow track curves
 * but will never flip 180°. This holds until the trip ends (new trip_id =
 * new marker = fresh calculation). Terminus turnaround is free because the
 * old marker is removed and a fresh one is created.
 *
 * Warm-state correction: if significant movement (>50 m) clearly contradicts
 * the locked heading (>90° apart), we recalibrate — catches wrong cold-start.
 *
 * Cold-start signal stack (no existingHeading yet):
 *   1. Movement trajectory  — most reliable, but zero on first frame
 *   2. GTFS direction_id    — cardinal bearing, always available
 *   3. API position_bearing — noisy but correct quadrant
 *   4. Stop approach bearing
 */
function computeHeading(vehicle, fromLng, fromLat, toLng, toLat, existingHeading) {
    const routeCode = vehicle.properties.route_code;

    // Get track-snapped angle (precise, but ambiguous — two possible directions)
    let snapBearing = null;
    if (hasShapeData(routeCode)) {
        const snap = snapToRoute(routeCode, toLng, toLat);
        if (snap) snapBearing = snap.bearing;
    }

    const dLng = toLng - fromLng;
    const dLat = toLat - fromLat;
    const hasMovement = Math.abs(dLng) > MOVEMENT_THRESHOLD || Math.abs(dLat) > MOVEMENT_THRESHOLD;

    // ── LOCKED: existing heading established — align snap, never flip 180° ──
    if (existingHeading != null) {
        // Shape data is ground truth for rail: snap + 270° rule is sufficient.
        // Skip GPS-based recalibration entirely when we have a snap bearing —
        // noisy GPS movement can never corrupt the locked direction this way.
        if (snapBearing != null) return alignToReference(snapBearing, existingHeading);

        // No shape data (G/J buses): only recalibrate if movement is large
        // (~220 m) AND clearly contradicts (>135°, i.e. genuinely reversed).
        if (hasMovement && (Math.abs(dLng) > 0.002 || Math.abs(dLat) > 0.002)) {
            const movBearing = computeBearing(fromLng, fromLat, toLng, toLat);
            if (angleDiff(movBearing, existingHeading) > 135) {
                return movBearing;
            }
        }
        return existingHeading;
    }

    // ── COLD START: establish direction from motion signals ──
    let reference = null;

    // 1. Movement trajectory
    if (hasMovement) {
        reference = computeBearing(fromLng, fromLat, toLng, toLat);
    }

    // 2. GTFS direction_id → cardinal bearing (reliable, always available)
    if (reference == null) {
        const { direction_id } = vehicle.properties;
        if (direction_id != null) {
            reference = directionIdToBearing(routeCode, direction_id);
        }
    }

    // 3. API-provided bearing (noisy — 0 is treated as missing)
    if (reference == null) {
        const api = vehicle.properties.position_bearing;
        if (api != null && api !== 0 && api !== 360) reference = api;
    }

    // 4. Stop approach bearing
    if (reference == null) {
        const stopId = vehicle.properties.stopId;
        const status = vehicle.properties.currentStatus;
        const approaching = status === 0 || status === 2
            || status === 'INCOMING_AT' || status === 'IN_TRANSIT_TO';
        if (approaching && stopId != null) {
            const target = window.masterStopsData?.[String(stopId)];
            if (target) {
                const dlnt = target.lon - toLng;
                const dlat = target.lat - toLat;
                if (Math.abs(dlnt) > MOVEMENT_THRESHOLD || Math.abs(dlat) > MOVEMENT_THRESHOLD) {
                    reference = computeBearing(toLng, toLat, target.lon, target.lat);
                }
            }
        }
    }

    // Apply reference to snap, or return reference directly if no snap
    if (snapBearing != null) {
        if (reference != null) return alignToReference(snapBearing, reference);
        return snapBearing;
    }
    if (reference != null) return reference;
    const api = vehicle.properties.position_bearing;
    return (api && api !== 360) ? api : 0;
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

// Metrolink — pentagon (house shape: rect body + pointed direction tip)
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

export function processVehicleData(data, features, map) {
    const nowSec = Math.floor(Date.now() / 1000);
    data.features
        .filter(v => v.properties?.trip_id)
        .forEach(vehicle => {
            const ts = parseInt(vehicle.properties.timestamp);
            if (nowSec - ts > STALE_THRESHOLD_SEC) return; // skip stale data

            const markerKey = vehicle.properties.trip_id;
            const existing = markers[markerKey];
            if (existing) {
                if (ts > parseInt(existing.timestamp)) {
                    existing.timestamp = ts;
                    updateExistingMarker(vehicle, features, map, markerKey);
                }
            } else {
                // New trip detected. Check if it's a terminus turnaround.
                let oldMarkerKey = null;
                let isTerminusTurnaround = false;

                for (const key in markers) {
                    if (markers[key].properties.vehicle_id === vehicle.properties.vehicle_id && key !== markerKey) {
                        const oldPos = markers[key].getLngLat();
                        const [newLng, newLat] = vehicle.geometry.coordinates;
                        const dist = Math.sqrt(Math.pow(newLng - oldPos.lng, 2) + Math.pow(newLat - oldPos.lat, 2));
                        
                        // If it's less than ~1km jump, it's the same physical train at the terminus changing trips.
                        if (dist < 0.01) {
                            oldMarkerKey = key;
                            isTerminusTurnaround = true;
                            break;
                        }
                    }
                }

                if (isTerminusTurnaround && oldMarkerKey) {
                    const oldHeading = markers[oldMarkerKey].properties.Heading;
                    markers[oldMarkerKey].remove();
                    delete markers[oldMarkerKey];
                    
                    createNewMarker(vehicle, features, map, markerKey, oldHeading);
                } else {
                    createNewMarker(vehicle, features, map, markerKey, null);
                }
            }
        });

    updateDataPanel(markers);
}

function createNewMarker(vehicle, features, map, markerKey, initialHeading) {
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
    const heading = initialHeading !== null ? initialHeading : computeHeading(vehicle, lng, lat, lng, lat, null);

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
        .setRotation(heading)
        .addTo(map);

    marker.properties = { vehicle_id, trip_id, Heading: heading, speed: vehicle.properties.position_speed };
    marker.timestamp = parseInt(timestamp);
    marker.route_code = route_code;
    markers[markerKey] = marker;
}

function updateExistingMarker(vehicle, features, map, markerKey) {
    if (animations[markerKey]) {
        cancelAnimationFrame(animations[markerKey]);
    }

    const marker = markers[markerKey];
    const current = marker.getLngLat();
    const [newLng, newLat] = vehicle.geometry.coordinates;

    // ── GPS glitch filter ─────────────────────────────────────────────────
    // Primary: implied speed check. 160 km/h ≈ 0.0005 deg/s max for any
    // Metro vehicle. Minimum window of 30 s guards against same-timestamp
    // spikes; +20 s absorbs update-lag jitter.
    const newTs = parseInt(vehicle.properties.timestamp);
    const distDeg = Math.sqrt(Math.pow(newLng - current.lng, 2) + Math.pow(newLat - current.lat, 2));
    const elapsed = Math.max(newTs - marker.timestamp, 0);
    const maxAllowedDeg = 0.0005 * (Math.max(elapsed, 30) + 20);

    // Secondary: next-stop proximity. If the new GPS position is more than
    // ~5 km from the vehicle's next/current stop, the fix is implausible.
    let stopTooFar = false;
    if (distDeg > maxAllowedDeg) {
        const stopId = vehicle.properties.stopId;
        const stop = stopId != null ? window.masterStopsData?.[String(stopId)] : null;
        if (stop) {
            const distToStop = Math.sqrt(Math.pow(newLng - stop.lon, 2) + Math.pow(newLat - stop.lat, 2));
            stopTooFar = distToStop > 0.045; // ~5 km — no Metro vehicle is ever this far from its next stop
        } else {
            stopTooFar = true; // no stop data to validate against → trust the speed filter
        }
    }

    if (distDeg > maxAllowedDeg && stopTooFar) {
        // GPS spike — advance timestamp so next update's elapsed is correct,
        // refresh the popup, but hold the marker position.
        marker.timestamp = newTs;
        marker.getElement().setAttribute('data-timestamp', newTs);
        updatePopup(vehicle, markerKey);
        return;
    }
    // ─────────────────────────────────────────────────────────────────────

    const heading = computeHeading(
        vehicle,
        current.lng, current.lat,
        newLng, newLat,
        marker.properties.Heading
    );

    marker.setRotation(heading);
    marker.properties.Heading = heading;
    marker.properties.speed = vehicle.properties.position_speed; // Update speed for metrics

    // Snap position to track before animating.
    // Reject snap if the snapped point is >~500 m from raw GPS — avoids loop-route
    // mismatches where the nearest shape point is on the wrong leg of the route.
    let targetLng = newLng;
    let targetLat = newLat;
    if (hasShapeData(vehicle.properties.route_code)) {
        const snap = snapToRoute(vehicle.properties.route_code, newLng, newLat);
        if (snap) {
            const snapDist = Math.sqrt(
                Math.pow(snap.snappedLng - newLng, 2) +
                Math.pow(snap.snappedLat - newLat, 2)
            );
            if (snapDist < 0.005) { // ~500 m in degrees at LA latitude
                targetLng = snap.snappedLng;
                targetLat = snap.snappedLat;
            }
        }
    }

    const diffLng = targetLng - current.lng;
    const diffLat = targetLat - current.lat;
    const distanceDeg = Math.sqrt(diffLng * diffLng + diffLat * diffLat);

    if (distanceDeg > 0.05) { // Roughly 5km jump — teleport directly
        marker.setLngLat([targetLng, targetLat]);
        updateMarkerTimestamp(marker, vehicle);
    } else {
        animateMarker(vehicle, diffLng, diffLat, 60, current, markerKey, targetLng, targetLat).then(() => {
            updateMarkerTimestamp(marker, vehicle);
        });
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

function animateMarker(vehicle, diffLng, diffLat, steps, currentCoordinates, markerKey, targetLng, targetLat) {
    return new Promise(resolve => {
        let i = 0;
        function animate() {
            if (!markers[markerKey]) return resolve(); // marker removed mid-animation
            if (i <= steps) {
                const progress = i / steps;
                const eased = progress < 0.5
                    ? 4 * progress * progress * progress
                    : 1 - Math.pow(-2 * progress + 2, 2) / 2;
                markers[markerKey].setLngLat([
                    currentCoordinates.lng + eased * diffLng,
                    currentCoordinates.lat + eased * diffLat
                ]);
                i++;
                animations[markerKey] = requestAnimationFrame(animate);
            } else {
                // Ensure we land exactly on the snapped target
                if (targetLng != null && targetLat != null) {
                    markers[markerKey]?.setLngLat([targetLng, targetLat]);
                }
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
