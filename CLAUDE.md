# Metro Live Map — Developer Workflow

## Git Workflow Rules

These rules apply to **every Claude Code session**. They enforce safe, reviewable development.

1. **Never commit directly to `main`.** Always work on a feature branch. Claude Code creates a git worktree + branch automatically — use it.
2. **Commit after each logical sub-task** using the format `feat:`, `fix:`, `polish:`, or `refactor:` followed by a short description.
3. **Check `.gitignore` before staging.** Never track `.env`, `scripts/*.jsonl`, `*.log`, or GTFS `.txt` files.
4. **Scope control.** Only modify files directly relevant to the current task. If a change in another file is needed, flag it to the user before editing.
5. **All merges go through a Pull Request.** The user reviews each changed file in GitHub Desktop before approving. Do not ask to bypass this.
6. **No force pushes.** Never run `git push --force` or `git reset --hard` without explicit user approval.

---

## Key Constraints

- **No build step** — all imports are relative ES module paths. CDN libs loaded via `<script>` tags in `index.html`.
- **Always edit files in the active worktree**, not directly in the main branch if a worktree is open.
- **data/ files** — Built JSON files (rail-shapes.json, stops.json, trips.json, bus-routes.json, metro-micro-zones.json) are committed; raw GTFS source files (*.txt, *.zip) are gitignored.
- **GitHub Pages deployment** — serves from repo root. `index.html` must be at root. Push to `main` auto-deploys. Custom domain `livemap.metro.net` in CNAME is pending DNS.
- **API keys** in `config.js` are client-visible; restrict via referrer policies in ESRI/MapTiler dashboards.
- **Tests** — `npm test` runs the Vitest suite (12 test files, 183 tests covering predictions, snap, heading, spike rejection, DR animation, marker lifecycle, calibration, adherence, boarding merging, trip updates, and the WS API). Run after any change to ETA, snapping, or marker logic.

---

## Helpful References

- **Architecture & modules** — see README.md
- **Live feeds & data sources** — see README.md
- **Stack & tech** — see README.md
