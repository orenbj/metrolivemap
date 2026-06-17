# docs/audits — point-in-time review reports

Focused reviews of a slice of the app (UX surface, code simplicity, runtime
automations, …). Each is a snapshot of the findings at the time it was written —
like [`docs/_archive/`](../_archive/), **audits are not rewritten after the
fact.** When an audit's recommendations land, the durable outcome belongs in
[`CLAUDE.md`](../../CLAUDE.md) (the contract) or [`docs/STATUS.md`](../STATUS.md)
(the snapshot); the audit itself stays here for provenance.

**Lifecycle:** an audit is *Open* while its findings are un-triaged, *Actioned*
once they're implemented or moved into the backlog, and may be moved to
`docs/_archive/` once fully superseded. Keep the Status column current.

| File | What it reviews | Status |
|---|---|---|
| [`dist-automations-review-2026-06-16.md`](./dist-automations-review-2026-06-16.md) | Browser-side runtime automations (alerts proxy, timers, SW, geolocation, localStorage). Findings D1–D4. Framed around the "dist" bundle, since removed — but the findings are about the app's `js/` and still apply. | **Actioned** — D1 in `config.js` + `HANDOFF.md` §12.2; D2 (#523) + D3 (#524) shipped; D4 kept as intentional forensics. |
| [`app-chrome-ux-audit-2026-06-16.md`](./app-chrome-ux-audit-2026-06-16.md) | App chrome / control surfaces UX. | Open — tied to in-flight work. |
| [`simplicity-audit-2026-06-14.md`](./simplicity-audit-2026-06-14.md) | Code simplicity / reuse opportunities. | Reference. |
| [`station-popup-ux-audit-2026-06-12.md`](./station-popup-ux-audit-2026-06-12.md) | Station arrivals popup UX. | Reference. |
| [`tooltip-surfaces-ux-audit-2026-06-12.md`](./tooltip-surfaces-ux-audit-2026-06-12.md) | Tooltip/popup surfaces consistency across vehicle / station / bikeshare / micro / legend. | Reference. |
