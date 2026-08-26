/**
 * Integration test for the targeting pipeline (no LLM involved):
 *   hit-test → buildTargetDescriptor (live probing) → resolveDescriptor on a
 * FRESH session. Proves recorded descriptors survive session restarts —
 * the property deterministic replay depends on.
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { chromium, type Browser } from 'playwright';
import { createLegacyBankApp } from '../src/targets/legacybank/server.js';
import { PlaywrightWebDriver } from '../src/surface/driver.js';
import { buildTargetDescriptor, resolveDescriptor } from '../src/surface/targeting.js';
import { DEMO_USER } from '../src/targets/legacybank/data.js';
import os from 'node:os';
import path from 'node:path';

let server: Server;
let baseUrl = '';
const browser: Browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu', '--disable-logging', '--log-level=3'],
  env: { ...process.env, CHROME_LOG_FILE: path.join(os.tmpdir(), 'deft-targeting-chrome.log') },
});

beforeAll(async () => {
  const app = createLegacyBankApp() as express.Express;
  await new Promise<void>((resolve) => {
    server = createServer(app);
    server.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function loginAndGoToSearch(driver: PlaywrightWebDriver): Promise<void> {
  // Test scaffolding uses direct selectors; the SYSTEM under test (targeting)
  // is exercised after we reach the search screen.
  const p = driver.page;
  await p.goto(`${baseUrl}/acme/login.aspx`);
  await p.fill('#ctl00_ContentPlaceHolder1_txtUserId', DEMO_USER.userId);
  await p.fill('#ctl00_ContentPlaceHolder1_txtPassword', DEMO_USER.password);
  await Promise.all([p.waitForURL('**/main.aspx'), p.click('#ctl00_ContentPlaceHolder1_btnSignIn')]);
  await p.goto(`${baseUrl}/acme/search.aspx`);
}

describe('record-time verified targeting', () => {
  it('builds verified descriptors and resolves them on a fresh session', async () => {
    // --- record pass -------------------------------------------------------
    const recorder = new PlaywrightWebDriver({ headless: true });
    await recorder.start();
    await loginAndGoToSearch(recorder);
    expect(recorder.currentUrl()).toContain('/search.aspx');

    // Hit-test the member id textbox and the search button by converting their
    // real bounding-box centers to grid coords (tests OUR grid→px→frame path).
    const VP = { width: 1440, height: 900 };
    const toGrid = (b: { x: number; y: number; width: number; height: number }) => ({
      x: Math.round(((b.x + b.width / 2) / VP.width) * 999),
      y: Math.round(((b.y + b.height / 2) / VP.height) * 999),
    });

    const boxInput = await recorder.page.locator('#ctl00_ContentPlaceHolder1_txtMemberId').boundingBox();
    expect(boxInput).not.toBeNull();
    const gInput = toGrid(boxInput!);
    const factsInput = await recorder.factsAtGridPoint(gInput.x, gInput.y);
    expect(factsInput).not.toBeNull();
    expect(factsInput!.tag).toBe('input');
    expect(factsInput!.role).toBe('textbox');

    const descInput = await buildTargetDescriptor(recorder, factsInput!, VP);
    expect(descInput.quality).toBe('verified');
    expect(['role', 'label', 'placeholder', 'name']).toContain(descInput.primary.kind);

    const boxBtn = await recorder.page.locator('#ctl00_ContentPlaceHolder1_btnSearch').boundingBox();
    expect(boxBtn).not.toBeNull();
    const gBtn = toGrid(boxBtn!);
    const factsBtn = await recorder.factsAtGridPoint(gBtn.x, gBtn.y);
    expect(factsBtn).not.toBeNull();
    expect(factsBtn!.role).toBe('button');
    const descBtn = await buildTargetDescriptor(recorder, factsBtn!, VP);
    expect(descBtn.quality).toBe('verified');
    expect(descBtn.primary.kind).toBe('role');

    await recorder.close();

    // --- replay pass (fresh browser context & session) ----------------------
    const replayer = new PlaywrightWebDriver({ headless: true });
    await replayer.start();
    const page = replayer.page;
    await loginAndGoToSearch(replayer);

    const resInput = await resolveDescriptor(page, descInput, { timeoutMs: 6000 });
    expect(resInput.status).toBe('resolved');
    expect(resInput.degraded).toBe(false);

    const resBtn = await resolveDescriptor(page, descBtn, { timeoutMs: 6000 });
    expect(resBtn.status).toBe('resolved');
    expect(resBtn.degraded).toBe(false);
    expect(await resBtn.locator!.getAttribute('value')).toBe('Find Member');

    await replayer.close();
  });

  it('flags degraded when only coordinates remain and honors skipCoordinateFallback', async () => {
    const driver = new PlaywrightWebDriver({ headless: true });
    await driver.start();
    await driver.act({ type: 'navigate', url: `${baseUrl}/acme/login.aspx` });

    const coordinateOnly = {
      primary: { kind: 'coordinate' as const, x: 500, y: 300 },
      fallbacks: [],
      scope: { framePath: [] as string[] },
    };
    const page = driver.page;
    const outcome = await resolveDescriptor(page, coordinateOnly, { timeoutMs: 1000 });
    expect(outcome.status).toBe('coordinate-fallback');
    expect(outcome.degraded).toBe(true);

    const skipped = await resolveDescriptor(page, coordinateOnly, {
      timeoutMs: 1000,
      skipCoordinateFallback: true,
    });
    expect(skipped.status).toBe('not-found');
    await driver.close();
  });

  it('never falls back to the parent frame when a declared child frame is missing', async () => {
    const page = await browser.newPage();
    await page.setContent('<button id="same">main only</button>');
    const outcome = await resolveDescriptor(page, {
      primary: { kind: 'id', id: 'same' },
      fallbacks: [],
      scope: { framePath: ['missing-child'] },
    }, { timeoutMs: 100 });
    expect(outcome.status).toBe('not-found');
    await page.close();
  });

  it('recounts after waiting and rejects a zero-to-many locator transition', async () => {
    const page = await browser.newPage();
    await page.setContent('<div id="host"></div><script>setTimeout(() => { host.innerHTML = "<button id=\'late\'>A</button><button id=\'late\'>B</button>"; }, 30)</script>');
    const outcome = await resolveDescriptor(page, {
      primary: { kind: 'id', id: 'late' },
      fallbacks: [],
      scope: { framePath: [] },
    }, { timeoutMs: 500 });
    expect(outcome.status).toBe('not-found');
    expect(outcome.attempts.some((attempt) => /AMBIGUOUS/.test(attempt.why))).toBe(true);
    await page.close();
  });
});
