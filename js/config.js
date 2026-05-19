// ── Per-vehicle freshness tiers ───────────────────────────────────────────────
// One source of truth for how a vehicle marker LOOKS. A pure tier function in
// markers.js (`getFreshnessTier`) maps `nowSec - marker.timestamp` into one of:
//
//   live    (age <  FRESH_LIVE_S  =  30s)  → opacity 1.00, popup dot green
//   aging   (age <  FRESH_AGING_S =  90s)  → opacity 1.00, popup dot green
//   stale   (age <  FRESH_EXPIRE_S= 300s)  → opacity 0.50, popup dot gray
//   expired (age ≥  FRESH_EXPIRE_S)        → fade out + remove from DOM
//
// Note: the `aging` tier exists in the data model but its color was collapsed
// into `live` (PR #141 — Metro's normal 15–35s broadcast lag would otherwise
// flip the dot amber on healthy feeds and confuse users). Opacity, spike
// rejection, and ETA filters still treat aging as a distinct tier; only the
// rider-facing dot color was unified with live.
//
// Bounds rationale:
//   30s — Metro's typical GPS-to-broadcast lag is 15–35s; anything below 30s is
//         "as fresh as the feed gets."
//   90s — Past Metro's normal lag envelope. If we haven't heard from a vehicle
//         in 90s, the feed has genuinely paused on it; opacity drops to 0.5
//         once we cross into `stale`.
//   300s — Hard data-quality cutoff. After 5 min of silence, the vehicle is
//          either parked or off-route; predictions can't trust it any longer.
export const FRESH_LIVE_S            = 30;
export const FRESH_AGING_S           = 90;
export const FRESH_EXPIRE_S          = 300;
export const FRESH_CHECK_INTERVAL_MS = 5000;

// ── Independent staleness gates (different concerns) ──────────────────────────
// Spike-rejection bypass: after this long without a fix, the next fix is
// accepted unconditionally (no fresh velocity reference to validate against).
// DECOUPLED from FRESH_* tiers — visual fade is a UX concern, spike-bypass is
// a data-quality concern. 60–90s feed gaps are common; bypassing the spike
// check that early lets genuinely bad fixes through.
export const SPIKE_BYPASS_S = 120;

// ── Heading model tunables ────────────────────────────────────────────────────
// A vehicle is "stationary" below this speed (m/s). Heading is held, not recomputed.
export const STATIONARY_SPEED_MPS = 0.5; // below this speed, heading is frozen to avoid GPS-noise flips
// Speed constants: MAX_PLAUSIBLE_SPEED_MPS is the inbound spike-rejection gate;
// RAIL_MAX_SPEED_MPS is the physics cap for DR kinematic model;
// ETA_MAX_SPEED_MPS is the blend cap to avoid unrealistic ETA compression.
// Implausibly high speed (m/s) — clamped at ingestion and used to reject GPS spikes.
export const MAX_PLAUSIBLE_SPEED_MPS = 50; // ~110 mph
// GPS noise floor (degrees) — used as the lower bound for outlier rejection radius.
export const GPS_NOISE_FLOOR_DEG = 0.0001; // ~10 m
// Hold heading within this distance of the trip's terminal stop.
export const FINAL_STOP_HOLD_M = 150;
// Minimum distance to a downstream stop before bearingToStop() returns a result.
export const DOWNSTREAM_MIN_METERS = 20;

// ── Snap-to-polyline thresholds ───────────────────────────────────────────────
// Surface rail (A/C/E/K): mostly fixed guideway but with at-grade street-running
// segments where GPS multipath and shape-vs-track offsets are well bounded.
export const RAIL_SNAP_MAX_M = 150;
// Heavy rail (B/D): fully grade-separated tunnels. The vehicle physically
// cannot leave the track, so any GPS divergence is noise — wider threshold
// keeps the marker on-rail through urban-canyon and tunnel-mouth multipath
// instead of dropping snap and showing the train wandering through buildings.
export const HEAVY_RAIL_SNAP_MAX_M = 250;
// G/J bus: dedicated busway but can detour onto surface streets — tight threshold
// so off-route buses show at raw GPS instead of being pulled onto the polyline.
export const BUS_SNAP_MAX_M = 75;
// Heavy-rail STOPPED_AT proximity gate. Past this distance from the declared
// stop, ignore the feed's STOPPED_AT and keep dead-reckoning — B/D run in
// dedicated guideway/tunnel where mid-segment STOPPED_AT is always stale.
export const HEAVY_RAIL_STOPPED_AT_MAX_M = 75;

// ── STOPPED_AT misfire override ──────────────────────────────────────────────
// Detect when the feed reports STOPPED_AT for a vehicle that's clearly moving.
// Two triggers, OR-gated; once either fires, skip the station-snap pin in
// _applySnap and don't halt DR in startDeadReckoning.
//
// Trigger 1 (speed) — reported speed exceeds this threshold while STOPPED_AT.
// 2× STATIONARY_SPEED_MPS gives headroom over the noise floor; below this, a
// "moving" reading could be GPS jitter at a real platform.
export const STOPPED_AT_MISFIRE_SPEED_MPS = 1.0;
// Trigger 2 (age + movement) — both conditions must hold:
//   (a) marker.properties.statusChangedAt is older than this many seconds.
//       Legitimate end-of-line / mid-line operator-break dwells can run
//       2-5 minutes at terminal stops, so this must be comfortably above
//       the longest legit dwell.
export const STOPPED_AT_MISFIRE_AGE_S = 180;
//   (b) snap.arcMeters has moved at least this far since statusChangedAt.
//       Uses arc-meters (the unit DR reasons in) rather than planar distance,
//       so GPS jitter that orbits a station coord doesn't trigger.
export const STOPPED_AT_MISFIRE_ARC_DELTA_M = 50;

// ── GPS spike rejection ───────────────────────────────────────────────────────
// A fix is allowed through the spike filter if it lands within this distance of the next stop.
// Bypass radius: if the new fix lands within this distance of the vehicle's
// declared next stop, the spike filter lets it through. Sized to cover the
// largest real inter-station gap on Metro rail (~1.3 km on the D Line Phase 1
// extension) plus generous GPS scatter headroom. 5 km was too loose — it
// effectively bypassed the filter for any fix anywhere in central LA.
export const GPS_SPIKE_STOP_RADIUS_M = 1500;
// Minimum displacement required before the predict-then-validate spike check fires.
export const GPS_SPIKE_MIN_DIST_M = 200; // comparable to RAIL_SNAP_MAX_M + GPS scatter headroom
// Rail arc-distance spike check: max speed used to gate how far along the polyline
// a vehicle may jump between fixes. ~60 mph covers all Metro rail lines with headroom.
export const RAIL_MAX_SPEED_MPS = 27;
// Extra snap-noise tolerance added to the rail arc-distance spike gate.
export const RAIL_ARC_SPIKE_NOISE_M = 500;
// Cold-start gate: brand-new markers without lastVelocity bypass the predict-validate
// filter. If the very first fix lands more than this distance from the route polyline,
// reject it as obvious bad data (the vehicle physically cannot be off-track by km).
// Shapes carry generous corridor width (curves, station offsets) so 1500 m is loose
// enough to never reject legitimate cold starts at platforms, yard turnouts, or where
// the rendered shape diverges slightly from physical track.
export const COLD_START_MAX_OFFROUTE_M = 1500;

// ── Dead-reckoning ────────────────────────────────────────────────────────────
// Scale reported GPS speed down so DR always undershoots — GPS updates then push
// the marker forward rather than pulling it back.
export const DR_SPEED_FACTOR = 0.75; // empirically tuned: trains coast slower than last-known speed
// Maximum duration (seconds) of a dead-reckoning animation before it stops.
export const DR_MAX_SECONDS = 20;
/**
 * Watchdog for rail dead-reckoning. Resets on every WS frame, so this only
 * fires when the feed itself pauses — not during tunnel transit (Metro's
 * GTFS-RT feed keeps emitting frames with speed=0 → DR_HEAVY_RAIL_FALLBACK_MPS
 * takes over). The longest actual tunnel segment is Hollywood/Highland ↔
 * Universal/Studio City under Cahuenga Pass, scheduled at ~4–5 min — far
 * beyond 60 s of wall time, but covered as long as frames keep arriving.
 * The `watchdogRail` telemetry counter reveals whether the assumption holds
 * in practice; tune from data, not from this comment.
 */
export const DR_MAX_SECONDS_RAIL = 60;
// EWMA weight for GPS speed smoothing (0–1). Higher = more responsive to new readings.
// Reduces DR animation jitter caused by one-off noisy speed reports in the feed.
export const DR_SPEED_ALPHA = 0.4;
// Per-frame velocity glide time constant (seconds). The DR integrator's visible
// speed lerps toward _drTargetSpeed with this τ each frame — so an EWMA-updated
// target from a new WS fix doesn't snap velocity in one frame (visible jerk),
// it ramps over ~3·τ. Pure rendering smoothing: target speed (the truth) is
// untouched, the integrator still converges on it.
export const DR_SPEED_GLIDE_TAU_S = 0.5;
// Arc-meters before the next stop where kinematic deceleration begins.
export const DR_DECEL_ZONE_M = 150;
// Deceleration rate (m/s²) applied in the DR_DECEL_ZONE_M.
// 1 m/s² ≈ comfortable light-rail/bus braking.
export const DR_DECEL_RATE_MPS2 = 1.0;
// Minimum DR speed (m/s) for B/D heavy-rail when _heavyRailScheduleSpeed() fails
// (missing trip data, bad stop coords, snap failure). ~40 km/h is well below peak
// tunnel speed (~80 km/h) but ensures DR starts and the stop-cap decel handles braking.
export const DR_HEAVY_RAIL_FALLBACK_MPS = 11;
// Proximity (meters) for "marker is near a known light-rail at-grade crossing."
// Used by markers.js to distinguish a real red-light/gate stop (speed=0 is true)
// from GPS dropout in a tunnel or elevated section (speed=0 is noise — use the
// heavy-rail fallback path so the marker keeps moving). Calibrated to the
// typical street-level GPS noise envelope (~5-15 m) plus snap-to-shape slack.
// Source data: data/light-rail-intersections.json (built from a public Google
// My Maps layer cataloguing all 263 LA Metro light-rail at-grade crossings).
export const INTERSECTION_PROX_M = 50;

// ── Terminus turnaround ───────────────────────────────────────────────────────
// Same vehicle_id within this distance on a new trip = terminus turnaround (reuse marker).
export const TERMINUS_TURNAROUND_RADIUS_M = 1000;
// End-of-line cleanup: a vehicle stopped at the last stop of its current trip
// lingers for TERMINUS_LINGER_S seconds, then fades out over TERMINUS_FADE_MS
// before removal. Keeps end-of-line stations from accumulating dead markers
// while still showing the just-arrived train briefly.
export const TERMINUS_LINGER_S = 30;
export const TERMINUS_FADE_MS  = 5000;

// ── Vehicle lifecycle ─────────────────────────────────────────────────────────
// Markers older than this are excluded from ETA calculations. Intentionally
// independent of the FRESH_* visual tiers above — this is an algorithmic gate
// (predictions can't trust a 180s-old position) that happens to fall midway
// between the `stale` (90s) and `expired` (300s) visual thresholds.
// Must stay <= FRESH_EXPIRE_S so predictions never reference a removed marker.
export const VEHICLE_MARKER_TTL_S = 180;

// ── ETA / predictions ─────────────────────────────────────────────────────────
// Max plausible train speed for GTFS-RT plausibility check (~108 km/h).
export const ETA_MAX_SPEED_MPS = 30;
// Adherence taper: applied adherence offset is capped at ADHERENCE_TAPER_K × remaining travel time.
// Prevents close-range overshoot (OBA issue #127 bug class). Tightened iteratively:
//   1.0 → 0.5 (2026-05-05 v6 audit) — 3–11% engagement, persistent −22s bias at 1–5 min
//   0.5 → 0.35 (2026-05-06 v6 audit) — 23–28% engagement on A/E/J but −51s bias at 2–5 min
//   and −141s at 5–10 min remained; tighter cap pulls more of the long-horizon offset into
//   the capped region without over-correcting short-horizon (still +19s mean at <30s).
export const ADHERENCE_TAPER_K = 0.35;
// Grace window added to plausibility check to account for dwell, sensor lag, snap noise.
export const ETA_PLAUSIBILITY_GRACE_S = 45;
// Upper-bound plausibility override: when a vehicle is within this many meters
// of the target stop AND moving, GTFS-RT's predicted arrival cannot exceed
// physics by more than ETA_PLAUSIBILITY_GRACE_S. Catches the "marker is at the
// platform but GTFS still says 2 min" failure mode (feed lag — trip_updates
// recomputes predictions less often than vehicle_position broadcasts position).
// 400 m ≈ one urban block; tight enough to only fire on visibly-imminent
// arrivals where calc is materially more accurate.
export const ETA_PROXIMITY_OVERRIDE_M = 400;
// Floor on smoothedSpeed used in the upper-bound divisor. Prevents a near-zero
// speed sample from inflating the "max plausible" ETA to infinity and silently
// disabling the override. 5 m/s ≈ 11 mph — a conservative approach speed even
// for a train heavily braking into a station.
export const ETA_MIN_APPROACH_SPEED_MPS = 5;
// Assumed departure lag (seconds) added when dead-reckoning from a stop.
// Reduced from 30 → 15 after 2026-05-05 v6 audit showed +14.7s rail / +33.4s bus mean
// error at <30s horizon: the 30s lag was overestimating time-in-transit and pulling
// short-range ETAs ~30s earlier than actual arrivals.
export const ETA_DEPARTURE_LAG_S = 15;
// GTFS-RT arrival entries older than this (seconds since last ingest) are treated as stale.
// Prevents zombie arrivals and stale hybrid blending when the trip_updates feed hangs.
export const GTFS_ENTRY_STALENESS_S = 90;
// Past-arrival grace window. Trip_updates entries whose predicted arrivalUnix is
// older than (now - this) are treated as "the vehicle has departed" — they're
// rejected at ingest, pruned from masterArrivalsData, hidden from popup rendering,
// and dropped from the boarding-vehicles list. Single source of truth so the
// ingest gate, prune loop, popup filter, and boarding query can't drift apart
// (a 30 s ingest cutoff + 60 s popup filter previously left a 30 s window where
// the popup showed "Arriving" for vehicles that had already departed).
export const PAST_ARRIVAL_GRACE_S = 60;
// If a trip_updates feed has been silent this long, surface a "data may be stale"
// banner above the station popup. Matches PAST_ARRIVAL_GRACE_S deliberately: when
// the feed is silent for >60s, the prune loop starts deleting valid arrivals, so
// the banner must fire at the same threshold or the popup quietly empties out
// with no warning to the user.
export const FEED_STALE_THRESHOLD_S = 60;
// Per-stop dwell time added to multi-stop calc ETAs. Metro GTFS uses point-times
// (arrival == departure) at non-timepoint stops, so schedule gaps contain no dwell.
// Bumped 30→40 (2026-05-07 v6): persistent −53s median error at 2–5 min spans
// 2–4 intermediate stops × 30s = 60–120s underestimate. +10s/stop closes most of it.
export const ETA_INTERMEDIATE_DWELL_S     = 40; // rail lines (was 30)
// G/J Lines — bumped 30→45 (2026-05-06 v6): J Line 33% taper-cap rate + -128s mean at
// 5–10 min indicates schedule too tight through downtown surface-street segment.
export const ETA_INTERMEDIATE_DWELL_BUS_S = 45;

// ── ETA blend ────────────────────────────────────────────────────────────────
// Phase 5b+ tier policy: use GTFS-RT when present (caller has already filtered
// stale/implausible entries upstream), otherwise calc fallback. No horizon-
// band blending, no disagreement decay, no replay guard. The 2026-05 offline
// sweep (docs/blend-tuning-2026-05.md, 57,954 paired snapshots) showed calc
// adds essentially no signal once GTFS-RT is present, and the replay guard
// fired on only 0.36 % of rows. Simpler logic, same rider-visible accuracy.
// See predictions._blendArrivals for the policy implementation.

// ── Station rendering ─────────────────────────────────────────────────────────
// Stops with the same normalised name within this radius are merged into one dot.
// Note: bikeshare.js has its own MERGE_RADIUS_M=50 for bike-dock co-location;
// they are intentionally different scales — rail platforms can be hundreds of
// meters apart at the same station (cross-platform interchanges, mezzanine
// transfers); bike docks at the same intersection are ≤50m apart.
export const STATION_MERGE_RADIUS_M = 300; // ~1 city block; groups platforms of the same station
// How often the open station popup re-renders its arrival times.
export const STATION_POPUP_REFRESH_MS = 5000;

// ── Long-session hygiene ──────────────────────────────────────────────────────
// Hard wall-clock TTL on a vehicle marker regardless of feed freshness. Catches
// ghost trips whose feed keeps re-broadcasting forever — without this they
// never hit FRESH_EXPIRE_S because their "feed silence" never starts.
//
// 3 hours covers the longest legitimate Metro trips end-to-end with a
// healthy layover buffer. The A Line (Long Beach ↔ APU/Citrus) is over
// 2 hours one-way — the world's longest light-rail line — and a user
// opening the app mid-trip needs the marker to persist until the run
// actually ends. _createdAtMs is set when a marker first appears IN THIS
// SESSION, not at trip-start, so this cap is the wall-clock window we
// give a marker before assuming it's a stale ghost. Earlier 30 min cap
// was set before the A Line's full length was considered.
export const MARKER_HARD_TTL_MS    = 3 * 60 * 60 * 1000;
// Grace period before force-removing a marker whose `timestamp` is missing
// (covers a brief ingest race during marker construction).
export const NO_TIMESTAMP_GRACE_MS = 15 * 1000;
// Defensive LRU cap. Active fleet is ~200 vehicles; well above legitimate
// worst-case but bounded so a leak can't grow forever before we notice.
export const MARKER_COUNT_CAP      = 500;
// Cadence of the GTFS service-date watcher (checks for midnight rollover).
export const SERVICE_DATE_CHECK_MS = 60_000;

// ── WebSocket reconnect ───────────────────────────────────────────────────────
// Base delay for exponential backoff. Doubles each failed attempt up to WS_MAX_RECONNECT_MS.
export const WS_BASE_RECONNECT_MS = 5000; // initial WebSocket reconnect delay; doubles on each retry
export const WS_MAX_RECONNECT_MS  = 300000; // 5 minutes

// Periodic forced WS reconnect — mimics a page refresh at the WS layer.
// Metro's WS appears to send a state snapshot only on initial connect, so a
// session left running indefinitely can drift if a vehicle's position stream
// had a transient gap that wasn't long enough to trip the 60s inbound watchdog
// but long enough for the marker to be pruned at FRESH_EXPIRE_S (300s). Every
// WS_PERIODIC_RECONNECT_MS, we deliberately close + reopen each WS to pull a
// fresh snapshot from Metro. 5 min is the right balance: aggressive enough that
// a ghost vehicle is recovered before a rider sees it as suspicious, and it
// sits at the upper edge of the existing backoff cap (WS_MAX_RECONNECT_MS) so
// it can't race with backoff-driven reconnects. Worst-case ghost persistence
// after this lands: ~5.5 min (cadence + jitter + 1s fast reconnect).
export const WS_PERIODIC_RECONNECT_MS        = 5 * 60_000;
// Symmetric jitter (±30s) so the four feeds (rail/bus × positions/trip_updates)
// don't all reconnect at the same instant. Tight enough that all four rotate
// within a 1-min window — predictable in logs while still avoiding collision.
export const WS_PERIODIC_RECONNECT_JITTER_MS = 60_000;

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
export const RAIL_ALERTS_URL = 'https://5cgdcfl7csnoiymgfhjp5bqgii0yxifx.lambda-url.us-west-1.on.aws/'; // last-verified 2026-05
export const BUS_ALERTS_URL  = 'https://lbwlhl4z4pktjvxw3tm6emxfui0kwjiv.lambda-url.us-west-1.on.aws/'; // last-verified 2026-05
export const ALERTS_POLL_MS  = 120_000;

// ── Metro Bike Share ──────────────────────────────────────────────────────────
export const BIKESHARE_POLL_MS      = 30000;
export const GBFS_INFO_URL          = 'https://gbfs.bcycle.com/bcycle_lametro/station_information.json';
export const GBFS_STATUS_URL        = 'https://gbfs.bcycle.com/bcycle_lametro/station_status.json';
// Hover-popup debounce on bike markers. Two distinct values: when the bike
// station co-locates with a rail station group, opening that group's popup is
// the priority (fast); otherwise we open a standalone bike popup (slightly
// longer to avoid flicker on accidental cursor passes).
//
// Tuning rationale (2026-05-10): 120 m proxies "same plaza/station entrance"
// — wider than rail-rail bikeshare merge (50 m) because rail stations span
// hundreds of meters. 180/200 ms hover delays are below the ~250 ms research
// threshold for "deliberate hover" (anything shorter triggers on cursor
// transit). The 20 ms gap biases toward the rail station when a marker is
// near one, since users hovering bikes at a rail station usually want
// rail-arrival times. Re-tune if usability data ever suggests fast
// interaction is being mistaken for accidental cursor passage.
export const BIKESHARE_NEAR_RAIL_RADIUS_M  = 120;
export const BIKESHARE_HOVER_DELAY_NEAR_MS = 180;
export const BIKESHARE_HOVER_DELAY_SOLO_MS = 200;

// ── Route terminus display overrides ─────────────────────────────────────────
// GTFS terminal stop names are sometimes layover/yard identifiers that aren't
// meaningful to riders. Override them here with the canonical passenger-facing
// terminus name. Key format: "routeCode|directionId".
export const TERMINUS_DISPLAY_OVERRIDES = {
    '950|1': 'San Pedro',  // GTFS last stop is "Pacific / 21st Layover", not the station name
};

// ── Route metadata ────────────────────────────────────────────────────────────
/** Maps routeCode → official LACMTA SVG icon URL (from metro-iconography CDN). */
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

/** Maps routeCode → { 0: 'Northbound', 1: 'Southbound' } direction label pairs. */
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

/**
 * Route codes the app cares about — six Metro rail lines plus the G/J busways
 * and bus-route variants. Used by:
 *   - alerts.js to filter incoming alert routeIds (drop bus-route alerts for
 *     lines we don't draw)
 *   - stations.js to gate which rail/busway lines render in popups and badges
 *
 * Previously declared in two places (`RELEVANT_ROUTES` in alerts.js,
 * `RAIL_LIKE_ROUTES` in stations.js) with identical contents. Centralised so
 * adding/retiring a line is a one-line change.
 */
export const METRO_ROUTE_CODES = new Set(['801','802','803','804','805','807','901','910','950']);

/** Maps routeCode → brand hex color string (used for SVG fills and CSS variables). */
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

