# Evidence

Curated bundles from real runs, tied together by [`manifest.json`](manifest.json):
every scenario records its `runId`, the **sha256 of the exact artifact bytes it
executed**, its expected vs actual result, and its file list.
Run `npm run verify:submission` to check all of it automatically.

Every `log.jsonl` is the raw structured log (redacted at the sink — registered
secrets never appear). Screenshots are captured before/after actions, on every
failure, and — during human escalation — periodically while the operator holds
the session (`human_sample` events).

| Bundle | What it proves |
|---|---|
| `discovery/` | A genuine LLM-driven run (`gemini-3.5-flash`) completing "look up member M10041 and read savings balance" on the live UI: decisions, verified-targeting events, action results, and the full `transcript.json` (terminal state `DONE`). The compiled artifact's `provenance.discoveredFromRunId` points at exactly this run. |
| `artifact.lookup-member-balance.json` | The compiled capability — typed inputs/outputs, verified targeting descriptors, relational extraction, declared business outcome, shared relogin recovery chain, NW tenant variant. Operator-curated after discovery (duplicates consolidated; checkpoint strengthened) — curation is a documented workflow step, and the provenance run id is preserved. |
| `replay-success/` | Deterministic replay of that artifact (`memberId=M10041`) — **no model in the loop** — `SUCCESS`, `{"savingsBalance": "$2,450.75"}`, zero degraded steps, `artifactSha256` recorded. Checkpoints assert the member-detail page for the requested member, not just "a click worked". |
| `artifact.open-sub-account.json` | Operator-authored capability (no LLM): descriptors captured live with the same record-time verified probing. Multi-field form → review → irreversible confirm behind a native `window.confirm`. |
| `replay-business-outcome/` | Replay with `memberId=M99999` → `BUSINESS_OUTCOME / MEMBER_NOT_FOUND`. "No such member" is an answer for the caller, not a crash. |
| `replay-session-recovery/` | Session force-expired mid-flow → the login redirect is detected inside the frame → the bounded `relogin` chain re-authenticates → the engine **fast-forwards the deterministic flow** (re-runs the verified steps) to rebuild POST-arrival page state → retried step and the rest of the flow complete: **SUCCESS** with the correct balance. |
| `replay-cross-tenant/` | The ACME-recorded capability replayed against **NorthWind** (different branding, labels, vendor version 2.4) via a declarative variant overlay — patches cover both locator names *and* recorded fingerprints — SUCCESS, same balance. |
| `risky-gating/` | The open-sub-account replay without approval: every step runs until the irreversible confirm → `RISKY_STEP_BLOCKED`, and the log proves the confirm never executed. |
| `hitl-approval/` | Same replay with `--escalate --headed`: the operator console (see `operator-console.png`) shows the REAL live observation; the operator takes control, approves, resumes → `risky_approved_by_operator`, `SUCCESS`, `resumedByHuman: true`, and 5 periodic `human_sample` audit entries captured while the human held the lease. The native confirm dialog is recorded in `surface_events`. |

Reproduce any of these with the commands in the root README, then run
`npm run verify:submission`.
