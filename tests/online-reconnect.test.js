/**
 * Reconnect when the OS says the network is back (R7-03).
 *
 * Every failed reconnect during an outage schedules a longer backoff — 5s, 10s,
 * 20s, 40s … capped near five minutes. A rider who loses signal in a tunnel for
 * three or four minutes, tab in the foreground the whole time, comes out to a
 * map that stays frozen for up to another five while the in-flight timer runs
 * down. The browser knew connectivity was back the instant the radio
 * reconnected; the app just was not listening.
 *
 * These assert the BEHAVIOUR rather than the listener's existence, so they still
 * hold if the mechanism is reworked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockWebSocket } from './_helpers/mockWebSocket.js';

vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());
vi.mock('../js/markers.js', () => ({
    processVehicleData: vi.fn(), initMarkerCleanup: vi.fn(), removeAllMarkers: vi.fn(),
}));

import { setupWebSocket, initVisibilityHandler, _resetFeedsForTest } from '../js/api.js';

const URL_A = 'wss://api.metro.net/ws/LACMTA_Rail/vehicle_positions';

let sockets;
beforeEach(() => {
    vi.useFakeTimers();
    const { MockWebSocket, sockets: list } = (() => {
        const made = createMockWebSocket({ deferOnClose: true });
        return { MockWebSocket: made.MockWebSocket ?? made, sockets: made.sockets ?? [] };
    })();
    sockets = list;
    globalThis.WebSocket = MockWebSocket;
    globalThis.WebSocket.OPEN = 1;
    globalThis.WebSocket.CLOSED = 3;
    _resetFeedsForTest();
});

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    _resetFeedsForTest();
});

/** Drive the socket into a long backoff by failing several reconnects. */
function intoLongBackoff(map) {
    setupWebSocket(URL_A, map);
    for (let i = 0; i < 5; i++) {
        const s = sockets[sockets.length - 1];
        s.readyState = 3;
        s.onclose?.({});
        vi.advanceTimersByTime(400_000);   // let each scheduled retry fire
    }
    return sockets.length;
}

describe('an `online` event short-circuits the backoff', () => {
    it('reconnects immediately instead of waiting out the pending timer', () => {
        const map = {};
        initVisibilityHandler(map);
        const before = intoLongBackoff(map);

        // Drop the socket and let a long backoff be scheduled, then do NOT
        // advance time — this is the moment the radio comes back.
        const s = sockets[sockets.length - 1];
        s.readyState = 3;
        s.onclose?.({});
        const beforeOnline = sockets.length;

        window.dispatchEvent(new Event('online'));

        expect(sockets.length, 'a fresh socket must be opened at once').toBeGreaterThan(beforeOnline);
        expect(before).toBeGreaterThan(0);
    });

    it('does nothing while a socket is already open', () => {
        const map = {};
        initVisibilityHandler(map);
        setupWebSocket(URL_A, map);
        sockets[0].readyState = 1;
        sockets[0].onopen?.({});
        const n = sockets.length;
        window.dispatchEvent(new Event('online'));
        expect(sockets.length, 'no duplicate connection for a healthy feed').toBe(n);
    });

    it('registers only ONE listener however many times init runs', () => {
        // Asserted on the registration, not on the observable reconnect: a
        // second handler is idempotent downstream (the first call adds the URL
        // to _activeSockets, so the rest skip), which means a behavioural test
        // cannot see the leak. What accumulates is listeners — one per init
        // call, for the life of the page.
        const spy = vi.spyOn(window, 'addEventListener');
        const map = {};
        initVisibilityHandler(map);
        initVisibilityHandler(map);
        initVisibilityHandler(map);
        const onlineRegistrations = spy.mock.calls.filter(([type]) => type === 'online').length;
        expect(onlineRegistrations).toBe(1);
        spy.mockRestore();
    });
});
