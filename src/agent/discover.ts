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
  summary?: string;
  proposedOutputs?: Record<string, string>;
  /** Reverse-looked-up relational bindings for outputs found in data tables. */
  outputBindings?: Record<string, { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[] }>;
  finalUrl?: string;
}

export interface DiscoveryOptions {
  maxSteps: number;
  headed: boolean;
  viewport: { width: number; height: number };
  runsDir: string;
  /** Effective secret values used this run — registered for sink redaction. */
  secrets?: string[];
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
    observation = await this.observe();
    let endState: DiscoveryEndState = 'MAX_STEPS';
    let summary: string | undefined;
    let proposedOutputs: Record<string, string> | undefined;
    let outputBindings: Record<string, { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[] }> | undefined;

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
      summary,
      proposedOutputs,
      ...(outputBindings ? { outputBindings } : {}),
      finalUrl: this.lastUrl,
    };
  }

  private lastUrl = '';

  /** For each proposed output, find the data-table cell it came from so the
   *  compiler can emit a relational extractor instead of a brittle literal.
   *  The matching frame path travels with the binding — extraction must run
   *  where the table actually lives (legacy framesets). */
  private async lookupOutputBindings(
    obs: Observation,
    outputs: Record<string, string>
  ): Promise<Record<string, { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[] }>> {
    const framePaths = [...new Set(Object.values(obs.refIndex).map((r) => r.framePath.join('>')))]
      .map((s) => (s === '' ? [] : s.split('>')))
      .filter((p) => p.length <= 2);
    const candidates = [[], ...framePaths];
    const out: Record<string, { rowHeader: string; rowKeyValue: string; colHeader: string; framePath: string[] }> = {};
    for (const [key, value] of Object.entries(outputs)) {
      for (const fp of candidates) {
        const hit = await this.driver.findTableCellForValue(fp, value).catch(() => null);
        if (hit) {
          out[key] = { ...hit, framePath: fp };
          break;
        }
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

