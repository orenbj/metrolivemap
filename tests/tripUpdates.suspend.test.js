/**
 * Hidden-tab feed-suspend → resume (tripUpdates.js). Mirrors
 * tests/api.suspend.test.js's deferred-onclose regression coverage, applied to
 * this module's suspendFeeds/resumeFeeds mirror — added because that fix
 * shipped (PR #559) without its own regression test; only the staleness-clock
 * behavior below was originally covered.
 *
 * Two independent things are pinned here:
 *
 * 1. STALENESS CLOCK: the station popup's "⚠ Live <feed> delayed (Nm)" banner
 *    is driven by getTripUpdatesFeedHealth() (the last-frame clock). A
 *    DELIBERATE hidden-tab suspend freezes that clock; without a reset,
 *    returning to the tab renders the whole away-duration as a feed "delay"
 *    until the first reconnected frame lands. resumeFeeds() anchors the clock
 *    to NOW so a power-save is never shown as a Metro feed problem — while
 *    still aging normally so a genuinely failed reconnect re-fires the banner
 *    after FEED_STALE_THRESHOLD_S.
 *
 * 2. THE RECONNECT RACE (whole-app-audit HIGH, same commit as api.js's fix):
 *    suspendFeeds() must empty _activeSockets SYNCHRONOUSLY, not rely on the
 *    async onclose to do it. Real browsers fire onclose asynchronously (after
 *    the close handshake; on a mobile unfreeze, in the wake-up burst around
 *    the visibility change). If resumeFeeds() ran before those deferred
 *    onclose events, every socket still looked "active" and was skipped — and
 *    the per-socket _suspendClose guard then blocked onclose from ever
 *    scheduling a reconnect. All feeds dead until the next long backgrounding
 *    or a reload. The deferred-onclose test below is the regression guard.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    // markers.js imports this for the marker accessible name (R6-02); a mock
    // missing it fails the module load, not the assertion.
    vehicleAriaLabel: vi.fn(() => 'vehicle'),
    showToast: vi.fn(), setConnectionStatus: vi.fn(), updateDataPanel: vi.fn(),
    getPopupHTML: vi.fn(() => ''), cleanDestination: s => s,
    updateUpdateTime: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));

import { initTripUpdates, suspendFeeds, resumeFeeds, getTripUpdatesFeedHealth, _resetFeedsForTest } from '../js/tripUpdates.js';
import { resetGlobals } from './_helpers/globals.js';
import { createMockWebSocket } from './_helpers/mockWebSocket.js';

// close() fires onclose SYNCHRONOUSLY by default — real-ish, and matches
// every test except the deferred-onclose regression test below, which
// overrides close() per-instance to model a real browser's async close.
const { MockWebSocket, sockets: _sockets } = createMockWebSocket();

const openCount = () => _sockets.filter(s => s.readyState === MockWebSocket.OPEN).length;

beforeEach(() => {
    vi.useFakeTimers();
    _sockets.length = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    global.WebSocket = MockWebSocket;
    resetGlobals();       // clears window.masterArrivalsData
    _resetFeedsForTest();  // clears _activeSockets/_pendingReconnects, allows re-init
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('feed suspend/resume — staleness-clock reset', () => {
    it('resume anchors the feed-health clock to now (a deliberate suspend is not a "delayed" feed)', () => {
        initTripUpdates();   // opens rail + bus sockets
        suspendFeeds();
        resumeFeeds();
        const now = Math.floor(Date.now() / 1000);
        const h = getTripUpdatesFeedHealth();
        expect(h.rail).toBeGreaterThanOrEqual(now - 2);
        expect(h.bus).toBeGreaterThanOrEqual(now - 2);
    });

    it('resume is a no-op when not suspended (does not clobber a live clock)', () => {
        initTripUpdates();
        const before = getTripUpdatesFeedHealth();
        resumeFeeds();
        expect(getTripUpdatesFeedHealth()).toEqual(before);
    });
});

describe('feed suspend/resume — the reconnect race (whole-app-audit HIGH)', () => {
    it('re-opens both feeds after a normal suspend (synchronous onclose)', () => {
        initTripUpdates();
        expect(openCount()).toBe(2);   // rail + bus
        suspendFeeds();
        expect(openCount()).toBe(0);   // both closed
        resumeFeeds();
        expect(openCount()).toBe(2);   // both re-opened
    });

    it('re-opens both feeds even when onclose is DEFERRED (the regression case)', () => {
        // Every OTHER test in this file uses the default synchronous-onclose mock,
        // which fires onclose inline inside close() — so _activeSockets is always
        // already empty by the time resume runs, structurally unable to see this
        // bug. Here we DEFER onclose per-socket: close() flips readyState but does
        // NOT call onclose, so both sockets are STILL in _activeSockets when
        // resumeFeeds() runs — exactly the race a fast tab-return produces.
        initTripUpdates();
        for (const s of _sockets) {
            s.close = vi.fn(() => { s.readyState = MockWebSocket.CLOSED; /* onclose deferred */ });
        }
        expect(openCount()).toBe(2);

        suspendFeeds();
        // Both sockets report CLOSED (close() ran) even though onclose never fired
        // and neither has been removed from _activeSockets by the (never-called)
        // handler — the synchronous _activeSockets.clear() in suspendFeeds() is
        // what resumeFeeds() must rely on instead.
        expect(openCount()).toBe(0);

        const before = _sockets.length;
        resumeFeeds();
        const reopened = _sockets.slice(before);
        expect(reopened).toHaveLength(2);   // WITHOUT the fix this is 0 — resume
                                             // sees both urls "active" and skips them.
        expect(openCount()).toBe(2);
    });
});
