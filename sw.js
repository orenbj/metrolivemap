/**
 * sw.js — installability-only service worker for Metro Live Map.
 *
 * This worker exists for ONE reason: Chromium will not fire
 * `beforeinstallprompt` (and therefore the in-app install banner in
 * js/pwaInstall.js can never appear) unless the page is controlled by a
 * service worker that has a `fetch` handler. It deliberately caches NOTHING
 * and serves NOTHING from cache — every request falls through to the network
 * exactly as if no worker were present.
 *
 * This is NOT the deferred "offline mode" service worker. Metro Live Map is a
 * live-data app with no offline use case; caching map tiles or feed responses
 * would only ever show riders stale positions. If real offline caching is ever
 * wanted, that is a separate, deliberate design decision — do not bolt a cache
 * onto this file.
 */

// Take control immediately so the very first load becomes installable without
// requiring a second navigation.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// An (empty) fetch handler is the installability trigger. Not calling
// `event.respondWith` lets the browser handle every request with its normal
// network logic — no caching, no interception.
self.addEventListener('fetch', () => { /* pass-through: network handles it */ });
