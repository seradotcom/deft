import AjvDefault from 'ajv/dist/ajv.js';
import { createHash } from 'node:crypto';
type AjvError = { instancePath: string; message?: string };
type AjvValidator = { compile: (s: object) => ((data: unknown) => boolean) & { errors?: AjvError[] } };
/**
 * Replay support: run context, variant overlays, input validation, checks,
 * relational extraction, and the failure/outcome classification helpers.
 */
import type { Locator, Page } from 'playwright';
import type { Observation } from '../core/actions.js';
import type { InterventionResult } from '../hitl/operator-console.js';
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type Check,
  type ReplayResult,
  type Step,
  type StepTimelineEntry,
} from '../core/artifact.js';
import { PlaywrightWebDriver } from '../surface/driver.js';
import { interpolate, resolveDescriptor, resolveFrameByPathStrict } from '../surface/targeting.js';
import { defaultPolicy, PolicyEngine } from '../safety/policy.js';
import { EvidenceLogger } from '../evidence/logger.js';

export interface ReplayOptions {
  tenantId?: string;
  /** sha256 of the artifact bytes loaded by the caller — flows into the result. */
  artifactBytes?: Uint8Array | string;
  /** Raw runtime env — artifact environmentBindings resolve against it INSIDE
   *  the engine. Pre-resolved `env` (if given) takes precedence per key. */
  runtimeEnv?: Record<string, string | undefined>;
  env: Record<string, string>;
  inputs: Record<string, unknown>;
  headless?: boolean;
  allowRisky?: boolean;
  runsDir?: string;
  capabilitiesDir?: string;
  /**
   * Human-in-the-loop: called when a step can't be completed safely or a risky
   * step needs approval. Receives the REAL current observation (screenshot +
   * a11y outline) so the operator sees the actual live state. While the
   * callback is pending, the engine samples the live session (screenshots +
   * a11y) — that audit trail IS the record of what the human did.
   */
  onEscalation?: (info: { reason: string; observation: Observation }) => Promise<boolean>;
  onManualTakeover?: (info: {
    reason: string;
    observation: Observation;
    sessionId: string;
    observeCurrent: () => Promise<Observation>;
    dialogLease: {
      begin: () => void | Promise<void>;
      isPending: () => boolean;
      resolve: (action: 'accept' | 'dismiss') => Promise<void>;
      clickAt: (x: number, y: number) => Promise<void>;
      cleanup: () => Promise<void>;
    };
  }) => Promise<InterventionResult>;
}

export interface Ctx {
  driver: PlaywrightWebDriver;
  policy: PolicyEngine;
  evidence: EvidenceLogger;
  timeline: StepTimelineEntry[];
  degradedSteps: string[];
  outputs: Record<string, unknown>;
  recoveryAttempts: Map<string, number>;
  lastShots: string[];
  execution?: { mode: 'normal' | 'auth' | 'recovery' | 'fast-forward' | 'retry'; attempt: number };
  approvedRiskySteps: Set<string>;
  escalation?: {
    interventionId: string;
    reason: string;
    resumedByHuman: boolean;
    /** Audit samples captured while the human held the lease. */
    humanSamplesCaptured: number;
    /** How many samples differed from the previous one � evidence of REAL
     *  state change under human control (not five identical screenshots). */
    humanStateChanges: number;
  };
}

export async function openRunContext(
  artifact: CapabilityArtifact,
  opts: ReplayOptions
): Promise<Ctx> {
  const driver = new PlaywrightWebDriver({ headless: opts.headless ?? true });
  await driver.start();
  const baseUrl = opts.env.baseUrl ?? '';
  const policy = defaultPolicy(baseUrl || 'http://localhost:7788');
  const evidence = new EvidenceLogger(
    opts.runsDir ?? process.env.DEFT_RUNS_DIR ?? 'artifacts/runs',
    'replay',
    `${artifact.metadata.id}${opts.tenantId ? '@' + opts.tenantId : ''}`
  );
  return {
    driver,
    policy,
    evidence,
    timeline: [],
    degradedSteps: [],
    outputs: {},
    recoveryAttempts: new Map(),
    lastShots: [],
    approvedRiskySteps: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Templates / variants / validation
// ---------------------------------------------------------------------------

export function templateCtx(
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  ctx: Ctx
): Record<string, unknown> {
  return {
    inputs: opts.inputs,
    env: opts.env,
    target: { entryUrl: artifact.target.entryUrlTemplate },
    outputs: ctx.outputs,
  };
}

/** Validate the live surface selected by a target/check before resolving or
 * touching a locator. A declared frame path is exact: never fall back to its
 * parent, and never inspect a frame outside the run's origin policy. */
export function targetSurfaceFailure(
  ctx: Ctx,
  target: { scope?: { framePath?: string[] } } | undefined
): 'FRAME_NOT_FOUND' | 'POLICY_BLOCKED' | null {
  if (!target) return null;
  const framePath = target.scope?.framePath ?? [];
  const frame = resolveFrameByPathStrict(ctx.driver.page, framePath);
  if (!frame) return 'FRAME_NOT_FOUND';
  if (!ctx.policy.isUrlAllowed(frame.url())) return 'POLICY_BLOCKED';
  return null;
}

/** Targetless checks/probes still have a surface. Reading a disallowed frame
 * as part of an aggregate page check would turn hostile content into success. */
export function checkSurfaceFailure(
  ctx: Ctx,
  check: Check | undefined
): 'FRAME_NOT_FOUND' | 'POLICY_BLOCKED' | null {
  if (!check) return null;
  if ('target' in check) return targetSurfaceFailure(ctx, check.target);
  const disallowed = ctx.driver.page.frames().some((frame) => {
    const url = frame.url();
    return Boolean(url) && !/^about:blank$/i.test(url) && !ctx.policy.isUrlAllowed(url);
  });
  return disallowed ? 'POLICY_BLOCKED' : null;
}

/** Resolve all artifact templates before a browser context exists. */
export function validateArtifactTemplates(
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  env: Record<string, string>
): string {
  const outputSchema = artifact.outputs as Record<string, unknown>;
  const outputProperties =
    outputSchema.type === 'object' && outputSchema.properties && typeof outputSchema.properties === 'object'
      ? (outputSchema.properties as Record<string, unknown>)
      : {};
  const outputs = Object.fromEntries(Object.keys(outputProperties).map((key) => [key, '__deft_output__']));
  const ctx: Record<string, unknown> = {
    inputs: opts.inputs,
    env,
    target: { entryUrl: '' },
    outputs,
  };
  if (/\{\{\s*target\.entryUrl\s*\}\}/.test(artifact.target.entryUrlTemplate)) {
    throw Object.assign(new Error('target.entryUrlTemplate cannot reference target.entryUrl'), { deftClass: 'ARTIFACT_INVALID' });
  }
  const resolvedEntryUrl = interpolate(artifact.target.entryUrlTemplate, ctx);
  ctx.target = { entryUrl: resolvedEntryUrl };

  const declaredOutputs = new Set(Object.keys(outputProperties));
  const outputReferencePattern = /\{\{\s*outputs\.([A-Za-z0-9_.-]+)\s*\}\}/g;
  const assertOutputReferences = (value: unknown, available: Set<string>, ancestors = new Set<object>()): void => {
    if (typeof value === 'string') {
      outputReferencePattern.lastIndex = 0;
      for (const match of value.matchAll(outputReferencePattern)) {
        const name = match[1]!;
        if (!available.has(name)) {
          throw Object.assign(new Error(`output reference is not available yet: ${name}`), { deftClass: 'ARTIFACT_INVALID' });
        }
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (ancestors.has(value)) return;
    const next = new Set(ancestors);
    next.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) assertOutputReferences(child, available, next);
  };
  const availableOutputs = new Set<string>();
  for (const step of artifact.authPhase?.steps ?? []) {
    assertOutputReferences(step, availableOutputs);
    if (step.action === 'extract' && step.outputKey) availableOutputs.add(step.outputKey);
  }
  for (const step of artifact.steps) {
    assertOutputReferences(step, availableOutputs);
    if (step.action === 'extract' && step.outputKey) availableOutputs.add(step.outputKey);
  }
  for (const chain of Object.values(artifact.recoveryChains ?? {})) assertOutputReferences(chain, new Set());
  // Final checks and declared business outcomes may refer to any declared output;
  // the generic interpolation pass below still rejects absent names.
  assertOutputReferences(artifact.successCondition, declaredOutputs);
  assertOutputReferences(artifact.businessOutcomes, declaredOutputs);

  const visit = (value: unknown, ancestors = new Set<object>()): void => {
    if (typeof value === 'string') {
      if (value.includes('{{') || value.includes('}}')) interpolate(value, ctx);
      return;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) {
        throw Object.assign(new Error('cyclic artifact structure during template preflight'), { deftClass: 'ARTIFACT_INVALID' });
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(value);
      for (const item of value) visit(item, nextAncestors);
      return;
    }
    if (value && typeof value === 'object') {
      if (ancestors.has(value)) {
        throw Object.assign(new Error('cyclic artifact structure during template preflight'), { deftClass: 'ARTIFACT_INVALID' });
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(value);
      for (const child of Object.values(value)) visit(child, nextAncestors);
    }
  };

  visit(artifact);
  return resolvedEntryUrl;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hashCapabilityArtifact(artifact: CapabilityArtifact): string {
  return createHash('sha256').update(canonicalJson(artifact), 'utf8').digest('hex');
}

function canonicalArtifactBytes(artifact: CapabilityArtifact): Uint8Array {
  return Buffer.from(canonicalJson(artifact), 'utf8');
}

function invalidArtifact(message: string): Error {
  return Object.assign(new Error(message), { deftClass: 'ARTIFACT_INVALID' });
}

function suppliedArtifactBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

export interface ArtifactPreflightResult {
  artifact: CapabilityArtifact;
  env: Record<string, string>;
  artifactSha256: string;
  artifactDefinitionBytes: Uint8Array;
}

/** Single pre-browser artifact/runtime contract gate, including tenant patches. */
export function artifactPreflight(
  artifactLike: unknown,
  opts: ReplayOptions
): ArtifactPreflightResult {
  const parsed = CapabilityArtifactSchema.safeParse(artifactLike);
  if (!parsed.success) {
    throw invalidArtifact(`invalid capability artifact: ${parsed.error.message.slice(0, 300)}`);
  }
  const sourceBytes = opts.artifactBytes === undefined ? undefined : suppliedArtifactBytes(opts.artifactBytes);
  if (sourceBytes) {
    let sourceJson: unknown;
    try {
      sourceJson = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
    } catch {
      throw invalidArtifact('artifactBytes must contain valid JSON');
    }
    const sourceParsed = CapabilityArtifactSchema.safeParse(sourceJson);
    if (!sourceParsed.success || canonicalJson(sourceParsed.data) !== canonicalJson(parsed.data)) {
      throw invalidArtifact('artifactBytes do not correspond to artifactLike');
    }
  }
  let artifact: CapabilityArtifact;
  try {
    artifact = applyVariant(parsed.data, opts.tenantId);
  } catch (error) {
    if (error && typeof error === 'object' && 'deftClass' in error) throw error;
    throw Object.assign(new Error(`invalid tenant artifact: ${(error as Error).message}`), {
      deftClass: 'ARTIFACT_INVALID',
    });
  }
  try {
    ajv.compile(artifact.inputs as object);
    ajv.compile(artifact.outputs as object);
  } catch (error) {
    throw invalidArtifact(`invalid input/output contract schema: ${(error as Error).message}`);
  }
  validateInputs(artifact, opts.inputs);
  const env = {
    ...resolveEnvironmentBindings(artifact, opts.runtimeEnv ?? process.env),
    ...(opts.env ?? {}),
  };
  const entryUrl = validateArtifactTemplates(artifact, opts, env);
  const policy = defaultPolicy(env.baseUrl ?? 'http://localhost:7788');
  if (!policy.isUrlAllowed(entryUrl)) {
    throw Object.assign(new Error(`entry URL outside policy: ${entryUrl}`), { deftClass: 'ARTIFACT_INVALID' });
  }
  const definitionBytes = opts.tenantId || !sourceBytes ? canonicalArtifactBytes(artifact) : sourceBytes;
  return {
    artifact,
    env,
    artifactSha256: createHash('sha256').update(definitionBytes).digest('hex'),
    artifactDefinitionBytes: definitionBytes,
  };
}

/** Tenant overlay: flat-key JSON patches applied to a deep clone.
 *  Bracket keys reference steps by ID ("steps[s10].target.primary.name"),
 *  not by array index — ids are stable, positions are not. */
export function applyVariant(artifact: CapabilityArtifact, tenantId?: string): CapabilityArtifact {
  if (!tenantId) return artifact;
  const variant = artifact.target.variants?.find((v) => v.match.tenantId === tenantId);
  // Fail closed: an explicitly requested tenant with no variant is a caller
  // error — silently running the base artifact for the WRONG institution
  // is exactly the multi-tenant failure mode this system exists to prevent.
  if (!variant) {
    throw new Error(`UNKNOWN_TENANT_VARIANT: no variant declared for tenant '${tenantId}'`);
  }
  const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  const steps = clone.steps as Array<{ id: string }>;
  for (const [flatKey, value] of Object.entries(variant.patches)) {
    const resolved = flatKey.replace(/^steps\[([^\]]+)\]/, (_m, stepId: string) => {
      const idx = steps.findIndex((s) => s.id === stepId);
      return `steps.${idx >= 0 ? idx : stepId}`;
    });
    setFlatPath(clone, resolved, value);
  }
  // Patches are code-by-data: revalidate the merged artifact.
  return CapabilityArtifactSchema.parse(clone);
}

function setFlatPath(obj: Record<string, unknown>, flatKey: string, value: unknown): void {
  // Supports "a.b.c" and bracket segments like steps[s3].target.primary.name
  const parts: string[] = [];
  for (const seg of flatKey.split('.')) {
    const m = seg.match(/^([A-Za-z0-9_-]+)(\[(.+)\])?$/);
    if (m?.[1]) parts.push(m[1]);
    if (m?.[3]) parts.push(m[3]);
  }
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === undefined || next === null || typeof next !== 'object') {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

const ajv = new (AjvDefault as unknown as { new (o?: object): AjvValidator })({ allErrors: true });

/** Full JSON Schema validation of the invocation against the artifact's
 *  declared input contract — not a hand-rolled subset. */
export function validateInputs(artifact: CapabilityArtifact, inputs: Record<string, unknown>): void {
  const validate = ajv.compile(artifact.inputs as object);
  const ok = validate(inputs);
  if (!ok) {
    const msg = (validate.errors ?? [])
      .map((e: AjvError) => `${e.instancePath || '(root)'} ${e.message ?? ''}`)
      .join('; ');
    throw Object.assign(new Error(`input contract violation: ${msg}`), { deftClass: 'INPUT_CONTRACT_VIOLATION' });
  }
}

/** Outputs must satisfy the declared contract before SUCCESS is returned. */
export function validateOutputs(artifact: CapabilityArtifact, outputs: Record<string, unknown>): void {
  const schema = artifact.outputs as object;
  if (!schema || Object.keys(schema).length === 0) return;
  const validate = ajv.compile(schema);
  const ok = validate(outputs);
  if (!ok) {
    const msg = (validate.errors ?? [])
      .map((e: AjvError) => `${e.instancePath || '(root)'} ${e.message ?? ''}`)
      .join('; ');
    throw Object.assign(new Error(`output contract violation: ${msg}`), {
      deftClass: 'OUTPUT_CONTRACT_VIOLATION',
    });
  }
}

/**
 * Resolve the artifact's declared environment bindings from the runtime
 * environment. Secrets stay inside the engine — they are values, never
 * model context.
 */
export function resolveEnvironmentBindings(
  artifact: CapabilityArtifact,
  runtimeEnv: Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, binding] of Object.entries(artifact.environmentBindings ?? {})) {
    if (binding.source === 'literal') out[key] = binding.value;
    else if (binding.source === 'envVar') {
      const v = runtimeEnv[binding.name];
      if (v === undefined) {
        throw Object.assign(new Error(`missing environment binding: ${key} (env var ${binding.name})`), {
          deftClass: 'ARTIFACT_INVALID',
        });
      }
      out[key] = v;
    } else {
      throw Object.assign(new Error(`unsupported binding source for ${key}`), { deftClass: 'ARTIFACT_INVALID' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export async function runCheck(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  check: Check | undefined
): Promise<boolean> {
  if (!check) return true;
  const c = templateCtx(artifact, opts, ctx);
  const page = ctx.driver.page;
  try {
    const surfaceFailure = checkSurfaceFailure(ctx, check);
    if (surfaceFailure) return false;
    if (check.assert === 'urlMatchesGlob') {
      // Frameset apps: the TOP url never changes — match any frame's URL too.
      const pattern = interpolate(check.pattern, c);
      if (ctx.policy.isUrlAllowed(page.url()) && globMatch(pattern, page.url())) return true;
      return page.frames().some((f) => ctx.policy.isUrlAllowed(f.url()) && globMatch(pattern, f.url()));
    }
    if (check.assert === 'pageTextContains') {
      // Frameset apps: aggregate visible text across all frames.
      let hay = '';
      for (const f of page.frames().filter((frame) => ctx.policy.isUrlAllowed(frame.url()))) {
        const t = await f.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        if (!ctx.policy.isUrlAllowed(f.url())) return false;
        if (t) hay += t + '\n';
      }
      if (checkSurfaceFailure(ctx, check)) return false;
      return hay.toLowerCase().includes(interpolate(check.text, c).toLowerCase());
    }
    // Fail-closed: a missing frame in the checkpoint's frame path is a
    // FRAME_NOT_FOUND, never 'check the parent surface instead'.
    const res = await resolveDescriptor(page, check.target, { timeoutMs: check.timeoutMs ?? 8000 });
    if (!res.locator) return false;
    if (targetSurfaceFailure(ctx, check.target)) return false;
    if (check.assert === 'elementVisible') {
      const visible = await res.locator.isVisible();
      return targetSurfaceFailure(ctx, check.target) ? false : visible;
    }
    if (check.assert === 'elementTextContains') {
      const text = await res.locator.innerText({ timeout: check.timeoutMs ?? 8000 });
      if (targetSurfaceFailure(ctx, check.target)) return false;
      return text.toLowerCase().includes(check.text.toLowerCase());
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Relational extraction (hostile tables)
// ---------------------------------------------------------------------------

interface TableQuery {
  rowHeader: string;
  rowValue: string;
  colHeader: string;
}

const tableCellQueryFn = (q: TableQuery): string | null => {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const matches: string[] = [];
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) continue;
    const headerRow = rows[0];
    if (!headerRow) continue;
    const headers = Array.from(headerRow.querySelectorAll('th,td')).map((h) =>
      norm(h.textContent || '')
    );
    const colIdx = headers.indexOf(norm(q.colHeader));
    const rowIdx = headers.indexOf(norm(q.rowHeader));
    if (colIdx === -1 || rowIdx === -1) continue;
    // Banking rule: a row identity matching MULTIPLE rows is not an answer.
    // Return null (EXTRACT_FAILED) rather than silently taking the first match.
    for (const row of rows.slice(1)) {
      const cells = Array.from(row.querySelectorAll('td'));
      const keyCell = cells[rowIdx];
      if (keyCell && norm(keyCell.textContent || '') === norm(q.rowValue)) {
        matches.push(cells[colIdx]?.textContent?.trim() ?? '');
      }
    }
    if (matches.length > 1) return null;
  }
  return matches.length === 1 ? matches[0]! : null;
};

export async function extractStepOutput(
  ctx: Ctx,
  artifact: CapabilityArtifact,
  opts: ReplayOptions,
  step: Step
): Promise<string | null> {
  const ex = step.extract!;
  const c = templateCtx(artifact, opts, ctx);
  const page: Page = ctx.driver.page;

  const target = ex.strategy === 'tableCell' ? { scope: ex.scope } : ex.target;
  const surfaceFailure = targetSurfaceFailure(ctx, target);
  if (surfaceFailure) {
    ctx.evidence.write({ type: 'extract_error', stepId: step.id, message: surfaceFailure });
    return null;
  }

  if (ex.strategy === 'tableCell') {
    const frame = resolveFrameByPathStrict(page, ex.scope.framePath ?? []);
    if (!frame) {
      ctx.evidence.write({ type: 'extract_error', stepId: step.id, message: 'FRAME_NOT_FOUND' });
      return null;
    }
    try {
      if (targetSurfaceFailure(ctx, { scope: ex.scope })) return null;
      const tableCount = await frame.evaluate('document.querySelectorAll("table").length');
      ctx.evidence.write({ type: 'extract_debug', stepId: step.id, frameUrl: frame.url(), tableCount });
      const value = ((await frame.evaluate(tableCellQueryFn as never, {
          rowHeader: ex.rowMatch.columnHeader,
          rowValue: interpolate(ex.rowMatch.equalsTemplate ?? ex.rowMatch.containsTemplate ?? '', c),
          colHeader: ex.columnHeader,
        } as never)) as string | null) ?? null;
      if (targetSurfaceFailure(ctx, { scope: ex.scope })) return null;
      return value;
    } catch (err) {
      ctx.evidence.write({
        type: 'extract_error',
        stepId: step.id,
        frameUrl: frame.url(),
        message: (err instanceof Error ? err.message : String(err)).split('\n')[0]?.slice(0, 200),
      });
      return null;
    }
  }

  // text strategy
  const res = await resolveDescriptor(page, ex.target, { timeoutMs: 8000 });
  if (!res.locator) return null;
  if (targetSurfaceFailure(ctx, ex.target)) return null;
  const raw = await res.locator.innerText({ timeout: 5000 }).catch(() => null);
  if (targetSurfaceFailure(ctx, ex.target)) return null;
  if (raw == null) return null;
  if (ex.regexWithGroups) {
    const m = raw.match(new RegExp(ex.regexWithGroups));
    return m?.[1] ?? m?.[0] ?? null;
  }
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

export function globMatch(glob: string, url: string): boolean {
  const re = new RegExp(
    '^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::').replace(/\*/g, '[^/]*').replace(/::/g, '.*') + '$'
  );
  return re.test(url);
}

export function errorClassOf(err: unknown): string {
  const deftClass = (err as { deftClass?: unknown } | null)?.deftClass;
  if (typeof deftClass === 'string') return deftClass;
  const msg = err instanceof Error ? err.message : String(err);
  if (/Timeout.*exceeded/i.test(msg)) return 'TIMEOUT';
  if (/strict mode violation/i.test(msg)) return 'AMBIGUOUS_TARGET';
  if (/detached/i.test(msg)) return 'TARGET_DETACHED';
  if (/Target closed|has been closed/i.test(msg)) return 'SESSION_DEAD';
  if (/net::ERR/.test(msg)) return 'NETWORK_ERROR';
  if (/missing required input|does not match pattern|must be a string/.test(msg)) return 'ARTIFACT_INVALID';
  return 'UNKNOWN_ERROR';
}

export function classifyPhase(err: unknown): StepTimelineEntry['phase'] {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Timeout.*exceeded.*visible|waiting for locator/i.test(msg)) return 'locate';
  if (/strict mode violation/i.test(msg)) return 'locate';
  return 'act';
}

export function shortMsg(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]?.slice(0, 240) ?? 'error';
}

export function describeCheck(check: Check | undefined): string {
  if (!check) return '(no check)';
  switch (check.assert) {
    case 'urlMatchesGlob':
      return `url matches ${check.pattern}`;
    case 'pageTextContains':
      return `page contains "${check.text}"`;
    case 'elementVisible':
      return `element visible: ${JSON.stringify(check.target.primary)}`;
    case 'elementTextContains':
      return `element text contains "${check.text}"`;
  }
}

export function describeExtract(step: Step): string {
  const ex = step.extract;
  if (!ex) return '(no extractor)';
  if (ex.strategy === 'tableCell') {
    return `cell [${ex.rowMatch.columnHeader}=${ex.rowMatch.equalsTemplate ?? ex.rowMatch.containsTemplate}] of column "${ex.columnHeader}"`;
  }
  return `text at ${JSON.stringify(ex.target.primary)}`;
}

export function matchBusinessOutcome(
  artifact: CapabilityArtifact,
  failedStepId: string,
  probe: { pageText?: string; dialogText?: string; url?: string }
): NonNullable<ReplayResult['businessOutcome']> | null {
  for (const bo of artifact.businessOutcomes ?? []) {
    if (bo.detect.duringStepId && bo.detect.duringStepId !== failedStepId) continue;
    // A declared outcome needs a CONCRETE detector — no patternless auto-hit.
    let hit = false;
    if (bo.detect.pageTextContains && probe.pageText?.toLowerCase().includes(bo.detect.pageTextContains.toLowerCase())) hit = true;
    if (bo.detect.dialogTextContains && probe.dialogText?.toLowerCase().includes(bo.detect.dialogTextContains.toLowerCase())) hit = true;
    if (bo.detect.urlGlob && probe.url && globMatch(bo.detect.urlGlob, probe.url)) hit = true;
    if (hit) {
      return { code: bo.code, description: bo.description, returnsToCaller: bo.returnsToCaller };
    }
  }
  return null;
}

export async function locatorText(locator: Locator): Promise<string> {
  return (await locator.innerText({ timeout: 4000 }).catch(() => '')) ?? '';
}










