import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createLegacyBankApp } from '../dist/targets/legacybank/server.js';
import { replayCapability } from '../dist/replay/engine.js';
import { OperatorConsole } from '../dist/hitl/operator-console.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staging = path.join(root, 'artifacts', 'release-capture');
const runsDir = path.join(staging, 'runs');
const ledgersDir = path.join(staging, 'ledgers');
const operatorDir = path.join(staging, 'operator');
const baseUrl = 'http://localhost:7788';
const expected = {
  'replay-success': 'SUCCESS',
  'replay-business-outcome': 'BUSINESS_OUTCOME',
  'replay-session-recovery': 'SUCCESS',
  'replay-cross-tenant': 'SUCCESS',
  'risky-gating': 'FAILED',
  'hitl-approval': 'SUCCESS',
  'hitl-manual-takeover': 'SUCCESS',
};
const mode = process.argv[2];
if (!['automated', 'approval', 'manual', 'sanitize'].includes(mode)) {
  throw new Error('usage: node scripts/capture-release-evidence.mjs automated|approval|manual|sanitize');
}

if (mode === 'sanitize') {
  sanitizeTransitionFile(path.join(root, 'evidence', 'hitl-approval', 'intervention.jsonl'), 'approval');
  sanitizeTransitionFile(path.join(root, 'evidence', 'hitl-manual-takeover', 'intervention.jsonl'), 'manual_takeover');
  console.log('SANITIZED curated intervention references');
  process.exit(0);
}

fs.mkdirSync(runsDir, { recursive: true });
fs.mkdirSync(ledgersDir, { recursive: true });
fs.mkdirSync(operatorDir, { recursive: true });
const appServer = createServer(createLegacyBankApp());
await new Promise((resolve, reject) => {
  appServer.once('error', reject);
  appServer.listen(7788, '127.0.0.1', resolve);
});

try {
  if (mode === 'automated') {
    await capture('replay-success', 'legacybank.lookup-member-balance', { memberId: 'M10041' });
    await capture('replay-business-outcome', 'legacybank.lookup-member-balance', { memberId: 'M99999' });
    await reset();
    await chaos({ expireOnPath: '/acme/search.aspx' });
    await capture('replay-session-recovery', 'legacybank.lookup-member-balance', { memberId: 'M10087' }, { resetFirst: false });
    await capture('replay-cross-tenant', 'legacybank.lookup-member-balance', { memberId: 'M10041' }, { tenantId: 'nw' });
    await capture('risky-gating', 'legacybank.open-sub-account', openInputs());
  } else if (mode === 'approval') {
    const console_ = new OperatorConsole(7790, operatorDir);
    let started = false;
    await capture('hitl-approval', 'legacybank.open-sub-account', openInputs(), {
      headless: false,
      onEscalation: async (info) => {
        if (!started) { await console_.start(); started = true; }
        console.log(`OPERATOR_URL=${console_.baseUrl}`);
        const result = await console_.requestAndWait({ kind: 'approval', source: 'replay', reason: info.reason, observation: info.observation });
        return result.state === 'APPROVED';
      },
      after: async (result) => {
        await curateIntervention('hitl-approval', result.runId, 'approval');
        if (started) await console_.stop();
      },
    });
  } else {
    await reset();
    await chaos({ modalOnPath: '/acme/confirmopen.aspx' });
    const console_ = new OperatorConsole(7790, operatorDir);
    let started = false;
    await capture('hitl-manual-takeover', 'legacybank.open-sub-account', openInputs(), {
      resetFirst: false,
      headless: false,
      allowRisky: true,
      onManualTakeover: async (info) => {
        if (!started) { await console_.start(); started = true; }
        console.log(`OPERATOR_URL=${console_.baseUrl}`);
        return console_.requestAndWait({
          kind: 'manual_takeover', source: 'replay', reason: info.reason,
          sessionId: info.sessionId, observation: info.observation,
          observeCurrent: info.observeCurrent, dialogLease: info.dialogLease,
        });
      },
      after: async (result) => {
        await curateIntervention('hitl-manual-takeover', result.runId, 'manual_takeover');
        if (started) await console_.stop();
      },
    });
  }
} finally {
  await new Promise((resolve) => appServer.close(resolve));
}

async function capture(scenario, capabilityId, inputs, options = {}) {
  if (!(scenario in expected)) throw new Error(`unknown release scenario: ${scenario}`);
  if (options.resetFirst !== false) await reset();
  const artifactFile = path.join(root, 'capabilities', `${capabilityId}.json`);
  const artifactBytes = fs.readFileSync(artifactFile);
  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  const result = await replayCapability(artifact, {
    artifactBytes,
    tenantId: options.tenantId,
    runtimeEnv: { ...process.env, LEGACYBANK_USER: 'teller1', LEGACYBANK_PASSWORD: 'Demo!2345' },
    env: { baseUrl: `${baseUrl}/${options.tenantId === 'nw' ? 'nw' : 'acme'}` },
    inputs,
    headless: options.headless ?? true,
    allowRisky: options.allowRisky ?? false,
    runsDir,
    capabilitiesDir: ledgersDir,
    onEscalation: options.onEscalation,
    onManualTakeover: options.onManualTakeover,
  });
  if (result.status !== expected[scenario]) throw new Error(`${scenario}: expected ${expected[scenario]}, got ${result.status}: ${JSON.stringify(result.failure)}`);
  curateRun(scenario, capabilityId, result.runId);
  await options.after?.(result);
  console.log(`CAPTURED ${scenario} ${result.runId} ${result.status}`);
}

function curateRun(scenario, capabilityId, runId) {
  const source = path.join(runsDir, runId);
  const destination = path.join(root, 'evidence', scenario);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  const ledger = path.join(ledgersDir, `${capabilityId}.validation.jsonl`);
  const rows = fs.readFileSync(ledger, 'utf8').split(/\r?\n/).filter(Boolean).filter((line) => JSON.parse(line).runId === runId);
  if (rows.length !== 1) throw new Error(`${scenario}: expected one ledger row for ${runId}, got ${rows.length}`);
  fs.writeFileSync(path.join(destination, 'ledger.jsonl'), `${rows[0]}\n`);
}

async function curateIntervention(scenario, runId, kind) {
  const destination = path.join(root, 'evidence', scenario);
  const candidates = fs.readdirSync(operatorDir).filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, value: JSON.parse(fs.readFileSync(path.join(operatorDir, name), 'utf8')) }))
    .filter(({ value }) => value.kind === kind && (kind === 'approval' || value.sessionId === runId))
    .sort((a, b) => a.value.createdAt.localeCompare(b.value.createdAt));
  const intervention = candidates.at(-1)?.value;
  if (!intervention) throw new Error(`${scenario}: matching operator intervention not found`);
  const curatedTransitionFile = path.join(destination, 'intervention.jsonl');
  fs.copyFileSync(intervention.transitionLogFile, curatedTransitionFile);
  sanitizeTransitionFile(curatedTransitionFile, kind);
  if (kind !== 'manual_takeover') return;
  const transitions = fs.readFileSync(intervention.transitionLogFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const first = transitions[0]; const last = transitions.at(-1);
  fs.writeFileSync(path.join(destination, 'before.json'), `${JSON.stringify({
    url: first.urlAtPause, title: 'LegacyBank manual takeover before', a11yAnnotatedYaml: first.a11yOutline, frames: [],
    semanticHash: first.beforeSemanticHash,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(destination, 'after.json'), `${JSON.stringify({
    url: last.urlAtResume, title: 'LegacyBank manual takeover after', a11yAnnotatedYaml: last.afterA11yOutline, frames: [],
    semanticHash: last.afterSemanticHash,
  }, null, 2)}\n`);
  fs.copyFileSync(intervention.screenshotFile, path.join(destination, 'before.png'));
  fs.copyFileSync(intervention.afterScreenshotFile, path.join(destination, 'after.png'));
}

async function reset() {
  const response = await fetch(`${baseUrl}/acme/admin/reset`, { method: 'POST' });
  if (!response.ok) throw new Error(`target reset failed: ${response.status}`);
}
async function chaos(body) {
  const response = await fetch(`${baseUrl}/acme/admin/chaos-all`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`target chaos setup failed: ${response.status}`);
}
function openInputs() { return { memberId: 'M10041', nickname: 'Release evidence', deposit: '100' }; }

function sanitizeTransitionFile(file, kind) {
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const row = JSON.parse(line);
    delete row.currentScreenshotFile;
    row.transitionLogFile = 'intervention.jsonl';
    if (kind === 'manual_takeover') {
      if (row.screenshotFile) row.screenshotFile = 'before.png';
      if (row.afterScreenshotFile) row.afterScreenshotFile = 'after.png';
    } else {
      delete row.screenshotFile;
      delete row.afterScreenshotFile;
    }
    return JSON.stringify(row);
  });
  fs.writeFileSync(file, `${rows.join('\n')}\n`);
}
