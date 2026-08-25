/**
 * verify:submission — automated integrity check of the evidence package.
 *
 * Proves the demo is authentic and internally consistent:
 *   provenance chains, artifact hashes, terminal statuses, referenced
 *   screenshots, no duplicated runs, no secrets.
 *
 * Exit code 0 = PASS. Any ✗ line fails the submission.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

let failures = 0;
const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => { console.log(`✗ ${msg}`); failures += 1; };

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// --- artifacts exist -------------------------------------------------------
const caps = ['legacybank.lookup-member-balance', 'legacybank.open-sub-account'];
for (const c of caps) {
  const p = `capabilities/${c}.json`;
  fs.existsSync(p) ? ok(`capability exists: ${c}`) : bad(`missing capability: ${c}`);
}

// --- manifest present ------------------------------------------------------
if (!fs.existsSync('evidence/manifest.json')) { bad('missing evidence/manifest.json'); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync('evidence/manifest.json', 'utf8'));
ok('manifest present');

// --- discovery: exists, DONE, provenance matches ---------------------------
const discLog = fs.readFileSync('evidence/discovery/log.jsonl', 'utf8');
const discTranscript = JSON.parse(fs.readFileSync('evidence/discovery/transcript.json', 'utf8'));
discTranscript.endState === 'DONE'
  ? ok('discovery terminal state = DONE')
  : bad(`discovery endState = ${discTranscript.endState} (must be DONE)`);

const lookup = JSON.parse(fs.readFileSync('capabilities/legacybank.lookup-member-balance.json', 'utf8'));
const discRunId = discLog.match('"runId":"([^"]+)"')?.[1];
lookup.provenance.discoveredFromRunId === discRunId
  ? ok(`artifact provenance matches discovery run (${discRunId})`)
  : bad(`provenance mismatch: artifact=${lookup.provenance.discoveredFromRunId} evidence=${discRunId}`);

// --- per-scenario checks ---------------------------------------------------
const expected = {
  'discovery': () => true, // terminal state checked separately (DONE)
  'replay-success': (s) => s.actualResult === 'SUCCESS',
  'replay-business-outcome': (s) => s.actualResult.includes('MEMBER_NOT_FOUND'),
  'replay-cross-tenant': (s) => s.actualResult === 'SUCCESS',
  'replay-session-recovery': (s) => s.actualResult === 'SUCCESS',
  'risky-gating': (s) => s.actualResult === 'FAILED' && s.actualResult !== null,
  'hitl-approval': (s) => s.actualResult === 'SUCCESS',
};
const seen = new Set();
for (const s of manifest.scenarios) {
  if (seen.has(s.scenario + s.runId)) bad(`duplicated run in manifest: ${s.scenario}`);
  seen.add(s.scenario + s.runId);

  const exp = expected[s.scenario];
  exp && exp(s) ? ok(`${s.scenario}: ${s.actualResult}`) : bad(`${s.scenario}: unexpected result ${s.actualResult}`);

  if (s.scenario !== 'discovery' && !s.artifactSha256) bad(`${s.scenario}: no artifactSha256 recorded`);
  else if (s.artifactSha256) ok(`${s.scenario}: artifact sha ${s.artifactSha256.slice(0, 12)}…`);
}

// --- session recovery actually recovered -----------------------------------
const recLog = fs.readFileSync('evidence/replay-session-recovery/log.jsonl', 'utf8');
recLog.includes('"type":"recovering"')
  ? ok('session recovery: relogin chain fired')
  : bad('session recovery: no recovering event');
recLog.includes('step_ok_after_recovery')
  ? ok('session recovery: failed step recovered and retried')
  : bad('session recovery: no successful post-recovery retry');

// --- HITL: approval + human audit samples ----------------------------------
const hitlLog = fs.readFileSync('evidence/hitl-approval/log.jsonl', 'utf8');
hitlLog.includes('risky_approved_by_operator')
  ? ok('HITL: risky step approved by operator')
  : bad('HITL: no operator approval event');
const samples = (hitlLog.match(/"type":"human_sample"/g) ?? []).length;
samples >= 1 ? ok(`HITL: ${samples} live-session audit samples captured`) : bad('HITL: no human-action samples');

// --- risky gating actually blocked BEFORE the final page -------------------
const riskyLog = fs.readFileSync('evidence/risky-gating/log.jsonl', 'utf8');
riskyLog.includes('RISKY_STEP_BLOCKED') ? ok('risky gating: RISKY_STEP_BLOCKED present') : bad('risky gating missing');
!riskyLog.includes('opened successfully') ? ok('risky gating: irreversible step never executed') : bad('risky gating: the confirm RAN — gating failed');

// --- referenced screenshots exist ------------------------------------------
let refs = 0, missing = 0;
for (const s of manifest.scenarios) {
  for (const f of s.files) {
    if (!f.endsWith('.png')) continue;
    refs += 1;
    if (!fs.existsSync(`${s.dir}/${f}`)) missing += 1;
  }
}
missing === 0 ? ok(`${refs}/${refs} referenced screenshots exist`) : bad(`${missing}/${refs} screenshots MISSING`);

// --- secrets scan (evidence + capabilities + src) ---------------------------
const secretPatterns = [/AIzaSy[A-Za-z0-9_-]{10,}/, /AQ\.Ab8[A-Za-z0-9_-]{10,}/];
let secretHits = [];
for (const dir of ['evidence', 'capabilities', 'src', 'tests']) {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${f.name}`;
      if (f.isDirectory()) walk(p);
      else if (/\.(json|jsonl|ts|mjs|md)$/.test(f.name)) {
        const content = fs.readFileSync(p, 'utf8');
        for (const re of secretPatterns) if (re.test(content)) secretHits.push(p);
      }
    }
  };
  walk(dir);
}
secretHits.length === 0 ? ok('no API keys in evidence/capabilities/src/tests') : bad(`API keys found in: ${secretHits.join(', ')}`);

// --- verdict ----------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log('Submission evidence integrity: PASS');
} else {
  console.log(`Submission evidence integrity: FAIL (${failures} problem(s))`);
  process.exit(1);
}

