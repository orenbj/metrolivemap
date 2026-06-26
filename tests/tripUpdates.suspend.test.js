/**
 * Hidden-tab feed-suspend → resume staleness-clock reset (tripUpdates.js).
 *
 * The station popup's "⚠ Live <feed> delayed (Nm)" banner is driven by
 * getTripUpdatesFeedHealth() (the last-frame clock). A DELIBERATE hidden-tab
 * suspend freezes that clock; without a reset, returning to the tab renders the
 * whole away-duration as a feed "delay" until the first reconnected frame lands.
 * resumeFeeds() anchors the clock to NOW so a power-save is never shown as a
 * Metro feed problem — while still aging normally so a genuinely failed
 * reconnect re-fires the banner after FEED_STALE_THRESHOLD_S.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), setConnectionStatus: vi.fn(), updateDataPanel: vi.fn(),
    getPopupHTML: vi.fn(() => ''), cleanDestination: s => s,
    updateUpdateTime: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));

class MockWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.OPEN;
        this.onopen = this.onclose = this.onerror = this.onmessage = null;
        this.send = vi.fn();
        this.close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); });
    }
}
MockWebSocket.OPEN = 1;

import { suspendFeeds, resumeFeeds, getTripUpdatesFeedHealth } from '../js/tripUpdates.js';

beforeEach(() => {
    vi.useFakeTimers();
    global.WebSocket = MockWebSocket;
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('feed suspend/resume — staleness-clock reset', () => {
    it('resume anchors the feed-health clock to now (a deliberate suspend is not a "delayed" feed)', () => {
        // Boot health is { rail: 0, bus: 0 }. Without the reset, a suspend→resume
        // would leave the clock at its frozen value; the fix sets it to now.
        suspendFeeds();   // _feedsSuspended = true
        resumeFeeds();    // resets the clock + reconnects (mock sockets)

        const now = Math.floor(Date.now() / 1000);
        const h = getTripUpdatesFeedHealth();
        // Within a couple seconds of now (NOT the stale 0 it would be without the fix).
        expect(h.rail).toBeGreaterThanOrEqual(now - 2);
        expect(h.bus).toBeGreaterThanOrEqual(now - 2);
    });

    it('resume is a no-op when not suspended (does not clobber a live clock)', () => {
        // Not suspended → early return → health untouched.
        const before = getTripUpdatesFeedHealth();
        resumeFeeds();
        expect(getTripUpdatesFeedHealth()).toEqual(before);
    });
});
