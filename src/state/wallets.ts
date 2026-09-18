import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export interface JobWallet {
  jobId: string;
  address: Address;
  privateKey: Hex;
  createdAt: number;
  /** Central wallet that funded this one and receives its dust back. */
  fundedBy: Address;
  token?: Address;
  curve?: Address;
}

interface Book {
  version: 1;
  wallets: JobWallet[];
}

/**
 * Per-launch wallet book: one fresh key per job, kept in `<stateDir>/wallets.json` (mode 0600,
 * git-ignored) so a position can always be recovered by hand even if the bot dies mid-round.
 * Keys never go through env or logs; the file is the only copy, so back it up.
 */
export class WalletBook {
  readonly path: string;
  private book: Book;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'wallets.json');
    this.book = existsSync(this.path)
      ? (JSON.parse(readFileSync(this.path, 'utf8')) as Book)
      : { version: 1, wallets: [] };
  }

  list(): JobWallet[] {
    return [...this.book.wallets];
  }

  get(jobId: string): JobWallet | undefined {
    return this.book.wallets.find((w) => w.jobId === jobId);
  }

  /** Returns the existing wallet for a job, or mints one and persists it before returning. */
  getOrCreate(jobId: string, fundedBy: Address): JobWallet {
    const existing = this.get(jobId);
    if (existing) return existing;
    const privateKey = generatePrivateKey();
    const wallet: JobWallet = {
      jobId,
      address: getAddress(privateKeyToAccount(privateKey).address),
      privateKey,
      createdAt: Date.now(),
      fundedBy: getAddress(fundedBy),
    };
    this.book.wallets.push(wallet);
    this.flush();
    return wallet;
  }

  update(jobId: string, fields: Partial<Pick<JobWallet, 'token' | 'curve'>>): void {
    const wallet = this.get(jobId);
    if (!wallet) throw new Error(`no wallet for job ${jobId}`);
    Object.assign(wallet, fields);
    this.flush();
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.book, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
