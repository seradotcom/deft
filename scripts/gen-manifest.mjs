import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const scenarioDefinitions = [
  ['discovery', 'legacybank.lookup-member-balance', 'DONE'],
  ['replay-success', 'legacybank.lookup-member-balance', 'SUCCESS'],
  ['replay-business-outcome', 'legacybank.lookup-member-balance', 'BUSINESS_OUTCOME'],
  ['replay-session-recovery', 'legacybank.lookup-member-balance', 'SUCCESS'],
  ['replay-cross-tenant', 'legacybank.lookup-member-balance', 'SUCCESS'],
  ['risky-gating', 'legacybank.open-sub-account', 'FAILED'],
  ['hitl-approval', 'legacybank.open-sub-account', 'SUCCESS'],
  ['hitl-manual-takeover', 'legacybank.open-sub-account', 'SUCCESS'],
];

export function generateManifest(root = process.cwd()) {
  const manifest = {
    schemaVersion: 2,
    runtimeFreezeCommit: '499ca6ef2fed93572330916c084e7f5bab5f7fff',
    generatedAt: new Date().toISOString(), artifacts: {}, scenarios: [],
  };
  for (const capabilityId of ['legacybank.lookup-member-balance', 'legacybank.open-sub-account']) {
    const file = path.join(root, `capabilities/${capabilityId}.json`);
    if (!fs.existsSync(file)) throw new Error(`missing frozen artifact: ${capabilityId}`);
    manifest.artifacts[capabilityId] = sha(file);
  }
  for (const [scenario, capabilityId, expectedResult] of scenarioDefinitions) {
    const relativeDir = `evidence/${scenario}`; const dir = path.join(root, relativeDir);
    const logFile = path.join(dir, 'log.jsonl');
    if (!fs.existsSync(logFile)) throw new Error(`missing frozen scenario log: ${scenario}`);
    const events = readJsonl(logFile);
    const terminals = scenario === 'discovery'
      ? events.filter((event) => event.type === 'run_end')
      : events.filter((event) => event.type === 'replay_result');
    if (terminals.length !== 1) throw new Error(`${scenario}: expected exactly one terminal event`);
    const terminal = terminals[0];
    const runId = terminal.runId ?? events.find((event) => event.runId)?.runId;
    if (!runId) throw new Error(`${scenario}: terminal/run log has no runId`);
    const entry = {
      scenario, dir: relativeDir, runId, capabilityId, expectedResult,
      tenant: scenario === 'replay-cross-tenant' ? 'nw' : 'base',
      files: listFiles(dir),
    };
    if (scenario !== 'discovery') {
      const definition = path.join(dir, 'artifact.executed.json');
      if (!fs.existsSync(definition)) throw new Error(`${scenario}: exact artifact.executed.json snapshot missing`);
      entry.artifactDefinition = 'artifact.executed.json';
      entry.artifactSha256 = sha(definition);
      entry.artifactVersion = JSON.parse(fs.readFileSync(definition, 'utf8')).metadata.version;
      entry.ledger = 'ledger.jsonl';
      if (!fs.existsSync(path.join(dir, entry.ledger))) throw new Error(`${scenario}: curated ledger row missing`);
      if (entry.artifactSha256 !== terminal.artifactSha256) throw new Error(`${scenario}: snapshot differs from executed artifact hash`);
    }
    if (scenario === 'hitl-approval') Object.assign(entry, { interventionLog: 'intervention.jsonl' });
    if (scenario === 'hitl-manual-takeover') Object.assign(entry, {
      interventionLog: 'intervention.jsonl', beforeObservation: 'before.json', afterObservation: 'after.json',
      beforeScreenshot: 'before.png', afterScreenshot: 'after.png',
    });
    manifest.scenarios.push(entry);
  }
  const manifestFile = path.join(root, 'evidence/manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function listFiles(dir, root = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(file, root);
    return [{ path: path.relative(root, file).split(path.sep).join('/'), sha256: sha(file), bytes: fs.statSync(file).size }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = generateManifest(process.cwd());
  console.log(`manifest: ${manifest.scenarios.length} frozen scenarios`);
}
