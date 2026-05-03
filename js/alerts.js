/**
 * alerts.js
 * Subscribes to the Metro GTFS-RT service_alerts WebSocket feed and maintains
 * a live lookup of active alerts per route:
 *
 *   window.masterAlertsData = Map { routeCode → Alert[] }
 *   Alert = { id, effect, header, description, activePeriod: { start, end } }
 *
 * Exports getActiveAlerts(routeCode) and updateAlertBadges() for use by the
 * station popup (stations.js) and legend (ui.js).
 */

const ALERTS_WS_URL      = 'wss://api.metro.net/ws/LACMTA_Rail/service_alerts';
const RECONNECT_DELAY_MS = 5000;

export function initAlerts() {
    window.masterAlertsData = new Map();
    _connect();
}

function _connect() {
    const ws = new WebSocket(ALERTS_WS_URL);
    ws.onerror = () => ws.close();
    ws.onclose = () => setTimeout(_connect, RECONNECT_DELAY_MS);
    ws.onmessage = e => {
        try { _processMsg(JSON.parse(e.data)); } catch { /* ignore malformed frames */ }
    };
}

function _processMsg(msg) {
    // GTFS-RT FeedMessage: full snapshot as entity array — replace all data
    if (Array.isArray(msg.entity)) {
        window.masterAlertsData.clear();
        for (const entity of msg.entity) {
            if (entity.alert) _ingest(entity.id ?? '', entity.alert);
        }
        updateAlertBadges();
        return;
    }
    // Single alert push — merge/update
    if (msg.alert) {
        _ingest(msg.id ?? '', msg.alert);
        _prune();
        updateAlertBadges();
    }
}

function _ingest(id, alert) {
    const now    = Math.floor(Date.now() / 1000);
    const period = alert.activePeriod?.[0] ?? {};
    const start  = Number(period.start ?? 0);
    const end    = Number(period.end   ?? 0) || Infinity;
    if (end < now) return;

    const routeCodes = new Set();
    for (const ie of (alert.informedEntity ?? [])) {
        const rc = String(ie.routeId ?? '').split('-')[0];
        if (rc) routeCodes.add(rc);
    }

    const header = _text(alert.headerText);
    const desc   = _text(alert.descriptionText);
    const effect = alert.effect ?? '';

    for (const rc of routeCodes) {
        if (!window.masterAlertsData.has(rc)) window.masterAlertsData.set(rc, []);
        const list    = window.masterAlertsData.get(rc);
        const idx     = list.findIndex(a => a.id === id);
        const entry   = { id, effect, header, description: desc, activePeriod: { start, end } };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
    }
}

function _text(textObj) {
    if (!textObj) return '';
    const translations = textObj.translation ?? [];
    const t = translations.find(t => t.language === 'en') ?? translations[0];
    return t?.text ?? '';
}

function _prune() {
    const now = Math.floor(Date.now() / 1000);
    window.masterAlertsData.forEach((list, rc) => {
        const fresh = list.filter(a => a.activePeriod.end > now);
        if (fresh.length === 0) window.masterAlertsData.delete(rc);
        else window.masterAlertsData.set(rc, fresh);
    });
}

export function getActiveAlerts(routeCode) {
    if (!window.masterAlertsData) return [];
    const now = Math.floor(Date.now() / 1000);
    return (window.masterAlertsData.get(String(routeCode)) ?? [])
        .filter(a => a.activePeriod.end > now);
}

export function updateAlertBadges() {
    document.querySelectorAll('.legend-row[data-route]').forEach(row => {
        const rc       = row.getAttribute('data-route');
        const hasAlert = getActiveAlerts(rc).length > 0;
        let   badge    = row.querySelector('.alert-badge');

        if (hasAlert && !badge) {
            const img = row.querySelector('img');
            if (!img) return;
            // Wrap the icon in a relative container so the badge can be positioned
            let wrap = img.parentNode.classList?.contains('alert-icon-wrap')
                ? img.parentNode
                : null;
            if (!wrap) {
                wrap = document.createElement('div');
                wrap.className = 'alert-icon-wrap';
                img.parentNode.insertBefore(wrap, img);
                wrap.appendChild(img);
            }
            badge = document.createElement('span');
            badge.className = 'alert-badge';
            badge.setAttribute('aria-label', 'Service alert');
            badge.textContent = '!';
            wrap.appendChild(badge);
        } else if (!hasAlert && badge) {
            const wrap = badge.parentNode;
            badge.remove();
            // Unwrap icon if we own the wrapper
            if (wrap?.classList.contains('alert-icon-wrap')) {
                const img = wrap.querySelector('img');
                if (img) wrap.parentNode.insertBefore(img, wrap);
                wrap.remove();
            }
        }
    });
}
