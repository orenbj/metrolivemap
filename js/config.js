// ── Constants ─────────────────────────────────────────────────────────────────
export const STALE_THRESHOLD_SEC = 300;
export const STALE_CHECK_INTERVAL_MS = 5000;
// Marker fades to 50% opacity after this many seconds of staleness.
export const STALE_FADE_START_SEC = 60;

// ── Heading model tunables ────────────────────────────────────────────────────
// A vehicle is "stationary" below this speed (m/s). Heading is held, not recomputed.
export const STATIONARY_SPEED_MPS = 0.5;
// Implausibly high speed (m/s) — clamped at ingestion and used to reject GPS spikes.
export const MAX_PLAUSIBLE_SPEED_MPS = 50; // ~110 mph
// GPS noise floor (degrees) — used as the lower bound for outlier rejection radius.
export const GPS_NOISE_FLOOR_DEG = 0.0001; // ~10 m
// Hold heading within this distance of the trip's terminal stop.
export const FINAL_STOP_HOLD_M = 150;
// Minimum distance to a downstream stop before bearingToStop() returns a result.
export const DOWNSTREAM_MIN_METERS = 20;

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
// Extra snap-noise tolerance added to the rail arc-distance spike gate.
export const RAIL_ARC_SPIKE_NOISE_M = 500;

// ── Dead-reckoning ────────────────────────────────────────────────────────────
// Scale reported GPS speed down so DR always undershoots — GPS updates then push
// the marker forward rather than pulling it back.
export const DR_SPEED_FACTOR = 0.75;
// Maximum duration (seconds) of a dead-reckoning animation before it stops.
export const DR_MAX_SECONDS = 20;
// EWMA weight for GPS speed smoothing (0–1). Higher = more responsive to new readings.
// Reduces DR animation jitter caused by one-off noisy speed reports in the feed.
export const DR_SPEED_ALPHA = 0.4;
// Arc-meters before the next stop where kinematic deceleration begins.
export const DR_DECEL_ZONE_M = 150;
// Deceleration rate (m/s²) applied in the DR_DECEL_ZONE_M.
// 1 m/s² ≈ comfortable light-rail/bus braking.
export const DR_DECEL_RATE_MPS2 = 1.0;

// ── Terminus turnaround ───────────────────────────────────────────────────────
// Same vehicle_id within this distance on a new trip = terminus turnaround (reuse marker).
export const TERMINUS_TURNAROUND_RADIUS_M = 1000;

// ── Vehicle lifecycle ─────────────────────────────────────────────────────────
// Markers older than this are excluded from ETA calculations.
// Must stay <= STALE_THRESHOLD_SEC so predictions never reference a removed marker.
export const VEHICLE_MARKER_TTL_S = 180;

// ── ETA / predictions ─────────────────────────────────────────────────────────
// Max plausible train speed for GTFS-RT plausibility check (~108 km/h).
export const ETA_MAX_SPEED_MPS = 30;
// Adherence taper: applied adherence offset is capped at ADHERENCE_TAPER_K × remaining travel time.
// Prevents close-range overshoot (OBA issue #127 bug class). 1.0 = allow full offset when ≥ offset
// seconds of scheduled travel remain; offset fades to zero as vehicle nears the stop.
export const ADHERENCE_TAPER_K = 1.0;
// Grace window added to plausibility check to account for dwell, sensor lag, snap noise.
export const ETA_PLAUSIBILITY_GRACE_S = 45;
// Assumed departure lag (seconds) added when dead-reckoning from a stop.
export const ETA_DEPARTURE_LAG_S = 30;
// GTFS-RT arrival entries older than this (seconds since last ingest) are treated as stale.
// Prevents zombie arrivals and stale hybrid blending when the trip_updates feed hangs.
export const GTFS_ENTRY_STALENESS_S = 90;
// Per-stop dwell time added to multi-stop calc ETAs. Metro GTFS uses point-times
// (arrival == departure) at non-timepoint stops, so schedule gaps contain no dwell.
export const ETA_INTERMEDIATE_DWELL_S     = 30; // rail lines (was 45)
export const ETA_INTERMEDIATE_DWELL_BUS_S = 30; // G/J Lines (was 35)

// ── Station rendering ─────────────────────────────────────────────────────────
// Stops with the same normalised name within this radius are merged into one dot.
export const STATION_MERGE_RADIUS_M = 300;
// How often the open station popup re-renders its arrival times.
export const STATION_POPUP_REFRESH_MS = 5000;

// ── WebSocket reconnect ───────────────────────────────────────────────────────
// Base delay for exponential backoff. Doubles each failed attempt up to WS_MAX_RECONNECT_MS.
export const WS_BASE_RECONNECT_MS = 5000;
export const WS_MAX_RECONNECT_MS  = 300000; // 5 minutes

// ── Viewport / zoom breakpoints ───────────────────────────────────────────────
export const VIEWPORT_BREAKPOINT_MOBILE = 768;   // px — initial map zoom = 8
export const VIEWPORT_BREAKPOINT_TABLET = 1280;  // px — initial map zoom = 9
// Above TABLET initial zoom = 10

// ── Vehicle size scaling ──────────────────────────────────────────────────────
export const VEHICLE_ZOOM_MIN = 9;      // zoom level at which marker is smallest
export const VEHICLE_ZOOM_MAX = 14;     // zoom level at which marker is largest
export const VEHICLE_SIZE_MIN_PX = 15; // marker size at VEHICLE_ZOOM_MIN
export const VEHICLE_SIZE_MAX_PX = 38; // marker size at VEHICLE_ZOOM_MAX

// ── Service Alerts ───────────────────────────────────────────────────────────
// REST endpoints powering alerts.metro.net — polled on init and every 2 min.
// These Lambda URLs are undocumented but stable (they back the official alerts page).
export const RAIL_ALERTS_URL = 'https://5cgdcfl7csnoiymgfhjp5bqgii0yxifx.lambda-url.us-west-1.on.aws/';
export const BUS_ALERTS_URL  = 'https://lbwlhl4z4pktjvxw3tm6emxfui0kwjiv.lambda-url.us-west-1.on.aws/';
export const ALERTS_POLL_MS  = 120_000;

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
    '807': 'https://lacmta.github.io/metro-iconography/Service_KLine.svg',
    '901': 'https://lacmta.github.io/metro-iconography/Service_GLine.svg',
    '910': 'https://lacmta.github.io/metro-iconography/Service_JLine.svg',
    '950': 'https://lacmta.github.io/metro-iconography/Service_JLine.svg',
};

// Per-route direction labels
export const routeDirectionLabels = {
    // ── Metro ──
    '801': { 0: 'Northbound', 1: 'Southbound' },
    '802': { 0: 'Eastbound', 1: 'Westbound' },
    '803': { 0: 'Westbound', 1: 'Eastbound' },
    '804': { 0: 'Eastbound', 1: 'Westbound' },
    '805': { 0: 'Eastbound', 1: 'Westbound' },
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
    '807': '#e56db1',
    '901': '#fc4c02',
    '910': '#adb8bf',
    '950': '#adb8bf',
};

