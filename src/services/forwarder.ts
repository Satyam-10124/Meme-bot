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
 * Sends the launcher's spendable native balance to the pinned treasury. This is the only
 * value-bearing transfer the bot makes to a non-protocol address, and the destination is
 * checked against the allowlist like every other send.
 */
export async function forwardToTreasury(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
): Promise<ForwardResult> {
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  const from: Address = account.address;
  const to = getAddress(config.treasury);
  if (getAddress(from) === to) return { amount: 0n, skipped: 'launcher is the treasury' };

  const [balance, gasPrice] = await Promise.all([
    client.getBalance({ address: from }),
    client.getGasPrice(),
  ]);
  const plan = planForward({
    balance,
    gasPrice,
    gasReserve: config.forwardGasReserveWei,
    minForward: config.forwardMinWei,
  });
  if (plan.amount === 0n) return { amount: 0n, skipped: plan.reason ?? 'nothing to forward' };

  assertAllowedTx(config, { to, value: plan.amount, transfer: true });
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
