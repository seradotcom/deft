/**
 * Replay engine — the production execution path. NO model in the loop.
 *
 * Per step: policy → wait → locate (verified targeting) → act → verify.
 * Failure contract:
 *   BUSINESS_OUTCOME  expected answers declared in the artifact
 *   recovered         bounded per-step recovery chains (session expiry…)
 *   FAILED            hard stop with debuggable detail + evidence refs
 * Degradation (coordinate fallback) is explicit in the result.
 */
import {
  type CapabilityArtifact,
  type ReplayResult,
  type Step,
} from '../core/artifact.js';
import type { Locator } from 'playwright';
import { interpolate, resolveDescriptor, idPatternMatches } from '../surface/targeting.js';
import { resolveFrameByPathStrict } from '../surface/targeting.js';
import { gridToPx } from '../surface/driver.js';

function resolveFrameByPathPublic(page: import('playwright').Page, path: string[]): import('playwright').Frame | null {
  return resolveFrameByPathStrict(page, path);
}
function gridToPxViewport(x999: number, y999: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1439, Math.round((x999 / 999) * 1439))),
    y: Math.max(0, Math.min(899, Math.round((y999 / 999) * 899))),
  };
}
import { openRunContext, runCheck, extractStepOutput, validateOutputs, artifactPreflight, templateCtx, globMatch, errorClassOf, classifyPhase, shortMsg, describeCheck, describeExtract, matchBusinessOutcome, type Ctx, type ReplayOptions } from './support.js';

function writeEvidence(ctx: Ctx, event: Record<string, unknown>): void {
  try {
    ctx.evidence.write(event);
  } catch (error) {
    throw Object.assign(new Error(`evidence write failed: ${error instanceof Error ? error.message : String(error)}`), {
      deftClass: 'EVIDENCE_WRITE_FAILED',
    });
  }
}

export async function replayCapability(
  artifactLike: unknown,
  opts: ReplayOptions & { allowRisky?: boolean }
): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const { artifact, env, artifactSha256: executedArtifactSha256, artifactDefinitionBytes } = artifactPreflight(artifactLike, opts);

  // Environment bindings resolve INSIDE the engine from the runtime env �
  // secrets are engine-scope values, never model context.
  opts.env = env;

  const ctx = await openRunContext(artifact, opts);
  const artifactDefinitionRef = 'artifact.executed.json';
  const fsSnapshot = await import('node:fs');
  const pathSnapshot = await import('node:path');
  fsSnapshot.writeFileSync(pathSnapshot.join(ctx.evidence.dir, artifactDefinitionRef), Buffer.from(artifactDefinitionBytes));
  ctx.evidence.write({ type: 'artifact_definition', artifactSha256: executedArtifactSha256, definitionRef: artifactDefinitionRef });
  let status: ReplayResult['status'] = 'SUCCESS';
  let businessOutcome: ReplayResult['businessOutcome'];
  let failure: ReplayResult['failure'];

  try {
    ctx.evidence.write({ type: 'replay_start', capability: artifact.metadata.id, version: artifact.metadata.version, tenant: opts.tenantId ?? 'base' });
    const entryUrl = interpolate(artifact.target.entryUrlTemplate, templateCtx(artifact, opts, ctx));
    if (!ctx.policy.isUrlAllowed(entryUrl)) {
      status = 'FAILED';
      failure = { stepId: 'entry', phase: 'act', errorClass: 'POLICY_BLOCKED', expected: entryUrl, observed: 'blocked by allowlist', evidenceRefs: [] };
    } else {
      await ctx.driver.act({ type: 'navigate', url: entryUrl });
      await shot(ctx, 'entry');
    }

    if (status === 'SUCCESS') {
      // Deterministic auth phase — engine-executed, policy-checked, evidence-
      // logged. Credential values resolve from env bindings INSIDE the engine;
      // the model never sees them (there is no model here at all).
      let authIndex = 0;
      for (const authStep of artifact.authPhase?.steps ?? []) {
        const outcome = await runStep(ctx, artifact, opts, authStep, authIndex, { disableRecovery: true });
        authIndex += 1;
        if (outcome.kind === 'failure') {
          status = 'FAILED';
          failure = { ...outcome.failure, errorClass: 'AUTH_FAILED' };
          break;
        }
      }
    }

    if (status === 'SUCCESS') {
      let stepIndex = 0;
      for (const step of artifact.steps) {
        const outcome = await runStep(ctx, artifact, opts, step, stepIndex);
        stepIndex += 1;
        if (outcome.kind === 'business') {
          status = 'BUSINESS_OUTCOME';
          businessOutcome = outcome.business;
          break;
        }
        if (outcome.kind === 'failure') {
          status = 'FAILED';
          failure = outcome.failure;
          break;
        }
      }
    }

    if (status === 'SUCCESS') {
      for (const chk of artifact.successCondition.allOf) {
        const ok = await runCheck(ctx, artifact, opts, chk);
        ctx.evidence.write({ type: 'final_check', assert: chk.assert, ok });
        if (!ok) {
          const ref = await shot(ctx, `fail-check-${chk.assert}`);
          status = 'FAILED';
          failure = {
            stepId: 'successCondition',
            phase: 'verify',
            errorClass: 'CHECKPOINT_FAILED',
            expected: describeCheck(chk),
            observed: 'failed',
            evidenceRefs: [ref],
          };
          break;
        }
      }
    }

  } finally {
    await ctx.driver.close().catch(() => undefined);
  }

  // Output contract: SUCCESS only if the extracted values satisfy the
  // artifact's declared output schema.
  if (status === 'SUCCESS') {
    try {
      validateOutputs(artifact, ctx.outputs);
    } catch (err) {
      status = 'FAILED';
      failure = {
        stepId: 'outputs',
        phase: 'verify',
        errorClass: 'OUTPUT_CONTRACT_VIOLATION',
        expected: 'outputs matching artifact.outputs schema',
        observed: (err as Error).message,
        evidenceRefs: [],
      };
    }
  }
  let ledgerAppended = false;
  try {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const storePath = opts.capabilitiesDir ?? 'capabilities';
    fsMod.mkdirSync(storePath, { recursive: true });
    const ledgerPath = pathMod.join(storePath, `${artifact.metadata.id}.validation.jsonl`);
    fsMod.appendFileSync(
      ledgerPath,
      JSON.stringify({
        at: new Date().toISOString(),
        runId: ctx.evidence.runId,
        tenant: opts.tenantId ?? 'base',
        status,
        degradedSteps: ctx.degradedSteps,
        escalated: ctx.escalation?.resumedByHuman ?? false,
        artifactSha256: executedArtifactSha256,
        artifactDefinitionRef,
      }) + '\n'
    );
    ledgerAppended = true;
  } catch (err) {
    status = 'FAILED';
    failure = {
      stepId: 'ledger',
      phase: 'verify',
      errorClass: 'LEDGER_WRITE_FAILED',
      expected: 'one validation ledger row',
      observed: err instanceof Error ? err.message : String(err),
      evidenceRefs: [],
    };
  }
  writeEvidence(ctx, ledgerAppended
    ? { type: 'ledger_appended', status, artifactSha256: executedArtifactSha256, degradedSteps: ctx.degradedSteps.length }
    : { type: 'ledger_append_failed', status: 'FAILED', errorClass: 'LEDGER_WRITE_FAILED' });

  const result: ReplayResult = {
    runId: ctx.evidence.runId,
    capabilityId: artifact.metadata.id,
    capabilityVersion: artifact.metadata.version,
    artifactSha256: executedArtifactSha256,
    artifactDefinitionRef,
    status,
    outputs: status === 'SUCCESS' ? ctx.outputs : undefined,
    businessOutcome: status === 'BUSINESS_OUTCOME' ? businessOutcome : undefined,
    failure,
    escalation: ctx.escalation
      ? { ...ctx.escalation, resumedByHuman: status !== 'FAILED' }
      : undefined,
    timeline: ctx.timeline,
    degradedSteps: [...new Set(ctx.degradedSteps)],
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  writeEvidence(ctx, { type: 'replay_result', ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

type StepOutcome =
  | { kind: 'ok' }
  | { kind: 'business'; business: NonNullable<ReplayResult['businessOutcome']> }
  | { kind: 'failure'; failure: NonNullable<ReplayResult['failure']> };

async function runStep(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions & { allowRisky?: boolean },
  step: Step,
  stepIndex = 0,
  internal: { disableRecovery?: boolean } = {}
): Promise<StepOutcome> {
  const t0 = Date.now();
  ctx.evidence.write({ type: 'step_start', stepId: step.id, intent: step.intent, action: step.action });

  if (
    step.riskClass === 'risky' &&
    !opts.allowRisky &&
    (artifact.riskPolicy?.onRiskyStep ?? 'require_approval') === 'require_approval'
  ) {
    // Human-in-the-loop approval: an operator may authorize the risky step
    // through the escalation channel instead of pre-approving the whole run.
    if (opts.onEscalation && !internal.disableRecovery && !ctx.recoveryAttempts.has(`risky:${step.id}`)) {
      ctx.recoveryAttempts.set(`risky:${step.id}`, 1);
      const reason = `risky step "${step.intent}" requires operator approval`;
      const approved = await escalateToHuman(ctx, opts, step, reason);
      if (approved) {
        ctx.evidence.write({ type: 'risky_approved_by_operator', stepId: step.id });
        // fall through: approval granted for this step
      } else {
        return fail(ctx, step, 'act', 'RISKY_STEP_BLOCKED', 'approved unattended execution', `risky step requires approval: ${step.intent}`, []);
      }
    } else {
      return fail(ctx, step, 'act', 'RISKY_STEP_BLOCKED', 'approved unattended execution', `risky step requires approval: ${step.intent}`, []);
    }
  }

  try {
    switch (step.action) {
      case 'navigate': {
        const url = interpolate(step.valueTemplate ?? '', templateCtx(artifact, opts, ctx));
        if (!ctx.policy.isUrlAllowed(url)) {
          return fail(ctx, step, 'act', 'POLICY_BLOCKED', url, 'outside allowlist', []);
        }
        await ctx.driver.act({ type: 'navigate', url });
        break;
      }
      case 'click':
      case 'fill':
      case 'select':
      case 'press': {
        if (step.expectsDialog) ctx.driver.acceptNextDialog();
        if (!step.target) {
          return fail(ctx, step, 'locate', 'ARTIFACT_INVALID', 'target descriptor', 'missing', []);
        }
        const located = await locate(ctx, artifact, opts, step);
        if ('outcome' in located) return located.outcome;

        if (located.mode === 'done') break; // coordinate click already executed

        const loc = located.locator!;
        const c = templateCtx(artifact, opts, ctx);
        if (step.action === 'click') {
          await loc.click({ timeout: 12000 });
        } else if (step.action === 'fill') {
          await loc.fill(interpolate(step.valueTemplate ?? '', c), { timeout: 10000 });
        } else if (step.action === 'select') {
          const label = interpolate(step.selectOptionText ?? '', c);
          await loc.selectOption({ label }).catch(() => loc.selectOption(label));
        } else {
          await loc.press(step.keyCombo ?? 'Enter');
        }
        // Direct locator calls bypass driver.act(); settle explicitly so
        // follow-up steps never race an in-flight frameset navigation.
        if (step.action !== 'fill' && step.action !== 'select') {
          await ctx.driver.waitForLoadStateSettle();
        }
        // A click that "worked" may still have landed on a session-expiry
        // redirect inside a frame — surface it so recovery can fire.
        if ((step.recoverableErrors ?? []).length > 0) {
          const loginHit = ctx.driver
            .page.frames()
            .some((f) => globMatch('**/login.aspx*', f.url()));
          if (loginHit) {
            throw Object.assign(new Error('session redirect after action'), {
              deftClass: 'SESSION_REDIRECT',
            });
          }
        }
        break;
      }
      case 'scroll':
        await ctx.driver.act({ type: 'scroll', direction: step.scrollDirection ?? 'down', magnitude: 400 });
        break;
      case 'wait':
        await ctx.driver.act({ type: 'wait', ms: 800 });
        break;
      case 'extract': {
        const value = await extractStepOutput(ctx, artifact, opts, step);
        ctx.evidence.write({ type: 'extract', stepId: step.id, found: value != null });
        if (value == null) {
          const probe = await pageProbe(ctx);
          const biz = matchBusinessOutcome(artifact, step.id, probe);
          if (biz) return { kind: 'business', business: biz };
          const ref = await shot(ctx, `fail-extract-${step.id}`);
          return fail(ctx, step, 'verify', 'EXTRACT_FAILED', describeExtract(step), 'not found', [ref]);
        }
        if (step.outputKey) ctx.outputs[step.outputKey] = value;
        break;
      }
      case 'check': {
        const ok = await runCheck(ctx, artifact, opts, step.postCheck);
        if (!ok) {
          const ref = await shot(ctx, `fail-check-${step.id}`);
          return fail(ctx, step, 'verify', 'CHECK_FAILED', describeCheck(step.postCheck), 'failed', [ref]);
        }
        break;
      }
    }

    // Surface events (native dialogs, crashes) are first-class evidence.
    const surfEvents = ctx.driver.drainEvents();
    if (surfEvents.length > 0) {
      ctx.evidence.write({ type: 'surface_events', stepId: step.id, events: surfEvents });
    }

    if (step.postCheck && step.action !== 'check') {
      const ok = await runCheck(ctx, artifact, opts, step.postCheck);
      if (!ok) {
        const probe = await pageProbe(ctx);
        const biz = matchBusinessOutcome(artifact, step.id, probe);
        if (biz) return { kind: 'business', business: biz };
        const ref = await shot(ctx, `fail-post-${step.id}`);
        return fail(ctx, step, 'verify', 'POST_CHECK_FAILED', describeCheck(step.postCheck), summarize(probe), [ref]);
      }
    }

    ctx.timeline.push({
      stepId: step.id,
      intent: step.intent,
      phase: 'act',
      ok: true,
      ms: Date.now() - t0,
      degraded: ctx.degradedSteps.includes(step.id) || undefined,
    });
    const postShot = await shot(ctx, `ok-${step.id}`);
    ctx.evidence.write({
      type: 'after_step',
      stepId: step.id,
      topUrl: ctx.driver.page.url(),
      frameUrls: ctx.driver.page.frames().map((f) => `${f.name()}=${f.url()}`),
      shot: postShot,
    });
    ctx.evidence.write({ type: 'step_ok', stepId: step.id, ms: Date.now() - t0 });
    return { kind: 'ok' };
  } catch (err) {
    // 1) bounded recovery chain (e.g. session expiry re-login)
    const recovered = internal.disableRecovery ? null : await attemptRecovery(ctx, artifact, opts, step, err);
    if (recovered) {
      ctx.timeline.push({
        stepId: step.id,
        intent: step.intent,
        phase: 'recover',
        ok: true,
        ms: Date.now() - t0,
        recovered: true,
        detail: recovered,
      });
      // Retry the step once after recovery by tail-recursing through loop guard.
      const retry = await runStepRetry(ctx, artifact, opts, step, stepIndex, t0);
      return retry;
    }
    // 2) business outcome detection — an "expected failure" is an answer
    const probe = await pageProbe(ctx);
    const biz = matchBusinessOutcome(artifact, step.id, probe);
    if (biz) {
      ctx.evidence.write({ type: 'business_outcome', stepId: step.id, code: biz.code });
      return { kind: 'business', business: biz };
    }
    // 3) human-in-the-loop escalation (once per step)
    if (opts.onEscalation && !internal.disableRecovery && !ctx.recoveryAttempts.has(`esc:${step.id}`)) {
      ctx.recoveryAttempts.set(`esc:${step.id}`, 1);
      const reason = `replay stuck at step ${step.id} ("${step.intent}"): ${shortMsg(err)}`;
      const resumed = await escalateToHuman(ctx, opts, step, reason);
      if (resumed) {
        return runStepRetry(ctx, artifact, opts, step, stepIndex, t0);
      }
    }
    // 4) hard failure
    const ref = await shot(ctx, `fail-${step.id}`);
    return fail(ctx, step, classifyPhase(err), errorClassOf(err), step.intent, shortMsg(err), [ref]);
  }
}

/**
 * Post-recovery retry: re-executes the deterministic flow from the first
 * non-login step up to the failed one (fast-forward), so POST-arrival pages
 * are re-reached by re-running the flow instead of blind GET navigation
 * ("Cannot GET /results.aspx" taught us this). Then retries the failed step
 * through the SAME guarded executor.
 */
async function runStepRetry(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions & { allowRisky?: boolean },
  step: Step,
  stepIndex: number,
  t0: number
): Promise<StepOutcome> {
  try {
    // Fast-forward: rebuild deterministic state by RE-RUNNING the verified
    // steps through the SAME guarded pipeline (policy, fail-closed frames,
    // evidence). Non-idempotent steps are NEVER re-executed — a submit that
    // already happened must not happen twice; crossing one means escalate.
    for (let j = 0; j < stepIndex; j++) {
      const prev = artifact.steps[j]!;
      if (prev.pageUrl && /login\.aspx/i.test(prev.pageUrl)) continue; // chain re-authenticated
      if (['extract', 'check', 'wait', 'scroll'].includes(prev.action)) continue;
      if (prev.idempotent === false) {
        ctx.evidence.write({ type: 'fast_forward_blocked_non_idempotent', stepId: prev.id });
        const ref = await shot(ctx, `fail-ff-${step.id}`);
        return fail(ctx, step, 'act', 'FAST_FORWARD_BLOCKED', 'idempotent state reconstruction', `non-idempotent step ${prev.id} lies between recovery and the failed step — refusing to duplicate a side effect`, [ref]);
      }
      const ff = await runStep(ctx, artifact, { ...opts, onEscalation: undefined }, prev, j, { disableRecovery: true });
      if (ff.kind === 'failure') {
        // Benign: the flow already moved past this step (its control is gone
        // because we're on a later page) → skip. Anything else (policy,
        // ambiguous target, session dead…) is NOT benign → fail honestly
        // instead of "hoping the next step works".
        const benign = ff.failure?.errorClass === 'ELEMENT_NOT_FOUND' || ff.failure?.errorClass === 'TIMEOUT';
        ctx.evidence.write({ type: 'fast_forward_skip', stepId: prev.id, reason: ff.failure?.errorClass, benign });
        if (!benign) {
          const ref = await shot(ctx, `fail-ff-${step.id}`);
          return fail(ctx, step, 'act', 'FAST_FORWARD_FAILED', `reconstruction via ${prev.id}`, ff.failure?.observed ?? 'fast-forward step failed', [ref]);
        }
      }
    }
    const outcome = await executeStepBody(ctx, artifact, opts, step);
    if (outcome !== null) return outcome;
    ctx.timeline.push({
      stepId: step.id,
      intent: step.intent,
      phase: 'act',
      ok: true,
      ms: Date.now() - t0,
      recovered: true,
      degraded: ctx.degradedSteps.includes(step.id) || undefined,
    });
    ctx.evidence.write({ type: 'step_ok_after_recovery', stepId: step.id });
    return { kind: 'ok' };
  } catch (err) {
    const probe = await pageProbe(ctx);
    const biz = matchBusinessOutcome(artifact, step.id, probe);
    if (biz) return { kind: 'business', business: biz };
    const ref = await shot(ctx, `fail-retry-${step.id}`);
    return fail(ctx, step, classifyPhase(err), errorClassOf(err), step.intent, shortMsg(err), [ref]);
  }
}

/** Executes only the action part of a step; returns null when nothing failed. */
async function executeStepBody(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions & { allowRisky?: boolean },
  step: Step
): Promise<StepOutcome | null> {
  switch (step.action) {
    case 'navigate': {
      const url = interpolate(step.valueTemplate ?? '', templateCtx(artifact, opts, ctx));
      await ctx.driver.act({ type: 'navigate', url });
      return null;
    }
    case 'click':
    case 'fill':
    case 'select':
    case 'press': {
      if (!step.target) throw new Error('missing target');
      const located = await locate(ctx, artifact, opts, step);
      if ('outcome' in located) return located.outcome;
      if (located.mode === 'done') return null;
      const loc = located.locator!;
      const c = templateCtx(artifact, opts, ctx);
      if (step.action === 'click') await loc.click({ timeout: 12000 });
      else if (step.action === 'fill') await loc.fill(interpolate(step.valueTemplate ?? '', c), { timeout: 10000 });
      else if (step.action === 'select') {
        const label = interpolate(step.selectOptionText ?? '', c);
        await loc.selectOption({ label }).catch(() => loc.selectOption(label));
      } else await loc.press(step.keyCombo ?? 'Enter');
      // Same settle discipline as the main path — post-recovery retries race
      // frame navigations exactly like first attempts do.
      if (step.action !== 'fill' && step.action !== 'select') {
        await ctx.driver.waitForLoadStateSettle();
      }
      return null;
    }
    case 'extract': {
      const value = await extractStepOutput(ctx, artifact, opts, step);
      if (value == null) throw new Error(`extract failed: ${describeExtract(step)}`);
      if (step.outputKey) ctx.outputs[step.outputKey] = value;
      return null;
    }
    default:
      return null; // scroll/wait/check need no retry semantics here
  }
}

type LocateOutcome =
  | { mode: 'locator'; locator: Locator }
  | { mode: 'done' } // coordinate fallback already clicked
  | { outcome: StepOutcome };

async function locate(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  step: Step
): Promise<LocateOutcome> {
  // Fail-closed frame resolution + policy check on the TARGET surface.
  // Frameset reality: the top URL can stay on an allowed page while a frame
  // redirects somewhere else — the frame's own URL is what must be policed.
  const fp = step.target!.scope.framePath ?? [];
  if (fp.length > 0) {
    const frame = resolveFrameByPathStrict(ctx.driver.page, fp);
    if (!frame) {
      const ref = await shot(ctx, `fail-frame-${step.id}`);
      return {
        outcome: fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', `frame path [${fp.join('>')}]`, 'frame missing (redirect/navigation changed the shell)', [ref]),
      };
    }
    if (!ctx.policy.isUrlAllowed(frame.url())) {
      const ref = await shot(ctx, `fail-policy-${step.id}`);
      ctx.evidence.write({ type: 'policy_blocked_frame', stepId: step.id, frameUrl: frame.url() });
      return {
        outcome: fail(ctx, step, 'locate', 'POLICY_BLOCKED', `frame url within ${fp.join('>')}`, `disallowed frame url: ${frame.url()}`, [ref]),
      };
    }
  }

  const res = await resolveDescriptor(ctx.driver.page, step.target!, { timeoutMs: 9000 });
  if (res.status === 'resolved' && res.locator) {
    ctx.evidence.write({
      type: 'located',
      stepId: step.id,
      viaFallback: res.usedFallbackIndex ?? false,
      fingerprintScore: res.fingerprintScore != null ? Number(res.fingerprintScore.toFixed(2)) : undefined,
    });
    return { mode: 'locator', locator: res.locator };
  }
  if (res.status === 'coordinate-fallback') {
    // A recorded coordinate is a POINT, not a control. Clicking through it is
    // an honest degraded mode; fill/select/press need the actual element —
    // pretending otherwise produced silent no-ops.
    if (step.action !== 'click') {
      const ref = await shot(ctx, `fail-coord-${step.id}`);
      return {
        outcome: fail(
          ctx,
          step,
          'locate',
          'COORDINATE_FALLBACK_UNSUPPORTED',
          `semantic target for ${step.action}`,
          'only the coordinate fallback resolved; coordinate targeting cannot safely perform a data action',
          [ref]
        ),
      };
    }
    // Before blind-clicking, check whether the page is already telling us a
    // declared business outcome ("no such member" needs no click).
    const probeBiz = await pageProbe(ctx);
    const bizEarly = matchBusinessOutcome(artifact, step.id, probeBiz);
    if (bizEarly) {
      ctx.evidence.write({ type: 'business_outcome', stepId: step.id, code: bizEarly.code, via: 'pre-coordinate-check' });
      return { outcome: { kind: 'business', business: bizEarly } };
    }
    const spec =
      step.target!.fallbacks.find((f) => f.kind === 'coordinate') ??
      (step.target!.primary.kind === 'coordinate' ? step.target!.primary : undefined);
    ctx.evidence.write({
      type: 'coordinate_fallback',
      stepId: step.id,
      xy: spec ? [spec.x, spec.y] : null,
      attempts: res.attempts.map((a) => `${a.spec.kind}:${a.why}`),
    });
    if (spec && spec.kind === 'coordinate') {
      ctx.degradedSteps.push(step.id);
      // Coordinates are FRAME-LOCAL PIXELS (record-time center); translate
      // through the frame's viewport origin.
      let px: { x: number; y: number } | null = null;
      try {
        const frame = resolveFrameByPathPublic(ctx.driver.page, step.target!.scope.framePath ?? []);
        if (!frame) throw new Error('frame gone');
        const fe = await frame.frameElement();
        const box = await fe.asElement()?.boundingBox();
        if (box) {
          px = { x: Math.round(box.x + spec.x), y: Math.round(box.y + spec.y) };
        }
      } catch {
        /* fall through to viewport guess */
      }
      if (!px) px = gridToPxViewport(spec.x, spec.y);
      ctx.evidence.write({ type: 'coordinate_click_viewport', stepId: step.id, px });
      await ctx.driver.act({ type: 'click', hint: { px } });
      return { mode: 'done' };
    }
  }
  const ref = await shot(ctx, `fail-locate-${step.id}`);
  const probe = await pageProbe(ctx);
  const biz = matchBusinessOutcome(artifact, step.id, probe);
  if (biz) {
    return { outcome: { kind: 'business', business: biz } };
  }
  return {
    outcome: fail(
      ctx,
      step,
      'locate',
      'ELEMENT_NOT_FOUND',
      JSON.stringify(step.target!.primary),
      res.attempts.map((a) => `${a.spec.kind}:${a.why}`).join(' | ').slice(0, 240),
      [ref]
    ),
  };
}

// ---------------------------------------------------------------------------
// Recovery chains
// ---------------------------------------------------------------------------

async function attemptRecovery(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  step: Step,
  err: unknown
): Promise<string | null> {
  for (const spec of step.recoverableErrors ?? []) {
    // Expand shared-chain references into a concrete rule.
    const rule =
      'chainRef' in spec
        ? {
            description: spec.description ?? `shared chain "${spec.chainRef}"`,
            when: { redirectedToGlob: '**/login.aspx*' } as {
              redirectedToGlob?: string;
              dialogTextContains?: string;
              pageTextContains?: string;
              errorClass?: string;
            },
            do: artifact.recoveryChains?.[spec.chainRef] ?? [],
            maxAttempts: 1 as const,
          }
        : spec;

    if (rule.do.length === 0) continue;
    const key = `${step.id}::${rule.description}`;
    const used = ctx.recoveryAttempts.get(key) ?? 0;
    if (used >= rule.maxAttempts) continue;
    // Frameset reality: the login redirect happens INSIDE a frame while the
    // top URL stays stable — match the glob against every frame URL. An EMPTY
    // frame list means the page died mid-redirect; the chain's navigate
    // revives it, so recovery still proceeds.
    const allUrls = ctx.driver.page.frames().map((f) => f.url());
    const urlHit = rule.when.redirectedToGlob
      ? allUrls.some((u) => globMatch(rule.when.redirectedToGlob!, u)) || allUrls.length === 0
      : false;
    const errHit = rule.when.errorClass ? rule.when.errorClass === errorClassOf(err) : false;
    if (!urlHit && !errHit) continue;

    ctx.recoveryAttempts.set(key, used + 1);
    ctx.evidence.write({
      type: 'recovering',
      stepId: step.id,
      via: rule.description,
      frameUrlsBefore: ctx.driver.page.frames().map((f) => `${f.name()}=${f.url()}`),
    });
    await runRecoveryActions(ctx, artifact, opts, step, rule.do);
    ctx.evidence.write({
      type: 'recovery_done',
      stepId: step.id,
      frameUrlsAfter: ctx.driver.page.frames().map((f) => `${f.name()}=${f.url()}`),
    });
    await shot(ctx, `recovered-${step.id}`);
    return rule.description;
  }
  return null;
}

/** Executes a recovery action chain. Fill/click/select actions run as
 *  pseudo-steps through the SAME guarded runStep pipeline (policy on the
 *  target frame, fail-closed resolution, evidence) — recovery does not get a
 *  lawless fast path. */
async function runRecoveryActions(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  step: Step,
  actions: Array<import('../core/artifact.js').RecoverAction>
): Promise<void> {
  const c = templateCtx(artifact, opts, ctx);
  let n = 0;
  for (const act of actions) {
    n += 1;
    const pseudoId = `${step.id}-rec${n}`;
    if (act.action === 'navigate') {
      const url = interpolate(act.urlTemplate, c);
      if (!ctx.policy.isUrlAllowed(url)) {
        throw new Error(`POLICY_BLOCKED: recovery navigate outside allowlist: ${url}`);
      }
      await ctx.driver.act({ type: 'navigate', url });
      await ctx.driver.waitForLoadStateSettle();
    } else if (act.action === 'wait') {
      await ctx.driver.act({ type: 'wait', ms: Math.min(act.durationMs, 5000) });
    } else if (act.action === 'gotoStepPage') {
      const url = interpolate(step.pageUrl ?? '', c);
      ctx.evidence.write({ type: 'goto_step_page', stepId: step.id, url, framePath: step.target?.scope.framePath ?? [] });
      if (!url) continue;
      const fp = step.target?.scope.framePath ?? [];
      if (fp.length > 0) {
        // Return the FRAME to the step's page (frameset apps keep the shell).
        // The frameset children attach ASYNC after the relogin POST — poll.
        let target: import('playwright').Frame | undefined;
        for (let i = 0; i < 40 && !target; i++) {
          const parent = resolveFrameByPathPublic(ctx.driver.page, fp.slice(0, -1));
          const leaf = fp[fp.length - 1]!;
          target = parent?.childFrames().find((f) => f.name() === leaf || f.url() === leaf);
          if (!target) await new Promise((r) => setTimeout(r, 150));
        }
        if (target) {
          await target.evaluate(`window.location.href = ${JSON.stringify(url)}`).catch((e) => {
            ctx.evidence.write({ type: 'goto_step_page_error', stepId: step.id, message: (e as Error).message?.slice(0, 150) });
          });
          await ctx.driver.waitForLoadStateSettle();
          ctx.evidence.write({
            type: 'goto_step_page_done',
            stepId: step.id,
            frameUrl: target.url(),
          });
          continue;
        }
        ctx.evidence.write({ type: 'goto_step_page_error', stepId: step.id, message: 'target frame not found after poll' });
      }
      await ctx.driver.act({ type: 'navigate', url });
    } else {
      // fill / click / select — guarded pseudo-step through runStep.
      const pseudoStep: Step = {
        id: pseudoId,
        intent: `recovery ${act.action} for ${step.id}`,
        action: act.action === 'fill' ? 'fill' : act.action === 'click' ? 'click' : 'select',
        target: act.target,
        valueTemplate: act.action === 'fill' ? act.valueTemplate : undefined,
        selectOptionText: act.action === 'select' ? act.optionTextTemplate : undefined,
        pageUrl: step.pageUrl,
        recoverableErrors: [],
        riskClass: 'safe',
        idempotent: true,
        expectsDialog: false,
      };
      const outcome = await runStep(ctx, artifact, { ...opts, onEscalation: undefined }, pseudoStep, 0, {
        disableRecovery: true,
      });
      if (outcome.kind === 'failure') {
        throw new Error(`recovery ${act.action} failed: ${outcome.failure.errorClass}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Human-in-the-loop escalation (real observation + live-session audit sampler)
// ---------------------------------------------------------------------------

/**
 * Hands the live session to a human: captures the REAL current observation,
 * then samples the session (screenshot + a11y outline) while the operator has
 * control — the sample diff IS the audit record of what the human did.
 * Returns true when the operator resumed (approval or fix applied).
 */
async function escalateToHuman(
  ctx: Ctx,
  opts: ReplayOptions,
  step: Step,
  reason: string
): Promise<boolean> {
  if (!opts.onEscalation) return false;
  const observation = await ctx.driver.observe();
  ctx.evidence.write({ type: 'escalation_request', stepId: step.id, reason, urlAtPause: observation.url });

  const samples: string[] = [];
  const hashes: string[] = [];
  let stateChanges = 0;
  let sampling = true;
  const sampler = (async () => {
    let n = 0;
    let lastHash = '';
    while (sampling) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!sampling) break;
      n += 1;
      try {
        const shot = await ctx.driver.screenshot();
        const ref = await ctx.evidence.saveShot(shot.base64, `human-${String(n).padStart(2, '0')}`);
        // Frameset reality: aggregate EVERY frame's text — the top-level body
        // of a frameset page is empty, which once produced all-zero hashes.
        let hay = '';
        for (const f of ctx.driver.page.frames()) {
          const t = await f.locator('body').innerText({ timeout: 800 }).catch(() => '');
          if (t) hay += t + '\n';
        }
        const h = hashOf(hay);
        const changed = lastHash !== '' && h !== lastHash;
        if (changed) stateChanges += 1;
        lastHash = h;
        samples.push(ref);
        hashes.push(h);
        ctx.evidence.write({
          type: 'human_sample',
          stepId: step.id,
          n,
          shot: ref,
          textHash: h,
          changed,
          url: ctx.driver.page.url(),
        });
      } catch {
        /* page mid-navigation — next sample */
      }
    }
  })();

  let approved = false;
  try {
    approved = await opts.onEscalation({ reason, observation });
  } finally {
    sampling = false;
    await sampler;
  }

  ctx.escalation = ctx.escalation ?? {
    interventionId: `esc-${step.id}`,
    reason,
    resumedByHuman: approved,
    humanSamplesCaptured: samples.length,
    humanStateChanges: stateChanges,
  };
  ctx.evidence.write({
    type: 'escalation_resolved',
    stepId: step.id,
    approved,
    humanSamples: samples.length,
    humanStateChanges: stateChanges,
    samples,
  });
  return approved;
}

function hashOf(s: string): string {
  // Cheap stability signal for the audit diff (not cryptographic).
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(
  ctx: Ctx,
  step: Step,
  phase: NonNullable<ReplayResult['failure']>['phase'],
  errorClass: string,
  expected: string,
  observed: string,
  extraRefs: string[]
): { kind: 'failure'; failure: NonNullable<ReplayResult['failure']> } {
  ctx.evidence.write({ type: 'step_failed', stepId: step.id, errorClass, expected, observed, evidenceRefs: extraRefs });
  return {
    kind: 'failure',
    failure: {
      stepId: step.id,
      phase,
      errorClass,
      expected,
      observed,
      evidenceRefs: [...extraRefs, ctx.evidence.logRef],
    },
  };
}

async function pageProbe(ctx: Ctx): Promise<{ pageText?: string; dialogText?: string; url?: string }> {
  try {
    // Frameset reality: the top document's body is EMPTY — text lives in
    // frames. Aggregate every frame's visible text for pattern checks.
    const parts: string[] = [];
    for (const f of ctx.driver.page.frames()) {
      const t = await f.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      if (t) parts.push(t);
    }
    const body = parts.join('\n');
    const dialogs = ctx.driver.drainEvents().filter((e) => e.kind === 'dialog');
    return {
      pageText: body.slice(0, 4000),
      dialogText: dialogs.map((d) => d.detail).join('; ') || undefined,
      url: ctx.driver.page.url(),
    };
  } catch {
    return { url: ctx.driver.page.url() };
  }
}

function summarize(probe: { pageText?: string }): string {
  return (probe.pageText ?? '').replace(/\s+/g, ' ').slice(0, 160);
}

export async function shot(ctx: Ctx, tag: string): Promise<string> {
  const s = await ctx.driver.screenshot();
  const rel = await ctx.evidence.saveShot(s.base64, tag);
  ctx.lastShots.push(rel);
  return rel;
}
















