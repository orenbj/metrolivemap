import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePopup, notifyPopupClosed, closeActivePopup, _resetActivePopup } from '../js/popups.js';

describe('popups — single active popup coordinator', () => {
    beforeEach(() => _resetActivePopup());

    it('first registration closes nothing; a second closes the first', () => {
        const closed = [];
        setActivePopup(() => closed.push('A'));
        expect(closed).toEqual([]);          // nothing else was open
        setActivePopup(() => closed.push('B')); // B opens → A must close
        expect(closed).toEqual(['A']);
    });

    it('re-registering the SAME closer does not self-close', () => {
        let closes = 0;
        const closeA = () => { closes++; };
        setActivePopup(closeA);
        setActivePopup(closeA);              // identity match → no-op
        expect(closes).toBe(0);
    });

    it('ignores non-function arguments and preserves the active popup', () => {
        let aClosed = 0;
        const closeA = () => { aClosed++; };
        setActivePopup(closeA);
        setActivePopup(undefined);           // ignored — must NOT close A
        setActivePopup(null);                // ignored
        expect(aClosed).toBe(0);
        setActivePopup(() => {});            // a real new popup closes A exactly once
        expect(aClosed).toBe(1);
    });

    it('a stale closer cannot clear a newer registration', () => {
        let bClosed = 0;
        const closeA = () => {};
        const closeB = () => { bClosed++; };
        setActivePopup(closeA);
        setActivePopup(closeB);              // B is active now
        notifyPopupClosed(closeA);           // stale (A) → must NOT clear B
        setActivePopup(() => {});            // new popup → should close B
        expect(bClosed).toBe(1);             // proves B was still active
    });

    it('notifyPopupClosed for the active closer clears the registry', () => {
        let closes = 0;
        const closeA = () => { closes++; };
        setActivePopup(closeA);
        notifyPopupClosed(closeA);           // A closed itself (× / map click)
        setActivePopup(() => {});            // nothing should be closed now
        expect(closes).toBe(0);
    });

    it('an error thrown by the outgoing close does not block the incoming popup', () => {
        let bClosed = 0;
        setActivePopup(() => { throw new Error('boom'); });
        const closeB = () => { bClosed++; };
        expect(() => setActivePopup(closeB)).not.toThrow();  // throw swallowed
        setActivePopup(() => {});            // C opens → B closes despite earlier throw
        expect(bClosed).toBe(1);
    });

    it('closeActivePopup runs the active closer once and empties the registry (Escape path)', () => {
        let closes = 0;
        // Realistic owner: its own close fn notifies the coordinator (as a MapLibre
        // 'close' handler would), so closeActivePopup must not double-invoke.
        const closeA = () => { closes++; notifyPopupClosed(closeA); };
        setActivePopup(closeA);
        expect(closeActivePopup()).toBe(true);
        expect(closes).toBe(1);
        expect(closeActivePopup()).toBe(false);  // nothing left to close
        expect(closes).toBe(1);
    });

    it('closeActivePopup is a safe no-op when nothing is open', () => {
        expect(closeActivePopup()).toBe(false);
    });

    it('closeActivePopup swallows a teardown error and still clears the registry', () => {
        setActivePopup(() => { throw new Error('boom'); });
        expect(() => closeActivePopup()).not.toThrow();
        // The throwing closer never called notifyPopupClosed, so the registry still
        // points at it; a subsequent open must still be able to replace it.
        let bClosed = 0;
        setActivePopup(() => { bClosed++; });
        setActivePopup(() => {});
        expect(bClosed).toBe(1);
    });

    it('"set-first-then-close": a re-entrant notify from the outgoing close cannot clear the newcomer', () => {
        // Mirrors the real flow: closing the OLD popup synchronously fires its
        // MapLibre 'close' handler, which calls notifyPopupClosed(oldClose). By
        // then the NEW popup is already registered, so that notify is a no-op.
        const events = [];
        const oldClose = () => { events.push('old'); notifyPopupClosed(oldClose); };
        const newClose = () => { events.push('new'); };
        setActivePopup(oldClose);
        setActivePopup(newClose);            // registers new, THEN closes old (which notifies old)
        expect(events).toEqual(['old']);
        setActivePopup(() => {});            // newcomer still active → opening a third closes it
        expect(events).toEqual(['old', 'new']);
    });
});
