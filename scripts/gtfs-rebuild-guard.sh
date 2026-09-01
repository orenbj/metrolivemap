#!/usr/bin/env bash
#
# Pre-flight for .github/workflows/rebuild-gtfs.yml.
#
# Decides whether the weekly GTFS rebuild should run, and writes `skip=true|false`
# to $GITHUB_OUTPUT plus a human-readable line to $GITHUB_STEP_SUMMARY.
#
# Policy, in one sentence: a rebuild PR that is still awaiting review must not be
# disturbed, but it must not be able to freeze committed GTFS data forever either.
#
#   - no open `gtfs-data` PR                  -> rebuild
#   - open PR younger than $STALE_PR_DAYS     -> skip (loudly, in the run summary)
#   - open PR older than that                 -> comment, close, rebuild anyway
#
# This lives in a FILE rather than inline in the workflow YAML on purpose. The
# inline version shipped a bug that only the live Monday cron could find: the jq
# filter `.[0] | "\(.number) \(.createdAt)"` renders an EMPTY result list as the
# literal string "null null", so the `-z "$open_pr"` no-PR branch never fired and
# `date -u -d null` killed the job under `set -e`. The rebuild could not run at
# all. Shell embedded in YAML is shell nobody can execute in a test; the
# regression suite (tests/gtfs-rebuild-guard.test.js) runs THIS file against a
# fake `gh` that pipes real JSON through real jq, which is what makes the
# `.[0] // empty` contract below verifiable instead of assumed.
#
# Environment: GH_TOKEN, REPO, STALE_PR_DAYS, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY.

set -euo pipefail

: "${REPO:?REPO is required}"
: "${STALE_PR_DAYS:?STALE_PR_DAYS is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_STEP_SUMMARY:?GITHUB_STEP_SUMMARY is required}"

# `.[0] // empty` is load-bearing: on an empty result set `.[0]` is `null`, and
# interpolating null into a string yields "null null" — a NON-EMPTY line that
# sails past every emptiness check downstream. `// empty` makes jq print nothing
# at all, which is the only representation of "no PR" the shell can detect.
#
# Plain command substitution + cut, not `read < <(...)`: process substitution is
# a bashism and this must not depend on the caller's shell staying bash.
pr_line=$(gh pr list --repo "$REPO" --state open --label gtfs-data \
            --json number,createdAt \
            -q '.[0] // empty | "\(.number) \(.createdAt)"' 2>/dev/null || true)
open_pr=$(printf '%s' "$pr_line" | cut -d' ' -f1)
created=$(printf '%s' "$pr_line" | cut -d' ' -f2)

# Belt and braces: `null` is also what a future gh/jq change would most likely
# leak here, and it must never reach `date`.
if [ -z "${open_pr:-}" ] || [ "$open_pr" = "null" ]; then
  echo "No open rebuild PR — proceeding."
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "No open rebuild PR — rebuilding." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

# An unparseable createdAt must FAIL OPEN (rebuild), never crash the job. A dead
# guard job blocks the rebuild entirely, which is the exact failure this
# workflow's guard was hardened against; a duplicate PR is the cheaper mistake.
created_epoch=$(date -u -d "$created" +%s 2>/dev/null || true)
if [ -z "$created_epoch" ]; then
  echo "::warning::Could not parse createdAt '$created' for PR #$open_pr — rebuilding rather than skipping on unknown age."
  echo "skip=false" >> "$GITHUB_OUTPUT"
  echo "Could not determine the age of PR #$open_pr — rebuilding." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

age_days=$(( ( $(date -u +%s) - created_epoch ) / 86400 ))

if [ "$age_days" -le "$STALE_PR_DAYS" ]; then
  # Normal case: a recent PR is awaiting review. Skip, but say so LOUDLY in the
  # run summary — the old failure mode was invisible precisely because a skip
  # looked identical to a real rebuild on the Actions page.
  echo "Rebuild PR #$open_pr is open (${age_days}d old) — skipping this run."
  echo "skip=true" >> "$GITHUB_OUTPUT"
  {
    echo "### ⏭️ Rebuild skipped"
    echo "PR #$open_pr is open and ${age_days} day(s) old (limit ${STALE_PR_DAYS})."
    echo "**Committed GTFS data is not being refreshed while it stays open.**"
  } >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

echo "Rebuild PR #$open_pr is ${age_days}d old (> ${STALE_PR_DAYS}) — superseding it."
gh pr comment "$open_pr" --repo "$REPO" --body \
  "Superseded automatically: this rebuild PR has been open ${age_days} days (limit ${STALE_PR_DAYS}), which blocks every subsequent weekly rebuild and freezes committed GTFS data. Closing so a fresh rebuild can run — no data is lost, \`data/*.json\` is regenerated from Metro's feeds on every run." || true
gh pr close "$open_pr" --repo "$REPO" || true
echo "skip=false" >> "$GITHUB_OUTPUT"
{
  echo "### ♻️ Superseded a stale rebuild PR"
  echo "Closed #$open_pr (${age_days} days old) and rebuilt with fresh data."
} >> "$GITHUB_STEP_SUMMARY"
