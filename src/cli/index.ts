/**
 * DEFT CLI — the system's face.
 *
 *   deft discover   goal-driven LLM run on the live surface → capability artifact
 *   deft replay     deterministic execution of a saved capability (no model)
 *   deft capabilities  list stored capabilities
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../core/config.js';
import { HybridVisionPlanner } from '../agent/planner.js';
import { DiscoveryRun } from '../agent/discover.js';
import { compileCapability } from '../agent/compiler.js';
import { replayCapability } from '../replay/engine.js';
import { defaultPolicy } from '../safety/policy.js';
import { CapabilityArtifactSchema } from '../core/artifact.js';
import { OperatorConsole } from '../hitl/operator-console.js';

const program = new Command();
program.name('deft').description('The model discovers. The capability replays.').version('0.1.0');

function parseInputs(pairs: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

function parseOutcomes(specs: string[] = []) {
  return specs.map((s) => {
    // CODE=pageTextContains:'No matching member'
    const eq = s.indexOf('=');
    const code = s.slice(0, eq);
    const rest = s.slice(eq + 1);
    const colon = rest.indexOf(':');
    const kind = rest.slice(0, colon);
    const value = rest.slice(colon + 1).replace(/^'|'$/g, '');
    if (kind === 'pageTextContains') {
      return {
        code,
        description: `Expected business result detected via page text`,
        detect: { pageTextContains: value },
        returnsToCaller: { outcomeCode: code },
      };
    }
    throw new Error(`unsupported outcome detector: ${kind}`);
  });
}

program
  .command('discover')
  .requiredOption('--goal <goal>', 'natural language goal')
  .requiredOption('--capability-id <id>', 'target capability id, e.g. legacybank.lookup-member-balance')
  .requiredOption('--name <name>')
  .requiredOption('--description <description>')
  .option('--tenant <tenant>', 'tenant key from config', 'acme')
  .option('--entry-path <path>', 'entry path appended to tenant base', '/login.aspx')
  .option('--input <pairs...>', 'typed inputs used during this run', [])
  .option('--outcome <specs...>', 'business outcome declarations', [])
  .option('--max-steps <n>', 'planner budget', '14')
  .option('--headed', 'show the browser window', false)
  .action(async (cmd) => {
    const cfg = loadConfig();
    if (!cfg.geminiApiKey) throw new Error('GEMINI_API_KEY missing (.env)');
    const baseUrl = cfg.baseUrlByTenant[cmd.tenant];
    if (!baseUrl) throw new Error(`unknown tenant ${cmd.tenant}`);
    const entryUrl = `${baseUrl}${cmd.entryPath}`;

    const console_ = new OperatorConsole(cfg.operatorPort, 'artifacts/operator');
    let consoleUp = false;
    const ensureConsole = async () => {
      if (!consoleUp) {
        await console_.start();
        consoleUp = true;
        console.error(`\n(operator console at http://localhost:${cfg.operatorPort} — waiting for you)\n`);
      }
    };

    const planner = new HybridVisionPlanner(cfg.geminiApiKey, cfg.plannerModel);
    const policy = defaultPolicy(baseUrl);

    const username = process.env.LEGACYBANK_USER ?? 'teller1';
    const password = process.env.LEGACYBANK_PASSWORD ?? 'Demo!2345';
    const goalWithCredentials = `${cmd.goal} Sign in at the entry screen with operator ID "${username}" and password "${password}" if asked.`;

    const run = new DiscoveryRun(
      { goal: goalWithCredentials, baseUrl, entryUrl },
      planner,
      policy,
      {
        maxSteps: Number(cmd.maxSteps),
        headed: Boolean(cmd.headed),
        viewport: cfg.viewport,
        runsDir: cfg.runsDir,
        secrets: [username, password],
        onEscalation: async (info) => {
          await ensureConsole();
          const verdict = await console_.requestAndWait({
            source: 'discovery',
            reason: info.reason,
            observation: info.observation,
            saveShot: async (_b64, _tag) => '', // screenshot already captured in obs
          });
          return verdict === 'resumed';
        },
      }
    );

    console.error(`▶ discover: ${cmd.goal}`);
    const result = await run.run();
    console.error(`■ discovery ended: ${result.endState} (${result.steps.length} recorded steps)`);
    if (consoleUp) await console_.stop();

    if (result.endState !== 'DONE') {
      console.log(JSON.stringify({ endState: result.endState, runId: result.runId }, null, 2));
      process.exitCode = 2;
      return;
    }

    const inputs = parseInputs(cmd.input);
    const artifact = compileCapability(result, {
      appFamily: cmd.capabilityId.split('.')[0],
      capabilityIdBase: cmd.capabilityId,
      name: cmd.name,
      description: cmd.description,
      entryUrlTemplate: entryUrl,
      inputs,
      outputsSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.keys(result.outputBindings ?? {}).map((k) => [
            k,
            { type: 'string', description: `read from table column "${result.outputBindings![k]!.colHeader}"` },
          ])
        ),
      },
      businessOutcomes: parseOutcomes(cmd.outcome),
      plannerModel: cfg.plannerModel,
      loginTargets: extractLoginTargets(result),
    });

    fs.mkdirSync(cfg.capabilitiesDir, { recursive: true });
    const file = path.join(cfg.capabilitiesDir, `${artifact.metadata.id}.json`);
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
    console.log(JSON.stringify({
      compiled: file,
      status: artifact.metadata.status,
      steps: artifact.steps.length,
      quality: artifact.steps.map((s) => s.target?.quality ?? null).filter(Boolean),
      provenance: artifact.provenance.discoveredFromRunId,
    }, null, 2));
  });

program
  .command('replay')
  .argument('<capabilityId>')
  .option('--tenant <tenant>', 'apply a variant overlay for this tenant id')
  .option('--input <pairs...>', 'typed invocation params', [])
  .option('--allow-risky', 'permit risky steps unattended', false)
  .option('--headed', 'show the browser window', false)
  .option('--escalate', 'enable operator-console escalation on stuck steps', false)
  .action(async (id, cmd) => {
    const cfg = loadConfig();
    const file = path.join(cfg.capabilitiesDir, `${id}.json`);
    if (!fs.existsSync(file)) throw new Error(`capability not found: ${file}`);
    const artifact = CapabilityArtifactSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));

    const tenantBase = cmd.tenant ? cfg.baseUrlByTenant[cmd.tenant] : undefined;
    const env: Record<string, string> = {
      baseUrl: tenantBase ?? cfg.baseUrlByTenant.acme!,
      username: process.env.LEGACYBANK_USER ?? 'teller1',
      password: process.env.LEGACYBANK_PASSWORD ?? 'Demo!2345',
    };

    const console_ = new OperatorConsole(cfg.operatorPort, 'artifacts/operator');
    let consoleUp = false;

    const result = await replayCapability(artifact, {
      tenantId: cmd.tenant,
      env,
      inputs: parseInputs(cmd.input),
      headless: !cmd.headed,
      allowRisky: Boolean(cmd.allowRisky),
      runsDir: cfg.runsDir,
      onEscalation: cmd.escalate
        ? async (info) => {
            const obs = await fetchObservationForConsole(cfg);
            await ensure(console_, cfg, () => { consoleUp = true; });
            const verdict = await console_.requestAndWait({
              source: 'replay',
              reason: info.reason,
              observation: obs,
              saveShot: async () => '',
            });
            return verdict === 'resumed';
          }
        : undefined,
    });
    if (consoleUp) await console_.stop();

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'FAILED' ? 2 : 0;
  });

program
  .command('capabilities')
  .action(async () => {
    const cfg = loadConfig();
    const dir = cfg.capabilitiesDir;
    if (!fs.existsSync(dir)) return console.log('(none)');
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const a = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`${a.metadata.id} v${a.metadata.version} [${a.metadata.status}] — ${a.metadata.name}`);
    }
  });

async function ensure(c: OperatorConsole, cfg: { operatorPort: number }, mark: () => void): Promise<void> {
  await c.start();
  mark();
  console.error(`(operator console at http://localhost:${cfg.operatorPort})`);
}

/** Replay-side escalation needs an observation snapshot of current state. */
async function fetchObservationForConsole(_cfg: unknown): Promise<import('../core/actions.js').Observation> {
  // The engine escalates synchronously inside its own driver context; to keep
  // the seam simple we hand the console the last evidence screenshot instead.
  const shotsDir = 'artifacts/runs';
  const latest = fs
    .readdirSync(shotsDir)
    .sort()
    .pop();
  return {
    url: '(see latest run)',
    title: latest ?? 'unknown',
    screenshotBase64: '',
    viewport: { width: 1440, height: 900 },
    a11yAnnotatedYaml: '',
    refIndex: {},
    frames: [],
    at: new Date().toISOString(),
  };
}

function extractLoginTargets(result: Awaited<ReturnType<DiscoveryRun['run']>>) {
  const loginSteps = result.steps.filter(
    (s) =>
      s.descriptor &&
      /login/.test(s.urlBefore.toLowerCase()) &&
      (s.action.type === 'type' || s.action.type === 'click')
  );
  const userField = loginSteps.find((s) => /user/i.test(s.facts?.id ?? s.facts?.accessibleName ?? ''))?.descriptor;
  const passField = loginSteps.find((s) => /pass/i.test(s.facts?.id ?? s.facts?.accessibleName ?? ''))?.descriptor;
  const submitButton = loginSteps.find((s) => s.action.type === 'click')?.descriptor;
  return { userField, passField, submitButton };
}

program.parseAsync(process.argv);

