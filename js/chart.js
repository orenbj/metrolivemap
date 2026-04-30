/**
 * chart.js
 * Sparkline chart showing total active vehicle count over the current day.
 * Samples once per minute (time-gated inside recordSample), persisted in
 * localStorage so the chart survives page refreshes within the same day.
 */

const STORAGE_KEY        = 'livemap-vehicle-history';
const SVG_W              = 216;   // px — matches viewBox in index.html
const SVG_H              = 44;    // px
const DAY_SECS           = 86400;
const BOTTOM_MARGIN      = 3;     // px so baseline stroke isn't clipped
const TOP_MARGIN         = 4;     // px so top dot isn't clipped
const PLOT_H             = SVG_H - BOTTOM_MARGIN - TOP_MARGIN; // 37 px

// Module state
let _history = { date: '', samples: [] }; // { date: 'YYYY-MM-DD', samples: [{t, n}] }
let _lastSampleMinute = -1;               // prevents >1 sample per wall-clock minute

// ── Time helpers ──────────────────────────────────────────────────────────────

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowMinute() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

function secOfDay(unixSec) {
    const d = new Date(unixSec * 1000);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

function currentSecOfDay() {
    const d = new Date();
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// ── localStorage ──────────────────────────────────────────────────────────────

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed?.date === todayStr() && Array.isArray(parsed.samples)) {
            _history = parsed;
        }
    } catch (_) { /* corrupt — start fresh */ }
}

function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_history)); }
    catch (_) { /* quota / private browsing — silently skip */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once from main.js at startup.
 * Restores today's history, advances the hairline every 60 s, renders initial chart.
 */
export function initChart() {
    load();
    _history.date = todayStr();
    if (!Array.isArray(_history.samples)) _history.samples = [];

    // Advance the "now" hairline even when no new vehicles arrive
    setInterval(renderChart, 60_000);

    renderChart();
}

/**
 * Call from updateDataPanel() in ui.js on every WS update.
 * Time-gated: only records one sample per wall-clock minute.
 * Handles midnight rollover on long-lived pages.
 */
export function recordSample(count) {
    const minute = nowMinute();
    if (minute === _lastSampleMinute) return;

    const today = todayStr();
    if (_history.date !== today) {
        _history = { date: today, samples: [] };
    }

    _lastSampleMinute = minute;
    _history.samples.push({ t: Math.floor(Date.now() / 1000), n: count });
    save();
    renderChart();
}

// ── SVG rendering ─────────────────────────────────────────────────────────────

export function renderChart() {
    const el = document.getElementById('vehicle-chart');
    if (!el) return;

    const samples = _history.samples;

    if (samples.length === 0) {
        el.innerHTML = `<text x="${SVG_W / 2}" y="${SVG_H / 2 + 4}"
            text-anchor="middle" font-size="9" fill="var(--text-muted)"
            font-family="sans-serif">No data yet today</text>`;
        return;
    }

    // Coordinate helpers
    const maxN = Math.max(...samples.map(s => s.n), 1);
    const yMax = maxN * 1.2;
    const bottom = SVG_H - BOTTOM_MARGIN;

    const xOf = s  => (secOfDay(s.t) / DAY_SECS) * SVG_W;
    const yOf = n  => TOP_MARGIN + PLOT_H - (n / yMax) * PLOT_H;

    // Area path (closed polygon) and stroke path (open polyline)
    let area = '', stroke = '';
    samples.forEach((s, i) => {
        const x = xOf(s), y = yOf(s.n);
        if (i === 0) {
            area   = `M ${x} ${bottom} L ${x} ${y}`;
            stroke = `M ${x} ${y}`;
        } else {
            area   += ` L ${x} ${y}`;
            stroke += ` L ${x} ${y}`;
        }
    });
    area += ` L ${xOf(samples[samples.length - 1])} ${bottom} Z`;

    // Latest-point dot
    const last = samples[samples.length - 1];
    const dotX = xOf(last), dotY = yOf(last.n);

    // Current-time hairline
    const hairX = (currentSecOfDay() / DAY_SECS) * SVG_W;

    // Hour tick labels
    const ticks = [[21600, '6am'], [43200, '12pm'], [64800, '6pm']].map(([ts, label]) => {
        const tx = (ts / DAY_SECS) * SVG_W;
        return `<text x="${tx}" y="${SVG_H - 1}" text-anchor="middle"
            font-size="7" fill="var(--text-muted)" font-family="sans-serif"
            opacity="0.7">${label}</text>`;
    }).join('');

    el.innerHTML = `
        <path d="${area}" fill="#0072bc" fill-opacity="0.15" stroke="none"/>
        <path d="${stroke}" fill="none" stroke="#0072bc" stroke-opacity="0.8"
              stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        <line x1="${hairX}" y1="${TOP_MARGIN}" x2="${hairX}" y2="${bottom}"
              stroke="var(--text-muted)" stroke-opacity="0.4" stroke-width="1"/>
        <circle cx="${dotX}" cy="${dotY}" r="3" fill="#0072bc"/>
        ${ticks}`;
}
