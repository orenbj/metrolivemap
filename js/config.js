// ── API Keys ──────────────────────────────────────────────────────────────────
export const ESRI_KEY = "AAPKccc2cf38fecc47649e91529acf524abflSSkRTjWwH0AYmZi8jaRo-wdpcTf6z67CLCkOjVYlw3pZyUIF_Y4KGBndq35Y02z";
export const MAPTILER_KEY = "QHioFl9Q5F97g1m2BvMR";
export const METROLINK_API_KEY = "Umyp2Txlov26s3ccrk72x8dmPkGzp0Wj7tjjOEpu";

// ── Constants ─────────────────────────────────────────────────────────────────
export const VEHICLE_SIZE_PX = 24;
export const STALE_THRESHOLD_SEC = 180;
export const STALE_CHECK_INTERVAL_MS = 30000;
export const MOVEMENT_THRESHOLD = 0.00001;

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
};

// Per-route direction labels (Metro + Metrolink)
export const routeDirectionLabels = {
    // ── Metro ──
    '801': { 0: 'Northbound', 1: 'Southbound' },
    '802': { 0: 'Southbound / Eastbound', 1: 'Northbound / Westbound' },
    '803': { 0: 'Westbound', 1: 'Eastbound' },
    '804': { 0: 'Westbound', 1: 'Eastbound' },
    '805': { 0: 'Westbound / Northbound', 1: 'Eastbound / Southbound' },
    '806': { 0: 'Northbound', 1: 'Southbound' },
    '807': { 0: 'Northbound', 1: 'Southbound' },
    '901': { 0: 'Westbound', 1: 'Eastbound' },
    '910': { 0: 'Southbound', 1: 'Northbound' },
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
    // ── Metrolink (all one brand color) ──
    'AV':  '#0079C1',
    'SB':  '#0079C1',
    'VT':  '#0079C1',
    'OC':  '#0079C1',
    'IE':  '#0079C1',
    '91':  '#0079C1',
};
