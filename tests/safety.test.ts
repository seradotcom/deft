import { describe, expect, it } from 'vitest';
import { redactDeep, redactString } from '../src/safety/redact.js';
import { PolicyEngine, defaultPolicy } from '../src/safety/policy.js';

describe('redaction', () => {
  it('redacts SSNs, cards and amounts with stable pseudonyms', () => {
    const out = redactString('Member 123-45-6789 paid $2,450.75 via 4111 1111 1111 1111');
    expect(out).not.toContain('123-45-6789');
    expect(out).not.toContain('$2,450.75');
    expect(out).not.toContain('4111');
    // stable pseudonymization
    expect(redactString('SSN 123-45-6789')).toBe(redactString('SSN 123-45-6789'));
    expect(redactString('SSN 123-45-6789')).not.toBe(redactString('SSN 987-65-4321'));
  });

  it('never emits sensitive keys with values', () => {
    const out = redactDeep({ password: 'hunter2', nested: { token: 'abc', ok: 'fine $1.23' } });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('abc');
    expect(out.nested.ok).not.toBe('fine $1.23');
  });
});

describe('policy engine', () => {
  const policy = defaultPolicy('http://localhost:7788/acme');

  it('allows navigation within the tenant prefix and blocks others', () => {
    expect(policy.isUrlAllowed('http://localhost:7788/acme/search.aspx')).toBe(true);
    expect(policy.isUrlAllowed('http://localhost:7788/nw/search.aspx')).toBe(false);
    expect(policy.isUrlAllowed('http://evil.example.com/acme')).toBe(false);
  });

  it('blocks disallowed action types with a reason', () => {
    const strict = new (policy.constructor as typeof PolicyEngine)({
      allowedUrlPrefixes: ['http://x'],
      allowedActionTypes: ['click'],
    });
    const verdict = strict.checkAction({ type: 'navigate', url: 'http://x/' });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('allowlist');
  });

  it('checks current URL for non-navigate actions too', () => {
    const v = policy.checkAction(
      { type: 'click', hint: { x: 10, y: 10 } },
      'https://phish.example/'
    );
    expect(v.allowed).toBe(false);
  });
});
