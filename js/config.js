// ── API Keys ──────────────────────────────────────────────────────────────────
// METROLINK_API_KEY is intentionally NOT stored here.
// Set it as a Cloudflare Worker secret: wrangler secret put METROLINK_API_KEY

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
export const DR_SPEED_FACTOR = 0.80;
// Maximum duration (seconds) of a dead-reckoning animation before it stops.
export const DR_MAX_SECONDS = 20;

// ── Terminus turnaround ───────────────────────────────────────────────────────
// Same vehicle_id within this distance on a new trip = terminus turnaround (reuse marker).
export const TERMINUS_TURNAROUND_RADIUS_M = 1000;

// ── ETA / predictions ─────────────────────────────────────────────────────────
// Max plausible train speed for GTFS-RT plausibility check (~108 km/h).
export const ETA_MAX_SPEED_MPS = 30;
// Grace window added to plausibility check to account for dwell, sensor lag, snap noise.
export const ETA_PLAUSIBILITY_GRACE_S = 45;
// Assumed departure lag (seconds) added when dead-reckoning from a stop.
export const ETA_DEPARTURE_LAG_S = 30;
// Maximum GPS correction applied to schedule ETA (prevents wild swings from noisy GPS).
export const ETA_GPS_CORRECTION_CAP_S = 60;

// ── Station rendering ─────────────────────────────────────────────────────────
// Stops with the same normalised name within this radius are merged into one dot.
export const STATION_MERGE_RADIUS_M = 300;
// How often the open station popup re-renders its arrival times.
export const STATION_POPUP_REFRESH_MS = 5000;

// ── WebSocket reconnect ───────────────────────────────────────────────────────
// Base delay for exponential backoff. Doubles each failed attempt up to WS_MAX_RECONNECT_MS.
export const WS_BASE_RECONNECT_MS = 5000;
export const WS_MAX_RECONNECT_MS  = 300000; // 5 minutes
// If the filtered G/J trip_updates URL yields no arrivals within this window, fall back
// to the unfiltered endpoint.
export const WS_BUS_FALLBACK_MS = 15000;

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

// ── LAX FlyAway (Ride Systems — intercity Flyaway buses)  ─────────────────────
// Separate Ride Systems instance from the intra-airport laxtransportation.transloc.com.
// All routes here are intercity: Van Nuys ↔ LAX, Union Station ↔ LAX.
// No systemSelected0 parameter needed — single-system deployment.
export const FLYAWAY_API        = 'https://laxflyaway.transloc.com/Services/JSONPRelay.svc';
export const FLYAWAY_POLL_MS    = 10_000;   // vehicle position refresh interval
export const FLYAWAY_STALE_SEC  = 30;       // fade to 0.4 opacity after this many seconds
export const FLYAWAY_REMOVE_SEC = 60;       // remove from map after this many seconds

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

// Per-route direction labels (Metro + Metrolink)
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

