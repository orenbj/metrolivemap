/**
 * Tests for followVehicle.js — the pin-and-follow camera tracker.
 * Drives the chase tick manually against a fake map and a fake
 * window.vehicleMarkers, so the camera/grace/persistence logic is verified
 * without a real MapLibre instance.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    toggleFollow, isFollowingKey, decorateFollowButton, initFollow, hasPendingRestore, _followInternals,
} from '../js/followVehicle.js';

const KEY = 'T1';

function fakeMarker(lng, lat, rc = '804') {
    const popup = { _open: false, isOpen() { return this._open; } };
    const el = document.createElement('div');
    el.setAttribute('data-mode', 'rail');
    return {
        getLngLat: () => ({ lng, lat }),
        route_code: rc,
        getPopup: () => popup,
        getElement: () => el,
        togglePopup() { popup._open = !popup._open; },
        _popup: popup,
        _el: el,
    };
}
function fakeMap() {
    const handlers = {};
    return {
        _center: { lng: 0, lat: 0 },
        easeToCalls: [], jumpToCalls: [],
        on(ev, cb) { handlers[ev] = cb; },
        fire(ev, arg) { handlers[ev]?.(arg); },
        getCenter() { return { ...this._center }; },
        easeTo(opts) { this.easeToCalls.push(opts); this._center = { ...opts.center }; },
        jumpTo(opts) { this.jumpToCalls.push(opts); this._center = { ...opts.center }; },
    };
}

beforeEach(() => {
    window.matchMedia = () => ({ matches: false });
    window.vehicleMarkers = { [KEY]: fakeMarker(10, 10) };
    try { localStorage.removeItem('mlm_follow_vehicle'); } catch { /* ignore */ }
    _followInternals.reset();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});
afterEach(() => { _followInternals.reset(); vi.useRealTimers(); });

describe('followVehicle — start/stop/toggle', () => {
    it('toggleFollow starts following: state, chip, and persistence', () => {
        toggleFollow(KEY);
        expect(isFollowingKey(KEY)).toBe(true);
        expect(_followInternals.state().chip).toBe(true);
        expect(JSON.parse(localStorage.getItem('mlm_follow_vehicle')).key).toBe(KEY);
        expect(document.querySelector('.follow-chip')).not.toBeNull();
    });

    it('toggleFollow on the same key stops, removes the chip, clears persistence', () => {
        toggleFollow(KEY);
        toggleFollow(KEY);
        expect(isFollowingKey(KEY)).toBe(false);
        expect(_followInternals.state().chip).toBe(false);
        expect(localStorage.getItem('mlm_follow_vehicle')).toBeNull();
        expect(document.querySelector('.follow-chip')).toBeNull();
    });
});

describe('followVehicle — camera chase', () => {
    it('eases the camera toward the followed marker each tick', () => {
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);                 // marker (10,10), center (0,0)
        _followInternals.tick();
        expect(map.easeToCalls.length).toBe(1);
        expect(map.easeToCalls[0].center).toEqual({ lng: 10, lat: 10 });
    });

    it('skips the camera move when already centered (parked vehicle)', () => {
        window.vehicleMarkers[KEY] = fakeMarker(0, 0);
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);
        _followInternals.tick();
        expect(map.easeToCalls.length).toBe(0);
    });

    it('snaps (jumpTo, not easeTo) under prefers-reduced-motion', () => {
        window.matchMedia = () => ({ matches: true });
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);
        _followInternals.tick();
        expect(map.jumpToCalls.length).toBe(1);
        expect(map.easeToCalls.length).toBe(0);
        expect(map.jumpToCalls[0].center).toEqual({ lng: 10, lat: 10 });
    });
});

describe('followVehicle — user pan pauses, not fights', () => {
    it('a user dragstart pauses follow; a paused tick does not move the camera', () => {
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);
        map.fire('dragstart');
        expect(_followInternals.state().paused).toBe(true);
        expect(document.querySelector('.follow-chip').classList.contains('is-paused')).toBe(true);
        _followInternals.tick();
        expect(map.easeToCalls.length).toBe(0);
    });
});

describe('followVehicle — vehicle vanishes', () => {
    it('keeps following within the reacquire grace, then ends after it', () => {
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);
        delete window.vehicleMarkers[KEY];     // vehicle leaves the feed
        _followInternals.tick();
        expect(isFollowingKey(KEY)).toBe(true);                 // still following (grace)
        expect(document.querySelector('.follow-chip').classList.contains('is-reconnecting')).toBe(true);
        // Reappears within grace → resumes (reconnecting flag clears).
        window.vehicleMarkers[KEY] = fakeMarker(5, 5);
        _followInternals.tick();
        expect(document.querySelector('.follow-chip').classList.contains('is-reconnecting')).toBe(false);
        // Gone again, past the grace → follow ends.
        delete window.vehicleMarkers[KEY];
        _followInternals.tick();               // sets missingSince
        vi.setSystemTime(1_000_000 + 40_000);  // > REACQUIRE_GRACE_MS (35s)
        _followInternals.tick();
        expect(isFollowingKey(KEY)).toBe(false);
        expect(document.querySelector('.follow-chip')).toBeNull();
    });
});

describe('followVehicle — end of route', () => {
    it('stops following immediately when the vehicle reaches its final stop', () => {
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);
        _followInternals.tick();                         // following normally
        expect(isFollowingKey(KEY)).toBe(true);
        // markers.js marks the vehicle stopped at its trip's last stop.
        window.vehicleMarkers[KEY]._endOfLineSinceTs = 1_000_000;
        _followInternals.tick();
        expect(isFollowingKey(KEY)).toBe(false);         // follow ended
        expect(document.querySelector('.follow-chip')).toBeNull();
        expect(localStorage.getItem('mlm_follow_vehicle')).toBeNull();
    });

    it('end-of-route during a restore falls back to startup auto-locate (no toast)', () => {
        const fired = vi.fn();
        document.addEventListener('requestAutoLocate', fired);
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: Date.now() }));
        delete window.vehicleMarkers[KEY];
        initFollow(fakeMap());
        // Vehicle re-acquired on the first frame, but already at end-of-line.
        window.vehicleMarkers[KEY] = fakeMarker(10, 10);
        window.vehicleMarkers[KEY]._endOfLineSinceTs = 1_000_000;
        _followInternals.tick();
        expect(isFollowingKey(KEY)).toBe(false);
        expect(fired).toHaveBeenCalledTimes(1);
        document.removeEventListener('requestAutoLocate', fired);
    });
});

describe('followVehicle — camera takeover pauses (not stops)', () => {
    it('a mlm:camera-takeover event pauses an active follow', () => {
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);
        expect(_followInternals.state().paused).toBe(false);
        document.dispatchEvent(new CustomEvent('mlm:camera-takeover'));
        expect(_followInternals.state().paused).toBe(true);   // paused, still following
        expect(isFollowingKey(KEY)).toBe(true);
        _followInternals.tick();                              // a paused tick doesn't chase
        expect(map.easeToCalls.length).toBe(0);
    });

    it('does nothing when not following', () => {
        initFollow(fakeMap());
        document.dispatchEvent(new CustomEvent('mlm:camera-takeover'));
        expect(_followInternals.state().paused).toBe(false);
    });
});

describe('followVehicle — followed route hidden by the legend filter', () => {
    afterEach(() => { document.body.classList.remove('hide-route-804'); });
    it('stops following when the vehicle\'s route is filtered out', () => {
        initFollow(fakeMap());
        toggleFollow(KEY);                                    // marker route_code = '804'
        _followInternals.tick();
        expect(isFollowingKey(KEY)).toBe(true);
        document.body.classList.add('hide-route-804');        // user hides the A/E... route
        _followInternals.tick();
        expect(isFollowingKey(KEY)).toBe(false);
        expect(document.querySelector('.follow-chip')).toBeNull();
    });
});

describe('followVehicle — popup button + restore', () => {
    it('decorateFollowButton reflects follow state', () => {
        const root = document.createElement('div');
        root.innerHTML = '<button class="pv2-follow-btn" aria-pressed="false"><span class="pv2-follow-label">Follow</span></button>';
        toggleFollow(KEY);
        decorateFollowButton(root, KEY);
        expect(root.querySelector('.pv2-follow-label').textContent).toBe('Following');
        expect(root.querySelector('.pv2-follow-btn').getAttribute('aria-pressed')).toBe('true');
        decorateFollowButton(root, 'OTHER');   // a different vehicle's popup
        expect(root.querySelector('.pv2-follow-label').textContent).toBe('Follow');
    });

    it('initFollow restores a persisted follow from localStorage', () => {
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: Date.now() }));
        initFollow(fakeMap());
        expect(isFollowingKey(KEY)).toBe(true);
        expect(document.querySelector('.follow-chip')).not.toBeNull();
    });
});

describe('followVehicle — restore focuses the vehicle (reload / app-return)', () => {
    it('a restored follow is pending until the vehicle is acquired', () => {
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: Date.now() }));
        delete window.vehicleMarkers[KEY];        // not loaded yet (cold start)
        initFollow(fakeMap());
        expect(hasPendingRestore()).toBe(true);   // so startup auto-locate is suppressed
    });

    it('on first acquire it zooms moderately to the vehicle + opens ITS popup, then chases', () => {
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: Date.now() }));
        delete window.vehicleMarkers[KEY];
        const map = fakeMap();
        initFollow(map);
        // Vehicle arrives on the first feed frame.
        window.vehicleMarkers[KEY] = fakeMarker(10, 10);
        _followInternals.tick();
        expect(map.jumpToCalls.length).toBe(1);
        expect(map.jumpToCalls[0].zoom).toBe(14);                 // moderate, not tight
        expect(map.jumpToCalls[0].center).toEqual({ lng: 10, lat: 10 });
        expect(window.vehicleMarkers[KEY]._popup.isOpen()).toBe(true);
        expect(hasPendingRestore()).toBe(false);
        // Subsequent ticks chase (easeTo), holding the restore zoom.
        window.vehicleMarkers[KEY] = fakeMarker(11, 11);
        _followInternals.tick();
        expect(map.easeToCalls.length).toBe(1);
    });

    it('a FRESH (user-clicked) follow never zooms or re-popups', () => {
        const map = fakeMap();
        initFollow(map);
        toggleFollow(KEY);                         // user click — vehicle already present
        expect(hasPendingRestore()).toBe(false);
        _followInternals.tick();
        expect(map.jumpToCalls.length).toBe(0);    // no zoom yank
        expect(map.easeToCalls.length).toBe(1);    // just chases
    });

    it('falls back to startup auto-locate if the restored vehicle never returns', () => {
        const fired = vi.fn();
        document.addEventListener('requestAutoLocate', fired);
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: Date.now() }));
        delete window.vehicleMarkers[KEY];
        initFollow(fakeMap());
        _followInternals.tick();                   // missing → sets grace
        vi.setSystemTime(1_000_000 + 40_000);      // past the 35s grace
        _followInternals.tick();
        expect(fired).toHaveBeenCalledTimes(1);
        expect(isFollowingKey(KEY)).toBe(false);
        document.removeEventListener('requestAutoLocate', fired);
    });
});

describe('followVehicle — highlights the followed vehicle', () => {
    it('rings the followed marker on start and removes it on stop', () => {
        initFollow(fakeMap());
        const m = window.vehicleMarkers[KEY];
        toggleFollow(KEY);
        expect(m._el.classList.contains('follow-highlight')).toBe(true);
        toggleFollow(KEY);   // stop
        expect(m._el.classList.contains('follow-highlight')).toBe(false);
    });

    it('moves the ring to the new element if the marker is recreated', () => {
        initFollow(fakeMap());
        const first = window.vehicleMarkers[KEY];
        toggleFollow(KEY);
        expect(first._el.classList.contains('follow-highlight')).toBe(true);
        // Marker recreated (e.g. after resume) — new element.
        const second = fakeMarker(10, 10);
        window.vehicleMarkers[KEY] = second;
        _followInternals.tick();
        expect(first._el.classList.contains('follow-highlight')).toBe(false);
        expect(second._el.classList.contains('follow-highlight')).toBe(true);
    });

    it('clears the ring while the vehicle is absent (reconnecting)', () => {
        initFollow(fakeMap());
        const m = window.vehicleMarkers[KEY];
        toggleFollow(KEY);
        delete window.vehicleMarkers[KEY];
        _followInternals.tick();
        expect(m._el.classList.contains('follow-highlight')).toBe(false);
    });
});

describe('followVehicle — stale restore is dropped (opened hours later)', () => {
    it('does NOT restore a follow older than the max age — and clears it', () => {
        // Persisted 40 min ago (> FOLLOW_RESTORE_MAX_AGE_MS of 30 min).
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: 1_000_000 - 40 * 60_000 }));
        initFollow(fakeMap());
        expect(isFollowingKey(KEY)).toBe(false);          // no reconnect attempt
        expect(hasPendingRestore()).toBe(false);          // startup auto-locate runs normally
        expect(document.querySelector('.follow-chip')).toBeNull();
        expect(localStorage.getItem('mlm_follow_vehicle')).toBeNull();  // self-cleaned
    });

    it('DOES restore a recent follow (within the max age)', () => {
        localStorage.setItem('mlm_follow_vehicle', JSON.stringify({ key: KEY, ts: 1_000_000 - 5 * 60_000 }));
        initFollow(fakeMap());
        expect(isFollowingKey(KEY)).toBe(true);
        expect(hasPendingRestore()).toBe(true);
    });

    it('drops a legacy plain-string persisted value (pre-timestamp format)', () => {
        localStorage.setItem('mlm_follow_vehicle', KEY);  // old format, no JSON/ts
        initFollow(fakeMap());
        expect(isFollowingKey(KEY)).toBe(false);
        expect(localStorage.getItem('mlm_follow_vehicle')).toBeNull();
    });
});
