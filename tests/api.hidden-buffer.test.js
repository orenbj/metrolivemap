/**
 * Hidden-tab vehicle buffer + drain (api.js).
 *
 * While the tab is hidden (but before the 60 s suspend), incoming vehicle frames
 * are NOT rendered live — they are buffered latest-per-vehicle and replayed on
 * return. This whole subsystem had no test; it carries three load-bearing
 * behaviors verified here: (1) latest-per-vehicle de-dup, (2) the tripId-fallback
 * key when Metro omits vehicle.id, (3) the >FRESH_EXPIRE_S stale-skip on drain,
 * plus the delete-then-set LRU eviction at the cap.
 */

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';

const _seen = [];
vi.mock('../js/markers.js', () => ({
    processVehicleData: vi.fn((data) => { _seen.push(...(data?.features ?? [])); }),
}));
vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());

import { setupWebSocket, initVisibilityHandler, _resetFeedsForTest, PENDING_VEHICLE_CAP } from '../js/api.js';
import { FRESH_EXPIRE_S } from '../js/config.js';
import { makeRawVehicleFrame } from './_fixtures/markers.js';
import { createMockWebSocket, makeSocketOpener } from './_helpers/mockWebSocket.js';

const { MockWebSocket, sockets: _sockets } = createMockWebSocket();
const openSocket = makeSocketOpener(setupWebSocket, _sockets, 'wss://test/veh');

let _hidden = false;
function setHidden(v) {
    _hidden = v;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => _hidden });
    document.dispatchEvent(new Event('visibilitychange'));
}

const send = (socket, frame) => socket.onmessage({ data: JSON.stringify(frame) });

// Register the visibility handler ONCE — calling it per test would stack
// listeners (each draining), leaking work across tests.
beforeAll(() => { initVisibilityHandler(null); });

beforeEach(() => {
    vi.useFakeTimers();
    _sockets.length = 0;
    _seen.length = 0;
    global.WebSocket = MockWebSocket;
    _resetFeedsForTest();
    setHidden(false);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('hidden-tab buffering', () => {
    it('does NOT render frames live while hidden; replays latest-per-vehicle on return', () => {
        const sock = openSocket();
        setHidden(true);

        // Two frames for the SAME vehicle while hidden — only the latest should
        // survive the buffer.
        send(sock, makeRawVehicleFrame({ vehicleId: 'V1', lng: -118.10 }));
        send(sock, makeRawVehicleFrame({ vehicleId: 'V1', lng: -118.20 }));
        expect(_seen).toHaveLength(0);   // nothing rendered while hidden

        setHidden(false);                // visibilitychange → drain (≤25 → sync)
        expect(_seen).toHaveLength(1);   // de-duped to one
        expect(_seen[0].properties.vehicle_id).toBe('V1');
        expect(_seen[0].properties.position_longitude).toBeCloseTo(-118.20); // the LATEST
    });

    it('buffers under tripId when vehicle.id is missing (Metro omits it)', () => {
        const sock = openSocket();
        setHidden(true);
        const frame = makeRawVehicleFrame({ tripId: 'TR-NOID', lng: -118.3 });
        delete frame.vehicle.vehicle.id;   // no vehicle id
        send(sock, frame);
        setHidden(false);

        expect(_seen).toHaveLength(1);
        expect(_seen[0].properties.trip_id).toBe('TR-NOID');
    });

    it('skips entries that aged past FRESH_EXPIRE_S while hidden', () => {
        const sock = openSocket();
        setHidden(true);
        send(sock, makeRawVehicleFrame({ vehicleId: 'STALE', lng: -118.4 }));
        // Sit hidden long enough for the queued entry to age out (but short of the
        // 60 s suspend would have closed the socket — here we just advance the
        // wall clock the drain compares against).
        vi.advanceTimersByTime((FRESH_EXPIRE_S + 5) * 1000);
        setHidden(false);

        expect(_seen).toHaveLength(0);   // stale entry skipped on drain
    });

    it('evicts the oldest-TOUCHED vehicle at the cap (delete-then-set LRU)', async () => {
        const sock = openSocket();
        setHidden(true);
        // Fill the cap with distinct vehicles V0..V(cap-1).
        for (let i = 0; i < PENDING_VEHICLE_CAP; i++) {
            send(sock, makeRawVehicleFrame({ vehicleId: `V${i}`, tripId: `T${i}`, lng: -118 - i * 1e-4 }));
        }
        // Re-touch V0 so it moves to the tail (newest-touched) instead of staying
        // the eviction target. (Coords kept in-bounds so the drain's geo gate
        // doesn't drop them.)
        send(sock, makeRawVehicleFrame({ vehicleId: 'V0', tripId: 'T0', lng: -118.26 }));
        // One more NEW vehicle overflows the cap → evicts the oldest-touched,
        // which is now V1 (V0 was just re-touched), not V0.
        send(sock, makeRawVehicleFrame({ vehicleId: 'VNEW', tripId: 'TNEW', lng: -118.27 }));

        setHidden(false);
        // Drain spans multiple _rIC batches (cap > 25) — flush them.
        await vi.advanceTimersByTimeAsync(2000);

        const ids = new Set(_seen.map(f => f.properties.vehicle_id));
        expect(ids.size).toBe(PENDING_VEHICLE_CAP);   // cap respected (one evicted)
        expect(ids.has('V0')).toBe(true);             // re-touched → survived
        expect(ids.has('VNEW')).toBe(true);           // newest → present
        expect(ids.has('V1')).toBe(false);            // oldest-touched → evicted
    });
});
