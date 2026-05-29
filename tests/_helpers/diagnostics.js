/**
 * Diagnostic helpers for tests that emit aggregate metrics (spike-gate
 * firing rates, prediction error percentiles, snap-deviation spreads, …).
 *
 * Tests use these to log structured tables that survive copy-paste into
 * chat without column-merging — same pattern as the browser harness's
 * consoleTablePlus().
 */

/**
 * Compute simple distribution stats for an array of numeric samples.
 * Returns null when empty.
 */
export function statsOf(samples) {
    const n = samples.length;
    if (n === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
    const mean = samples.reduce((a, b) => a + b, 0) / n;
    return { n, mean, p10: pct(0.10), p50: pct(0.50), p90: pct(0.90),
             min: sorted[0], max: sorted[n - 1] };
}

/**
 * Format a numeric value compactly: 1 decimal place, or '—' for nullish.
 */
export function fmt(v, places = 1) {
    if (v == null || !Number.isFinite(v)) return '—';
    return v.toFixed(places);
}

/**
 * Print a markdown table to console. Each row is an object; columns are the
 * union of all keys (preserving first-seen order). Survives copy-paste.
 */
export function logMarkdownTable(label, rows) {
    if (!rows?.length) {
        console.log(`\n[${label}] (no rows)\n`);
        return;
    }
    const keys = [];
    const seen = new Set();
    for (const r of rows) {
        for (const k of Object.keys(r)) {
            if (!seen.has(k)) { seen.add(k); keys.push(k); }
        }
    }
    const header = `| ${keys.join(' | ')} |`;
    const sep    = `| ${keys.map(() => '---').join(' | ')} |`;
    const body   = rows.map(r => `| ${keys.map(k => r[k] ?? '').join(' | ')} |`).join('\n');
    console.log(`\n[${label}]\n${header}\n${sep}\n${body}\n`);
}
