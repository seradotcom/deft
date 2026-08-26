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
import type { AgentAction } from '../core/actions.js';
import type { ElementHandle, Locator } from 'playwright';
import { interpolate, resolveDescriptor, idPatternMatches } from '../surface/targeting.js';
import { resolveFrameByPathStrict } from '../surface/targeting.js';
import { gridToPx, type SurfaceActionGuard } from '../surface/driver.js';

function resolveFrameByPathPublic(page: import('playwright').Page, path: string[]): import('playwright').Frame | null {
  return resolveFrameByPathStrict(page, path);
}
import { openRunContext, runCheck, extractStepOutput, validateOutputs, artifactPreflight, templateCtx, globMatch, errorClassOf, classifyPhase, shortMsg, describeCheck, describeExtract, matchBusinessOutcome, targetSurfaceFailure, checkSurfaceFailure, type Ctx, type ReplayOptions } from './support.js';

function writeEvidence(ctx: Ctx, event: Record<string, unknown>): void {
  try {
    ctx.evidence.write(event);
  } catch (error) {
    throw Object.assign(new Error(`evidence write failed: ${error instanceof Error ? error.message : String(error)}`), {
      deftClass: 'EVIDENCE_WRITE_FAILED',
    });
  }
}

/** One guarded boundary for every driver-level action. Driver.act returns a
 * typed ActOutcome; ignoring `ok:false` used to let a failed navigation or
 * coordinate click continue into post-checks as if it had succeeded. */
async function performDriverAction(
  ctx: Ctx,
  action: AgentAction,
  stepId: string,
  execution: { mode: string; attempt: number },
  expectsDialog = false,
  guard?: SurfaceActionGuard
): Promise<void> {
  const outcome = await ctx.driver.act(action, guard);
  if (outcome.events.length > 0) {
    writeEvidence(ctx, { type: 'surface_events', stepId, mode: execution.mode, attempt: execution.attempt, events: outcome.events });
  }
  if (!outcome.ok) {
    throw Object.assign(new Error(outcome.message ?? `driver action failed: ${action.type}`), {
      deftClass: outcome.errorClass ?? 'ACT_FAILED',
    });
  }
  if (expectsDialog) await ctx.driver.waitForExpectedDialog();
  const lateEvents = ctx.driver.drainEvents();
  if (lateEvents.length > 0) {
    writeEvidence(ctx, { type: 'surface_events', stepId, mode: execution.mode, attempt: execution.attempt, events: lateEvents });
  }
}

async function resolvedSubmitControl(element: ElementHandle<Element>): Promise<boolean> {
  return element.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    return (tag === 'input' && (type === 'submit' || type === 'image')) ||
      (tag === 'button' && (type === 'submit' || (type === '' && (el as HTMLButtonElement).form !== null)));
  }).catch(() => false);
}

async function submitControlAtPoint(
  frame: import('playwright').Frame,
  point: { x: number; y: number }
): Promise<boolean> {
  return frame.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return false;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    return (tag === 'input' && (type === 'submit' || type === 'image')) ||
      (tag === 'button' && (type === 'submit' || (type === '' && (el as HTMLButtonElement).form !== null)));
  }, point).catch(() => false);
}

function validSubmitEffect(step: Step): boolean {
  return (step.riskClass === 'risky' && step.idempotent === false) ||
    (step.riskClass === 'safe' && step.idempotent === true);
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
      try {
        await performDriverAction(ctx, { type: 'navigate', url: entryUrl }, 'entry', { mode: 'normal', attempt: 1 });
        if (!ctx.policy.isUrlAllowed(ctx.driver.page.url())) {
          throw Object.assign(new Error(`entry redirected outside allowlist: ${ctx.driver.page.url()}`), { deftClass: 'POLICY_BLOCKED' });
        }
      } catch (err) {
        status = 'FAILED';
        failure = { stepId: 'entry', phase: 'act', errorClass: errorClassOf(err), expected: entryUrl, observed: shortMsg(err), evidenceRefs: [] };
      }
      await shot(ctx, 'entry');
    }

    if (status === 'SUCCESS') {
      // Deterministic auth phase — engine-executed, policy-checked, evidence-
      // logged. Credential values resolve from env bindings INSIDE the engine;
      // the model never sees them (there is no model here at all).
      let authIndex = 0;
      for (const authStep of artifact.authPhase?.steps ?? []) {
        const outcome = await runStep(ctx, artifact, opts, authStep, authIndex, { mode: 'auth' });
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
        const surfaceFailure = checkSurfaceFailure(ctx, chk);
        if (surfaceFailure) {
          status = 'FAILED';
          failure = {
            stepId: 'successCondition', phase: 'verify', errorClass: surfaceFailure,
            expected: describeCheck(chk), observed: 'target surface unavailable or outside allowlist', evidenceRefs: [],
          };
          break;
        }
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

type ExecutionMode = 'normal' | 'auth' | 'recovery' | 'fast-forward' | 'retry';
type DispatchState = 'not-started' | 'in-flight' | 'completed' | 'postcheck-uncertain';
type StepExecutionInternal = { mode?: ExecutionMode; attempt?: number; framePath?: string[] };
const MODE_RULES: Record<ExecutionMode, { mayRecover: boolean; mayApproveRisk: boolean; mayEscalateFailure: boolean }> = {
  normal: { mayRecover: true, mayApproveRisk: true, mayEscalateFailure: true },
  auth: { mayRecover: false, mayApproveRisk: false, mayEscalateFailure: false },
  recovery: { mayRecover: false, mayApproveRisk: false, mayEscalateFailure: false },
  'fast-forward': { mayRecover: false, mayApproveRisk: false, mayEscalateFailure: false },
  retry: { mayRecover: false, mayApproveRisk: false, mayEscalateFailure: false },
};

async function runStep(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions & { allowRisky?: boolean },
  step: Step,
  stepIndex = 0,
  internal: StepExecutionInternal = {}
): Promise<StepOutcome> {
  const t0 = Date.now();
  const mode = internal.mode ?? 'normal';
  const modeRules = MODE_RULES[mode];
  const attempt = internal.attempt ?? (mode === 'retry' ? 2 : 1);
  const previousExecution = ctx.execution;
  let dispatchState: DispatchState = 'not-started';
  ctx.execution = { mode, attempt };
  ctx.evidence.write({ type: 'step_start', stepId: step.id, intent: step.intent, action: step.action, mode, attempt });

  try {
    if (
    step.riskClass === 'risky' &&
    !opts.allowRisky &&
    (artifact.riskPolicy?.onRiskyStep ?? 'require_approval') === 'require_approval' &&
    !ctx.approvedRiskySteps.has(step.id)
    ) {
    // Human-in-the-loop approval: an operator may authorize the risky step
    // through the escalation channel instead of pre-approving the whole run.
    if (opts.onEscalation && modeRules.mayApproveRisk && !ctx.recoveryAttempts.has(`risky:${step.id}`)) {
      ctx.recoveryAttempts.set(`risky:${step.id}`, 1);
      const reason = `risky step "${step.intent}" requires operator approval`;
      const approved = await escalateToHuman(ctx, opts, step, reason);
      if (approved) {
        ctx.approvedRiskySteps.add(step.id);
        ctx.evidence.write({ type: 'risky_approved_by_operator', stepId: step.id });
        // fall through: approval granted for this step
      } else {
        return fail(ctx, step, 'act', 'RISKY_STEP_BLOCKED', 'approved unattended execution', `risky step requires approval: ${step.intent}`, []);
      }
    } else {
      return fail(ctx, step, 'act', 'RISKY_STEP_BLOCKED', 'approved unattended execution', `risky step requires approval: ${step.intent}`, []);
    }
    }
    switch (step.action) {
      case 'navigate': {
        const url = interpolate(step.valueTemplate ?? '', templateCtx(artifact, opts, ctx));
        if (!ctx.policy.isUrlAllowed(url)) {
          return fail(ctx, step, 'act', 'POLICY_BLOCKED', url, 'outside allowlist', []);
        }
        if (internal.framePath?.length) {
          const frame = resolveFrameByPathStrict(ctx.driver.page, internal.framePath);
          if (!frame) return fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', `frame path [${internal.framePath.join('>')}]`, 'frame missing', []);
          if (!ctx.policy.isUrlAllowed(frame.url())) return fail(ctx, step, 'act', 'POLICY_BLOCKED', url, `disallowed frame url: ${frame.url()}`, []);
          dispatchState = 'in-flight';
          await frame.evaluate((target) => { window.location.href = target; }, url);
          await ctx.driver.waitForLoadStateSettle();
          dispatchState = 'completed';
          if (!ctx.policy.isUrlAllowed(frame.url())) return fail(ctx, step, 'act', 'POLICY_BLOCKED', url, `disallowed frame url after navigation: ${frame.url()}`, []);
        } else {
          dispatchState = 'in-flight';
          await performDriverAction(ctx, { type: 'navigate', url }, step.id, { mode, attempt });
          dispatchState = 'completed';
          if (!ctx.policy.isUrlAllowed(ctx.driver.page.url())) {
            return fail(ctx, step, 'act', 'POLICY_BLOCKED', url, `redirected outside allowlist: ${ctx.driver.page.url()}`, []);
          }
        }
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

        if (located.mode === 'coordinate') {
          if (located.submitControl && step.submission !== 'SUBMIT') {
            return fail(ctx, step, 'act', 'ARTIFACT_INVALID', 'coordinate submit with explicit SUBMIT metadata', 'coordinate hit-test resolved a form submit control without submission semantics', []);
          }
          if (located.submitControl && !validSubmitEffect(step)) {
            return fail(ctx, step, 'act', 'ARTIFACT_INVALID', 'consistent SUBMIT effect metadata', 'coordinate submit metadata does not match risk/idempotence', []);
          }
          if (!located.submitControl && step.submission === 'SUBMIT') {
            return fail(ctx, step, 'act', 'ARTIFACT_INVALID', 'coordinate resolving to a submit control', 'SUBMIT coordinate no longer resolves to a submit control', []);
          }
          const coordinateFrame = step.target.scope.framePath?.length
            ? resolveFrameByPathStrict(ctx.driver.page, step.target.scope.framePath)
            : ctx.driver.page.mainFrame();
          if (!coordinateFrame) return fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', 'declared coordinate frame', 'frame disappeared before dispatch', []);
          if (!ctx.policy.isUrlAllowed(coordinateFrame.url())) {
            return fail(ctx, step, 'act', 'POLICY_BLOCKED', coordinateFrame.url(), 'coordinate surface left policy before dispatch', []);
          }
          if (step.expectsDialog) ctx.driver.acceptNextDialog();
          try {
            dispatchState = 'in-flight';
            await performDriverAction(
              ctx,
              { type: 'click', hint: { px: located.px } },
              step.id,
              { mode, attempt },
              step.expectsDialog,
              {
                framePath: step.target.scope.framePath ?? [],
                isUrlAllowed: (url) => ctx.policy.isUrlAllowed(url),
              }
            );
            dispatchState = 'completed';
          } finally {
            ctx.driver.disarmNextDialog();
          }
          break;
        }

        const loc = located.locator!;
        // Let delayed frame/top-level redirects settle before the final
        // surface check. This closes the race where locate waits while the
        // target silently crosses the origin boundary.
        await ctx.driver.waitForLoadStateSettle();
        const preActionFrame = step.target.scope.framePath?.length
          ? resolveFrameByPathStrict(ctx.driver.page, step.target.scope.framePath)
          : ctx.driver.page.mainFrame();
        if (!preActionFrame) return fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', 'declared target frame', 'frame disappeared before action', []);
        if (!ctx.policy.isUrlAllowed(preActionFrame.url())) return fail(ctx, step, 'act', 'POLICY_BLOCKED', preActionFrame.url(), 'target surface redirected before action', []);
        // Pin the exact DOM node before the last policy check. Acting through
        // the Locator here would allow Playwright to re-resolve it on a
        // replacement document after the check (a TOCTOU escape). A pinned
        // handle instead detaches and fails closed if navigation wins.
        const element = await loc.elementHandle({ timeout: 12000 }).catch(() => null);
        if (!element) return fail(ctx, step, 'locate', 'ELEMENT_NOT_FOUND', 'one live target element', 'target disappeared before dispatch', []);
        const c = templateCtx(artifact, opts, ctx);
        const isSubmitControl = step.action === 'click' && await resolvedSubmitControl(element);
        if (isSubmitControl && step.submission !== 'SUBMIT') {
          return fail(ctx, step, 'act', 'ARTIFACT_INVALID', 'submit control with explicit SUBMIT metadata', 'resolved target is a form submit control without explicit submission semantics', []);
        }
        if (isSubmitControl && !validSubmitEffect(step)) {
          return fail(ctx, step, 'act', 'ARTIFACT_INVALID', 'consistent SUBMIT effect metadata', 'submit metadata does not match its declared risk/idempotence', []);
        }
        if (step.submission === 'SUBMIT' && !isSubmitControl && step.action === 'click') {
          return fail(ctx, step, 'act', 'ARTIFACT_INVALID', 'resolved submit control', 'SUBMIT metadata was declared for a non-submit target', []);
        }
        const dispatchFrame = step.target.scope.framePath?.length
          ? resolveFrameByPathStrict(ctx.driver.page, step.target.scope.framePath)
          : ctx.driver.page.mainFrame();
        if (!dispatchFrame) return fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', 'declared target frame', 'frame disappeared before dispatch', []);
        if (!ctx.policy.isUrlAllowed(dispatchFrame.url())) {
          return fail(ctx, step, 'act', 'POLICY_BLOCKED', dispatchFrame.url(), 'target surface left policy before dispatch', []);
        }
        if (step.expectsDialog) ctx.driver.acceptNextDialog();
        try {
          dispatchState = 'in-flight';
          if (step.action === 'click') {
            await element.click({ timeout: 12000 });
          } else if (step.action === 'fill') {
            await element.fill(interpolate(step.valueTemplate ?? '', c), { timeout: 10000 });
          } else if (step.action === 'select') {
            const label = interpolate(step.selectOptionText ?? '', c);
            await element.selectOption({ label }).catch(() => element.selectOption(label));
          } else {
            await element.press(step.keyCombo ?? 'Enter');
          }
          dispatchState = 'completed';
          // Direct locator calls bypass driver.act(); settle while the
          // expected dialog remains armed, then disarm lexically below.
          if (step.expectsDialog) await ctx.driver.waitForExpectedDialog();
          if (step.action !== 'fill' && step.action !== 'select') {
            await ctx.driver.waitForLoadStateSettle();
          }
        } finally {
          ctx.driver.disarmNextDialog();
          await element.dispose().catch(() => undefined);
        }
        const activeFrame = step.target.scope.framePath?.length
          ? resolveFrameByPathStrict(ctx.driver.page, step.target.scope.framePath)
          : ctx.driver.page.mainFrame();
        if (!activeFrame) {
          throw Object.assign(new Error('declared target frame disappeared after action'), { deftClass: 'FRAME_NOT_FOUND' });
        }
        if (!ctx.policy.isUrlAllowed(activeFrame.url())) {
          throw Object.assign(new Error(`target surface redirected outside allowlist: ${activeFrame.url()}`), { deftClass: 'POLICY_BLOCKED' });
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
        dispatchState = 'in-flight';
        await performDriverAction(ctx, { type: 'scroll', direction: step.scrollDirection ?? 'down', magnitude: 400 }, step.id, { mode, attempt });
        dispatchState = 'completed';
        break;
      case 'wait':
        dispatchState = 'in-flight';
        await performDriverAction(ctx, { type: 'wait', ms: step.waitDurationMs ?? 800 }, step.id, { mode, attempt });
        dispatchState = 'completed';
        break;
      case 'extract': {
        dispatchState = 'in-flight';
        const surfaceFailure = targetSurfaceFailure(ctx, step.extract?.strategy === 'tableCell'
          ? { scope: step.extract.scope }
          : step.extract?.target);
        if (surfaceFailure) {
          return fail(ctx, step, 'locate', surfaceFailure, 'allowed target surface', 'target surface unavailable or outside allowlist', []);
        }
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
        dispatchState = 'completed';
        break;
      }
      case 'check': {
        dispatchState = 'postcheck-uncertain';
        const surfaceFailure = checkSurfaceFailure(ctx, step.postCheck);
        if (surfaceFailure) return fail(ctx, step, 'verify', surfaceFailure, describeCheck(step.postCheck), 'target surface unavailable or outside allowlist', []);
        const ok = await runCheck(ctx, artifact, opts, step.postCheck);
        if (!ok) {
          const ref = await shot(ctx, `fail-check-${step.id}`);
          return fail(ctx, step, 'verify', step.idempotent === false ? 'NON_IDEMPOTENT_OUTCOME_UNKNOWN' : 'CHECK_FAILED', describeCheck(step.postCheck), 'failed after dispatched step', [ref]);
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
      dispatchState = 'postcheck-uncertain';
      const surfaceFailure = checkSurfaceFailure(ctx, step.postCheck);
      if (surfaceFailure) return fail(ctx, step, 'verify', surfaceFailure, describeCheck(step.postCheck), 'target surface unavailable or outside allowlist', []);
      const ok = await runCheck(ctx, artifact, opts, step.postCheck);
      if (!ok) {
        const probe = await pageProbe(ctx);
        const biz = matchBusinessOutcome(artifact, step.id, probe);
        if (biz) return { kind: 'business', business: biz };
        const ref = await shot(ctx, `fail-post-${step.id}`);
        return fail(ctx, step, 'verify', step.idempotent === false ? 'NON_IDEMPOTENT_OUTCOME_UNKNOWN' : 'POST_CHECK_FAILED', describeCheck(step.postCheck), summarize(probe), [ref]);
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
    ctx.evidence.write({ type: 'step_ok', stepId: step.id, ms: Date.now() - t0, mode, attempt });
    return { kind: 'ok' };
  } catch (err) {
    ctx.driver.disarmNextDialog();
    if (step.idempotent === false && dispatchState !== 'not-started') {
      const ref = await shot(ctx, `fail-uncertain-${step.id}`);
      return fail(ctx, step, classifyPhase(err), 'NON_IDEMPOTENT_OUTCOME_UNKNOWN', 'confirmed completion or explicit operator recovery', shortMsg(err), [ref]);
    }
    // 1) bounded recovery chain (e.g. session expiry re-login)
    let recovered: string | null = null;
    if (modeRules.mayRecover) {
      try {
        recovered = await attemptRecovery(ctx, artifact, opts, step, err);
      } catch (recoveryErr) {
        const ref = await shot(ctx, `fail-recovery-${step.id}`);
        return fail(ctx, step, 'recover', 'RECOVERY_FAILED', step.intent, shortMsg(recoveryErr), [ref]);
      }
    }
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
      const retry = await reconstructAndRetry(ctx, artifact, opts, step, stepIndex);
      if (retry.kind === 'failure') {
        // The retry's mode-specific event is an attempt result. Promote its
        // terminal failure once here so the logical step has exactly one
        // ordinary step_failed event as well.
        return fail(ctx, step, retry.failure.phase, retry.failure.errorClass, retry.failure.expected, retry.failure.observed, retry.failure.evidenceRefs);
      }
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
    if (opts.onEscalation && modeRules.mayEscalateFailure && !ctx.recoveryAttempts.has(`esc:${step.id}`)) {
      ctx.recoveryAttempts.set(`esc:${step.id}`, 1);
      const reason = `replay stuck at step ${step.id} ("${step.intent}"): ${shortMsg(err)}`;
      const resumed = await escalateToHuman(ctx, opts, step, reason);
      if (resumed) {
        const retry = await reconstructAndRetry(ctx, artifact, opts, step, stepIndex);
        if (retry.kind === 'failure') {
          return fail(ctx, step, retry.failure.phase, retry.failure.errorClass, retry.failure.expected, retry.failure.observed, retry.failure.evidenceRefs);
        }
        return retry;
      }
    }
    // 4) hard failure
    const ref = await shot(ctx, `fail-${step.id}`);
    return fail(ctx, step, classifyPhase(err), errorClassOf(err), step.intent, shortMsg(err), [ref]);
  } finally {
    ctx.execution = previousExecution;
  }
}

/**
 * Post-recovery retry: re-executes the deterministic flow from the first
 * non-login step up to the failed one (fast-forward), so POST-arrival pages
 * are re-reached by re-running the flow instead of blind GET navigation
 * ("Cannot GET /results.aspx" taught us this). Then retries the failed step
 * through the SAME guarded executor.
 */
async function reconstructAndRetry(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions & { allowRisky?: boolean },
  step: Step,
  stepIndex: number
): Promise<StepOutcome> {
  try {
    // Fast-forward: rebuild deterministic state by RE-RUNNING the verified
    // steps through the SAME guarded pipeline (policy, fail-closed frames,
    // evidence). Non-idempotent steps are NEVER re-executed — a submit that
    // already happened must not happen twice; crossing one means escalate.
    for (let j = 0; j < stepIndex; j++) {
      const prev = artifact.steps[j]!;
      if (prev.idempotent === false) {
        ctx.evidence.write({ type: 'fast_forward_blocked_non_idempotent', stepId: prev.id });
        const ref = await shot(ctx, `fail-ff-${step.id}`);
        return fail(ctx, step, 'act', 'FAST_FORWARD_BLOCKED', 'idempotent state reconstruction', `non-idempotent step ${prev.id} lies between recovery and the failed step — refusing to duplicate a side effect`, [ref], { mode: 'fast-forward', attempt: 1 });
      }
      const ff = await runStep(ctx, artifact, { ...opts, onEscalation: undefined }, prev, j, { mode: 'fast-forward', attempt: 1 });
      if (ff.kind !== 'ok') {
        const ref = await shot(ctx, `fail-ff-${step.id}`);
        return fail(ctx, step, 'act', 'FAST_FORWARD_FAILED', `reconstruction via ${prev.id}`, ff.kind === 'failure' ? ff.failure?.observed ?? 'fast-forward step failed' : `business outcome ${ff.business.code} during fast-forward`, [ref], { mode: 'fast-forward', attempt: 1 });
      }
    }
    const outcome = await runStep(ctx, artifact, opts, step, stepIndex, { mode: 'retry', attempt: 2 });
    if (outcome.kind === 'ok') ctx.evidence.write({ type: 'step_ok_after_recovery', stepId: step.id, mode: 'retry', attempt: 2 });
    return outcome;
  } catch (err) {
    const probe = await pageProbe(ctx);
    const biz = matchBusinessOutcome(artifact, step.id, probe);
    if (biz) return { kind: 'business', business: biz };
    const ref = await shot(ctx, `fail-retry-${step.id}`);
    return fail(ctx, step, classifyPhase(err), errorClassOf(err), step.intent, shortMsg(err), [ref], { mode: 'retry', attempt: 2 });
  }
}

type LocateOutcome =
  | { mode: 'locator'; locator: Locator }
  | { mode: 'coordinate'; px: { x: number; y: number }; submitControl: boolean }
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
  const currentFrame = fp.length ? resolveFrameByPathStrict(ctx.driver.page, fp) : null;
  if (fp.length && !currentFrame) {
    return { outcome: fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', `frame path [${fp.join('>')}]`, 'frame missing', []) };
  }
  const currentSurfaceUrl = currentFrame?.url() ?? ctx.driver.page.url();
  if (!currentSurfaceUrl || !ctx.policy.isUrlAllowed(currentSurfaceUrl)) {
    return { outcome: fail(ctx, step, 'locate', 'POLICY_BLOCKED', `allowed target surface for ${step.id}`, `disallowed current surface: ${currentSurfaceUrl ?? 'missing frame'}`, []) };
  }
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
      let px: { x: number; y: number } | null = null;
      if (spec.space === 'viewport-grid') {
        if ((step.target!.scope.framePath ?? []).length > 0) {
          return { outcome: fail(ctx, step, 'locate', 'ARTIFACT_INVALID', 'viewport-grid with top-level scope', 'viewport-grid cannot target a declared child frame', []) };
        }
        const viewport = ctx.driver.page.viewportSize() ?? { width: 1440, height: 900 };
        px = gridToPx(spec.x, spec.y, viewport);
      } else {
        // frame-px is strictly frame-local. A missing declared child frame is
        // not permission to click the parent or reinterpret pixels globally.
        const framePath = step.target!.scope.framePath ?? [];
        if (framePath.length === 0) {
          const viewport = ctx.driver.page.viewportSize() ?? { width: 1440, height: 900 };
          if (spec.x >= viewport.width || spec.y >= viewport.height) {
            const ref = await shot(ctx, `fail-coordinate-${step.id}`);
            return { outcome: fail(ctx, step, 'locate', 'COORDINATE_OUT_OF_BOUNDS', 'live viewport bounds', `frame-px [${spec.x},${spec.y}] outside ${viewport.width}x${viewport.height}`, [ref]) };
          }
          px = { x: spec.x, y: spec.y };
        } else {
          const frame = resolveFrameByPathPublic(ctx.driver.page, framePath);
          if (!frame) {
            const ref = await shot(ctx, `fail-frame-${step.id}`);
            return { outcome: fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', `frame path [${framePath.join('>')}]`, 'frame missing for frame-px coordinate', [ref]) };
          }
          const fe = await frame.frameElement();
          const box = await fe.asElement()?.boundingBox();
          if (!box) {
            const ref = await shot(ctx, `fail-frame-${step.id}`);
            return { outcome: fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', `frame path [${framePath.join('>')}]`, 'frame has no viewport box', [ref]) };
          }
          if (spec.x >= box.width || spec.y >= box.height) {
            const ref = await shot(ctx, `fail-coordinate-${step.id}`);
            return { outcome: fail(ctx, step, 'locate', 'COORDINATE_OUT_OF_BOUNDS', 'declared frame bounds', `frame-px [${spec.x},${spec.y}] outside ${Math.round(box.width)}x${Math.round(box.height)}`, [ref]) };
          }
          px = { x: Math.round(box.x + spec.x), y: Math.round(box.y + spec.y) };
        }
      }
      const coordinateFrame = spec.space === 'viewport-grid'
        ? ctx.driver.page.mainFrame()
        : resolveFrameByPathStrict(ctx.driver.page, step.target!.scope.framePath ?? []);
      if (!coordinateFrame) {
        return { outcome: fail(ctx, step, 'locate', 'FRAME_NOT_FOUND', 'coordinate target frame', 'frame missing before coordinate hit-test', []) };
      }
      const localPoint = spec.space === 'viewport-grid' ? px : { x: spec.x, y: spec.y };
      const submitControl = await submitControlAtPoint(coordinateFrame, localPoint);
      ctx.evidence.write({ type: 'coordinate_click_viewport', stepId: step.id, px });
      return { mode: 'coordinate', px, submitControl };
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
  let n = 0;
  for (const act of actions) {
    n += 1;
    const pseudoId = `${step.id}-rec${n}`;
    // Recovery inherits the failed step's safety metadata.  Recovery is not
    // an escape hatch for turning an unknown side effect into a safe one.
    // Frame semantics for gotoStepPage are carried separately below.
    const pseudoStep: Step = {
      id: pseudoId,
      intent: `recovery ${act.action} for ${step.id}`,
      action: act.action === 'navigate' || act.action === 'gotoStepPage' ? 'navigate' : act.action === 'wait' ? 'wait' : act.action === 'fill' ? 'fill' : act.action === 'click' ? 'click' : 'select',
      target: 'target' in act ? act.target : undefined,
      valueTemplate: act.action === 'navigate' ? act.urlTemplate : act.action === 'gotoStepPage' ? step.pageUrl : act.action === 'fill' ? act.valueTemplate : undefined,
      selectOptionText: act.action === 'select' ? act.optionTextTemplate : undefined,
      submission: act.action === 'click' ? act.submission : undefined,
      waitDurationMs: act.action === 'wait' ? act.durationMs : undefined,
      pageUrl: step.pageUrl,
      recoverableErrors: [],
      riskClass: act.riskClass,
      idempotent: act.idempotent,
      expectsDialog: act.expectsDialog,
    };
    if (act.action === 'gotoStepPage' && !step.pageUrl) continue;
    const outcome = await runStep(ctx, artifact, { ...opts, onEscalation: undefined }, pseudoStep, 0, {
      mode: 'recovery',
      framePath: act.action === 'gotoStepPage' ? step.target?.scope.framePath : undefined,
    });
    if (outcome.kind === 'failure') {
      throw new Error(`recovery ${act.action} failed: ${outcome.failure.errorClass}`);
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
  extraRefs: string[],
  execution?: { mode: string; attempt: number }
): { kind: 'failure'; failure: NonNullable<ReplayResult['failure']> } {
  const mode = execution?.mode ?? ctx.execution?.mode ?? 'normal';
  const attempt = execution?.attempt ?? ctx.execution?.attempt ?? 1;
  ctx.evidence.write({ type: mode === 'normal' || mode === 'auth' ? 'step_failed' : 'step_attempt_failed', stepId: step.id, errorClass, expected, observed, evidenceRefs: extraRefs, mode, attempt });
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
    for (const f of ctx.driver.page.frames().filter((frame) => ctx.policy.isUrlAllowed(frame.url()))) {
      const t = await f.locator('body').innerText({ timeout: 1500 }).catch(() => '');
      if (!ctx.policy.isUrlAllowed(f.url())) return { url: ctx.driver.page.url() };
      if (t) parts.push(t);
    }
    if (ctx.driver.page.frames().some((frame) => frame.url() && !/^about:blank$/i.test(frame.url()) && !ctx.policy.isUrlAllowed(frame.url()))) {
      return { url: ctx.driver.page.url() };
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
















