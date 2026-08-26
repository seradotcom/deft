import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifySubmission } from '../scripts/verify-submission.mjs';
const verify = (root: string) => verifySubmission(root, { requireCompleteScenarioSet: false, requireFrozenArtifacts: false });

const roots: string[] = [];
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const write = (file: string, value: string | object) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
};
const jsonl = (...events: object[]) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

function fixture(scenario = 'replay-success') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deft-verifier-')); roots.push(root);
  const artifact = Buffer.from('{"kind":"Capability","metadata":{"id":"cap.test","version":"2.0.0"}}\n');
  const artifactHash = sha(artifact); const runId = `run-${scenario}`;
  write(path.join(root, 'capabilities/cap.test.json'), artifact);
  write(path.join(root, 'evidence/artifact.cap.test.json'), artifact);
  write(path.join(root, `evidence/${scenario}/artifact.json`), artifact);
  write(path.join(root, `evidence/${scenario}/log.jsonl`), jsonl(
    { type: 'run_start', runId, kind: 'replay', label: 'cap.test' },
    { type: 'replay_start', capability: 'cap.test', version: '2.0.0', tenant: 'base' },
    { type: 'artifact_definition', artifactSha256: artifactHash, definitionRef: 'artifact.json' },
    { type: 'replay_result', runId, capabilityId: 'cap.test', capabilityVersion: '2.0.0', status: 'SUCCESS', artifactSha256: artifactHash },
  ));
  write(path.join(root, `evidence/${scenario}/ledger.jsonl`), jsonl({ runId, status: 'SUCCESS', artifactSha256: artifactHash }));
  const manifest = { schemaVersion: 2, artifacts: { 'cap.test': artifactHash }, scenarios: [{
    scenario, dir: `evidence/${scenario}`, runId, capabilityId: 'cap.test',
    artifactDefinition: 'artifact.json', artifactSha256: artifactHash,
    artifactVersion: '2.0.0', tenant: 'base', expectedResult: 'SUCCESS', ledger: 'ledger.jsonl', files: [
      { path: 'artifact.json', sha256: artifactHash, bytes: artifact.length },
      { path: 'log.jsonl', sha256: sha(fs.readFileSync(path.join(root, `evidence/${scenario}/log.jsonl`))), bytes: fs.statSync(path.join(root, `evidence/${scenario}/log.jsonl`)).size },
      { path: 'ledger.jsonl', sha256: sha(fs.readFileSync(path.join(root, `evidence/${scenario}/ledger.jsonl`))), bytes: fs.statSync(path.join(root, `evidence/${scenario}/ledger.jsonl`)).size },
    ],
  }] };
  write(path.join(root, 'evidence/manifest.json'), manifest);
  return { root, manifest, artifact, artifactHash, runId, scenario };
}

function addManualEngineEvent(f: ReturnType<typeof fixture>) {
  const file = path.join(f.root, `evidence/${f.scenario}/log.jsonl`);
  fs.appendFileSync(file, jsonl(
    { type: 'human_surface_events', stepId: 's1', sessionId: f.runId, events: [
      { kind: 'human_pointer', control: 'human', sessionId: f.runId },
      { kind: 'human_pointer', control: 'human', sessionId: f.runId },
      { kind: 'dialog', control: 'human', sessionId: f.runId, accepted: true },
    ] },
    { type: 'manual_takeover_resumed', runId: f.runId, sessionId: f.runId, stepId: 's1', humanStateChanges: 1 },
    { type: 'after_step', stepId: 's1', completedBy: 'manual_takeover' },
    { type: 'step_ok', stepId: 's1', completedBy: 'manual_takeover' },
  ));
  const reference = f.manifest.scenarios[0].files.find((entry) => entry.path === 'log.jsonl')!;
  reference.sha256 = sha(fs.readFileSync(file)); reference.bytes = fs.statSync(file).size;
}

function refreshFiles(f: ReturnType<typeof fixture>) {
  const dir = path.join(f.root, `evidence/${f.scenario}`);
  f.manifest.scenarios[0].files = fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    return { path: name, sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size };
  });
}

afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('submission verifier derives facts from frozen bytes and logs', () => {
  it('rejects a modified artifact despite a stale manifest hash', () => {
    const f = fixture(); write(path.join(f.root, 'capabilities/cap.test.json'), '{"changed":true}\n');
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/artifact.*hash/i));
  });
  it('requires exactly one terminal replay_result and ignores manifest result claims', () => {
    const f = fixture();
    write(path.join(f.root, `evidence/${f.scenario}/log.jsonl`), jsonl(
      { type: 'replay_result', runId: f.runId, status: 'SUCCESS', artifactSha256: f.artifactHash },
      { type: 'replay_result', runId: f.runId, status: 'FAILED', artifactSha256: f.artifactHash },
    ));
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/exactly one terminal/i));
  });
  it('rejects duplicate run IDs globally', () => {
    const f = fixture(); const duplicate = structuredClone(f.manifest.scenarios[0]); duplicate.scenario = 'other';
    f.manifest.scenarios.push(duplicate); write(path.join(f.root, 'evidence/manifest.json'), f.manifest);
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/duplicate runId/i));
  });
  it('requires the exact executed definition snapshot and matching log hash', () => {
    const f = fixture(); write(path.join(f.root, `evidence/${f.scenario}/artifact.json`), '{"not":"executed"}\n');
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/executed definition/i));
  });
  it('does not accept approval-only or identical observations as manual takeover', () => {
    const f = fixture('hitl-manual-takeover');
    write(path.join(f.root, `evidence/${f.scenario}/intervention.jsonl`), jsonl(
      { transition: 'PENDING', kind: 'approval', sessionId: f.runId }, { transition: 'APPROVED', kind: 'approval', sessionId: f.runId },
    ));
    write(path.join(f.root, `evidence/${f.scenario}/before.json`), { url: '/same', a11yAnnotatedYaml: 'same' });
    write(path.join(f.root, `evidence/${f.scenario}/after.json`), { url: '/same', a11yAnnotatedYaml: 'same' });
    write(path.join(f.root, `evidence/${f.scenario}/before.png`), 'identical');
    write(path.join(f.root, `evidence/${f.scenario}/after.png`), 'identical');
    Object.assign(f.manifest.scenarios[0], { interventionLog: 'intervention.jsonl', beforeObservation: 'before.json', afterObservation: 'after.json', beforeScreenshot: 'before.png', afterScreenshot: 'after.png' });
    refreshFiles(f);
    write(path.join(f.root, 'evidence/manifest.json'), f.manifest);
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/manual takeover/i));
  });
  it('accepts genuine PENDING to HUMAN_CONTROL to RESUMED in one session with real delta', () => {
    const f = fixture('hitl-manual-takeover');
    addManualEngineEvent(f);
    write(path.join(f.root, `evidence/${f.scenario}/intervention.jsonl`), jsonl(
      { transition: 'PENDING', kind: 'manual_takeover', sessionId: f.runId },
      { transition: 'HUMAN_CONTROL', kind: 'manual_takeover', sessionId: f.runId },
      { transition: 'RESUMED', kind: 'manual_takeover', sessionId: f.runId, humanStateChanges: 1 },
    ));
    write(path.join(f.root, `evidence/${f.scenario}/before.json`), { url: 'http://127.0.0.1/before', a11yAnnotatedYaml: 'broken' });
    write(path.join(f.root, `evidence/${f.scenario}/after.json`), { url: 'http://127.0.0.1/after', a11yAnnotatedYaml: 'fixed' });
    write(path.join(f.root, `evidence/${f.scenario}/before.png`), 'before-image');
    write(path.join(f.root, `evidence/${f.scenario}/after.png`), 'after-image');
    Object.assign(f.manifest.scenarios[0], { interventionLog: 'intervention.jsonl', beforeObservation: 'before.json', afterObservation: 'after.json', beforeScreenshot: 'before.png', afterScreenshot: 'after.png' });
    refreshFiles(f);
    write(path.join(f.root, 'evidence/manifest.json'), f.manifest);
    expect(verify(f.root).failures).toEqual([]);
  });
  it('rejects a nominal manual transition backed by identical screenshots', () => {
    const f = fixture('hitl-manual-takeover');
    addManualEngineEvent(f);
    write(path.join(f.root, `evidence/${f.scenario}/intervention.jsonl`), jsonl(
      { transition: 'PENDING', kind: 'manual_takeover', sessionId: f.runId },
      { transition: 'HUMAN_CONTROL', kind: 'manual_takeover', sessionId: f.runId },
      { transition: 'RESUMED', kind: 'manual_takeover', sessionId: f.runId, humanStateChanges: 1 },
    ));
    write(path.join(f.root, `evidence/${f.scenario}/before.json`), { url: 'http://127.0.0.1/before', a11yAnnotatedYaml: 'broken' });
    write(path.join(f.root, `evidence/${f.scenario}/after.json`), { url: 'http://127.0.0.1/after', a11yAnnotatedYaml: 'fixed' });
    write(path.join(f.root, `evidence/${f.scenario}/before.png`), 'same-image');
    write(path.join(f.root, `evidence/${f.scenario}/after.png`), 'same-image');
    Object.assign(f.manifest.scenarios[0], { interventionLog: 'intervention.jsonl', beforeObservation: 'before.json', afterObservation: 'after.json', beforeScreenshot: 'before.png', afterScreenshot: 'after.png' });
    refreshFiles(f);
    write(path.join(f.root, 'evidence/manifest.json'), f.manifest);
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/screenshot/i));
  });
  it('turns malformed JSON and path traversal references into verifier failures', () => {
    const f = fixture();
    f.manifest.scenarios[0].files.push({ path: '../escape.json', sha256: '0'.repeat(64), bytes: 1 });
    write(path.join(f.root, 'evidence/manifest.json'), f.manifest);
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/unsafe file reference/i));
    write(path.join(f.root, 'evidence/manifest.json'), '{broken');
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/parse|json/i));
  });
  it('rejects takeover transition evidence when the replay log lacks the engine resume event', () => {
    const f = fixture('hitl-manual-takeover');
    write(path.join(f.root, `evidence/${f.scenario}/intervention.jsonl`), jsonl(
      { transition: 'PENDING', kind: 'manual_takeover', sessionId: f.runId },
      { transition: 'HUMAN_CONTROL', kind: 'manual_takeover', sessionId: f.runId },
      { transition: 'RESUMED', kind: 'manual_takeover', sessionId: f.runId, humanStateChanges: 1 },
    ));
    write(path.join(f.root, `evidence/${f.scenario}/before.json`), { url: 'http://127.0.0.1/before', a11yAnnotatedYaml: 'broken' });
    write(path.join(f.root, `evidence/${f.scenario}/after.json`), { url: 'http://127.0.0.1/after', a11yAnnotatedYaml: 'fixed' });
    write(path.join(f.root, `evidence/${f.scenario}/before.png`), 'before'); write(path.join(f.root, `evidence/${f.scenario}/after.png`), 'after');
    Object.assign(f.manifest.scenarios[0], { interventionLog: 'intervention.jsonl', beforeObservation: 'before.json', afterObservation: 'after.json', beforeScreenshot: 'before.png', afterScreenshot: 'after.png' });
    refreshFiles(f);
    write(path.join(f.root, 'evidence/manifest.json'), f.manifest);
    expect(verify(f.root).failures).toContainEqual(expect.stringMatching(/engine.*resume/i));
  });
});
