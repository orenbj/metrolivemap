/**
 * Tests for the focus-trap + focus-restore behavior added to alertsPanel.js
 * in the Wave A a11y PR.
 *
 * What's exercised:
 *   - openAlertsPanel snapshots the opener (document.activeElement)
 *   - closeAlertsPanel restores focus to the opener
 *   - Tab on the last focusable in the panel wraps to the first
 *   - Shift+Tab on the panel itself wraps to the last focusable
 *   - Focus restore is graceful when the opener was detached mid-session
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
    openAlertsPanel,
    closeAlertsPanel,
    initAlertsPanel,
    isAlertsPanelOpen,
} from '../js/alertsPanel.js';

// Mount the panel DOM the open/close functions expect. Mirrors the relevant
// subset of index.html — close button + tablist + body container. Real
// rendering of alerts is mocked out; this suite only tests the focus
// invariants.
function _mountPanelDOM() {
    document.body.innerHTML = `
        <button id="opener-stub">Alerts</button>
        <div id="alerts-panel" role="dialog" aria-hidden="true" tabindex="-1" class="hidden">
            <header>
                <h2 id="alerts-panel-title">Alerts</h2>
                <button id="alerts-panel-close" aria-label="Close alerts panel">×</button>
            </header>
            <div id="alerts-panel-tabs" role="tablist">
                <button class="alerts-tab" data-tab="service" aria-selected="true">Service</button>
                <button class="alerts-tab" data-tab="access"  aria-selected="false">Accessibility</button>
            </div>
            <div id="alerts-panel-body"></div>
        </div>
        <div id="alerts-panel-backdrop" class="hidden" aria-hidden="true"></div>
    `;
    // jsdom doesn't lay out boxes — `offsetParent` returns null for everything
    // unless we shim it. The focusable filter uses offsetParent !== null to
    // skip visually-hidden elements. Fake "visible" by patching offsetParent.
    for (const el of document.querySelectorAll('#alerts-panel button, #alerts-panel-close')) {
        Object.defineProperty(el, 'offsetParent', { get() { return document.body; } });
    }
}

beforeEach(() => {
    window.masterAlertsData = new Map();
    window.masterStopAccessibilityAlertsData = new Map();
    window.masterStopsData = {};
    _mountPanelDOM();
    // initAlertsPanel is gated by an internal _wired flag and runs at most once
    // across the suite. We can call it freely; the wiring binds to document
    // (which persists), so subsequent calls are no-ops.
    initAlertsPanel();
});

describe('focus restore', () => {
    it('opens with focus on the panel, restores to the opener on close', () => {
        const opener = document.getElementById('opener-stub');
        opener.focus();
        expect(document.activeElement).toBe(opener);

        openAlertsPanel();
        expect(isAlertsPanelOpen()).toBe(true);
        // openAlertsPanel uses requestAnimationFrame to focus the panel
        // (mobile Safari quirk). The focus move is deferred, so in this
        // synchronous test we don't assert WHERE focus is right after open —
        // we just assert that on CLOSE it returns to the opener.

        closeAlertsPanel();
        expect(document.activeElement).toBe(opener);
        expect(isAlertsPanelOpen()).toBe(false);
    });

    it('does NOT crash when the opener was removed from the DOM mid-session', () => {
        const opener = document.getElementById('opener-stub');
        opener.focus();
        openAlertsPanel();
        opener.remove();
        // closeAlertsPanel should swallow the missing-opener case rather than
        // throw or focus document.body.
        expect(() => closeAlertsPanel()).not.toThrow();
    });

    it('handles the case where there was no prior focused element', () => {
        // Blur everything by focusing then blurring.
        document.getElementById('opener-stub').focus();
        document.getElementById('opener-stub').blur();
        // Some jsdom versions leave document.activeElement === body here.
        openAlertsPanel();
        expect(() => closeAlertsPanel()).not.toThrow();
    });
});

describe('focus-trap', () => {
    it('Tab on the last focusable in the panel wraps to the first', () => {
        const opener = document.getElementById('opener-stub');
        opener.focus();
        openAlertsPanel();

        // Get the actual focusables in the order the trap sees them.
        const focusable = [...document.querySelectorAll(
            '#alerts-panel a[href],#alerts-panel button:not([disabled]),' +
            '#alerts-panel input:not([disabled]),#alerts-panel select:not([disabled]),' +
            '#alerts-panel textarea:not([disabled]),#alerts-panel [tabindex]:not([tabindex="-1"])'
        )];
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        last.focus();
        expect(document.activeElement).toBe(last);

        // Fire a synthetic Tab on the document — the trap listens at document level.
        const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.dispatchEvent(evt);
        expect(document.activeElement).toBe(first);
        expect(evt.defaultPrevented).toBe(true);
    });

    it('Shift+Tab on the panel root wraps to the last focusable', () => {
        document.getElementById('opener-stub').focus();
        openAlertsPanel();

        const panel = document.getElementById('alerts-panel');
        const focusable = [...document.querySelectorAll(
            '#alerts-panel button:not([disabled]),#alerts-panel a[href]'
        )];
        const last = focusable[focusable.length - 1];

        panel.focus();
        const evt = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(evt);
        expect(document.activeElement).toBe(last);
        expect(evt.defaultPrevented).toBe(true);
    });

    it('Tab in the middle of the focusable chain does NOT preventDefault', () => {
        // Native Tab behavior should still flow when neither boundary is hit.
        document.getElementById('opener-stub').focus();
        openAlertsPanel();

        const middleBtn = document.querySelector('.alerts-tab[data-tab="service"]');
        middleBtn.focus();

        const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.dispatchEvent(evt);
        // Trap should let this pass — only boundary cases are intercepted.
        expect(evt.defaultPrevented).toBe(false);
    });

    it('non-Tab keys are ignored by the trap', () => {
        document.getElementById('opener-stub').focus();
        openAlertsPanel();

        const focusable = [...document.querySelectorAll('#alerts-panel button')];
        const last = focusable[focusable.length - 1];
        last.focus();

        for (const key of ['Enter', 'Space', 'ArrowDown', 'a']) {
            const evt = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
            document.dispatchEvent(evt);
            expect(evt.defaultPrevented).toBe(false);
        }
        // Focus should not have moved.
        expect(document.activeElement).toBe(last);
    });

    it('Tab is NOT trapped while the panel is closed', () => {
        document.getElementById('opener-stub').focus();
        // Panel never opened.
        expect(isAlertsPanelOpen()).toBe(false);

        const evt = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        document.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(false);
    });
});
