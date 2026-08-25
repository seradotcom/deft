/**
 * Discovery loop — the ONE place where the model is in the loop.
 *
 * observe → plan → policy-check → resolve target (verified, live) → act → record.
 * Everything needed to compile a capability is captured here: actions, verified
 * descriptors, outcomes, surface events, screenshots. Evidence is written as
 * we go so even a crashed run leaves a complete forensic trail.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentAction, ElementFacts, Observation } from '../core/actions.js';
import type { TargetDescriptor } from '../core/artifact.js';
import { PlaywrightWebDriver } from '../surface/driver.js';
import { buildTargetDescriptor } from '../surface/targeting.js';
import { PolicyEngine } from '../safety/policy.js';
import { classifyTargetRisk } from '../safety/risk.js';
import { EvidenceLogger } from '../evidence/logger.js';
import { observationParts, type GeminiContent } from '../llm/gemini.js';
import type { Planner } from './planner.js';

export interface DiscoveryGoal {
  goal: string;
  baseUrl: string;
  entryUrl: string;
}

export interface RecordedStep {
  seq: number;
  ts: string;
  action: AgentAction;
  facts?: ElementFacts;
  descriptor?: TargetDescriptor;
  ok: boolean;
  errorClass?: string;
  urlBefore: string;
  urlAfter: string;
  /** URL of the FRAME the step executed in (frameset apps: top never changes). */
  frameUrlBefore?: string;
  shotBefore?: string;
  shotAfter?: string;
  dialogEvents: string[];
}

export type DiscoveryEndState =
  | 'DONE'
  | 'MAX_STEPS'
  | 'DEAD_END_DECLARED'
  | 'ASKED_HUMAN'
  | 'POLICY_LOOP';

export interface DiscoveryResult {
  runId: string;
  endState: DiscoveryEndState;
  steps: RecordedStep[];
  /** Deterministic authentication steps — engine-executed, never model-seen. */
  authSteps?: RecordedStep[];
  summary?: string;
  proposedOutputs?: Record<string, string>;
  /** Reverse-looked-up relational bindings for outputs found in data tables. */
  outputBindings?: Record<
    string,
    { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[]; frameUrl: string }
  >;
  finalUrl?: string;
}

/** Deterministic pre-authentication — environment plumbing, NOT capability
 *  discovery. Credentials are resolved from env bindings by the engine and
 *  NEVER enter model context: the planner's first observation is the
 *  already-authenticated surface. Selectors identify login controls on the
 *  entry page; descriptors are captured with the same verified machinery. */
export interface AuthConfig {
  userSelector: string;
  passSelector: string;
  submitSelector: string;
  username: string;
  password: string;
}

export interface DiscoveryOptions {
  maxSteps: number;
  headed: boolean;
  viewport: { width: number; height: number };
  runsDir: string;
  /** Effective secret values used this run — registered for sink redaction. */
  secrets?: string[];
  auth?: AuthConfig;
  /** Called when automation cannot safely continue. Return true after human fixed state. */
  onEscalation?: (info: { reason: string; observation: Observation }) => Promise<boolean>;
}

export class DiscoveryRun {
  private driver!: PlaywrightWebDriver;
  private evidence!: EvidenceLogger;
  private history: GeminiContent[] = [];
  private steps: RecordedStep[] = [];
  private blockedCount = 0;

  constructor(
    private readonly goalSpec: DiscoveryGoal,
    private readonly planner: Planner,
    private readonly policy: PolicyEngine,
    private readonly opts: DiscoveryOptions
  ) {}

  async run(): Promise<DiscoveryResult> {
    this.driver = new PlaywrightWebDriver({ headless: !this.opts.headed, viewport: this.opts.viewport });
    await this.driver.start();
    this.evidence = new EvidenceLogger(this.opts.runsDir, 'discovery', 'goal redacted');
    this.evidence.registerSecrets([
      process.env.LEGACYBANK_PASSWORD,
      process.env.LEGACYBANK_USER,
      ...(this.opts.secrets ?? []),
    ]);

    let observation: Observation;
    // Land on the entry surface BEFORE the first decision (through the policy gate).
    if (!this.policy.isUrlAllowed(this.goalSpec.entryUrl)) {
      throw new Error(`entry URL outside policy: ${this.goalSpec.entryUrl}`);
    }
    await this.driver.act({ type: 'navigate', url: this.goalSpec.entryUrl });
    await this.driver.waitForLoadStateSettle();

    // Deterministic pre-authentication — the planner NEVER sees credentials.
    // Values are templated to env bindings at record time; the model's first
    // observation is the already-authenticated surface.
    const authSteps = await this.performDeterministicAuth();

    observation = await this.observe();
    let endState: DiscoveryEndState = 'MAX_STEPS';
    let summary: string | undefined;
    let proposedOutputs: Record<string, string> | undefined;
    let outputBindings: Record<string, { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[]; frameUrl: string }> | undefined;

    try {
      for (let i = 0; i < this.opts.maxSteps; i++) {
        const { decision, assistantParts, usage } = await this.planner.decide({
          goal: this.goalSpec.goal,
          observation,
          history: this.history,
          stepsUsed: i,
          maxSteps: this.opts.maxSteps,
        });
        this.history.push({ role: 'user', parts: observationParts(this.goalSpec.goal, observation) });
        this.history.push({ role: 'model', parts: assistantParts });
        if (usage) this.evidence.write({ type: 'llm_usage', promptTokens: usage.promptTokens });

        const action = decision.action;
        this.evidence.write({ type: 'decision', step: i + 1, call: decision.rawCallName, action });

        // Terminal decisions -------------------------------------------------
        if (action.type === 'done') {
          endState = 'DONE';
          summary = action.summary;
          proposedOutputs = action.outputs;
          outputBindings = await this.lookupOutputBindings(observation, action.outputs);
          break;
        }
        if (action.type === 'fail') {
          endState = 'DEAD_END_DECLARED';
          summary = action.reason;
          break;
        }
        if (action.type === 'ask_human') {
          const resumed = (await this.opts.onEscalation?.({
            reason: `agent requested help: ${action.question}`,
            observation,
          })) ?? false;
          if (!resumed) {
            endState = 'ASKED_HUMAN';
            summary = action.question;
            break;
          }
          observation = await this.observe();
          continue;
        }

        // Policy gate ----------------------------------------------------------
        const verdict = this.policy.checkAction(action, this.driver.currentUrl());
        if (!verdict.allowed) {
          this.blockedCount += 1;
          this.evidence.write({ type: 'policy_blocked', step: i + 1, reason: verdict.reason });
          this.history.push({
            role: 'user',
            parts: [{ text: `SYSTEM: last action was BLOCKED by policy (${verdict.reason}). Choose a different action within the allowed site.` }],
          });
          if (this.blockedCount >= 3) {
            endState = 'POLICY_LOOP';
            summary = 'agent kept proposing out-of-policy actions';
            break;
          }
          continue;
        }

        // Verified targeting capture (before acting!) --------------------------
        const shotBefore = await this.evidence.saveShot(observation.screenshotBase64, `${i + 1}-before`);
        let facts: ElementFacts | undefined;
        let descriptor: TargetDescriptor | undefined;
        if ((action.type === 'click' || action.type === 'type' || action.type === 'select') && action.hint) {
          const hint = action.hint;
          const resolveFacts = (): Promise<ElementFacts | null> =>
            'elementRef' in hint
              ? this.driver.factsForRef(hint.elementRef)
              : 'px' in hint
                ? Promise.resolve(null)
                : this.driver.factsAtGridPoint(hint.x, hint.y);
          let f = await resolveFacts();
          if (!f) {
            // Mid-load frames can detach refs — re-observe once and retry.
            observation = await this.observe();
            await this.driver.waitForLoadStateSettle();
            f = await resolveFacts();
          }
          if (f) {
            facts = f;
            descriptor = await buildTargetDescriptor(this.driver, f, this.opts.viewport);
            this.evidence.write({
              type: 'targeting_verified',
              step: i + 1,
              quality: descriptor.quality,
              primary: descriptor.primary,
            });

            // Deterministic risk classification — OUTSIDE the LLM. The model
            // proposes; this gate decides. Risky targets never execute during
            // discovery: the operator decides via escalation, or the model is
            // told to choose another path.
            const risk = classifyTargetRisk(f);
            if (risk && (action.type === 'click' || action.type === 'select')) {
              this.evidence.write({ type: 'policy_blocked_risky', step: i + 1, matched: risk, target: facts.accessibleName ?? facts.visibleText });
              this.blockedCount += 1;
              const approved = (await this.opts.onEscalation?.({
                reason: `discovery action blocked: target "${facts.accessibleName ?? facts.visibleText}" matches risky verb "${risk}"`,
                observation,
              })) ?? false;
              if (approved) {
                this.evidence.write({ type: 'risky_approved_by_operator', step: i + 1 });
              } else {
                this.history.push({
                  role: 'user',
                  parts: [{ text: `SYSTEM: that action was BLOCKED by policy — "${facts.accessibleName ?? facts.visibleText}" looks like an irreversible/risky control ("${risk}"). It requires a human operator. Do NOT attempt it again; if the goal truly requires it, call ask_human.` }],
                });
                if (this.blockedCount >= 3) {
                  endState = 'POLICY_LOOP';
                  summary = 'agent kept proposing risky/out-of-policy actions';
                  break;
                }
                continue;
              }
            }
          }
        }

        // Act ------------------------------------------------------------------
        const outcome = await this.driver.act(action);
        await this.driver.waitForLoadStateSettle();
        const urlAfter = this.driver.currentUrl();
        const obsAfter = await this.observe();
        const shotAfter = await this.evidence.saveShot(obsAfter.screenshotBase64, `${i + 1}-after`);
        const dialogs = outcome.events.filter((e) => e.kind === 'dialog').map((e) => e.detail);

        // The executing frame's URL (frameset apps: top URL never changes).
        let frameUrlBefore: string | undefined;
        const fp = descriptor?.scope.framePath ?? [];
        if (fp.length > 0) {
          const leaf = fp[fp.length - 1]!;
          frameUrlBefore = observation.frames.find((f) => f.name === leaf || f.url === leaf)?.url;
        } else {
          frameUrlBefore = observation.url;
        }

        this.steps.push({
          seq: this.steps.length + 1,
          ts: new Date().toISOString(),
          action,
          ...(facts ? { facts } : {}),
          ...(descriptor ? { descriptor } : {}),
          ok: outcome.ok,
          errorClass: outcome.errorClass,
          urlBefore: observation.url,
          urlAfter,
          ...(frameUrlBefore ? { frameUrlBefore } : {}),
          shotBefore,
          shotAfter,
          dialogEvents: dialogs,
        });
        this.evidence.write({
          type: 'action_result',
          step: i + 1,
          ok: outcome.ok,
          errorClass: outcome.errorClass,
          events: outcome.events,
          shots: [shotBefore, shotAfter],
        });

        observation = obsAfter;

        if (!outcome.ok && outcome.errorClass === 'SESSION_DEAD') break;

        // Feed execution result back so the model can react.
        this.history.push({
          role: 'user',
          parts: [
            {
              text: outcome.ok
                ? `OK — action executed. Screen updated below.`
                : `ACTION FAILED (${outcome.errorClass}): ${outcome.message}. Observe the current screen and choose differently.`,
            },
          ],
        });
      }
    } finally {
      // Persist the full transcript: evidence for the run AND a recompilable
      // artifact source (compile decisions can be revisited without re-running).
      // Scrubbed with the same sink redaction as the log.
      try {
        const scrubbed = JSON.parse(this.evidence.scrub(JSON.stringify({ goal: 'redacted', endState, steps: this.steps, summary, proposedOutputs, outputBindings })));
        fs.writeFileSync(
          path.join(this.evidence.dir, 'transcript.json'),
          JSON.stringify(scrubbed, null, 2)
        );
      } catch { /* best effort */ }
      await this.driver.close().catch(() => undefined);
      this.evidence.write({ type: 'run_end', endState, steps: this.steps.length, summary });
    }

    return {
      runId: this.evidence.runId,
      endState,
      steps: this.steps,
      ...(authSteps ? { authSteps } : {}),
      summary,
      proposedOutputs,
      ...(outputBindings ? { outputBindings } : {}),
      finalUrl: this.lastUrl,
    };
  }

  private lastUrl = '';

  /**
   * Deterministic login executed by the ENGINE. Credentials resolve from env
   * bindings and are immediately templated — they exist only inside this
   * method's scope and the driver's input events, never in model context,
   * transcript, or evidence (sink redaction is the last line of defense).
   * Targeting descriptors are captured with the same verified machinery so
   * replay's authPhase is proven, not guessed.
   */
  private async performDeterministicAuth(): Promise<RecordedStep[] | null> {
    const auth = this.opts.auth;
    if (!auth) return null;
    const seq0 = 0;
    const out: RecordedStep[] = [];
    let n = seq0;

    const fillField = async (selector: string, envTemplate: string, intent: string): Promise<void> => {
      const loc = this.driver.page.locator(selector).first();
      await loc.waitFor({ state: 'visible', timeout: 10000 });
      const box = await loc.boundingBox();
      if (!box) throw new Error(`auth selector not visible: ${selector}`);
      const gx = Math.round((((box.x + box.width / 2) / this.opts.viewport.width) * 999));
      const gy = Math.round((((box.y + box.height / 2) / this.opts.viewport.height) * 999));
      const facts = await this.driver.factsAtGridPoint(gx, gy);
      if (!facts) throw new Error(`no facts for auth selector: ${selector}`);
      const descriptor = await buildTargetDescriptor(this.driver, facts, this.opts.viewport);
      n += 1;
      out.push({
        seq: n,
        ts: new Date().toISOString(),
        action: { type: 'type', text: envTemplate, hint: { x: gx, y: gy } },
        facts,
        descriptor,
        ok: true,
        urlBefore: this.driver.currentUrl(),
        urlAfter: this.driver.currentUrl(),
        dialogEvents: [],
      });
      await loc.fill(envTemplate === '{{env.username}}' ? auth.username : auth.password);
      this.evidence.write({ type: 'auth_step', intent, descriptor: descriptor.primary });
    };

    await fillField(auth.userSelector, '{{env.username}}', 'Enter operator user ID');
    await fillField(auth.passSelector, '{{env.password}}', 'Enter operator password');

    // Submit and wait for the authenticated shell.
    const submit = this.driver.page.locator(auth.submitSelector).first();
    await submit.waitFor({ state: 'visible', timeout: 10000 });
    const sbox = await submit.boundingBox();
    if (!sbox) throw new Error('auth submit not visible');
    const facts = await this.driver.factsAtGridPoint(
      Math.round((((sbox.x + sbox.width / 2) / this.opts.viewport.width) * 999)),
      Math.round((((sbox.y + sbox.height / 2) / this.opts.viewport.height) * 999))
    );
    if (!facts) throw new Error('no facts for auth submit');
    const descriptor = await buildTargetDescriptor(this.driver, facts, this.opts.viewport);
    n += 1;
    out.push({
      seq: n,
      ts: new Date().toISOString(),
      action: { type: 'click', hint: { x: Math.round((((sbox.x + sbox.width / 2) / this.opts.viewport.width) * 999)), y: Math.round((((sbox.y + sbox.height / 2) / this.opts.viewport.height) * 999)) } },
      facts,
      descriptor,
      ok: true,
      urlBefore: this.driver.currentUrl(),
      urlAfter: this.driver.currentUrl(),
      dialogEvents: [],
    });
    this.evidence.write({ type: 'auth_step', intent: 'Submit credentials (engine-side)' });
    await submit.click();
    for (let i = 0; i < 50 && !this.driver.page.frame({ name: 'content' }); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.driver.waitForLoadStateSettle();
    this.evidence.write({ type: 'auth_complete', steps: out.length });
    return out;
  }

  /** For each proposed output, find the data-table cell it came from so the
   *  compiler can emit a relational extractor instead of a brittle literal.
   *  The matching frame path travels with the binding — extraction must run
   *  where the table actually lives (legacy framesets). */
  private async lookupOutputBindings(
    obs: Observation,
    outputs: Record<string, string>
  ): Promise<
    Record<string, { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[]; frameUrl: string }>
  > {
    const framePaths = [...new Set(Object.values(obs.refIndex).map((r) => r.framePath.join('>')))]
      .map((s) => (s === '' ? [] : s.split('>')))
      .filter((p) => p.length <= 2);
    const candidates = [[], ...framePaths];
    const out: Record<
      string,
      { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[]; frameUrl: string }
    > = {};
    for (const [key, value] of Object.entries(outputs)) {
      for (const fp of candidates) {
        const hit = await this.driver.findTableCellForValue(fp, value).catch(() => null);
        if (!hit) continue;
        // Banking rule: an extraction identity that matches multiple rows is
        // NOT a safe binding. Fail discovery loudly — the operator must scope
        // the output (or the fixture must be unambiguous), never "first match".
        if ('ambiguous' in hit) {
          throw new Error(
            `ambiguous extraction binding for "${key}": value "${value}" matches ${hit.matchCount} rows — row identity is not unique`
          );
        }
        const leaf = fp[fp.length - 1]!;
        const frameUrl = obs.frames.find((f) => f.name === leaf)?.url ?? obs.url;
        out[key] = { ...hit, framePath: fp, frameUrl };
        break;
      }
    }
    return out;
  }

  private async observe(): Promise<Observation> {
    const o = await this.driver.observe();
    this.lastUrl = o.url;
    return o;
  }
}




