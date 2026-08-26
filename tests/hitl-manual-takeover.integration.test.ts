import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OperatorConsole } from '../src/hitl/operator-console.js';
import type { Observation } from '../src/core/actions.js';

const consoles: OperatorConsole[] = [];
const observation = (text: string): Observation => ({
  url: 'http://bank.test/app',
  title: 'Bank',
  screenshotBase64: Buffer.from(text).toString('base64'),
  viewport: { width: 800, height: 600 },
  a11yAnnotatedYaml: text,
  refIndex: {},
  frames: [],
  at: new Date().toISOString(),
});

async function startConsole(): Promise<OperatorConsole> {
  const console_ = new OperatorConsole(0, mkdtempSync(path.join(tmpdir(), 'deft-hitl-')));
  await console_.start();
  consoles.push(console_);
  return console_;
}

afterEach(async () => {
  await Promise.all(consoles.splice(0).map((console_) => console_.stop()));
});

describe('manual takeover FSM', () => {
  it('serializes empty browser-button request bodies as valid JSON', async () => {
    const console_ = await startConsole();
    const pending = console_.requestAndWait({
      kind: 'approval', source: 'replay', reason: 'approve risky action', observation: observation('before'),
    });
    const html = await (await fetch(`${console_.baseUrl}/`)).text();
    expect(html).toContain("body:JSON.stringify({})");
    const [intervention] = console_.listInterventions();
    await fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(await pending).toMatchObject({ state: 'APPROVED' });
  });

  it('does not let approval satisfy a manual takeover', async () => {
    const console_ = await startConsole();
    const pending = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'repair state', sessionId: 'session-a',
      observation: observation('before'), observeCurrent: async () => observation('after'),
    });
    const [intervention] = await console_.listInterventions();
    const response = await fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/approve`, { method: 'POST' });
    expect(response.status).toBe(409);
    await fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/abort`, { method: 'POST' });
    expect(await pending).toMatchObject({ state: 'ABORTED' });
  });

  it('rejects invalid transitions and resume directly from pending', async () => {
    const console_ = await startConsole();
    const pending = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'repair state', sessionId: 'session-a',
      observation: observation('before'), observeCurrent: async () => observation('after'),
    });
    const [intervention] = await console_.listInterventions();
    const resume = await fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    });
    expect(resume.status).toBe(409);
    await fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/abort`, { method: 'POST' });
    const takeoverAfterAbort = await fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    });
    expect(takeoverAfterAbort.status).toBe(409);
    expect(await pending).toMatchObject({ state: 'ABORTED' });
  });

  it('requires the same session and an observable human state change before resume', async () => {
    let current = observation('before');
    const console_ = await startConsole();
    const pending = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'repair state', sessionId: 'session-a',
      observation: current, observeCurrent: async () => current,
    });
    const [intervention] = await console_.listInterventions();
    const takeover = (sessionId: string) => fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
    });
    expect((await takeover('session-b')).status).toBe(409);
    expect((await takeover('session-a')).status).toBe(200);
    const resume = (sessionId: string) => fetch(`${console_.baseUrl}/api/interventions/${intervention!.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }),
    });
    expect((await resume('session-b')).status).toBe(409);
    expect((await resume('session-a')).status).toBe(409);
    current = observation('after');
    expect((await resume('session-a')).status).toBe(200);
    expect(await pending).toMatchObject({ state: 'RESUMED', sessionId: 'session-a', humanStateChanges: 1 });
    const [persisted] = await console_.listInterventions();
    expect(persisted?.beforeSemanticHash).not.toBe(persisted?.afterSemanticHash);
    expect(persisted?.screenshotFile && existsSync(persisted.screenshotFile)).toBe(true);
    expect(persisted?.afterScreenshotFile && existsSync(persisted.afterScreenshotFile)).toBe(true);
    expect(persisted?.afterA11yOutline).toBe('after');
    const transitions = readFileSync(persisted!.transitionLogFile!, 'utf8');
    expect(transitions).toContain('"transition":"PENDING"');
    expect(transitions).toContain('"transition":"HUMAN_CONTROL"');
    expect(transitions).toContain('"transition":"RESUMED"');
  });

  it('supports PENDING to HUMAN_CONTROL to RESUMED and terminal abort', async () => {
    const console_ = await startConsole();
    let current = observation('after');
    const resumed = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'repair state', sessionId: 'session-a',
      observation: observation('before'), observeCurrent: async () => current,
    });
    const [first] = await console_.listInterventions();
    expect(await (await fetch(`${console_.baseUrl}/api/state`)).json()).toMatchObject({ lease: 'awaiting-operator' });
    expect((await fetch(`${console_.baseUrl}/api/interventions/${first!.id}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(200);
    expect(await (await fetch(`${console_.baseUrl}/api/state`)).json()).toMatchObject({ lease: 'human' });
    expect((await fetch(`${console_.baseUrl}/api/interventions/${first!.id}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(409);
    expect((await fetch(`${console_.baseUrl}/api/interventions/${first!.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(200);
    expect((await resumed).state).toBe('RESUMED');
    expect(await (await fetch(`${console_.baseUrl}/api/state`)).json()).toMatchObject({ lease: 'idle' });
    expect((await fetch(`${console_.baseUrl}/api/interventions/${first!.id}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(409);

    const aborted = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'stop', sessionId: 'session-a',
      observation: current, observeCurrent: async () => current,
    });
    const interventions = await console_.listInterventions();
    const second = interventions.at(-1)!;
    expect((await fetch(`${console_.baseUrl}/api/interventions/${second.id}/abort`, { method: 'POST' })).status).toBe(200);
    expect((await aborted).state).toBe('ABORTED');
  });
});
