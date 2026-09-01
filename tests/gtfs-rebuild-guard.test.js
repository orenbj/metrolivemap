/**
 * Runs the REAL scripts/gtfs-rebuild-guard.sh — the weekly GTFS rebuild's
 * pre-flight — against a fake `gh`.
 *
 * This test exists because of a bug it would have caught and my first attempt
 * at testing this did not. The guard used to live inline in the workflow YAML,
 * where nothing can execute it, so it was "tested" against a hand-written fake
 * `gh` that printed NOTHING when no PR was open. Real `gh` does not do that:
 * `--jq '.[0] | "\(.number) \(.createdAt)"'` on an empty result set evaluates
 * `.[0]` to null and interpolates it, emitting the literal line "null null".
 * That is non-empty, so the no-PR branch never ran, `date -u -d null` failed,
 * and under `set -e` the guard job died — blocking the rebuild entirely.
 * Faking a dependency's OUTPUT is not testing the contract; the fake below
 * therefore emits real JSON and applies the script's own `--jq` filter with
 * real jq, so jq's actual semantics are in the loop.
 *
 * A note on mutation-testing this file, because the result reads wrong at first
 * glance: reverting `// empty`, or the literal-"null" check, or the fail-open
 * date guard ONE AT A TIME leaves the suite green. That is not a coverage hole
 * — the three are deliberately redundant, and any one of them alone produces
 * correct behaviour, so a single revert is not a behaviour change to detect.
 * Reverting all three reconstructs the code that actually shipped, and four
 * tests go red. Verify that composite, not the singles.
 *
 * Skipped automatically where `jq` is unavailable — the point is moot without
 * it, and CI (ubuntu-latest) always has it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const SCRIPT = 'scripts/gtfs-rebuild-guard.sh';

/** Fake `gh`: applies the script's own --jq filter to a JSON fixture with REAL jq. */
const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "list" ]; then
  filter=''
  while [ $# -gt 0 ]; do
    if [ "$1" = "-q" ] || [ "$1" = "--jq" ]; then filter="$2"; fi
    shift
  done
  printf '%s' "$GH_FIXTURE" | jq -r "$filter"
  exit 0
fi
# pr comment / pr close — record the call so the test can assert on it.
printf '%s\\n' "$*" >> "$GH_CALLS"
`;

let dir;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gtfs-guard-'));
    writeFileSync(join(dir, 'gh'), FAKE_GH);
    chmodSync(join(dir, 'gh'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Run the guard with the given `gh pr list` JSON fixture. */
function runGuard(fixture, { staleDays = '10' } = {}) {
    const out = join(dir, 'out'), summary = join(dir, 'summary'), calls = join(dir, 'calls');
    writeFileSync(out, ''); writeFileSync(summary, ''); writeFileSync(calls, '');
    const r = spawnSync('bash', [SCRIPT], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            GH_FIXTURE: JSON.stringify(fixture),
            GH_CALLS: calls,
            GH_TOKEN: 'x',
            REPO: 'orenbj/metrolivemap',
            STALE_PR_DAYS: staleDays,
            GITHUB_OUTPUT: out,
            GITHUB_STEP_SUMMARY: summary,
        },
    });
    return {
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        output: readFileSync(out, 'utf8'),
        summary: readFileSync(summary, 'utf8'),
        ghCalls: readFileSync(calls, 'utf8'),
    };
}

const daysAgo = d => new Date(Date.now() - d * 86400_000).toISOString();

describe.skipIf(!HAS_JQ)('gtfs rebuild guard', () => {
    it('the script the workflow invokes actually exists', () => {
        // The workflow's `run:` is a bare path; a rename would fail only on the
        // live Monday cron.
        expect(existsSync(SCRIPT)).toBe(true);
        const yml = readFileSync('.github/workflows/rebuild-gtfs.yml', 'utf8');
        expect(yml).toContain(`bash ${SCRIPT}`);
    });

    it('rebuilds when NO rebuild PR is open (the "null null" regression)', () => {
        // jq renders `.[0]` on [] as null, and "\(null) \(null)" as the literal
        // string "null null". Pre-fix this reached `date -u -d null`, exited 1,
        // and took the whole rebuild down with it.
        const r = runGuard([]);
        expect(r.status).toBe(0);
        expect(r.output).toContain('skip=false');
        expect(r.stderr).not.toMatch(/invalid date|unbound variable|syntax error/);
    });

    it('the fake gh really does emit "null null" without the `// empty` fix', () => {
        // Guards the guard: proves the fixture reproduces jq's real behaviour,
        // so the test above is exercising the actual failure mode and not a
        // conveniently silent stub. (This is the assumption my first attempt
        // got wrong.)
        const bad = execFileSync('jq', ['-r', '.[0] | "\\(.number) \\(.createdAt)"'],
                                 { input: '[]', encoding: 'utf8' });
        expect(bad.trim()).toBe('null null');
        const good = execFileSync('jq', ['-r', '.[0] // empty | "\\(.number) \\(.createdAt)"'],
                                  { input: '[]', encoding: 'utf8' });
        expect(good.trim()).toBe('');
    });

    it('treats a PR object with null fields as "no PR", not as a PR named null', () => {
        // `.[0] // empty` only rescues an EMPTY list. A present-but-null-valued
        // entry still interpolates to "null null", so open_pr becomes the
        // string "null" and reaches `date`. Cheap to defend, and it is the
        // shape a future gh/jq change would most likely leak.
        const r = runGuard([{ number: null, createdAt: null }]);
        expect(r.status).toBe(0);
        expect(r.output).toContain('skip=false');
        expect(r.stderr).not.toMatch(/invalid date|unbound variable|syntax error/);
    });

    it('skips while a RECENT rebuild PR is awaiting review', () => {
        const r = runGuard([{ number: 700, createdAt: daysAgo(3) }]);
        expect(r.status).toBe(0);
        expect(r.output).toContain('skip=true');
        expect(r.ghCalls).toBe('');                    // nothing touched
    });

    it('says so LOUDLY in the run summary when it skips', () => {
        // The 25-day freeze was invisible because a skip looked identical to a
        // real rebuild on the Actions page.
        const r = runGuard([{ number: 700, createdAt: daysAgo(3) }]);
        expect(r.summary).toContain('#700');
        expect(r.summary).toMatch(/not being refreshed/i);
    });

    it('supersedes a STALE PR and rebuilds anyway', () => {
        const r = runGuard([{ number: 623, createdAt: daysAgo(25) }]);
        expect(r.status).toBe(0);
        expect(r.output).toContain('skip=false');
        expect(r.ghCalls).toMatch(/pr comment 623/);
        expect(r.ghCalls).toMatch(/pr close 623/);
        expect(r.summary).toMatch(/Superseded/);
    });

    it('treats the boundary day as still-fresh, not stale', () => {
        const r = runGuard([{ number: 700, createdAt: daysAgo(10) }], { staleDays: '10' });
        expect(r.output).toContain('skip=true');
    });

    it('FAILS OPEN on an unparseable createdAt rather than killing the job', () => {
        // A dead guard job blocks the rebuild outright — the exact failure this
        // guard was hardened against. A duplicate PR is the cheaper mistake.
        const r = runGuard([{ number: 700, createdAt: 'not-a-date' }]);
        expect(r.status).toBe(0);
        expect(r.output).toContain('skip=false');
        expect(r.stdout).toMatch(/::warning::/);
    });

    it('never writes both skip values in one run', () => {
        for (const fixture of [[], [{ number: 1, createdAt: daysAgo(2) }],
                               [{ number: 2, createdAt: daysAgo(40) }]]) {
            const lines = runGuard(fixture).output.trim().split('\n').filter(Boolean);
            expect(lines.filter(l => l.startsWith('skip='))).toHaveLength(1);
        }
    });
});
