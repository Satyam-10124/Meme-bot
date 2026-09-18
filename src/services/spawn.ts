import { formatEther, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assertChainId, makePublicClient, makeWalletClient, robinhoodChain } from '../chain/clients.js';
import type { Config } from '../config.js';
import { BPS } from '../core/curve.js';
import { Journal } from '../state/journal.js';
import { WalletBook } from '../state/wallets.js';
import { forwardToTreasury, fundJobWallet } from './forwarder.js';
import { executeLaunch, planLaunch, simulateLaunch } from './launcher.js';
import { applyCloneOptions, resolveSourceMetadata } from './metadata.js';
import { readProtocolState } from './protocol.js';

// launchToken estimates ~3.8M gas and the 1.3x multiplier pushes the limit near 5M;
// 8M of headroom absorbs gas-price spikes between funding the job wallet and the launch.
export const SPAWN_GAS_UNITS = 8_000_000n;

const EXPLORER = robinhoodChain.blockExplorers.default.url;

function eth(value: bigint): string {
  return `${formatEther(value)} ETH`;
}

/**
 * Clone-launches `source` from the wallet behind `key`. Shared by every launch mode —
 * the caller decides which wallet signs and whether a pre-buy rides along.
 */
export async function launchWith(
  config: Config,
  client: PublicClient,
  journal: Journal,
  key: Hex,
  source: Address,
  jobId: string,
): Promise<boolean> {
  const wallet = makeWalletClient(config, key);
  const launcher = privateKeyToAccount(key).address;

  const metadata = applyCloneOptions(await resolveSourceMetadata(client, source));
  const plan = await planLaunch(client, config, { metadata, launcher });
  journal.create(jobId, {
    sourceToken: source,
    name: metadata.name,
    symbol: metadata.symbol,
    launcher,
    creatorFeeRecipient: config.creatorFeeRecipient,
    state: 'METADATA_OK',
  });

  console.log('clone of          ', source, `-> ${metadata.name} (${metadata.symbol})`);
  console.log('spend             ', eth(plan.totalValue), `= ${eth(plan.launchFee)} fee + ${eth(plan.quoteIn)} pre-buy`);
  console.log('expected tokens   ', plan.expectedTokensOut.toString());
  console.log('min tokens out    ', plan.minTokensOut.toString());
  console.log('fee recipient     ', plan.creatorFeeRecipient);

  const simulated = await simulateLaunch(client, config, plan);
  console.log('simulated token   ', simulated.token, 'curve', simulated.curve);

  if (config.dryRun) {
    console.log('dry run: nothing sent. set DRY_RUN=false to broadcast.');
    return false;
  }

  const result = await executeLaunch(client, wallet, config, journal, jobId, plan);
  journal.update(jobId, {
    state: 'HOLDING',
    token: result.token,
    curve: result.curve,
    launchTxHash: result.txHash,
    entryQuoteReserve: result.entryQuoteReserve.toString(),
    tokensBought: result.tokensOut.toString(),
    tokensSold: '0',
    quoteRecovered: '0',
    peakMultipleBps: BPS.toString(),
    rungsFilled: [],
  });
  console.log('launched          ', result.token, 'curve', result.curve, 'tx', result.txHash);
  console.log('tokens held       ', result.tokensOut.toString());
  if (result.metadataMismatches.length > 0) {
    console.log('metadata mismatch ', result.metadataMismatches);
  }
  return true;
}

export interface SpawnResult {
  jobId: string;
  jobWallet: Address;
  launched: boolean;
  token: Address | undefined;
  curve: Address | undefined;
  launchTxHash: Hex | undefined;
  durationMs: number;
  fundedWei: bigint;
  refundTxHash: Hex | undefined;
  refundWei: bigint | undefined;
}

/**
 * Spawn mode: every clone launches from a fresh job wallet funded by the central launcher,
 * with no pre-buy — the cheapest possible launch. Leftover ETH refunds to the central wallet
 * right after the launch settles, so the job wallet never holds a balance.
 */
export async function spawnClone(config: Config, source: Address, jobId: string): Promise<SpawnResult> {
  const started = Date.now();
  const client = makePublicClient(config);
  await assertChainId(client, config.chainId);
  if (!config.launcherKey) throw new Error('LAUNCHER_PRIVATE_KEY is required to spawn');
  const central = makeWalletClient(config, config.launcherKey);
  const centralAddress = privateKeyToAccount(config.launcherKey).address;
  const journal = new Journal(config.stateDir);
  const book = new WalletBook(config.stateDir);
  const jobWallet = book.getOrCreate(jobId, centralAddress);
  console.log('job wallet        ', jobWallet.address, `(key in ${book.path})`);

  // Force launch-only regardless of the configured profile.
  const spawnConfig: Config = { ...config, profile: { ...config.profile, preBuyWei: 0n } };

  const [protocol, gasPrice] = await Promise.all([readProtocolState(client), client.getGasPrice()]);
  const liveGasBuffer = SPAWN_GAS_UNITS * gasPrice;
  const gasBuffer = liveGasBuffer > config.profile.gasBufferWei ? liveGasBuffer : config.profile.gasBufferWei;
  const budget = protocol.launchFee + gasBuffer;
  let fundedWei = 0n;
  const jobBalance = await client.getBalance({ address: jobWallet.address });
  if (jobBalance < budget) {
    const topUp = budget - jobBalance;
    const fundTx = await fundJobWallet(client, central, config, journal, jobId, jobWallet.address, topUp);
    fundedWei = topUp;
    console.log('funded            ', eth(topUp), fundTx ? `tx ${fundTx}` : '(dry run)');
  }

  let launched = false;
  let refundTxHash: Hex | undefined;
  let refundWei: bigint | undefined;
  try {
    launched = await launchWith(spawnConfig, client, journal, jobWallet.privateKey, source, jobId);
  } finally {
    // Whatever happened, the job wallet's leftover ETH goes back to the central wallet.
    const jobClient = makeWalletClient(config, jobWallet.privateKey);
    try {
      const refund = await forwardToTreasury(client, jobClient, config, journal, jobId, {
        refundTo: centralAddress,
        gasReserve: 0n,
        minForward: config.forwardMinWei / 10n,
      });
      refundTxHash = refund.txHash;
      refundWei = refund.amount;
      console.log('refund to central ', refund.skipped ?? `${eth(refund.amount)} tx ${refund.txHash}`);
    } catch (err) {
      console.log('refund failed     ', err instanceof Error ? err.message.split('\n')[0] : err);
    }
  }
  const durationMs = Date.now() - started;
  const job = journal.get(jobId);
  if (job?.token && job.curve) book.update(jobId, { token: job.token, curve: job.curve });

  if (job?.token) {
    console.log('');
    console.log('TOKEN CA          ', job.token);
    console.log('PONS LINK         ', `https://www.ponsfamily.com/launchpad/${job.token}`);
    console.log('GMGN LINK         ', `https://gmgn.ai/robinhood/token/${job.token.toLowerCase()}`);
    console.log('LAUNCH TX         ', `${EXPLORER}/tx/${job.launchTxHash}`);
    console.log('FEES TO           ', config.creatorFeeRecipient);
    console.log('JOB               ', jobId, `(${durationMs}ms)`);
  }
  journal.update(jobId, { state: 'SETTLED' });
  return {
    jobId,
    jobWallet: jobWallet.address,
    launched,
    token: job?.token,
    curve: job?.curve,
    launchTxHash: job?.launchTxHash,
    durationMs,
    fundedWei,
    refundTxHash,
    refundWei,
  };
}
