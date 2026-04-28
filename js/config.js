// ── API Keys ──────────────────────────────────────────────────────────────────
export const ESRI_KEY = "AAPKccc2cf38fecc47649e91529acf524abflSSkRTjWwH0AYmZi8jaRo-wdpcTf6z67CLCkOjVYlw3pZyUIF_Y4KGBndq35Y02z";
export const MAPTILER_KEY = "QHioFl9Q5F97g1m2BvMR";

// ── Constants ─────────────────────────────────────────────────────────────────
export const VEHICLE_SIZE_PX = 24;
export const STALE_THRESHOLD_SEC = 180; // 3 minutes
export const STALE_CHECK_INTERVAL_MS = 30000;
export const MOVEMENT_THRESHOLD = 0.00001; // ~1 meter in degrees

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
    '910': 'https://lacmta.github.io/metro-iconography/Service_JLine.svg'
};

// Per-route direction labels.
// Metro's GTFS does NOT use a consistent direction_id=0 convention across routes.
// Each entry is { directionId: 'Label' } verified against live data.
export const routeDirectionLabels = {
    '801': { 0: 'Northbound', 1: 'Southbound' },                        // A Line: dir0 → APU, dir1 → Long Beach
    '802': { 0: 'Southbound / Eastbound', 1: 'Northbound / Westbound' }, // B Line: dir0 → Union Station, dir1 → NoHo  ← confirmed
    '803': { 0: 'Westbound', 1: 'Eastbound' },                          // C Line: dir0 → Redondo, dir1 → Norwalk     ← confirmed
    '804': { 0: 'Westbound', 1: 'Eastbound' },                          // E Line: dir0 → Santa Monica, dir1 → Atlantic
    '805': { 0: 'Westbound / Northbound', 1: 'Eastbound / Southbound' },// D Line: dir0 → Wilshire/Western, dir1 → Union
    '806': { 0: 'Northbound', 1: 'Southbound' },                        // L Line (inactive)
    '807': { 0: 'Northbound', 1: 'Southbound' },                        // K Line: dir0 → Expo/Crenshaw, dir1 → Westchester
    '901': { 0: 'Westbound', 1: 'Eastbound' },                          // G Line: dir0 → Chatsworth, dir1 → NoHo
    '910': { 0: 'Southbound', 1: 'Northbound' },                        // J Line: dir0 → San Pedro/Harbor, dir1 → El Monte
};

export const routeHexColors = {
    '801': '#0072bc', // A Line (Blue)
    '802': '#e31937', // B Line (Red)
    '803': '#58a738', // C Line (Green)
    '804': '#fdb913', // E Line (Gold)
    '805': '#a05da5', // D Line (Purple)
    '806': '#fdb913', // L Line (Gold)
    '807': '#e56db1', // K Line (Pink)
    '901': '#fc4c02', // G Line (Orange)
    '910': '#adb8bf', // J Line (Silver)
};
