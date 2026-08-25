# REPORT — DEFT (Computer-Use Automation System)

> **The model discovers. The capability replays.**
> One principle throughout: **degradation is explicit, never silent** — in
> targeting, extraction, tenancy, recovery, and escalation.

The target is **LegacyBank** (`src/targets/legacybank`): a hostile simulator of
the real problem — two tenants (ACME FCU / NorthWind CU) on the same vendor
product, server-rendered `<frameset>`, WebForms controls (`ctl00$…`), no test
IDs, native `confirm()` on the irreversible step, session timeouts, and a
fault-injection endpoint. Everything below ran against it; bundles in
`/evidence`, verified by `npm run verify:submission`.

## 1. Architecture

Single process, five ports, CLI as the face. No queues, no services — the
*boundaries* are the design.

```
Discovery (LLM, once)          Replay (no model, always)
  observe→decide→act→record      locate→policy→act→verify per step
       │                              │
       ▼                              ▼
  SurfaceDriver (Playwright impl)   PolicyEngine · EvidenceLogger
  compile → Capability Artifact     EscalationManager ⇄ Operator Console
```

Three decisions carry the design:

**Record-time verified targeting.** Most systems store what the driver clicked.
DEFT marks the element with a temporary attribute, probes candidate semantic
locators *live* (role/name → label → vendor `name` attr → id → coordinate), and
keeps only candidates whose first match **is the marked element**. The stored
descriptor carries `quality` (`verified|partial|coordinate-only`) plus a
fingerprint that replay re-verifies with a similarity score. Ambiguity is a
signal: a locator matching >1 element is rejected even if the first match looks
right.

**Credentials never enter model context.** Authentication is a deterministic
engine-side phase (`authPhase` in the artifact): the engine fills credentials
from env bindings and submits *before* the planner's first observation. The
model discovers the *capability*, not the *login*. Replay runs the same
`authPhase` through the same guarded pipeline. Secrets are engine-scope values,
never prompt content.

**One guarded pipeline.** Normal steps, recovery-chain fills, fast-forward
re-runs, and the auth phase all execute through the same `runStep` — strict
frame resolution, frame-URL policy check, evidence. Recovery and retries set
internal flags to prevent recursion, not to bypass guarantees.

## 2. Artifact schema

Zod is the single source of truth: static types, runtime validation, JSON
Schema contract. Key decisions:

- **Inputs/outputs are JSON Schema (draft 2020-12)**, validated with AJV at
  invocation and before SUCCESS — any agent can check the contract without our
  code.
- **Steps carry human `intent`** alongside machine fields; a reviewer reads the
  flow without decoding descriptors.
- **Values are templates** (`{{inputs.memberId}}`, `{{env.password}}`).
  Credential values cannot leak into artifacts because they are references,
  never literals. Unresolved templates throw `ARTIFACT_INVALID` — writing
  `'{{env.password}}'` into a live input is not an option.
- **Business outcomes are declarative**: `businessOutcomes[]` with concrete
  detection patterns (`pageTextContains`, `urlGlob`) and caller-facing payloads.
  "No such member" is an answer, not a crash.
- **Targeting chains are honest**: `primary` (semantic) → `fallbacks`
  (weaker → legacy → coordinate as explicit last resort, with an explicit
  `space: frame-px | viewport-grid`) + `fingerprint` + `quality` + `rationale`.
- **`idempotent: false` on non-idempotent steps** — recovery fast-forward
  refuses to re-execute them (a submit that already happened must not happen
  twice).
- **The artifact is immutable after compilation.** Runtime history lives in an
  append-only `validation.jsonl` ledger keyed by artifact sha256. Approval
  state is derived from the ledger, never written into the definition.

## 3. Determinism & error handling

**Determinism**: no model between steps; values only from declared inputs/env;
locators resolved through the verified chain with fingerprint scoring
(ambiguity = fail, not `.first()`); waits that respect 302-redirect chains
(frame-URL stability, not just DOM-ready — which fires on the empty redirect).

**Three-way result contract**:
- `SUCCESS` — frame-aware checkpoints verified, typed outputs validated
  against the output schema.
- `BUSINESS_OUTCOME` — declared, expected answer (`MEMBER_NOT_FOUND`).
- `FAILED` — `{stepId, phase, errorClass, expected, observed, evidenceRefs}`.

**Recovery**: bounded per-step chains (`maxAttempts ≤ 3`, every attempt in
evidence). Session expiry mid-flow: the login redirect is detected across all
frame URLs, the relogin chain re-authenticates, then the engine **fast-forwards
the deterministic flow** (re-runs verified steps, skipping non-idempotent ones
— crossing one escalates instead of duplicating a side effect) and retries.
Evidence: `replay-session-recovery/` → SUCCESS.

**Fail-closed geometry**: frame resolution is strict (`FRAME_NOT_FOUND`, never
"act on the parent"); the coordinate fallback is legal only for clicks
(`COORDINATE_FALLBACK_UNSUPPORTED` for fill/select/press); policy is checked
on the *target frame's* URL, not the top-level (which never changes in a
frameset app).

## 4. Heterogeneity & multi-tenant

**Surface abstraction**: everything above `SurfaceDriver` is surface-agnostic.
A desktop driver (UIA) would implement the same port — the observation format
and action IR were designed for that translation.

**Multi-tenant is demonstrated, not just designed.** The lookup capability was
recorded on ACME and replayed on **NorthWind** (different branding, labels,
vendor v2.4) via declarative variant overlays. Patches cover locator names *and*
recorded fingerprints (identity evidence must match the tenant surface too).
Vendor-stable `name` attributes in fallback chains provide a second mechanism.
Evidence: `replay-cross-tenant/` → SUCCESS.

## 5. Escalation & handoff

A **lease** model: exactly one controller (`automation | human`) owns the live
session. Triggers: the model's `ask_human`, unrecoverable failures, and risky
steps (blocked unattended, evidence: `risky-gating/`).

When escalated, the engine captures the **real current observation** and starts
a **live-session sampler** (~1.5 s screenshot + frame-aggregated text hash) —
the sample series is the audit record of what the operator did, and
`humanStateChanges` counts real state transitions under human control. The
operator works the **same headed browser** via the console's Take Control, then
Resume. The engine re-observes and continues from actual state — after human
escalation it retries only the current step (no fast-forward, trusting the
human's fix); after session recovery it fast-forwards (rebuilding known state).

Evidence (`hitl-approval/`): intervention → real observation on the console →
takeover → approval → native confirm accepted → SUCCESS with
`resumedByHuman: true` and 16 audit samples. `operator-console.png` shows the
intervention card.

## 6. Safety

- **Allowlist before action, both loops**: navigation targets and the target
  frame's URL are policed per interaction; blocked actions are fed back to the
  planner (discovery) or hard-fail (replay, `POLICY_BLOCKED`).
- **Risk classified outside the LLM**: during discovery, resolved targets are
  screened against destructive-verb patterns *before execution*; matches are
  blocked and routed to the operator. During replay, `riskClass: risky` steps
  require explicit approval.
- **Redaction at the sink**: registered secrets replaced before serialization;
  sensitive keys never persist values; artifact writes pass through the
  scrubber; login values template into `{{env.*}}` by construction.
- **Fixture isolation**: the simulator deep-clones its data per instance;
  scenarios cannot contaminate each other.

Limits: redaction is pattern-based; the console is localhost-only; discovery's
risk screen is a heuristic (a novel secret format typed into a non-obvious
field could reach the transcript — the artifact compiler is the second line).

## 7. Cuts

1. **Desktop driver** — the port and IR are shaped for it; no UIA implementation.
2. **Discovery-time risk classification depth** — the screen is verb-based; a
   production system would add form-action inspection and route classification.
3. **Cross-tenant drift telemetry** — variant overlays work; failure clustering
   across hundreds of tenants is designed (ledger) but not aggregated.
4. **Capability catalog API** — the schema is the tool contract; only the
   serving layer is missing.
5. **Operator console polish** — minimal lease-transfer surface by intent.
6. **Recovery rule breadth** — `when` supports `redirectedToGlob` and
   `errorClass` (the two conditions the engine evaluates); the schema
   intentionally omits conditions that would be declarative placeholders.
