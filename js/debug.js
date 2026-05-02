/**
 * debug.js
 * ETA comparison panel: raw GTFS-RT feed vs our schedule+GPS calc.
 * Toggle with backtick (`).
 */

import { getScheduledArrivals, getTerminalName } from './predictions.js';
import { getActiveStopIds } from './stations.js';
import { routeHexColors } from './config.js';

const ROUTE_LETTER = {
    '801': 'A', '802': 'B', '803': 'C', '804': 'E', '805': 'D',
    '806': 'L', '807': 'K', '901': 'G', '910': 'J', '950': 'J',
};

let panel = null;
let refreshTimer = null;
let visible = false;

export function initDebugPanel() {
    panel = document.createElement('div');
    panel.id = 'eta-dbg-panel';
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="eta-dbg-header">
            <span>ETA Debug <span class="eta-dbg-hint">(Alt+A)</span></span>
            <button class="eta-dbg-close" title="Close">×</button>
        </div>
        <div class="eta-dbg-scroll">
            <table class="eta-dbg-table">
                <thead><tr>
                    <th>Rt</th>
                    <th>To</th>
                    <th>GTFS</th>
                    <th>Calc</th>
                    <th>Δs</th>
                </tr></thead>
                <tbody id="eta-dbg-body"></tbody>
            </table>
        </div>
        <div class="eta-dbg-footer" id="eta-dbg-footer">Press \` to open</div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.eta-dbg-close').addEventListener('click', () => setVisible(false));
    document.addEventListener('keydown', e => {
        if (e.altKey && e.key === 'a') setVisible(!visible);
    });
}

function setVisible(show) {
    visible = show;
    panel.style.display = show ? 'flex' : 'none';
    if (show) {
        refresh();
        refreshTimer = setInterval(refresh, 2000);
    } else {
        clearInterval(refreshTimer);
        refreshTimer = null;
    }
}

function fmtEta(unix) {
    if (unix == null) return '—';
    const sec = Math.round(unix - Date.now() / 1000);
    if (sec < -30) return 'past';
    if (sec <= 30)  return 'Now';
    if (sec < 60)   return `${sec}s`;
    return `${Math.round(sec / 60)}m`;
}

function refresh() {
    const now   = Math.floor(Date.now() / 1000);
    const tbody = document.getElementById('eta-dbg-body');
    const footer = document.getElementById('eta-dbg-footer');
    if (!tbody) return;

    const activeStopIds = getActiveStopIds();
    if (!activeStopIds?.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="dbg-empty">Open a station popup</td></tr>`;
        if (footer) footer.textContent = 'No station selected';
        return;
    }

    const rows = [];
    const seen = new Set();

    for (const stopId of activeStopIds) {
        // Raw GTFS-RT arrivals for this stop
        const gtfsList = window.masterArrivalsData?.get(stopId) ?? [];
        // Our blended calc result (what the user actually sees)
        const calcList = getScheduledArrivals(stopId);

        // Index calc results by tripId for O(1) lookup
        const calcByTrip = new Map(calcList.map(a => [a.tripId, a]));

        for (const gtfs of gtfsList) {
            if (gtfs.arrivalUnix < now - 30) continue;
            const key = `${gtfs.tripId}-${gtfs.routeId}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const calc  = calcByTrip.get(gtfs.tripId);
            const delta = calc != null ? Math.round(calc.arrivalUnix - gtfs.arrivalUnix) : null;
            const dir   = gtfs.directionId ?? calc?.directionId ?? 0;
            const dest  = getTerminalName(gtfs.routeId, dir) ?? `Dir ${dir}`;

            rows.push({
                routeId:     gtfs.routeId,
                directionId: dir,
                dest:        dest.length > 14 ? dest.slice(0, 13) + '…' : dest,
                gtfsUnix:    gtfs.arrivalUnix,
                calcUnix:    calc?.arrivalUnix ?? null,
                delta,
            });
        }

        // Also show calc-only rows (our calc sees a vehicle GTFS missed)
        for (const calc of calcList) {
            const key = `${calc.tripId}-${calc.routeId}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const dest = getTerminalName(calc.routeId, calc.directionId) ?? `Dir ${calc.directionId}`;
            rows.push({
                routeId:     calc.routeId,
                directionId: calc.directionId ?? 0,
                dest:        dest.length > 14 ? dest.slice(0, 13) + '…' : dest,
                gtfsUnix:    null,
                calcUnix:    calc.arrivalUnix,
                delta:       null,
            });
        }
    }

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="dbg-empty">No upcoming arrivals</td></tr>`;
        if (footer) footer.textContent = 'No data';
        return;
    }

    // Group by route, then by direction
    const byRoute = {};
    for (const r of rows) {
        if (!byRoute[r.routeId]) byRoute[r.routeId] = {};
        if (!byRoute[r.routeId][r.directionId]) byRoute[r.routeId][r.directionId] = [];
        byRoute[r.routeId][r.directionId].push(r);
    }

    // Sort each group by ETA and limit to 2 per direction
    for (const routeId in byRoute) {
        for (const dir in byRoute[routeId]) {
            byRoute[routeId][dir].sort((a, b) => (a.gtfsUnix ?? a.calcUnix ?? 0) - (b.gtfsUnix ?? b.calcUnix ?? 0));
            byRoute[routeId][dir] = byRoute[routeId][dir].slice(0, 2);
        }
    }

    // Flatten and render
    let html = '';
    for (const routeId of Object.keys(byRoute).sort()) {
        for (const dir of Object.keys(byRoute[routeId]).sort()) {
            const dirRows = byRoute[routeId][dir];
            const dirLabel = dir == 0 ? '↓' : '↑';
            html += `<tr><td colspan="5" style="font-size:9px;font-weight:700;color:var(--text-muted);padding:3px 6px;border-top:1px solid var(--border-line)">${ROUTE_LETTER[routeId] ?? routeId} Dir ${dir} ${dirLabel}</td></tr>`;

            for (const r of dirRows) {
                const letter = ROUTE_LETTER[r.routeId] ?? r.routeId;
                const color  = routeHexColors[r.routeId] ?? '#888';

                let deltaClass = '', deltaStr = '—';
                if (r.delta != null) {
                    deltaStr   = r.delta >= 0 ? `+${r.delta}` : `${r.delta}`;
                    deltaClass = Math.abs(r.delta) < 60  ? 'dbg-ok'
                               : Math.abs(r.delta) < 120 ? 'dbg-warn'
                               : 'dbg-bad';
                }

                html += `<tr>
                    <td><span class="dbg-badge" style="background:${color}">${letter}</span></td>
                    <td class="dbg-stop">${r.dest}</td>
                    <td>${fmtEta(r.gtfsUnix)}</td>
                    <td>${fmtEta(r.calcUnix)}</td>
                    <td class="${deltaClass}">${deltaStr}</td>
                </tr>`;
            }
        }
    }

    tbody.innerHTML = html;

    const matched = rows.filter(r => r.delta != null).length;
    const gtfsOnly = rows.filter(r => r.calcUnix == null).length;
    const calcOnly = rows.filter(r => r.gtfsUnix == null).length;
    if (footer) footer.textContent =
        `${rows.length} rows · ${matched} matched · ${gtfsOnly} gtfs-only · ${calcOnly} calc-only · ${new Date().toLocaleTimeString()}`;
}
