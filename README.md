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
4. **Escalate** — when automation can't safely continue, a human takes control
   of the *same live session* through an operator console, approves or fixes,
   and hands control back — with everything audited.

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
npm install
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
npm run agent:discover -- \
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
npm run replay -- legacybank.lookup-member-balance --input memberId=M10041
# → { "status": "SUCCESS", "outputs": { "savingsBalance": "$2,450.75" } }

# Expected business result (not an error):
npm run replay -- legacybank.lookup-member-balance --input memberId=M99999
# → { "status": "BUSINESS_OUTCOME", "businessOutcome": { "code": "MEMBER_NOT_FOUND" } }

# Same capability, second tenant of the same vendor product (variant overlay):
npm run replay -- legacybank.lookup-member-balance --tenant nw --input memberId=M10041
```

### The full story: risky steps and human approval

`legacybank.open-sub-account` (operator-authored, see `/evidence`) opens a
financial product — an irreversible action behind a native `window.confirm`:

```bash
# Automation refuses to cross the line unattended:
npm run replay -- legacybank.open-sub-account --input memberId=M10041 \
  --input "nickname=Vacation fund" --input deposit=100
# → FAILED / RISKY_STEP_BLOCKED at the confirm step

# With an operator in the loop: the console raises an intervention with the
# REAL live observation; the browser is headed — take control of the actual
# window, approve, resume → the run completes with a human-action audit.
npm run replay -- legacybank.open-sub-account --input memberId=M10041 \
  --input "nickname=Vacation fund" --input deposit=100 --escalate --headed
# operator console: http://localhost:7790
```

### Verify the evidence package

```bash
npm run verify:submission
# ✓ provenance chains · artifact sha256 per run · terminal statuses
# ✓ referenced screenshots exist · no duplicated runs · no secrets
```

### Tests (offline)

```bash
npm test
```

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
