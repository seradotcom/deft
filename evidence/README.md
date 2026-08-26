# Release evidence

This directory is a curated, immutable package of eight scenarios. Run
`npm run verify:submission` to recompute the frozen capability hashes, every
scenario file hash and size, terminal events, executed artifact snapshots,
ledger rows, run IDs, and the HITL audit contracts.

The executable artifacts are the exact LF-normalized files in `capabilities/`,
both at version `2.0.0`. Each replay bundle contains the exact bytes executed as
`artifact.executed.json`; variant replay identity is computed after applying
the declared overlay.

| Bundle | Contract proved |
|---|---|
| `discovery/` | Original genuine LLM discovery source: one discovery `run_start`, terminal `DONE` transcript/run log, screenshots, and the run ID preserved by the lookup artifact's provenance. This historical source predates the 2.0.0 hardening; it is not represented as a 2.0.0 replay. |
| `replay-success/` | Frozen lookup artifact, deterministic `SUCCESS`, typed balance output, no model in the replay. |
| `replay-business-outcome/` | Missing member terminates as `BUSINESS_OUTCOME / MEMBER_NOT_FOUND`, not a system failure. |
| `replay-session-recovery/` | Forced mid-flow expiry, bounded relogin/reconstruction, guarded retry, and terminal `SUCCESS`. |
| `replay-cross-tenant/` | Exact NW variant snapshot and deterministic `SUCCESS` against the second tenant. |
| `risky-gating/` | Irreversible account opening is denied without approval and terminates `FAILED / RISKY_STEP_BLOCKED`. |
| `hitl-approval/` | Approval-only path: `PENDING -> APPROVED`, zero human state changes, no `HUMAN_CONTROL`, then one approved automated risky action and `SUCCESS`. |
| `hitl-manual-takeover/` | Genuine same-session path: `PENDING -> HUMAN_CONTROL -> RESUMED`; the operator clicks the visible live-session screenshot twice, accepts the held native dialog, establishes a semantic before/after delta, satisfies the declared `postCheck`, and finishes `SUCCESS` without retry or fast-forward. |

Replay bundles include a single matching `ledger.jsonl` row. Manual takeover
also includes normalized `before.json` / `after.json`, distinct screenshots,
the console transition log, and engine-side `human_surface_events` containing
the human pointer coordinates and accepted dialog. Local staging paths and
credentials are excluded from the curated package.

To regenerate the replays after `npm run build`, use
`node scripts/capture-release-evidence.mjs automated`, `approval`, and `manual`.
Generate `manifest.json` last with `node scripts/gen-manifest.mjs`; any later
byte change requires regenerating the manifest.
