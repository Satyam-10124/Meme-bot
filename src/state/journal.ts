import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Address, Hex } from 'viem';

export type JobState =
  | 'REQUESTED'
  | 'METADATA_OK'
  | 'LAUNCHED'
  | 'HOLDING'
  | 'EXITING'
  | 'EXITED'
  | 'HARVESTING'
  | 'SETTLED'
  | 'FAILED_METADATA'
  | 'FAILED_LAUNCH'
  | 'FAILED_EXIT'
  | 'QUARANTINED';

export interface Job {
  id: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  sourceToken?: Address;
  name?: string;
  symbol?: string;
  launcher?: Address;
  creatorFeeRecipient?: Address;
  token?: Address;
  curve?: Address;
  launchTxHash?: Hex;
  launchBlock?: string;
  /** Pricing quote reserve immediately after the pre-buy filled — the entry for `m`. */
  entryQuoteReserve?: string;
  tokensBought?: string;
  tokensSold?: string;
  quoteRecovered?: string;
  peakMultipleBps?: string;
  rungsFilled?: number[];
  lastError?: string;
}

interface Snapshot {
  version: 1;
  jobs: Record<string, Job>;
}

/**
 * Crash-safe job journal. Every mutation appends an intent line to `journal.log` before the
 * snapshot is rewritten atomically, so a crash between "sent" and "confirmed" is recoverable
 * by replaying the log rather than by trusting cached balances.
 */
export class Journal {
  private readonly dir: string;
  private readonly snapshotPath: string;
  private readonly logPath: string;
  private snapshot: Snapshot;

  constructor(dir: string) {
    this.dir = dir;
    this.snapshotPath = join(dir, 'jobs.json');
    this.logPath = join(dir, 'journal.log');
    mkdirSync(dir, { recursive: true });
    this.snapshot = existsSync(this.snapshotPath)
      ? (JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as Snapshot)
      : { version: 1, jobs: {} };
  }

  list(): Job[] {
    return Object.values(this.snapshot.jobs).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Job | undefined {
    return this.snapshot.jobs[id];
  }

  create(id: string, fields: Partial<Job> = {}): Job {
    const existing = this.snapshot.jobs[id];
    if (existing) return existing;
    const now = Date.now();
    const job: Job = { id, state: 'REQUESTED', createdAt: now, updatedAt: now, ...fields };
    this.snapshot.jobs[id] = job;
    this.persist('create', job);
    return job;
  }

  update(id: string, fields: Partial<Job>): Job {
    const job = this.snapshot.jobs[id];
    if (!job) throw new Error(`unknown job ${id}`);
    Object.assign(job, fields, { updatedAt: Date.now() });
    this.persist('update', job);
    return job;
  }

  /** Records an intent before a transaction is sent, so a crash leaves a readable trail. */
  intent(id: string, action: string, detail: Record<string, unknown>): void {
    appendFileSync(
      this.logPath,
      `${JSON.stringify({ ts: Date.now(), id, action, detail })}\n`,
      'utf8',
    );
  }

  private persist(action: string, job: Job): void {
    this.intent(job.id, action, { state: job.state });
    const tmp = `${this.snapshotPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.snapshot, null, 2), 'utf8');
    renameSync(tmp, this.snapshotPath);
  }

  get directory(): string {
    return this.dir;
  }
}
