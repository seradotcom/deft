/**
 * Replay support: run context, variant overlays, input validation, checks,
 * relational extraction, and the failure/outcome classification helpers.
 */
import type { Locator, Page } from 'playwright';
import {
  type CapabilityArtifact,
  type Check,
  type ReplayResult,
  type Step,
  type StepTimelineEntry,
} from '../core/artifact.js';
import { PlaywrightWebDriver } from '../surface/driver.js';
import { interpolate, resolveDescriptor } from '../surface/targeting.js';
import { defaultPolicy, PolicyEngine } from '../safety/policy.js';
import { EvidenceLogger } from '../evidence/logger.js';

export interface ReplayOptions {
  tenantId?: string;
  env: Record<string, string>;
  inputs: Record<string, unknown>;
  headless?: boolean;
  allowRisky?: boolean;
  runsDir?: string;
  /** Human-in-the-loop: called when a step can't be completed safely. */
  onEscalation?: (info: { reason: string }) => Promise<boolean>;
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
  escalation?: {
    interventionId: string;
    reason: string;
    resumedByHuman: boolean;
    humanActionsObserved: number;
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

/** Tenant overlay: flat-key JSON patches applied to a deep clone.
 *  Bracket keys reference steps by ID ("steps[s10].target.primary.name"),
 *  not by array index — ids are stable, positions are not. */
export function applyVariant(artifact: CapabilityArtifact, tenantId?: string): CapabilityArtifact {
  if (!tenantId) return artifact;
  const variant = artifact.target.variants?.find((v) => v.match.tenantId === tenantId);
  if (!variant) return artifact;
  const clone = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
  const steps = clone.steps as Array<{ id: string }>;
  for (const [flatKey, value] of Object.entries(variant.patches)) {
    const resolved = flatKey.replace(/^steps\[([^\]]+)\]/, (_m, stepId: string) => {
      const idx = steps.findIndex((s) => s.id === stepId);
      return `steps.${idx >= 0 ? idx : stepId}`;
    });
    setFlatPath(clone, resolved, value);
  }
  return clone as unknown as CapabilityArtifact;
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

const INPUT_SCHEMA = {
  props(k: string, schema: unknown): { type?: string; pattern?: string } | undefined {
    void k;
    const s = schema as { properties?: Record<string, { type?: string; pattern?: string }> };
    return s?.properties?.[k];
  },
};

export function validateInputs(artifact: CapabilityArtifact, inputs: Record<string, unknown>): void {
  const schema = artifact.inputs as {
    required?: string[];
    properties?: Record<string, { type?: string; pattern?: string }>;
  };
  const missing = (schema.required ?? []).filter((k) => inputs[k] === undefined);
  if (missing.length > 0) throw new Error(`missing required input(s): ${missing.join(', ')}`);
  for (const [k, prop] of Object.entries(schema.properties ?? {})) {
    const v = inputs[k];
    if (v === undefined) continue;
    if (prop.type === 'string' && typeof v !== 'string') {
      throw new Error(`input "${k}" must be a string`);
    }
    if (prop.pattern && typeof v === 'string' && !new RegExp(prop.pattern).test(v)) {
      throw new Error(`input "${k}" does not match pattern ${prop.pattern}`);
    }
  }
}
void INPUT_SCHEMA;

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
    if (check.assert === 'urlMatchesGlob') {
      // Frameset apps: the TOP url never changes — match any frame's URL too.
      const pattern = interpolate(check.pattern, c);
      if (globMatch(pattern, page.url())) return true;
      return page.frames().some((f) => globMatch(pattern, f.url()));
    }
    if (check.assert === 'pageTextContains') {
      // Frameset-aware: aggregate visible text across all frames.
      let hay = '';
      for (const f of page.frames()) {
        const t = await f.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        if (t) hay += t + '\n';
      }
      return hay.toLowerCase().includes(check.text.toLowerCase());
    }
    const res = await resolveDescriptor(page, check.target, { timeoutMs: check.timeoutMs ?? 8000 });
    if (!res.locator) return false;
    if (check.assert === 'elementVisible') return res.locator.isVisible();
    if (check.assert === 'elementTextContains') {
      const text = await res.locator.innerText({ timeout: check.timeoutMs ?? 8000 });
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
    for (const row of rows.slice(1)) {
      const cells = Array.from(row.querySelectorAll('td'));
      const keyCell = cells[rowIdx];
      if (keyCell && norm(keyCell.textContent || '') === norm(q.rowValue)) {
        return cells[colIdx]?.textContent?.trim() ?? null;
      }
    }
  }
  return null;
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

  if (ex.strategy === 'tableCell') {
    let frame = page.mainFrame();
    for (const name of ex.scope.framePath ?? []) {
      const next = frame.childFrames().find((f) => f.name() === name || f.url() === name);
      if (!next) break;
      frame = next;
    }
    try {
      const tableCount = await frame.evaluate('document.querySelectorAll("table").length');
      ctx.evidence.write({ type: 'extract_debug', stepId: step.id, frameUrl: frame.url(), tableCount });
      return (
        (await frame.evaluate(tableCellQueryFn as never, {
          rowHeader: ex.rowMatch.columnHeader,
          rowValue: interpolate(ex.rowMatch.equalsTemplate ?? ex.rowMatch.containsTemplate ?? '', c),
          colHeader: ex.columnHeader,
        } as never)) ?? null
      );
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
  const raw = await res.locator.innerText({ timeout: 5000 }).catch(() => null);
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
    '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::').replace(/\*/g, '[^/]*').replace(/::/g, '.*') + '$'
  );
  return re.test(url);
}

export function errorClassOf(err: unknown): string {
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
    let hit = !(
      bo.detect.pageTextContains ||
      bo.detect.dialogTextContains ||
      bo.detect.urlGlob
    );
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
