import {
  encodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { curveAbi, erc20Abi } from '../chain/abis.js';
import type { Config } from '../config.js';
import { maxTrancheForImpact, quoteSell, withSlippage } from '../core/curve.js';
import { decideExit, type ExitInputs } from '../core/exit.js';
import { assertAllowedTx } from '../core/guards.js';
import type { Journal } from '../state/journal.js';
import { readFlowWindow } from './indexer.js';
import { readCurveState } from './protocol.js';

export interface SellExecution {
  txHash: Hex;
  tokensSold: bigint;
  quoteOut: bigint;
}

/** One sell tranche, bounded by the configured price impact and slippage. */
export async function sellTranche(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
  curve: Address,
  tokens: bigint,
  recipient: Address,
  token: Address,
): Promise<SellExecution> {
  const state = await readCurveState(client, curve);
  const fees = { feeBps: state.feeBps, creatorTaxBps: state.creatorTaxBps };
  const { quoteOut } = quoteSell(state.reserves, tokens, fees);
  const minQuoteOut = withSlippage(quoteOut, config.slippageBps);
  if (minQuoteOut <= 0n) throw new Error('refusing a sell with a zero minimum output');

  const data = encodeFunctionData({
    abi: curveAbi,
    functionName: 'sell',
    args: [tokens, minQuoteOut, recipient],
  });
  assertAllowedTx(config, { to: curve, data, value: 0n, curve, token });

  await client.simulateContract({
    address: curve,
    abi: curveAbi,
    functionName: 'sell',
    args: [tokens, minQuoteOut, recipient],
    account: wallet.account ?? recipient,
  });

  journal.intent(jobId, 'sell', {
    to: curve,
    tokens: tokens.toString(),
    minQuoteOut: minQuoteOut.toString(),
  });

  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  const txHash = await wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to: curve,
    data,
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`sell reverted: ${txHash}`);

  return { txHash, tokensSold: tokens, quoteOut };
}

/**
 * Approves the curve for the exact tranche only. pons curves pull tokens via transferFrom,
 * and a lingering unlimited approval on a disposable wallet is free money for anyone who
 * later compromises it.
 */
export async function approveExact(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  token: Address,
  curve: Address,
  amount: bigint,
): Promise<Hex | undefined> {
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  const current = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, curve],
  });
  if (current >= amount) return undefined;

  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curve, amount] });
  assertAllowedTx(config, { to: token, data, value: 0n, token });
  return wallet.sendTransaction({
    account,
    chain: wallet.chain ?? null,
    to: token,
    data,
  });
}

export interface TickResult {
  rule: string;
  multipleBps: bigint;
  peakMultipleBps: bigint;
  sells: SellExecution[];
}

/**
 * Evaluates the exit rules once and executes the decision, splitting the order into
 * impact-capped tranches so a full exit never dumps into its own price.
 */
export async function runExitTick(
  client: PublicClient,
  wallet: WalletClient,
  config: Config,
  journal: Journal,
  jobId: string,
  args: {
    token: Address;
    curve: Address;
    recipient: Address;
    entryQuoteReserve: bigint;
    tokensHeld: bigint;
    tokensBoughtOriginally: bigint;
    tradableAllocation: bigint;
    peakMultipleBps: bigint;
    rungsFilled: number[];
  },
): Promise<TickResult> {
  const [state, head] = await Promise.all([
    readCurveState(client, args.curve),
    client.getBlockNumber(),
  ]);
  const windowBlocks = BigInt(config.exit.flowWindowBlocks);
  const flow = await readFlowWindow(
    client,
    args.curve,
    head > windowBlocks ? head - windowBlocks : 0n,
    head,
  );

  const inputs: ExitInputs = {
    entryQuoteReserve: args.entryQuoteReserve,
    quoteReserve: state.reserves.quote,
    realQuoteReserve: state.realQuoteReserve,
    graduationThreshold: state.graduationThreshold,
    sellableTokens: state.sellableTokens,
    tradableAllocation: args.tradableAllocation,
    readyToGraduate: state.readyToGraduate,
    tokensHeld: args.tokensHeld,
    tokensBoughtOriginally: args.tokensBoughtOriginally,
    peakMultipleBps: args.peakMultipleBps,
    rungsFilled: args.rungsFilled,
    nowSeconds: Math.floor(Date.now() / 1000),
    lastBuyAtSeconds: flow.lastBuyAtSeconds,
    flow60sWei: flow.netFlowWei,
    distinctBuyers60s: flow.distinctBuyers,
  };

  const decision = decideExit(config, inputs);
  const sells: SellExecution[] = [];
  if (decision.action === 'sell' && decision.tokens > 0n) {
    let remaining = decision.tokens;
    const fees = { feeBps: state.feeBps, creatorTaxBps: state.creatorTaxBps };
    for (let i = 0; i < config.exit.maxTranchesPerTick && remaining > 0n; i += 1) {
      const live = await readCurveState(client, args.curve);
      const cap = maxTrancheForImpact(live.reserves, remaining, config.exit.maxTrancheImpactBps);
      const tranche = cap > 0n ? cap : remaining;
      if (config.dryRun) {
        sells.push({
          txHash: '0x' as Hex,
          tokensSold: tranche,
          quoteOut: quoteSell(live.reserves, tranche, fees).quoteOut,
        });
        remaining -= tranche;
        continue;
      }
      await approveExact(client, wallet, config, args.token, args.curve, tranche);
      sells.push(
        await sellTranche(
          client,
          wallet,
          config,
          journal,
          jobId,
          args.curve,
          tranche,
          args.recipient,
          args.token,
        ),
      );
      remaining -= tranche;
    }
  }

  return {
    rule: decision.rule,
    multipleBps: decision.multipleBps,
    peakMultipleBps: decision.peakMultipleBps,
    sells,
  };
}
