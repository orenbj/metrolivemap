// Seed the window globals that predictions.js and markers.js read from.
// Each test file should override these as needed via beforeEach/beforeAll.
window.masterStopsData    = {};
window.masterTripsData    = {};
window.masterArrivalsData = new Map();
window.vehicleMarkers     = {};

// Node 22+ exposes its own `globalThis.localStorage` as an experimental
// global (gated on `--experimental-webstorage` + `--localstorage-file=…`).
// Vitest's jsdom environment ALSO installs `window.localStorage`, but in
// Node 25 the BUILT-IN global wins via the prototype lookup AND replaces
// jsdom's window.localStorage with the same broken reference. Without a
// `--localstorage-file` backing path, both are accessor stubs whose
// `setItem` throws "localStorage.setItem is not a function" on every
// write. (Matching node warning at vitest startup: "Warning:
// --localstorage-file was provided without a valid path".)
//
// Install a plain in-memory Storage shim and pin it on BOTH globalThis
// AND window so production code's `localStorage.foo(...)` calls work
// from either lookup path. Production browsers are unaffected — they
// have a real Storage object.
function _makeInMemoryStorage() {
    let store = Object.create(null);
    return {
        get length()           { return Object.keys(store).length; },
        key(i)                  { return Object.keys(store)[i] ?? null; },
        getItem(k)              { return Object.hasOwn(store, k) ? store[k] : null; },
        setItem(k, v)           { store[String(k)] = String(v); },
        removeItem(k)           { delete store[k]; },
        clear()                 { store = Object.create(null); },
    };
}

const _shim = _makeInMemoryStorage();
const _pin = (host) => {
    if (!host) return;
    try {
        Object.defineProperty(host, 'localStorage', {
            value: _shim,
            writable: true,
            configurable: true,
        });
    } catch { /* host doesn't allow redefinition; nothing we can do */ }
};
_pin(globalThis);
if (typeof window !== 'undefined') _pin(window);
