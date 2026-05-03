// ── API Keys ──────────────────────────────────────────────────────────────────
// IMPORTANT: Restrict both keys to your production domain via each provider's dashboard.
// ESRI: developers.arcgis.com → API Keys → Referrers
// MapTiler: cloud.maptiler.com → API Keys → Allowed URLs
export const ESRI_KEY = "AAPKccc2cf38fecc47649e91529acf524abflSSkRTjWwH0AYmZi8jaRo-wdpcTf6z67CLCkOjVYlw3pZyUIF_Y4KGBndq35Y02z";
export const MAPTILER_KEY = "QHioFl9Q5F97g1m2BvMR";
// METROLINK_API_KEY is intentionally NOT stored here.
// Set it as a Cloudflare Worker secret: wrangler secret put METROLINK_API_KEY

// ── Constants ─────────────────────────────────────────────────────────────────
export const STALE_THRESHOLD_SEC = 180;
export const STALE_CHECK_INTERVAL_MS = 5000;

// ── Heading model tunables ────────────────────────────────────────────────────
// A vehicle is "stationary" below this speed (m/s). Heading is held, not recomputed.
export const STATIONARY_SPEED_MPS = 0.5;
// Implausibly high speed (m/s) — clamped at ingestion and used to reject GPS spikes.
export const MAX_PLAUSIBLE_SPEED_MPS = 50; // ~110 mph
// GPS noise floor (degrees) — used as the lower bound for outlier rejection radius.
export const GPS_NOISE_FLOOR_DEG = 0.0001; // ~10 m
// Hold heading within this distance of the trip's terminal stop.
export const FINAL_STOP_HOLD_M = 150;

// ── Snap-to-polyline thresholds ───────────────────────────────────────────────
// Rail: always on a fixed guideway, generous threshold.
export const RAIL_SNAP_MAX_M = 150;
// G/J bus: dedicated busway but can detour onto surface streets — tight threshold
// so off-route buses show at raw GPS instead of being pulled onto the polyline.
export const BUS_SNAP_MAX_M = 75;

// ── GPS spike rejection ───────────────────────────────────────────────────────
// A fix is allowed through the spike filter if it lands within this distance of the next stop.
export const GPS_SPIKE_STOP_RADIUS_M = 5000;
// Minimum displacement required before the predict-then-validate spike check fires.
export const GPS_SPIKE_MIN_DIST_M = 200;
// Rail arc-distance spike check: max speed used to gate how far along the polyline
// a vehicle may jump between fixes. ~60 mph covers all Metro rail lines with headroom.
export const RAIL_MAX_SPEED_MPS = 27;

// ── Dead-reckoning speed ──────────────────────────────────────────────────────
// Scale reported GPS speed down so DR always undershoots — GPS updates then push
// the marker forward rather than pulling it back.
export const DR_SPEED_FACTOR = 0.80;

// ── Terminus turnaround ───────────────────────────────────────────────────────
// Same vehicle_id within this distance on a new trip = terminus turnaround (reuse marker).
export const TERMINUS_TURNAROUND_RADIUS_M = 1000;

// ── Viewport / zoom breakpoints ───────────────────────────────────────────────
export const VIEWPORT_BREAKPOINT_MOBILE = 768;   // px — initial map zoom = 8
export const VIEWPORT_BREAKPOINT_TABLET = 1280;  // px — initial map zoom = 9
// Above TABLET initial zoom = 10

// ── Vehicle size scaling ──────────────────────────────────────────────────────
export const VEHICLE_ZOOM_MIN = 9;      // zoom level at which marker is smallest
export const VEHICLE_ZOOM_MAX = 14;     // zoom level at which marker is largest
export const VEHICLE_SIZE_MIN_PX = 15; // marker size at VEHICLE_ZOOM_MIN
export const VEHICLE_SIZE_MAX_PX = 38; // marker size at VEHICLE_ZOOM_MAX

// ── Metro Bike Share ──────────────────────────────────────────────────────────
export const BIKESHARE_COLOR        = '#00a651';
export const BIKESHARE_POLL_MS      = 30000;
export const GBFS_INFO_URL          = 'https://gbfs.bcycle.com/bcycle_lametro/station_information.json';
export const GBFS_STATUS_URL        = 'https://gbfs.bcycle.com/bcycle_lametro/station_status.json';

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
};

// ── Design Tokens ──────────────────────────────────────────────────────
// Establish consistent spacing, typography, and visual scales across the app

// Spacing scale: 8px base unit
export const SPACING = {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '20px',
    xxl: '24px',
    xxxl: '32px',
};

// Typography scale
export const FONT_SIZE = {
    xs: '10px',    // micro labels
    sm: '11px',    // hints, small text
    base: '12px',  // body text
    md: '13px',    // inputs, normal text
    lg: '14px',    // section headers
    xl: '16px',    // titles
    xxl: '18px',   // main title
};

export const LINE_HEIGHT = {
    tight: '1.2',  // headings
    normal: '1.4', // body text
    relaxed: '1.6', // long form
};

export const FONT_WEIGHT = {
    normal: 400,
    semibold: 600,
    bold: 700,
    extrabold: 800,
};

// Border radius scale
export const BORDER_RADIUS = {
    sm: '4px',
    md: '8px',
    lg: '12px',
    xl: '16px',
    full: '20px',
    circle: '50%',
};

// Shadow scale
export const SHADOW = {
    sm: '0 1px 2px rgba(0, 0, 0, 0.1)',
    md: '0 2px 4px rgba(0, 0, 0, 0.1)',
    lg: '0 4px 12px rgba(0, 0, 0, 0.15)',
    xl: '0 4px 16px rgba(0, 0, 0, 0.15)',
};

// Z-index scale
export const Z_INDEX = {
    hide: -1,
    base: 0,
    dropdown: 100,
    sticky: 200,
    fixed: 300,
    modal: 400,
    tooltip: 500,
    notification: 600,
    loading: 9000,
    overlay: 9500,
};

// Transition timings
export const TRANSITION = {
    fast: '0.15s ease',
    normal: '0.3s ease',
    slow: '0.5s ease',
};
