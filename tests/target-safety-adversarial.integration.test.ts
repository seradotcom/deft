import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Express } from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { DiscoveryRun, type DiscoveryResult } from '../src/agent/discover.js';
import { compileCapability } from '../src/agent/compiler.js';
import type { Planner } from '../src/agent/planner.js';
import { CapabilityArtifactSchema, type Step } from '../src/core/artifact.js';
import { replayCapability } from '../src/replay/engine.js';
import { defaultPolicy } from '../src/safety/policy.js';
import { PlaywrightWebDriver } from '../src/surface/driver.js';
import { buildTargetDescriptor, resolveDescriptor } from '../src/surface/targeting.js';

type Fixture = { baseUrl: string; root: string; server: Server };
const fixtures: Fixture[] = [];
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-logging', '--log-level=3'],
    env: { ...process.env, CHROME_LOG_FILE: path.join(os.tmpdir(), 'deft-target-safety-chrome.log') },
  });
});
afterAll(async () => { await browser.close(); });
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ server, root }) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }));
});

async function serve(configure: (app: Express) => void): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deft-target-safety-'));
  const app = express();
  configure(app);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const fixture = { baseUrl: `http://127.0.0.1:${address.port}`, root, server };
  fixtures.push(fixture);
  return fixture;
}

function byId(id: string, framePath: string[] = []) {
  return {
    primary: { kind: 'id' as const, id },
    fallbacks: [],
    scope: { framePath },
    quality: 'verified' as const,
  };
}

function artifact(
  baseUrl: string,
  id: string,
  steps: Step[],
  outputs: Record<string, unknown> = { type: 'object', properties: {}, required: [], additionalProperties: false },
  successCondition: Record<string, unknown> = { allOf: [{ assert: 'pageTextContains', text: 'DONE' }] }
) {
  const now = new Date().toISOString();
  return CapabilityArtifactSchema.parse({
    schemaVersion: '1', kind: 'Capability',
    metadata: {
      id: `adversarial.${id}`, name: `${id} adversarial fixture`,
      description: `Deterministic target-safety acceptance fixture for ${id}.`,
      version: '1.0.0', status: 'draft', createdAt: now, updatedAt: now,
    },
    target: { appFamily: 'adversarial', surfaceType: 'web-modern', entryUrlTemplate: `${baseUrl}/start`, variants: [] },
    inputs: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputs,
    environmentBindings: {}, steps, businessOutcomes: [],
    successCondition,
    riskPolicy: { onRiskyStep: 'require_approval' },
    redaction: { sensitiveInputNames: [], notes: '' }, provenance: {},
  });
}

async function replay(fixture: Fixture, capability: unknown) {
  return replayCapability(capability, {
    env: { baseUrl: fixture.baseUrl }, inputs: {}, headless: true,
    runsDir: path.join(fixture.root, 'runs'), capabilitiesDir: path.join(fixture.root, 'ledger'),
  });
}

describe('target and surface policy fail-closed behavior', () => {
  it('blocks a hostile top-level redirect before replay interaction', async () => {
    let hostileClicks = 0;
    const hostile = await serve((app) => {
      app.get('/hostile', (_req, res) => res.type('html').send('<form method="post" action="/clicked"><button id="act">Act</button></form>'));
      app.post('/clicked', (_req, res) => { hostileClicks += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const trusted = await serve((app) => {
      // The target is deliberately absent on the trusted page. Resolution is
      // waiting when the top surface drifts, then the same selector appears on
      // the hostile origin. The redirect is delayed enough not to race the
      // engine's entry-evidence screenshot.
      app.get('/start', (_req, res) => res.type('html').send(`<p>Loading trusted control</p><script>setTimeout(()=>location.href='${hostile.baseUrl}/hostile',700)</script>`));
    });
    const capability = artifact(trusted.baseUrl, 'top-redirect', [{
      id: 'act-on-trusted-only', intent: 'Act only on the trusted surface', action: 'click',
      target: byId('act'), recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(trusted, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
    expect(hostileClicks).toBe(0);
  });

  it('blocks replay interaction inside a hostile child frame with zero server-side effects', async () => {
    let hostileClicks = 0;
    const hostile = await serve((app) => {
      app.get('/frame', (_req, res) => res.type('html').send('<form method="post" action="/clicked"><button id="boom">Boom</button></form>'));
      app.post('/clicked', (_req, res) => { hostileClicks += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`<iframe name="hostile" src="${hostile.baseUrl}/frame"></iframe>`));
    });
    const capability = artifact(trusted.baseUrl, 'hostile-child-replay', [{
      id: 'blocked-child-action', intent: 'Refuse the hostile child action', action: 'click',
      target: byId('boom', ['hostile']), recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(trusted, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
    expect(hostileClicks).toBe(0);
  });

  it('blocks discovery interaction inside a hostile child frame with zero server-side effects', async () => {
    let hostileClicks = 0;
    const hostile = await serve((app) => {
      app.get('/frame', (_req, res) => res.type('html').send('<form method="post" action="/clicked"><button id="boom">Boom</button></form>'));
      app.post('/clicked', (_req, res) => { hostileClicks += 1; res.type('html').send('<p>clicked</p>'); });
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`<iframe name="hostile" src="${hostile.baseUrl}/frame"></iframe>`));
    });
    const planner: Planner = {
      async decide(input) {
        const ref = Object.entries(input.observation.refIndex).find(([, value]) => /button.*Boom/i.test(value.yamlLine))?.[0];
        if (!ref) throw new Error('hostile button ref was not observed');
        return {
          decision: { action: { type: 'click', hint: { elementRef: ref } }, rawCallName: 'click' },
          assistantParts: [],
        };
      },
    };
    const run = new DiscoveryRun(
      { goal: 'test hostile child policy', baseUrl: trusted.baseUrl, entryUrl: `${trusted.baseUrl}/start` },
      planner, defaultPolicy(trusted.baseUrl),
      { maxSteps: 1, headed: false, viewport: { width: 1440, height: 900 }, runsDir: path.join(trusted.root, 'discovery') }
    );

    await expect(run.run()).rejects.toThrow(/outside policy/i);

    expect(hostileClicks).toBe(0);
  });

  it('blocks a hostile auth redirect before writing credentials or calling the planner', async () => {
    let hostileUsernameWrites = 0;
    let hostilePasswordWrites = 0;
    let hostileSubmits = 0;
    let plannerCalls = 0;
    const hostile = await serve((app) => {
      app.post('/username-written', (_req, res) => { hostileUsernameWrites += 1; res.sendStatus(204); });
      app.post('/password-written', (_req, res) => { hostilePasswordWrites += 1; res.sendStatus(204); });
      app.post('/submitted', (_req, res) => { hostileSubmits += 1; res.type('html').send('<p>hostile authenticated shell</p>'); });
      app.get('/login', (_req, res) => res.type('html').send(`
        <form method="post" action="/submitted">
          <input id="username" oninput="fetch('/username-written',{method:'POST'})">
          <input id="password" type="password" oninput="fetch('/password-written',{method:'POST'})">
          <button id="submit" type="submit">Sign in</button>
        </form>
      `));
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.redirect(302, `${hostile.baseUrl}/login`));
    });
    const planner: Planner = {
      async decide() {
        plannerCalls += 1;
        return {
          decision: { action: { type: 'done', summary: 'must never observe hostile UI', outputs: {} }, rawCallName: 'done' },
          assistantParts: [],
        };
      },
    };
    const run = new DiscoveryRun(
      { goal: 'authenticate only on trusted surfaces', baseUrl: trusted.baseUrl, entryUrl: `${trusted.baseUrl}/start` },
      planner, defaultPolicy(trusted.baseUrl),
      {
        maxSteps: 1, headed: false, viewport: { width: 1440, height: 900 },
        runsDir: path.join(trusted.root, 'hostile-auth-redirect'),
        auth: {
          userSelector: '#username', passSelector: '#password', submitSelector: '#submit',
          username: 'operator', password: 'secret',
        },
      }
    );

    await expect(run.run()).rejects.toThrow(/outside policy/i);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(hostileUsernameWrites).toBe(0);
    expect(hostilePasswordWrites).toBe(0);
    expect(hostileSubmits).toBe(0);
    expect(plannerCalls).toBe(0);
  });

  it('refuses to bind discovery outputs from a hostile child frame', async () => {
    const hostile = await serve((app) => {
      app.get('/frame', (_req, res) => res.type('html').send('<table><tr><th>Member ID</th><th>Balance</th></tr><tr><td>M1</td><td>$99</td></tr></table>'));
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`<iframe name="hostile" src="${hostile.baseUrl}/frame"></iframe>`));
    });
    const planner: Planner = {
      async decide() {
        return {
          decision: { action: { type: 'done', summary: 'found hostile balance', outputs: { balance: '$99' } }, rawCallName: 'done' },
          assistantParts: [],
        };
      },
    };
    const run = new DiscoveryRun(
      { goal: 'do not trust hostile output', baseUrl: trusted.baseUrl, entryUrl: `${trusted.baseUrl}/start` },
      planner, defaultPolicy(trusted.baseUrl),
      { maxSteps: 1, headed: false, viewport: { width: 1440, height: 900 }, runsDir: path.join(trusted.root, 'hostile-output-discovery') }
    );

    await expect(run.run()).rejects.toThrow(/outside policy/i);
  });

  it('does not finish discovery when a declared output cannot be bound', async () => {
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<p>Result is visible, but not in a bindable table.</p>'));
    });
    const planner: Planner = {
      async decide() {
        return {
          decision: { action: { type: 'done', summary: 'found an unbound value', outputs: { foo: 'bar' } }, rawCallName: 'done' },
          assistantParts: [],
        };
      },
    };
    const run = new DiscoveryRun(
      { goal: 'return every declared output', baseUrl: trusted.baseUrl, entryUrl: `${trusted.baseUrl}/start` },
      planner, defaultPolicy(trusted.baseUrl),
      { maxSteps: 1, headed: false, viewport: { width: 1440, height: 900 }, runsDir: path.join(trusted.root, 'unbound-output-discovery') }
    );

    const result = await run.run();

    expect(result.endState).not.toBe('DONE');
    expect(result.outputBindings).toBeUndefined();
    expect(result.summary).toMatch(/foo.*not bound/i);
  });

  it('enforces child-frame policy before extracting hostile text', async () => {
    const hostile = await serve((app) => {
      app.get('/frame', (_req, res) => res.type('html').send('<div id="secret">HOSTILE SECRET</div><p>DONE</p>'));
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`<iframe name="hostile" src="${hostile.baseUrl}/frame"></iframe>`));
    });
    const capability = artifact(trusted.baseUrl, 'hostile-child-extract', [{
      id: 'extract-hostile', intent: 'Refuse data extraction from a hostile frame', action: 'extract',
      outputKey: 'secret',
      extract: { strategy: 'text', target: byId('secret', ['hostile']) },
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }], {
      type: 'object', properties: { secret: { type: 'string' } }, required: ['secret'], additionalProperties: false,
    });

    const result = await replay(trusted, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
    expect(result.outputs).toBeUndefined();
  });

  it('enforces child-frame policy before evaluating a hostile element checkpoint', async () => {
    const hostile = await serve((app) => {
      app.get('/frame', (_req, res) => res.type('html').send('<div id="checkpoint">DONE</div>'));
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`<iframe name="hostile" src="${hostile.baseUrl}/frame"></iframe>`));
    });
    const capability = artifact(trusted.baseUrl, 'hostile-child-check', [{
      id: 'check-hostile', intent: 'Refuse a checkpoint on a hostile frame', action: 'check',
      postCheck: { assert: 'elementVisible', target: byId('checkpoint', ['hostile']), timeoutMs: 500 },
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(trusted, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
  });

  it('rejects a navigation whose allowed target redirects to a hostile actual URL', async () => {
    const hostile = await serve((app) => {
      app.get('/landing', (_req, res) => res.type('html').send('<p>DONE</p>'));
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<p>Start</p>'));
      app.get('/redirect', (_req, res) => res.redirect(302, `${hostile.baseUrl}/landing`));
    });
    const capability = artifact(trusted.baseUrl, 'redirect-actual-url', [{
      id: 'navigate-trusted', intent: 'Navigate only if the final URL remains trusted', action: 'navigate',
      valueTemplate: `${trusted.baseUrl}/redirect`, recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(trusted, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
  });

  it('does not accept targetless DONE text from a hostile child as a success checkpoint', async () => {
    const hostile = await serve((app) => {
      app.get('/frame', (_req, res) => res.type('html').send('<p>DONE</p>'));
    });
    const trusted = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`<iframe name="hostile" src="${hostile.baseUrl}/frame"></iframe>`));
    });
    const capability = artifact(trusted.baseUrl, 'hostile-targetless-checkpoint', [{
      id: 'settle', intent: 'Wait without interacting', action: 'wait', waitDurationMs: 20,
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(trusted, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
  });

  it('prevents an unapproved type+Enter submit from reaching the server', async () => {
    let submissions = 0;
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<form method="post" action="/submit"><input id="field" name="field"></form>'));
      app.post('/submit', (_req, res) => { submissions += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const capability = artifact(fixture.baseUrl, 'enter-submit-runtime', [{
      id: 'fill-field', intent: 'Fill the form field', action: 'fill', target: byId('field'), valueTemplate: 'value',
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }, {
      id: 'submit-enter', intent: 'Press Enter to submit the form', action: 'press', target: byId('field'), keyCombo: 'Enter',
      submission: 'SUBMIT', recoverableErrors: [], riskClass: 'risky', idempotent: false, expectsDialog: false,
    }]);

    const result = await replay(fixture, capability);

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('RISKY_STEP_BLOCKED');
    expect(submissions).toBe(0);
  });

  it('requires explicit submit semantics for a resolved submit control', async () => {
    let submissions = 0;
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<form method="post" action="/submit"><button id="submit">Search</button></form>'));
      app.post('/submit', (_req, res) => { submissions += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const undeclared = artifact(fixture.baseUrl, 'undeclared-click-submit', [{
      id: 'submit-search', intent: 'Submit a declared read-only search', action: 'click', target: byId('submit'),
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);
    const declared = artifact(fixture.baseUrl, 'declared-click-submit', [{
      id: 'submit-search', intent: 'Submit a declared read-only search', action: 'click', target: byId('submit'),
      submission: 'SUBMIT', recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const blocked = await replay(fixture, undeclared);
    expect(blocked.status).toBe('FAILED');
    expect(blocked.failure?.errorClass).toBe('ARTIFACT_INVALID');
    expect(submissions).toBe(0);

    const allowed = await replay(fixture, declared);
    expect(allowed.status).toBe('SUCCESS');
    expect(submissions).toBe(1);
  });

  it('hit-tests coordinate fallback and blocks an undeclared submit', async () => {
    let submissions = 0;
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<form method="post" action="/submit"><button style="position:fixed;left:700px;top:420px;width:80px;height:60px">Submit</button></form>'));
      app.post('/submit', (_req, res) => { submissions += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const capability = artifact(fixture.baseUrl, 'coordinate-submit', [{
      id: 'coordinate-submit', intent: 'Never submit through undeclared coordinates', action: 'click',
      target: { primary: { kind: 'coordinate', space: 'viewport-grid', x: 514, y: 500 }, fallbacks: [], scope: { framePath: [] }, quality: 'coordinate-only' },
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(fixture, capability);
    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('ARTIFACT_INVALID');
    expect(submissions).toBe(0);
  });
});

describe('compiler and resolver ambiguity contracts', () => {
  it('compiles type+Enter as an explicitly risky, non-idempotent submit', () => {
    const result: DiscoveryResult = {
      runId: 'run-submit', endState: 'DONE', finalUrl: 'http://example.test/form',
      steps: [{
        seq: 1, ts: new Date().toISOString(),
        action: { type: 'type', text: 'value', pressEnter: true, hint: { x: 500, y: 500 } },
        descriptor: byId('field'), ok: true, urlBefore: 'http://example.test/form', urlAfter: 'http://example.test/result', dialogEvents: [],
      }],
    };
    const compiled = compileCapability(result, {
      appFamily: 'example', capabilityIdBase: 'example.submit-form', name: 'Submit form',
      description: 'Submit a synthetic form through an Enter-terminated fill.',
      entryUrlTemplate: 'http://example.test/form', inputs: { value: 'value' },
      outputsSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, plannerModel: 'test', artifactVersion: '1.0.0',
    });
    const submit = compiled.steps.find((step) => step.action === 'press');

    expect(submit).toBeDefined();
    expect(submit?.submission).toBe('SUBMIT');
    expect(submit?.idempotent).toBe(false);
    expect(submit?.riskClass).toBe('risky');
  });

  it('persists explicit SUBMIT semantics for a recorded submit-control click', () => {
    const descriptor = {
      ...byId('search'),
      fingerprint: { tag: 'button', attributes: { type: 'submit' } },
    };
    const result: DiscoveryResult = {
      runId: 'run-click-submit', endState: 'DONE', finalUrl: 'http://example.test/results',
      steps: [{
        seq: 1, ts: new Date().toISOString(), action: { type: 'click', hint: { x: 500, y: 500 } },
        descriptor, facts: {
          tag: 'button', role: 'button', accessibleName: 'Search', typeAttr: 'submit', submitControl: true,
          framePath: [], rect: { x: 10, y: 10, width: 20, height: 20 }, ordinalInParent: 0,
        },
        ok: true, urlBefore: 'http://example.test/form', urlAfter: 'http://example.test/results', dialogEvents: [],
      }],
    };
    const compiled = compileCapability(result, {
      appFamily: 'example', capabilityIdBase: 'example.search', name: 'Search',
      description: 'Submit a reviewed read-only search control.', entryUrlTemplate: 'http://example.test/form',
      inputs: {}, outputsSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }, plannerModel: 'test', artifactVersion: '1.0.0',
    });

    expect(compiled.steps[0]?.submission).toBe('SUBMIT');
    expect(compiled.steps[0]?.riskClass).toBe('safe');
    expect(compiled.steps[0]?.idempotent).toBe(true);
  });

  it('recounts a locator that changes from zero to many and refuses coordinate fallback', async () => {
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <div id="mount"></div>
        <script>setTimeout(()=>mount.innerHTML='<button class="late">Late</button><button class="late">Late</button>',50)</script>
      `));
    });
    const page = await browser.newPage();
    await page.goto(`${fixture.baseUrl}/start`);
    const outcome = await resolveDescriptor(page, {
      primary: { kind: 'role', role: 'button', name: 'Late', exact: true },
      fallbacks: [{ kind: 'coordinate', space: 'viewport-grid', x: 500, y: 500 }],
      scope: { framePath: [] }, quality: 'verified',
    }, { timeoutMs: 1000 });
    await page.close();

    expect(outcome.status).toBe('not-found');
    expect(outcome.attempts.some((attempt) => /AMBIGUOUS: 2/.test(attempt.why))).toBe(true);
  });

  it('rejects a duplicate semantic probe even when the marked element is the first match', async () => {
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<button class="duplicate">Duplicate</button><button class="duplicate">Duplicate</button>'));
    });
    const driver = new PlaywrightWebDriver({ headless: true });
    await driver.start();
    await driver.page.goto(`${fixture.baseUrl}/start`);
    const first = driver.page.getByRole('button', { name: 'Duplicate', exact: true }).first();
    const box = await first.boundingBox();
    if (!box) throw new Error('first duplicate button was not visible');
    const facts = await driver.factsAtGridPoint(
      Math.round(((box.x + box.width / 2) / 1440) * 999),
      Math.round(((box.y + box.height / 2) / 900) * 999)
    );
    if (!facts) throw new Error('duplicate button facts unavailable');
    const descriptor = await buildTargetDescriptor(driver, facts, { width: 1440, height: 900 });
    await driver.close();

    expect(descriptor.quality).toBe('coordinate-only');
    expect(descriptor.primary.kind).toBe('coordinate');
  });

  it('recounts a locator that changes from one to many while waiting and refuses coordinate fallback', async () => {
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <button class="late" style="display:none">Late</button><div id="mount"></div>
        <script>setTimeout(()=>{mount.innerHTML='<button class="late">Late</button>';document.querySelector('.late').style.display='block'},50)</script>
      `));
    });
    const page = await browser.newPage();
    await page.goto(`${fixture.baseUrl}/start`);
    const outcome = await resolveDescriptor(page, {
      primary: { kind: 'role', role: 'button', name: 'Late', exact: true },
      fallbacks: [{ kind: 'coordinate', space: 'viewport-grid', x: 500, y: 500 }],
      scope: { framePath: [] }, quality: 'verified',
    }, { timeoutMs: 1000 });
    await page.close();

    expect(outcome.status).toBe('not-found');
    expect(outcome.attempts.some((attempt) => /AMBIGUOUS: 2/.test(attempt.why))).toBe(true);
  });

  it('fails closed when any frame-path segment is missing instead of resolving in a parent frame', async () => {
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send('<button id="danger">Danger</button>'));
    });
    const page = await browser.newPage();
    await page.goto(`${fixture.baseUrl}/start`);
    const outcome = await resolveDescriptor(page, {
      primary: { kind: 'id', id: 'danger' }, fallbacks: [],
      scope: { framePath: ['missing-child'] }, quality: 'verified',
    }, { timeoutMs: 300 });
    await page.close();

    expect(outcome.status).toBe('not-found');
  });

  it('rejects a discovered extraction binding whose persisted row key is not unique', async () => {
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <table>
          <tr><th>Member ID</th><th>Balance</th></tr>
          <tr><td>M1</td><td>$10</td></tr>
          <tr><td>M1</td><td>$20</td></tr>
        </table>
      `));
    });
    const planner: Planner = {
      async decide() {
        return {
          decision: { action: { type: 'done', summary: 'found balance', outputs: { balance: '$10' } }, rawCallName: 'done' },
          assistantParts: [],
        };
      },
    };
    const run = new DiscoveryRun(
      { goal: 'read one balance safely', baseUrl: fixture.baseUrl, entryUrl: `${fixture.baseUrl}/start` },
      planner, defaultPolicy(fixture.baseUrl),
      { maxSteps: 1, headed: false, viewport: { width: 1440, height: 900 }, runsDir: path.join(fixture.root, 'row-key-discovery') }
    );

    await expect(run.run()).rejects.toThrow(/row identity is not unique/i);
  });

  it('rejects a row identity duplicated across separate tables', async () => {
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <table><tr><th>Member ID</th><th>Balance</th></tr><tr><td>M1</td><td>$10</td></tr></table>
        <table><tr><th>Member ID</th><th>Balance</th></tr><tr><td>M1</td><td>$20</td></tr></table>
      `));
    });
    const planner: Planner = {
      async decide() {
        return {
          decision: { action: { type: 'done', summary: 'found balance', outputs: { balance: '$10' } }, rawCallName: 'done' },
          assistantParts: [],
        };
      },
    };
    const run = new DiscoveryRun(
      { goal: 'read one balance safely', baseUrl: fixture.baseUrl, entryUrl: `${fixture.baseUrl}/start` },
      planner, defaultPolicy(fixture.baseUrl),
      { maxSteps: 1, headed: false, viewport: { width: 1440, height: 900 }, runsDir: path.join(fixture.root, 'cross-table-row-key') }
    );

    await expect(run.run()).rejects.toThrow(/row identity is not unique/i);
  });
});

describe('coordinate-space execution', () => {
  it('executes viewport-grid on the live viewport and frame-px relative to the live child frame', async () => {
    let viewportClicks = 0;
    let frameClicks = 0;
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <a href="/viewport-click" style="position:fixed;display:block;left:700px;top:420px;width:80px;height:60px">Viewport</a>
      `));
      app.get('/viewport-click', (_req, res) => { viewportClicks += 1; res.type('html').send('<p>DONE</p>'); });
      app.get('/frame-shell', (_req, res) => res.type('html').send('<iframe name="child" style="position:absolute;left:300px;top:200px;width:300px;height:200px;border:0" src="/frame"></iframe>'));
      app.get('/frame', (_req, res) => res.type('html').send('<a href="/frame-click" style="position:absolute;display:block;left:30px;top:20px;width:80px;height:60px">Frame</a>'));
      app.get('/frame-click', (_req, res) => { frameClicks += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const viewportCapability = artifact(fixture.baseUrl, 'viewport-grid', [{
      id: 'viewport-click', intent: 'Click using live viewport grid coordinates', action: 'click',
      target: { primary: { kind: 'coordinate', space: 'viewport-grid', x: 514, y: 500 }, fallbacks: [], scope: { framePath: [] }, quality: 'coordinate-only' },
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);
    const frameCapability = artifact(fixture.baseUrl, 'frame-px', [{
      id: 'open-shell', intent: 'Open the child-frame shell', action: 'navigate', valueTemplate: `${fixture.baseUrl}/frame-shell`, recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }, {
      id: 'frame-click', intent: 'Click using frame-local pixels', action: 'click',
      target: { primary: { kind: 'coordinate', space: 'frame-px', x: 70, y: 50 }, fallbacks: [], scope: { framePath: ['child'] }, quality: 'coordinate-only' },
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const viewportResult = await replay(fixture, viewportCapability);
    const frameResult = await replay(fixture, frameCapability);

    expect(viewportResult.status).toBe('SUCCESS');
    expect(frameResult.status).toBe('SUCCESS');
    expect(viewportClicks).toBe(1);
    expect(frameClicks).toBe(1);
  });

  it('rejects an out-of-frame frame-px coordinate without clicking a parent control', async () => {
    let parentDangerClicks = 0;
    const fixture = await serve((app) => {
      app.get('/start', (_req, res) => res.type('html').send(`
        <form method="post" action="/parent-danger"><button style="position:absolute;left:760px;top:670px;width:80px;height:60px">Parent danger</button></form>
        <iframe name="child" style="position:absolute;left:300px;top:200px;width:100px;height:100px;border:0" src="/empty-frame"></iframe>
      `));
      app.get('/empty-frame', (_req, res) => res.type('html').send('<p>Empty child</p>'));
      app.post('/parent-danger', (_req, res) => { parentDangerClicks += 1; res.type('html').send('<p>DONE</p>'); });
    });
    const capability = artifact(fixture.baseUrl, 'frame-coordinate-bounds', [{
      id: 'frame-coordinate', intent: 'Refuse a coordinate outside the child frame', action: 'click',
      target: { primary: { kind: 'coordinate', space: 'frame-px', x: 500, y: 500 }, fallbacks: [], scope: { framePath: ['child'] }, quality: 'coordinate-only' },
      recoverableErrors: [], riskClass: 'safe', idempotent: true, expectsDialog: false,
    }]);

    const result = await replay(fixture, capability);

    expect(result.status).toBe('FAILED');
    expect(parentDangerClicks).toBe(0);
  });
});
