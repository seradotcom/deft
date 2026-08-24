/**
 * Redaction — regulated financial data must never leak into artifacts or logs.
 *
 * Design stance (REPORT §Safety): redaction is applied AT THE SINK (everything
 * that leaves the process boundary: logs, artifacts, evidence bundles), not at
 * the source, so a missed pattern in one writer can't undo the guarantee.
 */
import { createHash } from 'node:crypto';

const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'CARD', re: /\b(?:\d[ -]*?){13,16}\b/g },
  { label: 'ROUTING', re: /\b\d{9}\b/g },
  { label: 'PASSWORD_FIELD', re: /("?(?:password|passwd|pwd|secret|token)"?\s*[:=]\s*)"[^"]*"/gi },
  { label: 'AMOUNT', re: /\$\s?\d[\d,]*(?:\.\d{2})?/g },
];

/** Stable pseudonym per value so runs stay debuggable without exposing data. */
export function pseudonymize(value: string): string {
  const h = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `«${h}»`;
}

export function redactString(input: string): string {
  let out = input;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => pseudonymize(m));
  }
  return out;
}

/** Recursively redact every string inside JSON-shaped data. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Never emit obviously sensitive keys with their real values.
      if (/^(password|passwd|pwd|secret|token|authorization)$/i.test(k)) {
        out[k] = '«redacted»';
        continue;
      }
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Field names DEFT treats as sensitive inputs by default. */
export const SENSITIVE_INPUT_HINTS = ['ssn', 'dob', 'account', 'card', 'password'];
