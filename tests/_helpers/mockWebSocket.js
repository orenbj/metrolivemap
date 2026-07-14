/**
 * Shared `MockWebSocket` fixture for the WS-lifecycle test suites
 * (api.hidden-buffer / api.reconnect-cascade / api.reconnect / api.suspend /
 * tripUpdates.suspend). Each of those files used to declare its own
 * near-identical class + module-level `_sockets` array; the only real
 * behavioral variation between them is whether `close()` fires `onclose`
 * SYNCHRONOUSLY (most files, to run the production close→reconnect cascade
 * as a real chain) or leaves it DEFERRED (api.reconnect.test.js, to drive
 * onclose by hand and observe nested timers step-by-step).
 *
 * `createMockWebSocket()` returns a FRESH class bound to a NEW, per-call
 * `sockets` array — deliberately not a module-level singleton, so two test
 * files (or two `describe` blocks) can each hold an independent socket list
 * with no cross-file state leakage.
 */

import { vi } from 'vitest';

export function createMockWebSocket({ deferOnClose = false } = {}) {
    const sockets = [];

    class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url) {
            this.url = url;
            this.readyState = MockWebSocket.OPEN;
            this.onopen = this.onclose = this.onerror = this.onmessage = null;
            this.send = vi.fn();
            this.close = deferOnClose
                // Real browsers fire onclose ASYNChronously — leave firing it to
                // the caller so nested timers (close → onclose → reconnect
                // setTimeout) are observable step-by-step.
                ? vi.fn(() => { this.readyState = MockWebSocket.CLOSED; })
                // Synchronous, guarded against double-close: flips state then
                // fires onclose immediately, so the production close→onclose→
                // reconnect cascade runs as a real chain.
                : vi.fn(() => {
                    if (this.readyState === MockWebSocket.CLOSED) return;
                    this.readyState = MockWebSocket.CLOSED;
                    this.onclose?.();
                });
            sockets.push(this);
        }
    }

    return { MockWebSocket, sockets };
}

/**
 * Bind a reusable `openSocket(url)` helper to one `setupFn` (e.g.
 * `setupWebSocket` from js/api.js) and one `sockets` array: calls
 * `setupFn(url, null)`, grabs the last-pushed socket, fires `onopen`, and
 * returns it. `defaultUrl` lets call sites omit the url, matching files
 * that always open the same test feed.
 */
export function makeSocketOpener(setupFn, sockets, defaultUrl) {
    return (url = defaultUrl) => {
        setupFn(url, null);
        const s = sockets[sockets.length - 1];
        s.onopen?.();
        return s;
    };
}
