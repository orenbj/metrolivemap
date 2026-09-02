/**
 * Reconnect cascade (api.js) — exercised with a REALISTIC socket mock whose
 * close() actually fires onclose, so the watchdog/drop → onclose → reconnect
 * chain runs end-to-end. The existing api.reconnect suite drives onclose by
 * hand and never asserts the positive offline-toast path; this covers:
 *   - an unexpected drop-to-zero flashes "offline" + a reconnecting toast
 *   - that drop schedules a reconnect that actually opens a fresh socket
 *   - a DELIBERATE (watchdog/periodic) reconnect does NOT flash offline
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/markers.js', () => ({ processVehicleData: vi.fn() }));
vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());

import { setupWebSocket, _resetFeedsForTest } from '../js/api.js';
import { showToast, setConnectionStatus } from '../js/ui.js';
import { WS_MAX_RECONNECT_MS } from '../js/config.js';
import { makeRawVehicleFrame } from './_fixtures/markers.js';
import { createMockWebSocket, makeSocketOpener } from './_helpers/mockWebSocket.js';

// Realistic: close() transitions state and fires onclose synchronously, so
// the production close→reconnect cascade runs as a real chain.
const { MockWebSocket, sockets: _sockets } = createMockWebSocket();
const openSocket = makeSocketOpener(setupWebSocket, _sockets, 'wss://t/rail');

function openLiveSocket(url = 'wss://t/rail') {
    const s = openSocket(url);
    // A real frame marks the connection "live" (adds url to _connectedSockets),
    // so a later unexpected drop crosses size→0 and triggers the offline path.
    s.onmessage({ data: JSON.stringify(makeRawVehicleFrame({ vehicleId: 'V1' })) });
    return s;
}

beforeEach(() => {
    vi.useFakeTimers();
    _sockets.length = 0;
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    global.WebSocket = MockWebSocket;
    _resetFeedsForTest();
    setConnectionStatus.mockClear();
    showToast.mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('reconnect cascade', () => {
    it('flashes offline + a reconnecting toast when an unexpected drop empties live sockets', () => {
        const s = openLiveSocket();
        s.close();   // unexpected drop (not deliberate, not suspend) → onclose
        expect(setConnectionStatus).toHaveBeenCalledWith('offline');
        expect(showToast).toHaveBeenCalled();
    });

    it('schedules a reconnect that opens a fresh socket after an unexpected drop', async () => {
        openLiveSocket('wss://t/rail');
        _sockets[0].close();
        const before = _sockets.length;
        // Advance past the maximum backoff so the reconnect timer fires regardless
        // of jitter (the dropped socket's own ping/watchdog timers were cleared in
        // onclose, so nothing else re-fires).
        await vi.advanceTimersByTimeAsync(WS_MAX_RECONNECT_MS + 1000);
        const reopened = _sockets.slice(before).map(x => x.url);
        expect(reopened).toContain('wss://t/rail');
    });

    it('a DELIBERATE reconnect (watchdog/periodic) does not flash offline', () => {
        const s = openLiveSocket();
        s._deliberateReconnect = true;   // watchdog/periodic sets this before close()
        s.close();
        expect(setConnectionStatus).not.toHaveBeenCalledWith('offline');
        expect(showToast).not.toHaveBeenCalled();
    });
});
