export {}; // makes this file a valid ES module — run via: import('/tests/eta-live-accuracy.js')

/**
 * ETA Three-Way Accuracy Test
 * ---------------------------
 * Run in the browser console on the running livemap (localhost:3000):
 *   import('/tests/eta-live-accuracy.js')
 * Runs for DURATION_MIN minutes, then prints a side-by-side report comparing:
 *   A) GTFS-RT feed arrival time
 *   B) Our calculated ETA (pure schedule + adherence offset, no GTFS blending)
 *   C) Actual arrival (when vehicle reaches STOPPED_AT)
 *
 * Positive error = arrived LATER than predicted (we were optimistic).
 * Negative error = arrived EARLIER than predicted (we were pessimistic).
 */
(async () => {
    const DURATION_MIN   = 10;
    const POLL_MS        = 2000;
    const MAX_HORIZON    = 600; // ignore predictions > 10 min out
    const EXCLUDE_ROUTES = new Set(['805']); // D line pre-revenue extension skews results
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

    // predKey → { calcEta, gtfsEta, recordedAt, stopId, vehicleId, tripId }
    const pending = new Map();
    const results = [];
    const arrived = new Set();
    const start   = Date.now();

    console.log(`[eta-test] Started — running for ${DURATION_MIN} min. Call window.__etaTestStop() to stop early.`);

    function tick() {
        if (Date.now() - start >= DURATION_MIN * 60 * 1000) {
            clearInterval(timer);
            report();
            return;
        }

        const now = Math.floor(Date.now() / 1000);

        for (const marker of Object.values(window.vehicleMarkers ?? {})) {
            const { vehicle_id, trip_id, stopId, currentStatus, route_code } = marker.properties ?? {};
            if (!vehicle_id || !stopId) continue;
            if (EXCLUDE_ROUTES.has(route_code)) continue;

            const predKey = `${vehicle_id}:${stopId}`;
            const stopped = currentStatus === 'STOPPED_AT' || currentStatus === 1;

            // Detect actual arrival
            if (stopped && pending.has(predKey) && !arrived.has(predKey)) {
                arrived.add(predKey);
                const p = pending.get(predKey);
                results.push({
                    vehicleId:   vehicle_id,
                    tripId:      trip_id,
                    stopId:      p.stopId,
                    routeId:     p.routeId,
                    predictedAt: p.recordedAt,
                    actualUnix:  now,
                    calcEta:     p.calcEta,
                    gtfsEta:     p.gtfsEta,
                    calcError:   p.calcEta != null ? now - p.calcEta : null,
                    gtfsError:   p.gtfsEta != null ? now - p.gtfsEta : null,
                    horizonCalc: p.calcEta != null ? p.calcEta - p.recordedAt : null,
                    horizonGtfs: p.gtfsEta != null ? p.gtfsEta - p.recordedAt : null,
                });
            }

            // Record first prediction for approaching vehicles
            if (!stopped && !pending.has(predKey)) {
                const breakdown = getArrivalBreakdown(String(stopId));
                const entry = breakdown.find(a => a.vehicleId === vehicle_id || a.tripId === trip_id);
                if (!entry) continue;

                const horizon = (entry.calcEta ?? entry.gtfsEta ?? 0) - now;
                if (horizon <= 0 || horizon > MAX_HORIZON) continue;

                pending.set(predKey, {
                    calcEta:    entry.calcEta,
                    gtfsEta:    entry.gtfsEta,
                    routeId:    entry.routeId,
                    recordedAt: now,
                    stopId,
                    vehicleId:  vehicle_id,
                    tripId:     trip_id,
                });
            }
        }
    }

    function stats(subset, field) {
        const vals = subset.map(r => r[field]).filter(v => v != null);
        if (!vals.length) return null;
        const abs    = vals.map(Math.abs);
        const mean   = vals.reduce((a, b) => a + b, 0) / vals.length;
        const mae    = abs.reduce((a, b) => a + b, 0) / abs.length;
        const rmse   = Math.sqrt(abs.map(e => e * e).reduce((a, b) => a + b, 0) / abs.length);
        const w30    = abs.filter(e => e <= 30).length / abs.length * 100;
        const w60    = abs.filter(e => e <= 60).length / abs.length * 100;
        return {
            n:        vals.length,
            mean:     +mean.toFixed(1),
            mae:      +mae.toFixed(1),
            rmse:     +rmse.toFixed(1),
            within30s: `${w30.toFixed(0)}%`,
            within60s: `${w60.toFixed(0)}%`,
        };
    }

    function report() {
        const elapsed = ((Date.now() - start) / 60000).toFixed(1);
        console.log(`\n╔══════════════════════════════════════════════════════╗`);
        console.log(`║  ETA Three-Way Report  (${elapsed} min, ${results.length} arrivals)  ║`);
        console.log(`╚══════════════════════════════════════════════════════╝`);

        if (!results.length) {
            console.warn('No arrivals captured. Try leaving the page open on a busy time with vehicles visible.');
            return;
        }

        const hasBoth  = results.filter(r => r.calcError != null && r.gtfsError != null);
        const calcOnly = results.filter(r => r.calcError != null && r.gtfsError == null);
        const gtfsOnly = results.filter(r => r.gtfsError != null && r.calcError == null);

        console.log(`\nTotal: ${results.length} arrivals — ${hasBoth.length} have both sources, ${calcOnly.length} calc-only, ${gtfsOnly.length} GTFS-only`);

        const buckets = [
            { label: '< 30 s',   min: 0,   max: 30  },
            { label: '30–60 s',  min: 30,  max: 60  },
            { label: '1–2 min',  min: 60,  max: 120 },
            { label: '2–5 min',  min: 120, max: 300 },
            { label: '5–10 min', min: 300, max: 600 },
        ];

        console.log('\n── Our Calc ETA accuracy (by calc horizon) ──');
        const calcRows = {};
        for (const b of buckets) {
            const g = results.filter(r => r.horizonCalc != null && r.horizonCalc >= b.min && r.horizonCalc < b.max);
            calcRows[b.label] = stats(g, 'calcError') ?? { n: 0 };
        }
        calcRows['ALL'] = stats(results.filter(r => r.calcError != null), 'calcError') ?? { n: 0 };
        console.table(calcRows);

        console.log('\n── GTFS-RT ETA accuracy (by GTFS horizon) ──');
        const gtfsRows = {};
        for (const b of buckets) {
            const g = results.filter(r => r.horizonGtfs != null && r.horizonGtfs >= b.min && r.horizonGtfs < b.max);
            gtfsRows[b.label] = stats(g, 'gtfsError') ?? { n: 0 };
        }
        gtfsRows['ALL'] = stats(results.filter(r => r.gtfsError != null), 'gtfsError') ?? { n: 0 };
        console.table(gtfsRows);

        if (hasBoth.length) {
            console.log('\n── Head-to-head (arrivals with BOTH sources) ──');
            const head = {
                'Calc': stats(hasBoth, 'calcError'),
                'GTFS-RT': stats(hasBoth, 'gtfsError'),
            };
            console.table(head);

            const calcWins = hasBoth.filter(r => Math.abs(r.calcError) < Math.abs(r.gtfsError)).length;
            const gtfsWins = hasBoth.filter(r => Math.abs(r.gtfsError) < Math.abs(r.calcError)).length;
            const ties     = hasBoth.length - calcWins - gtfsWins;
            console.log(`  Calc closer: ${calcWins}  |  GTFS-RT closer: ${gtfsWins}  |  Tie: ${ties}`);
        }

        console.log('\n── By line ──');
        const lineRows = {};
        const lines = [...new Set(results.map(r => r.routeId).filter(Boolean))].sort();
        for (const rc of lines) {
            const group = results.filter(r => r.routeId === rc);
            const label = ROUTE_NAMES[rc] ?? rc;
            const cs = stats(group.filter(r => r.calcError != null), 'calcError');
            const gs = stats(group.filter(r => r.gtfsError != null), 'gtfsError');
            if (cs) lineRows[`${label} — Calc`]    = cs;
            if (gs) lineRows[`${label} — GTFS-RT`] = gs;
        }
        console.table(lineRows);

        console.log('\n── Worst predictions (|error| > 60 s) ──');
        const worst = results
            .filter(r => Math.abs(r.calcError ?? 0) > 60 || Math.abs(r.gtfsError ?? 0) > 60)
            .sort((a, b) => Math.max(Math.abs(b.calcError ?? 0), Math.abs(b.gtfsError ?? 0))
                          - Math.max(Math.abs(a.calcError ?? 0), Math.abs(a.gtfsError ?? 0)))
            .slice(0, 15)
            .map(r => ({
                vehicleId:  r.vehicleId,
                stopId:     r.stopId,
                calcErr:    r.calcError,
                gtfsErr:    r.gtfsError,
                winner:     r.calcError != null && r.gtfsError != null
                    ? (Math.abs(r.calcError) < Math.abs(r.gtfsError) ? 'calc' : 'gtfs')
                    : (r.calcError != null ? 'calc-only' : 'gtfs-only'),
            }));
        if (worst.length) console.table(worst);
        else console.log('None!');

        console.log('\n── Raw results ──');
        console.table(results.sort((a, b) => a.predictedAt - b.predictedAt).map(r => ({
            line:       ROUTE_NAMES[r.routeId] ?? r.routeId,
            vehicleId:  r.vehicleId,
            stopId:     r.stopId,
            horizCalc:  r.horizonCalc,
            horizGtfs:  r.horizonGtfs,
            calcErr:    r.calcError,
            gtfsErr:    r.gtfsError,
            actual:     r.actualUnix,
        })));
    }

    const timer = setInterval(tick, POLL_MS);
    tick();

    window.__etaTestStop = () => { clearInterval(timer); report(); };
})();
