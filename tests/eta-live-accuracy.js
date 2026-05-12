export {}; // makes this file a valid ES module — run via: import('/tests/eta-live-accuracy.js')

/**
 * ETA Calc Accuracy Test (v7 — calc-only diagnostic, no blend)
 * ---------------------------------------------------------------------------------------------------
 * Run in the browser console on the running livemap (localhost:3000):
 *   import('/tests/eta-live-accuracy.js')
 *
 * Purpose: measure and diagnose the pure calc ETA accuracy so the algorithm can be tuned.
 * GTFS-RT is shown as a reference oracle only — not blended. Blend is a prod-tooltip concern.
 *
 * Error sign convention:
 *   error = actualUnix - predictedEta
 *   Negative = arrived EARLIER than predicted (pessimistic prediction)
 *   Positive = arrived LATER   than predicted (optimistic prediction)
 */
(async () => {
    // Duration / route allowlist can be overridden by the headless runner before
    // import. window.__etaTestDuration = minutes; window.__etaTestRoutes = Set<rc>.
    const DURATION_MIN        = Number(window.__etaTestDuration ?? 60);
    const POLL_MS             = 2000;
    const SNAPSHOT_INTERVAL_S = 15;    // seconds between prediction snapshots per (vehicle, trip, stop)
    const MIN_HORIZON_S       = 10;    // ignore predictions < 10 s out (terminus/near-arrival noise)
    const MAX_HORIZON_S       = 1800;  // ignore predictions > 30 min out
    const EXCLUDE_ROUTES      = new Set(['805']); // D Line pre-revenue extension skews results
    const ROUTE_FILTER        = window.__etaTestRoutes instanceof Set ? window.__etaTestRoutes : null;

    // Station-centric snapshot mode — see comments in earlier versions for full rationale.
    // Set target stop IDs here to capture long-horizon (10–30 min) snapshots.
    // Busy targets: '80122' (7th St), '80501' (LAX/Metro TC), '80401' (Union Station).
    const TARGET_STOP_IDS     = window.__etaTestTargetStops ?? [];

    const ROUTE_NAMES = {
        '801': 'A Line', '802': 'B Line', '803': 'C Line',
        '804': 'E Line', '805': 'D Line', '807': 'K Line',
        '901': 'G Line', '910': 'J Line', '950': 'J Line (exp)',
    };
    const RAIL_ROUTES = new Set(['801','802','803','804','807']);
    const BUS_ROUTES  = new Set(['901','910','950']);

    let getArrivalBreakdown;
    let aggregator;
    let planarMeters;
    try {
        ({ getArrivalBreakdown } = await import('/js/predictions.js'));
        ({ planarMeters }        = await import('/js/utils.js'));
        aggregator = await import('/tests/_lib/accuracy-aggregator.js');
    } catch (e) {
        console.error('[eta-test] Could not import predictions.js / utils.js / aggregator — make sure you are on localhost:3000', e);
        return;
    }
    const { stats, flattenSnapshots, consoleTablePlus } = aggregator;

    // markerDistM: planar metres from the marker's current visual position to
    // the target stop. Captured per-snapshot so offline analysis can compute
    // when the *dot* visually reached the stop vs. when the popup said it
    // would — the animation-vs-popup gap that today's harness can't see.
    function _markerDistToStop(marker, stopId) {
        if (!marker || !stopId) return null;
        const stop = window.masterStopsData?.[String(stopId)];
        if (!stop?.lat || !stop?.lon) return null;
        const lngLat = marker.getLngLat?.();
        if (!lngLat) return null;
        return planarMeters(lngLat.lat, lngLat.lng, stop.lat, stop.lon);
    }

    // predKey = `${vehicle_id}:${trip_id}:${stopId}` — tripId prevents wrong-vehicle cross-match
    const pending = new Map();
    const arrived = new Set();
    const results = [];
    const start   = Date.now();

    console.log(`[eta-test v7] Started — ${DURATION_MIN} min, snapshot every ${SNAPSHOT_INTERVAL_S}s, horizon ${MIN_HORIZON_S}–${MAX_HORIZON_S}s. Call window.__etaTestStop() to stop early.`);

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
            if (ROUTE_FILTER && !ROUTE_FILTER.has(route_code)) continue;

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
            const found = breakdown.find(a => a.vehicleId === vehicle_id || a.tripId === trip_id);
            if (!found) continue;

            const horizonCalc  = found.calcEta  != null ? found.calcEta  - now : null;
            const horizonGtfs  = found.gtfsEta  != null ? found.gtfsEta  - now : null;
            const horizonBlend = found.blendEta != null ? found.blendEta - now : null;
            const horizon      = horizonCalc ?? horizonGtfs ?? horizonBlend;
            if (horizon == null || horizon < MIN_HORIZON_S || horizon > MAX_HORIZON_S) continue;
            if (horizonGtfs != null && horizonGtfs < 0) continue;

            entry.routeId = found.routeId ?? entry.routeId;
            entry.snapshots.push({
                recordedAt:   now,
                tripId:       trip_id,
                calcEta:      found.calcEta,
                gtfsEta:      found.gtfsEta,
                blendEta:     found.blendEta,
                horizonCalc,
                horizonGtfs,
                horizonBlend,
                intermediates: found._intermediateStops ?? null,
                adherence:    found._adherenceOffsetS ?? null,
                atOrigin:     found._atOrigin ?? false,
                speedMult:    found._speedMultiplier ?? null,
                capped:       found._offsetCapped ?? false,
                snapDevM:     found._snapDeviationM ?? null,  // GPS-to-polyline distance in meters
                markerDistM:  _markerDistToStop(marker, stopId), // marker → target stop (metres)
            });
        }

        // ── Station-centric snapshots (long-horizon mode) ──
        for (const targetStopId of TARGET_STOP_IDS) {
            const sid = String(targetStopId);
            const breakdown = getArrivalBreakdown(sid);
            for (const entry of breakdown) {
                if (!entry.vehicleId || !entry.tripId) continue;
                if (EXCLUDE_ROUTES.has(entry.routeId)) continue;

                const predKey = `${entry.vehicleId}:${entry.tripId}:${sid}`;
                if (seenPredKeys.has(predKey)) continue;
                seenPredKeys.add(predKey);

                let p = pending.get(predKey);
                if (!p) {
                    p = { targetStopId: sid, vehicleId: entry.vehicleId, tripId: entry.tripId, routeId: entry.routeId, snapshots: [] };
                    pending.set(predKey, p);
                }
                const lastSnap = p.snapshots[p.snapshots.length - 1];
                if (lastSnap && now - lastSnap.recordedAt < SNAPSHOT_INTERVAL_S) continue;

                const horizonCalc  = entry.calcEta  != null ? entry.calcEta  - now : null;
                const horizonGtfs  = entry.gtfsEta  != null ? entry.gtfsEta  - now : null;
                const horizonBlend = entry.blendEta != null ? entry.blendEta - now : null;
                const horizon      = horizonCalc ?? horizonGtfs ?? horizonBlend;
                if (horizon == null || horizon < MIN_HORIZON_S || horizon > MAX_HORIZON_S) continue;
                if (horizonGtfs != null && horizonGtfs < 0) continue;

                p.routeId = entry.routeId ?? p.routeId;
                const stationMarker = window.vehicleMarkers?.[entry.vehicleId];
                p.snapshots.push({
                    recordedAt:   now,
                    tripId:       entry.tripId,
                    calcEta:      entry.calcEta,
                    gtfsEta:      entry.gtfsEta,
                    blendEta:     entry.blendEta,
                    horizonCalc,
                    horizonGtfs,
                    horizonBlend,
                    intermediates: entry._intermediateStops ?? null,
                    adherence:    entry._adherenceOffsetS ?? null,
                    atOrigin:     entry._atOrigin ?? false,
                    speedMult:    entry._speedMultiplier ?? null,
                    capped:       entry._offsetCapped ?? false,
                    snapDevM:     entry._snapDeviationM ?? null,
                    markerDistM:  _markerDistToStop(stationMarker, sid),
                });
            }
        }

        // ── Arrival via stopId advance ──
        for (const [predKey, entry] of pending) {
            if (arrived.has(predKey)) continue;
            if (seenPredKeys.has(predKey)) continue;

            const marker = window.vehicleMarkers?.[entry.vehicleId];
            if (!marker) {
                arrived.add(predKey);
                continue;
            }
            recordArrival(predKey, marker.timestamp ?? now, marker.properties?.trip_id);
        }
    }

    function recordArrival(predKey, actualUnix, arrivingTripId) {
        if (arrived.has(predKey)) return;
        const entry = pending.get(predKey);
        if (!entry || entry.snapshots.length === 0) { arrived.add(predKey); return; }
        arrived.add(predKey);

        const cleanSnapshots = entry.snapshots.filter(s => s.tripId === entry.tripId);
        if (!cleanSnapshots.length) return;

        results.push({
            vehicleId: entry.vehicleId, tripId: entry.tripId,
            stopId: entry.targetStopId, routeId: entry.routeId,
            actualUnix, snapshots: cleanSnapshots,
        });
    }

    function reportSection(label, subset) {
        const flat = flattenSnapshots(subset);
        if (!flat.length) return;

        const calcSnaps = flat.filter(f => f.calcErr != null).length;
        const gtfsSnaps = flat.filter(f => f.gtfsErr != null).length;
        const arrivalsWithGtfs = subset.filter(r => r.snapshots.some(s => s.gtfsEta != null)).length;

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  ${label}  —  ${subset.length} arrivals  |  ${flat.length} snapshots`);
        console.log(`${'═'.repeat(60)}`);
        console.log(`  GTFS-RT coverage: ${arrivalsWithGtfs}/${subset.length} arrivals`);
        console.log(`  Snapshots — calc: ${calcSnaps}, GTFS-RT: ${gtfsSnaps}, avg/arrival: ${(flat.length / subset.length).toFixed(1)}`);

        const buckets = [
            { label: '< 30 s',    min: 0,   max: 30   },
            { label: '30–60 s',   min: 30,  max: 60   },
            { label: '1–2 min',   min: 60,  max: 120  },
            { label: '2–5 min',   min: 120, max: 300  },
            { label: '5–10 min',  min: 300, max: 600  },
            { label: '10–15 min', min: 600, max: 900  },
            { label: '15+ min',   min: 900, max: 1800 },
        ];

        // ── Calc accuracy ──────────────────────────────────────────────────────────
        const augment = (g, base) => {
            if (!base || base.n === 0) return base ?? { n: 0 };
            const inter = g.map(f => f.intermediates).filter(v => v != null);
            const orig  = g.filter(f => f.atOrigin).length;
            return {
                ...base,
                avgInter: inter.length ? +(inter.reduce((a, b) => a + b, 0) / inter.length).toFixed(1) : null,
                pctOrig:  g.length ? `${Math.round(orig / g.length * 100)}%` : '0%',
            };
        };

        console.log('\n  Calc ETA accuracy by horizon:');
        const calcRows = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonCalc != null && f.horizonCalc >= b.min && f.horizonCalc < b.max);
            calcRows[b.label] = augment(g, stats(g.map(f => f.calcErr)));
        }
        calcRows['ALL'] = augment(flat, stats(flat.map(f => f.calcErr)));
        consoleTablePlus(calcRows);

        // ── GTFS-RT reference ──────────────────────────────────────────────────────
        console.log('\n  GTFS-RT accuracy (reference oracle — not blended):');
        const gtfsRows = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonGtfs != null && f.horizonGtfs >= b.min && f.horizonGtfs < b.max);
            gtfsRows[b.label] = stats(g.map(f => f.gtfsErr)) ?? { n: 0 };
        }
        gtfsRows['ALL'] = stats(flat.map(f => f.gtfsErr)) ?? { n: 0 };
        consoleTablePlus(gtfsRows);

        // ── Head-to-head: calc vs GTFS-RT ─────────────────────────────────────────
        const both = flat.filter(f => f.calcErr != null && f.gtfsErr != null);
        if (both.length) {
            console.log('\n  Head-to-head (snapshots with both sources):');
            consoleTablePlus({
                Calc:      stats(both.map(f => f.calcErr)),
                'GTFS-RT': stats(both.map(f => f.gtfsErr)),
            });
            const calcWins = both.filter(f => Math.abs(f.calcErr) < Math.abs(f.gtfsErr)).length;
            const gtfsWins = both.filter(f => Math.abs(f.gtfsErr) < Math.abs(f.calcErr)).length;
            console.log(`  Calc closer: ${calcWins}  |  GTFS-RT closer: ${gtfsWins}  |  Tie: ${both.length - calcWins - gtfsWins}`);
        }

        // ── Adherence offset diagnostics ───────────────────────────────────────────
        console.log('\n  Adherence offset (s) by line — pctZero shows how often correction is suppressed:');
        const adhLines = [...new Set(flat.map(f => f.routeId).filter(Boolean))].sort();
        const adhRows = {};
        for (const rc of adhLines) {
            const adh = flat.filter(f => f.routeId === rc).map(f => f.adherence).filter(v => v != null);
            if (!adh.length) continue;
            const sorted = [...adh].sort((a, b) => a - b);
            const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(adh.length * p))];
            adhRows[ROUTE_NAMES[rc] ?? rc] = {
                n:       adh.length,
                p10:     at(0.10),
                median:  at(0.50),
                p90:     at(0.90),
                atCap:   adh.filter(v => Math.abs(v) >= 590).length,
                pctZero: `${Math.round(adh.filter(v => v === 0).length / adh.length * 100)}%`,
            };
        }
        if (Object.keys(adhRows).length) consoleTablePlus(adhRows);

        // ── Snap deviation diagnostics ─────────────────────────────────────────────
        // Shows GPS-to-polyline distance per line. Values > 80 m were blocking adherence
        // before the devLimit fix; values > 150 m (RAIL_SNAP_MAX_M) mean off-route (no snap).
        const snapDevRows = {};
        for (const rc of adhLines) {
            const devs = flat.filter(f => f.routeId === rc).map(f => f.snapDevM).filter(v => v != null);
            if (!devs.length) continue;
            const sorted = [...devs].sort((a, b) => a - b);
            const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(devs.length * p))];
            snapDevRows[ROUTE_NAMES[rc] ?? rc] = {
                n:      devs.length,
                min:    +at(0).toFixed(1),
                median: +at(0.5).toFixed(1),
                p90:    +at(0.9).toFixed(1),
                max:    +sorted[sorted.length - 1].toFixed(1),
                pctNull: `${Math.round((flat.filter(f => f.routeId === rc && f.snapDevM == null).length / flat.filter(f => f.routeId === rc).length) * 100)}%`,
            };
        }
        if (Object.keys(snapDevRows).length) {
            console.log('\n  Snap deviation (m) by line — how far GPS was from polyline (null = off-route):');
            consoleTablePlus(snapDevRows);
        }

        // ── Speed multiplier diagnostics ───────────────────────────────────────────
        const multLines = [...new Set(flat.map(f => f.routeId).filter(Boolean))].sort();
        const multRows  = {};
        for (const rc of multLines) {
            const mults = flat.filter(f => f.routeId === rc && f.speedMult != null).map(f => f.speedMult);
            if (!mults.length) continue;
            const sortedM = [...mults].sort((a, b) => a - b);
            const atM     = (p) => sortedM[Math.min(sortedM.length - 1, Math.floor(mults.length * p))];
            const active  = mults.filter(m => Math.abs(m - 1.0) >= 0.05).length;
            multRows[ROUTE_NAMES[rc] ?? rc] = {
                n:         mults.length,
                min:       +sortedM[0].toFixed(2),
                median:    +atM(0.5).toFixed(2),
                max:       +sortedM[sortedM.length - 1].toFixed(2),
                pctActive: `${Math.round(active / mults.length * 100)}%`,
            };
        }
        if (Object.keys(multRows).length) {
            console.log('\n  Speed multiplier (EWMA travel-time correction) by line:');
            consoleTablePlus(multRows);
        }

        // ── Adherence taper cap engagement ────────────────────────────────────────
        const capRows = {};
        for (const rc of adhLines) {
            const g = flat.filter(f => f.routeId === rc);
            if (!g.length) continue;
            capRows[ROUTE_NAMES[rc] ?? rc] = {
                n:         g.length,
                pctCapped: `${Math.round(g.filter(f => f.capped === true).length / g.length * 100)}%`,
            };
        }
        if (Object.keys(capRows).length) {
            console.log('\n  Adherence taper engagement (% snapshots where offset was capped):');
            consoleTablePlus(capRows);
        }

        // ── By-line calc summary ───────────────────────────────────────────────────
        const lines = [...new Set(flat.map(f => f.routeId).filter(Boolean))].sort();
        if (lines.length > 1) {
            console.log('\n  Calc accuracy by line:');
            const lineRows = {};
            for (const rc of lines) {
                const g = flat.filter(f => f.routeId === rc);
                const cs = stats(g.map(f => f.calcErr));
                if (cs) lineRows[ROUTE_NAMES[rc] ?? rc] = cs;
            }
            consoleTablePlus(lineRows);
        }

        // ── Convergence ────────────────────────────────────────────────────────────
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
            consoleTablePlus({
                'Calc — first':    stats(conv.map(c => c.firstCalcErr)),
                'Calc — last':     stats(conv.map(c => c.lastCalcErr)),
                'GTFS-RT — first': stats(conv.map(c => c.firstGtfsErr)),
                'GTFS-RT — last':  stats(conv.map(c => c.lastGtfsErr)),
            });
        }

        // ── Worst calc snapshots ───────────────────────────────────────────────────
        const worst = flat
            .filter(f => Math.abs(f.calcErr ?? 0) > 90)
            .sort((a, b) => Math.abs(b.calcErr ?? 0) - Math.abs(a.calcErr ?? 0))
            .slice(0, 10)
            .map(f => ({
                line:      ROUTE_NAMES[f.routeId] ?? f.routeId,
                horizCalc: f.horizonCalc != null ? +f.horizonCalc.toFixed(0) : null,
                horizGtfs: f.horizonGtfs != null ? +f.horizonGtfs.toFixed(0) : null,
                calcErr:   f.calcErr  != null ? +f.calcErr.toFixed(0) : null,
                gtfsErr:   f.gtfsErr  != null ? +f.gtfsErr.toFixed(0) : null,
                adherence: f.adherence != null ? +f.adherence.toFixed(0) : null,
                snapDevM:  f.snapDevM  != null ? +f.snapDevM.toFixed(0) : null,
            }));
        if (worst.length) {
            console.log('\n  Worst calc snapshots (|calcErr| > 90 s, top 10):');
            const worstRows = {};
            worst.forEach((w, i) => { worstRows[`#${i + 1}`] = w; });
            consoleTablePlus(worstRows);
        }
    }

    function calcByBucket(flat) {
        const buckets = [
            { label: '< 30 s',    min: 0,   max: 30   },
            { label: '30–60 s',   min: 30,  max: 60   },
            { label: '1–2 min',   min: 60,  max: 120  },
            { label: '2–5 min',   min: 120, max: 300  },
            { label: '5–10 min',  min: 300, max: 600  },
            { label: '10–15 min', min: 600, max: 900  },
            { label: '15+ min',   min: 900, max: 1800 },
        ];
        const out = {};
        for (const b of buckets) {
            const g = flat.filter(f => f.horizonCalc != null && f.horizonCalc >= b.min && f.horizonCalc < b.max);
            const s = stats(g.map(f => f.calcErr));
            out[b.label] = s ? { n: s.n, mean: s.mean, mae: s.mae } : { n: 0 };
        }
        return out;
    }

    function report() {
        const elapsed = ((Date.now() - start) / 60000).toFixed(1);
        console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
        console.log(`║  ETA Calc Accuracy Report v7  (${elapsed} min, ${results.length} arrivals)  ║`);
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

        // Run-to-run delta vs previous test invocation in this session.
        const prev = window.__etaTestDataPrev;
        if (prev?.flat?.length) {
            console.log('\n  Δ vs previous run (calc, ALL LINES):');
            const cur  = calcByBucket(allFlat);
            const prv  = calcByBucket(prev.flat);
            const dRows = {};
            for (const k of Object.keys(cur)) {
                const c = cur[k], p = prv[k];
                if (!c.n || !p.n) { dRows[k] = { n_now: c.n ?? 0, n_prev: p.n ?? 0 }; continue; }
                dRows[k] = {
                    n_now: c.n, n_prev: p.n,
                    mean_now: c.mean, mean_prev: p.mean, Δmean: +(c.mean - p.mean).toFixed(1),
                    mae_now: c.mae, mae_prev: p.mae, Δmae: +(c.mae - p.mae).toFixed(1),
                };
            }
            consoleTablePlus(dRows);
        } else {
            console.log('\n  (No previous run in window.__etaTestDataPrev — Δ table will appear after the next run.)');
        }

        window.__etaTestData     = { results, flat: allFlat };
        window.__etaTestDataPrev = window.__etaTestData;
        console.log('\nRaw data: window.__etaTestData = { results, flat }');
    }

    const timer = setInterval(tick, POLL_MS);
    tick();

    // Headless-runner contract: poll __etaTestStatus(), then call __etaTestExport()
    // when status.done === true. Avoids racing the IIFE's setInterval and lets the
    // runner stream snapshot counts during capture for liveness.
    window.__etaTestStatus = () => ({
        startMs:   start,
        elapsedMin: ((Date.now() - start) / 60000).toFixed(2),
        durationMin: DURATION_MIN,
        snapshots: [...pending.values()].reduce((n, e) => n + e.snapshots.length, 0),
        arrivals:  results.length,
        done:      results.length > 0 && Date.now() - start >= DURATION_MIN * 60 * 1000,
    });
    window.__etaTestExport = () => ({
        meta: {
            startISO:    new Date(start).toISOString(),
            endISO:      new Date().toISOString(),
            durationMin: DURATION_MIN,
            arrivals:    results.length,
        },
        results,
    });
    window.__etaTestStop = () => { clearInterval(timer); report(); };
})();
