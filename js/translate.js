/**
 * translate.js
 * Custom language picker that drives the Google Translate Element widget
 * invisibly via the `googtrans` cookie.
 *
 * Why not just rely on the browser's built-in translate? Two reasons:
 *   1) Chrome/Edge/Safari suppress their own "Translate" affordance when the
 *      page declares <html lang="en"> AND the browser locale is English —
 *      the most common case on a local-LA app — so most riders never see it.
 *   2) Even when it surfaces, the gesture is buried (right-click on desktop,
 *      AA menu on iOS, ⋮ menu on Android Chrome) and Firefox ships nothing
 *      out of the box.
 *
 * Mechanism: the widget reads a cookie named `googtrans` on every page load
 * and auto-translates to the language encoded there (format `/en/<target>`).
 * applyTranslation() sets the cookie + reloads; the widget then translates
 * on the new pageload before any text is visible. Picking 'English' clears
 * the cookie and reloads to the original source.
 *
 * On localhost the widget often refuses to translate (cross-origin cookie
 * weirdness with the proxy iframe Google injects). It works once deployed
 * to a real hostname — verify there, not in local dev.
 *
 * Language list: top 10 spoken languages across LA County per ACS estimates.
 * Native script shown first so a rider who can't read English can still find
 * their language.
 */

/** @type {Array<{code:string,label:string,native:string}>} */
export const LANGUAGES = [
    { code: 'en',    label: 'English',    native: 'English'    },
    { code: 'es',    label: 'Spanish',    native: 'Español'    },
    { code: 'zh-CN', label: 'Chinese',    native: '中文'        },
    { code: 'ko',    label: 'Korean',     native: '한국어'       },
    { code: 'vi',    label: 'Vietnamese', native: 'Tiếng Việt' },
    { code: 'hy',    label: 'Armenian',   native: 'Հայերեն'    },
    { code: 'ar',    label: 'Arabic',     native: 'العربية'    },
    { code: 'ru',    label: 'Russian',    native: 'Русский'    },
    { code: 'ja',    label: 'Japanese',   native: '日本語'       },
    { code: 'tl',    label: 'Tagalog',    native: 'Tagalog'    },
];

const STORAGE_KEY = 'translateLang';
let _widgetLoading = false;

/**
 * Inject Google's Translate Element script. Idempotent — calling more than
 * once is a no-op. The widget reads the `googtrans` cookie on init and
 * auto-translates if it's set, which is the trigger applyTranslation uses.
 */
function _loadWidget() {
    if (_widgetLoading || document.querySelector('.goog-te-combo')) return;
    _widgetLoading = true;

    // Callback Google's script calls when the widget finishes loading. Must
    // be on window — Google looks it up by name in the global scope.
    window.googleTranslateElementInit = function () {
        /* global google */
        new google.translate.TranslateElement(
            { pageLanguage: 'en', autoDisplay: false },
            'google_translate_element'
        );
    };

    const s = document.createElement('script');
    s.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
    s.async = true;
    document.head.appendChild(s);
}

/**
 * Write the `googtrans` cookie the widget reads on init. Format:
 * `/sourceLang/targetLang`, e.g. `/en/es`. Setting to `null` deletes the
 * cookie (revert to source). Set on the bare hostname AND a dotted variant
 * so it works on apex (`metrolivemap.net`), www, and localhost equally.
 *
 * @param {string|null} target  ISO language code or null to clear
 */
function _setGoogTransCookie(target) {
    const host = location.hostname;
    const expires = target ? '' : 'expires=Thu, 01 Jan 1970 00:00:00 GMT;';
    const value = target ? `/en/${target}` : '';
    // Bare hostname (covers localhost + simple deployments)
    document.cookie = `googtrans=${value}; ${expires} path=/;`;
    // Domain-scoped variants — needed for www ↔ apex on a real deployment.
    // Skipping IP / localhost where setting a Domain attribute is invalid.
    if (host.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        document.cookie = `googtrans=${value}; ${expires} path=/; domain=${host};`;
        document.cookie = `googtrans=${value}; ${expires} path=/; domain=.${host};`;
    }
}

/**
 * Apply a translation by setting the cookie and reloading. The widget reads
 * the cookie on the new page load and translates before content is visible.
 * Picking 'en' clears the cookie and reloads to the original source.
 *
 * The reload is a real cost (loses map zoom + open popups) but it's a
 * one-shot at language-pick time. The cookie persists across visits, so a
 * rider who picked Spanish yesterday sees Spanish today without re-picking.
 *
 * @param {string} langCode  ISO language code from LANGUAGES
 */
export function applyTranslation(langCode) {
    if (langCode === 'en') {
        _setGoogTransCookie(null);
        localStorage.removeItem(STORAGE_KEY);
    } else {
        _setGoogTransCookie(langCode);
        localStorage.setItem(STORAGE_KEY, langCode);
    }
    location.reload();
}

/**
 * Ensure the widget is loaded when a saved-lang preference is present. Called
 * from main.js after boot so a returning rider sees the language they
 * previously picked. No-op when the rider is in the default English state.
 */
export function applyStoredTranslation() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved || saved === 'en') return;
    if (!LANGUAGES.some(l => l.code === saved)) {
        localStorage.removeItem(STORAGE_KEY);
        return;
    }
    // Make sure the cookie matches the saved selection (e.g. rider cleared
    // cookies but localStorage survived). Widget then picks it up on init.
    _setGoogTransCookie(saved);
    _loadWidget();
}

/**
 * Read the current language from localStorage. Used by the picker to
 * highlight the active row.
 *
 * @returns {string}  ISO language code (defaults to 'en')
 */
export function getCurrentLanguage() {
    return localStorage.getItem(STORAGE_KEY) || 'en';
}

/**
 * Open the language picker popover anchored to `anchorBtn`. Clicking a
 * language applies it and closes the popover; clicking outside (or pressing
 * Escape) dismisses without changing anything.
 *
 * @param {HTMLElement} anchorBtn  Button to anchor the popover next to
 */
export function openLanguagePicker(anchorBtn) {
    // Toggle: clicking the globe again closes an already-open picker.
    const existing = document.getElementById('translate-picker');
    if (existing) { existing.remove(); return; }

    const currentLang = getCurrentLanguage();
    const picker = document.createElement('div');
    picker.id = 'translate-picker';
    picker.className = 'translate-picker';
    picker.setAttribute('role', 'menu');
    picker.setAttribute('aria-label', 'Choose page language');
    picker.innerHTML = LANGUAGES.map(({ code, label, native }) => {
        const isCurrent = code === currentLang;
        return `<button class="translate-picker-item${isCurrent ? ' is-current' : ''}" ` +
               `data-lang="${code}" role="menuitemradio" aria-checked="${isCurrent}">` +
               `<span class="translate-picker-native">${native}</span>` +
               `<span class="translate-picker-label">${label}</span>` +
               `</button>`;
    }).join('') +
    `<div class="translate-picker-footer">Translation by Google</div>`;

    const rect = anchorBtn.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.left = `${rect.right + 8}px`;
    picker.style.top = `${rect.top}px`;
    picker.style.zIndex = '1000';

    document.body.appendChild(picker);
    picker.querySelector('.translate-picker-item')?.focus();

    picker.addEventListener('click', e => {
        const btn = e.target.closest('[data-lang]');
        if (!btn) return;
        applyTranslation(btn.dataset.lang);
        _closePicker();
    });

    function _onDocClick(e) {
        if (picker.contains(e.target) || anchorBtn.contains(e.target)) return;
        _closePicker();
    }
    function _onKey(e) {
        if (e.key === 'Escape') _closePicker();
    }
    function _closePicker() {
        picker.remove();
        document.removeEventListener('click', _onDocClick, true);
        document.removeEventListener('keydown', _onKey);
    }
    // Capture-phase so our handler runs before MapLibre's. Defer one tick
    // so the opening click doesn't immediately close us.
    setTimeout(() => {
        document.addEventListener('click', _onDocClick, true);
        document.addEventListener('keydown', _onKey);
    }, 0);
}
