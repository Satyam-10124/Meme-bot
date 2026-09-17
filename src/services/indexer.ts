import type { Address, PublicClient } from 'viem';
import { curveAbi } from '../chain/abis.js';

export interface FlowWindow {
  /** Net inbound quote over the window: Σ CurveBuy.quoteIn − Σ CurveSell.quoteOut. */
  netFlowWei: bigint;
  distinctBuyers: number;
  lastBuyAtSeconds: number | undefined;
}

/**
 * Flow over a trailing window, read from curve events. Ranges are kept narrow on purpose —
 * the public RPC times out on wide `eth_getLogs` spans.
 */
export async function readFlowWindow(
  client: PublicClient,
  curve: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<FlowWindow> {
  const [buys, sells] = await Promise.all([
    client.getContractEvents({
      address: curve,
      abi: curveAbi,
      eventName: 'CurveBuy',
      fromBlock,
      toBlock,
    }),
    client.getContractEvents({
      address: curve,
      abi: curveAbi,
      eventName: 'CurveSell',
      fromBlock,
      toBlock,
    }),
  ]);

  let netFlowWei = 0n;
  const buyers = new Set<string>();
  let lastBuyBlock: bigint | undefined;
  for (const log of buys) {
    netFlowWei += log.args.quoteIn ?? 0n;
    if (log.args.recipient) buyers.add(log.args.recipient.toLowerCase());
    if (lastBuyBlock === undefined || (log.blockNumber ?? 0n) > lastBuyBlock) {
      lastBuyBlock = log.blockNumber ?? undefined;
    }
  }
  for (const log of sells) netFlowWei -= log.args.quoteOut ?? 0n;

  let lastBuyAtSeconds: number | undefined;
  if (lastBuyBlock !== undefined) {
    const block = await client.getBlock({ blockNumber: lastBuyBlock });
    lastBuyAtSeconds = Number(block.timestamp);
  }

  return { netFlowWei, distinctBuyers: buyers.size, lastBuyAtSeconds };
}
