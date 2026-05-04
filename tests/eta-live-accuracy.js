export {}; // makes this file a valid ES module — run via: import('/tests/eta-live-accuracy.js')

/**
 * ETA Three-Way Accuracy Test (v2 — multi-snapshot)
 * --------------------------------------------------
 * Run in the browser console on the running livemap (localhost:3000):
 *   import('/tests/eta-live-accuracy.js')
 *
 * For each (vehicle, next-stop) pair seen during the run, we take a NEW
 * prediction snapshot every SNAPSHOT_INTERVAL_S seconds while the vehicle
 * approaches. Each snapshot becomes its own row in the horizon-bucketed
 * report — so the "1–2 min" bucket reflects predictions made when the
 * vehicle was actually 1–2 min out, not the first prediction we caught.
 *
 * Arrival detection (improvements over v1):
 *   1. STOPPED_AT at the tracked stop  → use marker.timestamp (last GPS fix)
 *   2. Marker advances away from the tracked stop → vehicle passed through;
 *      use marker.timestamp at the moment of advance (catches missed STOPPED_AT)
 *
 * Errors:
 *   actualUnix - predictedEta
 *   Negative = arrived EARLIER than predicted (we were pessimistic)
 *   Positive = arrived LATER   than predicted (we were optimistic)
 */
(async () => {
    const DURATION_MIN        = 60;
    const POLL_MS             = 2000;
    const SNAPSHOT_INTERVAL_S = 15;       // seconds between prediction snapshots per (vehicle, stop)
    const MAX_HORIZON_S       = 600;      // ignore predictions > 10 min out
    const EXCLUDE_ROUTES      = new Set(['805']); // D Line pre-revenue extension skews results
    const ROUTE_NAMES = {
        '801': 'A Line', '802': 'B Line', '803': 'C Line',
        '804': 'E Line', '805': 'D Line', '807': 'K Line',
        '901': 'G Line', '910': 'J Line', '950': 'J Line (exp)',
    };

    let getArrivalBreakdown;
    try {
        ({ getArrivalBreakdown } = await import('/js/predictions.js'));
    } catch (e) {
        console.error('[eta-test] Could not import predictions.js — make sure you are on localhost:3000', e);
        return;
    }

    /**
     * pending: predKey → {
     *   targetStopId, vehicleId, tripId, routeId,
     *   snapshots: [{ recordedAt, calcEta, gtfsEta, horizonCalc, horizonGtfs }],
     * }
     * Each entry collects predictions for one (vehicle, next-stop) pair.
     * On arrival, we copy snapshots into `results` with the observed actualUnix.
     */
    const pending  = new Map();
    const arrived  = new Set();
    /** results: { vehicleId, tripId, stopId, routeId, actualUnix, snapshots } per arrival */
    const results  = [];
    const start    = Date.now();

    console.log(`[eta-test v2] Started — running for ${DURATION_MIN} min, snapshot every ${SNAPSHOT_INTERVAL_S}s. Call window.__etaTestStop() to stop early.`);

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
            if (!vehicle_id || !stopId) continue;
            if (EXCLUDE_ROUTES.has(route_code)) continue;

            const predKey = `${vehicle_id}:${stopId}`;
            seenPredKeys.add(predKey);
            const stopped = currentStatus === 'STOPPED_AT' || currentStatus === 1;

            // ── Arrival detection: STOPPED_AT at the tracked stop ──
            if (stopped && pending.has(predKey) && !arrived.has(predKey)) {
                recordArrival(predKey, marker.timestamp ?? now);
                continue;
            }

            if (stopped) continue; // already-stopped vehicle, no new predictions

            // ── Take a new prediction snapshot ──
            let entry = pending.get(predKey);
            if (!entry) {
                entry = {
                    targetStopId: String(stopId),
                    vehicleId:    vehicle_id,
                    tripId:       trip_id,
                    routeId:      route_code,
                    snapshots:    [],
                };
                pending.set(predKey, entry);
            }
            const lastSnap = entry.snapshots[entry.snapshots.length - 1];
            if (lastSnap && now - lastSnap.recordedAt < SNAPSHOT_INTERVAL_S) continue;

            const breakdown = getArrivalBreakdown(String(stopId));
            const found = breakdown.find(a => a.vehicleId === vehicle_id || a.tripId === trip_id);
            if (!found) continue;

            const horizonCalc = found.calcEta != null ? found.calcEta - now : null;
            const horizonGtfs = found.gtfsEta != null ? found.gtfsEta - now : null;
            const horizon     = horizonCalc ?? horizonGtfs;
            if (horizon == null || horizon <= 0 || horizon > MAX_HORIZON_S) continue;

            entry.routeId = found.routeId ?? entry.routeId;
            entry.snapshots.push({
                recordedAt: now,
                calcEta:    found.calcEta,
                gtfsEta:    found.gtfsEta,
                horizonCalc,
                horizonGtfs,
            });
        }

        // ── Arrival detection: marker advanced away from tracked stop ──
        // Vehicle's next-stop is no longer our predKey's stopId → it passed through.
        // Catches arrivals where we missed the brief STOPPED_AT frame.
        for (const [predKey, entry] of pending) {
            if (arrived.has(predKey)) continue;
            if (seenPredKeys.has(predKey)) continue;

            const marker = window.vehicleMarkers?.[entry.vehicleId];
            // If the marker disappeared entirely (TTL expiry), use last snapshot's recordedAt
            // as a conservative actualUnix — but only if recent, else drop.
            const lastSnap = entry.snapshots[entry.snapshots.length - 1];
            const actualUnix = marker?.timestamp
                ?? (lastSnap && now - lastSnap.recordedAt < 120 ? now : null);
            if (actualUnix == null) {
                arrived.add(predKey); // give up on this one
                continue;
            }
            recordArrival(predKey, actualUnix);
        }
    }

    function recordArrival(predKey, actualUnix) {
        if (arrived.has(predKey)) return;
        const entry = pending.get(predKey);
        if (!entry || entry.snapshots.length === 0) {
            arrived.add(predKey);
            return;
        }
        arrived.add(predKey);
        results.push({
            vehicleId: entry.vehicleId,
            tripId:    entry.tripId,
            stopId:    entry.targetStopId,
            routeId:   entry.routeId,
            actualUnix,
            snapshots: entry.snapshots,
        });
    }

    // ── Report helpers ──
    function stats(values) {
        const v = values.filter(x => x != null);
        if (!v.length) return null;
        const abs  = v.map(Math.abs);
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        const mae  = abs.reduce((a, b) => a + b, 0) / abs.length;
        const rmse = Math.sqrt(abs.map(e => e * e).reduce((a, b) => a + b, 0) / abs.length);
        const w30  = abs.filter(e => e <= 30).length / abs.length * 100;
        const w60  = abs.filter(e => e <= 60).length / abs.length * 100;
        return {
            n:         v.length,
            mean:      +mean.toFixed(1),
            mae:       +mae.toFixed(1),
            rmse:      +rmse.toFixed(1),
            within30s: `${w30.toFixed(0)}%`,
            within60s: `${w60.toFixed(0)}%`,
        };
    }

    /** Build flat array of { calcErr, gtfsErr, horizonCalc, horizonGtfs, routeId } per snapshot. */
    function flattenSnapshots() {
        const flat = [];
        for (const r of results) {
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

    function report() {
        const elapsed = ((Date.now() - start) / 60000).toFixed(1);
        const flat = flattenSnapshots();
        const calcSnaps = flat.filter(f => f.calcErr != null).length;
        const gtfsSnaps = flat.filter(f => f.gtfsErr != null).length;

        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  ETA Three-Way Report v2  (${elapsed} min, ${results.length} arrivals, ${flat.length} snapshots)  ║`);
        console.log(`╚══════════════════════════════════════════════════════════════╝`);

        if (!results.length) {
            console.warn('No arrivals captured. Try a busier time of day with more vehicles in view.');
            return;
        }

        // Coverage
        const arrivalsWithGtfs = results.filter(r => r.snapshots.some(s => s.gtfsEta != null)).length;
        console.log(`\n── Coverage ──`);
        console.log(`  Arrivals: ${results.length}`);
        console.log(`  Arrivals with any GTFS-RT snapshot: ${arrivalsWithGtfs} (${(arrivalsWithGtfs / results.length * 100).toFixed(0)}%)`);
        console.log(`  Total snapshots — calc: ${calcSnaps}, GTFS-RT: ${gtfsSnaps}`);
        console.log(`  Avg snapshots per arrival: ${(flat.length / results.length).toFixed(1)}`);

        // Horizon buckets — every snapshot is its own row, bucketed by its OWN horizon
        const buckets = [
            { label: '< 30 s',   min: 0,   max: 30  },
            { label: '30–60 s',  min: 30,  max: 60  },
            { label: '1–2 min',  min: 60,  max: 120 },
            { label: '2–5 min',  min: 120, max: 300 },
            { label: '5–10 min', min: 300, max: 600 },
        ];

        console.log('\n── Calc ETA accuracy by horizon (snapshot-level) ──');
        const calcRows = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonCalc != null && f.horizonCalc >= b.min && f.horizonCalc < b.max);
            calcRows[b.label] = stats(g.map(f => f.calcErr)) ?? { n: 0 };
        }
        calcRows['ALL'] = stats(flat.map(f => f.calcErr)) ?? { n: 0 };
        console.table(calcRows);

        console.log('\n── GTFS-RT ETA accuracy by horizon (snapshot-level) ──');
        const gtfsRows = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonGtfs != null && f.horizonGtfs >= b.min && f.horizonGtfs < b.max);
            gtfsRows[b.label] = stats(g.map(f => f.gtfsErr)) ?? { n: 0 };
        }
        gtfsRows['ALL'] = stats(flat.map(f => f.gtfsErr)) ?? { n: 0 };
        console.table(gtfsRows);

        // Head-to-head
        const both = flat.filter(f => f.calcErr != null && f.gtfsErr != null);
        if (both.length) {
            console.log('\n── Head-to-head (snapshots with BOTH sources) ──');
            console.table({
                Calc:      stats(both.map(f => f.calcErr)),
                'GTFS-RT': stats(both.map(f => f.gtfsErr)),
            });
            const calcWins = both.filter(f => Math.abs(f.calcErr) < Math.abs(f.gtfsErr)).length;
            const gtfsWins = both.filter(f => Math.abs(f.gtfsErr) < Math.abs(f.calcErr)).length;
            const ties     = both.length - calcWins - gtfsWins;
            console.log(`  Calc closer: ${calcWins}  |  GTFS-RT closer: ${gtfsWins}  |  Tie: ${ties}`);
        }

        // Convergence: first snapshot vs last snapshot per arrival
        const conv = results
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
            console.log('\n── Convergence: first vs last snapshot per arrival ──');
            console.table({
                'Calc — first':    stats(conv.map(c => c.firstCalcErr)),
                'Calc — last':     stats(conv.map(c => c.lastCalcErr)),
                'GTFS-RT — first': stats(conv.map(c => c.firstGtfsErr)),
                'GTFS-RT — last':  stats(conv.map(c => c.lastGtfsErr)),
            });
        }

        // Per-line (snapshot-level)
        console.log('\n── By line (snapshot-level) ──');
        const lineRows = {};
        const lines = [...new Set(flat.map(f => f.routeId).filter(Boolean))].sort();
        for (const rc of lines) {
            const group = flat.filter(f => f.routeId === rc);
            const label = ROUTE_NAMES[rc] ?? rc;
            const cs = stats(group.map(f => f.calcErr));
            const gs = stats(group.map(f => f.gtfsErr));
            if (cs) lineRows[`${label} — Calc`]    = cs;
            if (gs) lineRows[`${label} — GTFS-RT`] = gs;
        }
        console.table(lineRows);

        // Worst snapshots
        console.log('\n── Worst snapshots (|error| > 90 s, top 20) ──');
        const worst = flat
            .filter(f => Math.abs(f.calcErr ?? 0) > 90 || Math.abs(f.gtfsErr ?? 0) > 90)
            .sort((a, b) => Math.max(Math.abs(b.calcErr ?? 0), Math.abs(b.gtfsErr ?? 0))
                          - Math.max(Math.abs(a.calcErr ?? 0), Math.abs(a.gtfsErr ?? 0)))
            .slice(0, 20)
            .map(f => ({
                line:       ROUTE_NAMES[f.routeId] ?? f.routeId,
                horizCalc:  f.horizonCalc,
                horizGtfs:  f.horizonGtfs,
                calcErr:    f.calcErr,
                gtfsErr:    f.gtfsErr,
                winner:     f.calcErr != null && f.gtfsErr != null
                    ? (Math.abs(f.calcErr) < Math.abs(f.gtfsErr) ? 'calc' : 'gtfs')
                    : (f.calcErr != null ? 'calc-only' : 'gtfs-only'),
            }));
        if (worst.length) console.table(worst); else console.log('None!');

        // Expose raw data for ad-hoc analysis
        window.__etaTestData = { results, flat, conv };
        console.log('\nRaw data exposed at: window.__etaTestData = { results, flat, conv }');
    }

    const timer = setInterval(tick, POLL_MS);
    tick();

    window.__etaTestStop = () => { clearInterval(timer); report(); };
})();
