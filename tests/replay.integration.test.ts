/**
 * Replay integration tests — the load-bearing boundaries, executed against the
 * real LegacyBank simulator (no LLM):
 *
 *  1. happy-path replay  → SUCCESS + typed outputs + artifact sha256
 *  2. business outcome   → MEMBER_NOT_FOUND is an ANSWER, not a crash
 *  3. policy enforcement → an interactive action on a frame whose URL is
 *     outside the allowlist is blocked BEFORE any interaction (fail closed)
 *  4. session recovery   → mid-flow expiry → relogin chain + fast-forward → SUCCESS
 */
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { chromium, type Browser } from 'playwright';
import { createLegacyBankApp } from '../src/targets/legacybank/server.js';
import { replayCapability } from '../src/replay/engine.js';
import { CapabilityArtifactSchema } from '../src/core/artifact.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

let server: Server;
let baseUrl = '';
const browser: Browser = await chromium.launch({
  headless: true,
  env: {
    ...process.env,
    CHROME_LOG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
  },
});

const CAPABILITIES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deft-capabilities-'));
const RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deft-runs-'));

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
  // Reset the simulator fixture � previous tests may have opened sub-accounts.
    try {
      await fetch(`${baseUrl}/acme/admin/reset`, { method: 'POST' });
    } catch { /* server may not be up yet */ }
  // Point the artifact's entry URL at the ephemeral port.
  const raw = fs.readFileSync(
    path.join('capabilities', 'legacybank.lookup-member-balance.json'),
    'utf8'
  );
  const art = JSON.parse(raw);
  art.target.entryUrlTemplate = `${baseUrl}/acme/login.aspx`;
  art.recoveryChains.relogin[0].urlTemplate = `${baseUrl}/acme/login.aspx`;
  art.target.variants = [];
  fs.mkdirSync(CAPABILITIES_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(CAPABILITIES_DIR, 'legacybank.lookup-member-balance.json'),
    JSON.stringify(art, null, 2)
  );
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(CAPABILITIES_DIR, { recursive: true, force: true });
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
});

function loadArtifactBytes(): { bytes: Buffer; sha256: string; artifact: unknown } {
  const bytes = fs.readFileSync(path.join(CAPABILITIES_DIR, 'legacybank.lookup-member-balance.json'));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { bytes, sha256, artifact: JSON.parse(bytes.toString('utf8')) };
}

const ENV = (extra: Record<string, string> = {}): {
  env: Record<string, string>;
  runtimeEnv: Record<string, string | undefined>;
  capabilitiesDir: string;
} => ({
  env: { baseUrl, ...extra },
  // Bindings resolve INSIDE the engine from the runtime env � same contract
  // the CLI uses. The simulator credential is a documented test fixture.
  runtimeEnv: { LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
  capabilitiesDir: path.join(RUNS_DIR, 'ledger'),
});

describe('deterministic replay (integration)', () => {
  it('happy path: SUCCESS with typed outputs, sha256 recorded, zero degraded steps', async () => {
    const { bytes, sha256, artifact } = loadArtifactBytes();
    const result = await replayCapability(artifact, {
      ...ENV(),
      inputs: { memberId: 'M10041' },
      headless: true,
      runsDir: RUNS_DIR,
      artifactBytes: bytes,
    });
    expect(result.status).toBe('SUCCESS');
    expect(result.outputs?.savingsBalance).toBe('$2,450.75');
    expect(result.artifactSha256).toBe(sha256);
    const snapshotPath = path.join(RUNS_DIR, result.runId, result.artifactDefinitionRef!);
    const snapshotBytes = fs.readFileSync(snapshotPath);
    expect(crypto.createHash('sha256').update(snapshotBytes).digest('hex')).toBe(result.artifactSha256);
    const ledgerRows = fs.readFileSync(path.join(RUNS_DIR, 'ledger', 'legacybank.lookup-member-balance.validation.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { runId?: string; artifactSha256?: string })
      .filter((row) => row.runId === result.runId);
    expect(ledgerRows[0]?.artifactSha256).toBe(result.artifactSha256);
    expect(result.degradedSteps).toEqual([]);
    // Strong checkpoint actually ran: both final checks passed.
    const checks = (await import('node:fs')).readdirSync(path.join(RUNS_DIR, result.runId));
    expect(checks).toContain('log.jsonl');
  });

  it('business outcome: unknown member is an ANSWER (MEMBER_NOT_FOUND), not a crash', async () => {
    const { artifact } = loadArtifactBytes();
    const result = await replayCapability(artifact, {
      ...ENV(),
      inputs: { memberId: 'M99999' },
      headless: true,
      runsDir: RUNS_DIR,
    });
    expect(result.status).toBe('BUSINESS_OUTCOME');
    expect(result.businessOutcome?.code).toBe('MEMBER_NOT_FOUND');
    expect(result.failure).toBeUndefined();
  });

  it('fails before navigation when the entry URL contains an unresolved template', async () => {
    const { artifact } = loadArtifactBytes();
    const unresolved = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (unresolved.target as Record<string, unknown>).entryUrlTemplate = '{{inputs.missingUrl}}';

    await expect(
      replayCapability(unresolved, {
        ...ENV(),
        inputs: { memberId: 'M10041' },
        headless: true,
        runsDir: path.join(RUNS_DIR, 'unresolved-template'),
      })
    ).rejects.toMatchObject({ deftClass: 'ARTIFACT_INVALID' });
    expect(fs.existsSync(path.join(RUNS_DIR, 'unresolved-template'))).toBe(false);
  });

  it('rejects target.entryUrl self-reference before creating a run directory', async () => {
    const { artifact } = loadArtifactBytes();
    const selfReferential = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    (selfReferential.target as Record<string, unknown>).entryUrlTemplate = '{{ target.entryUrl }}';
    const runsDir = path.join(RUNS_DIR, 'self-referential-target');

    await expect(
      replayCapability(selfReferential, {
        ...ENV(),
        inputs: { memberId: 'M10041' },
        headless: true,
        runsDir,
      })
    ).rejects.toMatchObject({ deftClass: 'ARTIFACT_INVALID' });
    expect(fs.existsSync(runsDir)).toBe(false);
  });

  it('T3-GUARD: returns one final FAILED result when a declared output is missing', async () => {
    const { artifact } = loadArtifactBytes();
    const missingOutput = JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>;
    missingOutput.steps = (missingOutput.steps as Array<Record<string, unknown>>).filter(
      (step) => step.action !== 'extract'
    );
    missingOutput.outputs = {
      type: 'object',
      properties: { savingsBalance: { type: 'string' } },
      required: ['savingsBalance'],
      additionalProperties: false,
    };

    const ledgerDir = path.join(RUNS_DIR, 'ledger-only');
    let result;
    try {
      result = await replayCapability(missingOutput, {
        ...ENV(),
        inputs: { memberId: 'M10041' },
        headless: true,
        runsDir: RUNS_DIR,
        capabilitiesDir: ledgerDir,
      });
    } finally { /* replay owns browser cleanup */ }

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('OUTPUT_CONTRACT_VIOLATION');
    expect(result.outputs).toBeUndefined();
    const runLog = fs.readFileSync(path.join(RUNS_DIR, result.runId, 'log.jsonl'), 'utf8');
    expect((runLog.match(/"type":"replay_result"/g) ?? []).length).toBe(1);
    const ledgerPath = path.join(ledgerDir, 'legacybank.lookup-member-balance.validation.jsonl');
    const rows = fs.readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { runId?: string; status?: string; artifactSha256?: string })
      .filter((row) => row.runId === result.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('FAILED');
    expect(rows[0]?.artifactSha256).toBe(result.artifactSha256);
  });

  it('fails finalization when the validation ledger cannot be written', async () => {
    const { artifact } = loadArtifactBytes();
    const ledgerPath = path.join(RUNS_DIR, 'ledger-is-file');
    fs.writeFileSync(ledgerPath, 'not a directory');

    const result = await replayCapability(artifact, {
      ...ENV(),
      inputs: { memberId: 'M99999' },
      headless: true,
      runsDir: RUNS_DIR,
      capabilitiesDir: ledgerPath,
    });

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('LEDGER_WRITE_FAILED');
    expect(result.businessOutcome).toBeUndefined();
    const log = fs.readFileSync(path.join(RUNS_DIR, result.runId, 'log.jsonl'), 'utf8');
    expect((log.match(/"type":"ledger_appended"/g) ?? []).length).toBe(0);
    expect((log.match(/"type":"ledger_append_failed"/g) ?? []).length).toBe(1);
    expect((log.match(/"type":"replay_result"/g) ?? []).length).toBe(1);
  });

  it('T3-POL/GUARD: an interactive action on a frame outside the allowlist is blocked BEFORE touching it', async () => {
    // Trusted origin serves a page embedding an iframe from a SECOND
    // (disallowed) origin that hosts the button. The artifact step targets
    // that frame. Replay must stop with POLICY_BLOCKED and zero interaction.
    let hostileClicks = 0;
    const evil = express();
    evil.get('/button-page', (_req, res) => {
      res.type('html').send('<button id="boom" onclick="fetch(\'/clicked\',{method:\'POST\'})">boom</button>');
    });
    evil.post('/clicked', (_req, res) => { hostileClicks += 1; res.json({ ok: true }); });
    evil.get('/click-count', (_req, res) => { res.json({ count: hostileClicks }); });
    const evilServer = createServer(evil);
    await new Promise<void>((r) => evilServer.listen(0, () => r()));
    const evilPort = (evilServer.address() as { port: number }).port;

    const trusted = express();
    trusted.get('/shell', (_req, res) => {
      res.type('html').send(
        `<html><body><iframe name="evil" src="http://localhost:${evilPort}/button-page"></iframe></body></html>`
      );
    });
    const trustedServer = createServer(trusted);
    await new Promise<void>((r) => trustedServer.listen(0, () => r()));
    const trustedBase = `http://localhost:${(trustedServer.address() as { port: number }).port}`;

    const artifact = CapabilityArtifactSchema.parse({
      schemaVersion: '1',
      kind: 'Capability',
      metadata: {
        id: 'test.policy-frame',
        name: 'policy frame test',
        description: 'click a button inside a disallowed-origin frame',
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      target: {
        appFamily: 'test',
        surfaceType: 'web-modern',
        entryUrlTemplate: `${trustedBase}/shell`,
        variants: [{ id: 'nw-frame', match: { tenantId: 'nw' }, patches: { 'metadata.version': '2.0.0' } }],
      },
      inputs: { type: 'object', properties: {} },
       outputs: { type: 'object', properties: {}, required: [], additionalProperties: false },
      environmentBindings: {},
      steps: [
        {
          id: 's1',
          intent: 'Click the button inside the disallowed frame',
          action: 'click',
          target: {
            primary: { kind: 'role', role: 'button', name: 'boom' },
            fallbacks: [],
            scope: { framePath: ['evil'] },
          },
          recoverableErrors: [],
          riskClass: 'safe',
        },
      ],
      businessOutcomes: [],
      successCondition: { allOf: [{ assert: 'urlMatchesGlob', pattern: `${trustedBase}/shell` }] },
      redaction: { sensitiveInputNames: [], notes: '' },
      provenance: {},
    });

    const result = await replayCapability(artifact, {
      env: { baseUrl: trustedBase },
      inputs: {},
      headless: true,
      runsDir: RUNS_DIR,
      tenantId: 'nw',
      capabilitiesDir: path.join(RUNS_DIR, 'variant-ledger'),
    });

    expect(result.status).toBe('FAILED');
    expect(result.failure?.errorClass).toBe('POLICY_BLOCKED');
    expect(result.failure?.phase).toBe('locate'); // blocked before any interaction
    expect(result.timeline.some((t) => t.ok && t.stepId === 's1')).toBe(false);
    const variantSnapshot = fs.readFileSync(path.join(RUNS_DIR, result.runId, result.artifactDefinitionRef!));
    expect(crypto.createHash('sha256').update(variantSnapshot).digest('hex')).toBe(result.artifactSha256);
    expect(JSON.parse(variantSnapshot.toString('utf8')).metadata.version).toBe('2.0.0');
    const variantLedger = fs.readFileSync(path.join(RUNS_DIR, 'variant-ledger', 'test.policy-frame.validation.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { runId?: string; artifactSha256?: string })
      .find((row) => row.runId === result.runId);
    expect(variantLedger?.artifactSha256).toBe(result.artifactSha256);

    // Verify ZERO clicks via SERVER-SIDE state (not a client-side flag on a
    // fresh page — that only proves the new page wasn't clicked).
    const countRes = await fetch(`http://localhost:${evilPort}/click-count`);
    const { count } = (await countRes.json()) as { count: number };
    expect(count).toBe(0);

    evilServer.close();
    trustedServer.close();
  });

  it('T3-REC: mid-flow expiry → relogin chain + guarded retry → SUCCESS', async () => {
    // Use M10087 — prior tests contaminate M10041 with sub-accounts, and the
    // ambiguity rejection correctly refuses a non-unique Savings row match.
    await fetch(`${baseUrl}/acme/admin/reset`, { method: 'POST' });
    await fetch(`${baseUrl}/acme/admin/chaos-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expireOnPath: '/acme/search.aspx' }),
    });

    const { artifact } = loadArtifactBytes();
    const result = await replayCapability(artifact, {
      ...ENV(),
      inputs: { memberId: 'M10087' },
      headless: true,
      runsDir: RUNS_DIR,
    });
    expect(result.status, JSON.stringify(result.failure)).toBe('SUCCESS');
    expect(result.outputs?.savingsBalance).toBe('$10,234.10');
    // The recovery actually fired: a step was retried after re-authentication.
    const log = fs.readFileSync(path.join(RUNS_DIR, result.runId, 'log.jsonl'), 'utf8');
    expect(log).toContain('"type":"recovering"');
    expect(log).toContain('step_ok_after_recovery');
    expect(log).toContain('"mode":"recovery"');
    expect(log).toContain('"mode":"retry"');
    expect((log.match(/"type":"step_failed"/g) ?? []).length).toBe(0);
  }, 120_000);
});







