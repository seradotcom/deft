/**
 * Agent-facing types: observations the planner sees and the action IR it emits.
 * The Action IR is deliberately modality-agnostic — a target hint may be a
 * grid coordinate (vision planners) or an element ref from the annotated
 * accessibility snapshot. The recorder resolves BOTH into semantic
 * TargetDescriptors before anything is persisted.
 */
import { z } from 'zod';

export const XYHint = z.object({ x: z.number().int().min(0).max(999), y: z.number().int().min(0).max(999) });
export type XYHint = z.infer<typeof XYHint>;

export const TargetHint = z.union([
  XYHint,
  z.object({ elementRef: z.string().regex(/^e\d+$/) }),
  /** Viewport pixels — used by replay's explicit coordinate fallback after
   *  frame-origin translation. Never produced raw by planners. */
  z.object({ px: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }) }),
]);
export type TargetHint = z.infer<typeof TargetHint>;

/** The action space offered to the LLM during discovery. */
export const AgentAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().min(1), why: z.string().optional() }),
  z.object({
    type: z.literal('click'),
    hint: TargetHint.optional(),
    why: z.string().optional(),
  }),
  z.object({
    type: z.literal('type'),
    text: z.string(),
    pressEnter: z.boolean().optional(),
    clearBeforeTyping: z.boolean().optional(),
    hint: TargetHint.optional(),
    why: z.string().optional(),
  }),
  z.object({
    type: z.literal('select'),
    optionText: z.string().min(1),
    hint: TargetHint.optional(),
    why: z.string().optional(),
  }),
  z.object({
    type: z.literal('scroll'),
    direction: z.enum(['up', 'down']),
    magnitude: z.number().int().min(0).max(1000).optional(), // 0-999 grid units
    hint: TargetHint.optional(),
    why: z.string().optional(),
  }),
  z.object({ type: z.literal('key'), combo: z.string().min(1), why: z.string().optional() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(250).max(15000), why: z.string().optional() }),
  /** Model claims the goal is met; outputs are its proposed extraction. */
  z.object({
    type: z.literal('done'),
    summary: z.string().min(3),
    outputs: z.record(z.string(), z.string()).default({}),
  }),
  /** Model declares a dead-end (e.g. permission wall). Triggers escalation path. */
  z.object({ type: z.literal('fail'), reason: z.string().min(3) }),
  /** Proactive human escalation — the model may ask for help explicitly. */
  z.object({ type: z.literal('ask_human'), question: z.string().min(3) }),
]);
export type AgentAction = z.infer<typeof AgentAction>;

export interface FrameInfo {
  name: string;
  url: string;
}

export interface Observation {
  url: string;
  title: string;
  screenshotBase64: string;
  viewport: { width: number; height: number };
  /**
   * Accessibility snapshot YAML of every frame merged, each line annotated
   * with [eN] refs that the planner can use as element hints.
   */
  a11yAnnotatedYaml: string;
  /** Map of ref -> frame path where the element lives (for resolution). */
  refIndex: Record<string, { framePath: string[]; yamlLine: string }>;
  frames: FrameInfo[];
  at: string;
}

export interface ElementFacts {
  tag: string;
  role?: string;
  accessibleName?: string;
  visibleText?: string;
  id?: string;
  nameAttr?: string;
  typeAttr?: string;
  /** True for controls whose activation submits their enclosing form. */
  submitControl?: boolean;
  placeholder?: string;
  title?: string;
  value?: string;
  framePath: string[];
  rect: { x: number; y: number; width: number; height: number };
  ordinalInParent: number;
  parentTag?: string;
  parentRole?: string;
}

export interface SurfaceEvent {
  kind: 'dialog' | 'navigation' | 'crash';
  detail: string;
  at: string;
  accepted?: boolean;
  control?: 'automation' | 'human';
  sessionId?: string;
}

/** Raw execution outcome of one agent action on the live surface. */
export interface ActOutcome {
  ok: boolean;
  errorClass?: string;
  message?: string;
  events: SurfaceEvent[];
}
