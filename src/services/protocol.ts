import type { Address, PublicClient } from 'viem';
import { curveAbi, factoryAbi, launchTokenAbi } from '../chain/abis.js';
import { PONS_V2 } from '../chain/addresses.js';
import type { Reserves } from '../core/curve.js';

export interface LaunchConfig {
  supply: bigint;
  curveFeeBps: bigint;
  phantomQuote: bigint;
  graduationThreshold: bigint;
  poolFee: number;
  tickSpacing: number;
  enabled: boolean;
}

export interface ProtocolState {
  launchFee: bigint;
  launchEnabled: boolean;
  maxCreatorTaxBps: bigint;
  launchConfigCount: bigint;
  feeEscrow: Address;
  memeHook: Address;
  snipeTaxStartBps: bigint;
  snipeTaxSeconds: bigint;
}

export async function readProtocolState(client: PublicClient): Promise<ProtocolState> {
  const read = <T>(functionName: string) =>
    client.readContract({
      address: PONS_V2.factory,
      abi: factoryAbi,
      functionName: functionName as never,
    }) as Promise<T>;

  const [
    launchFee,
    launchEnabled,
    maxCreatorTaxBps,
    launchConfigCount,
    feeEscrow,
    memeHook,
    snipeTaxStartBps,
    snipeTaxSeconds,
  ] = await Promise.all([
    read<bigint>('launchFee'),
    read<boolean>('launchEnabled'),
    read<bigint>('maxCreatorTaxBps'),
    read<bigint>('launchConfigCount'),
    read<Address>('feeEscrow'),
    read<Address>('memeHook'),
    read<bigint>('snipeTaxStartBps'),
    read<bigint>('snipeTaxSeconds'),
  ]);

  return {
    launchFee,
    launchEnabled,
    maxCreatorTaxBps,
    launchConfigCount,
    feeEscrow,
    memeHook,
    snipeTaxStartBps,
    snipeTaxSeconds,
  };
}

export async function readLaunchConfig(
  client: PublicClient,
  launchConfigId: bigint,
): Promise<LaunchConfig> {
  const cfg = await client.readContract({
    address: PONS_V2.factory,
    abi: factoryAbi,
    functionName: 'getLaunchConfig',
    args: [launchConfigId],
  });
  return cfg as LaunchConfig;
}

export async function canLaunch(client: PublicClient, launcher: Address): Promise<boolean> {
  return client.readContract({
    address: PONS_V2.factory,
    abi: factoryAbi,
    functionName: 'canLaunch',
    args: [launcher],
  });
}

export async function previewLaunchEconomics(
  client: PublicClient,
  launchConfigId: bigint,
  pairToken: Address,
) {
  return client.readContract({
    address: PONS_V2.factory,
    abi: factoryAbi,
    functionName: 'previewLaunchEconomics',
    args: [launchConfigId, pairToken],
  });
}

export async function getLaunchedToken(client: PublicClient, token: Address) {
  return client.readContract({
    address: PONS_V2.factory,
    abi: factoryAbi,
    functionName: 'getLaunchedToken',
    args: [token],
  });
}

export interface CurveState {
  reserves: Reserves;
  realQuoteReserve: bigint;
  sellableTokens: bigint;
  readyToGraduate: boolean;
  graduated: boolean;
  graduationThreshold: bigint;
  feeBps: bigint;
  creatorTaxBps: bigint;
  quoteFeeBalance: bigint;
  creatorTaxBalance: bigint;
  buybackEnabled: boolean;
}

export async function readCurveState(client: PublicClient, curve: Address): Promise<CurveState> {
  const read = <T>(functionName: string) =>
    client.readContract({
      address: curve,
      abi: curveAbi,
      functionName: functionName as never,
    }) as Promise<T>;

  const [
    reserves,
    realQuoteReserve,
    sellable,
    ready,
    graduated,
    graduationThreshold,
    feeBps,
    creatorTaxBps,
    quoteFeeBalance,
    creatorTaxBalance,
    buybackEnabled,
  ] = await Promise.all([
    read<readonly [bigint, bigint]>('getReserves'),
    read<bigint>('realQuoteReserve'),
    read<bigint>('sellableTokens'),
    read<boolean>('readyToGraduate'),
    read<boolean>('graduated'),
    read<bigint>('graduationThreshold'),
    read<number>('feeBps'),
    read<number>('creatorTaxBps'),
    read<bigint>('quoteFeeBalance'),
    read<bigint>('creatorTaxBalance'),
    read<boolean>('buybackEnabled'),
  ]);

  return {
    reserves: { quote: reserves[0], token: reserves[1] },
    realQuoteReserve,
    sellableTokens: sellable,
    readyToGraduate: ready,
    graduated,
    graduationThreshold,
    feeBps: BigInt(feeBps),
    creatorTaxBps: BigInt(creatorTaxBps),
    quoteFeeBalance,
    creatorTaxBalance,
    buybackEnabled,
  };
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: {
    twitter: string;
    telegram: string;
    discord: string;
    website: string;
    farcaster: string;
  };
}

/** Reads a pons-launched token's full metadata in two calls. */
export async function readPonsTokenMetadata(
  client: PublicClient,
  token: Address,
): Promise<TokenMetadata> {
  const [name, symbol, info] = await Promise.all([
    client.readContract({ address: token, abi: launchTokenAbi, functionName: 'name' }),
    client.readContract({ address: token, abi: launchTokenAbi, functionName: 'symbol' }),
    client.readContract({ address: token, abi: launchTokenAbi, functionName: 'getTokenInfo' }),
  ]);
  const [, logo, description, socials] = info;
  return { name, symbol, logo, description, socials: { ...socials } };
}
