/**
 * @module phase5State
 *
 * Module-singleton holders for the trajectory-model store and dwell learner.
 * Both objects must be reachable from every consumer module (api.js,
 * tripUpdates.js, markers.js, predictions.js) so they share one source of
 * truth across the entire trajectory pipeline.
 *
 * Why a dedicated module and not `window.*`?
 *   CLAUDE.md's cross-module globals table flags `window.*` additions as
 *   requiring explicit justification and notes the direction is to *remove*
 *   mirrors, not add them. ES module imports give us the same shared-singleton
 *   semantics without the global namespace, and they're greppable.
 *
 * Why a dedicated module and not `js/main.js`?
 *   `main.js` already imports from api.js + markers.js + predictions.js +
 *   tripUpdates.js. If those modules imported the singletons from main.js, we
 *   would get a circular dependency at module evaluation time. A standalone
 *   module breaks the cycle and keeps the dependency tree DAG-shaped.
 *
 * This file is **eagerly imported by main.js** so the singletons construct
 * during app boot. The first localStorage read (DwellModel._load) happens
 * synchronously inside the DwellModel constructor — fine for a 30-day-ttl
 * key with at most a few hundred entries.
 *
 * Today (USE_TRAJECTORY_MODEL=false in config.js) these singletons are
 * **dormant**: no production code path writes to or reads from them. Phase 5.2
 * onward wires them into api.js / tripUpdates.js / markers.js / predictions.js
 * behind the same flag.
 */

import { VehicleStateStore } from './vehicleState.js';
import { DwellModel } from './dwellModel.js';

/**
 * Per-vehicle kinematic state container.
 *
 * Keyed by **tripId** (not vehicleId) to mirror the legacy `markers[]`
 * keying so the parallel state-store + MapLibre-marker structures stay
 * in lockstep through terminus turnarounds. Trade-off: when a single
 * physical vehicle starts a new trip, its kinematic history doesn't
 * transfer — there will briefly be two state entries (one decaying, one
 * fresh). This matches today's behavior; the same fade-out runs on the
 * marker side via `_fadeOutAndRemove`.
 *
 * Metro frequently omits `vehicle.id` from the GTFS-RT frame but always
 * sends `trip.tripId`, so tripId is also the more reliable key in practice.
 *
 * @type {VehicleStateStore}
 */
export const vehicleStateStore = new VehicleStateStore({ keyFn: s => s.tripId });

/**
 * Per-(stopId, routeId, directionId) dwell-duration learner.
 *
 * Persisted to localStorage under `metro-livemap.dwellV1`. Entries time
 * out after 7 days (see `DwellModel.maxAgeMs`), so a rider returning after
 * a long absence falls back to the per-mode default rather than acting on
 * stale data from a schedule that may have changed.
 *
 * Not seeded from GTFS today — `data/trips.json` carries a single time per
 * stop (arrival only) so we can't derive dwell from the schedule. The model
 * learns purely online from STOPPED_AT durations once Phase 5.2 wires up
 * `applyStoppedAt`.
 *
 * @type {DwellModel}
 */
export const dwellModel = new DwellModel({ storageKey: 'metro-livemap.dwellV1' });
