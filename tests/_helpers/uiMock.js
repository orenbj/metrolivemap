/**
 * The standard `js/ui.js` module mock, in one place.
 *
 * 33 test files had their own copy of this object literal. That is a
 * change-amplifier with a demonstrated cost: adding a single export
 * (`vehicleAriaLabel`, for the marker accessible name) required editing all 33,
 * and the copies had already drifted — two were missing `removeLoadingScreen`,
 * several had the keys in a different order.
 *
 * `vi.mock` factories are HOISTED above imports, so a factory cannot reference
 * an imported binding. Call it through a dynamic import instead, which runs
 * lazily:
 *
 *     vi.mock('../js/ui.js', async () => (await import('./_helpers/uiMock.js')).uiMock());
 *
 * Pass overrides for the rare test that needs a specific return value:
 *
 *     uiMock({ getPopupHTML: vi.fn(() => '<div>…</div>') })
 *
 * Each call builds FRESH `vi.fn()` instances, exactly as the inline literals
 * did, so per-file isolation is unchanged.
 */

import { vi } from 'vitest';

export function uiMock(overrides = {}) {
    return {
        showToast: vi.fn(),
        updateDataPanel: vi.fn(),
        getPopupHTML: vi.fn(() => ''),
        cleanDestination: s => s,
        updateUpdateTime: vi.fn(),
        setConnectionStatus: vi.fn(),
        initUI: vi.fn(),
        removeLoadingScreen: vi.fn(),
        // markers.js imports this for the marker accessible name (R6-02); a
        // mock missing it fails the module LOAD, not the assertion.
        vehicleAriaLabel: vi.fn(() => 'vehicle'),
        ...overrides,
    };
}
