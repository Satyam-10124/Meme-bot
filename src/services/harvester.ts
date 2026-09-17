import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { curveAbi, escrowAbi, hookAbi } from '../chain/abis.js';
import { PONS_V2 } from '../chain/addresses.js';
import type { Config } from '../config.js';
import { assertAllowedTx } from '../core/guards.js';
import type { Journal } from '../state/journal.js';
import { getLaunchedToken, readCurveState } from './protocol.js';
import { resolvePoolId } from './pool.js';

export interface HarvestStatus {
  graduated: boolean;
  /** Creator tax sitting on the curve, sweepable to the escrow. */
  curveCreatorTaxWei: bigint;
  /** LP fees sitting on the hook, sweepable to the escrow once graduated. */
  hookPendingQuoteWei: bigint;
  hookPendingTokenWei: bigint;
  /** Already credited in the escrow and claimable by the delegated recipient. */
  escrowQuoteWei: bigint;
  escrowTokenWei: bigint;
  creatorFeeRecipient: Address;
  poolId: Hex | undefined;
}

export async function readHarvestStatus(
  client: PublicClient,
  config: Config,
  token: Address,
  curve: Address,
): Promise<HarvestStatus> {
  const recipient = config.creatorFeeRecipient;
  const [state, record, escrowQuoteWei, escrowTokenWei] = await Promise.all([
    readCurveState(client, curve),
    getLaunchedToken(client, token),
    client.readContract({
      address: PONS_V2.feeEscrow,
      abi: escrowAbi,
      functionName: 'balanceOf',
      args: [recipient],
    }),
    client.readContract({
      address: PONS_V2.feeEscrow,
      abi: escrowAbi,
      functionName: 'balanceOfToken',
      args: [recipient, token],
    }),
  ]);

  let hookPendingQuoteWei = 0n;
  let hookPendingTokenWei = 0n;
  let poolId: Hex | undefined;
  if (state.graduated) {
    poolId = await resolvePoolId(
      client,
      token,
      record.pairToken,
      record.poolFee,
      record.tickSpacing,
    );
  }
  if (poolId) {
    const pending = (currency: Address) =>
      Promise.all([
        client.readContract({
          address: PONS_V2.memeHook,
          abi: hookAbi,
          functionName: 'pendingFees',
          args: [poolId as Hex, currency],
        }),
        client.readContract({
          address: PONS_V2.memeHook,
          abi: hookAbi,
          functionName: 'pendingCreatorTax',
          args: [poolId as Hex, currency],
        }),
      ]);
    const [quote, tokenSide] = await Promise.all([pending(record.pairToken), pending(token)]);
    hookPendingQuoteWei = quote[0] + quote[1];
    hookPendingTokenWei = tokenSide[0] + tokenSide[1];
  }

  return {
    graduated: state.graduated,
    curveCreatorTaxWei: state.creatorTaxBalance,
    hookPendingQuoteWei,
    hookPendingTokenWei,
    escrowQuoteWei,
    escrowTokenWei,
    creatorFeeRecipient: getAddress(record.creatorFeeRecipient),
    poolId,
  };
}

export interface HarvestResult {
  sweepTxHash?: Hex;
  claimTxHash?: Hex;
  claimTokenTxHash?: Hex;
  claimedQuoteWei: bigint;
  claimedTokenWei: bigint;
  skipped: string[];
}

/**
 * sweep → claim, run by the delegated fee wallet itself.
 *
 * The claim leg must be signed by `creatorFeeRecipient`: the escrow credits balances per
 * address and `claim()` pays `msg.sender`, so the delegate is the only account that can move
 * the money. Sweeping is permissionless-for-the-creator and can be signed by the launcher.
 */
export async function harvest(
  client: PublicClient,
  config: Config,
  journal: Journal,
  jobId: string,
  args: {
    token: Address;
    curve: Address;
    sweeper: WalletClient | undefined;
    claimer: WalletClient | undefined;
  },
): Promise<HarvestResult> {
  const status = await readHarvestStatus(client, config, args.token, args.curve);
  const result: HarvestResult = { claimedQuoteWei: 0n, claimedTokenWei: 0n, skipped: [] };

  if (getAddress(status.creatorFeeRecipient) !== getAddress(config.creatorFeeRecipient)) {
    throw new Error(
      `refusing to harvest: on-chain recipient ${status.creatorFeeRecipient} != pinned ${config.creatorFeeRecipient}`,
    );
  }

  // 1. Sweep accrued fees into the escrow.
  const sweepable = status.graduated
    ? status.hookPendingQuoteWei + status.hookPendingTokenWei
    : status.curveCreatorTaxWei;
  if (sweepable < config.sweepThresholdWei) {
    result.skipped.push(`sweep below threshold (${sweepable} wei)`);
  } else if (!args.sweeper || config.dryRun) {
    result.skipped.push('sweep not sent (dry-run or no signer)');
  } else if (status.graduated && status.poolId) {
    result.sweepTxHash = await send(client, args.sweeper, config, journal, jobId, 'sweepPoolFees', {
      to: PONS_V2.memeHook,
      data: encodeFunctionData({
        abi: hookAbi,
        functionName: 'sweepPoolFees',
        args: [status.poolId, 0n, 0n],
      }),
    });
  } else {
    result.sweepTxHash = await send(client, args.sweeper, config, journal, jobId, 'sweepFees', {
      to: args.curve,
      data: encodeFunctionData({ abi: curveAbi, functionName: 'sweepFees', args: [0n] }),
    });
  }

  // 2. Claim from the escrow, as the delegated recipient.
  const post = await readHarvestStatus(client, config, args.token, args.curve);
  if (!args.claimer || config.dryRun) {
    result.skipped.push('claim not sent (dry-run or no claimer key)');
    return result;
  }
  const claimerAddress = args.claimer.account?.address;
  if (!claimerAddress || getAddress(claimerAddress) !== getAddress(config.creatorFeeRecipient)) {
    throw new Error(
      `claimer key is ${claimerAddress ?? 'missing'}, but the escrow only pays ${config.creatorFeeRecipient}`,
    );
  }

  if (post.escrowQuoteWei >= config.claimThresholdWei) {
    result.claimTxHash = await send(client, args.claimer, config, journal, jobId, 'claim', {
      to: PONS_V2.feeEscrow,
      data: encodeFunctionData({ abi: escrowAbi, functionName: 'claim' }),
    });
    result.claimedQuoteWei = post.escrowQuoteWei;
  } else {
    result.skipped.push(`quote claim below threshold (${post.escrowQuoteWei} wei)`);
  }

  if (post.escrowTokenWei > 0n) {
    result.claimTokenTxHash = await send(
      client,
      args.claimer,
      config,
      journal,
      jobId,
      'claimToken',
      {
        to: PONS_V2.feeEscrow,
        data: encodeFunctionData({
          abi: escrowAbi,
          functionName: 'claimToken',
          args: [args.token],
        }),
      },
    );
    result.claimedTokenWei = post.escrowTokenWei;
  }

  return result;
}

async function send(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
  label: string,
  tx: { to: Address; data: Hex },
): Promise<Hex> {
  assertAllowedTx(config, { to: tx.to, data: tx.data, value: 0n });
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  await client.call({ account, to: tx.to, data: tx.data });
  journal.intent(jobId, label, { to: tx.to });
  const hash = await wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to: tx.to,
    data: tx.data,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
  return hash;
}
