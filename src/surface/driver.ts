/**
 * SurfaceDriver port + Playwright web implementation.
 *
 * Design notes (REPORT §Heterogeneity):
 *  - The port (SurfaceDriver) is what a desktop/UIA driver would implement;
 *    nothing above it knows about DOM specifics.
 *  - Observation = screenshot + per-frame accessibility YAML annotated with
 *    stable [eN] refs, so vision planners can target by pixel OR by element.
 *  - Actions execute at the level closest to "what a human does": grid
 *    coordinates become real mouse events; element refs become semantic
 *    clicks. Both produce identical evidence.
 */
import { chromium, type Browser, type BrowserContext, type Frame, type JSHandle, type Page } from 'playwright';
import type {
  ActOutcome,
  AgentAction,
  ElementFacts,
  Observation,
  SurfaceEvent,
  TargetHint,
} from '../core/actions.js';

export interface SurfaceDriverOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
}

export interface SurfaceDriver {
  start(): Promise<void>;
  close(): Promise<void>;
  observe(): Promise<Observation>;
  act(action: AgentAction): Promise<ActOutcome>;
  currentUrl(): string;
  bringToFront(): Promise<void>;
  screenshot(): Promise<{ base64: string }>;
  drainEvents(): SurfaceEvent[];
  // Recorder/compiler helpers:
  factsAtGridPoint(x999: number, y999: number): Promise<ElementFacts | null>;
  /** Facts for an [eN] ref from the latest observation (for verified recording). */
  factsForRef(ref: string): Promise<ElementFacts | null>;
  /** Marks the element at a frame-local point with a temporary probe attribute. */
  markElementInFrame(framePath: string[], localX: number, localY: number): Promise<boolean>;
  /** Runs a candidate locator inside a frame; true iff its FIRST match carries the probe mark. */
  probeCandidate(framePath: string[], probe: LocatorProbe): Promise<boolean>;
  probeId(framePath: string[], id: string): Promise<boolean>;
  clearProbeMarks(framePath?: string[]): Promise<void>;
}

export interface LocatorProbe {
  kind: 'role' | 'label' | 'text' | 'placeholder' | 'title';
  role?: string;
  name?: string;
  exact?: boolean;
}

const PROBE_ATTR = 'data-deft-probe';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'menuitem', 'tab', 'option', 'slider', 'switch',
]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class PlaywrightWebDriver implements SurfaceDriver {
  private browser!: Browser;
  private context!: BrowserContext;
  private _page!: Page;
  /** Escape hatch for Playwright-specific resolution (replay engine). A desktop
   *  driver would expose an equivalent surface-specific context instead. */
  get page(): Page {
    return this._page;
  }
  private readonly opts: Required<SurfaceDriverOptions>;
  private eventLog: SurfaceEvent[] = [];
  private lastObs: Observation | null = null;

  constructor(opts: SurfaceDriverOptions = {}) {
    this.opts = {
      headless: opts.headless ?? false,
      viewport: opts.viewport ?? { width: 1440, height: 900 },
    };
  }

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: ['--window-size=1480,1000'],
    });
    this.context = await this.browser.newContext({ viewport: this.opts.viewport });
    this._page = await this.context.newPage();
    this.wirePage(this._page);
  }

  private wirePage(p: Page): void {
    p.on('dialog', async (d) => {
      this.eventLog.push({
        kind: 'dialog',
        detail: `${d.type()}: ${d.message()}`.slice(0, 300),
        at: new Date().toISOString(),
      });
      try {
        await d.accept();
      } catch {
        /* auto-dismissed races */
      }
    });
    p.on('crash', () => {
      this.eventLog.push({ kind: 'crash', detail: 'page crashed', at: new Date().toISOString() });
    });
  }

  async close(): Promise<void> {
    await this.browser?.close();
  }

  /**
   * Settle after an action. Legacy form flows are chains of 302 redirects:
   * domcontentloaded fires on the EMPTY redirect response, so we additionally
   * require the top+frame URL signature to stay stable for 500ms.
   */
  async waitForLoadStateSettle(): Promise<void> {
    await this._page.waitForLoadState('domcontentloaded').catch(() => undefined);
    const deadline = Date.now() + 6000;
    let prev = this.frameSignature();
    let lastChange = Date.now();
    if (process.env.DEFT_SETTLE_TRACE) console.error(`[settle] t0 sig=${prev.slice(0, 120)}`);
    while (Date.now() < deadline) {
      await this._page.waitForTimeout(150);
      const cur = this.frameSignature();
      if (process.env.DEFT_SETTLE_TRACE) console.error(`[settle] +${Date.now() - deadline + 6000}ms sig=${cur.slice(0, 120)}`);
      if (cur !== prev) {
        prev = cur;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= 500) {
        break;
      }
    }
    if (process.env.DEFT_SETTLE_TRACE) console.error(`[settle] done final=${prev.slice(0, 120)}`);
  }

  private frameSignature(): string {
    return [this._page.url(), ...this._page.frames().map((f) => f.name() + '=' + f.url())].join('|');
  }

  currentUrl(): string {
    return this._page.url();
  }

  drainEvents(): SurfaceEvent[] {
    const out = this.eventLog;
    this.eventLog = [];
    return out;
  }

  async bringToFront(): Promise<void> {
    await this._page.bringToFront();
  }

  async screenshot(): Promise<{ base64: string }> {
    const buf = await this._page.screenshot({ type: 'png', animations: 'disabled' });
    return { base64: buf.toString('base64') };
  }

  // ---- observation ---------------------------------------------------------

  async observe(): Promise<Observation> {
    await this._page.waitForLoadState('domcontentloaded').catch(() => undefined);
    const shot = await this.screenshot();
    const refIndex: Observation['refIndex'] = {};
    let counter = 0;
    let yamlOut = '';

    for (const frame of this._page.frames()) {
      const path = framePathOf(this._page, frame);
      let snap: string;
      try {
        snap = await frame.locator('html').ariaSnapshot({ timeout: 3000 });
      } catch {
        continue;
      }
      const lines = snap.split('\n');
      const annotated = lines.map((line) => {
        const role = yamlRole(line);
        if (!role || !INTERACTIVE_ROLES.has(role)) return line;
        counter += 1;
        const ref = `e${counter}`;
        refIndex[ref] = { framePath: path, yamlLine: line.trim().replace(/\s*\[e\d+\]$/, '') };
        return `${line} [${ref}]`;
      });
      yamlOut += `# frame ${path.length ? path.join('>') : 'main'} url=${frame.url()}\n${annotated.join('\n')}\n`;
    }

    const obs: Observation = {
      url: this._page.url(),
      title: await this._page.title(),
      screenshotBase64: shot.base64,
      viewport: this.opts.viewport,
      a11yAnnotatedYaml: yamlOut.trimEnd(),
      refIndex,
      frames: this._page.frames().map((f) => ({ name: f.name(), url: f.url() })),
      at: new Date().toISOString(),
    };
    this.lastObs = obs;
    return obs;
  }

  // ---- actions --------------------------------------------------------------

  async act(action: AgentAction): Promise<ActOutcome> {
    try {
      switch (action.type) {
        case 'navigate':
          await this._page.goto(toAbsolute(action.url, this._page.url()), {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          break;
        case 'click': {
          const t = await this.toTarget(action.hint);
          if ('px' in t) await this._page.mouse.click(t.px.x, t.px.y);
          else await (await this.refHandle(t.ref)).asElement()!.click({ timeout: 8000 });
          break;
        }
        case 'type': {
          const t = await this.toTarget(action.hint);
          if ('px' in t) await this._page.mouse.click(t.px.x, t.px.y);
          else await (await this.refHandle(t.ref)).asElement()!.click({ timeout: 8000 });
          if (action.clearBeforeTyping) await this._page.keyboard.press('Control+A');
          await this._page.keyboard.type(action.text, { delay: 10 });
          if (action.pressEnter) await this._page.keyboard.press('Enter');
          break;
        }
        case 'select': {
          if (!action.hint || !('elementRef' in action.hint)) {
            throw deftError('PLANNER_ERROR', 'select requires an elementRef hint');
          }
          const el = (await this.refHandle(action.hint.elementRef)).asElement();
          if (!el) throw deftError('ELEMENT_NOT_FOUND', `ref missing`);
          await el.selectOption({ label: action.optionText }).catch(() =>
            el.selectOption(action.optionText)
          );
          break;
        }
        case 'scroll': {
          const mag = Math.round(((action.magnitude ?? 400) / 999) * this.opts.viewport.height);
          await this._page.mouse.wheel(0, action.direction === 'up' ? -mag : mag);
          break;
        }
        case 'key':
          await this._page.keyboard.press(action.combo);
          break;
        case 'wait':
          await this._page.waitForTimeout(action.ms);
          break;
        case 'done':
        case 'fail':
        case 'ask_human':
          break; // loop-level decisions; nothing to execute here
      }
      await this._page.waitForLoadState('domcontentloaded').catch(() => undefined);
      return { ok: true, events: this.drainEvents() };
    } catch (err) {
      const e = err as Error & { deftClass?: string };
      return {
        ok: false,
        errorClass: e.deftClass ?? classifyPlaywrightError(e.message ?? ''),
        message: ((e.message ?? String(e)).split('\n')[0] ?? '').slice(0, 300),
        events: this.drainEvents(),
      };
    }
  }

  private async toTarget(
    hint: TargetHint | undefined
  ): Promise<{ px: { x: number; y: number } } | { ref: string }> {
    if (!hint) throw deftError('PLANNER_ERROR', 'action requires a target hint');
    if ('elementRef' in hint) return { ref: hint.elementRef };
    if ('px' in hint) return { px: hint.px };
    return { px: gridToPx(hint.x, hint.y, this.opts.viewport) };
  }

  /** Resolve an [eN] ref from the latest observation into a live JSHandle. */
  private async refHandle(ref: string): Promise<JSHandle> {
    const key = ref.replace(/[\[\]]/g, ''); // tolerate "[e4]" from models
    const entry = this.lastObs?.refIndex[key];
    if (!entry) throw deftError('ELEMENT_NOT_FOUND', `unknown ref ${ref}`);
    const parsed = yamlNode(entry.yamlLine);
    if (!parsed) throw deftError('ELEMENT_NOT_FOUND', `unparsable ref line for ${ref}`);
    const frame = this.resolveFramePath(entry.framePath);

    const nth = Math.max(
      0,
      // Nameless nodes disambiguate BY ROLE: a sibling's line can switch from
      // bare ("- textbox") to value-form ("- textbox: teller1") after typing,
      // which breaks identical-line counting (found the hard way — the
      // password ended up in the user field).
      nthOccurrenceAbove(this.lastObs!, ref, parsed.name === undefined ? parsed.role : undefined)
    );
    const candidates: import('playwright').Locator[] = [];
    if (parsed.role && parsed.name !== undefined) {
      candidates.push(byRole(frame, parsed.role, parsed.name).nth(nth));
      candidates.push(byRoleExact(frame, parsed.role, parsed.name).nth(nth));
    }
    if (parsed.role && parsed.name === undefined) {
      // Nameless/colon-form controls — role alone, nth-disambiguated. For
      // value-form nodes the nth counts among IDENTICAL lines which already
      // reflects the value the model saw.
      candidates.push(
        frame.getByRole(parsed.role as Parameters<Frame['getByRole']>[0]).nth(nth)
      );
    }
    if (parsed.name !== undefined) {
      candidates.push(frame.getByText(parsed.name, { exact: false }).nth(nth));
    }
    for (const loc of candidates) {
      const h = await loc.elementHandle({ timeout: 2500 }).catch(() => null);
      if (h) return h;
    }
    throw deftError('ELEMENT_NOT_FOUND', `no element for ${ref}`);
  }

  private resolveFramePath(path: string[]): Frame {
    let frame: Frame = this._page.mainFrame();
    for (const name of path) {
      const next = frame.childFrames().find((f) => f.name() === name || f.url() === name);
      if (!next) break;
      frame = next;
    }
    return frame;
  }

  // ---- recorder helpers -------------------------------------------------------

  async factsAtGridPoint(x999: number, y999: number): Promise<ElementFacts | null> {
    const { x: px, y: py } = gridToPx(x999, y999, this.opts.viewport);
    for (const frame of this._page.frames()) {
      const path = framePathOf(this._page, frame);
      const origin = await this.frameOrigin(path);
      const ix = Math.round(px - origin.x);
      const iy = Math.round(py - origin.y);
      if (ix < 0 || iy < 0) continue;
      const size = await frameSize(frame);
      if (size && (ix >= size.width || iy >= size.height)) continue;
      const facts = await this.evalIn<ElementFacts | null>(frame, factsAtPointFn, [ix, iy]);
      if (facts) {
        facts.framePath = path;
        return facts;
      }
    }
    return null;
  }

  private async frameOrigin(path: string[]): Promise<{ x: number; y: number }> {
    if (path.length === 0) return { x: 0, y: 0 };
    try {
      const leafName = path[path.length - 1];
      const parent = this.resolveFramePath(path.slice(0, -1));
      const child = parent.childFrames().find((f) => f.name() === leafName || f.url() === leafName);
      if (!child) return { x: 0, y: 0 };
      const fe = await child.frameElement();
      const box = await fe.asElement()?.boundingBox();
      return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  }

  async evaluateInFrame<T>(framePath: string[], fn: (arg: never) => unknown, arg?: unknown): Promise<T | null> {
    try {
      return (await this.resolveFramePath(framePath).evaluate(fn as never, arg as never)) as T;
    } catch {
      return null;
    }
  }

  private async evalIn<T>(frame: Frame, fn: (arg: never) => unknown, arg?: unknown): Promise<T | null> {
    try {
      return (await frame.evaluate(fn as never, arg as never)) as T;
    } catch (err) {
      console.error('[deft:evalIn]', (err as Error).message?.split('\n')[0]?.slice(0, 200));
      return null;
    }
  }

  async factsForRef(ref: string): Promise<ElementFacts | null> {
    const entry = this.lastObs?.refIndex[ref.replace(/[\[\]]/g, '')];
    if (!entry) return null;
    try {
      const handle = await this.refHandle(ref);
      const el = handle.asElement();
      if (!el) return null;
      const box = await el.boundingBox();
      await handle.dispose();
      if (!box) return null;
      const origin = await this.frameOrigin(entry.framePath);
      const localX = Math.round(box.x - origin.x + box.width / 2);
      const localY = Math.round(box.y - origin.y + box.height / 2);
      const facts = await this.evalIn<ElementFacts | null>(
        this.resolveFramePath(entry.framePath),
        factsAtPointFn,
        [localX, localY]
      );
      if (facts) facts.framePath = entry.framePath;
      return facts;
    } catch {
      return null;
    }
  }

  /** Reverse relational lookup: locate a value inside data tables and return
   *  its (rowKeyHeader, rowKeyValue, colHeader) so the compiler can emit TableExtract. */
  findTableCellForValue(
    framePath: string[],
    value: string
  ): Promise<
    { rowHeader: string; rowKeyValue: string; colHeader: string } | { ambiguous: true; matchCount: number } | null>;
  findTableCellForValue(
    framePath: string[],
    value: string
  ): Promise<{ rowHeader: string; rowKeyValue: string; colHeader: string } | null> {
    return this.evalIn(this.resolveFramePath(framePath), findCellFn, value);
  }

  async markElementInFrame(framePath: string[], localX: number, localY: number): Promise<boolean> {
    await this.clearProbeMarks();
    return (
      (await this.evalIn<boolean>(this.resolveFramePath(framePath), markAtPointFn, [
        Math.round(localX),
        Math.round(localY),
      ])) ?? false
    );
  }

  async probeId(framePath: string[], id: string): Promise<boolean> {
    return this.probeSelector(framePath, `#${cssEscapeAttr(id)}`);
  }

  /** Probe any CSS selector against the marked element (name attrs, ids). */
  async probeSelector(framePath: string[], selector: string): Promise<boolean> {
    const frame = this.resolveFramePath(framePath);
    try {
      const handle = await frame
        .locator(selector)
        .first()
        .elementHandle({ timeout: 1200 })
        .catch(() => null);
      if (!handle) return false;
      try {
        return await handle.evaluate((el) => el.hasAttribute('data-deft-probe'));
      } finally {
        await handle.dispose();
      }
    } catch {
      return false;
    }
  }

  async probeCandidate(framePath: string[], probe: LocatorProbe): Promise<boolean> {
    const frame = this.resolveFramePath(framePath);
    let loc: import('playwright').Locator;
    switch (probe.kind) {
      case 'role':
        loc = probe.exact
          ? byRoleExact(frame, probe.role!, probe.name!)
          : byRole(frame, probe.role!, probe.name!);
        break;
      case 'label':
        loc = frame.getByLabel(probe.name!, { exact: probe.exact ?? false });
        break;
      case 'text':
        loc = frame.getByText(probe.name!, { exact: probe.exact ?? false });
        break;
      case 'placeholder':
        loc = frame.getByPlaceholder(probe.name!);
        break;
      case 'title':
        loc = frame.getByTitle(probe.name!, { exact: probe.exact ?? false });
        break;
      default:
        return false;
    }
    try {
      const handle = await loc.first().elementHandle({ timeout: 1200 }).catch(() => null);
      if (!handle) return false;
      try {
        return await handle.evaluate((el) => el.hasAttribute('data-deft-probe'));
      } finally {
        await handle.dispose();
      }
    } catch {
      return false;
    }
  }

  async clearProbeMarks(framePath?: string[]): Promise<void> {
    const frames = framePath ? [this.resolveFramePath(framePath)] : this._page.frames();
    for (const f of frames) {
      await f.evaluate(() => {
        document.querySelectorAll('[data-deft-probe]').forEach((e) => e.removeAttribute('data-deft-probe'));
      }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// In-page functions (Playwright serializes real closures — never use strings)
// ---------------------------------------------------------------------------

const factsAtPointFn = (coords: number[]): ElementFacts | null => {
  const x = coords[0] ?? 0;
  const y = coords[1] ?? 0;
  const doc = document as Document & { elementsFromPoint?: (px: number, py: number) => Element[] };
  const pts = doc.elementsFromPoint?.(x, y) ?? [];
  const html = document.documentElement;
  const body = document.body;
  // Frame wrappers are NOT targets: returning null lets the caller descend
  // into child frames where the real control lives (legacy framesets).
  const el = pts.find(
    (e) => e !== html && e !== body && e.tagName !== 'FRAME' && e.tagName !== 'IFRAME'
  ) ?? null;
  if (!el || !(el instanceof HTMLElement)) return null;
  const inputEl = el as HTMLInputElement;
  const accName = (): string => {
    const al = el.getAttribute('aria-label');
    if (al) return al.trim();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(inputEl.type)) {
      return (inputEl.value || '').trim();
    }
    if (el.tagName === 'IMG') return ((el as HTMLImageElement).alt || '').trim();
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return ((l as HTMLElement).innerText || '').trim();
    }
    const wrap = el.closest('label');
    if (wrap) return (((wrap as HTMLElement).innerText || '') as string).replace(el.innerText || '', '').trim();
    return (el.innerText || '').trim().slice(0, 90);
  };
  const ROLE_MAP: Record<string, string> = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', OPTION: 'option' };
  let role = el.getAttribute('role') || '';
  if (!role) {
    if (el.tagName === 'INPUT') {
      const t = inputEl.type;
      role = ['submit', 'button', 'reset'].includes(t) ? 'button'
        : t === 'checkbox' ? 'checkbox'
        : t === 'radio' ? 'radio'
        : t === 'search' ? 'searchbox'
        : 'textbox';
    } else if (/^H[1-6]$/.test(el.tagName)) role = 'heading';
    else role = ROLE_MAP[el.tagName] || (el.isContentEditable ? 'textbox' : 'generic');
  }
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    role,
    accessibleName: accName() || undefined,
    visibleText: (el.innerText || '').trim().slice(0, 90) || undefined,
    id: el.id || undefined,
    nameAttr: el.getAttribute('name') || undefined,
    typeAttr: el.getAttribute('type') || undefined,
    placeholder: inputEl.placeholder || undefined,
    title: el.getAttribute('title') || undefined,
    value: 'value' in el ? String(inputEl.value).slice(0, 90) : undefined,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    ordinalInParent: el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0,
    parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : undefined,
    framePath: [],
  };
};

const markAtPointFn = (coords: number[]): boolean => {
  const x = coords[0] ?? 0;
  const y = coords[1] ?? 0;
  const doc = document as Document & { elementsFromPoint?: (px: number, py: number) => Element[] };
  const pts = doc.elementsFromPoint?.(x, y) ?? [];
  const html = document.documentElement;
  const body = document.body;
  const el = pts.find(
    (e) => e !== html && e !== body && e.tagName !== 'FRAME' && e.tagName !== 'IFRAME'
  );
  if (!el || !el.setAttribute) return false;
  document.querySelectorAll('[data-deft-probe]').forEach((e) => e.removeAttribute('data-deft-probe'));
  el.setAttribute('data-deft-probe', '1');
  return true;
};

/** Reverse table lookup: given a cell value, find its column header and the
 *  header+value of the row's key cell. AMBIGUITY IS DATA: if the value matches
 *  more than one row, the binding is not a safe extraction identity and the
 *  caller must fail loudly instead of returning "the first match". */
const findCellFn = (
  value: string
): { rowHeader: string; rowKeyValue: string; colHeader: string } | { ambiguous: true; matchCount: number } | null => {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const table of Array.from(document.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length < 2) continue;
    const headRow = rows[0];
    if (!headRow) continue;
    const headers = Array.from(headRow.querySelectorAll('th,td')).map((h) =>
      (h.textContent || '').trim()
    );
    for (const row of rows.slice(1)) {
      const cells = Array.from(row.querySelectorAll('td'));
      const hitIdx = cells.findIndex((c) => norm(c.textContent || '') === norm(value));
      if (hitIdx === -1 || headers[hitIdx] === undefined) continue;
      // Count ALL rows in this table matching the same value.
      let matchCount = 0;
      let first: { cells: HTMLElement[]; hitIdx: number } | null = null;
      for (const r2 of rows.slice(1)) {
        const cs = Array.from(r2.querySelectorAll('td'));
        if (cs[hitIdx] && norm(cs[hitIdx].textContent || '') === norm(value)) {
          matchCount += 1;
          if (!first) first = { cells: cs, hitIdx };
        }
      }
      if (matchCount > 1) return { ambiguous: true, matchCount };
      let keyIdx = first!.cells.findIndex(
        (c, i) => i !== hitIdx && (c.textContent || '').trim() !== ''
      );
      if (keyIdx === -1) keyIdx = 0;
      const rowHeader = headers[keyIdx] ?? '';
      if (!rowHeader) continue;
      return {
        rowHeader,
        rowKeyValue: (first!.cells[keyIdx]?.textContent || '').trim(),
        colHeader: headers[hitIdx] ?? '',
      };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function deftError(cls: string, msg: string): Error {
  return Object.assign(new Error(msg), { deftClass: cls });
}

/** getByRole with dynamic role strings (Playwright's union type is closed). */
function byRole(frame: Frame, role: string, name: string): import('playwright').Locator {
  return frame.getByRole(role as Parameters<Frame['getByRole']>[0], { name });
}
function byRoleExact(frame: Frame, role: string, name: string): import('playwright').Locator {
  return frame.getByRole(role as Parameters<Frame['getByRole']>[0], { name, exact: true });
}

export function gridToPx(
  x999: number,
  y999: number,
  viewport: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(viewport.width - 1, Math.round((x999 / 999) * (viewport.width - 1)))),
    y: Math.max(0, Math.min(viewport.height - 1, Math.round((y999 / 999) * (viewport.height - 1)))),
  };
}

function framePathOf(page: Page, frame: Frame): string[] {
  const path: string[] = [];
  let cur: Frame | null = frame;
  while (cur && cur !== page.mainFrame()) {
    path.unshift(cur.name() || cur.url());
    cur = cur.parentFrame();
  }
  return path;
}

async function frameSize(frame: Frame): Promise<{ width: number; height: number } | null> {
  try {
    const fe = await frame.frameElement();
    const box = await fe.asElement()?.boundingBox();
    return box ? { width: box.width, height: box.height } : null;
  } catch {
    return null;
  }
}

function yamlRole(line: string): string | null {
  const m = line.match(/^\s*-\s+([a-zA-Z]+)/);
  return m?.[1] ?? null;
}

function yamlNode(line: string): { role?: string; name?: string; isValueForm?: boolean } | null {
  const quoted = line.match(/^\s*-\s+([a-zA-Z]+)\s+"([^"]*)"/);
  if (quoted) return { role: quoted[1], name: quoted[2] };
  // Colon form carries the element VALUE (e.g. "- textbox: teller1"), NOT its
  // accessible name — treating it as a name broke re-resolution after typing.
  const colon = line.match(/^\s*-\s+([a-zA-Z]+):\s*(.*)$/);
  if (colon) return { role: colon[1], name: undefined, isValueForm: true };
  const bare = line.match(/^\s*-\s+([a-zA-Z]+)\s*(\[.*)?$/);
  if (bare) return { role: bare[1], name: undefined };
  return null;
}

/** How many equivalent interactive lines appear ABOVE this ref (for .nth()).
 *  Value-form nodes (colon YAML) are counted BY ROLE since their values make
 *  every line textually unique. */
function nthOccurrenceAbove(obs: Observation, ref: string, role?: string): number {
  const me = obs.refIndex[ref];
  if (!me) return 0;
  const myNum = Number(ref.slice(1));
  let n = 0;
  for (const [r, info] of Object.entries(obs.refIndex)) {
    const num = Number(r.slice(1));
    if (num >= myNum) continue;
    if (info.framePath.join('>') !== me.framePath.join('>')) continue;
    if (role) {
      if (yamlRole(info.yamlLine) === role) n += 1;
    } else if (info.yamlLine === me.yamlLine) {
      n += 1;
    }
  }
  return n;
}

export function classifyPlaywrightError(message: string): string {
  if (/Timeout.*exceeded/i.test(message)) return 'TIMEOUT';
  if (/strict mode violation/i.test(message)) return 'AMBIGUOUS_TARGET';
  if (/detached from DOM/i.test(message)) return 'TARGET_DETACHED';
  if (/Target closed|has been closed/i.test(message)) return 'SESSION_DEAD';
  if (/net::ERR/i.test(message)) return 'NETWORK_ERROR';
  return 'UNKNOWN_SURFACE_ERROR';
}

function cssEscapeAttr(s: string): string {
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}

function toAbsolute(url: string, current: string): string {
  try {
    new URL(url);
    return url;
  } catch {
    try {
      return new URL(url, current).toString();
    } catch {
      return url;
    }
  }
}


