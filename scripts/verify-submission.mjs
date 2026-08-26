import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const expectedResults = {
  discovery: 'DONE', 'replay-success': 'SUCCESS', 'replay-business-outcome': 'BUSINESS_OUTCOME',
  'replay-session-recovery': 'SUCCESS', 'replay-cross-tenant': 'SUCCESS', 'risky-gating': 'FAILED',
  'hitl-approval': 'SUCCESS', 'hitl-manual-takeover': 'SUCCESS',
};
const frozenArtifacts = {
  'legacybank.lookup-member-balance': { sha256: '720de53e89794427d3e86d99bd3dbb8520715d7e23eed804fd41254d74dfee07', bytes: 18645, version: '2.0.0' },
  'legacybank.open-sub-account': { sha256: '4369749f3a4bdaa3757307f13d6b1f8c997bfd337e46e9e3db85d9ad552c2d93', bytes: 26269, version: '2.0.0' },
};

export function verifySubmission(root = process.cwd(), options = {}) {
  try { return verifySubmissionUnsafe(root, options); }
  catch (error) { return { failures: [`JSON/parse verification error: ${error instanceof Error ? error.message : String(error)}`] }; }
}

function verifySubmissionUnsafe(root, options) {
  const failures = [];
  const fail = (message) => failures.push(message);
  const enforceFrozenArtifacts = options.requireFrozenArtifacts !== false;
  const manifestFile = path.join(root, 'evidence/manifest.json');
  if (!fs.existsSync(manifestFile)) return { failures: ['missing evidence/manifest.json'] };
  const manifest = readJson(manifestFile);
  if (manifest.schemaVersion !== 2) fail('manifest schemaVersion must be 2');
  if (options.requireCompleteScenarioSet !== false) {
    const actual = (manifest.scenarios ?? []).map((scenario) => scenario.scenario).sort();
    const required = Object.keys(expectedResults).sort();
    if (JSON.stringify(actual) !== JSON.stringify(required)) fail('manifest must contain the exact expected scenario set');
  }

  const artifactIds = Object.keys(manifest.artifacts ?? {}).sort();
  if (enforceFrozenArtifacts && JSON.stringify(artifactIds) !== JSON.stringify(Object.keys(frozenArtifacts).sort())) fail('manifest must contain the exact frozen artifact set');
  const artifactsToVerify = enforceFrozenArtifacts
    ? Object.entries(frozenArtifacts)
    : artifactIds.map((capabilityId) => [capabilityId, undefined]);
  for (const [capabilityId, frozen] of artifactsToVerify) {
    const expectedHash = manifest.artifacts?.[capabilityId];
    let artifactFile;
    try { artifactFile = safeResolve(path.join(root, 'capabilities'), `${capabilityId}.json`); }
    catch { fail(`unsafe capability id ${capabilityId}`); continue; }
    if (!fs.existsSync(artifactFile)) fail(`missing capability ${capabilityId}`);
    else if (sha(artifactFile) !== expectedHash || (frozen && (expectedHash !== frozen.sha256 || fs.statSync(artifactFile).size !== frozen.bytes))) {
      fail(`frozen artifact bytes/hash mismatch for ${capabilityId}`);
    }
  }

  const runIds = new Set();
  for (const scenario of manifest.scenarios ?? []) {
    if (!scenario.runId) fail(`${scenario.scenario}: missing runId`);
    else if (runIds.has(scenario.runId)) fail(`duplicate runId globally: ${scenario.runId}`);
    else runIds.add(scenario.runId);
    if (scenario.dir !== `evidence/${scenario.scenario}`) fail(`${scenario.scenario}: scenario directory must be canonical`);
    const dir = safeResolve(root, scenario.dir);
    const logFile = path.join(dir, 'log.jsonl');
    if (!fs.existsSync(logFile)) { fail(`${scenario.scenario}: missing log.jsonl`); continue; }
    const events = readJsonl(logFile);
    if (!discoveryContract(scenario)) {
      const starts = events.filter((event) => event.type === 'run_start');
      const replayStarts = events.filter((event) => event.type === 'replay_start');
      const definitions = events.filter((event) => event.type === 'artifact_definition');
      if (starts.length !== 1 || replayStarts.length !== 1 || definitions.length !== 1) fail(`${scenario.scenario}: exactly one run_start, replay_start and artifact_definition required`);
      const expectedRunLabel = scenario.tenant === 'base' ? scenario.capabilityId : `${scenario.capabilityId}@${scenario.tenant}`;
      if (starts[0]?.runId !== scenario.runId || starts[0]?.label !== expectedRunLabel ||
          replayStarts[0]?.capability !== scenario.capabilityId || replayStarts[0]?.version !== scenario.artifactVersion || replayStarts[0]?.tenant !== scenario.tenant ||
          definitions[0]?.artifactSha256 !== scenario.artifactSha256 || definitions[0]?.definitionRef !== scenario.artifactDefinition) {
        fail(`${scenario.scenario}: run/artifact definition facts mismatch`);
      }
      const frozen = frozenArtifacts[scenario.capabilityId];
      if (enforceFrozenArtifacts && (!frozen || scenario.artifactVersion !== frozen.version)) fail(`${scenario.scenario}: non-frozen capability version`);
    } else {
      const starts = events.filter((event) => event.type === 'run_start');
      if (starts.length !== 1 || starts[0]?.runId !== scenario.runId || starts[0]?.kind !== 'discovery') {
        fail(`${scenario.scenario}: exactly one matching discovery run_start required`);
      }
    }
    if (events.some((event) => event.runId && event.runId !== scenario.runId)) fail(`${scenario.scenario}: mixed runIds in log`);
    const discovery = scenario.scenario === 'discovery';
    const terminals = events.filter((event) => event.type === (discovery ? 'run_end' : 'replay_result'));
    if (terminals.length !== 1) { fail(`${scenario.scenario}: expected exactly one terminal ${discovery ? 'run_end' : 'replay_result'}`); continue; }
    const terminal = terminals[0];
    const observedRunId = terminal.runId ?? events.find((event) => event.runId)?.runId;
    if (observedRunId !== scenario.runId) fail(`${scenario.scenario}: terminal runId mismatch`);
    const expectedResult = expectedResults[scenario.scenario];
    if (!expectedResult) fail(`${scenario.scenario}: unknown scenario contract`);
    const actualResult = discovery ? terminal.endState : terminal.status;
    if (actualResult !== expectedResult) fail(`${scenario.scenario}: terminal result ${actualResult} does not match ${expectedResult}`);
    if (!discovery && (terminal.capabilityId !== scenario.capabilityId || terminal.capabilityVersion !== scenario.artifactVersion || terminal.artifactSha256 !== scenario.artifactSha256)) {
      fail(`${scenario.scenario}: terminal capability/version/hash facts mismatch`);
    }

    let definitionFile = dir;
    try { definitionFile = safeResolve(dir, scenario.artifactDefinition ?? ''); } catch { fail(`${scenario.scenario}: unsafe executed definition reference`); }
    if (!discovery && (!scenario.artifactDefinition || !fs.existsSync(definitionFile))) {
      fail(`${scenario.scenario}: exact executed definition snapshot missing`);
    } else if (!discovery) {
      const definitionHash = sha(definitionFile);
      if (definitionHash !== scenario.artifactSha256 || definitionHash !== terminal.artifactSha256) {
        fail(`${scenario.scenario}: executed definition hash mismatch`);
      }
    }

    for (const reference of scenario.files ?? []) {
      if (!reference || typeof reference.path !== 'string') { fail(`${scenario.scenario}: invalid file manifest entry`); continue; }
      let file;
      try { file = safeResolve(dir, reference.path); } catch { fail(`${scenario.scenario}: unsafe file reference ${reference.path}`); continue; }
      if (!fs.existsSync(file)) fail(`${scenario.scenario}: missing referenced file ${reference.path}`);
      else if (fs.statSync(file).size !== reference.bytes || sha(file) !== reference.sha256) fail(`${scenario.scenario}: file bytes/hash mismatch ${reference.path}`);
    }
    const declaredFiles = (scenario.files ?? []).map((reference) => reference?.path).sort();
    const actualFiles = listRelativeFiles(dir);
    if (new Set(declaredFiles).size !== declaredFiles.length || JSON.stringify(declaredFiles) !== JSON.stringify(actualFiles)) {
      fail(`${scenario.scenario}: file manifest must exactly inventory the scenario directory`);
    }
    if (!discovery) verifyLedger(dir, scenario, terminal, fail);
    if (scenario.scenario === 'hitl-approval') verifyApproval(dir, events, scenario, fail);
    if (scenario.scenario === 'hitl-manual-takeover') verifyManualTakeover(dir, events, scenario, fail);
    if (scenario.scenario === 'replay-session-recovery' &&
        (!events.some((event) => event.type === 'recovering') || !events.some((event) => event.type === 'step_ok_after_recovery'))) {
      fail(`${scenario.scenario}: recovery and successful retry events required`);
    }
    if (scenario.scenario === 'risky-gating' && !JSON.stringify(events).includes('RISKY_STEP_BLOCKED')) {
      fail(`${scenario.scenario}: RISKY_STEP_BLOCKED evidence required`);
    }
    if (scenario.scenario === 'replay-business-outcome' && terminal.businessOutcome?.code !== 'MEMBER_NOT_FOUND') {
      fail(`${scenario.scenario}: MEMBER_NOT_FOUND terminal business outcome required`);
    }
    if (discovery) {
      const transcriptFile = path.join(dir, 'transcript.json');
      if (!fs.existsSync(transcriptFile)) fail(`${scenario.scenario}: transcript.json missing`);
      else {
        const transcript = readJson(transcriptFile);
        if (transcript.endState !== 'DONE') fail(`${scenario.scenario}: transcript terminal state mismatch`);
      }
      const capabilityFile = path.join(root, `capabilities/${scenario.capabilityId}.json`);
      if (fs.existsSync(capabilityFile)) {
        const artifact = readJson(capabilityFile);
        if (artifact.provenance?.discoveredFromRunId !== scenario.runId) fail(`${scenario.scenario}: artifact provenance runId mismatch`);
      }
    }
  }
  scanSecrets(root, fail);
  return { failures };
}

function discoveryContract(scenario) { return scenario.scenario === 'discovery'; }

function safeResolve(base, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('unsafe path');
  const resolved = path.resolve(base, relative); const prefix = `${path.resolve(base)}${path.sep}`;
  if (resolved !== path.resolve(base) && !resolved.startsWith(prefix)) throw new Error('unsafe path');
  return resolved;
}

function listRelativeFiles(dir, root = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? listRelativeFiles(file, root) : [path.relative(root, file).split(path.sep).join('/')];
  }).sort();
}

function verifyLedger(dir, scenario, terminal, fail) {
  if (!scenario.ledger) { fail(`${scenario.scenario}: ledger reference missing`); return; }
  let file; try { file = safeResolve(dir, scenario.ledger); } catch { fail(`${scenario.scenario}: unsafe ledger reference`); return; }
  if (!fs.existsSync(file)) { fail(`${scenario.scenario}: ledger missing`); return; }
  const rows = readJsonl(file);
  const matches = rows.filter((row) => row.runId === scenario.runId);
  if (rows.length !== 1 || matches.length !== 1 || matches[0].status !== terminal.status || matches[0].artifactSha256 !== terminal.artifactSha256) {
    fail(`${scenario.scenario}: ledger must contain exactly one matching terminal row`);
  }
}

function scanSecrets(root, fail) {
  const patterns = [/AIzaSy[A-Za-z0-9_-]{10,}/, /AQ\.Ab8[A-Za-z0-9_-]{10,}/];
  for (const relative of ['evidence', 'capabilities']) {
    const base = path.join(root, relative); if (!fs.existsSync(base)) continue;
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(json|jsonl|md)$/.test(entry.name)) {
        const text = fs.readFileSync(file, 'utf8');
        if (patterns.some((pattern) => pattern.test(text))) fail(`secret-like token found in ${path.relative(root, file)}`);
      }
    });
    walk(base);
  }
}

function verifyApproval(dir, events, scenario, fail) {
  if (!events.some((event) => event.type === 'risky_approved_by_operator')) fail(`${scenario.scenario}: approval event missing`);
  if (events.some((event) => event.type === 'manual_takeover_resumed')) fail(`${scenario.scenario}: approval must not claim manual takeover`);
  let interventionFile;
  try { interventionFile = scenario.interventionLog && safeResolve(dir, scenario.interventionLog); } catch { fail(`${scenario.scenario}: unsafe approval transition reference`); return; }
  if (!interventionFile || !fs.existsSync(interventionFile)) { fail(`${scenario.scenario}: approval transition log missing`); return; }
  const transitions = readJsonl(interventionFile);
  if (transitions.map((event) => event.transition).join('>') !== 'PENDING>APPROVED' ||
      transitions.some((event) => event.kind !== 'approval' || event.transition === 'HUMAN_CONTROL')) {
    fail(`${scenario.scenario}: invalid approval transition sequence`);
  }
}

function verifyManualTakeover(dir, events, scenario, fail) {
  const required = [scenario.interventionLog, scenario.beforeObservation, scenario.afterObservation, scenario.beforeScreenshot, scenario.afterScreenshot];
  let files;
  try { files = required.map((file) => file && safeResolve(dir, file)); } catch { fail(`${scenario.scenario}: unsafe manual takeover audit reference`); return; }
  if (files.some((file) => !file || !fs.existsSync(file))) {
    fail(`${scenario.scenario}: manual takeover audit files missing`); return;
  }
  const transitions = readJsonl(files[0]);
  const sequence = transitions.map((event) => event.transition);
  const sessions = new Set(transitions.map((event) => event.sessionId));
  const genuine = sequence.length === 3 && sequence.join('>') === 'PENDING>HUMAN_CONTROL>RESUMED' &&
    transitions.every((event) => event.kind === 'manual_takeover') && sessions.size === 1 && sessions.has(scenario.runId) &&
    transitions[2]?.humanStateChanges >= 1;
  const engineResume = events.filter((event) => event.type === 'manual_takeover_resumed');
  if (engineResume.length !== 1 || engineResume[0].sessionId !== scenario.runId || engineResume[0].humanStateChanges < 1) {
    fail(`${scenario.scenario}: engine resume event missing or inconsistent`);
  }
  const surfaceAudit = events.filter((event) => event.type === 'human_surface_events');
  const surfaceEvents = surfaceAudit.flatMap((event) => Array.isArray(event.events) ? event.events : []);
  const pointers = surfaceEvents.filter((event) => event.kind === 'human_pointer' && event.control === 'human' && event.sessionId === scenario.runId);
  const dialogs = surfaceEvents.filter((event) => event.kind === 'dialog' && event.control === 'human' && event.sessionId === scenario.runId && event.accepted === true);
  if (surfaceAudit.length !== 1 || pointers.length < 2 || dialogs.length !== 1) {
    fail(`${scenario.scenario}: human pointer and accepted-dialog surface audit required`);
  }
  const resumedStepId = engineResume[0]?.stepId;
  const completed = events.filter((event) => event.type === 'step_ok' && event.stepId === resumedStepId && event.completedBy === 'manual_takeover');
  const afterSteps = events.filter((event) => event.type === 'after_step' && event.stepId === resumedStepId && event.completedBy === 'manual_takeover');
  if (completed.length !== 1 || afterSteps.length !== 1 || events.some((event) => event.stepId === resumedStepId && event.type === 'step_ok_after_recovery')) {
    fail(`${scenario.scenario}: manual completion must be verified exactly once without recovery fast-forward`);
  }
  const before = readJson(files[1]);
  const after = readJson(files[2]);
  const semantic = (observation) => JSON.stringify({
    url: observation.url, title: observation.title,
    a11yAnnotatedYaml: observation.a11yAnnotatedYaml, frames: observation.frames,
  });
  if (!genuine || semantic(before) === semantic(after)) fail(`${scenario.scenario}: invalid manual takeover sequence/session/state delta`);
  try {
    const beforeUrl = new URL(before.url); const afterUrl = new URL(after.url);
    if (!['http:', 'https:'].includes(beforeUrl.protocol) || beforeUrl.origin !== afterUrl.origin) fail(`${scenario.scenario}: manual takeover URLs leave the allowed origin`);
  } catch { fail(`${scenario.scenario}: manual takeover URLs are invalid`); }
  if (sha(files[3]) === sha(files[4])) {
    fail(`${scenario.scenario}: manual takeover screenshots are identical`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifySubmission(process.cwd());
  for (const failure of result.failures) console.error(`✗ ${failure}`);
  if (result.failures.length) { console.error(`Submission evidence integrity: FAIL (${result.failures.length})`); process.exitCode = 1; }
  else console.log('Submission evidence integrity: PASS');
}
