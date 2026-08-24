/**
 * Planner — turns (goal + observation) into AgentActions via an LLM.
 *
 * HybridVisionPlanner (default): the model sees BOTH the screenshot and the
 * annotated accessibility outline, and may target by pixel (works on any
 * surface) or by element ref (precise when semantics exist). This is the
 * pragmatic middle of "computer use": it degrades to pure vision only when
 * semantics are absent — exactly the legacy-app reality.
 */
import type { AgentAction } from '../core/actions.js';
import type { Observation } from '../core/actions.js';
import { GeminiClient, observationParts, pruneHistory, type GeminiContent } from '../llm/gemini.js';

/** Action space declared to the model as Gemini function declarations. */
export const ACTION_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'navigate',
    description: 'Open a URL known to exist on the institution site (from links you saw).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'absolute or relative URL' } },
      required: ['url'],
    },
  },
  {
    name: 'click',
    description: 'Click a control. Prefer ref; use x/y only without a usable ref.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'element ref like e7 from the outline' },
        x: { type: 'integer', description: '0-999 grid' },
        y: { type: 'integer', description: '0-999 grid' },
        why: { type: 'string' },
      },
    },
  },
  {
    name: 'type',
    description: 'Focus a field and type text. Set pressEnter only to submit a form.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        ref: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        press_enter: { type: 'boolean', description: 'press Enter after typing (form submit)' },
        why: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option of a dropdown/combobox.',
    parameters: {
      type: 'object',
      properties: {
        option: { type: 'string', description: 'visible option label' },
        ref: { type: 'string' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        why: { type: 'string' },
      },
      required: ['option'],
    },
  },
  {
    name: 'scroll',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        magnitude: { type: 'integer', description: '0-999 grid units, default 400' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'wait',
    description: 'Wait briefly when the page is clearly loading.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'done',
    description: 'Goal fully satisfied. Report extracted values in outputs.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        outputs: {
          type: 'object',
          description:
            'Extracted values keyed by logical name, e.g. {"savingsBalance": "$2,450.75"}. All values are strings.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'fail',
    description: 'Dead end: goal cannot be achieved from here.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'ask_human',
    description: 'Request a human operator for this live session.',
    parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
];

const SYSTEM = `You are the decision core of a UI automation agent operating a bank employee's back-office web application.
You act like a careful human operator: observe the screen, then choose ONE action that makes progress toward the GOAL.

Targeting rules:
- Prefer element refs ([eN] from the accessibility outline) — precise and robust.
- Use pixel coordinates ONLY for things without a usable ref. Coordinates use a 0-999 grid over the screenshot (x: 0=left 999=right, y: 0=top 999=bottom).
- Type actions: give the field hint; set pressEnter only if submitting the form is clearly the next step.

Safety rules:
- Stay strictly on the institution's site shown in the URL. Never invent URLs.
- If a screen asks for irreversible confirmation of financial changes, prefer ask_human unless the goal explicitly includes completing it.
- If you are stuck (no path forward), call fail with the reason. If the goal is already satisfied, call done with the outputs extracted from the screen.

Output discipline: exactly one function call per turn.`;

export interface PlannerDecision {
  action: AgentAction;
  rawCallName: string;
}

export interface PlannerInput {
  goal: string;
  observation: Observation;
  history: GeminiContent[];
  stepsUsed: number;
  maxSteps: number;
  feedback?: string;
}

export interface PlannerOutput {
  decision: PlannerDecision;
  assistantParts: import('../llm/gemini.js').GeminiPart[];
  usage?: { promptTokens?: number };
}

export interface Planner {
  decide(input: PlannerInput): Promise<PlannerOutput>;
}

export class HybridVisionPlanner implements Planner {
  private client: GeminiClient;

  constructor(apiKey: string, model: string) {
    this.client = new GeminiClient(apiKey, model);
  }

  async decide(input: PlannerInput): Promise<PlannerOutput> {
    const budgetNote = input.feedback
      ? `\n\nSYSTEM FEEDBACK (previous action): ${input.feedback}`
      : '';
    const turn: GeminiContent = {
      role: 'user',
      parts: [
        ...observationParts(
          `${input.goal} (step ${input.stepsUsed + 1}/${input.maxSteps})`,
          input.observation,
          budgetNote
        ),
      ],
    };
    const contents = pruneHistory([...input.history, turn], 3);
    const { parts, usage } = await this.client.generate(contents, {
      system: SYSTEM,
      tools: [{ functionDeclarations: ACTION_DECLARATIONS }],
    });

    const call = parts.find((p) => p.functionCall)?.functionCall;
    if (!call) {
      // Model replied with prose instead of acting — nudge it once.
      return {
        decision: { action: { type: 'wait', ms: 500, why: 'no actionable call' }, rawCallName: '(none)' },
        assistantParts: parts,
        usage,
      };
    }
    const args = call.args ?? {};
    const hint = buildHint(args);
    const action = mapCall(call.name, args, hint);
    return { decision: { action, rawCallName: call.name }, assistantParts: parts, usage };
  }
}

function buildHint(args: Record<string, unknown>): { x?: number; y?: number; ref?: string } | undefined {
  const ref = typeof args.ref === 'string' ? args.ref : undefined;
  const x = typeof args.x === 'number' ? args.x : undefined;
  const y = typeof args.y === 'number' ? args.y : undefined;
  if (ref) return { ref };
  if (x !== undefined && y !== undefined) return { x, y };
  return undefined;
}

function mapCall(
  name: string,
  args: Record<string, unknown>,
  hint: { x?: number; y?: number; ref?: string } | undefined
): AgentAction {
  switch (name) {
    case 'navigate':
      return { type: 'navigate', url: String(args.url ?? ''), why: str(args.why) };
    case 'click_at':
    case 'click':
      return hint?.ref
        ? { type: 'click', hint: { elementRef: hint.ref }, why: str(args.why) }
        : { type: 'click', hint: { x: hint?.x ?? 499, y: hint?.y ?? 499 }, why: str(args.why) };
    case 'type_at':
    case 'type_text_at':
    case 'type':
      return {
        type: 'type',
        text: String(args.text ?? ''),
        pressEnter: Boolean(args.press_enter ?? args.pressEnter ?? false),
        clearBeforeTyping: true,
        ...(hint?.ref ? { hint: { elementRef: hint.ref } } : hint ? { hint: { x: hint.x!, y: hint.y! } } : {}),
        why: str(args.why),
      };
    case 'select_option':
    case 'select':
      if (hint?.ref) return { type: 'select', optionText: String(args.option ?? args.text ?? ''), hint: { elementRef: hint.ref }, why: str(args.why) };
      return { type: 'select', optionText: String(args.option ?? args.text ?? ''), why: str(args.why) };
    case 'scroll':
      return {
        type: 'scroll',
        direction: args.direction === 'up' ? 'up' : 'down',
        magnitude: typeof args.magnitude === 'number' ? args.magnitude : 400,
      };
    case 'key':
      return { type: 'key', combo: String(args.combo ?? 'Enter'), why: str(args.why) };
    case 'wait_5_seconds':
    case 'wait':
      return { type: 'wait', ms: 1000, why: 'model requested wait' };
    case 'done':
      return {
        type: 'done',
        summary: String(args.summary ?? 'goal met'),
        outputs: toStrRecord(args.outputs),
      };
    case 'fail':
      return { type: 'fail', reason: String(args.reason ?? 'dead end') };
    case 'ask_human':
      return { type: 'ask_human', question: String(args.question ?? 'operator assistance needed') };
    default:
      return { type: 'fail', reason: `unknown action "${name}"` };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function toStrRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = String(val);
  }
  return out;
}
