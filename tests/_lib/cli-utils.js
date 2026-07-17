/**
 * tests/_lib/cli-utils.js — tiny shared helpers for the scripts/ CLI harnesses
 * (audit-feeds.js, live-accuracy-harness.js, live-accuracy-headless.js,
 * perf-baseline.js). Lives under tests/_lib alongside accuracy-aggregator.js
 * since that's the established shared-code location these scripts already
 * import from — kept in its own file since parseDuration is generic CLI
 * arg-parsing, not accuracy-aggregation logic.
 */

/**
 * Parse a duration flag value like "30m", "45s", "2h" into milliseconds.
 * Defaults to minutes when no unit suffix is given. Returns null for an
 * unparseable value (including null/undefined, via optional chaining).
 * @param {string|null|undefined} v
 * @returns {number|null}
 */
export function parseDuration(v) {
    const m = v?.match?.(/^(\d+)(s|m|min|h)?$/);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2] ?? 'm';
    return n * (unit === 's' ? 1000 : unit === 'h' ? 3_600_000 : 60_000);
}
