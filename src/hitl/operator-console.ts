import express from 'express';
import type { Express, Request, Response } from 'express';
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Observation } from '../core/actions.js';

export type InterventionKind = 'approval' | 'manual_takeover';
export type InterventionState = 'PENDING' | 'HUMAN_CONTROL' | 'RESUMED' | 'ABORTED' | 'APPROVED';

export interface InterventionRequest {
  id: string; kind: InterventionKind; state: InterventionState; createdAt: string;
  source: 'discovery' | 'replay'; reason: string; sessionId: string; urlAtPause: string;
  beforeSemanticHash: string; afterSemanticHash?: string; humanStateChanges: number;
  screenshotFile?: string; afterScreenshotFile?: string;
  currentScreenshotFile?: string;
  a11yOutline?: string; afterA11yOutline?: string; urlAtResume?: string;
  transitionLogFile: string;
}
export interface DialogLease {
  begin?: () => void | Promise<void>;
  isPending: () => boolean;
  resolve?: (action: 'accept' | 'dismiss') => Promise<void>;
  clickAt?: (x: number, y: number) => Promise<void>;
  cleanup?: () => Promise<void>;
}
export interface InterventionResult {
  state: 'RESUMED' | 'ABORTED' | 'APPROVED'; sessionId: string; before: Observation;
  after?: Observation; humanStateChanges: number;
}
type PendingIntervention = { request: InterventionRequest; before: Observation; observeCurrent: () => Promise<Observation>; dialogLease?: DialogLease };

export class OperatorConsole {
  private app!: Express;
  private server!: Server;
  private interventions = new Map<string, PendingIntervention>();
  private resolvers = new Map<string, (value: InterventionResult) => void>();
  private takeoverInFlight = new Set<string>();

  constructor(private readonly port: number, private readonly evidenceDir: string) { fs.mkdirSync(evidenceDir, { recursive: true }); }

  get baseUrl(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('operator console is not listening');
    return `http://127.0.0.1:${address.port}`;
  }
  listInterventions(): (InterventionRequest & { dialogPending?: boolean })[] {
    return [...this.interventions.values()].map(({ request, dialogLease }) => ({
      ...request,
      ...(dialogLease ? { dialogPending: dialogLease.isPending() } : {}),
    }));
  }

  start(): Promise<void> {
    this.app = express();
    this.app.use(express.json());
    this.app.use('/evidence', express.static(this.evidenceDir));
    this.app.get('/', (_req, res) => res.type('html').send(HTML_SHELL.replace('<!--CARDS-->', this.listInterventions().map(renderCard).join('\n') || '<p>No active interventions.</p>')));
    this.app.get('/api/state', (_req, res) => {
      const states = this.listInterventions().map((i) => i.state);
      const lease = states.includes('HUMAN_CONTROL') ? 'human' : states.includes('PENDING') ? 'awaiting-operator' : 'idle';
      res.json({ lease, interventions: this.listInterventions() });
    });
    this.app.post('/api/interventions/:id/approve', (req, res) => this.approve(req, res));
    this.app.post('/api/interventions/:id/takeover', (req, res) => this.takeover(req, res));
    this.app.post('/api/interventions/:id/resume', (req, res) => void this.resume(req, res));
    this.app.post('/api/interventions/:id/dialog', (req, res) => void this.resolveDialog(req, res));
    this.app.post('/api/interventions/:id/pointer', (req, res) => void this.pointer(req, res));
    this.app.post('/api/interventions/:id/abort', (req, res) => this.abort(req, res));
    return new Promise((resolve) => { this.server = createServer(this.app); this.server.listen(this.port, '127.0.0.1', resolve); });
  }
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeAllConnections();
    });
  }

  async requestAndWait(input: {
    kind?: InterventionKind; source: 'discovery' | 'replay'; reason: string; sessionId?: string;
    observation: Observation; observeCurrent?: () => Promise<Observation>;
    saveShot?: (base64: string, tag: string) => Promise<string>;
    dialogLease?: DialogLease;
  }): Promise<InterventionResult> {
    const id = randomUUID().slice(0, 8);
    const kind = input.kind ?? 'approval';
    const sessionId = input.sessionId ?? `legacy-${id}`;
    let screenshotFile: string | undefined;
    if (input.saveShot && input.observation.screenshotBase64) {
      screenshotFile = await input.saveShot(input.observation.screenshotBase64, `intervention-${id}`) || undefined;
    }
    if (!screenshotFile && input.observation.screenshotBase64) {
      screenshotFile = path.join(this.evidenceDir, `intervention-${id}.png`);
      fs.writeFileSync(screenshotFile, Buffer.from(input.observation.screenshotBase64, 'base64'));
    }
    const request: InterventionRequest = {
      id, kind, state: 'PENDING', createdAt: new Date().toISOString(), source: input.source, reason: input.reason,
      sessionId, urlAtPause: input.observation.url, beforeSemanticHash: semanticHash(input.observation), humanStateChanges: 0,
      transitionLogFile: path.join(this.evidenceDir, `intervention-${id}.jsonl`),
      ...(screenshotFile ? { screenshotFile } : {}), a11yOutline: input.observation.a11yAnnotatedYaml.slice(0, 4000),
    };
    this.interventions.set(id, { request, before: input.observation, observeCurrent: input.observeCurrent ?? (async () => input.observation), dialogLease: input.dialogLease });
    this.persist(request, 'PENDING');
    return new Promise((resolve) => this.resolvers.set(id, resolve));
  }

  private approve(req: Request, res: Response): void {
    const item = this.lookup(req, res); if (!item) return;
    if (item.request.kind !== 'approval' || item.request.state !== 'PENDING') return conflict(res);
    item.request.state = 'APPROVED'; this.persist(item.request, 'APPROVED');
    this.finish(item, { state: 'APPROVED', sessionId: item.request.sessionId, before: item.before, humanStateChanges: 0 });
    res.json({ ok: true });
  }
  private takeover(req: Request, res: Response): void {
    const item = this.lookup(req, res); if (!item) return;
    if (item.request.kind !== 'manual_takeover' || item.request.state !== 'PENDING' || req.body?.sessionId !== item.request.sessionId) return conflict(res);
    if (this.takeoverInFlight.has(item.request.id)) return conflict(res);
    this.takeoverInFlight.add(item.request.id);
    Promise.resolve(item.dialogLease?.begin?.()).then(() => {
      item.request.state = 'HUMAN_CONTROL'; this.persist(item.request, 'HUMAN_CONTROL'); res.json({ ok: true });
    }).catch(async () => {
      try { await item.dialogLease?.cleanup?.(); } catch { /* transition remains pending */ }
      conflict(res);
    }).finally(() => this.takeoverInFlight.delete(item.request.id));
  }
  private async resume(req: Request, res: Response): Promise<void> {
    const item = this.lookup(req, res); if (!item) return;
    if (item.request.kind !== 'manual_takeover' || item.request.state !== 'HUMAN_CONTROL' || req.body?.sessionId !== item.request.sessionId) return conflict(res);
    if (item.dialogLease?.isPending()) return conflict(res);
    const after = await item.observeCurrent();
    const afterHash = semanticHash(after);
    if (afterHash === item.request.beforeSemanticHash) return conflict(res);
    try { await item.dialogLease?.cleanup?.(); } catch { return conflict(res); }
    let afterScreenshotFile: string | undefined;
    if (after.screenshotBase64) {
      afterScreenshotFile = path.join(this.evidenceDir, `intervention-${item.request.id}-after.png`);
      fs.writeFileSync(afterScreenshotFile, Buffer.from(after.screenshotBase64, 'base64'));
    }
    item.request.afterSemanticHash = afterHash;
    item.request.afterScreenshotFile = afterScreenshotFile;
    item.request.afterA11yOutline = after.a11yAnnotatedYaml.slice(0, 4000);
    item.request.urlAtResume = after.url;
    item.request.humanStateChanges = 1;
    item.request.state = 'RESUMED';
    this.persist(item.request, 'RESUMED');
    this.finish(item, { state: 'RESUMED', sessionId: item.request.sessionId, before: item.before, after, humanStateChanges: 1 });
    res.json({ ok: true });
  }
  private async resolveDialog(req: Request, res: Response): Promise<void> {
    const item = this.lookup(req, res); if (!item) return;
    if (item.request.kind !== 'manual_takeover' || item.request.state !== 'HUMAN_CONTROL' || req.body?.sessionId !== item.request.sessionId) return conflict(res);
    if (!item.dialogLease?.resolve || !item.dialogLease.isPending() || !['accept', 'dismiss'].includes(req.body?.action)) return conflict(res);
    try {
      await item.dialogLease.resolve(req.body.action);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.refreshHumanView(item);
      res.json({ ok: true });
    } catch {
      conflict(res);
    }
  }
  private async pointer(req: Request, res: Response): Promise<void> {
    const item = this.lookup(req, res); if (!item) return;
    const { sessionId, x, y } = req.body ?? {};
    if (item.request.kind !== 'manual_takeover' || item.request.state !== 'HUMAN_CONTROL' || sessionId !== item.request.sessionId ||
        !item.dialogLease?.clickAt || item.dialogLease.isPending() || !Number.isInteger(x) || !Number.isInteger(y)) return conflict(res);
    let completed = false; let failure: unknown;
    const click = item.dialogLease.clickAt(x, y).then(() => { completed = true; }).catch((error) => { failure = error; });
    await Promise.race([click, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (failure) return conflict(res);
    if (completed) await this.refreshHumanView(item);
    res.status(completed ? 200 : 202).json({ ok: true, pendingDialog: item.dialogLease.isPending() });
  }
  private async refreshHumanView(item: PendingIntervention): Promise<void> {
    const current = await item.observeCurrent();
    if (current.screenshotBase64) {
      const file = path.join(this.evidenceDir, `intervention-${item.request.id}-current.png`);
      fs.writeFileSync(file, Buffer.from(current.screenshotBase64, 'base64'));
      item.request.currentScreenshotFile = file;
    }
  }
  private async abort(req: Request, res: Response): Promise<void> {
    const item = this.lookup(req, res); if (!item) return;
    if (!['PENDING', 'HUMAN_CONTROL'].includes(item.request.state)) return conflict(res);
    try { await item.dialogLease?.cleanup?.(); } catch { /* terminal abort still releases the intervention */ }
    item.request.state = 'ABORTED'; this.persist(item.request, 'ABORTED');
    this.finish(item, { state: 'ABORTED', sessionId: item.request.sessionId, before: item.before, humanStateChanges: item.request.humanStateChanges });
    res.json({ ok: true });
  }
  private lookup(req: Request, res: Response): PendingIntervention | undefined {
    const item = this.interventions.get(req.params.id as string); if (!item) res.status(404).json({ ok: false }); return item;
  }
  private finish(item: PendingIntervention, result: InterventionResult): void {
    this.resolvers.get(item.request.id)?.(result); this.resolvers.delete(item.request.id);
  }
  private persist(request: InterventionRequest, transition: InterventionState): void {
    fs.writeFileSync(path.join(this.evidenceDir, `intervention-${request.id}.json`), JSON.stringify(request, null, 2));
    fs.appendFileSync(request.transitionLogFile, `${JSON.stringify({ at: new Date().toISOString(), transition, ...request })}\n`);
  }
}

function conflict(res: Response): void { res.status(409).json({ ok: false, error: 'invalid intervention transition' }); }
function semanticHash(o: Observation): string {
  return createHash('sha256').update(JSON.stringify({ url: o.url, title: o.title, a11y: o.a11yAnnotatedYaml, frames: o.frames })).digest('hex');
}
function renderCard(i: InterventionRequest & { dialogPending?: boolean }): string {
  const visibleShot = i.currentScreenshotFile ?? i.screenshotFile;
  const pointer = `const r=this.getBoundingClientRect(),x=Math.round((event.clientX-r.left)*this.naturalWidth/r.width),y=Math.round((event.clientY-r.top)*this.naturalHeight/r.height);fetch('/api/interventions/${i.id}/pointer',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:'${escapeHtml(i.sessionId)}',x,y})}).then(()=>setTimeout(()=>location.reload(),650))`;
  const shot = visibleShot ? `<img alt="Live session; click to control" src="/evidence/${encodeURIComponent(path.basename(visibleShot))}" style="max-width:640px;cursor:crosshair"${i.state === 'HUMAN_CONTROL' && !i.dialogPending ? ` onclick="${pointer}"` : ''}>` : '';
  const post = (action: string, body = 'JSON.stringify({})') => `fetch('/api/interventions/${i.id}/${action}',{method:'POST',headers:{'content-type':'application/json'},body:${body}}).then(()=>location.reload())`;
  const sessionBody = `JSON.stringify({sessionId:'${escapeHtml(i.sessionId)}'})`;
  const dialogControls = i.kind === 'manual_takeover' && i.state === 'HUMAN_CONTROL' && i.dialogPending
    ? `<button onclick="${post('dialog', `JSON.stringify({sessionId:'${escapeHtml(i.sessionId)}',action:'accept'})`)}">Accept dialog</button><button onclick="${post('dialog', `JSON.stringify({sessionId:'${escapeHtml(i.sessionId)}',action:'dismiss'})`)}">Dismiss dialog</button>`
    : '';
  const controls = i.kind === 'approval'
    ? `<button onclick="${post('approve')}">Approve</button>`
    : `<button onclick="${post('takeover', sessionBody)}">Take control</button>${dialogControls}<button onclick="${post('resume', sessionBody)}">Resume</button>`;
  return `<div><h3>${escapeHtml(i.source)} · ${i.kind} · ${i.state}</h3><p>${escapeHtml(i.reason)}</p>${shot}<details><summary>Accessibility outline</summary><pre>${escapeHtml(i.a11yOutline ?? '')}</pre></details>${controls}<button onclick="${post('abort')}">Abort</button></div>`;
}
function escapeHtml(s: string): string { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
const HTML_SHELL = '<!doctype html><html><body><h2>DEFT Operator Console</h2><!--CARDS--></body></html>';
