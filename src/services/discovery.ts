import { getAbiItem, getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { curveAbi, factoryAbi } from '../chain/abis.js';
import { PONS_V2 } from '../chain/addresses.js';

export interface CurveVolume {
  token: Address;
  curve: Address;
  launchedAtBlock: bigint;
  buys: number;
  sells: number;
  /** Quote in on buys plus quote out on sells, in wei. */
  volumeWei: bigint;
  /** Buys minus sells, in wei; positive means net inflow into the curve. */
  netFlowWei: bigint;
}

/** Factory launches are sparse; curve trades are dense and the RPC caps a query at 10k logs. */
const LAUNCH_CHUNK = 50_000n;
const VOLUME_CHUNK = 5_000n;
const PACE_MS = 300;

/** Public RPC rate-limits log scans; back off and retry instead of failing the whole ranking. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let delay = 500;
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
}

async function* chunks(from: bigint, to: bigint, size: bigint): AsyncGenerator<[bigint, bigint]> {
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n < to ? start + size - 1n : to;
    yield [start, end];
    await new Promise((r) => setTimeout(r, PACE_MS));
  }
}

/**
 * Ranks pons curves on Robinhood Chain by curve trading volume over the trailing window.
 * Pure log scan: launches from the factory, then every `CurveBuy`/`CurveSell` in the window
 * (no address filter, so one pass covers all curves), attributed to the launched set.
 * Graduated curves still count — their history is what a clone is cloning.
 */
export async function rankCurvesByVolume(
  client: PublicClient,
  args: { launchLookbackBlocks: bigint; volumeLookbackBlocks: bigint },
): Promise<CurveVolume[]> {
  const head = await client.getBlockNumber();
  const launchFrom = head > args.launchLookbackBlocks ? head - args.launchLookbackBlocks : 0n;
  const volumeFrom = head > args.volumeLookbackBlocks ? head - args.volumeLookbackBlocks : 0n;

  const byCurve = new Map<Address, CurveVolume>();
  const launched = getAbiItem({ abi: factoryAbi, name: 'TokenLaunched' });
  for await (const [fromBlock, toBlock] of chunks(launchFrom, head, LAUNCH_CHUNK)) {
    const logs = await withRetry(() =>
      client.getLogs({ address: PONS_V2.factory, event: launched, fromBlock, toBlock }),
    );
    for (const log of logs) {
      const { token, curve, pairToken } = log.args;
      if (!token || !curve) continue;
      // Only native-ETH curves: the launcher pre-buys in ETH and volume is compared in one unit.
      if (pairToken !== undefined && getAddress(pairToken) !== zeroAddress) continue;
      byCurve.set(getAddress(curve), {
        token: getAddress(token),
        curve: getAddress(curve),
        launchedAtBlock: log.blockNumber,
        buys: 0,
        sells: 0,
        volumeWei: 0n,
        netFlowWei: 0n,
      });
    }
  }

  const buy = getAbiItem({ abi: curveAbi, name: 'CurveBuy' });
  const sell = getAbiItem({ abi: curveAbi, name: 'CurveSell' });
  for await (const [fromBlock, toBlock] of chunks(volumeFrom, head, VOLUME_CHUNK)) {
    const buys = await withRetry(() => client.getLogs({ event: buy, fromBlock, toBlock }));
    const sells = await withRetry(() => client.getLogs({ event: sell, fromBlock, toBlock }));
    for (const log of buys) {
      const entry = byCurve.get(getAddress(log.address));
      if (!entry || log.args.quoteIn === undefined) continue;
      entry.buys += 1;
      entry.volumeWei += log.args.quoteIn;
      entry.netFlowWei += log.args.quoteIn;
    }
    for (const log of sells) {
      const entry = byCurve.get(getAddress(log.address));
      if (!entry || log.args.quoteOut === undefined) continue;
      entry.sells += 1;
      entry.volumeWei += log.args.quoteOut;
      entry.netFlowWei -= log.args.quoteOut;
    }
  }

  return [...byCurve.values()]
    .filter((c) => c.volumeWei > 0n)
    .sort((a, b) => (a.volumeWei === b.volumeWei ? 0 : a.volumeWei > b.volumeWei ? -1 : 1));
}
