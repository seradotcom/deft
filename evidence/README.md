# Evidence

Curated bundles from real runs. Every `log.jsonl` is the raw structured log
(redacted at the sink — credentials never appear). Screenshots are captured
before/after actions and on every failure.

| Bundle | What it proves |
|---|---|
| `discovery/` | A genuine LLM-driven run (`gemini-3.5-flash`) completing "look up member M10041 and read savings balance" on the live UI: decisions, verified targeting events, action results, final transcript. |
| `artifact.lookup-member-balance.json` | The compiled capability from that run — typed inputs/outputs, verified targeting descriptors, relational extraction, business-outcome declarations, relogin recovery chain, NW tenant variant. Operator-curated (redundant login retries removed; login fills restored from the verified chain). |
| `replay-success/` | Deterministic replay of that artifact with `memberId=M10041` — **no model in the loop** — returning `{"savingsBalance": "$2,450.75"}` with zero degraded steps. |
| `artifact.open-sub-account.json` | Operator-authored capability (no LLM): descriptors captured live with the same record-time verified probing. Covers a multi-field form, a review step, and an irreversible confirm behind a native `window.confirm` dialog. |
| `replay-business-outcome/` | Replay with `memberId=M99999` → `BUSINESS_OUTCOME / MEMBER_NOT_FOUND`. "No such member" is an answer for the caller, not a crash. |
| `replay-session-recovery/` | Session force-expired mid-flow (simulator chaos endpoint) → login redirect detected inside the frame → bounded `relogin` chain fires → triggering step retried and recovered (see `recovering` / `step_ok_after_recovery` events). |
| `replay-cross-tenant/` | The ACME-recorded capability replayed against the **NorthWind** tenant (different branding, labels, vendor version 2.4) via a declarative variant overlay — SUCCESS, same balance. |
| `risky-gating/` | The open-sub-account replay without approval: every step runs until the irreversible confirm → `RISKY_STEP_BLOCKED`. Automation refuses to cross the line unattended. |
| `hitl-approval/` | Same replay with `--escalate`: an intervention is raised on the operator console; the operator takes control, approves, and resumes → `risky_approved_by_operator`, run completes with `resumedByHuman: true`. The native confirm dialog is captured in the surface events. |

Reproduce any of these with the commands in the root README.
