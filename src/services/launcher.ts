import { randomBytes } from 'node:crypto';
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { curveAbi, factoryAbi, routerAbi } from '../chain/abis.js';
import { NATIVE_QUOTE, PONS_V2 } from '../chain/addresses.js';
import type { Config } from '../config.js';
import { quoteBuy, withSlippage } from '../core/curve.js';
import { assertAllowedTx, assertFeeRecipientPinned } from '../core/guards.js';
import type { Journal } from '../state/journal.js';
import {
  canLaunch,
  getLaunchedToken,
  previewLaunchEconomics,
  readCurveState,
  readLaunchConfig,
  readProtocolState,
  readPonsTokenMetadata,
  type TokenMetadata,
} from './protocol.js';
import { diffMetadata } from './metadata.js';

export interface LaunchPlan {
  metadata: TokenMetadata;
  launchFee: bigint;
  quoteIn: bigint;
  totalValue: bigint;
  expectedTokensOut: bigint;
  minTokensOut: bigint;
  expectedEconomics: Hex;
  salt: Hex;
  creatorFeeRecipient: Address;
  recipient: Address;
  launcher: Address;
}

export interface LaunchResult {
  txHash: Hex;
  token: Address;
  curve: Address;
  tokensOut: bigint;
  entryQuoteReserve: bigint;
  metadataMismatches: ReturnType<typeof diffMetadata>;
}

/**
 * Builds the launch, priced against the *current* config and pinned with `expectedEconomics`
 * so an owner config change between the read and the send reverts the launch instead of
 * silently repricing it.
 */
export async function planLaunch(
  client: PublicClient,
  config: Config,
  args: { metadata: TokenMetadata; launcher: Address; recipient?: Address },
): Promise<LaunchPlan> {
  assertFeeRecipientPinned(config);

  const [protocol, launchConfig, allowed, expectedEconomics] = await Promise.all([
    readProtocolState(client),
    readLaunchConfig(client, config.launchConfigId),
    canLaunch(client, args.launcher),
    previewLaunchEconomics(client, config.launchConfigId, NATIVE_QUOTE),
  ]);

  if (!protocol.launchEnabled) throw new Error('pons launching is disabled protocol-wide');
  if (!allowed) throw new Error(`launcher ${args.launcher} is not permitted to launch`);
  if (!launchConfig.enabled) throw new Error(`launch config ${config.launchConfigId} is disabled`);
  if (BigInt(config.creatorTaxBps) > protocol.maxCreatorTaxBps) {
    throw new Error(`creatorTaxBps ${config.creatorTaxBps} exceeds cap ${protocol.maxCreatorTaxBps}`);
  }

  const quoteIn = config.profile.preBuyWei;
  const totalValue = protocol.launchFee + quoteIn;
  if (totalValue > config.profile.maxJobSpendWei) {
    throw new Error(`launch would spend ${totalValue} wei, above the per-job cap`);
  }

  // The launch buy happens on a fresh curve, so the opening reserves are exactly the config.
  // The router exempts the buy recipient, so no snipe tax applies to this leg.
  const { tokensOut } = quoteBuy(
    { quote: launchConfig.phantomQuote, token: launchConfig.supply },
    quoteIn,
    { feeBps: launchConfig.curveFeeBps, creatorTaxBps: BigInt(config.creatorTaxBps) },
  );

  return {
    metadata: args.metadata,
    launchFee: protocol.launchFee,
    quoteIn,
    totalValue,
    expectedTokensOut: tokensOut,
    minTokensOut: withSlippage(tokensOut, config.slippageBps),
    expectedEconomics,
    salt: toHex(randomBytes(32)),
    creatorFeeRecipient: config.creatorFeeRecipient,
    recipient: args.recipient ?? args.launcher,
    launcher: args.launcher,
  };
}

function buildTokenParams(plan: LaunchPlan, config: Config) {
  return {
    name: plan.metadata.name,
    symbol: plan.metadata.symbol,
    logo: plan.metadata.logo,
    description: plan.metadata.description,
    socials: plan.metadata.socials,
    // The whole point of this bot: creator fees are delegated to the pinned claimer wallet
    // at creation, so they never touch the disposable launcher wallet.
    creatorFeeRecipient: plan.creatorFeeRecipient,
    creatorTaxBps: config.creatorTaxBps,
    // Must be false: a sweep that needs an internal swap is refused for the creator with
    // InternalSwapRequiresOperator, which would make fee harvesting depend on pons' operator.
    buybackEnabled: false,
    expectedEconomics: plan.expectedEconomics,
    salt: plan.salt,
  } as const;
}

export function encodeLaunchAndBuy(plan: LaunchPlan, config: Config): Hex {
  return encodeFunctionData({
    abi: routerAbi,
    functionName: 'launchAndBuy',
    args: [
      buildTokenParams(plan, config),
      config.launchConfigId,
      NATIVE_QUOTE,
      plan.quoteIn,
      plan.minTokensOut,
      plan.recipient,
      [],
    ],
  });
}

/** `eth_call` the exact calldata at the pending block. No transaction is ever sent blind. */
export async function simulateLaunch(
  client: PublicClient,
  config: Config,
  plan: LaunchPlan,
): Promise<{ token: Address; curve: Address; tokensOut: bigint }> {
  const { result } = await client.simulateContract({
    address: PONS_V2.launchAndBuyRouter,
    abi: routerAbi,
    functionName: 'launchAndBuy',
    args: [
      buildTokenParams(plan, config),
      config.launchConfigId,
      NATIVE_QUOTE,
      plan.quoteIn,
      plan.minTokensOut,
      plan.recipient,
      [],
    ],
    value: plan.totalValue,
    account: plan.launcher,
  });
  const [token, curve, tokensOut] = result as readonly [Address, Address, bigint];
  return { token, curve, tokensOut };
}

export async function executeLaunch(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
  plan: LaunchPlan,
): Promise<LaunchResult> {
  const data = encodeLaunchAndBuy(plan, config);
  assertAllowedTx(config, { to: PONS_V2.launchAndBuyRouter, data, value: plan.totalValue });

  const simulated = await simulateLaunch(client, config, plan);
  const gas = await client.estimateContractGas({
    address: PONS_V2.launchAndBuyRouter,
    abi: routerAbi,
    functionName: 'launchAndBuy',
    args: [
      buildTokenParams(plan, config),
      config.launchConfigId,
      NATIVE_QUOTE,
      plan.quoteIn,
      plan.minTokensOut,
      plan.recipient,
      [],
    ],
    value: plan.totalValue,
    account: plan.launcher,
  });

  journal.intent(jobId, 'launchAndBuy', {
    to: PONS_V2.launchAndBuyRouter,
    value: plan.totalValue.toString(),
    predictedToken: simulated.token,
    creatorFeeRecipient: plan.creatorFeeRecipient,
    salt: plan.salt,
  });

  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  const txHash = await wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to: PONS_V2.launchAndBuyRouter,
    data,
    value: plan.totalValue,
    gas: (gas * config.gasMultiplierPercent) / 100n,
  });
  journal.update(jobId, { launchTxHash: txHash });

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`launch transaction reverted: ${txHash}`);

  // Trust receipts, not intentions: a buy near the cap is clamped and partially refunded.
  let token: Address | undefined;
  let curve: Address | undefined;
  let tokensOut = 0n;
  for (const log of receipt.logs) {
    if (getAddress(log.address) === PONS_V2.factory) {
      try {
        const decoded = decodeEventLog({ abi: factoryAbi, ...log });
        if (decoded.eventName === 'TokenLaunched') {
          token = decoded.args.token;
          curve = decoded.args.curve;
        }
      } catch {
        /* unrelated factory event */
      }
    }
  }
  for (const log of receipt.logs) {
    if (curve && getAddress(log.address) === getAddress(curve)) {
      try {
        const decoded = decodeEventLog({ abi: curveAbi, ...log });
        if (decoded.eventName === 'CurveBuy') tokensOut += decoded.args.tokensOut;
      } catch {
        /* unrelated curve event */
      }
    }
  }
  if (!token || !curve) throw new Error(`launch receipt ${txHash} has no TokenLaunched event`);
  // Persist the position the moment it exists on-chain; any read below may fail on a flaky RPC.
  journal.update(jobId, { token, curve, tokensBought: tokensOut.toString(), state: 'HOLDING' });

  const [record, curveState, actualMetadata] = await Promise.all([
    getLaunchedToken(client, token),
    readCurveState(client, curve),
    readPonsTokenMetadata(client, token),
  ]);

  if (getAddress(record.creatorFeeRecipient) !== getAddress(config.creatorFeeRecipient)) {
    journal.update(jobId, {
      state: 'QUARANTINED',
      lastError: `creator fee recipient is ${record.creatorFeeRecipient}, expected ${config.creatorFeeRecipient}`,
    });
    throw new Error(
      `fee delegation failed: on-chain recipient ${record.creatorFeeRecipient} != ${config.creatorFeeRecipient}`,
    );
  }
  if (record.buybackEnabled) {
    throw new Error('launch settled with buybackEnabled=true; self-sweeping is not possible');
  }

  return {
    txHash,
    token,
    curve,
    tokensOut,
    entryQuoteReserve: curveState.reserves.quote,
    metadataMismatches: diffMetadata(plan.metadata, actualMetadata),
  };
}
