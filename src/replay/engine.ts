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
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type ReplayResult,
  type Step,
} from '../core/artifact.js';
import type { Locator } from 'playwright';
import { interpolate, resolveDescriptor, idPatternMatches } from '../surface/targeting.js';
import { resolveFrameByPath } from '../surface/targeting.js';
import { gridToPx } from '../surface/driver.js';

function resolveFrameByPathPublic(page: import('playwright').Page, path: string[]): import('playwright').Frame {
  return resolveFrameByPath(page, path);
}
function gridToPxViewport(x999: number, y999: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1439, Math.round((x999 / 999) * 1439))),
    y: Math.max(0, Math.min(899, Math.round((y999 / 999) * 899))),
  };
}
import { openRunContext, runCheck, extractStepOutput, applyVariant, validateInputs, templateCtx, globMatch, errorClassOf, classifyPhase, shortMsg, describeCheck, describeExtract, matchBusinessOutcome, type Ctx, type ReplayOptions } from './support.js';

export async function replayCapability(
  artifactLike: unknown,
  opts: ReplayOptions & { allowRisky?: boolean }
): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const parsed = CapabilityArtifactSchema.safeParse(artifactLike);
  if (!parsed.success) {
    throw new Error(`invalid capability artifact: ${parsed.error.message.slice(0, 300)}`);
  }
  const artifact = applyVariant(parsed.data, opts.tenantId);
  validateInputs(artifact, opts.inputs);

  const ctx = await openRunContext(artifact, opts);
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
      for (const step of artifact.steps) {
        const outcome = await runStep(ctx, artifact, opts, step);
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

    // Provenance feedback: artifacts learn from their replays.
    try {
      const fsMod = await import('node:fs');
      const storePath = process.env.DEFT_CAPABILITIES_DIR ?? 'capabilities';
      const file = `${storePath}/${artifact.metadata.id}.json`;
      if (fsMod.existsSync(file)) {
        const onDisk = JSON.parse(fsMod.readFileSync(file, 'utf8')) as CapabilityArtifact;
        onDisk.provenance.validation.lastReplayAt = new Date().toISOString();
        onDisk.provenance.validation.lastReplayStatus = status;
        if (status === 'SUCCESS' || status === 'BUSINESS_OUTCOME') {
          onDisk.provenance.validation.replaySuccessCount += 1;
          if (onDisk.metadata.status === 'draft' && onDisk.provenance.validation.replaySuccessCount >= 2) {
            onDisk.metadata.status = 'approved';
          }
        } else {
          onDisk.provenance.validation.replayFailureCount += 1;
          if (ctx.degradedSteps.length > 0 || onDisk.provenance.validation.replayFailureCount >= 3) {
            onDisk.metadata.status = 'needs-review';
          }
        }
        fsMod.writeFileSync(file, JSON.stringify(onDisk, null, 2));
        ctx.evidence.write({ type: 'provenance_updated', status, degradedSteps: ctx.degradedSteps.length });
      }
    } catch {
      /* provenance update is best-effort */
    }
  } finally {
    await ctx.driver.close().catch(() => undefined);
  }

  const result: ReplayResult = {
    runId: ctx.evidence.runId,
    capabilityId: artifact.metadata.id,
    capabilityVersion: artifact.metadata.version,
    status,
    outputs: status === 'SUCCESS' ? ctx.outputs : undefined,
    businessOutcome,
    failure,
    escalation: ctx.escalation
      ? { ...ctx.escalation, resumedByHuman: status !== 'FAILED' }
      : undefined,
    timeline: ctx.timeline,
    degradedSteps: [...new Set(ctx.degradedSteps)],
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  ctx.evidence.write({ type: 'replay_result', ...result });
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
  step: Step
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
    if (opts.onEscalation && !ctx.recoveryAttempts.has(`risky:${step.id}`)) {
      ctx.recoveryAttempts.set(`risky:${step.id}`, 1);
      const reason = `risky step "${step.intent}" requires operator approval`;
      ctx.evidence.write({ type: 'escalation_request', stepId: step.id, reason });
      const approved = await opts.onEscalation({ reason });
      if (approved) {
        ctx.escalation = ctx.escalation ?? {
          interventionId: `risky-${step.id}`,
          reason,
          resumedByHuman: true,
          humanActionsObserved: 0,
        };
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
    const recovered = await attemptRecovery(ctx, artifact, opts, step);
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
      const retry = await runStepRetry(ctx, artifact, opts, step, t0);
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
    if (opts.onEscalation && !ctx.recoveryAttempts.has(`esc:${step.id}`)) {
      ctx.recoveryAttempts.set(`esc:${step.id}`, 1);
      const reason = `replay stuck at step ${step.id} ("${step.intent}"): ${shortMsg(err)}`;
      ctx.evidence.write({ type: 'escalation_request', stepId: step.id, reason });
      const resumed = await opts.onEscalation({ reason });
      if (resumed) {
        ctx.escalation = ctx.escalation ?? {
          interventionId: `esc-${step.id}`,
          reason,
          resumedByHuman: true,
          humanActionsObserved: 0,
        };
        return runStepRetry(ctx, artifact, opts, step, t0);
      }
    }
    // 4) hard failure
    const ref = await shot(ctx, `fail-${step.id}`);
    return fail(ctx, step, classifyPhase(err), errorClassOf(err), step.intent, shortMsg(err), [ref]);
  }
}

async function runStepRetry(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions & { allowRisky?: boolean },
  step: Step,
  t0: number
): Promise<StepOutcome> {
  try {
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
  step: Step
): Promise<string | null> {
  const url = ctx.driver.page.url();
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
    if (!urlHit && !rule.when.errorClass && !rule.when.pageTextContains && !rule.when.dialogTextContains) continue;
    if (!urlHit && !rule.when.errorClass) continue;

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

/** Executes a recovery action chain. */
async function runRecoveryActions(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  step: Step,
  actions: Array<import('../core/artifact.js').RecoverAction>
): Promise<void> {
  const c = templateCtx(artifact, opts, ctx);
  for (const act of actions) {
    if (act.action === 'navigate') {
      await ctx.driver.act({ type: 'navigate', url: interpolate(act.urlTemplate, c) });
    } else if (act.action === 'wait') {
      await ctx.driver.act({ type: 'wait', ms: Math.min(act.durationMs, 5000) });
    } else if (act.action === 'gotoStepPage') {
      const url = interpolate(step.pageUrl ?? '', c);
      ctx.evidence.write({ type: 'goto_step_page', stepId: step.id, url, framePath: step.target?.scope.framePath ?? [] });
      if (!url) continue;
      const fp = step.target?.scope.framePath ?? [];
      if (fp.length > 0) {
        // Return the FRAME to the step's page (frameset apps keep the shell).
        const parent = resolveFrameByPathPublic(ctx.driver.page, fp.slice(0, -1));
        const leaf = fp[fp.length - 1]!;
        const target = parent.childFrames().find((f) => f.name() === leaf || f.url() === leaf);
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
        ctx.evidence.write({ type: 'goto_step_page_error', stepId: step.id, message: 'target frame not found' });
      }
      await ctx.driver.act({ type: 'navigate', url });
    } else {
      const res = await resolveDescriptor(ctx.driver.page, act.target, { timeoutMs: 6000 });
      if (!res.locator) throw new Error('recovery target missing');
      if (act.action === 'click') await res.locator.click({ timeout: 8000 });
      else if (act.action === 'fill') await res.locator.fill(interpolate(act.valueTemplate, c), { timeout: 8000 });
      else {
        const label = interpolate(act.optionTextTemplate, c);
        await res.locator.selectOption({ label }).catch(() => res.locator!.selectOption(label));
      }
      // Clicks inside the chain trigger navigations (Sign In → main) — settle
      // so subsequent chain actions don't race the frameset reload.
      if (act.action === 'click') await ctx.driver.waitForLoadStateSettle();
    }
  }
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
