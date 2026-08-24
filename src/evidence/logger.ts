/**
 * EvidenceLogger — structured, redacted JSONL per run + screenshot store.
 * Every run (discovery or replay) produces a self-contained bundle:
 *
 *   artifacts/runs/<runId>/
 *     log.jsonl        one event per line: decisions, actions, checks, errors
 *     shots/<n>.png    screenshots keyed by sequence number
 *
 * Redaction happens AT THE SINK: registered secrets are replaced before
 * serialization, on top of pattern-based redaction — nothing leaves the
 * process boundary unscrubbed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactDeep } from '../safety/redact.js';

export type EvidenceEvent = Record<string, unknown>;

export class EvidenceLogger {
  readonly runId: string;
  readonly dir: string;
  private logPath: string;
  private shotSeq = 0;
  private secrets = new Set<string>();

  constructor(runsDir: string, kind: 'discovery' | 'replay', label?: string) {
    this.runId = `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    this.dir = path.join(runsDir, this.runId);
    fs.mkdirSync(path.join(this.dir, 'shots'), { recursive: true });
    this.logPath = path.join(this.dir, 'log.jsonl');
    this.write({
      t: new Date().toISOString(),
      type: 'run_start',
      runId: this.runId,
      kind,
      label,
    });
  }

  /** Values that must NEVER appear in evidence (credentials etc.). */
  registerSecrets(values: Array<string | undefined>): void {
    for (const v of values) {
      if (v && v.length >= 4) this.secrets.add(v);
    }
  }

  /** Replace registered secrets in any string (logs and transcripts alike). */
  scrub(s: string): string {
    let out = s;
    let i = 0;
    for (const secret of this.secrets) {
      i += 1;
      out = out.split(secret).join(`«secret-${i}»`);
    }
    return out;
  }

  write(event: EvidenceEvent): void {
    const line = this.scrub(JSON.stringify(redactDeep({ t: new Date().toISOString(), ...event })));
    fs.appendFileSync(this.logPath, line + '\n');
  }

  async saveShot(base64: string, tag: string): Promise<string> {
    this.shotSeq += 1;
    const name = `${String(this.shotSeq).padStart(3, '0')}-${tag.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
    const rel = path.join('shots', name);
    fs.writeFileSync(path.join(this.dir, rel), Buffer.from(base64, 'base64'));
    return rel;
  }

  /** Relative path of the log — referenced from result contracts & evidence bundles. */
  get logRef(): string {
    return path.relative(process.cwd(), this.logPath);
  }
}
