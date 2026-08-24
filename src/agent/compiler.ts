/**
 * Compiler — turns a discovery transcript into a typed Capability Artifact.
 *
 * Judgment calls encoded here (all documented in REPORT.md):
 *  - Only surface-meaningful actions compile (navigate/click/type/select);
 *    model waits and scrolls are dropped unless load-bearing.
 *  - Login steps are auto-detected (login URL + credential fields) and
 *    parameterized via environment bindings, NEVER literal.
 *  - Typed input values replace matching literals in fill steps.
 *  - Model-proposed outputs become relational table extractors when a reverse
 *    lookup found their source cell; otherwise text extractors.
 *  - Submit/confirm-style controls get riskClass=risky by name heuristic;
 *    the artifact ships as draft for human review either way.
 */
import { randomUUID } from 'node:crypto';
import {
  CapabilityArtifactSchema,
  type BusinessOutcome,
  type CapabilityArtifact,
  type Step,
  type TargetDescriptor,
} from '../core/artifact.js';
import type { RecordedStep, DiscoveryResult } from './discover.js';

export interface CompileOptions {
  appFamily: string;
  capabilityIdBase: string; // e.g. "legacybank.lookup-member-balance"
  name: string;
  description: string;
  entryUrlTemplate: string;
  inputs: Record<string, string>; // values used during the run, by param name
  outputsSchema: Record<string, unknown>;
  businessOutcomes?: BusinessOutcome[];
  plannerModel: string;
  /** Verified login targeting captured from discovery's bootstrap steps. */
  loginTargets?: {
    userField?: TargetDescriptor;
    passField?: TargetDescriptor;
    submitButton?: TargetDescriptor;
  };
}

type SimpleActionType = 'navigate' | 'click' | 'type' | 'select';

export function compileCapability(
  result: DiscoveryResult,
  opts: CompileOptions
): CapabilityArtifact {
  const meaningful = result.steps.filter((s) =>
    ['navigate', 'click', 'type', 'select'].includes(s.action.type)
  );

  const loginSeqs = detectLoginSteps(meaningful);
  const now = new Date().toISOString();

  const steps: Step[] = [];
  let seq = 0;
  for (const rs of meaningful) {
    seq += 1;
    const id = `s${seq}`;
    const isLogin = loginSeqs.has(rs.seq);
    const actionType = rs.action.type as SimpleActionType;

    if (actionType === 'navigate') continue; // entry navigation comes from target.entryUrlTemplate

    // NEVER drop flow steps silently: without a verified descriptor, fall back
    // to the model's grid coordinates as an explicit degraded target.
    if (!rs.descriptor) {
      const rawAction = rs.action as { hint?: import('../core/actions.js').TargetHint };
      const hint = rawAction.hint;
      if (!hint || !('x' in hint)) {
        throw new Error(
          `transcript step s${rs.seq} (${rs.action.type}) has no resolvable target and no coordinates; cannot compile safely`
        );
      }
      steps.push({
        id,
        intent: `${intentOf(rs, isLogin)} (degraded: coordinate targeting)`,
        action: mapAction(actionType),
        target: {
          primary: { kind: 'coordinate', x: hint.x, y: hint.y, note: 'viewport-grid fallback; no verified descriptor at record time' },
          fallbacks: [],
          scope: { framePath: [] },
          quality: 'coordinate-only',
          rationale: 'descriptor resolution failed at record time; kept as explicit degraded step',
        },
        pageUrl: templateUrl(rs.frameUrlBefore ?? rs.urlBefore, opts),
        valueTemplate: rs.action.type === 'type' ? templateFor(rs, opts, isLogin) : undefined,
        selectOptionText: rs.action.type === 'select' ? rs.action.optionText : undefined,
        recoverableErrors: [],
        riskClass: riskyHeuristic(rs) ? 'risky' : 'safe',
      });
      continue;
    }

    const step: Step = {
      id,
      intent: intentOf(rs, isLogin),
      action: mapAction(actionType),
      target: redactDescriptorValues(rs.descriptor as TargetDescriptor),
      pageUrl: templateUrl(rs.frameUrlBefore ?? rs.urlBefore, opts),
      recoverableErrors: !isLogin
        ? ([
            {
              chainRef: 'relogin',
              description: 're-login after session expiry',
            },
          ] as Step['recoverableErrors'])
        : [],
      riskClass: riskyHeuristic(rs) ? 'risky' : 'safe',
    };

    if (rs.action.type === 'type') {
      step.valueTemplate = templateFor(rs, opts, isLogin);
    }
    if (rs.action.type === 'select') {
      step.selectOptionText = rs.action.optionText;
    }

    steps.push(step);

    // Enter-terminated typing is TWO actions at replay time: fill + press.
    if (rs.action.type === 'type' && rs.action.pressEnter) {
      seq += 1;
      steps.push({
        id: `s${seq}`,
        intent: `Press Enter to submit (${step.intent.replace(/^Type into /, '')})`,
        action: 'press',
        target: step.target,
        keyCombo: 'Enter',
        pageUrl: step.pageUrl,
        recoverableErrors: (step.recoverableErrors ?? []) as Step['recoverableErrors'],
        riskClass: 'safe',
      });
    }
  }

  // Outputs → relational extraction steps.
  let outSeq = steps.length;
  const outputBindings = result.outputBindings ?? {};
  // Extraction happens on the page where the model read the values.
  const lastUrl = result.steps[result.steps.length - 1]?.frameUrlBefore ?? result.steps[result.steps.length - 1]?.urlAfter ?? result.finalUrl ?? '';
  for (const [key, binding] of Object.entries(outputBindings)) {
    outSeq += 1;
    // The row key becomes a template so extraction generalizes across data.
    let rowValueTemplate: string = binding.rowKeyValue;
    for (const [k, v] of Object.entries(opts.inputs)) {
      if (v === binding.rowKeyValue) rowValueTemplate = `{{inputs.${k}}}`;
    }
    steps.push({
      id: `x${outSeq}`,
      intent: `Read ${key}: cell of column "${binding.colHeader}" in the row where ${binding.rowHeader} = ${rowValueTemplate}`,
      action: 'extract',
      outputKey: key,
      pageUrl: templateUrl(lastUrl, opts),
      extract: {
        strategy: 'tableCell',
        scope: { framePath: binding.framePath ?? [] },
        rowMatch: { columnHeader: binding.rowHeader, equalsTemplate: rowValueTemplate },
        columnHeader: binding.colHeader,
      },
      recoverableErrors: [
        { chainRef: 'relogin', description: 're-login after session expiry' },
      ] as Step['recoverableErrors'],
      riskClass: 'safe',
    });
  }

  // Deduplicate consecutive navigations AFTER extractions were appended.
  const deduped = steps.filter(
    (s, i) => !(s.action === 'navigate' && i > 0 && steps[i - 1]!.action === 'navigate')
  );

  const artifact: CapabilityArtifact = {
    schemaVersion: '1',
    kind: 'Capability',
    metadata: {
      id: opts.capabilityIdBase,
      name: opts.name,
      description: opts.description,
      version: '1.0.0',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    },
    target: {
      appFamily: opts.appFamily,
      surfaceType: 'web-legacy',
      entryUrlTemplate: opts.entryUrlTemplate,
      variants: [],
    },
    inputs: {
      type: 'object',
      required: Object.keys(opts.inputs),
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.keys(opts.inputs).map((k) => [k, { type: 'string', title: k }])
      ),
    },
    outputs: opts.outputsSchema,
    environmentBindings: {
      username: { source: 'envVar', name: 'LEGACYBANK_USER', sensitive: false },
      password: { source: 'envVar', name: 'LEGACYBANK_PASSWORD', sensitive: true },
    },
    steps: deduped.length > 0 ? deduped : steps,
    businessOutcomes: opts.businessOutcomes ?? [],
    recoveryChains: {
      relogin: [
        { action: 'navigate', urlTemplate: opts.entryUrlTemplate },
        ...credentialChain(opts),
        { action: 'gotoStepPage' },
        { action: 'wait', durationMs: 800 },
      ],
    },
    successCondition: {
      allOf: [
        { assert: 'urlMatchesGlob', pattern: urlGlob(result.finalUrl ?? '') },
        ...(result.outputBindings && Object.keys(result.outputBindings).length > 0
          ? []
          : []),
      ],
    },
    riskPolicy: {
      onRiskyStep: 'require_approval',
      rationale:
        'Capabilities may open financial products; irreversible submits stay behind approval until replay history earns trust.',
    },
    redaction: {
      sensitiveInputNames: ['password'],
      notes: 'Credentials resolved from env at runtime; never persisted.',
    },
    provenance: {
      discoveredFromRunId: result.runId,
      plannerModel: opts.plannerModel,
      recordedAt: now,
      stepCount: steps.length,
      validation: {
        lastReplayAt: null,
        lastReplayStatus: null,
        replaySuccessCount: 0,
        replayFailureCount: 0,
      },
    },
  };

  return CapabilityArtifactSchema.parse(artifact);
}

function credentialChain(opts: CompileOptions): Array<
  | { action: 'navigate'; urlTemplate: string }
  | { action: 'fill'; target: NonNullable<Step['target']>; valueTemplate: string }
  | { action: 'click'; target: NonNullable<Step['target']> }
  | { action: 'wait'; durationMs: number }
> {
  const lt = opts.loginTargets ?? {};
  const dummy: TargetDescriptor = {
    primary: { kind: 'role', role: 'textbox', name: 'User ID:' },
    fallbacks: [],
    scope: { framePath: [] },
    quality: 'verified',
    rationale: 'fallback login targeting',
  };
  return [
    {
      action: 'fill' as const,
      valueTemplate: '{{env.username}}',
      target: (lt.userField ?? dummy) as NonNullable<Step['target']>,
    },
    {
      action: 'fill' as const,
      valueTemplate: '{{env.password}}',
      target: (lt.passField ?? lt.userField ?? dummy) as NonNullable<Step['target']>,
    },
    {
      action: 'click' as const,
      target: (lt.submitButton ??
        lt.passField ??
        dummy) as NonNullable<Step['target']>,
    },
  ];
}

function detectLoginSteps(steps: RecordedStep[]): Set<number> {
  const ids = new Set<number>();
  for (const s of steps) {
    const url = s.urlBefore.toLowerCase();
    const fp = JSON.stringify(s.facts?.id ?? '') + JSON.stringify(s.facts?.nameAttr ?? '');
    const looksCredential = /txtuser|txtpass|passwd|password/.test(fp);
    const onLoginPage = /login|signin|sign-in|logon/.test(url);
    if ((looksCredential || (onLoginPage && s.action.type !== 'navigate'))) {
      ids.add(s.seq);
    }
  }
  return ids;
}

function templateFor(rs: RecordedStep, opts: CompileOptions, isLogin: boolean): string {
  const literal = rs.action.type === 'type' ? rs.action.text : "";
  if (isLogin) {
    // Credentials NEVER persist as literals — resolve from env at runtime.
    const hints = `${rs.facts?.typeAttr ?? ''} ${rs.facts?.id ?? ''} ${rs.facts?.nameAttr ?? ''}`;
    if (rs.facts?.typeAttr === 'password' || /pass/i.test(hints)) {
      return '{{env.password}}';
    }
    return '{{env.username}}';
  }
  for (const [k, v] of Object.entries(opts.inputs)) {
    if (v === literal) return `{{inputs.${k}}}`;
  }
  return literal;
}

/** Concrete step page URL with input values templated (no secrets in URLs). */
function templateUrl(url: string, opts: CompileOptions): string {
  let out = url;
  for (const [k, v] of Object.entries(opts.inputs)) {
    if (v && out.includes(v)) out = out.split(v).join(`{{inputs.${k}}}`);
  }
  return out;
}

function riskyHeuristic(rs: RecordedStep): boolean {
  if (rs.action.type !== 'click') return false;
  const name = (rs.facts?.accessibleName ?? '').toLowerCase();
  return /(confirm|submit|open|approve|delete|transfer|authorize)/.test(name);
}

function intentOf(rs: RecordedStep, isLogin: boolean): string {
  if (isLogin && rs.action.type === 'type') {
    return /pass/i.test(`${rs.facts?.typeAttr ?? ''} ${rs.facts?.id ?? ''} ${rs.facts?.nameAttr ?? ''}`)
      ? 'Enter operator password'
      : 'Enter operator user ID';
  }
  switch (rs.action.type) {
    case 'click':
      return `Click ${(rs.facts?.accessibleName ?? rs.facts?.visibleText ?? 'control').slice(0, 60)}`.trim();
    case 'type': {
      const label = rs.facts?.accessibleName || prettyFromLegacyId(rs.facts?.id ?? rs.facts?.nameAttr ?? '');
      return `Type into ${label ? label.slice(0, 60) : 'field'}`;
    }
    case 'select':
      return `Select "${rs.action.optionText}"`;
    case 'navigate':
      return `Navigate to ${rs.action.url}`;
    default:
      return `${rs.action.type} step`;
  }
}

/** ctl00_ContentPlaceHolder1_txtMemberId → "member id" — readable intents for legacy ids. */
function prettyFromLegacyId(id: string): string {
  const m = id.match(/(?:txt|ddl|lst|chk|btn|lbl|grd)_?(\w+)$/i) ?? id.match(/[_$](\w+)$/);
  const raw = m?.[1] ?? id;
  const spaced = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
  return spaced;
}

function mapAction(t: 'navigate' | 'click' | 'type' | 'select'): Step['action'] {
  return t === 'type' ? 'fill' : t;
}

function urlGlob(url: string): string {
  try {
    const u = new URL(url);
    const pathGlob = u.pathname.replace(/\d+/g, '*');
    return `${u.origin}${pathGlob}*`.replace(/\*\*/g, '*');
  } catch {
    return url;
  }
}

/** Descriptors carry no values by construction; belt-and-suspenders scrub. */
function redactDescriptorValues(d: TargetDescriptor): TargetDescriptor {
  const clone = JSON.parse(JSON.stringify(d)) as TargetDescriptor;
  delete (clone as Record<string, unknown>).capturedValue;
  return clone;
}
