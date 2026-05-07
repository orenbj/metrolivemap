/**
 * Tests for marker lifecycle helpers in markers.js:
 *   - applyOriginVisibility hides/shows the DOM element when STOPPED_AT idx=0
 *   - initMarkerCleanup fades markers at STALE_FADE_START_SEC and removes
 *     them at STALE_THRESHOLD_SEC
 *   - restoreMarkerOpacity un-fades a single marker
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../js/ui.js', () => ({
    showToast: vi.fn(), updateDataPanel: vi.fn(), getPopupHTML: vi.fn(() => ''),
    cleanDestination: s => s, updateUpdateTime: vi.fn(),
    setConnectionStatus: vi.fn(), initUI: vi.fn(), removeLoadingScreen: vi.fn(),
}));
vi.mock('../js/stations.js', () => ({ closeStationPopup: vi.fn() }));

import {
    markers,
    applyOriginVisibility,
    initMarkerCleanup,
    restoreMarkerOpacity,
} from '../js/markers.js';
import { initPredictions } from '../js/predictions.js';
import { makeMarker } from './_fixtures/markers.js';
import { installGlobals } from './_helpers/globals.js';
import {
    STALE_THRESHOLD_SEC, STALE_FADE_START_SEC,
} from '../js/config.js';

const NOW = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    installGlobals();
    initPredictions();
    for (const k of Object.keys(markers)) delete markers[k];
});

afterEach(() => {
    vi.useRealTimers();
});

describe('applyOriginVisibility', () => {
    it('hides the marker element when STOPPED_AT idx=0 of own route', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', routeCode: '801', directionId: 0,
            stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('hidden');
        expect(m.getElement().style.pointerEvents).toBe('none');
    });

    it('shows the marker element when not at origin', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80303', currentStatus: 'STOPPED_AT',
        });
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('visible');
        expect(m.getElement().style.pointerEvents).toBe('');
    });

    it('shows the marker when IN_TRANSIT_TO origin (not yet arrived)', () => {
        const m = makeMarker({
            tripId: 'TR-A-1', stopId: '80101', currentStatus: 'IN_TRANSIT_TO',
        });
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('visible');
    });

    it('is route-aware: a route\'s origin is not necessarily another route\'s origin', () => {
        // 80101 is origin for route 801 only. Pretend a 901 vehicle is at 80101 STOPPED_AT —
        // it should NOT be hidden.
        const m = makeMarker({
            tripId: 'TR-A-1',
            routeCode: '901',     // bus route, different origin set
            directionId: 0,
            stopId: '80101', currentStatus: 'STOPPED_AT',
        });
        // Note: the trip TR-A-1 has rc=801 in masterTripsData, so isAtOwnOriginStop
        // looks up dir/origin for 901|0 — 80101 isn't 901's origin.
        m.properties.route_code = '901';
        applyOriginVisibility(m, m.properties);
        expect(m.getElement().style.visibility).toBe('visible');
    });
});

describe('restoreMarkerOpacity', () => {
    it('sets element opacity to 1', () => {
        const m = makeMarker({ tripId: 'TR-A-1' });
        m.getElement().style.opacity = '0.3';
        markers['TR-A-1'] = m;
        restoreMarkerOpacity('TR-A-1');
        expect(Number(m.getElement().style.opacity)).toBe(1);
    });

    it('is a no-op for an unknown markerKey', () => {
        // No throw, no side effect
        restoreMarkerOpacity('does-not-exist');
    });
});

describe('initMarkerCleanup', () => {
    it('marks elements stale when age exceeds STALE_FADE_START_SEC', () => {
        vi.useFakeTimers();
        const fresh = makeMarker({ tripId: 'F1', timestamp: NOW() });
        const stale = makeMarker({ tripId: 'S1', timestamp: NOW() - (STALE_FADE_START_SEC + 5) });
        markers['F1'] = fresh;
        markers['S1'] = stale;

        initMarkerCleanup();
        // Cleanup interval is STALE_CHECK_INTERVAL_MS = 5000 ms
        vi.advanceTimersByTime(6000);

        expect(fresh.getElement().hasAttribute('data-stale')).toBe(false);
        expect(stale.getElement().hasAttribute('data-stale')).toBe(true);
    });

    it('removes markers older than STALE_THRESHOLD_SEC', () => {
        vi.useFakeTimers();
        const dead = makeMarker({ tripId: 'D1', timestamp: NOW() - (STALE_THRESHOLD_SEC + 10) });
        const removeSpy = vi.fn();
        dead.remove = removeSpy;
        markers['D1'] = dead;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(removeSpy).toHaveBeenCalled();
        expect(markers['D1']).toBeUndefined();
    });

    it('does not remove markers without timestamps', () => {
        vi.useFakeTimers();
        const noTs = makeMarker({ tripId: 'N1' });
        delete noTs.timestamp;
        const removeSpy = vi.fn();
        noTs.remove = removeSpy;
        markers['N1'] = noTs;

        initMarkerCleanup();
        vi.advanceTimersByTime(6000);

        expect(removeSpy).not.toHaveBeenCalled();
        expect(markers['N1']).toBeDefined();
    });
});
