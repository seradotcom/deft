import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityArtifactSchema, type Step } from '../src/core/artifact.js';
import { replayCapability } from '../src/replay/engine.js';

type Fixture = {
  baseUrl: string;
  root: string;
  runsDir: string;
  ledgerDir: string;
  server: Server;
};

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ server, root }) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }));
});

async function startFixture(configure: (app: Express) => void): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deft-executor-safety-'));
  const app = express();
  configure(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind a TCP port');
  const fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    runsDir: path.join(root, 'runs'),
    ledgerDir: path.join(root, 'ledger'),
    server,
  };
  fixtures.push(fixture);
  return fixture;
}

function target(id: string) {
  return {
    primary: { kind: 'id' as const, id },
    fallbacks: [],
    scope: { framePath: [] },
    quality: 'verified' as const,
  };
}

function recoveryNavigate(urlTemplate: string) {
  return {
    action: 'navigate' as const,
    urlTemplate,
    riskClass: 'safe' as const,
    idempotent: true,
    expectsDialog: false,
  };
}

function sessionRecovery(urlTemplate: string) {
  return [{
    description: 'restore the expired session',
    when: { redirectedToGlob: '**/login.aspx*' },
    do: [recoveryNavigate(urlTemplate)],
    maxAttempts: 1,
  }];
}

function artifact(baseUrl: string, scenario: string, steps: Step[]) {
  const now = new Date().toISOString();
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1',
    kind: 'Capability',
    metadata: {
      id: `safety.${scenario}`,
      name: `${scenario} safety fixture`,
      description: `Synthetic executor safety fixture for ${scenario}.`,
      version: '1.0.0',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    },
    target: {
      appFamily: 'safety-fixture',
      surfaceType: 'web-modern',
      entryUrlTemplate: `${baseUrl}/start`,
      variants: [],
    },
    inputs: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputs: { type: 'object', properties: {}, required: [], additionalProperties: false },
    environmentBindings: {},
    steps,
    businessOutcomes: [],
    successCondition: { allOf: [{ assert: 'pageTextContains', text: 'DONE' }] },
    riskPolicy: { onRiskyStep: 'require_approval' },
    redaction: { sensitiveInputNames: [], notes: '' },
    provenance: {},
  });
}

function replayLog(fixture: Fixture, runId: string): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(fixture.runsDir, runId, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function replay(fixture: Fixture, capability: unknown) {
  return replayCapability(capability, {
    env: { baseUrl: fixture.baseUrl },
    inputs: {},
    headless: true,
    runsDir: fixture.runsDir,
    capabilitiesDir: fixture.ledgerDir,
  });
}

describe('guarded executor recovery invariants', () => {
  it('finalizes a recovery-action policy violation as FAILED with exactly one replay_result', async () => {
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="expire" href="/login.aspx">Expire</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
    });
    const capability = artifact(fixture.baseUrl, 'recovery-policy', [{
      id: 'expire-session',
      intent: 'Trigger session expiry',
      action: 'click',
      target: target('expire'),
      recoverableErrors: sessionRecovery('http://example.invalid/outside-policy'),
      riskClass: 'safe',
      idempotent: true,
      expectsDialog: false,
    }]);

    const result = await replay(fixture, capability);
    const log = replayLog(fixture, result.runId);
    const terminalEvents = log.filter((event) => event.type === 'replay_result');
    const failures = log.filter((event) => event.type === 'step_failed');

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('RECOVERY_FAILED');
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('FAILED');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stepId: 'expire-session',
      errorClass: 'RECOVERY_FAILED',
      mode: 'normal',
      attempt: 1,
    });
  });

  it('never retries a non-idempotent step after its side effect was dispatched', async () => {
    let sideEffects = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send(
        '<form method="post" action="/effect"><button id="effect" type="submit">Apply</button></form>'
      ));
      app.post('/effect', (_req, res) => {
        sideEffects += 1;
        res.redirect(303, '/login.aspx');
      });
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
      app.get('/recovered', (_req, res) => res.type('html').send('<button id="effect">Apply again</button>'));
    });
    const capability = artifact(fixture.baseUrl, 'non-idempotent', [{
      id: 'apply-once',
      intent: 'Apply one irreversible side effect',
      action: 'click',
      target: target('effect'),
      submission: 'SUBMIT',
      recoverableErrors: sessionRecovery(`${fixture.baseUrl}/recovered`),
      riskClass: 'risky',
      idempotent: false,
      expectsDialog: false,
    }]);
    capability.riskPolicy.onRiskyStep = 'allow';

    const result = await replay(fixture, capability);
    const log = replayLog(fixture, result.runId);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('NON_IDEMPOTENT_OUTCOME_UNKNOWN');
    expect(sideEffects).toBe(1);
    expect(log.filter((event) => event.type === 'recovering')).toHaveLength(0);
    expect(log.filter((event) => event.type === 'step_start' && event.stepId === 'apply-once')).toHaveLength(1);
  });

  it('applies the original postCheck on retry and never emits step_ok_after_recovery for a failed retry', async () => {
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="target" href="/login.aspx">Continue</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
      app.get('/retry', (_req, res) => res.type('html').send('<button id="target">Retry</button><p>NOT READY</p>'));
    });
    const capability = artifact(fixture.baseUrl, 'retry-postcheck', [{
      id: 'continue-flow',
      intent: 'Continue after session recovery',
      action: 'click',
      target: target('target'),
      postCheck: { assert: 'pageTextContains', text: 'EXPECTED READY STATE' },
      recoverableErrors: sessionRecovery(`${fixture.baseUrl}/retry`),
      riskClass: 'safe',
      idempotent: true,
      expectsDialog: false,
    }]);

    const result = await replay(fixture, capability);
    const log = replayLog(fixture, result.runId);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POST_CHECK_FAILED');
    expect(log.some((event) => event.type === 'step_start' && event.stepId === 'continue-flow' && event.mode === 'retry')).toBe(true);
    expect(log.some((event) => event.type === 'step_ok_after_recovery')).toBe(false);
    expect(log.filter((event) => event.type === 'step_attempt_failed' && event.stepId === 'continue-flow')).toHaveLength(1);
    expect(log.filter((event) => event.type === 'step_failed' && event.stepId === 'continue-flow')).toHaveLength(1);
  });

  it('stops fast-forward when a previous target is missing and never dispatches the later retry', async () => {
    let laterSideEffects = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="prepare" href="/work">Prepare</a>'));
      app.get('/work', (_req, res) => res.type('html').send('<a id="target" href="/login.aspx">Continue</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
      app.get('/recovered', (_req, res) => res.type('html').send(
        '<form method="post" action="/later"><button id="target" type="submit">Later side effect</button></form>'
      ));
      app.post('/later', (_req, res) => {
        laterSideEffects += 1;
        res.type('html').send('<p>DONE</p>');
      });
    });
    const capability = artifact(fixture.baseUrl, 'fast-forward-stop', [
      {
        id: 'prepare-state',
        intent: 'Prepare deterministic state',
        action: 'click',
        target: target('prepare'),
        pageUrl: `${fixture.baseUrl}/login.aspx`,
        recoverableErrors: [],
        riskClass: 'safe',
        idempotent: true,
        expectsDialog: false,
      },
      {
        id: 'continue-flow',
        intent: 'Continue after session recovery',
        action: 'click',
        target: target('target'),
        recoverableErrors: sessionRecovery(`${fixture.baseUrl}/recovered`),
        riskClass: 'safe',
        idempotent: true,
        expectsDialog: false,
      },
    ]);

    const result = await replay(fixture, capability);
    const log = replayLog(fixture, result.runId);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('FAST_FORWARD_FAILED');
    expect(laterSideEffects).toBe(0);
    expect(log.some((event) => event.type === 'step_start' && event.stepId === 'prepare-state' && event.mode === 'fast-forward')).toBe(true);
    expect(log.some((event) => event.type === 'step_start' && event.stepId === 'continue-flow' && event.mode === 'retry')).toBe(false);
    expect(log.filter((event) => event.type === 'step_attempt_failed' && event.stepId === 'continue-flow')).toHaveLength(1);
    expect(log.filter((event) => event.type === 'step_failed' && event.stepId === 'continue-flow')).toHaveLength(1);
  });

  it('turns a driver ActOutcome failure into FAILED without step_ok or dropped surface events', async () => {
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="missing" href="/nowhere">Missing</a>'));
      app.get('/drop', (req) => req.socket.destroy());
    });
    const capability = artifact(fixture.baseUrl, 'driver-outcome-failure', [{
      id: 'network-action',
      intent: 'Navigate to a network failure',
      action: 'navigate',
      valueTemplate: `${fixture.baseUrl}/drop`,
      recoverableErrors: [],
      riskClass: 'safe',
      idempotent: true,
      expectsDialog: false,
    }]);

    const result = await replay(fixture, capability);
    const log = replayLog(fixture, result.runId);

    expect(result.status).toBe('FAILED');
    expect(log.some((event) => event.type === 'step_ok' && event.stepId === 'network-action')).toBe(false);
    expect(log.some((event) => event.type === 'step_failed' && event.stepId === 'network-action')).toBe(true);
  });

  it('treats a failed postCheck after a non-idempotent dispatch as unknown, without retry', async () => {
    let sideEffects = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<form method="post" action="/effect"><button id="effect">Apply</button></form>'));
      app.post('/effect', (_req, res) => { sideEffects += 1; res.type('html').send('<p>NOT READY</p>'); });
    });
    const capability = artifact(fixture.baseUrl, 'non-idempotent-postcheck', [{
      id: 'apply-once',
      intent: 'Apply one irreversible side effect',
      action: 'click',
      target: target('effect'),
      submission: 'SUBMIT',
      postCheck: { assert: 'pageTextContains', text: 'EXPECTED READY STATE' },
      recoverableErrors: [],
      riskClass: 'risky',
      idempotent: false,
      expectsDialog: false,
    }]);
    capability.riskPolicy.onRiskyStep = 'allow';

    const result = await replay(fixture, capability);
    const log = replayLog(fixture, result.runId);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('NON_IDEMPOTENT_OUTCOME_UNKNOWN');
    expect(sideEffects).toBe(1);
    expect(log.some((event) => event.type === 'step_ok_after_recovery')).toBe(false);
    expect(log.filter((event) => event.type === 'step_start' && event.stepId === 'apply-once')).toHaveLength(1);
  });

  it('keeps an expected dialog armed through asynchronous settle and records its acceptance', async () => {
    let acceptedDialogs = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <button id="confirm">Confirm</button>
        <script>
          document.querySelector('#confirm').addEventListener('click', () => {
            setTimeout(async () => {
              if (confirm('Expected confirmation')) {
                await fetch('/accepted', { method: 'POST' });
                document.body.insertAdjacentHTML('beforeend', '<p>DONE</p>');
              } else {
                document.body.insertAdjacentHTML('beforeend', '<p>DISMISSED</p>');
              }
            }, 50);
          });
        </script>
      `));
      app.post('/accepted', (_req, res) => {
        acceptedDialogs += 1;
        res.json({ ok: true });
      });
    });
    const capability = artifact(fixture.baseUrl, 'async-expected-dialog', [{
      id: 'confirm-action',
      intent: 'Accept the expected asynchronous confirmation',
      action: 'click',
      target: target('confirm'),
      postCheck: { assert: 'pageTextContains', text: 'DONE' },
      recoverableErrors: [],
      riskClass: 'safe',
      idempotent: true,
      expectsDialog: true,
    }]);

    const result = await replay(fixture, capability);
    const dialogs = replayLog(fixture, result.runId)
      .filter((event) => event.type === 'surface_events')
      .flatMap((event) => event.events as Array<Record<string, unknown>>);

    expect(result.status).toBe('SUCCESS');
    expect(acceptedDialogs).toBe(1);
    expect(dialogs).toContainEqual(expect.objectContaining({ kind: 'dialog', accepted: true }));
  });

  it('disarms an unused dialog expectation before an unrelated later dialog', async () => {
    let unrelatedAccepts = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <button id="no-dialog">No dialog</button>
        <button id="unrelated">Unrelated dialog</button>
        <script>
          document.querySelector('#unrelated').addEventListener('click', async () => {
            if (confirm('Unrelated confirmation')) {
              await fetch('/unrelated-accepted', { method: 'POST' });
              document.body.insertAdjacentHTML('beforeend', '<p>WRONG</p>');
            } else {
              document.body.insertAdjacentHTML('beforeend', '<p>DONE</p>');
            }
          });
        </script>
      `));
      app.post('/unrelated-accepted', (_req, res) => {
        unrelatedAccepts += 1;
        res.json({ ok: true });
      });
    });
    const capability = artifact(fixture.baseUrl, 'dialog-disarm', [
      {
        id: 'expected-but-absent',
        intent: 'Run an action whose expected dialog never appears',
        action: 'click',
        target: target('no-dialog'),
        recoverableErrors: [],
        riskClass: 'safe',
        idempotent: true,
        expectsDialog: true,
      },
      {
        id: 'unrelated-dialog',
        intent: 'Dismiss an unrelated later confirmation',
        action: 'click',
        target: target('unrelated'),
        postCheck: { assert: 'pageTextContains', text: 'DONE' },
        recoverableErrors: [],
        riskClass: 'safe',
        idempotent: true,
        expectsDialog: false,
      },
    ]);

    const result = await replay(fixture, capability);
    const dialogs = replayLog(fixture, result.runId)
      .filter((event) => event.type === 'surface_events')
      .flatMap((event) => event.events as Array<Record<string, unknown>>);

    expect(result.status).toBe('SUCCESS');
    expect(unrelatedAccepts).toBe(0);
    expect(dialogs).toContainEqual(expect.objectContaining({ kind: 'dialog', accepted: false }));
  });

  it('persists one risky approval across recovery retry', async () => {
    let approvals = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="target" href="/login.aspx">Continue</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
      app.get('/retry', (_req, res) => res.type('html').send('<button id="target" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>DONE</p>\')">Continue</button>'));
    });
    const capability = artifact(fixture.baseUrl, 'risky-approval-retry', [{
      id: 'risky-step',
      intent: 'Continue through an approved risky transition',
      action: 'click',
      target: target('target'),
      recoverableErrors: sessionRecovery(`${fixture.baseUrl}/retry`),
      riskClass: 'risky',
      idempotent: true,
      expectsDialog: false,
    }]);
    const result = await replayCapability(capability, {
      env: { baseUrl: fixture.baseUrl }, inputs: {}, headless: true,
      runsDir: fixture.runsDir, capabilitiesDir: fixture.ledgerDir,
      onEscalation: async () => { approvals += 1; return true; },
    });
    expect(result.status).toBe('SUCCESS');
    expect(approvals).toBe(1);
  });

  it('fails closed when a recovery action is risky and cannot obtain approval', async () => {
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="target" href="/login.aspx">Continue</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
    });
    const capability = artifact(fixture.baseUrl, 'risky-recovery', [{
      id: 'recover-me', intent: 'Trigger recovery', action: 'click', target: target('target'),
      recoverableErrors: [{ description: 'risky recovery', when: { redirectedToGlob: '**/login.aspx*' }, do: [{ action: 'navigate', urlTemplate: `${fixture.baseUrl}/recovered`, riskClass: 'risky', idempotent: true, expectsDialog: false }], maxAttempts: 1 }],
      riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);
    const result = await replay(fixture, capability);
    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('RECOVERY_FAILED');
  });

  it('honors recovery wait duration through the guarded executor', async () => {
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<a id="target" href="/login.aspx">Continue</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
      app.get('/retry', (_req, res) => res.type('html').send('<button id="target" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>DONE</p>\')">Continue</button>'));
    });
    const capability = artifact(fixture.baseUrl, 'recovery-wait-duration', [{
      id: 'wait-step', intent: 'Wait during recovery', action: 'click', target: target('target'),
      recoverableErrors: [{ description: 'wait recovery', when: { redirectedToGlob: '**/login.aspx*' }, do: [{ action: 'navigate', urlTemplate: `${fixture.baseUrl}/retry`, riskClass: 'safe', idempotent: true, expectsDialog: false }, { action: 'wait', durationMs: 1400, riskClass: 'safe', idempotent: true, expectsDialog: false }], maxAttempts: 1 }],
      riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);
    const started = Date.now();
    const result = await replay(fixture, capability);
    expect(result.status).toBe('SUCCESS');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
  });

  it('reports missing gotoStepPage child frame as typed recovery failure', async () => {
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<iframe name="child" src="/child"></iframe>'));
      app.get('/child', (_req, res) => res.type('html').send('<a id="never" href="/login.aspx" target="_top">Expire</a>'));
      app.get('/login.aspx', (_req, res) => res.type('html').send('<p>Session expired</p>'));
    });
    const capability = artifact(fixture.baseUrl, 'goto-missing-frame', [{
      id: 'frame-step', intent: 'Recover in a missing child frame', action: 'click', target: { ...target('never'), scope: { framePath: ['child'] } }, pageUrl: `${fixture.baseUrl}/start`,
      recoverableErrors: [{ description: 'missing frame recovery', when: { redirectedToGlob: '**/login.aspx*' }, do: [{ action: 'gotoStepPage', riskClass: 'safe', idempotent: true, expectsDialog: false }], maxAttempts: 1 }],
      riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);
    const result = await replay(fixture, capability);
    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('RECOVERY_FAILED');
  });

  it('does not escalate an auth failure into main-flow reconstruction', async () => {
    let escalations = 0;
    const fixture = await startFixture((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<p>Start</p>'));
    });
    const capability = CapabilityArtifactSchema.parse({
      ...artifact(fixture.baseUrl, 'auth-guard', [{ id: 'post-auth', intent: 'Post-auth sentinel', action: 'wait', waitDurationMs: 250, recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false }]),
      authPhase: {
        steps: [{ id: 'auth-fail', intent: 'Missing auth control', action: 'click', target: target('missing-auth'), recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false }],
      },
    });
    const result = await replayCapability(capability, {
      env: { baseUrl: fixture.baseUrl }, inputs: {}, headless: true,
      runsDir: fixture.runsDir, capabilitiesDir: fixture.ledgerDir,
      onEscalation: async () => { escalations += 1; return true; },
    });
    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('AUTH_FAILED');
    expect(escalations).toBe(0);
  });
});
