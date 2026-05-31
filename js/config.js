// ── Per-vehicle freshness tiers ───────────────────────────────────────────────
// One source of truth for how a vehicle marker LOOKS. A pure tier function in
// freshness.js (`getFreshnessTier`) maps `nowSec - marker.timestamp` into:
//
//   live    (age <  FRESH_STALE_S  =  90s)  → opacity 1.00, popup dot green
//   stale   (age <  FRESH_EXPIRE_S = 300s)  → opacity 0.50, popup dot gray
//   expired (age ≥  FRESH_EXPIRE_S)         → fade out + remove from DOM
//
// History: a four-tier model with an intermediate `aging` band (30–90s)
// existed briefly (PR #141 collapsed it visually into `live` because Metro's
// normal 15–35s broadcast lag would otherwise flip the dot amber on healthy
// feeds and confuse riders). The KISS pass (2026-05-27) removed the tier
// from the data model too — it had zero behavioral consumers and the
// remaining three tiers map cleanly to "live / stale / gone."
//
// Bounds rationale:
//   90s — Past Metro's normal lag envelope (15–35s). If we haven't heard from
//         a vehicle in 90s, the feed has genuinely paused on it; opacity
//         drops to 0.5 once we cross into `stale`.
//   300s — Hard data-quality cutoff. After 5 min of silence, the vehicle is
//          either parked or off-route; predictions can't trust it any longer.
export const FRESH_STALE_S           = 90;
export const FRESH_EXPIRE_S          = 300;
export const FRESH_CHECK_INTERVAL_MS = 5000;

// Speed-freshness gate — used by predictions.js to decide whether
// marker.properties.smoothedSpeed is recent enough to trust as a "current
// speed" reading (rather than an EWMA-stale value from before the vehicle
// stopped or slowed). 30 s ≈ Metro's typical broadcast cadence, so any
// speed older than this could already be wrong by a stop-cycle.
// Independent of the freshness tier model above — that's about WHAT THE
// MARKER LOOKS LIKE; this is about WHETHER THE NUMBER IS USABLE.
export const FRESH_LIVE_S            = 30;

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
// RAIL_MAX_SPEED_MPS bounds the rail arc-distance spike gate and the arc-glide
// re-anchor (implied-speed) threshold; ETA_MAX_SPEED_MPS is the blend cap.
// Implausibly high speed (m/s) — clamped at ingestion and used to reject GPS spikes.
export const MAX_PLAUSIBLE_SPEED_MPS = 50; // ~110 mph
// GPS noise floor (degrees) — used as the lower bound for outlier rejection radius.
export const GPS_NOISE_FLOOR_DEG = 0.0001; // ~10 m
// Hold heading within this distance of the trip's terminal stop.
export const FINAL_STOP_HOLD_M = 150;
// Minimum distance to a downstream stop before bearingToStop() returns a result.
export const DOWNSTREAM_MIN_METERS = 20;

// ── Position-jitter deadband ──────────────────────────────────────────────────
// For MOVING vehicles (speed ≥ STATIONARY_SPEED_MPS): threshold is 0 — every
// forward move animates so slow station approaches are visible in real time.
// Backward moves are still held by the check `arcDelta < threshold` (arcDelta
// is negative; 0 > any negative number → hold). The old 12 m forward threshold
// was silently freezing trains creeping into platforms for 8–12 s of real motion.
export const POS_JITTER_DEADBAND_M = 0;
// For STATIONARY vehicles (speed < STATIONARY_SPEED_MPS): keep a wider band to
// prevent the marker shuffling in place from GPS noise and ratcheting forward
// while docked. A real departure moves ≫ 25 m on the first update.
export const POS_JITTER_DWELL_DEADBAND_M = 25;    // when speed < STATIONARY_SPEED_MPS

// ── Snap-to-polyline thresholds ───────────────────────────────────────────────
// Surface rail (A/C/E/K): mostly fixed guideway but with at-grade street-running
// segments where GPS multipath and shape-vs-track offsets are well bounded.
export const RAIL_SNAP_MAX_M = 150;
// Heavy rail (B/D): fully grade-separated tunnels. The vehicle physically
// cannot leave the track, so any GPS divergence is noise — wider threshold
// keeps the marker on-rail through urban-canyon and tunnel-mouth multipath
// instead of dropping snap and showing the train wandering through buildings.
export const HEAVY_RAIL_SNAP_MAX_M = 250;
// G/J BRT (901/910/950): dedicated busway, same track-fidelity as surface rail.
// Raised from the generic bus value (75 m) so GPS scatter on the busway doesn't
// clear lastSnap and fall through to straight-line animation. Off-busway detours
// snap-fail (snap distance > 150 m) and correctly show at raw GPS.
export const BRT_SNAP_MAX_M = 150;
// Generic bus (non-BRT): can detour onto surface streets — tight threshold
// so off-route buses show at raw GPS instead of being pulled onto the polyline.
export const BUS_SNAP_MAX_M = 75;
// Snap-deviation gate used by predictions.computeTripAdherenceOffset to decide
// whether the marker's snap is trustworthy enough to compute schedule adherence.
// Looser than BUS_SNAP_MAX_M (75 m) because buses legitimately drift mid-block;
// the inter-stop segment guard catches wrong-stop snaps separately.
export const BUS_SNAP_MAX_DEVIATION_M = 120;

// ── Feed-timestamp future-frame grace ─────────────────────────────────────────
// Reject frames whose `timestamp` lands further than this in the future. A
// genuine clock skew of a few seconds between Metro's servers and the user's
// browser is common; a 60-second future stamp is the sign of a serializer bug
// or wrong clock. Without this gate, `now - timestamp` goes negative, every
// freshness/age check collapses to 0 (= "fresh"), and a mis-stamped or
// phantom frame renders as perpetually live instead of aging out.
// 5_000 ms = 5 s. Smaller than Metro's documented 15–35 s broadcast lag, so
// we never reject late frames; large enough to absorb routine clock skew.
export const FUTURE_TS_GRACE_MS = 5_000;

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
// Consecutive-rejection escape hatch. A one-off spike should be rejected, but
// a SUSTAINED streak of rejections means the "spike" is the new reality the
// gate can't distinguish from noise — most commonly a B/D train emerging from
// a tunnel hundreds of metres ahead of its last surface fix. After this many
// rejections in a row, force-accept (re-anchor) the next fix so the marker
// can't stay frozen until the page is refreshed. At Metro's ~5–30 s cadence
// this bounds the stuck window to roughly streak × cadence; a genuine one-off
// spike never reaches it because any accepted fix resets the streak to 0.
export const SPIKE_REANCHOR_STREAK = 3;
// Cold-start gate: brand-new markers without lastVelocity bypass the predict-validate
// filter. If the very first fix lands more than this distance from the route polyline,
// reject it as obvious bad data (the vehicle physically cannot be off-track by km).
// Shapes carry generous corridor width (curves, station offsets) so 1500 m is loose
// enough to never reject legitimate cold starts at platforms, yard turnouts, or where
// the rendered shape diverges slightly from physical track.
// Note: matches GPS_SPIKE_STOP_RADIUS_M (1500 m) by coincidence, not by design —
// they serve different phases (spike bypass on warm marker vs. off-route reject on
// first fix). Tune them independently.
export const COLD_START_MAX_OFFROUTE_M = 1500;

// ── Marker glide ──────────────────────────────────────────────────────────────
// The per-WS-frame visual glide duration is NOT fixed — it tracks the actual
// gap between this fix and the previous one (`(newTs - prevTs) * 1000`), so the
// marker's on-screen speed ≈ the vehicle's real average speed (distance moved ÷
// time it took). A fixed duration was the cause of the "zooming across the
// whole line" bug: a 600 m advance reported after a 30 s gap, rendered in a
// fixed 5 s glide, is 120 m/s on screen.
//   • GLIDE_MIN_MS — floor, so rapid back-to-back fixes still ease smoothly
//     rather than snapping.
//   • GLIDE_MAX_MS — ceiling: a gap longer than this RE-ANCHORS (teleports to
//     the new snapped position) instead of gliding. Because the duration is
//     gap-matched (not fixed), there's no "zoom" risk at longer gaps — the only
//     cost of gliding a long gap is LAG: the marker trails the latest fix by up
//     to the gap. Raised 30s → 60s because Metro's vehicle-position cadence is
//     frequently >30s, so at 30s most updates teleported even for short moves;
//     60s lets the common cadence glide, trading a little freshness for far
//     smoother motion. Gaps beyond 60s are genuinely stale → teleport is honest.
//     (Still < SPIKE_BYPASS_S = 120s, the stale-reference bypass.)
// The marker still never moves past where the latest GPS fix says it is.
export const GLIDE_MIN_MS = 1000;
export const GLIDE_MAX_MS = 60000;

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
// Assumed departure lag (seconds) added to schedule-based ETAs to account for
// the gap between a stop's scheduled departure and the vehicle actually moving.
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
// Tier policy: use GTFS-RT when present (caller has already filtered
// stale/implausible entries upstream), otherwise calc fallback. No horizon-
// band blending, no disagreement decay, no replay guard. The 2026-05 offline
// sweep (docs/_archive/blend-tuning-2026-05.md, 57,954 paired snapshots) showed calc
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
// Max accepted WS frame size (bytes). A frame larger than this is rejected
// BEFORE JSON.parse — a transient cache corruption / MITM / Metro infra glitch
// could otherwise send a multi-MB blob that locks the main thread for seconds
// inside parse (the existing try/catch only fires AFTER the parse completes).
// Real Metro frames are < 50 KB; 256 KB is a generous ceiling. Tunable.
export const WS_MAX_FRAME_BYTES = 256 * 1024;
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

// ── WebSocket liveness tunables ──────────────────────────────────────────────
// Force-close a socket if no inbound message arrives within this window. Metro
// vehicle position feeds emit at sub-30s cadence under normal load, so 60s of
// total silence is a reliable "half-dead connection" signal. Tighter than the
// default backoff window so we recover within a minute instead of waiting for
// the OS-level TCP timeout (often 5+ min).
export const WS_INBOUND_TIMEOUT_MS    = 60_000;
// How often the watchdog tick checks each socket's lastMessageAt.
export const WS_WATCHDOG_INTERVAL_MS  = 15_000;
// Visibility-restore staleness threshold — when the tab regains focus, any
// socket that hasn't received a message in this long is force-reconnected
// immediately rather than waiting for the next watchdog tick.
export const WS_VISIBILITY_STALE_MS   = 30_000;
// Reconnect delay after a deliberate watchdog-triggered close. Skips the normal
// exponential backoff because we already know the network/client is fine —
// the previous server connection was unresponsive, not unreachable.
export const WS_FAST_RECONNECT_MS     = 1_000;

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

