import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { OperatorConsole } from '../src/hitl/operator-console.js';
import { PlaywrightWebDriver } from '../src/surface/driver.js';
import { createLegacyBankApp } from '../src/targets/legacybank/server.js';

const drivers: PlaywrightWebDriver[] = [];
const consoles: OperatorConsole[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close().catch(() => undefined)));
  await Promise.all(consoles.splice(0).map((console_) => console_.stop().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startDialogDriver(): Promise<PlaywrightWebDriver> {
  const driver = new PlaywrightWebDriver({ headless: true, viewport: { width: 800, height: 600 } });
  await driver.start();
  await driver.page.setContent('<button id="confirm" onclick="confirm(\'Proceed?\')">Confirm</button>');
  drivers.push(driver);
  return driver;
}

describe('native dialog human-control lease', () => {
  it('keeps normal automation auto-dismiss behavior', async () => {
    const driver = await startDialogDriver();

    await driver.page.locator('#confirm').click();

    expect(driver.drainEvents()).toEqual([
      expect.objectContaining({ kind: 'dialog', accepted: false }),
    ]);
  });

  it('holds a native dialog for one human session and resolves only with that session', async () => {
    const driver = await startDialogDriver();
    driver.beginHumanControl('session-a');

    await expect(driver.humanClickAt('session-b', 40, 20)).rejects.toThrow(/session/i);
    const click = driver.humanClickAt('session-a', 40, 20);
    await expect.poll(() => driver.humanDialogState()).toMatchObject({ pending: true, sessionId: 'session-a' });
    await expect(driver.resolveHumanDialog('session-b', 'accept')).rejects.toThrow(/session/i);

    await driver.resolveHumanDialog('session-a', 'accept');
    await click;
    expect(driver.drainEvents()).toEqual([
      expect.objectContaining({ kind: 'human_pointer', control: 'human', sessionId: 'session-a' }),
      expect.objectContaining({ kind: 'dialog', accepted: true, control: 'human', sessionId: 'session-a' }),
    ]);
    await driver.endHumanControl('session-a');
    expect(driver.humanDialogState()).toEqual({ pending: false });
  });
});

describe('operator console dialog lease', () => {
  it('reuses the existing listener when started repeatedly', async () => {
    const reservedPort = await reserveEphemeralPort();
    const console_ = new OperatorConsole(reservedPort, await tempDirectory());
    await console_.start();
    consoles.push(console_);

    await console_.start();

    expect(console_.baseUrl).toMatch(/127\.0\.0\.1/);
  });

  async function reserveEphemeralPort(): Promise<number> {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it('rejects resume while a native dialog is pending and cleans the lease on abort', async () => {
    const console_ = new OperatorConsole(0, await tempDirectory());
    await console_.start();
    consoles.push(console_);
    let pendingDialog = true;
    let begun = false;
    let current = 'before';
    let cleaned = false;
    const interventionResult = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'repair', sessionId: 'session-a',
      observation: observation(current), observeCurrent: async () => observation(current),
      dialogLease: {
        begin: () => { begun = true; },
        isPending: () => begun && pendingDialog,
        cleanup: async () => { pendingDialog = false; cleaned = true; },
      },
    });
    const [intervention] = console_.listInterventions();
    expect(begun).toBe(false);
    expect(intervention?.dialogPending).toBe(false);
    const base = `${console_.baseUrl}/api/interventions/${intervention!.id}`;
    expect((await fetch(`${base}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-b' }),
    })).status).toBe(409);
    expect(begun).toBe(false);
    expect((await fetch(`${base}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(200);
    expect(begun).toBe(true);
    const page = await (await fetch(`${console_.baseUrl}/`)).text();
    expect(page).toContain('Accept dialog');
    expect(page).toContain('Dismiss dialog');
    expect((await fetch(`${base}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(409);
    expect((await fetch(`${base}/abort`, { method: 'POST' })).status).toBe(200);
    expect(await interventionResult).toMatchObject({ state: 'ABORTED' });
    expect(cleaned).toBe(true);
    expect(pendingDialog).toBe(false);
  });
});

describe('operator console dialog resolution', () => {
  it('dispatches a screenshot-selected pointer only inside the matching human lease', async () => {
    const console_ = new OperatorConsole(0, await tempDirectory());
    await console_.start(); consoles.push(console_);
    let clicked = ''; let current = 'before';
    const result = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'pointer', sessionId: 'session-a',
      observation: observation(current), observeCurrent: async () => observation(current),
      dialogLease: {
        begin: () => undefined, isPending: () => false,
        clickAt: async (x, y) => { clicked = `${x},${y}`; current = 'after'; },
        cleanup: async () => undefined,
      },
    });
    const [intervention] = console_.listInterventions(); const base = `${console_.baseUrl}/api/interventions/${intervention!.id}`;
    await fetch(`${base}/takeover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }) });
    const html = await (await fetch(`${console_.baseUrl}/`)).text();
    expect(html).toContain('/pointer'); expect(html).toContain('Live session; click to control');
    const pointer = await fetch(`${base}/pointer`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a', x: 10, y: 20 }),
    });
    expect(pointer.status).toBe(200); expect(clicked).toBe('10,20');
    await fetch(`${base}/abort`, { method: 'POST' }); expect(await result).toMatchObject({ state: 'ABORTED' });
  });

  it('requires the takeover session and resolves before allowing resume', async () => {
    const console_ = new OperatorConsole(0, await tempDirectory());
    await console_.start();
    consoles.push(console_);
    let pending = false;
    let action = '';
    let current = 'before';
    let cleaned = false;
    const result = console_.requestAndWait({
      kind: 'manual_takeover', source: 'replay', reason: 'dialog', sessionId: 'session-a',
      observation: observation(current), observeCurrent: async () => observation(current),
      dialogLease: {
        begin: () => { pending = true; },
        isPending: () => pending,
        resolve: async (next) => { action = next; pending = false; current = 'after'; },
        cleanup: async () => { pending = false; cleaned = true; },
      },
    });
    const [intervention] = console_.listInterventions();
    const base = `${console_.baseUrl}/api/interventions/${intervention!.id}`;
    expect((await fetch(`${base}/takeover`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(200);
    expect((await fetch(`${base}/dialog`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-b', action: 'accept' }),
    })).status).toBe(409);
    expect((await fetch(`${base}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(409);
    expect((await fetch(`${base}/dialog`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a', action: 'accept' }),
    })).status).toBe(200);
    expect(action).toBe('accept');
    expect((await fetch(`${base}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'session-a' }),
    })).status).toBe(200);
    expect(await result).toMatchObject({ state: 'RESUMED', humanStateChanges: 1 });
    expect(cleaned).toBe(true);
  });
});

describe('LegacyBank modalOnPath fault injection', () => {
  let baseUrl = '';
  let cookie = '';

  beforeEach(async () => {
    const app = createLegacyBankApp() as express.Express;
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    const login = await fetch(`${baseUrl}/acme/login.aspx`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'ctl00%24ContentPlaceHolder1%24txtUserId=teller1&ctl00%24ContentPlaceHolder1%24txtPassword=Demo%212345' });
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  });

  it('adds the overlay only to the exact configured confirm path', async () => {
    const chaos = await fetch(`${baseUrl}/acme/admin/chaos-all`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modalOnPath: '/acme/confirmopen.aspx' }),
    });
    expect(chaos.status).toBe(200);

    const confirm = await fetch(`${baseUrl}/acme/confirmopen.aspx?id=M10041&type=Savings&nickname=Test&deposit=10`, { headers: { cookie } });
    expect(await confirm.text()).toContain('unexpected-overlay');

    const other = await fetch(`${baseUrl}/acme/detail.aspx?id=M10041`, { headers: { cookie } });
    expect(await other.text()).not.toContain('unexpected-overlay');
  });
});

function observation(text: string) {
  return {
    url: 'http://bank.test/app', title: 'Bank', screenshotBase64: Buffer.from(text).toString('base64'),
    viewport: { width: 800, height: 600 }, a11yAnnotatedYaml: text, refIndex: {}, frames: [], at: new Date().toISOString(),
  };
}

async function tempDirectory(): Promise<string> {
  const os = await import('node:os');
  const path = await import('node:path');
  return (await import('node:fs')).mkdtempSync(path.join(os.tmpdir(), 'deft-dialog-console-'));
}
