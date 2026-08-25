/**
 * Deterministic risk classification — OUTSIDE the LLM.
 *
 * The model may PROPOSE actions; it never decides whether it is allowed to
 * perform them. Before any discovery action touches the surface, the resolved
 * target's semantics (accessible name, visible text, role) are classified by
 * this module. Risky targets require an operator decision; the model is only
 * told the action was blocked and must choose differently.
 *
 * This is a heuristic screen, deliberately conservative: a false positive
 * costs one operator prompt, a false negative costs a financial side effect.
 */
export const RISKY_VERBS = [
  'confirm',
  'submit',
  'approve',
  'authorize',
  'delete',
  'remove',
  'transfer',
  'withdraw',
  'pay',
  'purchase',
  'open account',
  'open sub-account',
  'open sub account',
  'close account',
];

/** Returns the matched risky phrase, or null if the target looks safe. */
export function classifyTargetRisk(facts: {
  accessibleName?: string;
  visibleText?: string;
  role?: string;
  tag?: string;
} | null): string | null {
  if (!facts) return null;
  const hay = `${facts.accessibleName ?? ''} ${facts.visibleText ?? ''}`.toLowerCase();
  if (!hay.trim()) return null;
  for (const verb of RISKY_VERBS) {
    if (hay.includes(verb)) return verb;
  }
  return null;
}
