export {}; // makes this file a valid ES module — run via: import('/tests/eta-live-accuracy.js')

/**
 * ETA Three-Way Accuracy Test (v4 — tighter vehicle locking, VP-timestamp anchor, snapshot hygiene)
 * ---------------------------------------------------------------------------------------------------
 * Run in the browser console on the running livemap (localhost:3000):
 *   import('/tests/eta-live-accuracy.js')
 *
 * Improvements over v3:
 *   - predKey includes tripId: `vehicle:trip:stop` — prevents wrong-vehicle matching on infrequent
 *     lines (B/C/K) where stop-based arrival detection could match a different train on the same
 *     route. An old (vehicle, stop) entry is abandoned when the vehicle gets a new tripId.
 *   - Prediction lookup is vehicleId-only (no `|| tripId` fallback) — eliminates the case where
 *     a different vehicle's prediction gets attached to the wrong entry via a shared tripId.
 *   - Snapshot tripId stored; on arrival, snapshots with a different tripId are discarded —
 *     catches mid-approach trip reassignments (rare but real on turnaround stations).
 *   - Snapshots with horizonGtfs < 0 are discarded at push time — stale GTFS predictions that
 *     had already "passed" slip through only on the GTFS column and skew gtfsErr negative.
 *   - actualUnix uses marker.timestamp (VP feed timestamp) not wall clock — removes the
 *     10–30 s systematic bias introduced by the poll detection lag at close range.
 *
 * Error sign convention:
 *   error = actualUnix - predictedEta
 *   Negative = arrived EARLIER than predicted (pessimistic prediction)
 *   Positive = arrived LATER   than predicted (optimistic prediction)
 */
(async () => {
    const DURATION_MIN        = 60;
    const POLL_MS             = 2000;
    const SNAPSHOT_INTERVAL_S = 15;    // seconds between prediction snapshots per (vehicle, trip, stop)
    const MIN_HORIZON_S       = 10;    // ignore predictions < 10 s out (terminus/near-arrival noise)
    const MAX_HORIZON_S       = 600;   // ignore predictions > 10 min out
    const EXCLUDE_ROUTES      = new Set(['805']); // D Line pre-revenue extension skews results

    const ROUTE_NAMES = {
        '801': 'A Line', '802': 'B Line', '803': 'C Line',
        '804': 'E Line', '805': 'D Line', '807': 'K Line',
        '901': 'G Line', '910': 'J Line', '950': 'J Line (exp)',
    };
    const RAIL_ROUTES = new Set(['801','802','803','804','807']);
    const BUS_ROUTES  = new Set(['901','910','950']);

    let getArrivalBreakdown;
    try {
        ({ getArrivalBreakdown } = await import('/js/predictions.js'));
    } catch (e) {
        console.error('[eta-test] Could not import predictions.js — make sure you are on localhost:3000', e);
        return;
    }

    // predKey = `${vehicle_id}:${trip_id}:${stopId}` — tripId prevents wrong-vehicle cross-match
    const pending = new Map();
    const arrived = new Set();
    const results = [];
    const start   = Date.now();

    console.log(`[eta-test v4] Started — ${DURATION_MIN} min, snapshot every ${SNAPSHOT_INTERVAL_S}s, horizon ${MIN_HORIZON_S}–${MAX_HORIZON_S}s. Call window.__etaTestStop() to stop early.`);

    function tick() {
        if (Date.now() - start >= DURATION_MIN * 60 * 1000) {
            clearInterval(timer);
            report();
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const seenPredKeys = new Set();

        for (const marker of Object.values(window.vehicleMarkers ?? {})) {
            const { vehicle_id, trip_id, stopId, currentStatus, route_code } = marker.properties ?? {};
            if (!vehicle_id || !stopId || !trip_id) continue;
            if (EXCLUDE_ROUTES.has(route_code)) continue;

            // predKey now locks to the specific (vehicle, trip, stop) tuple
            const predKey = `${vehicle_id}:${trip_id}:${stopId}`;
            seenPredKeys.add(predKey);
            const stopped = currentStatus === 'STOPPED_AT' || currentStatus === 1;

            // ── Arrival via STOPPED_AT ──
            if (stopped && pending.has(predKey) && !arrived.has(predKey)) {
                recordArrival(predKey, marker.timestamp ?? now, trip_id);
                continue;
            }
            if (stopped) continue;

            // ── Snapshot while approaching ──
            let entry = pending.get(predKey);
            if (!entry) {
                entry = { targetStopId: String(stopId), vehicleId: vehicle_id, tripId: trip_id, routeId: route_code, snapshots: [] };
                pending.set(predKey, entry);
            }
            const lastSnap = entry.snapshots[entry.snapshots.length - 1];
            if (lastSnap && now - lastSnap.recordedAt < SNAPSHOT_INTERVAL_S) continue;

            const breakdown = getArrivalBreakdown(String(stopId));
            // Match by vehicleId first, fall back to tripId for GTFS-only entries that lack vehicleId.
            // Wrong-vehicle cross-matching is already prevented by the tripId-locked predKey above.
            const found = breakdown.find(a => a.vehicleId === vehicle_id || a.tripId === trip_id);
            if (!found) continue;

            const horizonCalc = found.calcEta != null ? found.calcEta - now : null;
            const horizonGtfs = found.gtfsEta != null ? found.gtfsEta - now : null;
            const horizon     = horizonCalc ?? horizonGtfs;
            if (horizon == null || horizon < MIN_HORIZON_S || horizon > MAX_HORIZON_S) continue;

            // Discard snapshots where GTFS horizon is negative (stale prediction already past)
            if (horizonGtfs != null && horizonGtfs < 0) continue;

            entry.routeId = found.routeId ?? entry.routeId;
            // Store tripId per snapshot so we can discard if the vehicle was reassigned mid-approach
            entry.snapshots.push({ recordedAt: now, tripId: trip_id, calcEta: found.calcEta, gtfsEta: found.gtfsEta, horizonCalc, horizonGtfs });
        }

        // ── Arrival via stopId advance ──
        // Only fire when the vehicle marker still EXISTS with a different stopId.
        // If the marker vanished entirely (TTL expiry) we cannot confirm arrival — drop it.
        for (const [predKey, entry] of pending) {
            if (arrived.has(predKey)) continue;
            if (seenPredKeys.has(predKey)) continue;

            const marker = window.vehicleMarkers?.[entry.vehicleId];
            if (!marker) {
                // Marker gone — TTL expiry, not a confirmed arrival. Abandon silently.
                arrived.add(predKey);
                continue;
            }
            // Marker alive but stopId (or tripId) changed → reached the tracked stop and moved on.
            // Use the VP feed timestamp as the arrival anchor (not wall clock).
            recordArrival(predKey, marker.timestamp ?? now, marker.properties?.trip_id);
        }
    }

    function recordArrival(predKey, actualUnix, arrivingTripId) {
        if (arrived.has(predKey)) return;
        const entry = pending.get(predKey);
        if (!entry || entry.snapshots.length === 0) { arrived.add(predKey); return; }
        arrived.add(predKey);

        // Filter out snapshots where the tripId had already changed (vehicle reassigned mid-approach).
        // arrivingTripId may differ from entry.tripId on stopId-advance (turnaround started new trip);
        // in that case we keep snapshots locked to entry.tripId and use the last VP timestamp as actualUnix.
        const cleanSnapshots = entry.snapshots.filter(s => s.tripId === entry.tripId);
        if (!cleanSnapshots.length) return;

        results.push({
            vehicleId: entry.vehicleId, tripId: entry.tripId,
            stopId: entry.targetStopId, routeId: entry.routeId,
            actualUnix, snapshots: cleanSnapshots,
        });
    }

    // ── Stats helpers ──
    function median(sorted) {
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    function stats(values) {
        const v = values.filter(x => x != null);
        if (!v.length) return null;
        const abs    = v.map(Math.abs);
        const mean   = v.reduce((a, b) => a + b, 0) / v.length;
        const mae    = abs.reduce((a, b) => a + b, 0) / abs.length;
        const rmse   = Math.sqrt(abs.map(e => e * e).reduce((a, b) => a + b, 0) / abs.length);
        const med    = median([...abs].sort((a, b) => a - b));
        const w30    = abs.filter(e => e <= 30).length / abs.length * 100;
        const w60    = abs.filter(e => e <= 60).length / abs.length * 100;
        return {
            n:         v.length,
            mean:      +mean.toFixed(1),
            median:    +med.toFixed(1),
            mae:       +mae.toFixed(1),
            rmse:      +rmse.toFixed(1),
            within30s: `${w30.toFixed(0)}%`,
            within60s: `${w60.toFixed(0)}%`,
        };
    }

    function flattenSnapshots(subset) {
        const flat = [];
        for (const r of subset) {
            for (const s of r.snapshots) {
                flat.push({
                    routeId:     r.routeId,
                    horizonCalc: s.horizonCalc,
                    horizonGtfs: s.horizonGtfs,
                    calcErr:     s.calcEta != null ? r.actualUnix - s.calcEta : null,
                    gtfsErr:     s.gtfsEta != null ? r.actualUnix - s.gtfsEta : null,
                });
            }
        }
        return flat;
    }

    function reportSection(label, subset) {
        const flat = flattenSnapshots(subset);
        if (!flat.length) return;

        const calcSnaps = flat.filter(f => f.calcErr != null).length;
        const gtfsSnaps = flat.filter(f => f.gtfsErr != null).length;
        const arrivalsWithGtfs = subset.filter(r => r.snapshots.some(s => s.gtfsEta != null)).length;

        console.log(`\n${'═'.repeat(56)}`);
        console.log(`  ${label}  —  ${subset.length} arrivals  |  ${flat.length} snapshots`);
        console.log(`${'═'.repeat(56)}`);
        console.log(`  GTFS-RT coverage: ${arrivalsWithGtfs}/${subset.length} arrivals (${(arrivalsWithGtfs / subset.length * 100).toFixed(0)}%)`);
        console.log(`  Snapshots — calc: ${calcSnaps}, GTFS-RT: ${gtfsSnaps}, avg/arrival: ${(flat.length / subset.length).toFixed(1)}`);

        const buckets = [
            { label: '< 30 s',   min: 0,   max: 30  },
            { label: '30–60 s',  min: 30,  max: 60  },
            { label: '1–2 min',  min: 60,  max: 120 },
            { label: '2–5 min',  min: 120, max: 300 },
            { label: '5–10 min', min: 300, max: 600 },
        ];

        console.log('\n  Calc ETA accuracy by horizon:');
        const calcRows = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonCalc != null && f.horizonCalc >= b.min && f.horizonCalc < b.max);
            calcRows[b.label] = stats(g.map(f => f.calcErr)) ?? { n: 0 };
        }
        calcRows['ALL'] = stats(flat.map(f => f.calcErr)) ?? { n: 0 };
        console.table(calcRows);

        console.log('\n  GTFS-RT ETA accuracy by horizon:');
        const gtfsRows = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonGtfs != null && f.horizonGtfs >= b.min && f.horizonGtfs < b.max);
            gtfsRows[b.label] = stats(g.map(f => f.gtfsErr)) ?? { n: 0 };
        }
        gtfsRows['ALL'] = stats(flat.map(f => f.gtfsErr)) ?? { n: 0 };
        console.table(gtfsRows);

        const both = flat.filter(f => f.calcErr != null && f.gtfsErr != null);
        if (both.length) {
            console.log('\n  Head-to-head (snapshots with BOTH sources):');
            console.table({ Calc: stats(both.map(f => f.calcErr)), 'GTFS-RT': stats(both.map(f => f.gtfsErr)) });
            const calcWins = both.filter(f => Math.abs(f.calcErr) < Math.abs(f.gtfsErr)).length;
            const gtfsWins = both.filter(f => Math.abs(f.gtfsErr) < Math.abs(f.calcErr)).length;
            console.log(`  Calc closer: ${calcWins}  |  GTFS-RT closer: ${gtfsWins}  |  Tie: ${both.length - calcWins - gtfsWins}`);
        }

        // Convergence
        const conv = subset
            .filter(r => r.snapshots.length >= 2)
            .map(r => {
                const first = r.snapshots[0];
                const last  = r.snapshots[r.snapshots.length - 1];
                return {
                    firstCalcErr: first.calcEta != null ? r.actualUnix - first.calcEta : null,
                    lastCalcErr:  last.calcEta  != null ? r.actualUnix - last.calcEta  : null,
                    firstGtfsErr: first.gtfsEta != null ? r.actualUnix - first.gtfsEta : null,
                    lastGtfsErr:  last.gtfsEta  != null ? r.actualUnix - last.gtfsEta  : null,
                };
            });
        if (conv.length) {
            console.log('\n  Convergence (first vs last snapshot per arrival):');
            console.table({
                'Calc — first':    stats(conv.map(c => c.firstCalcErr)),
                'Calc — last':     stats(conv.map(c => c.lastCalcErr)),
                'GTFS-RT — first': stats(conv.map(c => c.firstGtfsErr)),
                'GTFS-RT — last':  stats(conv.map(c => c.lastGtfsErr)),
            });
        }

        // Per-line within this section
        const lines = [...new Set(flat.map(f => f.routeId).filter(Boolean))].sort();
        if (lines.length > 1) {
            console.log('\n  By line:');
            const lineRows = {};
            for (const rc of lines) {
                const g = flat.filter(f => f.routeId === rc);
                const label = ROUTE_NAMES[rc] ?? rc;
                const cs = stats(g.map(f => f.calcErr));
                const gs = stats(g.map(f => f.gtfsErr));
                if (cs) lineRows[`${label} — Calc`]    = cs;
                if (gs) lineRows[`${label} — GTFS-RT`] = gs;
            }
            console.table(lineRows);
        }

        // Worst snapshots
        const worst = flat
            .filter(f => Math.abs(f.calcErr ?? 0) > 90 || Math.abs(f.gtfsErr ?? 0) > 90)
            .sort((a, b) => Math.max(Math.abs(b.calcErr ?? 0), Math.abs(b.gtfsErr ?? 0))
                          - Math.max(Math.abs(a.calcErr ?? 0), Math.abs(a.gtfsErr ?? 0)))
            .slice(0, 10)
            .map(f => ({
                line:      ROUTE_NAMES[f.routeId] ?? f.routeId,
                horizCalc: f.horizonCalc != null ? +f.horizonCalc.toFixed(0) : null,
                horizGtfs: f.horizonGtfs != null ? +f.horizonGtfs.toFixed(0) : null,
                calcErr:   f.calcErr != null ? +f.calcErr.toFixed(0) : null,
                gtfsErr:   f.gtfsErr != null ? +f.gtfsErr.toFixed(0) : null,
                winner:    f.calcErr != null && f.gtfsErr != null
                    ? (Math.abs(f.calcErr) < Math.abs(f.gtfsErr) ? 'calc' : 'gtfs')
                    : (f.calcErr != null ? 'calc-only' : 'gtfs-only'),
            }));
        if (worst.length) { console.log('\n  Worst snapshots (|error| > 90s, top 10):'); console.table(worst); }
    }

    function report() {
        const elapsed = ((Date.now() - start) / 60000).toFixed(1);
        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  ETA Three-Way Report v4  (${elapsed} min, ${results.length} arrivals)  ║`);
        console.log(`╚══════════════════════════════════════════════════════════════╝`);

        if (!results.length) {
            console.warn('No arrivals captured. Try a busier time of day with more vehicles in view.');
            return;
        }

        const railResults = results.filter(r => RAIL_ROUTES.has(r.routeId));
        const busResults  = results.filter(r => BUS_ROUTES.has(r.routeId));
        const allFlat     = flattenSnapshots(results);

        reportSection('RAIL (A/B/C/E/K)', railResults);
        if (busResults.length) reportSection('BUS (G/J)', busResults);
        reportSection('ALL LINES', results);

        window.__etaTestData = { results, flat: allFlat };
        console.log('\nRaw data: window.__etaTestData = { results, flat }');
    }

    const timer = setInterval(tick, POLL_MS);
    tick();

    window.__etaTestStop = () => { clearInterval(timer); report(); };
})();
