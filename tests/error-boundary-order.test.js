/**
 * The error boundary must be installed before the app's module graph runs
 * (R7-01).
 *
 * `installErrorBoundary()` written as the first statement of main.js does NOT
 * run first. ESM hoists imports: every one of main.js's ~20 imported modules is
 * fully evaluated before that statement executes. A module-scope throw in any
 * of them escapes uncaught — no boundary, no initMap(), no _showFatalBootError()
 * — leaving a permanently stuck splash and zero telemetry. main.js's own comment
 * asserted the opposite for months.
 *
 * Nothing throws at module scope today, so this pins a CONTRACT rather than a
 * live symptom. That is the point: the next person adding a module-scope
 * statement should not have to rediscover it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('the install is its own entry graph, not a statement in main.js', () => {
    const html = readFileSync('index.html', 'utf8');
    const main = readFileSync('js/main.js', 'utf8');
    const install = readFileSync('js/errorBoundaryInstall.js', 'utf8');

    it('index.html loads the installer BEFORE main.js', () => {
        // Parse the actual <script> tags rather than searching the raw text.
        // An indexOf on the filename also matches the EXPLANATORY COMMENT above
        // the tag, so both "reorder the tags" and "delete the tag entirely"
        // passed against a text search — caught by mutating this file.
        const moduleSrcs = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)]
            .map(m => m[1]);
        expect(moduleSrcs, 'the installer must actually be loaded').toContain('js/errorBoundaryInstall.js');
        expect(moduleSrcs).toContain('js/main.js');
        expect(
            moduleSrcs.indexOf('js/errorBoundaryInstall.js'),
            'order is the whole guarantee',
        ).toBeLessThan(moduleSrcs.indexOf('js/main.js'));
    });

    it('main.js no longer calls it itself', () => {
        // A call left behind would be harmless but would re-assert the false
        // claim and invite someone to delete the separate script.
        expect(main).not.toMatch(/^installErrorBoundary\(\);/m);
    });

    it('the installer graph stays shallow', () => {
        // Its guarantee is only as good as what it drags in: any import here is
        // another module evaluated before the boundary exists.
        const imports = [...install.matchAll(/^import .* from '(.+)';$/gm)].map(m => m[1]);
        expect(imports).toEqual(['./errorBoundary.js']);
    });
});

describe('ESM really does hoist past a leading call (the premise)', () => {
    it('a top-level statement runs AFTER every imported module', () => {
        // Guards the guard. If this stopped being true the fix would be
        // unnecessary, and a future reader should learn that from a failing
        // test rather than by reasoning about the spec.
        //
        // Run in a REAL node process: vitest transforms and resolves modules
        // itself, so a fixture imported through it would prove nothing about
        // the browser's evaluation order.
        const dir = mkdtempSync(join(tmpdir(), 'esm-order-'));
        try {
            writeFileSync(join(dir, 'order.mjs'), 'export const order = [];\n');
            writeFileSync(join(dir, 'dep.mjs'),
                "import { order } from './order.mjs';\norder.push('dep-module-scope');\n");
            writeFileSync(join(dir, 'installish.mjs'),
                "import { order } from './order.mjs';\n" +
                "export function installish() { order.push('install-call'); }\n");
            writeFileSync(join(dir, 'entry.mjs'),
                "import { order } from './order.mjs';\n" +
                "import { installish } from './installish.mjs';\n" +
                "installish();\n" +
                "import './dep.mjs';\n" +
                "console.log(JSON.stringify(order));\n");

            const out = execFileSync(process.execPath, [join(dir, 'entry.mjs')], { encoding: 'utf8' }).trim();
            expect(JSON.parse(out), "the imported module's top level wins, not the call")
                .toEqual(['dep-module-scope', 'install-call']);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
