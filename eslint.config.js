// ESLint flat config — CORRECTNESS rules only, no style enforcement.
//
// This is a no-build codebase: there is no compiler/bundler to catch an
// undefined identifier, a typo'd import, or an unused variable before it
// ships. CI tests are behavioral; this lint layer is the only static net.
// Scope is deliberately narrow (eslint:recommended-class checks) so it never
// fights the codebase's prose-comment style or argues about formatting.

import js from '@eslint/js';
import globals from 'globals';

// Correctness rules shared by every source-file `files:` block below.
//   - Unused function ARGS are common in handler signatures; unused
//     locals/imports are dead code a bundler would have flagged.
//   - The codebase intentionally uses empty catch for best-effort paths
//     (localStorage quota, popup teardown) — always with a comment.
const correctnessRules = {
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
    js.configs.recommended,
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // Script-tag global (index.html, vendored same-origin in
                // vendor/maplibre-gl/ — see #245) — not an import.
                maplibregl: 'readonly',
            },
        },
        rules: correctnessRules,
    },
    {
        files: ['scripts/**/*.js', 'scripts/**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: correctnessRules,
    },
    {
        files: ['scripts/**/*.cjs'],
        languageOptions: { sourceType: 'commonjs' },
    },
    {
        // Playwright harnesses: Node scripts whose page.evaluate() callbacks
        // run IN the browser page — window/document there are legitimate.
        files: ['scripts/live-accuracy-headless.js', 'scripts/perf-baseline.js', 'scripts/review-live-snapshot.js'],
        languageOptions: {
            globals: { ...globals.node, ...globals.browser },
        },
    },
    {
        files: ['tests/**/*.js', 'vitest.config.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.node },
        },
        rules: correctnessRules,
    },
    {
        // sw.js is a classic (non-module) service-worker script.
        files: ['sw.js'],
        languageOptions: {
            sourceType: 'script',
            globals: { ...globals.serviceworker },
        },
    },
    {
        ignores: ['node_modules/**', 'data/**', 'docs/**', 'images/**', 'styles/**', 'vendor/**'],
    },
];
