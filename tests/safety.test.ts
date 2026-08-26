import { describe, expect, it } from 'vitest';
import { redactDeep, redactString } from '../src/safety/redact.js';
import { PolicyEngine, defaultPolicy } from '../src/safety/policy.js';
import { CapabilityArtifactSchema, EnvBinding } from '../src/core/artifact.js';
import { applyVariant, artifactPreflight, hashCapabilityArtifact, resolveEnvironmentBindings, validateInputs, validateOutputs } from '../src/replay/support.js';
import { interpolate } from '../src/surface/targeting.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

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
    expect(policy.isUrlAllowed('http://localhost:7788/acmeevil/search.aspx')).toBe(false);
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

describe('release-candidate contract preflight', () => {
  it('rejects unsupported configKey environment bindings at schema validation', () => {
    expect(EnvBinding.safeParse({ source: 'configKey', key: 'legacybank.baseUrl' }).success).toBe(false);
  });

  it('allows every path on the same origin when the base URL is the origin root', () => {
    const rootPolicy = defaultPolicy('http://localhost:7788');
    expect(rootPolicy.isUrlAllowed('http://localhost:7788/acme/login.aspx')).toBe(true);
    expect(rootPolicy.isUrlAllowed('http://localhost:7788/nw/search.aspx')).toBe(true);
    expect(rootPolicy.isUrlAllowed('http://localhost:7789/acme/login.aspx')).toBe(false);
  });

  it('rejects unresolved template references instead of preserving their literal', () => {
    expect(() => interpolate('{{inputs.missingMemberId}}', { inputs: {} })).toThrow(/unresolved template/i);
  });

  it('expands second-order templates but rejects cycles and malformed markers', () => {
    expect(interpolate('{{inputs.value}}', { inputs: { value: '{{env.secret}}' }, env: { secret: 'resolved' } })).toBe('resolved');
    expect(() => interpolate('{{inputs.a}}', { inputs: { a: '{{inputs.b}}', b: '{{inputs.a}}' } })).toThrow(/cyclic|recursive/i);
    expect(() => interpolate('{{inputs.value', { inputs: { value: 'ok' } })).toThrow(/template/i);
  });

  it('rejects lax output object schemas, including nested object and array item schemas', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, unknown>;
    const lax = {
      ...base,
      outputs: {
        type: 'object',
        properties: {
          savingsBalance: { type: 'string' },
          details: {
            type: 'object',
            properties: { accountId: { type: 'string' } },
            required: ['accountId'],
          },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
        required: ['savingsBalance', 'details', 'entries'],
      },
    };
    expect(CapabilityArtifactSchema.safeParse(lax).success).toBe(false);
  });

  it('rejects structural output keywords without object type and empty output schemas', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, unknown>;
    for (const outputs of [
      { properties: { savingsBalance: { type: 'string' } } },
      { required: ['savingsBalance'] },
      { additionalProperties: false },
      {},
    ]) {
      expect(CapabilityArtifactSchema.safeParse({ ...base, outputs }).success).toBe(false);
    }
  });

  it('rejects unknown artifact-owned fields at top level, step, target, and action', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, any>;
    expect(CapabilityArtifactSchema.safeParse({ ...base, unexpected: true }).success).toBe(false);
    expect(CapabilityArtifactSchema.safeParse({ ...base, steps: [{ ...base.steps[0], unexpected: true }] }).success).toBe(false);
    expect(CapabilityArtifactSchema.safeParse({ ...base, steps: [{ ...base.steps[0], target: { ...base.steps[0].target, unexpected: true } }] }).success).toBe(false);
    expect(CapabilityArtifactSchema.safeParse({
      ...base,
      steps: [{ ...base.steps[0], recoverableErrors: [{ description: 'timeout', when: { errorClass: 'TIMEOUT' }, do: [{ action: 'wait', durationMs: 1, unexpected: true }] }] }],
    }).success).toBe(false);
  });

  it('rejects artifactBytes with unknown artifact-owned fields before browser side effects', () => {
    const bytes = fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'));
    const artifact = JSON.parse(bytes.toString('utf8')) as Record<string, any>;
    const unknownBytes = Buffer.from(JSON.stringify({ ...artifact, unexpected: true }));
    expect(() => artifactPreflight(artifact, {
      artifactBytes: unknownBytes,
      env: { baseUrl: 'http://localhost:7788' },
      runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
      inputs: { memberId: 'M10041' },
    })).toThrowError(expect.objectContaining({ deftClass: 'ARTIFACT_INVALID' }));
  });

  it('rejects a future output reference in an early step before browser creation', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, any>;
    const artifact = { ...base, steps: [{ ...base.steps[0], valueTemplate: '{{outputs.savingsBalance}}' }, ...base.steps.slice(1)] };
    expect(() => artifactPreflight(artifact, {
      env: { baseUrl: 'http://localhost:7788' },
      runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
      inputs: { memberId: 'M10041' },
    })).toThrowError(expect.objectContaining({ deftClass: 'ARTIFACT_INVALID' }));
  });

  it('rejects outputKey on non-extract steps and unknown extract outputs', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, any>;
    expect(CapabilityArtifactSchema.safeParse({ ...base, steps: [{ ...base.steps[0], outputKey: 'savingsBalance' }, ...base.steps.slice(1)] }).success).toBe(false);
    expect(CapabilityArtifactSchema.safeParse({
      ...base,
      steps: base.steps.map((step: any) => step.action === 'extract' ? { ...step, outputKey: 'unknownOutput' } : step),
    }).success).toBe(false);
  });

  it('requires explicit recovery action safety metadata', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, any>;
    const recoveryAction = { action: 'wait', durationMs: 1 };
    expect(CapabilityArtifactSchema.safeParse({
      ...base,
      recoveryChains: { relogin: [recoveryAction] },
    }).success).toBe(false);
  });

  it('permits a later output reference only after a real extract step', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, any>;
    const afterExtract = { ...base.steps[0], id: 's-after', valueTemplate: '{{outputs.savingsBalance}}' };
    expect(() => artifactPreflight({ ...base, steps: [...base.steps, afterExtract] }, {
      env: { baseUrl: 'http://localhost:7788' }, runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' }, inputs: { memberId: 'M10041' },
    })).not.toThrow();
  });

  it('rejects invalid AJV input/output schemas during preflight', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, any>;
    expect(() => artifactPreflight({ ...base, inputs: { type: 'not-a-json-schema-type' } }, {
      env: { baseUrl: 'http://localhost:7788' }, inputs: { memberId: 'M10041' },
    })).toThrowError(expect.objectContaining({ deftClass: 'ARTIFACT_INVALID' }));
  });

  it('rejects unsupported JSON Schema combinators and subschema keywords at any depth', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, unknown>;
    const unsupported = [
      '$ref', '$defs', 'definitions', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
      'prefixItems', 'contains', 'dependentSchemas', 'patternProperties', 'unevaluatedProperties',
    ];
    for (const keyword of unsupported) {
      const schema = {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: { value: { type: 'string', [keyword]: {} } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        required: ['nested'],
        additionalProperties: false,
      };
      expect(CapabilityArtifactSchema.safeParse({ ...base, outputs: schema }).success, keyword).toBe(false);
    }
  });

  it('types input contract failures before browser creation', () => {
    const artifact = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')));
    expect(() => validateInputs(artifact, {})).toThrowError(expect.objectContaining({ deftClass: 'INPUT_CONTRACT_VIOLATION' }));
  });

  it('types residual unsupported binding branches as ARTIFACT_INVALID', () => {
    expect(() => resolveEnvironmentBindings({ environmentBindings: { baseUrl: { source: 'configKey' } } } as never, {}))
      .toThrowError(expect.objectContaining({ deftClass: 'ARTIFACT_INVALID' }));
  });

  it('hashes the applied artifact definition, not merely the base artifact', () => {
    const base = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')));
    const applied = applyVariant(base, 'nw');
    expect(hashCapabilityArtifact(applied)).not.toBe(hashCapabilityArtifact(base));
    expect(hashCapabilityArtifact(base)).toBe(hashCapabilityArtifact(base));
  });

  it('rejects a resolved entry URL outside the pure preflight policy', () => {
    const base = JSON.parse(fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'), 'utf8')) as Record<string, unknown>;
    const artifact = { ...base, target: { ...(base.target as Record<string, unknown>), entryUrlTemplate: 'http://evil.example/login.aspx' } };
    expect(() => artifactPreflight(artifact, { env: { baseUrl: 'http://localhost:7788/acme' }, inputs: { memberId: 'M10041' } }))
      .toThrowError(expect.objectContaining({ deftClass: 'ARTIFACT_INVALID' }));
  });

  it('uses exact supplied base artifact bytes and rejects mismatched bytes before browser side effects', () => {
    const bytes = fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'));
    const artifact = JSON.parse(bytes.toString('utf8'));
    const preflight = artifactPreflight(artifact, {
      artifactBytes: bytes,
      env: { baseUrl: 'http://localhost:7788' },
      runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
      inputs: { memberId: 'M10041' },
    });
    expect(preflight.artifactSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Buffer.from(preflight.artifactDefinitionBytes)).toEqual(bytes);

    const mismatchArtifact = { ...artifact, metadata: { ...artifact.metadata, version: '9.9.9' } };
    const mismatch = Buffer.from(JSON.stringify(mismatchArtifact));
    expect(() => artifactPreflight(artifact, {
      artifactBytes: mismatch,
      env: { baseUrl: 'http://localhost:7788' },
      runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
      inputs: { memberId: 'M10041' },
    })).toThrowError(expect.objectContaining({ deftClass: 'ARTIFACT_INVALID' }));
  });

  it('hashes the post-variant canonical definition, not the base bytes', () => {
    const bytes = fs.readFileSync(path.join('capabilities', 'legacybank.lookup-member-balance.json'));
    const artifact = JSON.parse(bytes.toString('utf8'));
    const preflight = artifactPreflight(artifact, {
      artifactBytes: bytes,
      tenantId: 'nw',
      env: { baseUrl: 'http://localhost:7788' },
      runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
      inputs: { memberId: 'M10041' },
    });
    expect(preflight.artifactSha256).toBe(hashCapabilityArtifact(preflight.artifact));
    expect(preflight.artifactSha256).not.toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(Buffer.from(preflight.artifactDefinitionBytes).toString('utf8')).not.toBe(bytes.toString('utf8'));
  });

  it('requires every declared output property and rejects unknown output properties', () => {
    const artifact = {
      outputs: {
        type: 'object',
        properties: { savingsBalance: { type: 'string' } },
        required: ['savingsBalance'],
        additionalProperties: false,
      },
    } as never;

    expect(() => validateOutputs(artifact, {})).toThrow(/required/i);
    expect(() => validateOutputs(artifact, { savingsBalance: '$2,450.75', debug: 'leak' })).toThrow(/additional|property/i);
    expect(() => validateOutputs(artifact, { savingsBalance: '$2,450.75' })).not.toThrow();
  });
});
