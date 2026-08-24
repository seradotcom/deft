/**
 * PolicyEngine — the guardrail layer every action passes through, in BOTH
 * discovery and replay. Nothing touches the surface without a policy verdict.
 *
 * Model:
 *  - allowlist: permitted URL prefixes + permitted action types
 *  - risk classes: safe (reversible) vs risky (irreversible or state-changing
 *    beyond navigation/reading). Risky actions are blocked unless explicitly
 *    allowed for the run; in artifacts they require approval per riskPolicy.
 */
import type { AgentAction } from '../core/actions.js';

export interface PolicyConfig {
  allowedUrlPrefixes: string[];
  allowedActionTypes: AgentAction['type'][];
  /** When true, risky action types still pass (used by explicit operator approval). */
  allowRiskyActions?: boolean;
}

export const RISKY_ACTION_TYPES: ReadonlySet<AgentAction['type']> = new Set([
  // The discovery agent never gets these by default; replay marks artifact
  // steps that submit/confirm as risky instead. Kept here for defense in depth.
  'key',
]);

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
  riskClass: 'safe' | 'risky';
}

export class PolicyEngine {
  constructor(private readonly cfg: PolicyConfig) {}

  checkAction(action: AgentAction, currentUrl?: string): PolicyVerdict {
    if (!this.cfg.allowedActionTypes.includes(action.type)) {
      return {
        allowed: false,
        reason: `action type "${action.type}" is not on this run's allowlist`,
        riskClass: RISKY_ACTION_TYPES.has(action.type) ? 'risky' : 'safe',
      };
    }
    // URL containment applies to navigation targets and to INTERACTIVE actions
    // (they could act anywhere the page has drifted to). Passive actions skip.
    const interactive = ['click', 'type', 'select', 'key'].includes(action.type);
    const url = action.type === 'navigate' ? action.url : interactive ? currentUrl : undefined;
    if (url && !this.isUrlAllowed(url)) {
      return { allowed: false, reason: `URL "${url}" is outside the allowed prefixes`, riskClass: 'safe' };
    }
    if (RISKY_ACTION_TYPES.has(action.type) && !this.cfg.allowRiskyActions) {
      return { allowed: false, reason: `action type "${action.type}" is risky and not approved`, riskClass: 'risky' };
    }
    return { allowed: true, riskClass: 'safe' };
  }

  isUrlAllowed(url: string): boolean {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return this.cfg.allowedUrlPrefixes.some((prefix) => {
      try {
        const p = new URL(prefix);
        return parsed!.origin === p.origin && parsed!.pathname.startsWith(p.pathname);
      } catch {
        return url.startsWith(prefix);
      }
    });
  }
}

/** Default policy factory for a tenant target. */
export function defaultPolicy(baseUrl: string): PolicyEngine {
  return new PolicyEngine({
    allowedUrlPrefixes: [baseUrl],
    allowedActionTypes: ['navigate', 'click', 'type', 'select', 'scroll', 'wait', 'done', 'fail', 'ask_human', 'key'],
    allowRiskyActions: false,
  });
}
