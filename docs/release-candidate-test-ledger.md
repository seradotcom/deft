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

## Target-surface and submission hardening — 2026-08-25

- Frame lookup is strict: a missing or ambiguous declared child frame never falls back to its parent.
- Semantic targets are recounted after waits; zero-to-many and one-to-many changes fail closed, and ambiguous semantic locators never degrade to coordinates.
- Semantic replay pins a DOM element before its final policy check, while coordinate actions carry a frame guard into the driver action boundary.
- Discovery validates every live frame before and after output binding and assigns `DONE` only after the final live-surface check.
- Submit effects are explicit in artifacts. Undeclared submit controls are rejected; risky non-idempotent submits require approval, while curated safe idempotent search submits remain unattended.
- Coordinate fallbacks use live viewport/frame geometry, validate bounds, and hit-test submit semantics at the resolved point.
- Relational output bindings reject duplicate row identities within or across tables and frames.
- `tests/target-safety-adversarial.integration.test.ts` + `tests/executor-safety.integration.test.ts`: PASS — 34 tests, 76.23 seconds.
- Full `npm test`: PASS — 5 files, 74 tests, 216.05 seconds.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS.
- Workspace Chromium `debug.log`: absent after the final runs.
- Delegated human release gate: GO for Task 4.
- Independent TOCTOU code review: GO for Task 4.

## Genuine manual takeover — 2026-08-25

- Approval and manual takeover use distinct typed callbacks and intervention kinds; approval cannot acquire the browser lease or satisfy takeover.
- The operator console enforces `PENDING -> HUMAN_CONTROL -> RESUMED` and `PENDING|HUMAN_CONTROL -> ABORTED`; invalid and repeated transitions return HTTP 409.
- Takeover and resume are bound to the replay session. CLI replay is headed whenever escalation is enabled.
- Resume requires a live semantic before/after delta observed independently by the engine and a declared post-check that proves the human established the intended state.
- Valid human completion continues in the same browser without recovery, retry, or fast-forward and emits normal timeline, `after_step`, and `step_ok` evidence.
- Before/after screenshots, semantic hashes, URLs, frame URLs, a11y state, and the console transition JSONL are persisted. Abort terminates as `OPERATOR_ABORTED`.
- Red phase: the new console FSM tests failed 4/4 and the initial engine takeover tests failed 2/2 before implementation.
- Focused HITL + executor verification: PASS — 20 tests, 101.29 seconds.
- Full `npm test`: PASS — 6 files, 81 tests, 259.50 seconds.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS.
- Delegated human Task 5 gate: GO.
- Independent static Task 5 audit: GO.

## Executable artifact freeze — 2026-08-25

- Version rule: a new capability starts at `1.0.0`; replacing stored bytes requires an explicit version. Downgrades and any different bytes at the same version fail before overwrite.
- Both artifacts are frozen at `2.0.0`; the major bump reflects strict output and submission/dialog safety contract changes made during hardening.
- `.gitattributes` pins capability and evidence JSON/JSONL to LF so raw-byte hashes reproduce on Windows and Linux.
- `capabilities/legacybank.lookup-member-balance.json`: 18,645 bytes; SHA-256 `720de53e89794427d3e86d99bd3dbb8520715d7e23eed804fd41254d74dfee07`.
- `capabilities/legacybank.open-sub-account.json`: 26,269 bytes; SHA-256 `4369749f3a4bdaa3757307f13d6b1f8c997bfd337e46e9e3db85d9ad552c2d93`.
- Freeze commit: `83fc3a532d856c2acb3b4410490fa0ae741b24fb` (`Freeze versioned capability artifacts`). This ledger-only follow-up does not alter runtime or artifact bytes.
- Focused artifact/versioning and target-contract verification: PASS — 27 tests, 20.77 seconds.
- Full `npm test`: PASS — 7 files, 87 tests, 259.58 seconds.
- `npm run typecheck`: PASS.
- Existing curated `/evidence` is explicitly marked pre-freeze and must not be treated as release evidence. Task 7 must regenerate every scenario and the manifest from these exact bytes.
- Invalidation boundary: any later runtime/schema/compiler change, capability byte change, relevant dependency/lockfile change, or behavioral documentation change invalidates Task 7 evidence and returns the release to this freeze gate.

## Human-dialog lease and verifier freeze — 2026-08-25

- Runtime freeze commit: `71811e4` (`fix: lease native dialogs to human takeover`).
- Human dialog handling remains automatic outside takeover; the matching replay session acquires the lease only on the persisted `PENDING -> HUMAN_CONTROL` transition.
- A held native dialog requires an explicit operator UI decision. Resume is rejected while a dialog remains pending, and the lease is cleaned on resume, abort, callback error, and engine finalization.
- The simulator's `modalOnPath` fault is opt-in, exact-path scoped, and consumed once; frozen capability bytes are unchanged.
- Submission verifier commit: `ab7b094` (`feat: verify frozen submission evidence`). It owns the expected scenario/status map and frozen artifact hashes, recomputes every declared byte/hash, requires a complete directory inventory, and rejects malformed, mixed-run, stale-ledger, and nominal-only HITL evidence.
- Focused native-dialog + operator FSM verification: PASS — 9 tests.
- Adversarial submission-verifier verification: PASS — 9 tests.
- Full `npm test`: PASS — 9 files, 101 tests, 262.40 seconds.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- Frozen artifacts remain 18,645 / 26,269 bytes with SHA-256 `720de53e89794427d3e86d99bd3dbb8520715d7e23eed804fd41254d74dfee07` and `4369749f3a4bdaa3757307f13d6b1f8c997bfd337e46e9e3db85d9ad552c2d93` respectively.

Evidence generated before the final runtime freeze listed below is invalid. All curated replay, approval, and manual-takeover bundles must be produced from that exact runtime or a later documentation/evidence-only commit.

## Final evidence freeze — 2026-08-25

- Exact runtime freeze: `6bd8f50e269b174dc336e50ef1f9720406d15bd8` (`feat: audit remote human takeover`). The manifest owns and verifies this full commit ID.
- Evidence content freeze: `e02ed657c5ee86666f5370c40f4659621e07342c`; runtime-binding metadata: `75346d7`.
- Eight exact scenarios regenerated from the frozen 2.0.0 artifact bytes. Every replay directory contains `artifact.executed.json`, one terminal run log, one matching ledger row, and a complete SHA-256/byte inventory.
- Approval evidence: run `replay-2026-08-26T05-17-38-265Z-2cf82f`, transitions exactly `PENDING -> APPROVED`, zero human state changes, no manual takeover claim.
- Manual evidence: run `replay-2026-08-26T05-09-32-138Z-5f886f`, transitions exactly `PENDING -> HUMAN_CONTROL -> RESUMED` in the same session. Engine audit records two human viewport clicks, one held native dialog accepted by the operator, a real semantic/screenshot delta, one post-checked manual completion, and no recovery retry or fast-forward.
- The original genuine discovery run remains immutable historical provenance and is verified as such; no claim is made that it executed the later 2.0.0 artifact.
- Full `npm test`: PASS — 9 files, 103 tests, 263.72 seconds.
- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm run verify:submission`: PASS.
- Frozen artifact hashes remain `720de53e89794427d3e86d99bd3dbb8520715d7e23eed804fd41254d74dfee07` and `4369749f3a4bdaa3757307f13d6b1f8c997bfd337e46e9e3db85d9ad552c2d93`.
- Secret/path scan and `git diff --check`: PASS.

## Release gate

- Fresh-clone source SHA: `f44aa8ceb17db2d860f9a2eaac5c7bf8ab0f117a`.
- Fresh `npm ci`: PASS — 136 packages installed, 0 vulnerabilities; no missing optional platform binding.
- Fresh-clone `npm run typecheck`: PASS.
- Fresh-clone `npm run build`: PASS.
- Fresh-clone `npm test`: PASS — 9 files, 103 tests, 268.27 seconds.
- Fresh-clone `npm run verify:submission`: PASS.
- Fresh clone remained clean and contained no `debug.log`; both artifact hashes remained exact.
- GitHub CI for the final `master` commit: pending push.
