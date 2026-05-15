import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock markers/ui — setupWebSocket reaches into both; we only care about
// the connection lifecycle in this file.
vi.mock('../js/markers.js', () => ({
    processVehicleData: vi.fn(),
}));
vi.mock('../js/ui.js', () => ({
    showToast:           vi.fn(),
    updateDataPanel:     vi.fn(),
    getPopupHTML:        vi.fn(() => ''),
    cleanDestination:    s => s,
    updateUpdateTime:    vi.fn(),
    setConnectionStatus: vi.fn(),
    initUI:              vi.fn(),
    removeLoadingScreen: vi.fn(),
}));

// Minimal WebSocket mock — captures handlers so the test can drive them
// manually. Each construction is registered on `_sockets`. close() does
// NOT auto-fire onclose; tests trigger onclose explicitly so the cascade
// of nested timers (close → onclose → fast-reconnect setTimeout) is
// observable step-by-step rather than collapsing inside advanceTimersByTime.
const _sockets = [];

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
        this.url = url;
        this.readyState = MockWebSocket.OPEN;
        this.onopen = null;
        this.onclose = null;
        this.onerror = null;
        this.onmessage = null;
        this.send = vi.fn();
        this.close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });
        _sockets.push(this);
    }
}

// Static the api.js code reads
MockWebSocket.OPEN = 1;

import { setupWebSocket } from '../js/api.js';
import { WS_PERIODIC_RECONNECT_MS, WS_PERIODIC_RECONNECT_JITTER_MS } from '../js/config.js';

beforeEach(() => {
    vi.useFakeTimers();
    _sockets.length = 0;
    // Pin Math.random to 0.5 so jitter is zero (deadline at exactly the cadence).
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    global.WebSocket = MockWebSocket;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// Helper: advance fake time while bumping `_lastMessageAt` so the 60s inbound
// watchdog doesn't fire spuriously. Steps through `ms` in chunks under the
// watchdog window. The active socket is always the last in `_sockets`.
function advanceWithHeartbeat(ms) {
    const HEARTBEAT_STEP_MS = 30_000;  // half the 60s watchdog window
    let remaining = ms;
    while (remaining > 0) {
        const delta = Math.min(HEARTBEAT_STEP_MS, remaining);
        // Bump _lastMessageAt on every open socket so the watchdog stays asleep
        for (const s of _sockets) {
            if (s.readyState === MockWebSocket.OPEN) s._lastMessageAt = Date.now();
        }
        vi.advanceTimersByTime(delta);
        remaining -= delta;
    }
    for (const s of _sockets) {
        if (s.readyState === MockWebSocket.OPEN) s._lastMessageAt = Date.now();
    }
}

describe('periodic WebSocket reconnect', () => {
    it('constructs a fresh socket on setupWebSocket', () => {
        setupWebSocket('wss://test/feed', /* map */ null);
        expect(_sockets).toHaveLength(1);
        expect(_sockets[0].url).toBe('wss://test/feed');
    });

    it('schedules a periodic close at WS_PERIODIC_RECONNECT_MS (jitter=0 with Math.random=0.5)', () => {
        setupWebSocket('wss://test/feed', null);
        _sockets[0].onopen?.();

        // Just before the deadline: still open
        advanceWithHeartbeat(WS_PERIODIC_RECONNECT_MS - 1_000);
        expect(_sockets[0].close).not.toHaveBeenCalled();

        // Cross the deadline
        advanceWithHeartbeat(2_000);
        expect(_sockets[0].close).toHaveBeenCalledTimes(1);
        expect(_sockets[0]._deliberateReconnect).toBe(true);
    });

    it('reconnects fast (~1s) after a deliberate close', () => {
        setupWebSocket('wss://test/feed', null);
        _sockets[0].onopen?.();

        // Fire the periodic close
        advanceWithHeartbeat(WS_PERIODIC_RECONNECT_MS + 1_000);
        expect(_sockets[0].close).toHaveBeenCalledOnce();
        expect(_sockets).toHaveLength(1);

        // Now trigger onclose manually so the reconnect timer is scheduled
        _sockets[0].onclose?.();

        // Fast-reconnect window
        vi.advanceTimersByTime(1_500);
        expect(_sockets).toHaveLength(2);
        expect(_sockets[1].url).toBe('wss://test/feed');
    });

    it('does NOT call close if onclose fires before the periodic timer', () => {
        setupWebSocket('wss://test/feed', null);
        _sockets[0].onopen?.();

        // Simulate a non-deliberate disconnect well before the periodic deadline
        advanceWithHeartbeat(10_000);
        _sockets[0].readyState = MockWebSocket.CLOSED;
        _sockets[0].onclose?.();

        // Reset the spy on the (now-dead) socket and advance past the periodic
        // deadline. If the timer wasn't cleared on onclose, close would fire
        // a second time against the dead socket.
        _sockets[0].close.mockClear();
        vi.advanceTimersByTime(WS_PERIODIC_RECONNECT_MS + 1_000);
        expect(_sockets[0].close).not.toHaveBeenCalled();
    });

    it('skips the close call if socket is no longer OPEN when timer fires', () => {
        setupWebSocket('wss://test/feed', null);
        _sockets[0].onopen?.();

        // Pre-close the socket without firing onclose (simulates a half-closed
        // race where state transitioned but the close-handler hasn't run yet).
        _sockets[0].readyState = MockWebSocket.CLOSED;

        // Fire the periodic timer (note: heartbeat helper checks OPEN before
        // bumping, so the dead socket won't get its watchdog bumped — but
        // we don't care since it's closed; the api.js periodic timer should
        // see readyState != OPEN and skip the close)
        vi.advanceTimersByTime(WS_PERIODIC_RECONNECT_MS + 1_000);
        expect(_sockets[0].close).not.toHaveBeenCalled();
    });

    it('respects jitter — earliest fire is cadence − jitter/2', () => {
        // Math.random()=0.0 → jitter = -JITTER_MS/2 (earliest possible deadline)
        vi.spyOn(Math, 'random').mockReturnValue(0.0);
        setupWebSocket('wss://test/early', null);
        _sockets[0].onopen?.();

        const earliest = WS_PERIODIC_RECONNECT_MS - WS_PERIODIC_RECONNECT_JITTER_MS / 2;

        // Just before the earliest-possible deadline: socket still open
        advanceWithHeartbeat(earliest - 1_000);
        expect(_sockets[0].close).not.toHaveBeenCalled();

        // Cross the deadline
        advanceWithHeartbeat(2_000);
        expect(_sockets[0].close).toHaveBeenCalledTimes(1);
    });

    it('respects jitter — latest fire is cadence + jitter/2', () => {
        // Math.random()=1.0 → jitter = +JITTER_MS/2 (latest possible deadline)
        vi.spyOn(Math, 'random').mockReturnValue(1.0);
        setupWebSocket('wss://test/late', null);
        _sockets[0].onopen?.();

        const latest = WS_PERIODIC_RECONNECT_MS + WS_PERIODIC_RECONNECT_JITTER_MS / 2;

        // At the WITHOUT-jitter cadence: not yet fired (still in jitter window)
        advanceWithHeartbeat(WS_PERIODIC_RECONNECT_MS);
        expect(_sockets[0].close).not.toHaveBeenCalled();

        // Cross the latest deadline
        advanceWithHeartbeat(WS_PERIODIC_RECONNECT_JITTER_MS / 2 + 1_000);
        expect(_sockets[0].close).toHaveBeenCalledTimes(1);
    });
});
