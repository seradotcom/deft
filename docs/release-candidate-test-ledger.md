# Release Candidate Test Ledger

This ledger records the exact verification state of the release-candidate branch. It is not release evidence and must not be used as a substitute for the frozen evidence manifest.

## Baseline — 2026-08-25

- Commit: `5b083aa` (`Document release candidate hardening plan`)
- Worktree: `.worktrees/release-candidate-hardening`
- Runtime: Node.js project dependencies installed with `npm install`; 0 reported vulnerabilities
- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm test`: PASS — 3 files, 11 tests
- `npm run verify:submission`: reported PASS

The baseline verifier result is a known false positive. Independent audits confirmed that it trusts manifest declarations, does not recompute scenario artifact hashes or terminal JSONL results, accepts approval-only HITL evidence, and does not reject globally duplicated run IDs. The baseline is therefore **NO-GO** despite its reported PASS.

## Contract and preflight hardening — 2026-08-25

- TDD red phase: lax/malformed output schemas, unknown artifact fields, unresolved/future templates, ledger duplication, and contradictory finalization tests failed as expected.
- `npm test -- --run tests/safety.test.ts`: PASS — 25 tests.
- `npm test -- --run tests/replay.integration.test.ts`: PASS — 8 tests, 111.05 seconds.
- Focused ledger-write failure: PASS — no false `ledger_appended`, one `ledger_append_failed`, one terminal `replay_result`.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS.
- Delegated human spec review: APPROVE.
- Independent code-quality review: APPROVE.

The worktree remained free of generated validation ledgers, legacy temporary test directories, and Chromium `debug.log` after the final run.

## Guarded executor hardening — 2026-08-25

- Removed the reduced retry executor; normal, auth, recovery, fast-forward, and retry modes now converge on the guarded `runStep` pipeline.
- Driver action failures are typed terminal failures; non-idempotent uncertain outcomes fail closed without retrying the side effect.
- Recovery and retry evidence distinguishes nested `step_attempt_failed` events from exactly one logical `step_failed` event.
- Expected native dialogs are scoped to the triggering action, awaited with a bound, and always disarmed.
- Fast-forward no longer skips missing or login-like main-flow steps and never crosses a non-idempotent step.
- `tests/executor-safety.integration.test.ts`: PASS — 13 adversarial tests.
- `tests/safety.test.ts` + `tests/replay.integration.test.ts`: PASS — 34 tests.
- Full `npm test`: PASS — 4 files, 49 tests on the final Task 3 state, 162.47 seconds.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS.
- Delegated human release gate: GO for Task 3.
- Independent static code review: GO for Task 3.

## Release gate

Pending. This section will be completed only after code freeze, artifact freeze, evidence regeneration, manifest generation, strict verification, fresh-clone verification, and GitHub CI for the exact final commit.
