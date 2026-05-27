/**
 * @module errorBoundary
 *
 * Global error-handling boundary. Catches uncaught exceptions and unhandled
 * promise rejections that would otherwise propagate to the browser's silent
 * default handler — and at that point the map is functionally broken with
 * no rider-visible signal.
 *
 * Two behaviors:
 *   1. **Telemetry**: every caught error increments a counter in feedStats
 *      so we can see error spikes in the localStorage ring buffer and in
 *      the offline analyzer. Cited as `globalErrors` and `unhandledRejections`.
 *   2. **Recovery banner**: when error rate exceeds a small burst threshold
 *      (3 errors within 30 s), shows a dismissable banner telling the rider
 *      to refresh. Single-fire per session — repeated bursts don't stack
 *      banners.
 *
 * Why not crash-replace the whole UI: a single transient error (e.g., a
 * malformed WS frame, a MapLibre repaint glitch) often recovers on its own
 * and the rider doesn't notice. The threshold gates the banner to actual
 * sustained breakage. The telemetry counter is unconditional.
 */

import { recordMarkerDrop } from './feedStats.js';

const _BURST_WINDOW_MS = 30_000;
const _BURST_THRESHOLD = 3;

let _bannerShown = false;
const _recentErrors = [];

/**
 * Trim `_recentErrors` to entries within the burst window ending at `now`.
 * Returns the number of errors remaining (length after trim).
 */
function _trimRecent(now) {
    const cutoff = now - _BURST_WINDOW_MS;
    while (_recentErrors.length && _recentErrors[0] < cutoff) {
        _recentErrors.shift();
    }
    return _recentErrors.length;
}

/**
 * Record one error event. Increments the feedStats counter and triggers the
 * banner if the burst threshold has been crossed within the window.
 *
 * @param {string} kind  'globalErrors' | 'unhandledRejections'
 * @param {Date|number} [nowOverride]  test seam — defaults to Date.now()
 */
export function _recordError(kind, nowOverride) {
    try { recordMarkerDrop(kind); } catch { /* feedStats may not be ready */ }

    const now = nowOverride != null ? +nowOverride : Date.now();
    _recentErrors.push(now);
    const inWindow = _trimRecent(now);

    if (inWindow >= _BURST_THRESHOLD && !_bannerShown) {
        _bannerShown = true;
        _showRecoveryBanner();
    }
}

/**
 * Render the recovery banner. Safe to call from non-DOM contexts (test env)
 * — no-ops if `document.body` is missing.
 */
function _showRecoveryBanner() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.getElementById('error-recovery-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'error-recovery-banner';
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#b22222;color:#fff;padding:8px 40px 8px 12px;font:14px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.3);';
    banner.textContent = 'Something went wrong. The map may be out of date — refresh to recover.';

    const close = document.createElement('button');
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 8px;';
    close.addEventListener('click', () => banner.remove());
    banner.appendChild(close);

    document.body.appendChild(banner);
}

/**
 * Install global error and unhandled-rejection listeners. Idempotent — calling
 * twice is a no-op. Call this as early as possible in main.js so failures
 * during data-promise resolution and module init are captured.
 */
export function installErrorBoundary() {
    if (typeof window === 'undefined') return;
    if (window._errorBoundaryInstalled) return;
    window._errorBoundaryInstalled = true;

    window.addEventListener('error', (event) => {
        // event.error is sometimes null (e.g., script-load errors from a different
        // origin without CORS). Log what we have; record the event regardless.
        console.error('[errorBoundary] uncaught:', event.error || event.message);
        _recordError('globalErrors');
    });

    window.addEventListener('unhandledrejection', (event) => {
        console.error('[errorBoundary] unhandled rejection:', event.reason);
        _recordError('unhandledRejections');
    });
}

/**
 * Test-only reset. Clears module state so tests start from a clean slate.
 */
export function _resetForTest() {
    _bannerShown = false;
    _recentErrors.length = 0;
    if (typeof window !== 'undefined') delete window._errorBoundaryInstalled;
    if (typeof document !== 'undefined' && document.getElementById) {
        document.getElementById('error-recovery-banner')?.remove();
    }
}
