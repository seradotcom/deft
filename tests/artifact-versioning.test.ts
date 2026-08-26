import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapabilityArtifactSchema } from '../src/core/artifact.js';
import { assertArtifactRevision, compileCapability, writeArtifactRevision } from '../src/agent/compiler.js';

const capabilityPath = (name: string) => path.resolve('capabilities', name);

describe('immutable executable artifact revisions', () => {
  it('rejects a changed executable definition that retains the immutable version', () => {
    const previous = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(capabilityPath('legacybank.lookup-member-balance.json'), 'utf8')));
    const changed = structuredClone(previous);
    changed.steps[0]!.intent += ' changed';
    expect(() => assertArtifactRevision(previous, changed)).toThrow(/version/i);
  });

  it('rejects a changed executable definition with a downgraded version', () => {
    const previous = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(capabilityPath('legacybank.lookup-member-balance.json'), 'utf8')));
    const changed = structuredClone(previous);
    changed.metadata.version = '1.9.9';
    changed.steps[0]!.intent += ' changed';
    expect(() => assertArtifactRevision(previous, changed)).toThrow(/greater/i);
  });

  it('storage refuses an equal-version executable overwrite and preserves exact bytes', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? '.', 'deft-version-'));
    const file = path.join(dir, 'capability.json');
    const bytes = fs.readFileSync(capabilityPath('legacybank.lookup-member-balance.json'));
    fs.writeFileSync(file, bytes);
    const changed = JSON.parse(bytes.toString('utf8'));
    changed.steps[0].intent += ' changed';
    expect(() => writeArtifactRevision(file, `${JSON.stringify(changed, null, 2)}\n`)).toThrow(/version/i);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('compiler emits the explicitly intended release version instead of 1.0.0', () => {
    const compiled = compileCapability({
      runId: 'version-run', endState: 'DONE', finalUrl: 'http://localhost:7788/done',
      steps: [{ seq: 1, ts: new Date().toISOString(), action: { type: 'click', hint: { x: 10, y: 10 } },
        descriptor: { primary: { kind: 'id', id: 'go' }, fallbacks: [], scope: { framePath: [] }, quality: 'verified' },
        ok: true, urlBefore: 'http://localhost:7788/start', urlAfter: 'http://localhost:7788/done', dialogEvents: [] }],
    }, {
      appFamily: 'test', capabilityIdBase: 'test.versioned', name: 'Versioned', description: 'Versioned fixture',
      entryUrlTemplate: 'http://localhost:7788/start', inputs: {}, outputsSchema: { type: 'object', properties: {} },
      plannerModel: 'test', artifactVersion: '2.0.0',
    });
    expect(compiled.metadata.version).toBe('2.0.0');
  });

  it.each([
    ['legacybank.lookup-member-balance.json', 18645, '720de53e89794427d3e86d99bd3dbb8520715d7e23eed804fd41254d74dfee07'],
    ['legacybank.open-sub-account.json', 26269, '4369749f3a4bdaa3757307f13d6b1f8c997bfd337e46e9e3db85d9ad552c2d93'],
  ] as const)('%s satisfies frozen release contracts', (name, expectedBytes, expectedSha256) => {
    const bytes = fs.readFileSync(capabilityPath(name));
    const artifact = CapabilityArtifactSchema.parse(JSON.parse(bytes.toString('utf8')));
    expect(artifact.metadata.version).toBe('2.0.0');
    expect(bytes.byteLength).toBe(expectedBytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
    expect(artifact.outputs).toMatchObject({ type: 'object', additionalProperties: false });
    expect((artifact.outputs as { required?: string[] }).required).toEqual(Object.keys((artifact.outputs as { properties: object }).properties));
    for (const step of artifact.steps) {
      if (step.target) expect(step.target.quality).not.toBe('partial');
      if (step.submission === 'SUBMIT') {
        expect((step.riskClass === 'safe' && step.idempotent) || (step.riskClass === 'risky' && !step.idempotent)).toBe(true);
      }
    }
    if (name.includes('open-sub-account')) {
      const finalSubmit = artifact.steps.find((step) => step.riskClass === 'risky' && step.submission === 'SUBMIT');
      expect(finalSubmit).toMatchObject({ idempotent: false, expectsDialog: true, postCheck: expect.any(Object) });
    }
  });
});
