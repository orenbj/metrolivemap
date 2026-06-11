// ESLint flat config — CORRECTNESS rules only, no style enforcement.
//
// This is a no-build codebase: there is no compiler/bundler to catch an
// undefined identifier, a typo'd import, or an unused variable before it
// ships. CI tests are behavioral; this lint layer is the only static net.
// Scope is deliberately narrow (eslint:recommended-class checks) so it never
// fights the codebase's prose-comment style or argues about formatting.

import js from '@eslint/js';
import globals from 'globals';

export default [
    js.configs.recommended,
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                // CDN script-tag global (index.html) — not an import.
                maplibregl: 'readonly',
            },
        },
        rules: {
            // Unused function ARGS are common in handler signatures; unused
            // locals/imports are dead code a bundler would have flagged.
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            // The codebase intentionally uses empty catch for best-effort paths
            // (localStorage quota, popup teardown) — always with a comment.
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['scripts/**/*.js', 'scripts/**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: { ...globals.node },
        },
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },
    {
        files: ['scripts/**/*.cjs'],
        languageOptions: { sourceType: 'commonjs' },
    },
    {
        // Playwright harnesses: Node scripts whose page.evaluate() callbacks
        // run IN the browser page — window/document there are legitimate.
        files: ['scripts/live-accuracy-headless.js', 'scripts/perf-baseline.js'],
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
        rules: {
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
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
