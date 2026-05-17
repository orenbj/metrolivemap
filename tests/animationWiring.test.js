/**
 * Tests for js/animationWiring.js — the seam between WS frames / popup
 * refreshes and the animationStore.
 *
 * Most of the wiring's value is integration with predictions.getRouteCache,
 * which requires a populated masterTripsData + masterStopsData + shape
 * data. We exercise the surface contracts here; the load-bearing
 * end-to-end contract (popup ETA equals animation arrival) lives in
 * tests/animation-integration.test.js (added in commit 2).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { installGlobals } from './_helpers/globals.js';
import { initPredictions, _clearRouteStopsCache } from '../js/predictions.js';
import { updateAnimationFor, clearAnimationFor, _DEBOUNCE_MS } from '../js/animationWiring.js';
import {
    animations, _clearAnimations, setAnimation, getAnimation,
} from '../js/animationStore.js';

describe('animationWiring.updateAnimationFor — guards', () => {
    beforeEach(() => {
        _clearAnimations();
        _clearRouteStopsCache();
    });

    it('returns null when tripId is missing', () => {
        expect(updateAnimationFor({})).toBeNull();
        expect(updateAnimationFor({ tripId: '' })).toBeNull();
    });

    it('returns null when routeCode is missing', () => {
        expect(updateAnimationFor({
            tripId: 't1', directionId: 0, nextStopId: 's1',
            currentArc: 0, blendEtaUnix: 100, nowUnix: 50,
        })).toBeNull();
    });

    it('returns null when directionId is missing', () => {
        expect(updateAnimationFor({
            tripId: 't1', routeCode: '801', nextStopId: 's1',
            currentArc: 0, blendEtaUnix: 100, nowUnix: 50,
        })).toBeNull();
    });

    it('returns null when nextStopId is missing', () => {
        expect(updateAnimationFor({
            tripId: 't1', routeCode: '801', directionId: 0,
            currentArc: 0, blendEtaUnix: 100, nowUnix: 50,
        })).toBeNull();
    });

    it('returns null when the route cache is absent', () => {
        // No predictions cache initialized — getRouteCache returns undefined.
        installGlobals();
        const out = updateAnimationFor({
            tripId: 't1', routeCode: '801', directionId: 0,
            nextStopId: 's1', currentArc: 0,
            blendEtaUnix: 100, nowUnix: 50,
        });
        expect(out).toBeNull();
    });
});

describe('animationWiring — exports', () => {
    it('exports a sensible debounce constant', () => {
        expect(_DEBOUNCE_MS).toBe(250);
    });
});

describe('animationWiring.clearAnimationFor', () => {
    beforeEach(() => { _clearAnimations(); });

    it('removes an existing animation entry', () => {
        setAnimation('t1', { routeId: '801', directionId: 0 });
        expect(getAnimation('t1')).not.toBeNull();
        clearAnimationFor('t1');
        expect(getAnimation('t1')).toBeNull();
    });

    it('is a no-op for an unknown tripId', () => {
        expect(() => clearAnimationFor('nope')).not.toThrow();
    });
});
