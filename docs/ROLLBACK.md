# Rollback Runbook — "main is broken, what do I do?"

GitHub Pages auto-deploys from `main` on every push. There's no staging
environment; a bad commit reaches the deploy within ~60 s of merge. This
runbook is the safety net.

The CLAUDE.md rules — feature branch + PR + tests on every PR — are the
prevention layer. This document is the recovery layer for when something
slipped through anyway.

---

## Decide first: severity

Before any action, classify what "broken" means:

| Severity | Symptoms | Recovery action |
|---|---|---|
| **Blank page / hard crash** | White screen, "Application error", no map tiles render | Immediate revert (see §A) |
| **Map renders but no markers** | Tiles + UI OK, no vehicle dots, console errors | Immediate revert (§A) |
| **Markers OK, ETAs wrong** | Visible but obviously bad numbers (negatives, hours) | Same-day fix-forward (§B) preferred — revert (§A) only if a fix isn't fast |
| **A11y / cosmetic regression** | No functional break; one element looks wrong | Fix-forward (§B), no revert |

`Console.error()` and the `globalErrors` counter in `feedStats` are
your first signals. The error-recovery banner (PR #237) auto-appears
when 3+ uncaught errors fire within 30 s — if you see it on production,
the site is in **blank-page-equivalent** state for some users.

---

## §A Immediate revert (target: < 5 min from detection)

Use when the site is hard-broken and any-fix-vs-revert math favors
revert. **Never** force-push to main; the workflow rules forbid it
unless explicitly approved.

```bash
# 1. Verify which commit on main is the bad one
git fetch origin
git log --oneline origin/main -n 5

# 2. Revert it on a branch (creates an inverse commit; does NOT rewrite history)
git checkout main
git pull --ff-only
git revert <bad-sha>            # opens an editor for the revert message
git push origin HEAD:revert-<bad-sha>

# 3. Open a PR for the revert. Don't wait for CI — admin-merge it.
gh pr create \
    --title "revert: <short description> (#<bad-sha>)" \
    --body "Reverting <bad-sha> — production was hard-broken (link to evidence)" \
    --base main \
    --head revert-<bad-sha>

# 4. Merge with --admin to bypass status checks (CI takes ~3 min; outage is now)
gh pr merge <new-pr-num> --squash --admin --delete-branch
```

GitHub Pages picks up the revert in ~60 s. Verify by hard-refreshing
`https://orenbj.github.io/metrolivemap/` (and `https://livemap.metro.net/` once it resolves).

**Why revert, not `git reset --hard`:** the workflow rules forbid
force-push to main. A revert commit is a normal forward commit that
GitHub Pages will deploy. Loss of history risk: zero.

---

## §B Fix-forward (target: < 30 min from detection)

Use when the issue is real but narrowly-scoped and the fix is obvious
within a few minutes. Skipping CI is allowed for trivial fixes
(typo in a string, missing `await`); larger fixes go through normal
PR review.

```bash
# 1. Branch off main
git checkout main && git pull --ff-only
git checkout -b fix/<short-name>

# 2. Make the fix; test locally
npm test

# 3. Push + open PR
git push -u origin HEAD
gh pr create --title "fix: <description>" --body "<root cause + fix>"

# 4. If trivial AND tests pass, admin-merge to bypass review
gh pr merge <pr> --squash --admin --delete-branch
```

---

## §C Restore from a known-good commit (last resort)

If multiple bad commits have stacked and individual reverts are
fragile, restore main to a known-good SHA:

```bash
# Find the last known-good commit (e.g. yesterday's successful CI run)
git log --oneline origin/main -n 30

# Create a branch at that point and PR it as a "restore"
git checkout -b restore/<date> <good-sha>
git push -u origin HEAD

gh pr create \
    --title "restore: main to <good-sha>" \
    --body "Multiple commits since this SHA caused regressions. Reverting bulk."

# Force-merge requires explicit user approval per CLAUDE.md rule 6 —
# do NOT do this autonomously. Get the user's go-ahead first.
```

---

## What NOT to do

- **Don't `git push --force` to main.** CLAUDE.md rule 6 forbids it without explicit user approval. A revert commit is always safer.
- **Don't `git reset --hard` on main.** Same reason. Use revert.
- **Don't skip `--admin` when the issue is real.** Waiting for CI on a revert during an outage adds 3+ min of outage time for no benefit (CI runs the existing tests against the inverse of the bad change; it'll pass).
- **Don't merge a revert without a body explaining what broke.** Future readers (including you in two weeks) need to see what was reverted and why.

---

## Verifying recovery

After any revert / fix-forward:

1. **Hard-refresh** the deployed site (Cmd+Shift+R / Ctrl+Shift+R). GitHub Pages serves the new HTML within ~60 s of push, but the browser may have cached the broken JS.
2. **Open DevTools → Console.** Should be free of `[errorBoundary] uncaught:` lines.
3. **Open DevTools → Network.** Verify the route-icon SVGs, MapLibre JS, and `data/*.json` all return 200.
4. **Wait 30 s** for the WS feeds to settle and check that markers appear on the map.
5. **Click a station dot** and confirm the arrivals popup renders with at least one entry (assumes a live vehicle on the route — try Union Station for the broadest coverage).
6. **Check `feedStats`** in localStorage (`JSON.parse(localStorage.feedStatsRing)`) — the latest entry should show non-zero `accepted` counters for at least `LACMTA_Rail` and `LACMTA`.

If any of those fail, the revert wasn't enough — restart from §A.

---

## Monitoring (so you find out before the user)

- **The `globalErrors` / `unhandledRejections` counters** (PR #237) tick up in the localStorage ring whenever something fails on a live tab. Inspect via `JSON.parse(localStorage.feedStatsRing).slice(-3)` to see the last 3 minutes.
- **The `feed-reliability` workflow** (Wed 17:00 UTC, Fri 23:00 UTC) audits live feeds and files an issue on threshold FAIL.
- **The `live-accuracy` workflow** (Tue + Thu + Sat + Sun) captures live ETA accuracy; sustained MAE regressions show up in the artifact comparison.
- **The `uptime-check` workflow** (`.github/workflows/uptime-check.yml`, every 10 min) is your fastest external signal. It probes the live Pages deploy and requires **both** HTTP 200 **and** the `"Metro Live Map"` title needle in the response body — so a blank-page / broken-shell deploy that still returns 200 is caught, not just hard outages. A single failed fetch is retried (3 attempts, 10 s apart) to suppress edge-node blips before the run fails. On a sustained failure it files (or reuses) an issue labeled `uptime-failure`; on the next successful probe it auto-comments and closes that issue, so recovery self-resolves. Watch for the `uptime-failure` issue — it lands before most users notice.
