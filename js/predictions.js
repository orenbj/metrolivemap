import { cleanStationName, isStoppedAt, normalizeStopId, isBusRoute, snapMaxForRoute } from './utils.js';
import { snapToRoute, hasShapeData, resolveShapeKey } from './snap.js';
import {
    ETA_MAX_SPEED_MPS, ETA_PLAUSIBILITY_GRACE_S,
    ETA_PROXIMITY_OVERRIDE_M, ETA_MIN_APPROACH_SPEED_MPS,
    ETA_DEPARTURE_LAG_S,
    GTFS_ENTRY_STALENESS_S, VEHICLE_MARKER_TTL_S, PAST_ARRIVAL_GRACE_S,
    ETA_INTERMEDIATE_DWELL_S, ETA_INTERMEDIATE_DWELL_BUS_S,
    ADHERENCE_TAPER_K, TERMINUS_DISPLAY_OVERRIDES,
    FRESH_LIVE_S, MAX_ADHERENCE_OFFSET_S, BOARDING_MAX_HORIZON_S,
} from './config.js';
import { tripTerminusByTripId, isStopSkipped } from './tripUpdates.js';

const RE_TRAIL_NONDIG = /\D+$/;
const RE_HAS_DIGIT    = /\d/;

const routeStops = {};

/**
 * Return the per-(route, direction) stop/time cache built by initPredictions.
 * Used by markers.js as a fallback when a marker's trip_id is not present in
 * masterTripsData (e.g. B Line owl-service trips whose IDs are out of sync
 * with the static GTFS schedule). Returns undefined if no cache exists.
 *
 * @param {string} rc Route code, e.g. '802'
 * @param {number} dir Direction id, 0 or 1
 * @returns {{stops: string[], times: number[], arcMeters?: (number|null)[]}|undefined}
 */
export function getRouteCache(rc, dir) {
    if (!rc || dir == null) return undefined;
    return routeStops[`${rc}|${dir}`];
}

/**
 * Clear the route-stops cache (per-`${rc}|${dir}` map populated by
 * initPredictions). Called when GTFS data reloads at midnight so the
 * next initPredictions() call rebuilds from the new masterTripsData
 * instead of returning yesterday's cached stop sequences.
 */
export function _clearRouteStopsCache() {
    for (const k in routeStops) delete routeStops[k];
}

/**
 * Pre-process window.masterTripsData into per-(route, direction) stop/time lookup
 * tables and compute arc-meter positions for each stop (used in kinematic ETA).
 * Must be called after stops.json and trips.json are loaded.
 */
export function initPredictions() {
    const trips = window.masterTripsData;
    if (!trips) return;

    // Idempotence guard: clear the cache before rebuilding. If initPredictions
    // is called twice in quick succession with masterTripsData partially
    // refreshed (e.g. two service-date rollovers detected within 60 s, or a
    // dev-time re-import), the rebuild would otherwise interleave old and new
    // sequences silently. Unconditional clear costs O(routes×directions),
    // ~16 entries — negligible.
    _clearRouteStopsCache();

    const best = {};
    for (const [tripId, trip] of Object.entries(trips)) {
        const { rc, dir, stops, scheduledTimes } = trip;
        if (rc == null || dir == null || !stops?.length || !scheduledTimes?.length) continue;
        // Require stops/times length agreement DURING selection, not after: a
        // single length-mismatched longest trip would otherwise win the (rc,dir)
        // slot and then be dropped below, leaving the whole direction with no
        // cache (no ETAs / adherence / boarding) even when hundreds of valid
        // shorter trips exist.
        if (stops.length !== scheduledTimes.length) continue;
        const key = `${rc}|${dir}`;
        if (!best[key] || stops.length > best[key].stops.length) best[key] = { ...trip, tripId };
    }

    for (const [key, trip] of Object.entries(best)) {
        routeStops[key] = {
            stops: trip.stops.map(String),
            times: trip.scheduledTimes,
        };
    }

    // Precompute stop arc-meters for kinematic ETA (best-effort; null if shapes not yet loaded)
    let arcStops = 0, arcMissed = 0;
    for (const [key, cache] of Object.entries(routeStops)) {
        const [rc, dir] = key.split('|');
        if (!hasShapeData(rc)) continue;
        // Project this direction's stops onto THIS direction's shape (the bare
        // shape for the canonical direction, the `${rc}|${dir}` split shape for
        // the other) so the stop arc-meters live in the SAME arc space as the
        // marker's snap/glide — stop-lag and adherence compare the two directly.
        const shapeKey = resolveShapeKey(rc, dir === undefined ? null : Number(dir));
        // Record the shape space these arcMeters live in, so arc consumers
        // (computeTripAdherenceOffset / gtfsLooksPlausible) can verify the
        // marker's snap arc (marker._currentArcKey space) is comparable before
        // subtracting them — the two disagree on split routes (801|0 etc., built
        // REVERSED vs the bare shape) whenever the feed's direction_id drops out.
        cache.shapeKey = shapeKey;
        cache.arcMeters = cache.stops.map(stopId => {
            const stop = window.masterStopsData?.[stopId];
            if (!stop) { arcMissed++; return null; }
            // Treat missing/non-finite coords as a cache miss too. snapToRoute
            // would otherwise be called with undefined and silently return the
            // route origin (arcMeters=0), corrupting every adherence and ETA
            // calculation for segments touching this stop.
            if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) {
                arcMissed++;
                return null;
            }
            return snapToRoute(shapeKey, stop.lon, stop.lat)?.arcMeters ?? null;
        });
        // Record arc orientation for this route-direction. With a per-direction
        // shape both directions' stops project ASCENDING; on a shared bare
        // centerline the reverse direction projects DECREASING. `arcAscending`
        // lets the adherence + plausibility math measure forward progress
        // correctly either way, and `arcUnreliable` disables arc reasoning for
        // any shape whose stops don't project monotonically (then those
        // functions trust schedule/GTFS).
        const _orient = _computeArcOrientation(cache.arcMeters);
        cache.arcAscending  = _orient.ascending;
        cache.arcUnreliable = _orient.unreliable;
        arcStops += cache.arcMeters.filter(v => v !== null).length;
    }
    // D-1: warn if a significant fraction of stops are absent from stops.json.
    const arcTotal = arcStops + arcMissed;
    if (arcTotal > 0 && arcMissed / arcTotal > 0.2) {
        console.warn(`[predictions] ${arcMissed}/${arcTotal} stop IDs missing from stops.json — static data may be stale.`);
    }
}

/**
 * Tiered ETA selector. Returns the GTFS-RT-derived ETA when one is present
 * (the caller has already filtered out stale/implausible entries upstream)
 * and falls back to the calc-derived ETA otherwise.
 *
 * Why this is a function and not just `gtfsEtaS ?? calcEtaS`:
 *   - Keeps a single named seam where every (calc, gtfs) pair gets resolved,
 *     so future audits / instrumentation only need to wrap one call site.
 *   - Documents the policy explicitly. The old name "_blendArrivals" is kept
 *     so the import surface and test sites don't churn — but the math is no
 *     longer a blend.
 *
 * Why we don't blend at all:
 *   The 2026-05 offline sweep (docs/_archive/blend-tuning-2026-05.md, 57,954 paired
 *   snapshots) showed calc adds essentially no signal once GTFS-RT is
 *   present — 0% weight beyond 5 min, 10% near, marginal MAE improvement
 *   at the cost of within60s% degradation. Calc's real value is the
 *   fallback case, which is what this function now expresses.
 *
 *   The plausibility / staleness / origin-stop guards that used to choose
 *   between calc and GTFS-RT still live in getScheduledArrivals /
 *   getArrivalBreakdown — they hand this function either the trusted GTFS
 *   value or null. So `gtfsEtaS != null` means "the caller has already
 *   decided GTFS-RT is the right answer here."
 *
 * @param {number|null} calcEtaS   Calc-derived ETA (unix seconds), or null
 * @param {number|null} gtfsEtaS   GTFS-RT arrival unix seconds, or null
 *                                 (caller already filtered stale/implausible)
 * @param {number}      _horizonSec  Reserved for future use (kept for caller
 *                                   compatibility; ignored under the tier policy)
 * @param {number}      _nowS        Reserved for future use (same reason)
 * @returns {number|null}          GTFS-RT ETA if available, else calc, else null
 */
export function _blendArrivals(calcEtaS, gtfsEtaS, _horizonSec, _nowS) {
    if (gtfsEtaS != null) return gtfsEtaS;
    return calcEtaS;
}

/**
 * Apply the adherence-taper cap to a calc ETA. The taper limits how much of
 * the raw adherence offset (which can be ±600 s) flows into the displayed
 * ETA, scaling the cap proportionally to remaining travel time.
 *
 * Why: a vehicle 5 min late with 30 s remaining to its next stop should NOT
 * show ETA = now + 30 s + 300 s = 5.5 min — it physically arrives in ~30 s.
 * Capping at K × remainingTime keeps near-stop ETAs realistic while letting
 * downstream stops (with larger remainingTime) express most of the cascade.
 *
 * Used in production by getScheduledArrivals and (mirrored) by
 * getArrivalBreakdown's _offsetCapped diagnostic.
 *
 * @param {number} schedEta         Schedule-derived ETA (unix seconds)
 * @param {number} adherenceOffset  Raw signed offset from computeTripAdherenceOffset
 * @param {number} now              Current unix seconds
 * @returns {number} Tapered, now-clamped calc ETA
 */
export function _applyTaperedOffset(schedEta, adherenceOffset, now) {
    const remainingTime = Math.max(0, schedEta - now);
    // Overrun case: the schedule ETA is floored to `now` (interStopRemainingSeconds
    // saturated at 0 because the vehicle has been in-segment longer than the
    // scheduled gap). remainingTime is then 0, so the K×remainingTime cap below
    // would zero out a legitimate POSITIVE lateness offset — pinning the ETA at
    // "Now" for a train physically minutes away, the exact multi-minute delay the
    // overrun branch of computeTripAdherenceOffset was written to express. In
    // overrun the offset (positive = late, already ±MAX_ADHERENCE_OFFSET_S-clamped
    // upstream) IS the estimate of remaining time, so let it through; a negative
    // (early) offset can't apply once the schedule already says "arrived", so
    // floor it at 0.
    if (remainingTime === 0) {
        return Math.max(now, schedEta + Math.max(0, adherenceOffset));
    }
    const maxOffset     = ADHERENCE_TAPER_K * remainingTime;
    const cappedOffset  = Math.sign(adherenceOffset) * Math.min(Math.abs(adherenceOffset), maxOffset);
    return Math.max(now, schedEta + cappedOffset);
}

const dirsToTry = d => d != null ? [d] : [0, 1];

/**
 * Find the index of targetId in the stops array with fuzzy matching.
 * Tries: exact match → directional suffix strip → digit prefix match.
 * @param {string[]} stops    Ordered stop ID array for a route direction
 * @param {string|number} targetId Stop ID to locate
 * @returns {number} Index into stops, or -1 if not found
 */
export function findIdx(stops, targetId) {
    const t = String(targetId);
    let idx = stops.indexOf(t);
    if (idx !== -1) return idx;

    const stripped = normalizeStopId(t);
    if (stripped !== t) {
        idx = stops.indexOf(stripped);
        if (idx !== -1) return idx;
        idx = stops.findIndex(s => normalizeStopId(s) === stripped);
        if (idx !== -1) return idx;
    }

    const noTrail = t.replace(RE_TRAIL_NONDIG, '');
    if (noTrail && noTrail !== t && noTrail !== stripped) {
        idx = stops.indexOf(noTrail);
        if (idx !== -1) return idx;
    }

    if (t.length >= 5) {
        // Only match if the longer ID is the shorter one plus a non-numeric suffix (e.g. "80204N")
        idx = stops.findIndex(s => {
            const [longer, shorter] = s.length >= t.length ? [s, t] : [t, s];
            return longer.startsWith(shorter) && !RE_HAS_DIGIT.test(longer.slice(shorter.length));
        });
        if (idx !== -1) return idx;
    }
    return -1;
}

/**
 * Seconds since `statusChangedAt`, plus a constant departure-lag offset that
 * models door-closing / passenger-settling time at stops. Single source of
 * truth for the lag arithmetic — used by both `interStopRemainingSeconds` and
 * `computeTripAdherenceOffset`. If they ever drift apart, blended ETAs shift
 * silently because both paths feed the same downstream blend.
 * @param {number} statusChangedAt Unix seconds the marker ENTERED its current
 *   inter-stop segment — set on stop-id change in markers.js, NOT on
 *   currentStatus change (the name is historical). `now - statusChangedAt` is
 *   thus elapsed time in the segment, which is what this timer needs.
 * @param {number} now             Unix seconds (caller-controlled for testability).
 * @returns {number} Elapsed seconds + ETA_DEPARTURE_LAG_S.
 */
function _elapsedWithLag(statusChangedAt, now) {
    return (now - statusChangedAt) + ETA_DEPARTURE_LAG_S;
}

/**
 * Seconds remaining until the vehicle reaches its next stop, derived from how
 * long it has been in the current inter-stop segment vs. the scheduled segment
 * duration (NOT from arc position/speed — that kinematic variant was retired
 * with scheduleCalibration; see the body note).
 * @param {number} statusChangedAt Unix seconds the vehicle entered the segment
 *   (set on stop-id change; see _elapsedWithLag).
 * @param {number} now             Unix seconds.
 * @param {number[]} times         Per-stop scheduled times (seconds since midnight).
 * @param {number} idx             Index of the next stop in `times`.
 * @returns {number|null} Seconds remaining (0 if already past); null when not computable.
 */
export function interStopRemainingSeconds(statusChangedAt, now, times, idx) {
    if (statusChangedAt == null || idx <= 0) return null;
    const interStopGap = times[idx] - times[idx - 1];
    if (interStopGap <= 0) return null;
    // The per-(route, direction) schedule-speed multiplier (EWMA-learned
    // from observed inter-stop times) was retired with scheduleCalibration.js
    // — variance-gated to 1.0 on most routes anyway, and the ±5-15s
    // adjustment it produced on tight-variance routes was indistinguishable
    // from random variance in the Now/<1m/Xm bucket the rider sees.
    const timeInTransit = Math.min(_elapsedWithLag(statusChangedAt, now), interStopGap);
    return Math.max(0, interStopGap - timeInTransit);
}

/**
 * Determine the arc orientation of a route-direction's stop sequence projected
 * onto the single per-route polyline. Because ONE polyline serves both
 * directions, arc-meters increase with stop index for the direction matching
 * the shape and decrease for the reverse. Returns:
 *   - ascending  — true when arc generally grows with stop index. Drives the
 *     sign flip in _orientArc so "forward progress" increases in travel order.
 *   - unreliable — true when the sequence is too non-monotonic to trust (a bad
 *     or over-long shape, e.g. a scrambled union). Callers then fall back to
 *     schedule + trust-GTFS rather than reasoning about a meaningless arc.
 * @param {(number|null)[]} arcMeters  Per-stop arc-meters (nulls allowed)
 * @returns {{ascending: boolean, unreliable: boolean}}
 */
export function _computeArcOrientation(arcMeters) {
    let inc = 0, dec = 0, prev = null;
    for (const a of arcMeters || []) {
        if (a == null) continue;
        if (prev != null) {
            if (a > prev) inc++;
            else if (a < prev) dec++;
        }
        prev = a;
    }
    const total = inc + dec;
    // >15% direction reversals ⇒ not a clean monotonic projection. Zero usable
    // pairs ⇒ unreliable too (can't establish an orientation).
    return {
        ascending:  inc >= dec,
        unreliable: total === 0 || Math.min(inc, dec) / total > 0.15,
    };
}

/**
 * Convert a raw polyline arc-meters value into "forward progress" for a given
 * route-direction cache. The cache's stop arcs and the vehicle's snap arc are
 * both measured on the SAME single polyline, so a sign flip (driven by the
 * cache's orientation) is all that's needed to make progress increase in the
 * travel direction. Only DIFFERENCES of oriented values are used downstream, so
 * the sign flip preserves metre units (and the sign cancels in subtractions).
 * @param {{arcAscending: boolean}} cache
 * @param {number} rawArc  Raw arc-meters from snapToRoute / cache.arcMeters
 * @returns {number}
 */
function _orientArc(cache, rawArc) {
    // Negate ONLY for an explicitly-descending cache. A cache without an
    // orientation flag (defensive; initPredictions always sets one) defaults to
    // ascending — the historical assumption — so raw arc passes through unchanged.
    return cache.arcAscending === false ? -rawArc : rawArc;
}

/**
 * Measure how many seconds this vehicle is running ahead (negative) or behind
 * (positive) its timetable based on GPS arc position vs. the scheduled position
 * in the current inter-stop segment.
 *
 * Sign convention: **positive = late, negative = early.** Downstream callers
 * (`_applyTaperedOffset`, `getSecondsToNextStop`) add the offset to `schedEta`,
 * so a positive offset pushes the ETA into the future (vehicle is behind).
 *
 * Two branches:
 *   - In-segment (elapsed ≤ scheduled gap): arc-position offset converted to time.
 *     A vehicle behind where it should be at this point in the segment shows positive.
 *   - Overrun (elapsed > scheduled gap): vehicle should already have arrived.
 *     Express full lateness as (elapsed − gap) + (remainingArc / schedSpeed),
 *     so multi-segment delays flow through to all downstream ETAs instead of
 *     being silently clamped at one segment's worth of lateness.
 *
 * Clamped to ±600s to bound GPS pathology, but otherwise lateness flows freely.
 * Returns 0 when required data is absent or snap quality is poor.
 */
export function computeTripAdherenceOffset(marker, cache, nextIdx, now) {
    // arcUnreliable: a shape whose stops don't project monotonically — its arc is
    // meaningless, so skip GPS adherence and let the schedule stand alone.
    if (!cache.arcMeters || !marker.lastSnap || nextIdx <= 0 || cache.arcUnreliable) return 0;

    // Arc-space guard (mirrors markers.js _stopLagFromDeclared): cache.arcMeters
    // lives in cache.shapeKey space; marker.lastSnap.arcMeters lives in
    // marker._currentArcKey space. On split routes these disagree whenever the
    // feed omits direction_id (the marker resolves the bare/reversed shape),
    // producing a garbage cross-space offset that would flip the adherence sign
    // or reject the arc. Bail to schedule-only when the spaces don't match.
    if (marker._currentArcKey != null && cache.shapeKey != null && marker._currentArcKey !== cache.shapeKey) return 0;

    const rawNext = cache.arcMeters[nextIdx];
    const rawPrev = cache.arcMeters[nextIdx - 1];
    const rawSnap = marker.lastSnap.arcMeters;
    if (rawNext == null || rawPrev == null || rawSnap == null) return 0;

    // Orient to forward progress so the segment math holds for BOTH directions
    // (the reverse direction's raw arc decreases with stop index).
    const nextArc = _orientArc(cache, rawNext);
    const prevArc = _orientArc(cache, rawPrev);
    const snapArc = _orientArc(cache, rawSnap);

    // Folded-arc guard: after orientation prevArc < nextArc should hold. If it
    // still doesn't, this local segment is genuinely non-monotonic (duplicate /
    // folded vertices) — return 0 rather than compute a wrong-sign offset.
    if (prevArc > nextArc) return 0;
    const interStopDist = nextArc - prevArc;
    const interStopGap  = cache.times[nextIdx] - cache.times[nextIdx - 1];
    if (interStopDist <= 0 || interStopGap <= 0) return 0;

    // Snap must be within the current inter-stop segment. If it's outside (GPS
    // noise snapped to the wrong part of the track) the offset would be wildly
    // wrong — just return 0 and rely on the schedule alone.
    if (snapArc < prevArc || snapArc > nextArc) return 0;

    const { statusChangedAt } = marker.properties;
    if (statusChangedAt == null) return 0;

    // Snap-quality gate: only skip adherence when GPS is so far off the guideway
    // that the snap itself is unreliable. The ladder MUST mirror the
    // snap-acceptance ladder in markers.js (`_applySnap`) EXACTLY — BRT =
    // BRT_SNAP_MAX_M (150 m, checked before the generic-bus arm because
    // isBusRoute() is true for 901/910/950 too), bus = BUS_SNAP_MAX_M, heavy
    // rail = HEAVY_RAIL_SNAP_MAX_M (250 m, tunnel GPS scatter on B/D), light
    // rail = RAIL_SNAP_MAX_M. lastSnapDeviationM is only ever set when the
    // snap was ACCEPTED, so a matched ladder makes this gate purely defensive;
    // any divergence creates a band where the marker renders a snapped position
    // that adherence silently rejects (the previous BUS_SNAP_MAX_DEVIATION_M =
    // 120 m did exactly that to BRT snaps in the 120–150 m band). The
    // inter-stop segment guard below catches wrong-stop snaps separately.
    const dev      = marker.lastSnapDeviationM;
    const _rc      = marker.properties?.route_code;
    const devLimit = snapMaxForRoute(_rc);
    if (dev == null || dev > devLimit) return 0;

    const rawElapsed             = now - statusChangedAt;
    const elapsedSinceLastStatus = rawElapsed + ETA_DEPARTURE_LAG_S;   // lag only for in-segment path
    const schedSpeed = interStopDist / interStopGap;

    if (rawElapsed > interStopGap) {
        // Vehicle ran past its scheduled segment arrival without logging STOPPED_AT.
        // The old Math.min cap silently capped at ~interStopGap, hiding multi-minute
        // delays. Express the full overrun: how long past schedule + time still needed
        // to cover remaining arc at scheduled speed.
        // Use rawElapsed (no lag) so the overrun gate fires exactly on schedule, not
        // ETA_DEPARTURE_LAG_S (15 s) early — which caused a systematic upward ETA bias.
        const remainingDist = nextArc - snapArc;
        const remainingTime = Math.max(0, remainingDist / schedSpeed);
        const overrun       = rawElapsed - interStopGap;
        const raw           = overrun + remainingTime;
        return Math.max(-MAX_ADHERENCE_OFFSET_S, Math.min(MAX_ADHERENCE_OFFSET_S, raw));
    }

    // In-segment path: vehicle is still within its scheduled arrival window.
    const timeInTransit    = elapsedSinceLastStatus;
    const schedExpectedArc = prevArc + (timeInTransit / interStopGap) * interStopDist;

    // Positive arcDelta = vehicle ahead of schedule; negate for offset sign convention.
    const arcDelta = snapArc - schedExpectedArc;
    const raw      = -(arcDelta / schedSpeed);

    return Math.max(-MAX_ADHERENCE_OFFSET_S, Math.min(MAX_ADHERENCE_OFFSET_S, raw));
}

/**
 * Sanity-check a Tier-1 GTFS-RT arrival against the vehicle's physical position.
 * Returns false only when the reported arrival is implausibly soon given the
 * arc-distance to the stop. Returns true (trust feed) when required data is missing.
 * @param {Object} marker     Vehicle marker with lastSnap
 * @param {Object} cache      Route stop cache with arcMeters
 * @param {number} targetIdx  Index of the target stop in cache.stops
 * @param {Object} gtfsEntry  Arrival entry from masterArrivalsData
 * @param {number} now        Current unix seconds
 * @returns {boolean}
 */
export function gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now) {
    // No arc data, or a shape whose stops don't project monotonically (its arc
    // is meaningless) → trust the feed. The upstream staleness gate still applies.
    if (!cache.arcMeters || !marker.lastSnap || cache.arcUnreliable) return true;
    // Arc-space guard (see computeTripAdherenceOffset): the stop arc and the
    // marker snap arc must live in the SAME shape space to be comparable. On a
    // split route with the feed's direction_id dropped, they don't — and the
    // bogus cross-space distMeters would REJECT a perfectly good GTFS-RT arrival
    // as "impossibly soon." Trust the feed (return true) rather than reject it.
    if (marker._currentArcKey != null && cache.shapeKey != null && marker._currentArcKey !== cache.shapeKey) return true;
    const rawStop    = cache.arcMeters[targetIdx];
    const rawVehicle = marker.lastSnap.arcMeters;
    if (rawStop == null || rawVehicle == null) return true;

    // The snapped arc position is only as trustworthy as the GPS fix it came
    // from. _lastAcceptedTs is the trusted clock (marker.timestamp is bumped on
    // spike-rejected frames and would mask a frozen vehicle). When the last
    // accepted fix is older than FRESH_LIVE_S — sparse off-peak service, the
    // ~17 s BRT busway cadence, a tunnel freeze — the snap has drifted and can't
    // be used to assert where the vehicle sits relative to a stop.
    const markerTs    = Number(marker._lastAcceptedTs ?? marker.timestamp) || 0;
    const snapIsFresh = markerTs > 0 && (now - markerTs) <= FRESH_LIVE_S;

    // Oriented so distMeters is the FORWARD distance to the stop in the travel
    // direction (positive = ahead) regardless of the polyline's storage order.
    const distMeters = _orientArc(cache, rawStop) - _orientArc(cache, rawVehicle);
    // Vehicle past the stop: only plausible if the reported arrival is in the
    // past (the vehicle has departed and the feed agrees). A future reported
    // arrival when the vehicle is already downstream is a clear feed/snap lag —
    // reject so we fall through to calc/blend instead of rendering "2 min" for
    // a train pulling out of the station. The 30 m tolerance covers the brief
    // snap overshoot just before STOPPED_AT fires on station approach.
    //
    // BUT only when the snap is fresh. A STALE snap that reads "past the stop"
    // while the feed correctly predicts a future arrival is the dominant
    // false-rejection mechanism: pooled live-accuracy data (n=207 over 4 runs)
    // showed this gate net-hurting ~2:1 when it substituted calc, concentrated
    // in the sparse-GPS off-peak run and on the long-segment BRT busways (G/J)
    // where fixes arrive ~17 s apart. When we can't trust the arc, trust the
    // feed — mirroring the upper-bound rule's existing freshness guard below.
    if (distMeters <= -30) {
        if (!snapIsFresh) return true;
        return gtfsEntry.arrivalUnix <= now + ETA_PLAUSIBILITY_GRACE_S;
    }
    if (distMeters <= 0) return true;     // at / just past stop — keep behavior

    const reported     = gtfsEntry.arrivalUnix - now;
    const minPlausible = distMeters / ETA_MAX_SPEED_MPS;

    // Lower-bound: feed cannot predict arrival faster than physics allows.
    if (reported < minPlausible - ETA_PLAUSIBILITY_GRACE_S) return false;

    // Upper-bound: when the vehicle is close to the stop AND moving, the feed
    // cannot predict an arrival much slower than (distance / current speed).
    // Catches the "marker at platform but GTFS still says 2 min" feed-lag case
    // where trip_updates' predicted_arrival_time hasn't been recomputed since
    // the last broadcast even though vehicle_position is fresh.
    //
    // Speed-source freshness: smoothedSpeed is written by markers.js on every
    // GPS update. If the marker hasn't been refreshed within the last
    // FRESH_LIVE_S window, the smoothed value is stale (vehicle could have
    // braked since); ignore it and fall back to the conservative floor.
    if (distMeters < ETA_PROXIMITY_OVERRIDE_M) {
        // Reuse the same snap-freshness signal computed above: a smoothedSpeed
        // sample is only trustworthy while the fix it rode in on is fresh (a
        // vehicle doing 15 m/s 60 s ago might have braked into a stop since).
        const speed = snapIsFresh
            ? Math.max(Number(marker.properties?.smoothedSpeed) || 0, ETA_MIN_APPROACH_SPEED_MPS)
            : ETA_MIN_APPROACH_SPEED_MPS;
        const maxPlausible = distMeters / speed;
        if (reported > maxPlausible + ETA_PLAUSIBILITY_GRACE_S) return false;
    }

    return true;
}

/**
 * Compute a schedule-derived ETA for a stop using static GTFS times.
 * @param {number} nextIdx  Index of the vehicle's next stop in cache.stops.
 * @param {number} targetIdx  Index of the stop we want an ETA for.
 * @param {number} directionId  0 or 1.
 * @returns {number|null} Unix timestamp (seconds) of predicted arrival, or null if unavailable.
 */
function computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, routeCode, directionId) {
    const { statusChangedAt } = marker.properties;

    if (nextIdx === targetIdx) {
        if (stopped) return now;
        const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
        // No motion evidence for the next-stop ETA (next stop is the origin idx
        // 0, or statusChangedAt missing) → null, NOT now. Returning `now` here
        // fabricated a "Now" pill on the station board while getSecondsToNextStop
        // (the vehicle popup) returned null for the same vehicle. null keeps both
        // surfaces consistent — calc is then absent; GTFS-RT still shows if present.
        return remaining != null ? now + remaining : null;
    }

    const gap = cache.times[targetIdx] - cache.times[nextIdx];
    if (gap < 0) return null;

    // Pad for unmodeled dwell at intermediate stops. Metro GTFS uses point-times
    // (arrival == departure) at non-timepoint stops, so schedule gaps contain no dwell.
    const intermediateStops = Math.max(0, targetIdx - nextIdx - 1);
    const dwellPad = intermediateStops * (isBusRoute(routeCode) ? ETA_INTERMEDIATE_DWELL_BUS_S : ETA_INTERMEDIATE_DWELL_S);

    if (stopped) return now + Math.max(0, gap + dwellPad);

    const remaining = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
    // remaining == null means we have no evidence the vehicle is in motion
    // (statusChangedAt missing, or the next stop is the trip origin). The
    // ETA_DEPARTURE_LAG_S correction belongs only on the with-evidence path —
    // applying it here would bias the prediction earlier with no justification.
    if (remaining == null) return now + Math.max(0, gap + dwellPad);
    return now + Math.max(0, remaining + gap + dwellPad);
}


/**
 * Return upcoming arrivals at a stop. Two-tier policy (PR #192 simplified the
 * older blend to a tier fallback after the 2026-05 sweep showed calc adds no
 * material signal once GTFS-RT is present):
 *   - Tier 1: GTFS-RT arrival, plausibility-checked against the vehicle's
 *     physical position (gtfsLooksPlausible).
 *   - Tier 2: GPS-corrected schedule ETA (computeScheduleEta tapered by
 *     computeTripAdherenceOffset) — used when Tier 1 is absent, stale, or
 *     fails the plausibility check.
 * Results are sorted ascending by ETA.
 *
 * @param {string|number} targetStopId
 * @returns {Array<{ routeId, directionId, vehicleId, tripId, arrivalUnix }>}
 */
export function getScheduledArrivals(targetStopId) {
    const sid = String(targetStopId);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    // Snapshot GTFS-RT predictions already known for this stop
    const gtfsList      = window.masterArrivalsData?.get(sid) ?? [];
    const gtfsByTripId  = new Map(gtfsList.map(a => [a.tripId, a]));
    const coveredTripIds = new Set();

    // sid is constant per call — cache targetIdx per route+dir to avoid repeated O(N) scans
    const targetIdxCache = {};

    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;

        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;

        // VEHICLE_MARKER_TTL_S (180s) is intentionally independent of the
        // FRESH_* visual tiers in markers.js — this is an algorithmic gate
        // (predictions can't trust a 180s-old position) and lives between
        // the `stale` (90s) and `expired` (300s) visual thresholds.
        if (now - ((marker._lastAcceptedTs ?? marker.timestamp) ?? 0) > VEHICLE_MARKER_TTL_S) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        // Route to EMIT on the row. Metro tags every J Line trip 910 in the
        // vehicle feed — including the 950 San Pedro through-runs — and
        // trip_updates ingest already corrects that (correctJLineRouteTag). This
        // loop was re-stamping the raw feed tag over the correction, so at a stop
        // both routes serve, a San Pedro bus landed on the Harbor Gateway row
        // while the 950 row rendered an em-dash. Scoped to the J pair exactly as
        // the ingest-side helper is; a general "trust static over the feed" rule
        // would be a much larger behaviour change.
        //
        // NOTE the cache lookups below deliberately keep using `route_code`: the
        // marker's arc/stop cache is keyed by the feed's tag. Only what we EMIT
        // changes.
        const emitRoute = (route_code === '910' || route_code === '950')
            && (tripMeta?.rc === '910' || tripMeta?.rc === '950')
            ? tripMeta.rc
            : route_code;
        // Without a known direction we can't reliably tell whether the target stop
        // is ahead of or behind the vehicle. Trying both dirs risks phantom ETAs
        // (e.g. a westbound train near the east terminus generates eastbound arrivals
        // for every station whose schedule index happens to be >= nextIdx in dir=0).
        // Vehicles with unknown direction can still surface via GTFS-RT entries
        // appended below, which carry their own arrivalUnix.
        if (preferredDir == null) continue;
        const dirs         = dirsToTry(preferredDir);

        for (const dir of dirs) {
            const cacheKey = `${route_code}|${dir}`;
            const cache = routeStops[cacheKey];
            if (!cache) continue;

            const stopped = isStoppedAt(marker?.properties?.currentStatus);

            const nextIdx = findIdx(cache.stops, vehicleNextStop);

            // sid is constant per call — memoize targetIdx per route+dir to avoid
            // repeated O(N) scans across all vehicles for the same cache.
            if (!(cacheKey in targetIdxCache)) targetIdxCache[cacheKey] = findIdx(cache.stops, sid);
            const targetIdx = targetIdxCache[cacheKey];
            if (nextIdx === -1 || targetIdx === -1) continue;
            if (targetIdx < nextIdx) {
                // This vehicle has already PASSED the target stop (its next stop is
                // beyond it). Mark the trip covered so the GTFS-only fallback loop
                // below doesn't re-append the trip's now-stale trip_updates entry —
                // otherwise the board shows a future arrival ("2 min") for a train
                // that demonstrably left, until the entry ages past the grace window.
                coveredTripIds.add(trip_id);
                continue;
            }

            // Trip-level schedule adherence: measure the vehicle's running offset
            // once and apply it (tapered) to all stops — next stop and all downstream
            // ETAs. The taper caps the offset at ADHERENCE_TAPER_K × remainingTime
            // so a 5-min-late train doesn't inflate its 30-s-away ETA to 5.5 min,
            // while downstream stops with larger remainingTime still express most
            // of the cascading lateness.
            const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);

            const schedEta = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, route_code, dir);
            let calcEta = null;
            if (schedEta != null) {
                calcEta = _applyTaperedOffset(schedEta, adherenceOffset, now);
            }

            // Tier 1 — GTFS-RT by tripId: prefer the GTFS-RT ETA, fall back to
            // calc. `_blendArrivals` is now a tier selector (gtfsEtaS ?? calcEtaS),
            // not a percentage blend — see its JSDoc for why calc adds no signal
            // once GTFS-RT is present.
            //
            // Plausibility check still falls back to calc when GTFS-RT contradicts
            // physical position. Staleness gate uses calc outright if GTFS-RT is stale.
            //
            // Origin-stop guard: a vehicle STOPPED_AT the first stop (nextIdx=0) is
            // sitting at the terminus doing a layover. We don't know when it departs,
            // so calc always underestimates (it uses travel time only, not dwell time).
            // Don't let calc override GTFS-RT in that case.
            const atOrigin = nextIdx === 0 && stopped;
            const calcEtaForBlend = atOrigin ? null : calcEta;
            // True when THIS vehicle is physically STOPPED_AT this target stop.
            // Lets the station board reserve "Now" for an arrived train, matching
            // the vehicle popup (which gates "Now" on STOPPED_AT). Without it the
            // board said "Now" off secAway<=0 while the popup said "<1m" for the
            // same train that had reached its predicted time but wasn't here yet.
            const atStop = stopped && nextIdx === targetIdx;

            const gtfsEntry = gtfsByTripId.get(trip_id);
            if (gtfsEntry) {
                const gtfsStale = now - (gtfsEntry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S;
                let arrivalUnix;
                // `source` records which tier actually produced arrivalUnix so
                // callers (getVehicleEtaSecs → the [RT]/[calc] debug tag) report
                // the true source instead of assuming GTFS-RT.
                let source;
                if (gtfsStale) {
                    arrivalUnix = calcEtaForBlend; source = 'calc';
                } else if (calcEtaForBlend != null && !gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now)) {
                    arrivalUnix = calcEtaForBlend; source = 'calc';
                } else if (calcEtaForBlend != null) {
                    const gtfsHorizon = gtfsEntry.arrivalUnix - now;
                    arrivalUnix = _blendArrivals(calcEtaForBlend, gtfsEntry.arrivalUnix, gtfsHorizon, now);
                    source = 'gtfs-rt';
                } else {
                    arrivalUnix = gtfsEntry.arrivalUnix; source = 'gtfs-rt';
                }
                // Mark covered regardless so the GTFS-only loop below never re-appends
                // a stale entry for a vehicle we already have a live position for.
                coveredTripIds.add(trip_id);
                if (arrivalUnix != null) {
                    // departureUnix rides along untouched by the blend: at a
                    // terminus arrival is when the train pulls IN to lay over and
                    // departure is when it pulls OUT, and only the pull-out is
                    // actionable for a rider on that platform. Omitting it made
                    // _withDeparture's `?? arrivalUnix` fallback — documented as a
                    // legacy safety net — the mainstream path for every tracked
                    // train, reintroducing the defect PR #617 fixed in the renderer.
                    results.push({
                        routeId: emitRoute, directionId: dir, vehicleId: vehicle_id, tripId: trip_id,
                        arrivalUnix, departureUnix: gtfsEntry?.departureUnix ?? null, source, atStop,
                    });
                }
                break;
            }

            // Tier 2 — no GTFS-RT match: use calc (suppressed for origin-stop vehicles)
            if (calcEtaForBlend == null) break;
            // …and suppressed for a stop the latest frame declared SKIPPED. This
            // tier fires precisely WHEN there is no GTFS-RT entry for the trip at
            // this stop, which is exactly what a SKIPPED declaration produces — so
            // without this check, dropping the entry at ingest actively ROUTED
            // every skipped stop into a confident calc arrival for any trip with a
            // live marker. The rider saw "4m" for a train running express past
            // their platform.
            if (isStopSkipped(trip_id, sid)) break;
            // Calc tier: no GTFS-RT entry exists, so there is no departure to
            // carry. Explicitly null rather than absent, so a dropped field can
            // never again masquerade as "this tier has no departure".
            results.push({
                routeId: emitRoute, directionId: dir, vehicleId: vehicle_id, tripId: trip_id,
                arrivalUnix: calcEtaForBlend, departureUnix: null, source: 'calc', atStop,
            });
            break;
        }
    }

    // Append GTFS-only entries — trains GTFS-RT sees that our vehicle-position
    // pipeline missed (e.g. vehicles turning around at end-of-line, or IDs that
    // didn't match any active marker).
    // Staleness gate (L-1): skip entries not refreshed within GTFS_ENTRY_STALENESS_S
    // to prevent zombie arrivals when the trip_updates feed hangs.
    for (const [tripId, entry] of gtfsByTripId) {
        if (coveredTripIds.has(tripId)) continue;
        // Use the shared past-arrival grace so trains still pulling out of a
        // station don't vanish from one popup refresh while the prune loop is
        // still keeping them in masterArrivalsData.
        if (entry.arrivalUnix < now - PAST_ARRIVAL_GRACE_S) continue;
        if (now - (entry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S) continue;
        results.push({ ...entry, source: 'gtfs-rt' });
    }

    results.sort((a, b) => a.arrivalUnix - b.arrivalUnix);

    // Keep only the 2 closest vehicles per route+direction
    const countPerDir = {};
    return results.filter(a => {
        const k = `${a.routeId}|${a.directionId}`;
        countPerDir[k] = (countPerDir[k] ?? 0) + 1;
        return countPerDir[k] <= 2;
    });
}

/**
 * Like getScheduledArrivals but returns { calcEta, gtfsEta } separately
 * so callers can compare the two sources. Used by the ETA accuracy test.
 * gtfsEta is null when no fresh GTFS-RT entry exists for that vehicle.
 */
export function getArrivalBreakdown(targetStopId) {
    const sid = String(targetStopId);
    const now = Math.floor(Date.now() / 1000);
    const results = [];

    const gtfsList     = window.masterArrivalsData?.get(sid) ?? [];
    const gtfsByTripId = new Map(gtfsList.map(a => [a.tripId, a]));
    const targetIdxCache = {};

    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;
        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;
        if (now - ((marker._lastAcceptedTs ?? marker.timestamp) ?? 0) > VEHICLE_MARKER_TTL_S) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        if (preferredDir == null) continue;

        for (const dir of dirsToTry(preferredDir)) {
            const cacheKey = `${route_code}|${dir}`;
            const cache = routeStops[cacheKey];
            if (!cache) continue;

            const stopped  = isStoppedAt(marker?.properties?.currentStatus);
            const nextIdx  = findIdx(cache.stops, vehicleNextStop);
            if (!(cacheKey in targetIdxCache)) targetIdxCache[cacheKey] = findIdx(cache.stops, sid);
            const targetIdx = targetIdxCache[cacheKey];
            if (nextIdx === -1 || targetIdx === -1 || targetIdx < nextIdx) continue;

            const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
            const schedEta        = computeScheduleEta(marker, cache, nextIdx, targetIdx, stopped, now, route_code, dir);
            // Production now applies the taper here as well — match exactly so
            // the harness measures user-visible ETAs, not a divergent calc value.
            let rawCalcEta = null;
            if (schedEta != null) {
                rawCalcEta = _applyTaperedOffset(schedEta, adherenceOffset, now);
            }
            // Suppress calc for origin-stop vehicles (same guard as getScheduledArrivals)
            const calcEta    = (nextIdx === 0 && stopped) ? null : rawCalcEta;

            const gtfsEntry = gtfsByTripId.get(trip_id);
            const gtfsEta   = (gtfsEntry && now - (gtfsEntry.lastIngestUnix ?? 0) <= GTFS_ENTRY_STALENESS_S)
                ? gtfsEntry.arrivalUnix
                : null;

            // Compute blendEta and record WHICH tier fired. Mirrors the
            // tier policy in getScheduledArrivals's _blendArrivals + its
            // upstream plausibility/staleness/origin-stop guards. The tier
            // string is captured per row so the live-accuracy harness can
            // measure per-tier MAE (especially "calc when it's the actual
            // displayed prediction"), not just aggregate blend MAE.
            let blendEta = null;
            let blendTier = null;     // 'gtfs' | 'calc' | 'gtfs-stale' | 'gtfs-implausible' | 'origin-suppressed' | 'no-data'
            if (gtfsEntry) {
                const gtfsAge = now - (gtfsEntry.lastIngestUnix ?? 0);
                const gtfsStale = gtfsAge > GTFS_ENTRY_STALENESS_S;
                if (gtfsStale) {
                    blendEta = calcEta;
                    blendTier = calcEta != null ? 'gtfs-stale' : 'no-data';
                } else if (calcEta != null && !gtfsLooksPlausible(marker, cache, targetIdx, gtfsEntry, now)) {
                    blendEta = calcEta;
                    blendTier = 'gtfs-implausible';
                } else if (calcEta != null) {
                    const gtfsHorizon = gtfsEntry.arrivalUnix - now;
                    blendEta = _blendArrivals(calcEta, gtfsEntry.arrivalUnix, gtfsHorizon, now);
                    // Under the simplified tier policy, _blendArrivals returns
                    // gtfsEta when present; that's the canonical "Tier 1" case.
                    blendTier = 'gtfs';
                } else {
                    // calc suppressed (origin-stop) but GTFS is fresh + plausible.
                    blendEta = gtfsEta;
                    blendTier = nextIdx === 0 && stopped ? 'origin-suppressed' : 'gtfs';
                }
            } else if (calcEta != null) {
                blendEta = calcEta;
                blendTier = 'calc';
            } else {
                blendEta = null;
                blendTier = 'no-data';
            }

            const gtfsAgeS = gtfsEntry ? (now - (gtfsEntry.lastIngestUnix ?? 0)) : null;

            // Taper diagnostics: was the raw offset larger than the cap that
            // calcEta actually applied? (True ⇒ taper limited adherence's effect.)
            const remainingTime = schedEta != null ? Math.max(0, schedEta - now) : 0;
            const maxOffset     = ADHERENCE_TAPER_K * remainingTime;
            const _wasCapped    = Math.abs(adherenceOffset) > maxOffset;

            results.push({
                routeId: route_code, directionId: dir, vehicleId: vehicle_id, tripId: trip_id,
                calcEta, gtfsEta, blendEta,
                // diagnostics — consumed by tests/eta-live-accuracy.js
                _intermediateStops: Math.max(0, targetIdx - nextIdx - 1),
                _adherenceOffsetS:  Math.round(adherenceOffset),
                _atOrigin:          nextIdx === 0 && stopped,
                _offsetCapped:      _wasCapped,
                _snapDeviationM:    marker.lastSnapDeviationM ?? null,
                _blendTier:         blendTier,
                _gtfsAgeS:          gtfsAgeS != null ? Math.round(gtfsAgeS) : null,
            });
            break;
        }
    }

    results.sort((a, b) => (a.calcEta ?? Infinity) - (b.calcEta ?? Infinity));
    return results;
}

/**
 * Return estimated seconds until the vehicle reaches its current next stop
 * from the static GTFS schedule. Returns 0 if STOPPED_AT, null if unknown.
 * @param {Object} marker Vehicle marker with properties
 * @returns {number|null}
 */
export function getSecondsToNextStop(marker) {
    const { trip_id, route_code, stopId, statusChangedAt, direction_id } = marker.properties ?? {};
    if (!trip_id || !route_code || !stopId) return null;

    // Feed says STOPPED_AT → the vehicle is at the stop, ETA is 0 ("Now").
    if (isStoppedAt(marker?.properties?.currentStatus)) return 0;

    const now = Math.floor(Date.now() / 1000);
    const tripMeta     = window.masterTripsData?.[trip_id];
    const preferredDir = tripMeta?.dir ?? (direction_id != null ? Number(direction_id) : null);
    // Mirror the safety guard in getScheduledArrivals (line 504): without a
    // known direction, dirsToTry would iterate both and the first cache hit
    // would win — risking a westbound train's "next stop" being computed
    // against the eastbound sequence. Return null instead of a wrong ETA.
    if (preferredDir == null) return null;
    const dirs         = dirsToTry(preferredDir);

    for (const dir of dirs) {
        const cache = routeStops[`${route_code}|${dir}`];
        if (!cache) continue;

        const nextIdx = findIdx(cache.stops, String(stopId));
        if (nextIdx === -1) continue;

        const raw = interStopRemainingSeconds(statusChangedAt, now, cache.times, nextIdx);
        if (raw == null) return null;
        const adherenceOffset = computeTripAdherenceOffset(marker, cache, nextIdx, now);
        // Use the same tapered offset as getScheduledArrivals — raw offset can be ±600 s
        // which would wildly inflate the "next stop" ETA displayed in the vehicle popup.
        const schedEta = now + raw;
        return Math.max(0, _applyTaperedOffset(schedEta, adherenceOffset, now) - now);
    }
    return null;
}

/**
 * Return the last stop ID in the scheduled stop sequence for a route+direction.
 * @param {string} routeCode
 * @param {number} directionId 0 or 1
 * @returns {string|null}
 */
export function getTerminalStopId(routeCode, directionId) {
    const cache = routeStops[`${routeCode}|${directionId}`];
    if (!cache?.stops?.length) return null;
    for (let i = cache.stops.length - 1; i >= 0; i--) {
        if (cache.stops[i]) return cache.stops[i];
    }
    return null;
}

/**
 * Return a cleaned display name for the terminal stop of a route+direction.
 * @param {string} routeCode
 * @param {number} directionId
 * @returns {string|null}
 */
export function getTerminalName(routeCode, directionId) {
    const override = TERMINUS_DISPLAY_OVERRIDES[`${routeCode}|${directionId}`];
    if (override) return override;
    const lastStopId = getTerminalStopId(routeCode, directionId);
    if (!lastStopId) return null;
    const stop = window.masterStopsData?.[String(lastStopId)];
    return stop?.name ? cleanStationName(stop.name) : null;
}

/**
 * Resolve a trip's destination label via the canonical cascade. Used by station
 * popup rows (stations.js) and vehicle popups (ui.js). Previously each module
 * implemented its own cascade with subtly different ordering — stations.js put
 * `getTerminalName` (schedule-derived, authoritative) first while ui.js put it
 * last, so the same trip could surface different labels depending on which
 * popup the rider opened. This helper is the one ordering both call sites use.
 *
 * Cascade:
 *   1a. SHORT-TURN: when the trip's own last stop differs from its route|dir
 *      terminus, the trip's last stop wins — a bus turning at Canoga must not
 *      advertise Chatsworth (25 % of westbound G Line trips do turn early).
 *      Deliberately gated on the two differing, so a full-length trip still
 *      falls through to 1b and keeps TERMINUS_DISPLAY_OVERRIDES (950|1's real
 *      last stop is a layover point, not "San Pedro").
 *   1b. Schedule-derived terminus (`getTerminalName`) — authoritative for a
 *      trip that runs the whole pattern, and folds in TERMINUS_DISPLAY_OVERRIDES.
 *   2. Live trip.dest, pre-cleaned by the caller via `cleanDestination`. The
 *      cleaning lives in ui.js to keep this helper pure (no cross-module dep
 *      cycle predictions.js → ui.js).
 *   3. Last stop in `tripInfo.stops` — name from `masterStopsData`.
 *   4. Live `tripTerminusByTripId` (trip_updates feed) — covers J Line variants
 *      and city buses folded into station groups that lack static trip data.
 *
 * Returns `null` when no source produces a name; callers supply their own
 * fallback (direction label, "Dir 0", etc.).
 *
 * @param {string}      routeCode
 * @param {number}      directionId       0 or 1
 * @param {string|null} tripId            optional, used for live-feed lookup
 * @param {object|null} tripInfo          masterTripsData entry, if any
 * @param {string|null} cleanedTripDest   `cleanDestination(tripInfo.dest)` pre-applied
 * @returns {string|null}
 */
export function resolveTripDestination(routeCode, directionId, tripId, tripInfo, cleanedTripDest) {
    // J Line feed mis-tag: Metro tags EVERY J trip 910 — even the 950 San Pedro
    // through-runs — in BOTH the vehicle-position and trip_update feeds. The
    // trip_updates side is corrected at ingestion (tripUpdates.correctJLineRouteTag),
    // so station-popup rows arrive here already carrying the true route. The
    // VEHICLE popup, though, resolves straight from the positions feed's raw
    // route_code, so a southbound 950 would render "Harbor Gateway TC" (the 910
    // terminus) for a bus sitting in San Pedro. Static GTFS knows the real route
    // (`tripInfo.rc`), so for the J pair prefer it — but only ADOPT the corrected
    // terminus when it actually resolves a name. Southbound it does (the 950|1
    // display override → "San Pedro"); northbound both routes share El Monte and
    // 950 has no distinct terminus, so we fall through to the feed route there.
    // Idempotent for the station path (trueRc === routeCode → skipped).
    const trueRc = tripInfo?.rc;
    const jPairCorrected = (routeCode === '910' || routeCode === '950') &&
        (trueRc === '910' || trueRc === '950') && trueRc !== routeCode &&
        getTerminalName(trueRc, directionId) ? trueRc : null;
    // The route this trip's PATTERN belongs to — the J-corrected one where that
    // applies, otherwise the feed's own tag. Everything below compares against
    // this so a mis-tagged 950 is measured against 950's terminus, not 910's.
    const patternRc = jPairCorrected ?? routeCode;

    // SHORT-TURN. `getTerminalName` is route-level: it answers "where does this
    // route|dir end", which is the wrong question for a trip that ends early.
    // Measured on committed data, 88 of 350 westbound G Line trips (25 %) turn
    // at Canoga, three stops short of Chatsworth — and every one of them
    // rendered "Chatsworth" in both the station row and the vehicle popup, so a
    // rider could board for a stop the bus never reaches. The trip's real last
    // stop was already in masterTripsData and simply never consulted.
    //
    // Only fires when the trip genuinely ends somewhere else. A trip that runs
    // the full pattern falls through to getTerminalName below, which is what
    // keeps TERMINUS_DISPLAY_OVERRIDES working — 950|1's real last stop is
    // "Pacific / 21st Layover", a yard move no rider recognises, and the
    // override is the only thing that turns it into "San Pedro".
    const routeLastStopId = getTerminalStopId(patternRc, directionId);
    const tripLastStopId  = tripInfo?.stops ? [...tripInfo.stops].reverse().find(s => s) : null;
    if (tripLastStopId && routeLastStopId && String(tripLastStopId) !== String(routeLastStopId)) {
        const shortTurnStop = window.masterStopsData?.[String(tripLastStopId)];
        if (shortTurnStop?.name) return cleanStationName(shortTurnStop.name);
    }

    if (jPairCorrected) {
        const corrected = getTerminalName(jPairCorrected, directionId);
        if (corrected) return corrected;
    }
    const structural = getTerminalName(routeCode, directionId);
    if (structural) return structural;
    if (cleanedTripDest) return cleanedTripDest;
    if (tripInfo?.stops) {
        const lastStopId = [...tripInfo.stops].reverse().find(s => s);
        const stop = lastStopId ? window.masterStopsData?.[String(lastStopId)] : null;
        if (stop?.name) return cleanStationName(stop.name);
    }
    if (tripId) {
        const liveTermStopId = tripTerminusByTripId.get(String(tripId));
        const stop = liveTermStopId ? window.masterStopsData?.[String(liveTermStopId)] : null;
        if (stop?.name) return cleanStationName(stop.name);
    }
    return null;
}

/**
 * Rider-facing BUS destination from the static `data/bus-destinations.json` map
 * (`window.masterBusDestinations`). Returns Metro's headsign `destination_code`
 * ("Santa Monica", "Vermont / Athens Station") — what's printed on the bus —
 * rather than the live-feed terminus stop name (often an obscure intersection).
 *
 * Resolution order (see the build-script header for why):
 *   1. byTrip[tripId]              — exact, covers branch / short-turn trips
 *   2. byRouteDir[`route|dir`]     — the dominant destination for that direction
 *   3. null                        — caller falls back to the live terminus stop
 *
 * @param {string|number|null} tripId
 * @param {string|number|null} routeCode
 * @param {number|null}        directionId  0 or 1 (null = unknown)
 * @returns {string|null}
 */
export function resolveBusDestination(tripId, routeCode, directionId) {
    const m = window.masterBusDestinations;
    if (!m || !Array.isArray(m.dests)) return null;
    let idx;
    if (tripId != null && m.byTrip) {
        const v = m.byTrip[String(tripId)];
        if (v != null) idx = v;
    }
    if (idx == null && routeCode != null && directionId != null && m.byRouteDir) {
        const v = m.byRouteDir[`${routeCode}|${directionId}`];
        if (v != null) idx = v;
    }
    return idx != null ? (m.dests[idx] ?? null) : null;
}

/**
 * Returns true if any of the given stop IDs is the first stop of routeCode|dir.
 * @param {string[]} stopIds
 * @param {string} routeCode
 * @param {number} dir
 * @returns {boolean}
 */
export function isOriginStop(stopIds, routeCode, dir) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    return stopIds.some(sid => findIdx(cache.stops, sid) === 0);
}

/**
 * Returns true when this vehicle is STOPPED_AT the origin (idx=0) of its own
 * route+direction. Route-aware: a K Line train at Expo/Crenshaw is at origin,
 * but an E Line train at the same station is mid-route and not suppressed.
 * @param {Object} props Marker properties
 * @returns {boolean}
 */
export function isAtOwnOriginStop(props) {
    if (!props || !isStoppedAt(props.currentStatus)) return false;
    const { route_code, stopId, trip_id } = props;
    if (!route_code || !stopId) return false;
    const tripMeta     = window.masterTripsData?.[trip_id];
    const preferredDir = tripMeta?.dir ?? props.direction_id;
    if (preferredDir == null) return false;
    const cache = routeStops[`${route_code}|${preferredDir}`];
    if (!cache?.stops?.length) return false;
    return findIdx(cache.stops, String(stopId)) === 0;
}

/**
 * Return all (stopId, routeCode, dir) tuples where stopId is the origin (idx=0)
 * of that route+direction. Used by stations.js to render boarding badges.
 * @returns {Array<{ stopId: string, routeCode: string, dir: number }>}
 */
export function getAllOriginStops() {
    const result = [];
    for (const [key, cache] of Object.entries(routeStops)) {
        const [routeCode, dirStr] = key.split('|');
        const originStopId = cache.stops?.[0];
        if (originStopId) result.push({ stopId: String(originStopId), routeCode, dir: Number(dirStr) });
    }
    return result;
}

/**
 * Returns true if any of the given stop IDs is the last stop of routeCode|dir.
 * @param {string[]} stopIds
 * @param {string} routeCode
 * @param {number} dir
 * @returns {boolean}
 */
export function isTerminalStop(stopIds, routeCode, dir) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    const lastIdx = cache.stops.length - 1;
    return stopIds.some(sid => findIdx(cache.stops, sid) === lastIdx);
}

/**
 * Returns true if any of the given stop IDs falls within the last `n` stops
 * of routeCode|dir (not counting the terminal itself, which isTerminalStop handles).
 * Used to suppress empty "destination = San Pedro" rows at stops that are already
 * physically within the destination area.
 * @param {string[]} stopIds
 * @param {string} routeCode
 * @param {number} dir
 * @param {number} [n=1]  number of stops before the terminal to suppress
 * @returns {boolean}
 */
export function isNearTerminalStop(stopIds, routeCode, dir, n = 1) {
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return false;
    const lastIdx = cache.stops.length - 1;
    return stopIds.some(sid => {
        const idx = findIdx(cache.stops, sid);
        return idx >= 0 && idx >= lastIdx - n && idx < lastIdx;
    });
}

/**
 * Return vehicles boarding at the origin terminus for any of the given stop IDs.
 * Combines two sources:
 *   1. Active markers STOPPED_AT origin (live VP feed)
 *   2. Fresh GTFS-RT trip_updates entries at origin with no covering marker
 *      (bridges the layover gap when the VP feed is silent)
 * Each entry includes departureUnix when known (from trip_updates).
 *
 * **Staleness asymmetry between tiers (intentional):** Tier 1 uses
 * VEHICLE_MARKER_TTL_S (180s); Tier 2 uses GTFS_ENTRY_STALENESS_S (90s). The
 * 90s gap is a feature: if the VP feed dies but trip_updates stays fresh, a
 * Tier-2 boarding badge appears for up to 90s without a corresponding marker.
 * This is the "layover gap bridge" and is the whole point of Tier 2 — riders
 * still see "next train at 12:34" while the VP feed is silent. The downside
 * is a brief window where a badge can claim a departure that no longer has a
 * vehicle on the way; deemed acceptable because trip_updates is authoritative
 * for scheduled service and stales out within 90s anyway.
 *
 * @param {string[]} stopIds
 * @returns {Array<{ routeCode, directionId, vehicleId, tripId, departureUnix }>}
 */
/**
 * Soonest known DEPARTURE from an origin stop for one route+direction, with no
 * boarding horizon.
 *
 * `getBoardingVehicles` deliberately answers a narrower question — "is a train
 * physically sitting here to board?" — and caps at `BOARDING_MAX_HORIZON_S`
 * (10 min). That cap is right for the boarding semantics but it left the
 * terminus badge rendering an em-dash whenever the next departure was any
 * further out, which at off-peak headways is most of the time. An em-dash
 * should mean "nothing known", not "nothing within ten minutes".
 *
 * Same filters as that function's GTFS-only tier — freshness, past-grace
 * measured on the LATER of arrival/departure (a train laying over has an
 * arrival in the past and a pull-out still ahead), and a route-aware check that
 * this stop really is index 0 for the route+direction — minus the horizon.
 *
 * Returns the DEPARTURE (pull-out), not the arrival: at a terminus the two
 * genuinely differ and only the pull-out is actionable for someone standing on
 * the platform.
 *
 * @param {string} stopId
 * @param {string} routeCode
 * @param {number} dir
 * @param {number} now unix seconds
 * @returns {number|null} soonest departureUnix, or null if nothing is known.
 */
export function getNextOriginDeparture(stopId, routeCode, dir, now) {
    const sid = String(stopId);
    const cache = routeStops[`${routeCode}|${dir}`];
    if (!cache?.stops?.length) return null;
    if (findIdx(cache.stops, sid) !== 0) return null;

    let soonest = null;
    for (const entry of window.masterArrivalsData?.get(sid) ?? []) {
        if (!entry?.tripId) continue;
        if (now - (entry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S) continue;
        const departureUnix = entry.departureUnix ?? entry.arrivalUnix;
        if (!Number.isFinite(departureUnix)) continue;
        const livenessUnix = Math.max(entry.arrivalUnix, departureUnix);
        if (livenessUnix < now - PAST_ARRIVAL_GRACE_S) continue;

        const tripMeta = window.masterTripsData?.[entry.tripId];
        if (!tripMeta) continue;
        if (String(tripMeta.rc ?? entry.routeId ?? '') !== String(routeCode)) continue;
        if ((tripMeta.dir ?? entry.directionId) !== dir) continue;

        if (soonest == null || departureUnix < soonest) soonest = departureUnix;
    }
    return soonest;
}

export function getBoardingVehicles(stopIds) {
    const now = Math.floor(Date.now() / 1000);
    const results = [];
    const seenTripIds = new Set();
    const stopIdSet = new Set(stopIds.map(String));

    // Tier 1: active markers STOPPED_AT origin
    for (const marker of Object.values(window.vehicleMarkers ?? {})) {
        const { vehicle_id, trip_id, route_code } = marker.properties ?? {};
        if (!trip_id || !route_code) continue;
        const vehicleNextStop = marker.properties.stopId;
        if (!vehicleNextStop) continue;
        if (now - ((marker._lastAcceptedTs ?? marker.timestamp) ?? 0) > VEHICLE_MARKER_TTL_S) continue;

        if (!isStoppedAt(marker?.properties?.currentStatus)) continue;

        const tripMeta     = window.masterTripsData?.[trip_id];
        const preferredDir = tripMeta?.dir ?? marker.properties.direction_id;
        // Unknown direction → skip Tier 1 (mirrors getScheduledArrivals /
        // getSecondsToNextStop). At a shared terminal that is stop idx 0 of BOTH
        // direction caches, trying both dirs would report a dir-1-finishing
        // vehicle as boarding dir 0 — a wrong-direction boarding badge, which is
        // rider-safety-relevant. Such vehicles still surface via Tier 2 (GTFS-RT).
        if (preferredDir == null) continue;
        const dirs         = dirsToTry(preferredDir);

        for (const dir of dirs) {
            const cache = routeStops[`${route_code}|${dir}`];
            if (!cache) continue;
            const nextIdx = findIdx(cache.stops, vehicleNextStop);
            if (nextIdx !== 0) continue;
            if (!stopIds.some(sid => findIdx(cache.stops, sid) === 0)) continue;

            // Look up the scheduled DEPARTURE (pull-out) from GTFS-RT trip_updates.
            // At a first/layover stop arrival is the layover-arrival (often already
            // past) while departure is when the train actually leaves — that's the
            // meaningful "Departs" time for a boarding badge. Ingest stores
            // departureUnix (= departure ?? arrival) for exactly this consumer; the
            // `?? arrivalUnix` guard only covers legacy/cross-midnight-preserved
            // entries predating the field. Reading arrivalUnix here rendered
            // "Departs Now" for the whole dwell.
            const gtfsList  = window.masterArrivalsData?.get(String(vehicleNextStop)) ?? [];
            const gtfsEntry = gtfsList.find(e => e.tripId === trip_id);
            const departureUnix = gtfsEntry && now - (gtfsEntry.lastIngestUnix ?? 0) <= GTFS_ENTRY_STALENESS_S
                ? (gtfsEntry.departureUnix ?? gtfsEntry.arrivalUnix)
                : null;

            seenTripIds.add(trip_id);
            results.push({
                routeId: route_code, directionId: dir,
                vehicleId: vehicle_id, tripId: trip_id,
                stopId: String(vehicleNextStop), departureUnix,
            });
            break;
        }
    }

    // Tier 2: GTFS-only trip_updates at origin stops (bridges VP layover gap).
    // For each requested stopId that is an origin for some route+dir, find fresh
    // trip_updates entries for that origin whose tripId is not already covered.
    // Only include trains likely physically dwelling — departure within 10 min.
    // Scheduled-but-not-yet-here trains (departing in 25+ min) are filtered out;
    // they'll show up as normal arrivals at upstream stops, not as "boarding".
    for (const sid of stopIdSet) {
        const gtfsList = window.masterArrivalsData?.get(sid) ?? [];
        for (const entry of gtfsList) {
            if (!entry?.tripId) continue;
            if (seenTripIds.has(entry.tripId)) continue;
            if (now - (entry.lastIngestUnix ?? 0) > GTFS_ENTRY_STALENESS_S) continue;
            // Allow entries from now onward (train still dwelling) up to BOARDING_MAX_HORIZON_S.
            // Past-grace uses the LATER of arrival/departure (matching the ingest-side
            // livenessUnix) so a train whose arrival is minutes past but whose pull-out
            // is still ahead keeps its boarding badge for the whole layover instead of
            // vanishing 60 s after arrival. The future horizon stays arrival-based —
            // a train arriving 25+ min out isn't "boarding now".
            const livenessUnix = Math.max(entry.arrivalUnix, entry.departureUnix ?? entry.arrivalUnix);
            if (livenessUnix < now - PAST_ARRIVAL_GRACE_S) continue;
            if (entry.arrivalUnix - now > BOARDING_MAX_HORIZON_S) continue;

            const tripMeta = window.masterTripsData?.[entry.tripId];
            if (!tripMeta) continue;
            const routeCode = String(tripMeta.rc ?? entry.routeId ?? '');
            const dir       = tripMeta.dir ?? entry.directionId;
            if (!routeCode || dir == null) continue;

            // Verify this stopId is actually idx=0 for this route+dir (route-aware).
            const cache = routeStops[`${routeCode}|${dir}`];
            if (!cache?.stops?.length) continue;
            if (findIdx(cache.stops, sid) !== 0) continue;

            seenTripIds.add(entry.tripId);
            results.push({
                routeId: routeCode, directionId: dir,
                vehicleId: entry.vehicleId ?? null, tripId: entry.tripId,
                stopId: sid, departureUnix: entry.departureUnix ?? entry.arrivalUnix,
                gtfsOnly: true,
            });
        }
    }

    return results;
}
