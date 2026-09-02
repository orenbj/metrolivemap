/**
 * Hidden-tab feed suspend (Batch D1).
 *
 * While the tab is hidden the live WS feeds receive + parse a firehose nobody
 * is watching (~170 vehicle frames/s here, ~850 trip_update frames/s in the
 * other module). After WS_HIDDEN_SUSPEND_MS hidden, every feed is CLOSED to
 * stop that cost; on return the feeds re-open fresh (Metro re-sends a full
 * snapshot). These tests pin: the grace timer (no suspend before the window,
 * suspend after), that a suspended close neither reconnects nor flashes
 * offline, and that resume re-opens exactly the known feeds.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('../js/markers.js', () => ({ processVehicleData: vi.fn() }));
vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());

import { setupWebSocket, initVisibilityHandler, suspendFeeds, resumeFeeds, _resetFeedsForTest } from '../js/api.js';
import { showToast, setConnectionStatus } from '../js/ui.js';
import { WS_HIDDEN_SUSPEND_MS } from '../js/config.js';
import { createMockWebSocket, makeSocketOpener } from './_helpers/mockWebSocket.js';

// close() flips state and fires onclose synchronously (real-ish) so the
// suspend path's "close → onclose → return without reconnect" is observable.
const { MockWebSocket, sockets: _sockets } = createMockWebSocket();

// openSocket(url) registers the socket in _activeSockets (via onopen).
const openSocket = makeSocketOpener(setupWebSocket, _sockets);

const openCount = () => _sockets.filter(s => s.readyState === MockWebSocket.OPEN).length;

beforeEach(() => {
    vi.useFakeTimers();
    _sockets.length = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    global.WebSocket = MockWebSocket;
    _resetFeedsForTest();
    setConnectionStatus.mockClear();
    showToast.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('suspendFeeds', () => {
    it('closes every active feed with _suspendClose set', () => {
        const a = openSocket('wss://test/rail');
        const b = openSocket('wss://test/bus');
        suspendFeeds();
        expect(a.close).toHaveBeenCalledTimes(1);
        expect(b.close).toHaveBeenCalledTimes(1);
        expect(a._suspendClose).toBe(true);
        expect(b._suspendClose).toBe(true);
        expect(openCount()).toBe(0);
    });

    it('a suspended close neither reconnects nor flashes offline', () => {
        openSocket('wss://test/rail');
        suspendFeeds();                       // close() fires onclose synchronously
        vi.advanceTimersByTime(60_000);       // well past any reconnect delay
        expect(_sockets).toHaveLength(1);     // no reconnect socket constructed
        expect(setConnectionStatus).not.toHaveBeenCalledWith('offline');
        expect(showToast).not.toHaveBeenCalled();
    });

    it('cancels an in-flight reconnect so it cannot re-open during suspension', () => {
        const s = openSocket('wss://test/rail');
        // Non-deliberate drop schedules a backoff reconnect…
        s.readyState = MockWebSocket.CLOSED;
        s.onclose?.();
        // …then we suspend before it fires.
        suspendFeeds();
        vi.advanceTimersByTime(60_000);
        // Only the original socket — the pending reconnect was cancelled.
        expect(_sockets).toHaveLength(1);
    });

    it('is idempotent', () => {
        const a = openSocket('wss://test/rail');
        suspendFeeds();
        suspendFeeds();
        expect(a.close).toHaveBeenCalledTimes(1);
    });

    it('closes a socket still CONNECTING at suspend time (tracked at creation, not onopen)', () => {
        // A reconnect mid-handshake when the grace window expires: onopen has NOT
        // fired. Because the socket is registered in _activeSockets at creation,
        // suspend still closes it — otherwise it would connect later and run the
        // firehose live for the whole hidden window.
        setupWebSocket('wss://test/rail', null);
        const s = _sockets[_sockets.length - 1];
        s.readyState = MockWebSocket.CONNECTING;   // handshake not finished
        suspendFeeds();
        expect(s.close).toHaveBeenCalledTimes(1);
        expect(s._suspendClose).toBe(true);
    });
});

describe('resumeFeeds', () => {
    it('re-opens every known feed after a suspend', () => {
        openSocket('wss://test/rail');
        openSocket('wss://test/bus');
        suspendFeeds();
        const before = _sockets.length;
        resumeFeeds(null);
        const reopened = _sockets.slice(before).map(s => s.url).sort();
        expect(reopened).toEqual(['wss://test/bus', 'wss://test/rail']);
    });

    it('re-opens feeds even when onclose is DEFERRED (the suspend/resume race)', () => {
        // Regression test for the whole-app-audit HIGH finding. Real browsers fire
        // onclose ASYNChronously (after the close handshake; on a mobile unfreeze, in
        // the wake-up burst around the visibility change). The other tests use a mock
        // whose close() fires onclose synchronously, so _activeSockets is always
        // already empty at resume — masking the bug. Here we DEFER onclose: close()
        // flips state but does not fire onclose, so onclose has NOT removed the sockets
        // from _activeSockets when resume runs. suspendFeeds() must empty the registry
        // synchronously; otherwise resume skips both "still-active" urls and the feeds
        // stay dead until the next long backgrounding or a reload.
        const a = openSocket('wss://test/rail');
        const b = openSocket('wss://test/bus');
        for (const s of [a, b]) s.close = () => { s.readyState = MockWebSocket.CLOSED; /* onclose deferred */ };
        suspendFeeds();
        const before = _sockets.length;
        resumeFeeds(null);
        const reopened = _sockets.slice(before).map(s => s.url).sort();
        expect(reopened).toEqual(['wss://test/bus', 'wss://test/rail']);
    });

    it('a stale socket’s deferred onclose does not deregister its replacement (post-resume clobber)', () => {
        // Follow-on to the deferred-onclose race: _activeSockets is keyed by URL, so
        // when resume opens a REPLACEMENT socket for the same URL before the old
        // (suspended) socket's deferred onclose flushes, an unconditional delete in
        // that late onclose removes the NEW socket's entry — leaving the live feed
        // unmanaged (escapes the next suspend, duplicated on the following resume).
        // The identity guard (`_activeSockets.get(url) === socket`) makes the stale
        // onclose a no-op.
        const a = openSocket('wss://test/rail');
        a.close = () => { a.readyState = MockWebSocket.CLOSED; /* onclose deferred */ };
        suspendFeeds();
        resumeFeeds(null);
        const b = _sockets[_sockets.length - 1];
        expect(b.url).toBe('wss://test/rail');

        // The OLD socket's deferred onclose finally fires, AFTER resume registered b.
        a.onclose();

        // b must still be tracked: a fresh suspend has to close it. Without the guard
        // a.onclose would have removed b from _activeSockets and this stays uncalled.
        suspendFeeds();
        expect(b.close).toHaveBeenCalledTimes(1);
    });

    it('does nothing when not suspended', () => {
        openSocket('wss://test/rail');
        const before = _sockets.length;
        resumeFeeds(null);
        expect(_sockets).toHaveLength(before);
    });

    it('does not double-open a feed that is somehow still active', () => {
        openSocket('wss://test/rail');
        suspendFeeds();
        // Simulate the url being active again at resume time (a racey re-open).
        // Sockets are registered in _activeSockets at CREATION now, so a fresh
        // setupWebSocket for the same url makes it active without firing onclose;
        // resume must not construct a SECOND socket for that url.
        setupWebSocket('wss://test/rail', null);
        const before = _sockets.length;
        resumeFeeds(null);
        const reopened = _sockets.slice(before).map(s2 => s2.url);
        expect(reopened).not.toContain('wss://test/rail');
    });
});

describe('grace timer via visibilitychange', () => {
    let _hidden = false;
    function setHidden(v) {
        _hidden = v;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => _hidden });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    // Register the handler EXACTLY ONCE for the whole describe — calling
    // initVisibilityHandler per test would stack anonymous visibilitychange
    // listeners (each with its own grace timer) and one test's stale timer
    // would fire inside the next. In production it's called once at startup.
    beforeAll(() => { initVisibilityHandler(null); });

    beforeEach(() => {
        // Neutralize any grace timer the prior test left armed: a visible event
        // runs the handler's resume/clear branch (no-op once state is reset).
        setHidden(false);
        _resetFeedsForTest();
    });

    it('does NOT suspend before the grace window, suspends after', () => {
        openSocket('wss://test/rail');

        setHidden(true);
        vi.advanceTimersByTime(WS_HIDDEN_SUSPEND_MS - 1_000);
        expect(openCount()).toBe(1);   // still connected — quick hide

        vi.advanceTimersByTime(2_000); // cross the grace window
        expect(openCount()).toBe(0);   // suspended
    });

    it('a hide shorter than the grace window never suspends (quick tab-flip)', () => {
        const s = openSocket('wss://test/rail');

        setHidden(true);
        vi.advanceTimersByTime(WS_HIDDEN_SUSPEND_MS / 2);
        setHidden(false);              // came back before the timer fired
        s._lastMessageAt = Date.now(); // keep the inbound watchdog asleep
        // Advance well past the would-be grace fire (measured from hide start):
        // a live grace timer would have suspended by now.
        vi.advanceTimersByTime(WS_HIDDEN_SUSPEND_MS - 1_000);
        expect(s._suspendClose).toBeFalsy();   // suspend never ran
        expect(openCount()).toBe(1);
    });

    it('returning after a suspend re-opens the feed', () => {
        openSocket('wss://test/rail');

        setHidden(true);
        vi.advanceTimersByTime(WS_HIDDEN_SUSPEND_MS + 1_000); // suspends
        expect(openCount()).toBe(0);

        setHidden(false);             // resume
        expect(_sockets[_sockets.length - 1].url).toBe('wss://test/rail');
        expect(openCount()).toBe(1);
    });
});

// Placed LAST and never dispatches visibilitychange, so the extra listener this
// initVisibilityHandler() call registers can't fire into any other test.
describe('boot-already-hidden arms the grace timer', () => {
    afterEach(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    });

    it('suspends after the grace window when registered while already hidden', () => {
        // A tab can LOAD hidden (opened in the background, never focused). No
        // visibilitychange fires until first focus, so initVisibilityHandler must
        // arm the suspend timer itself when it boots hidden — otherwise the
        // firehose runs indefinitely.
        openSocket('wss://test/rail');
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });

        initVisibilityHandler(null);   // boots hidden → arms grace timer synchronously
        expect(openCount()).toBe(1);   // grace window still open

        vi.advanceTimersByTime(WS_HIDDEN_SUSPEND_MS + 1_000);
        expect(openCount()).toBe(0);   // suspended with no visibilitychange at all
    });
});
