/**
 * Tests for js/phase5State.js — Phase 5.1 singleton bootstrap.
 *
 * The module is just two singletons, but their contracts matter for the
 * downstream Phase 5.2+ wiring:
 *   - vehicleStateStore is keyed by tripId (not the Phase 2 default of vehicleId)
 *   - dwellModel hydrates from localStorage on construction
 *   - both must be the *same instance* on every import (singleton invariant)
 *
 * These tests are deliberately lightweight — they only assert the bootstrap
 * shape, not behavior. Behavior is covered by vehicleState.test.js and
 * dwellModel.test.js against fresh instances.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';

// jsdom's window.localStorage is wrapped in a Proxy that rejects direct
// property assignment — install a plain in-memory shim so DwellModel's
// _load / _save / our cleanup calls all work. Mirrors the pattern in
// tests/dwellModel.test.js.
const _storageStore = {};
let originalLocalStorageDescriptor;
beforeAll(() => {
    originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
        value: {
            getItem(k)    { return _storageStore[k] ?? null; },
            setItem(k, v) { _storageStore[k] = String(v); },
            removeItem(k) { delete _storageStore[k]; },
            clear()       { for (const k of Object.keys(_storageStore)) delete _storageStore[k]; },
        },
        writable: true, configurable: true,
    });
});
afterAll(() => {
    if (originalLocalStorageDescriptor) {
        Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor);
    }
});

import { vehicleStateStore, dwellModel } from '../js/phase5State.js';
import { VehicleStateStore } from '../js/vehicleState.js';
import { DwellModel } from '../js/dwellModel.js';
import { createState } from '../js/vehicleState.js';

describe('phase5State singletons', () => {
    it('exports a VehicleStateStore instance', () => {
        expect(vehicleStateStore).toBeInstanceOf(VehicleStateStore);
    });

    it('exports a DwellModel instance', () => {
        expect(dwellModel).toBeInstanceOf(DwellModel);
    });

    it('keys the vehicleStateStore by tripId, not vehicleId', () => {
        // Use distinctive trip/vehicle ids so a key collision can't accidentally pass.
        const state = createState({
            vehicleId: 'V-distinct', tripId: 'T-distinct',
            routeId: '801', directionId: 0,
            arc: 0, velocity: 0,
        });
        try {
            vehicleStateStore.set(state);
            // tripId is the key — looking up by tripId hits, vehicleId misses.
            expect(vehicleStateStore.get('T-distinct')).toBe(state);
            expect(vehicleStateStore.get('V-distinct')).toBeNull();
        } finally {
            // Clean up so we don't leak into other test files (vitest runs them
            // in the same module-evaluation pass, so the singleton persists).
            vehicleStateStore.delete('T-distinct');
        }
    });

    it('returns the same singleton on repeated imports', async () => {
        // Re-import — module-singleton semantics mean we get the same object back.
        const mod = await import('../js/phase5State.js');
        expect(mod.vehicleStateStore).toBe(vehicleStateStore);
        expect(mod.dwellModel).toBe(dwellModel);
    });

    it('dwellModel is wired to localStorage (writes after observation)', () => {
        // Clean slate so we can observe the write.
        localStorage.removeItem('metro-livemap.dwellV1');
        // Record one observation, then force a flush — bypasses the 30 s throttle
        // the DwellModel applies to localStorage writes.
        dwellModel.record({
            stopId: 'TEST-STOP', routeId: '801', directionId: 0,
            observedSec: 25,
        });
        dwellModel.flush();
        const stored = localStorage.getItem('metro-livemap.dwellV1');
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored);
        expect(parsed.entries['TEST-STOP|801|0']).toBeTruthy();
        expect(parsed.entries['TEST-STOP|801|0'].mean).toBe(25);
        // Clean up the persisted state we just created.
        localStorage.removeItem('metro-livemap.dwellV1');
    });
});
