/**
 * debug.js
 * Bottom-right ETA comparison panel: Metro GTFS-RT feed vs our schedule-based calc.
 * Toggle with backtick (`). Auto-refreshes every 2 s while open.
 */

import { getScheduledArrivals, getTerminalName } from './predictions.js';
import { getActiveStopIds } from './stations.js';
import { cleanStationName } from './utils.js';
import { routeHexColors } from './config.js';
import { cleanDestination } from './ui.js';

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
    panel.innerHTML = `
        <div class="eta-dbg-header">
            <span>ETA Debug <span class="eta-dbg-hint">(\`)</span></span>
            <button class="eta-dbg-close" title="Close">×</button>
        </div>
        <div class="eta-dbg-scroll">
            <table class="eta-dbg-table">
                <thead><tr>
                    <th>Rt</th>
                    <th>To</th>
                    <th>Veh</th>
                    <th>GTFS</th>
                    <th>Calc</th>
                    <th>Δs</th>
                </tr></thead>
                <tbody id="eta-dbg-body"></tbody>
            </table>
        </div>
        <div class="eta-dbg-footer" id="eta-dbg-footer">Waiting for data…</div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('.eta-dbg-close').addEventListener('click', () => setVisible(false));
    document.addEventListener('keydown', e => {
        if (e.key === '`') setVisible(!visible);
    });

    setVisible(true);
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
    if (sec < -30) return '—';
    if (sec <= 30) return 'Now';
    if (sec < 60) return `${sec}s`;
    return `${Math.round(sec / 60)}m`;
}

function refresh() {
    const now = Math.floor(Date.now() / 1000);
    const arrivalsData = window.masterArrivalsData;
    const footer = document.getElementById('eta-dbg-footer');

    const activeStopIds = getActiveStopIds();
    if (!activeStopIds?.length) {
        const tbody = document.getElementById('eta-dbg-body');
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="dbg-empty">Select a station to compare ETAs</td></tr>`;
        if (footer) footer.textContent = 'No station selected';
        return;
    }

    if (!arrivalsData?.size) {
        if (footer) footer.textContent = 'No GTFS-RT data yet…';
        return;
    }

    const rows = [];
    const seen = new Set();

    activeStopIds.forEach(stopId => {
        const gtfsList = arrivalsData.get(stopId) ?? [];
        const ourList = getScheduledArrivals(stopId);
        const ourByVeh = new Map(ourList.map(a => [`${a.vehicleId}-${a.routeId}`, a]));

        gtfsList.forEach(gtfs => {
            if (gtfs.arrivalUnix < now - 30) return;
            const key = `${stopId}-${gtfs.vehicleId}-${gtfs.routeId}`;
            if (seen.has(key)) return;
            seen.add(key);

            const ourEntry = ourByVeh.get(`${gtfs.vehicleId}-${gtfs.routeId}`);
            const delta = ourEntry != null
                ? Math.round(ourEntry.arrivalUnix - gtfs.arrivalUnix)
                : null;

            const tripInfo = gtfs.tripId ? window.masterTripsData?.[gtfs.tripId] : null;
            let dest = tripInfo?.dest ? cleanDestination(tripInfo.dest) : null;
            if (!dest && tripInfo?.stops?.length) {
                const lastId = [...tripInfo.stops].reverse().find(s => s);
                const lastStop = lastId ? window.masterStopsData?.[String(lastId)] : null;
                if (lastStop?.name) dest = cleanStationName(lastStop.name);
            }
            dest = dest ?? getTerminalName(gtfs.routeId, gtfs.directionId) ?? `Dir ${gtfs.directionId}`;

            rows.push({
                routeId:   gtfs.routeId,
                dest:      dest.length > 16 ? dest.slice(0, 15) + '…' : dest,
                vehicleId: String(gtfs.vehicleId),
                gtfsUnix:  gtfs.arrivalUnix,
                ourUnix:   ourEntry?.arrivalUnix ?? null,
                delta,
            });
        });
    });

    rows.sort((a, b) => a.gtfsUnix - b.gtfsUnix);

    const tbody = document.getElementById('eta-dbg-body');
    if (!tbody) return;

    tbody.innerHTML = rows.slice(0, 30).map(r => {
        const letter = ROUTE_LETTER[r.routeId] ?? r.routeId;
        const color  = routeHexColors[r.routeId] ?? '#888';
        const veh    = r.vehicleId.slice(-4);

        let deltaClass = '', deltaStr = '—';
        if (r.delta != null) {
            deltaStr  = r.delta >= 0 ? `+${r.delta}` : `${r.delta}`;
            deltaClass = Math.abs(r.delta) < 60  ? 'dbg-ok'
                       : Math.abs(r.delta) < 120 ? 'dbg-warn'
                       : 'dbg-bad';
        }

        return `<tr>
            <td><span class="dbg-badge" style="background:${color}">${letter}</span></td>
            <td class="dbg-stop">${r.dest}</td>
            <td class="dbg-veh">${veh}</td>
            <td>${fmtEta(r.gtfsUnix)}</td>
            <td>${fmtEta(r.ourUnix)}</td>
            <td class="${deltaClass}">${deltaStr}</td>
        </tr>`;
    }).join('');

    if (footer) {
        const matched = rows.filter(r => r.delta != null).length;
        footer.textContent = `${rows.length} rows · ${matched} matched · ${new Date().toLocaleTimeString()}`;
    }
}
