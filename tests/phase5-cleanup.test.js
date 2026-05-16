/**
 * Tests for the Phase 5.7 state-cleanup invariant: when a marker is removed
 * via `_fadeOutAndRemove`, the corresponding entry in `vehicleStateStore`
 * must also be deleted. Without this, the trajectory state leaks across
 * terminus turnarounds — and worse, if Metro re-uses a tripId for a different
 * physical vehicle later in the day, the new marker would silently read
 * the OLD trajectory and produce wrong ETAs.
 *
 * The marker lifecycle is the single authoritative place state can be
 * disposed of, so the invariant is: after `_fadeOutAndRemove(key)`,
 * `vehicleStateStore.get(key) === null`.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';

// jsdom localStorage shim (DwellModel construct touches it at module load).
beforeAll(() => {
    const store = {};
    Object.defineProperty(window, 'localStorage', {
        value: {
            getItem(k)    { return store[k] ?? null; },
            setItem(k, v) { store[k] = String(v); },
            removeItem(k) { delete store[k]; },
            clear()       { for (const k of Object.keys(store)) delete store[k]; },
        },
        writable: true, configurable: true,
    });
});

import { _fadeOutAndRemove, markers } from '../js/markers.js';
import { vehicleStateStore } from '../js/phase5State.js';
import { createState } from '../js/vehicleState.js';

// Minimal mock that satisfies _fadeOutAndRemove's expectations:
// getElement() returns an element with a style object; remove() flips a
// flag. The internal fade timeout is left to run; we only verify the
// synchronous state-store cleanup, not the eventual DOM removal.
function makeMockMarker() {
    const el = { style: { pointerEvents: '', transition: '', opacity: '1' } };
    return {
        _removed: false,
        _opacity: 1,
        _fadingOut: false,
        properties: {},
        getElement() { return el; },
        remove() { this._removed = true; },
    };
}

beforeEach(() => {
    vehicleStateStore.clear();
    // markers is exported as a live reference — clear it between tests.
    for (const k of Object.keys(markers)) delete markers[k];
    // Use fake timers so _fadeOutAndRemove's setTimeout doesn't leak into
    // other tests.
    vi.useFakeTimers();
});

describe('_fadeOutAndRemove ↔ vehicleStateStore parallel removal', () => {
    it('deletes the state entry when the marker is faded out', () => {
        // Seed both sides of the seam: a marker DOM mock + a kinematic state.
        markers.T1 = makeMockMarker();
        vehicleStateStore.set(createState({
            vehicleId: 'V1', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 100, velocity: 5,
        }));
        expect(vehicleStateStore.get('T1')).toBeTruthy();

        _fadeOutAndRemove('T1');

        // State is removed SYNCHRONOUSLY alongside the marker-map delete.
        expect(vehicleStateStore.get('T1')).toBeNull();
        // The marker-map entry is also removed (production guard against
        // getScheduledArrivals/data-panel double-counting the vehicle during
        // the visual fade).
        expect(markers.T1).toBeUndefined();
    });

    it('terminus turnaround: removing the OLD trip leaves the NEW trip state intact', () => {
        // Same physical vehicle, two different trip IDs in flight (turnaround).
        markers['T-old'] = makeMockMarker();
        markers['T-new'] = makeMockMarker();
        vehicleStateStore.set(createState({
            vehicleId: 'V1', tripId: 'T-old', routeId: '801', directionId: 0,
            arc: 100, velocity: 5,
        }));
        vehicleStateStore.set(createState({
            vehicleId: 'V1', tripId: 'T-new', routeId: '801', directionId: 1,
            arc: 0, velocity: 0,
        }));

        _fadeOutAndRemove('T-old');

        expect(vehicleStateStore.get('T-old')).toBeNull();
        expect(vehicleStateStore.get('T-new')).toBeTruthy();
        expect(vehicleStateStore.size).toBe(1);
    });

    it('idempotent: a second call for the already-fading marker does not re-touch state', () => {
        markers.T1 = makeMockMarker();
        vehicleStateStore.set(createState({
            vehicleId: 'V', tripId: 'T1', routeId: '801', directionId: 0,
            arc: 0, velocity: 0,
        }));

        _fadeOutAndRemove('T1');
        expect(vehicleStateStore.get('T1')).toBeNull();

        // Second call short-circuits via the `_fadingOut` guard (marker is
        // already gone from the map by then, so the early-return fires).
        // Must not throw or have any side effects.
        expect(() => _fadeOutAndRemove('T1')).not.toThrow();
    });

    it('safe when called with a key that has no marker (and no state)', () => {
        // Production calls _fadeOutAndRemove from the cleanup tick on
        // expired markers; if state and marker were both already gone,
        // the call should be a clean no-op.
        expect(() => _fadeOutAndRemove('never-existed')).not.toThrow();
        expect(vehicleStateStore.get('never-existed')).toBeNull();
    });
});
