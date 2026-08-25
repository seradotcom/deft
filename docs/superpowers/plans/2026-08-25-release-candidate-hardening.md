# DEFT Release Candidate Hardening Implementation Plan

> Execute this plan in an isolated worktree. For each task: write the failing test first, confirm the intended failure, make the smallest implementation change, run the focused tests, then commit. A fresh reviewer must check spec compliance and code quality before the next dependent task.

**Goal:** deliver one immutable, reproducible DEFT release candidate that passes the design acceptance criteria and GitHub CI.

**Architecture:** preserve the current discovery/compiler/replay structure while centralizing guarded execution and terminal finalization. Separate approval from genuine manual takeover. Freeze artifacts before regenerating evidence and make the verifier derive facts from bytes and logs.

**Stack:** TypeScript, Node 22, Vitest, Playwright, Express, AJV, Zod, GitHub Actions.

## Task 1: Establish the isolated baseline and test ledger

**Files:**

- Create: `.worktrees/release-candidate-hardening/` through Git worktree tooling
- Create: `docs/release-candidate-test-ledger.md`

**Steps:**

1. Verify `.worktrees` is ignored; add only the ignore entry if necessary.
2. Create branch `release-candidate-hardening` in the isolated worktree.
3. Run `npm install`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run verify:submission` as baseline.
4. Record exact commands, results, commit, and known verifier false-positive in the test ledger.
5. Commit the two planning documents and any required `.gitignore` change.

## Task 2: Make contracts fail closed before side effects

**Files:**

- Modify: `src/core/artifact.ts`
- Modify: `src/replay/support.ts`
- Modify: `src/surface/targeting.ts`
- Modify: `src/replay/engine.ts`
- Modify: `src/agent/compiler.ts`
- Test: `tests/replay.integration.test.ts`
- Test: `tests/safety.test.ts`

**Tests first:**

1. `configKey` is rejected by schema as `ARTIFACT_INVALID`.
2. Missing templates in navigate/fill/check fail before page navigation or interaction.
3. Declared output properties are required and unknown output properties fail validation.
4. Missing extracted output yields one final `FAILED` result.

**Implementation:**

1. Remove the unsupported `configKey` schema branch.
2. Add a complete artifact-template preflight and make interpolation throw on unresolved references.
3. Normalize compiler-produced object output schemas to `required` plus `additionalProperties:false`.
4. Ensure replay invokes preflight before constructing any side effect.

## Task 3: Centralize guarded execution and terminal finalization

**Files:**

- Modify: `src/replay/engine.ts`
- Modify: `src/replay/support.ts`
- Test: `tests/replay.integration.test.ts`
- Test: `tests/safety.test.ts`

**Tests first:**

1. A run appends exactly one ledger row and emits one terminal `replay_result`.
2. Output validation failure writes only `FAILED`.
3. Auth, recovery, fast-forward, and retry apply policy, risk, post-check, dialog, and event guards.
4. A non-idempotent step whose completion is uncertain escalates/terminates without retrying its side effect.
5. `ELEMENT_NOT_FOUND`, `TIMEOUT`, ambiguity, policy denial, and missing frame are never benign fast-forward skips.

**Implementation:**

1. Replace the reduced retry body with the same guarded executor used by normal steps.
2. Permit execution modes only to disable recursive recovery, never guards.
3. Centralize output validation, status classification, terminal event emission, and one ledger append.
4. Make unsafe reconstruction explicit rather than optimistic fast-forward.

## Task 4: Enforce target-surface, submit, targeting, and dialog invariants

**Files:**

- Modify: `src/core/actions.ts`
- Modify: `src/core/artifact.ts`
- Modify: `src/agent/planner.ts`
- Modify: `src/agent/discover.ts`
- Modify: `src/agent/compiler.ts`
- Modify: `src/safety/risk.ts`
- Modify: `src/surface/driver.ts`
- Modify: `src/surface/targeting.ts`
- Modify: `src/replay/engine.ts`
- Modify: `src/replay/support.ts`
- Test: `tests/safety.test.ts`
- Test: `tests/targeting.integration.test.ts`
- Test: `tests/replay.integration.test.ts`

**Tests first:**

1. Top-frame redirect and forbidden child-frame action are blocked immediately before interaction in discovery, initial replay, extraction, checkpoint, and retry.
2. Missing declared child frame never resolves against main/parent frame.
3. `type+Enter`, Enter on a form, submit buttons, and form submits are `SUBMIT` and fail closed when risk is unknown.
4. A zero-to-many locator transition is rejected after recount; multiple matches never fall back to coordinates.
5. Record-time probes reject non-unique locators and non-unique row keys.
6. A failed/no-dialog expected step cannot autoaccept a later unrelated dialog.
7. `frame-px` and live-viewport `viewport-grid` coordinates resolve correctly.

**Implementation:**

1. Add explicit submission semantics to action and artifact IR and classification.
2. Resolve the exact frame strictly, then check its current URL immediately before every operation.
3. Recount after waits and require exactly one match in record and replay paths.
4. Validate persisted table row keys for uniqueness.
5. Replace the global dialog flag with an action-scoped arm/consume/disarm handle.
6. Honor declared coordinate spaces using current frame/viewport geometry.

## Task 5: Implement genuine manual takeover

**Files:**

- Modify: `src/hitl/operator-console.ts`
- Modify: `src/replay/engine.ts`
- Modify: `src/core/artifact.ts` if intervention metadata requires it
- Test: `tests/replay.integration.test.ts`
- Create or modify: focused HITL integration tests under `tests/`

**Tests first:**

1. Approval and `manual_takeover` are distinct and approval cannot satisfy takeover.
2. Invalid FSM transitions return HTTP 409.
3. Resume from pending is rejected.
4. Resume requires same session, takeover state, observable before/after difference, and `humanStateChanges >= 1`.
5. A valid takeover follows `PENDING -> HUMAN_CONTROL -> RESUMED`, re-observes current state, and continues without recovery fast-forward.
6. Abort follows `PENDING|HUMAN_CONTROL -> ABORTED` and cannot resume.

**Implementation:**

1. Introduce typed intervention kind and strict transition functions.
2. Record session identity, before/after observations, and human state-change evidence.
3. Expose only transition endpoints whose preconditions are enforced server-side.
4. Resume normal observation/execution in the existing browser context; do not invoke session-recovery reconstruction.

## Task 6: Version and freeze executable artifacts

**Files:**

- Modify: `src/agent/compiler.ts`
- Modify: `capabilities/legacybank.lookup-member-balance.json`
- Modify: `capabilities/legacybank.open-sub-account.json`
- Modify: relevant artifact/version tests
- Modify: `README.md`
- Modify: `REPORT.md`

**Tests first:**

1. Changed executable definitions cannot retain an existing immutable version/hash identity.
2. Compiler emits the next intended version rather than unconditional `1.0.0`.
3. Final lookup and risky artifacts satisfy strict output, submit, dialog, and targeting contracts.

**Implementation:**

1. Define and enforce the project versioning rule.
2. Recompile or minimally migrate both capabilities to the new schema/version.
3. Freeze their exact bytes and record SHA-256 values in the release ledger.
4. Update docs to state only implemented behavior; remove audited overclaims.

No runtime, schema, compiler, or capability change is allowed after this task without invalidating all later evidence.

## Task 7: Rebuild curated evidence and cryptographic verification

**Files:**

- Modify: `scripts/gen-manifest.mjs`
- Modify: `scripts/verify-submission.mjs`
- Modify: `evidence/**`
- Modify: `evidence/README.md`
- Modify: verifier tests or add `tests/submission-verifier.test.ts`

**Tests first:**

1. Verifier rejects a modified artifact despite a stale manifest hash.
2. Verifier derives the terminal result from JSONL and rejects zero/multiple terminal events.
3. Verifier rejects duplicate run IDs globally.
4. Verifier rejects evidence that does not preserve/reference the exact executed definition.
5. Approval-only or identical-screenshot evidence cannot pass manual-takeover requirements.
6. Valid takeover evidence requires transition sequence, same session, real state change, and at least one human state change.

**Implementation:**

1. Recompute hashes from bytes and parse terminal facts from logs.
2. Generate the manifest only from frozen evidence and artifacts, as the final generated file.
3. Run every curated scenario again, including a genuine delegated-human takeover in the same browser session.
4. Curate one ledger row per run and remove historical contamination from the release evidence set.
5. Run `npm run verify:submission` and record the exact output.

## Task 8: Independent release gate and delivery

**Files:**

- Modify only release notes/test ledger if facts are missing; any code/artifact/evidence change returns to Task 6 or 7.

**Steps:**

1. Run the full local matrix: typecheck, build, all tests, verifier, lint if present, and README commands.
2. Use Chrome/Playwright to validate the final happy path, risky approval, and genuine manual takeover; capture only frozen-release evidence.
3. Have the delegated human auditor issue a fresh GO/NO-GO against the acceptance criteria.
4. Commit the frozen release candidate.
5. Create a fresh clone of that exact commit and repeat the documented commands.
6. Push the approved commit to `master` under the user's authorization and watch GitHub Actions to completion.
7. Confirm the remote `master` SHA equals the locally audited SHA and CI is green.
8. Make no subsequent modification. Report the exact commit, CI URL, test counts, evidence/verifier result, and any residual limitations.

