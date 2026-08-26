# DEFT — **D**eterministic **E**xecution **F**rom **T**ranscripts

**The model discovers. The capability replays.**

DEFT is a computer-use automation system built for the reality of credit-union
back offices: legacy web apps with no API, no test IDs, and no clean DOM — where
the only way in is to drive the UI the way a human operator would.

1. **Discover** — an LLM completes a goal on the live surface (observe → decide
   → act). Every target it touches is *verified at record time* against the real
   element, not guessed.
2. **Compile** — the successful run becomes a typed, versioned, reviewable
   **capability artifact**: steps with semantic targeting chains, typed inputs,
   relational output extraction, declared business outcomes, bounded recovery.
3. **Replay** — the artifact executes deterministically with **no model in the
   loop**, returning typed outputs and a three-way result contract
   (success / business outcome / failure) with full evidence.
4. **Escalate** — approval authorizes one risky automated action; manual
   takeover separately transfers the same live browser session and resumes
   only after an observable human state change.

```
goal ──▶ LLM discovery (once) ──▶ capability artifact ──▶ deterministic replay (always)
                                        │
                                        └──▶ human escalation when stuck or risky
```

---

## Quick start

Requirements: **Node ≥ 20**, npm. A Gemini API key is needed **only for
discovery** — replays and all tests run fully offline.

```bash
git clone https://github.com/seradotcom/deft.git && cd deft
npm ci
npx playwright install chromium
cp .env.example .env        # add your GEMINI_API_KEY
npm run build
```

Terminal 1 — the legacy bank simulator (two tenants of the same vendor product):

```bash
npm run target:start        # http://localhost:7788/acme/login.aspx  ·  /nw/login.aspx
```

Terminal 2 — discover a capability with a real LLM run:

```bash
node dist/cli/index.js discover \
  --tenant acme \
  --goal "Look up member M10041 in member search and read the balance of their Savings account." \
  --capability-id legacybank.lookup-member-balance \
  --name "Look up member and read savings balance" \
  --description "Signs into LegacyBank core, searches a member by ID, opens their record, and reads the Savings account balance from the accounts table." \
  --input memberId=M10041 \
  --outcome "MEMBER_NOT_FOUND=pageTextContains:'No matching member records were found'"
```

Then replay it — deterministically, no model, no API key:

```bash
node dist/cli/index.js replay legacybank.lookup-member-balance --input memberId=M10041
# → { "status": "SUCCESS", "outputs": { "savingsBalance": "$2,450.75" } }

# Expected business result (not an error):
node dist/cli/index.js replay legacybank.lookup-member-balance --input memberId=M99999
# → { "status": "BUSINESS_OUTCOME", "businessOutcome": { "code": "MEMBER_NOT_FOUND" } }

# Same capability, second tenant of the same vendor product (variant overlay):
node dist/cli/index.js replay legacybank.lookup-member-balance --tenant nw --input memberId=M10041
```

### Risky approval and manual takeover

`legacybank.open-sub-account` is operator-authored and opens a
financial product — an irreversible action behind a native `window.confirm`:

```bash
# Automation refuses to cross the line unattended:
node dist/cli/index.js replay legacybank.open-sub-account \
  --input memberId=M10041 --input "nickname=Vacation fund" --input deposit=100
# → FAILED / RISKY_STEP_BLOCKED at the confirm step

# With an operator in the loop, approve the single risky automated submit.
# Approval does not enter HUMAN_CONTROL or satisfy manual takeover.
node dist/cli/index.js replay legacybank.open-sub-account \
  --input memberId=M10041 --input "nickname=Vacation fund" --input deposit=100 \
  --escalate --headed
# operator console: http://localhost:7790
```

When replay is stuck, the same console creates a `manual_takeover`
intervention. Its valid path is `PENDING -> HUMAN_CONTROL -> RESUMED`; resume
requires the same session and a real semantic before/after change. Abort is
terminal.

The stored executable artifacts are release `2.0.0`. Any executable-definition
change requires a new semantic version; replay identity is SHA-256 over the
exact artifact bytes supplied to the engine.

### Verify the evidence package

```bash
npm run verify:submission
```

### Tests (offline)

```bash
npm test
```

> Note: the demo commands call the CLI directly (`node dist/cli/index.js`).
> Going through `npm run` also works, but npm can swallow `--input`-style
> flags on some versions — the direct invocation is unambiguous.

---

## What's in the box

```
src/
  core/        artifact schema (zod → types → JSON contract), action IR, config
  surface/     SurfaceDriver port + Playwright impl, record-time verified targeting
  agent/       discovery loop, LLM planner, transcript → capability compiler
  replay/      deterministic executor, error taxonomy, recovery chains
  safety/      allowlist policy engine, redaction at the sink
  hitl/        operator console: lease-based control transfer + audit
  llm/         Gemini client (function calling, thought signatures, 429 backoff)
  evidence/    structured JSONL logs + screenshot store per run
  targets/     LegacyBank: hostile two-tenant legacy simulator with fault injection
capabilities/  stored capability artifacts (the deliverable data)
evidence/      curated bundles + manifest: discovery, replays, outcomes, HITL
scripts/       verify-submission: automated integrity check of the package
```

Design decisions, trade-offs and cuts: **[REPORT.md](REPORT.md)**.
Curated run bundles: **[evidence/](evidence/README.md)**.
