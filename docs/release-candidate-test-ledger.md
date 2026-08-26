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

## Release gate

Pending. This section will be completed only after code freeze, artifact freeze, evidence regeneration, manifest generation, strict verification, fresh-clone verification, and GitHub CI for the exact final commit.
