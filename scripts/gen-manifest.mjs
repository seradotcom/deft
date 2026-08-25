import fs from 'node:fs';
import crypto from 'node:crypto';
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const scenarios = [
  { id: 'discovery', dir: 'evidence/discovery', capability: 'legacybank.lookup-member-balance', expect: 'LLM run ends DONE; artifact compiled from this run' },
  { id: 'replay-success', dir: 'evidence/replay-success', capability: 'legacybank.lookup-member-balance', expect: 'SUCCESS + savingsBalance=$2,450.75, zero degraded steps' },
  { id: 'replay-business-outcome', dir: 'evidence/replay-business-outcome', capability: 'legacybank.lookup-member-balance', expect: 'BUSINESS_OUTCOME / MEMBER_NOT_FOUND' },
  { id: 'replay-session-recovery', dir: 'evidence/replay-session-recovery', capability: 'legacybank.lookup-member-balance', expect: 'mid-flow expiry → relogin chain → SUCCESS' },
  { id: 'replay-cross-tenant', dir: 'evidence/replay-cross-tenant', capability: 'legacybank.lookup-member-balance', expect: 'tenant=nw variant → SUCCESS, same balance' },
  { id: 'risky-gating', dir: 'evidence/risky-gating', capability: 'legacybank.open-sub-account', expect: 'FAILED / RISKY_STEP_BLOCKED at the irreversible confirm' },
  { id: 'hitl-approval', dir: 'evidence/hitl-approval', capability: 'legacybank.open-sub-account', expect: 'operator approval via console → SUCCESS, resumedByHuman=true, audit samples' },
];
const manifest = { generatedAt: new Date().toISOString(), artifacts: {}, scenarios: [] };
for (const cap of ['legacybank.lookup-member-balance', 'legacybank.open-sub-account']) {
  manifest.artifacts[cap] = sha(`capabilities/${cap}.json`);
}
function listFiles(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) out.push(...listFiles(`${dir}/${f.name}`).map((x) => `${f.name}/${x}`));
    else out.push(f.name);
  }
  return out;
}
for (const s of scenarios) {
  const logPath = `${s.dir}/log.jsonl`;
  if (!fs.existsSync(logPath)) continue;
  const log = fs.readFileSync(logPath, 'utf8');
  manifest.scenarios.push({
    dir: s.dir,
    scenario: s.id,
    runId: log.match('"runId":"([^"]+)"')?.[1] ?? null,
    capabilityId: s.capability,
    artifactSha256: log.match('"artifactSha256":"([a-f0-9]+)"')?.[1] ?? null,
    expectedResult: s.expect,
    actualResult: log.match('"status":"([A-Z_]+)"')?.[1] ?? null,
    files: listFiles(s.dir),
  });
}
fs.writeFileSync('evidence/manifest.json', JSON.stringify(manifest, null, 2));
console.log('manifest:', manifest.scenarios.length, 'scenarios');
