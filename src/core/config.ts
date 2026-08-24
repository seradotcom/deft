/** Central configuration. Secrets NEVER live here — only references. */
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  geminiApiKey: string;
  plannerModel: string;
  baseUrlByTenant: Record<string, string>;
  capabilitiesDir: string;
  runsDir: string;
  evidenceDir: string;
  operatorPort: number;
  viewport: { width: number; height: number };
}

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/i);
    if (m?.[1] && m[2] && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

export function loadConfig(repoRoot?: string): AppConfig {
  const root = repoRoot ?? findRepoRoot();
  loadDotEnv(path.join(root, '.env'));
  return {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    plannerModel: process.env.DEFT_PLANNER_MODEL ?? 'gemini-3.5-flash-lite',
    baseUrlByTenant: {
      acme: process.env.DEFT_TENANT_ACME_URL ?? 'http://localhost:7788/acme',
      nw: process.env.DEFT_TENANT_NW_URL ?? 'http://localhost:7788/nw',
    },
    capabilitiesDir: path.join(root, 'capabilities'),
    runsDir: path.join(root, 'artifacts', 'runs'),
    evidenceDir: path.join(root, 'evidence'),
    operatorPort: Number(process.env.DEFT_OPERATOR_PORT ?? 7790),
    viewport: { width: 1440, height: 900 },
  };
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}
