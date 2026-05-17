/**
 * Tests for js/animationStore.js — the singleton map of per-trip
 * animation entries.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    animations, getAnimation, setAnimation, deleteAnimation, _clearAnimations,
} from '../js/animationStore.js';

describe('animationStore', () => {
    beforeEach(() => { _clearAnimations(); });

    it('setAnimation stores a frozen entry', () => {
        const entry = setAnimation('abc123', { routeId: '801', directionId: 0 });
        expect(Object.isFrozen(entry)).toBe(true);
        expect(entry.tripId).toBe('abc123');
        expect(entry.routeId).toBe('801');
    });

    it('getAnimation returns the entry for a known tripId', () => {
        setAnimation('xyz', { foo: 1 });
        expect(getAnimation('xyz').foo).toBe(1);
    });

    it('getAnimation returns null for unknown tripId', () => {
        expect(getAnimation('does-not-exist')).toBeNull();
    });

    it('setAnimation replaces an existing entry', () => {
        setAnimation('t1', { v: 1 });
        setAnimation('t1', { v: 2 });
        expect(getAnimation('t1').v).toBe(2);
        expect(animations.size).toBe(1);
    });

    it('deleteAnimation removes the entry and returns true', () => {
        setAnimation('t1', {});
        expect(deleteAnimation('t1')).toBe(true);
        expect(getAnimation('t1')).toBeNull();
    });

    it('deleteAnimation returns false for unknown tripId', () => {
        expect(deleteAnimation('nope')).toBe(false);
    });

    it('coerces tripId to string consistently across set/get/delete', () => {
        setAnimation(12345, { v: 1 });
        expect(getAnimation('12345').v).toBe(1);
        expect(getAnimation(12345).v).toBe(1);
        expect(deleteAnimation(12345)).toBe(true);
    });

    it('_clearAnimations empties the store', () => {
        setAnimation('t1', {});
        setAnimation('t2', {});
        _clearAnimations();
        expect(animations.size).toBe(0);
    });
});
