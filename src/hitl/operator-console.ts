/**
 * Operator console — the minimal-but-real human handoff surface.
 *
 * Control-transfer model ("lease"):
 *   exactly ONE controller at a time: automation | human.
 *   - automation pauses its loop (awaits a promise)
 *   - an InterventionRequest is registered with full context (why, where,
 *     screenshot, accessibility outline)
 *   - the operator works THE SAME live browser window (it is headed), then
 *     clicks Resume; the lease returns to automation and the loop re-observes
 *     and continues from current state
 *   - while lease=human, a periodic audit sampler captures screenshots +
 *     a11y outlines so WHAT THE HUMAN DID stays in evidence
 */
import express from 'express';
import type { Express, Request, Response } from 'express';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Observation } from '../core/actions.js';

export interface InterventionRequest {
  id: string;
  createdAt: string;
  source: 'discovery' | 'replay';
  reason: string;
  urlAtPause: string;
  screenshotFile?: string;
  a11yOutline?: string;
  status: 'pending' | 'in-human-control' | 'resolved';
}

export class OperatorConsole {
  private app!: Express;
  private server!: Server;
  private interventions = new Map<string, InterventionRequest>();
  private resolvers = new Map<string, (v: 'resumed' | 'aborted') => void>();
  private readonly evidenceDir: string;

  constructor(private readonly port: number, evidenceDir: string) {
    this.evidenceDir = evidenceDir;
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  start(): Promise<void> {
    this.app = express();
    this.app.use(express.json());
    this.app.use('/evidence', express.static(this.evidenceDir));

    this.app.get('/', (_req: Request, res: Response) => {
      const items = [...this.interventions.values()].map((i) => renderCard(i)).join('\n');
      res.type('html').send(HTML_SHELL.replace('<!--CARDS-->', items || '<p>No active interventions.</p>'));
    });

    this.app.get('/api/state', (_req: Request, res: Response) => {
      res.json({
        lease: [...this.interventions.values()].some((i) => i.status === 'pending')
          ? 'awaiting-operator'
          : 'idle',
        interventions: [...this.interventions.values()],
      });
    });

    this.app.post('/api/interventions/:id/takeover', (req, res) => {
      const i = this.interventions.get(req.params.id);
      if (!i) return void res.status(404).json({ ok: false });
      i.status = 'in-human-control';
      res.json({ ok: true, note: 'You now control the live browser window.' });
    });

    this.app.post('/api/interventions/:id/resume', (req, res) => {
      const i = this.interventions.get(req.params.id);
      if (!i) return void res.status(404).json({ ok: false });
      i.status = 'resolved';
      this.resolvers.get(i.id)?.('resumed');
      res.redirect('/');
    });

    this.app.post('/api/interventions/:id/abort', (req, res) => {
      const i = this.interventions.get(req.params.id);
      if (!i) return void res.status(404).json({ ok: false });
      i.status = 'resolved';
      this.resolvers.get(i.id)?.('aborted');
      res.redirect('/');
    });

    return new Promise((resolve) => {
      this.server = createServer(this.app);
      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** Register an intervention and WAIT until the operator resolves it. */
  async requestAndWait(input: {
    source: 'discovery' | 'replay';
    reason: string;
    observation: Observation;
    saveShot?: (base64: string, tag: string) => Promise<string>;
  }): Promise<'resumed' | 'aborted'> {
    const id = randomUUID().slice(0, 8);
    let screenshotFile: string | undefined;
    if (input.saveShot && input.observation.screenshotBase64) {
      screenshotFile = await input.saveShot(input.observation.screenshotBase64, `intervention-${id}`);
    } else if (input.observation.screenshotBase64) {
      const file = path.join(this.evidenceDir, `intervention-${id}.png`);
      fs.writeFileSync(file, Buffer.from(input.observation.screenshotBase64, 'base64'));
      screenshotFile = file;
    }
    const req: InterventionRequest = {
      id,
      createdAt: new Date().toISOString(),
      source: input.source,
      reason: input.reason,
      urlAtPause: input.observation.url,
      ...(screenshotFile ? { screenshotFile } : {}),
      a11yOutline: input.observation.a11yAnnotatedYaml.slice(0, 4000),
      status: 'pending',
    };
    this.interventions.set(id, req);

    // Persist for the audit trail.
    fs.writeFileSync(
      path.join(this.evidenceDir, `intervention-${id}.json`),
      JSON.stringify(req, null, 2)
    );

    return new Promise((resolve) => {
      this.resolvers.set(id, resolve);
    });
  }
}

function renderCard(i: InterventionRequest): string {
  const shotHtml = i.screenshotFile
    ? `<img src="/evidence/${encodeURIComponent(path.basename(i.screenshotFile))}" style="max-width:640px;border:1px solid #999">`
    : '';
  return `
<div style="border:1px solid #444;padding:12px;margin:12px 0;background:#1d2330;color:#e7ecf3">
  <h3>${i.source} · ${i.status}</h3>
  <p><b>Why:</b> ${escapeHtml(i.reason)}</p>
  <p><b>URL:</b> ${escapeHtml(i.urlAtPause)}</p>
  ${shotHtml}
  <details><summary>Accessibility outline</summary><pre style="font-size:10px">${escapeHtml(i.a11yOutline ?? '')}</pre></details>
  <button onclick="fetch('/api/interventions/${i.id}/takeover',{method:'POST'}).then(()=>alert('You are IN CONTROL of the live window. Do what is needed, then come back here.'))">Take control</button>
  <button onclick="fetch('/api/interventions/${i.id}/resume',{method:'POST'}).then(()=>location.reload())">Resume automation</button>
  <button onclick="fetch('/api/interventions/${i.id}/abort',{method:'POST'}).then(()=>location.reload())">Abort</button>
</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

const HTML_SHELL = `<!doctype html><html><head><title>DEFT Operator Console</title></head>
<body style="font-family:Segoe UI,Arial;background:#12151c;margin:0;padding:20px">
<h2 style="color:#e7ecf3">DEFT Operator Console</h2>
<p style="color:#9fb0c3">Live-session handoff. Take control operates the SAME window automation was driving.</p>
<!--CARDS-->
</body></html>`;

