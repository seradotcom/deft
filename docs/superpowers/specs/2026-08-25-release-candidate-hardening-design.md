# DEFT Release Candidate Hardening Design

Date: 2026-08-25  
Status: Approved with mandatory conditions by the delegated human auditor

## Objective

Produce one reproducible DEFT release candidate whose runtime safety claims, compiled capability artifacts, curated evidence, verifier output, documentation, and GitHub CI all describe the same immutable build.

This is a hardening pass, not a product rewrite. The existing discovery/compiler/replay architecture remains, but every execution path must share the same safety invariants and every release claim must be mechanically verifiable.

## Considered approaches

### A. Harden the existing architecture (selected)

Centralize execution and finalization, make HITL transitions explicit, strengthen contracts and targeting, then regenerate all release evidence from frozen artifacts. This fixes the audited correctness gaps while keeping the task focused.

### B. Replace the replay and evidence subsystems

A broader event-sourced redesign could make several invariants structural, but it would increase delivery risk and obscure the take-home's core demonstration. Rejected for this release.

### C. Repair only documentation, evidence, and the verifier

This would make the package look coherent while leaving real policy, retry, dialog, targeting, and HITL defects. Rejected because the evidence must describe safe behavior, not compensate for unsafe behavior.

## Runtime architecture

### Preflight

Before creating any browser side effect, replay validates the complete artifact and resolved runtime data:

- the artifact schema contains only supported binding sources;
- every template reference resolves;
- output schemas require their declared properties and reject unknown properties;
- artifact version and bytes identify the executable definition;
- entry URL is allowed.

When the caller provides `artifactBytes`, preflight verifies that their JSON
describes the supplied artifact. A base run hashes those exact raw bytes; a
tenant run hashes canonical deterministic bytes of the post-variant
definition. In-memory runs use the same canonical representation. Input
contract failures are a separate typed `INPUT_CONTRACT_VIOLATION` boundary;
malformed artifacts, bindings, templates, and byte mismatches remain
`ARTIFACT_INVALID` before browser creation.

Preflight failures return `ARTIFACT_INVALID` and never navigate, fill, click, press, select, extract, or invoke recovery.

`ARTIFACT_INVALID` is a typed exception raised before a run/browser context exists; it therefore does not manufacture a `ReplayResult` or ledger row. By contrast, an output contract violation occurs after execution and is represented by one terminal `ReplayResult` with status `FAILED` and one matching ledger row.

### One guarded executor

Initial execution, `authPhase`, recovery actions, fast-forward reconstruction, and retry all enter the same guarded step executor. A mode may disable recursive recovery, but it may not disable:

- actual target-surface URL policy checks;
- strict frame resolution;
- exactly-one targeting;
- risk classification and approval gates;
- scoped dialog handling;
- post-checks;
- surface-event and evidence collection.

The executor distinguishes a physical key press from submission semantics. Any `type+Enter`, Enter press on a form, submit control, or form submission is `SUBMIT`; unknown submit risk fails closed. Non-idempotent steps are never silently retried or skipped. If recovery cannot prove safe reconstruction, it escalates or terminates explicitly.

### Target-surface safety

Immediately before every interaction, discovery and replay validate the current URL of the real main frame or child frame that will receive the action. A declared child frame that is absent never falls back to its parent or main frame.

Locator resolution follows exactly-one semantics. After waiting it recounts; zero or multiple matches fail and cannot fall through to coordinates. Record-time probes enforce the same rule. Persisted table bindings require a unique row key, not merely a unique output value.

Coordinate fallback honors its declared coordinate space. `frame-px` is relative to the resolved frame; `viewport-grid` uses the current viewport dimensions. Fixed synthetic viewport dimensions are not used.

Dialog acceptance is scoped to one validated action. The expectation is armed only after target and policy checks, and is always disarmed if the action throws or does not consume it. An unrelated later dialog remains unexpected and is dismissed.

### Finalization and ledger

Each replay has one terminal finalization path:

1. execute all eligible steps;
2. extract and validate outputs;
3. determine the final status;
4. append exactly one ledger row for the `runId`;
5. emit one terminal `replay_result` event.

No provisional success is written. An invalid output produces only `FAILED`. Curated ledgers reject duplicate run IDs.

A physical ledger write failure is the sole exception to the one-row invariant:
the run returns `FAILED / LEDGER_WRITE_FAILED`, emits `ledger_append_failed`,
and emits no `ledger_appended` claim. If evidence storage fails after a ledger
row was written, replay throws the typed `EVIDENCE_WRITE_FAILED` exception and
does not return a misleading terminal result; release verification rejects the
row because its run has no terminal `replay_result` event.

## Human-in-the-loop architecture

`approval` and `manual_takeover` are different intervention types. Approval authorizes automation to perform a risky action; it never counts as evidence that a human took control.

A manual takeover uses a strict state machine:

```text
PENDING -> HUMAN_CONTROL -> RESUMED
                         -> ABORTED
```

Invalid transitions return HTTP 409. `RESUMED` requires:

- an earlier transition to `HUMAN_CONTROL`;
- the same browser/session identity;
- an observable before/after state difference;
- at least one recorded human state change.

After resume, automation re-observes the current page and continues from that state. It does not invoke session-recovery fast-forward. Session recovery remains a separate mechanism for reconstructing expired authentication state.

The operator console reports `pending`, `in-human-control`, `resumed`, or `aborted` faithfully. A manual-takeover evidence run must show the state transitions, a non-identical before/after state, the human action, and continuation in the same session.

## Artifact and release integrity

Capability definitions are immutable within a version. A changed executable definition receives a changed version and hash. Every evidence scenario either embeds the exact definition it executed or references a frozen artifact whose recomputed SHA-256 matches the manifest.

The release sequence is mandatory:

```text
freeze code
-> pass unit/integration tests
-> freeze capability artifacts and versions
-> regenerate all curated evidence
-> generate manifest last
-> run the independent verifier
-> verify from a fresh clone of the exact commit
-> verify GitHub CI for that commit
-> make no code/artifact/evidence changes afterward
```

The verifier does not trust declared manifest values. It recomputes file hashes, derives terminal results from JSONL, rejects missing or multiple terminal results, detects duplicate run IDs globally, validates the exact executed definition, and distinguishes manual takeover evidence from approval evidence.

## Documentation contract

README, REPORT, and evidence documentation describe only behavior proven by the frozen release. They do not claim surface abstraction, ledger-derived approval state, manual changes, schema dialect enforcement, or replay guarantees beyond what code and evidence demonstrate. All commands are runnable from a fresh clone.

## Acceptance criteria

The release is GO only when all of the following are observed:

1. Initial, auth, recovery, fast-forward, and retry paths share every guard.
2. One replay creates one terminal event and one ledger row.
3. Invalid outputs never produce a success row.
4. Actual main/child frame URLs are checked immediately before action.
5. Submission semantics fail closed and are never implicitly safe.
6. Dialog expectations cannot leak to later actions.
7. Missing frames, unresolved templates, unsupported bindings, zero targets, and ambiguous targets fail before side effects.
8. Output contracts require declared data and reject extras.
9. Manual takeover proves the strict transition sequence, real state change, same session, and resumed automation.
10. Final artifacts, evidence, manifest, verifier, docs, fresh-clone results, and GitHub CI agree on the exact commit and hashes.

