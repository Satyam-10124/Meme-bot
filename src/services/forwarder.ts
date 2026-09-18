import { getAddress, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import type { Config } from '../config.js';
import { assertAllowedTx } from '../core/guards.js';
import type { Journal } from '../state/journal.js';

/** Gas for a plain native transfer to an EOA. */
export const TRANSFER_GAS = 21_000n;

export interface ForwardPlan {
  balance: bigint;
  /** Native value sent to the treasury; 0n when nothing is worth moving. */
  amount: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  reason?: string;
}

/**
 * Treasury forwarding math. Everything above `gasReserve` (which also has to cover this
 * transfer's own worst-case fee) is sent, but only when it clears `minForward` so a forward is
 * never a gas-wasting dust transfer. Pure BigInt, no floats.
 */
export function planForward(args: {
  balance: bigint;
  gasPrice: bigint;
  gasReserve: bigint;
  minForward: bigint;
}): ForwardPlan {
  const maxFeePerGas = args.gasPrice * 2n;
  const maxPriorityFeePerGas = args.gasPrice / 2n;
  const worstFee = TRANSFER_GAS * maxFeePerGas;
  const base = {
    balance: args.balance,
    gasLimit: TRANSFER_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
  const spendable = args.balance - args.gasReserve - worstFee;
  if (spendable <= 0n) {
    return { ...base, amount: 0n, reason: `balance ${args.balance} within gas reserve` };
  }
  if (spendable < args.minForward) {
    return { ...base, amount: 0n, reason: `spendable ${spendable} below min forward ${args.minForward}` };
  }
  return { ...base, amount: spendable };
}

export interface ForwardResult {
  txHash?: Hex;
  amount: bigint;
  skipped?: string;
}

/**
 * Sends the wallet's spendable native balance to the pinned treasury, or — for a disposable
 * job wallet — back to the central wallet that funded it (`refundTo`). These are the only
 * value-bearing transfers the bot makes to non-protocol addresses, and both destinations are
 * checked against the allowlist like every other send.
 */
export async function forwardToTreasury(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
  opts: { refundTo?: Address; gasReserve?: bigint; minForward?: bigint } = {},
): Promise<ForwardResult> {
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  const from: Address = account.address;
  const refundTo = opts.refundTo;
  const to = getAddress(refundTo ?? config.treasury);
  if (getAddress(from) === to) return { amount: 0n, skipped: 'wallet is the destination' };

  const [balance, gasPrice] = await Promise.all([
    client.getBalance({ address: from }),
    client.getGasPrice(),
  ]);
  const plan = planForward({
    balance,
    gasPrice,
    gasReserve: opts.gasReserve ?? config.forwardGasReserveWei,
    minForward: opts.minForward ?? config.forwardMinWei,
  });
  if (plan.amount === 0n) return { amount: 0n, skipped: plan.reason ?? 'nothing to forward' };

  assertAllowedTx(config, {
    to,
    value: plan.amount,
    transfer: true,
    ...(refundTo ? { ownWallet: refundTo } : {}),
  });
  if (config.dryRun) {
    return { amount: plan.amount, skipped: 'dry run: forward not sent' };
  }

  journal.intent(jobId, 'forward', { from, to, amount: plan.amount.toString() });
  const txHash = await wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to,
    value: plan.amount,
    gas: plan.gasLimit,
    maxFeePerGas: plan.maxFeePerGas,
    maxPriorityFeePerGas: plan.maxPriorityFeePerGas,
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`forward reverted: ${txHash}`);
  journal.intent(jobId, 'forwarded', { txHash, amount: plan.amount.toString() });
  return { txHash, amount: plan.amount };
}

/**
 * Tops a fresh job wallet up from the central launcher with exactly the launch budget. The
 * destination must be a wallet from the bot's own wallet book and the value stays under the
 * per-job spend cap.
 */
export async function fundJobWallet(
  client: PublicClient,
  central: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
  jobWallet: Address,
  amount: bigint,
): Promise<Hex | undefined> {
  const account = central.account;
  if (!account) throw new Error('wallet client has no account');
  const to = getAddress(jobWallet);
  assertAllowedTx(config, { to, value: amount, transfer: true, ownWallet: to });

  const [balance, gasPrice] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.getGasPrice(),
  ]);
  const maxFeePerGas = gasPrice * 2n;
  const needed = amount + TRANSFER_GAS * maxFeePerGas + config.forwardGasReserveWei;
  if (balance < needed) {
    throw new Error(`central wallet holds ${balance} wei, needs ${needed} to fund ${to}`);
  }
  if (config.dryRun) return undefined;

  journal.intent(jobId, 'fund', { from: account.address, to, amount: amount.toString() });
  const txHash = await central.sendTransaction({
    account,
    chain: central.chain ?? null,
    to,
    value: amount,
    gas: TRANSFER_GAS,
    maxFeePerGas,
    maxPriorityFeePerGas: gasPrice / 2n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`funding reverted: ${txHash}`);
  journal.intent(jobId, 'funded', { txHash, amount: amount.toString() });
  return txHash;
}
