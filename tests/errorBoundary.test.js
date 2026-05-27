/**
 * Tests for js/errorBoundary.js — the global window.onerror /
 * unhandledrejection capture layer.
 *
 * What's exercised here:
 *   - Idempotent installation (calling twice is a no-op)
 *   - Telemetry counter is incremented on every error event
 *   - Burst-threshold banner appears after 3 errors in 30s
 *   - Banner is one-shot (does not stack on subsequent bursts)
 *   - Banner is dismissable and renders into document.body
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../js/feedStats.js', () => ({
    recordMarkerDrop: vi.fn(),
}));

import { installErrorBoundary, _recordError, _resetForTest } from '../js/errorBoundary.js';
import { recordMarkerDrop } from '../js/feedStats.js';

beforeEach(() => {
    _resetForTest();
    document.body.innerHTML = '';
    recordMarkerDrop.mockClear();
});

describe('installErrorBoundary', () => {
    it('attaches an `error` listener and an `unhandledrejection` listener', () => {
        const spy = vi.spyOn(window, 'addEventListener');
        installErrorBoundary();
        const events = spy.mock.calls.map(c => c[0]);
        expect(events).toContain('error');
        expect(events).toContain('unhandledrejection');
        spy.mockRestore();
    });

    it('is idempotent — second call does not re-register listeners', () => {
        const spy = vi.spyOn(window, 'addEventListener');
        installErrorBoundary();
        const firstCount = spy.mock.calls.length;
        installErrorBoundary();
        expect(spy.mock.calls.length).toBe(firstCount);
        spy.mockRestore();
    });
});

describe('_recordError — telemetry counter', () => {
    it('increments globalErrors counter on a window.onerror event', () => {
        _recordError('globalErrors');
        expect(recordMarkerDrop).toHaveBeenCalledWith('globalErrors');
    });

    it('increments unhandledRejections counter on a promise rejection event', () => {
        _recordError('unhandledRejections');
        expect(recordMarkerDrop).toHaveBeenCalledWith('unhandledRejections');
    });
});

describe('_recordError — burst banner', () => {
    it('does NOT show the banner after 2 errors in the window', () => {
        const now = 1_700_000_000_000;
        _recordError('globalErrors', now);
        _recordError('globalErrors', now + 5_000);
        expect(document.getElementById('error-recovery-banner')).toBeNull();
    });

    it('shows the banner after 3 errors within the 30s window', () => {
        const now = 1_700_000_000_000;
        _recordError('globalErrors', now);
        _recordError('globalErrors', now + 5_000);
        _recordError('globalErrors', now + 10_000);
        const banner = document.getElementById('error-recovery-banner');
        expect(banner).not.toBeNull();
        expect(banner.getAttribute('role')).toBe('alert');
        expect(banner.textContent).toMatch(/refresh/i);
    });

    it('does NOT show the banner when 3 errors span more than 30s', () => {
        const now = 1_700_000_000_000;
        _recordError('globalErrors', now);
        _recordError('globalErrors', now + 20_000);
        _recordError('globalErrors', now + 35_000);
        // First error is now outside the 30s window from the third — only 2 in window
        expect(document.getElementById('error-recovery-banner')).toBeNull();
    });

    it('mixes globalErrors + unhandledRejections in the burst count', () => {
        const now = 1_700_000_000_000;
        _recordError('globalErrors',         now);
        _recordError('unhandledRejections',  now + 1_000);
        _recordError('globalErrors',         now + 2_000);
        expect(document.getElementById('error-recovery-banner')).not.toBeNull();
    });

    it('is one-shot — second burst within the session does not re-create the banner', () => {
        const now = 1_700_000_000_000;
        _recordError('globalErrors', now);
        _recordError('globalErrors', now + 1_000);
        _recordError('globalErrors', now + 2_000);
        const first = document.getElementById('error-recovery-banner');
        first.remove();   // simulate user dismissal

        // Trigger another burst — banner should NOT re-appear
        _recordError('globalErrors', now + 60_000);
        _recordError('globalErrors', now + 61_000);
        _recordError('globalErrors', now + 62_000);
        expect(document.getElementById('error-recovery-banner')).toBeNull();
    });

    it('renders a dismiss button that removes the banner from the DOM', () => {
        const now = 1_700_000_000_000;
        _recordError('globalErrors', now);
        _recordError('globalErrors', now + 1_000);
        _recordError('globalErrors', now + 2_000);

        const banner = document.getElementById('error-recovery-banner');
        expect(banner).not.toBeNull();
        const close = banner.querySelector('button[aria-label="Dismiss"]');
        expect(close).not.toBeNull();
        close.click();
        expect(document.getElementById('error-recovery-banner')).toBeNull();
    });
});
