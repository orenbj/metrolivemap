// ── API Keys ──────────────────────────────────────────────────────────────────
// IMPORTANT: Restrict both keys to your production domain via each provider's dashboard.
// ESRI: developers.arcgis.com → API Keys → Referrers
// MapTiler: cloud.maptiler.com → API Keys → Allowed URLs
export const ESRI_KEY = "AAPKccc2cf38fecc47649e91529acf524abflSSkRTjWwH0AYmZi8jaRo-wdpcTf6z67CLCkOjVYlw3pZyUIF_Y4KGBndq35Y02z";
export const MAPTILER_KEY = "QHioFl9Q5F97g1m2BvMR";
// METROLINK_API_KEY is intentionally NOT stored here.
// Set it as a Cloudflare Worker secret: wrangler secret put METROLINK_API_KEY

// ── Constants ─────────────────────────────────────────────────────────────────
export const VEHICLE_SIZE_PX = 25;
export const STALE_THRESHOLD_SEC = 180;
export const STALE_CHECK_INTERVAL_MS = 30000;

// ── Heading model tunables ────────────────────────────────────────────────────
// A vehicle is "stationary" below this speed (m/s). Heading is held, not recomputed.
export const STATIONARY_SPEED_MPS = 0.5;
// Implausibly high speed (m/s) — clamped at ingestion and used to reject GPS spikes.
export const MAX_PLAUSIBLE_SPEED_MPS = 50; // ~110 mph
// GPS noise floor (degrees) — used as the lower bound for outlier rejection radius.
export const GPS_NOISE_FLOOR_DEG = 0.0001; // ~10 m

// ── Viewport / zoom breakpoints ───────────────────────────────────────────────
export const VIEWPORT_BREAKPOINT_MOBILE = 768;   // px — initial map zoom = 8
export const VIEWPORT_BREAKPOINT_TABLET = 1280;  // px — initial map zoom = 9
// Above TABLET initial zoom = 10

// ── Vehicle size scaling ──────────────────────────────────────────────────────
export const VEHICLE_ZOOM_MIN = 9;      // zoom level at which marker is smallest
export const VEHICLE_ZOOM_MAX = 14;     // zoom level at which marker is largest
export const VEHICLE_SIZE_MIN_PX = 15; // marker size at VEHICLE_ZOOM_MIN
export const VEHICLE_SIZE_MAX_PX = 38; // marker size at VEHICLE_ZOOM_MAX

// ── Metrolink ─────────────────────────────────────────────────────────────────
export const METROLINK_COLOR = '#0079C1';
export const METROLINK_ROUTE_IDS = ['AV', 'SB', 'VT', 'OC', 'IE', '91'];

// Inline SVG icon for Metrolink popup (circle M badge)
export const METROLINK_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50">' +
    '<circle cx="25" cy="25" r="25" fill="#0079C1"/>' +
    '<text x="25" y="34" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="white" text-anchor="middle">M</text>' +
    '</svg>'
)}`;

// ── Route metadata ────────────────────────────────────────────────────────────
export const routeIcons = {
    '801': 'https://lacmta.github.io/metro-iconography/Service_ALine.svg',
    '802': 'https://lacmta.github.io/metro-iconography/Service_BLine.svg',
    '803': 'https://lacmta.github.io/metro-iconography/Service_CLine.svg',
    '804': 'https://lacmta.github.io/metro-iconography/Service_ELine2.svg',
    '805': 'https://lacmta.github.io/metro-iconography/Service_DLine.svg',
    '806': 'https://lacmta.github.io/metro-iconography/Service_LLine.svg',
    '807': 'https://lacmta.github.io/metro-iconography/Service_KLine.svg',
    '901': 'https://lacmta.github.io/metro-iconography/Service_GLine.svg',
    '910': 'https://lacmta.github.io/metro-iconography/Service_JLine.svg',
    '950': 'https://lacmta.github.io/metro-iconography/Service_JLine.svg',
};

// Per-route direction labels (Metro + Metrolink)
export const routeDirectionLabels = {
    // ── Metro ──
    '801': { 0: 'Northbound', 1: 'Southbound' },
    '802': { 0: 'Eastbound', 1: 'Westbound' },
    '803': { 0: 'Westbound', 1: 'Eastbound' },
    '804': { 0: 'Eastbound', 1: 'Westbound' },
    '805': { 0: 'Eastbound', 1: 'Westbound' },
    '806': { 0: 'Northbound', 1: 'Southbound' },
    '807': { 0: 'Northbound', 1: 'Southbound' },
    '901': { 0: 'Eastbound', 1: 'Westbound' },
    '910': { 0: 'Northbound', 1: 'Southbound' },
    '950': { 0: 'Northbound', 1: 'Southbound' },
    // ── Metrolink — direction_id 0 = outbound from Union Station ──
    'AV':  { 0: 'Northbound', 1: 'Southbound' },   // Antelope Valley: Lancaster ↔ LA
    'SB':  { 0: 'Eastbound',  1: 'Westbound'  },   // San Bernardino: SB ↔ LA
    'VT':  { 0: 'Northbound', 1: 'Southbound' },   // Ventura County: Ventura ↔ LA
    'OC':  { 0: 'Southbound', 1: 'Northbound' },   // Orange County: Oceanside ↔ LA
    'IE':  { 0: 'Outbound',   1: 'Inbound'    },   // IE-OC: complex cross-route
    '91':  { 0: 'Southbound', 1: 'Northbound' },   // 91/Perris Valley: Perris ↔ LA
};

export const routeHexColors = {
    // ── Metro ──
    '801': '#0072bc',
    '802': '#e31937',
    '803': '#58a738',
    '804': '#fdb913',
    '805': '#a05da5',
    '806': '#fdb913',
    '807': '#e56db1',
    '901': '#fc4c02',
    '910': '#adb8bf',
    '950': '#adb8bf',
    // ── Metrolink (all one brand color) ──
    'AV':  '#0079C1',
    'SB':  '#0079C1',
    'VT':  '#0079C1',
    'OC':  '#0079C1',
    'IE':  '#0079C1',
    '91':  '#0079C1',
};
