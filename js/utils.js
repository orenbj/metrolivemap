/**
 * Geodesic bearing from one point to another, in [0, 360).
 * Shared by markers.js (trajectory heading) and snap.js (polyline tangent).
 */
export function computeBearing(fromLng, fromLat, toLng, toLat) {
    const toRad = d => d * Math.PI / 180;
    const toDeg = r => r * 180 / Math.PI;
    const lat1 = toRad(fromLat);
    const lat2 = toRad(toLat);
    const dLng = toRad(toLng - fromLng);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
