import type { Address, PublicClient } from 'viem';
import { erc20Abi } from '../chain/abis.js';
import { readPonsTokenMetadata, type TokenMetadata } from './protocol.js';

export interface CloneOptions {
  /**
   * Appended to the cloned symbol. Non-empty by default: a byte-identical symbol makes the
   * launch an impersonation of the source project, which is a legal and delisting exposure
   * rather than a technical one. Set to '' to clone exactly.
   */
  symbolSuffix: string;
  nameSuffix: string;
}

export const DEFAULT_CLONE_OPTIONS: CloneOptions = { symbolSuffix: '2', nameSuffix: '' };

/**
 * Resolves the metadata of a source contract address. pons-launched tokens expose everything
 * on-chain; anything else falls back to the ERC-20 basics and leaves logo/socials empty rather
 * than guessing, because launch metadata is immutable and a wrong value is permanent.
 */
export async function resolveSourceMetadata(
  client: PublicClient,
  source: Address,
): Promise<TokenMetadata> {
  try {
    return await readPonsTokenMetadata(client, source);
  } catch {
    const [name, symbol] = await Promise.all([
      client.readContract({ address: source, abi: erc20Abi, functionName: 'name' }),
      client.readContract({ address: source, abi: erc20Abi, functionName: 'symbol' }),
    ]);
    return {
      name,
      symbol,
      logo: '',
      description: '',
      socials: { twitter: '', telegram: '', discord: '', website: '', farcaster: '' },
    };
  }
}

export function applyCloneOptions(
  metadata: TokenMetadata,
  options: CloneOptions = DEFAULT_CLONE_OPTIONS,
): TokenMetadata {
  return {
    ...metadata,
    name: `${metadata.name}${options.nameSuffix}`,
    symbol: `${metadata.symbol}${options.symbolSuffix}`,
  };
}

export interface CloneMismatch {
  field: string;
  expected: string;
  actual: string;
}

/** Metadata is immutable after launch, so this read-back is the only chance to catch a mismatch. */
export function diffMetadata(expected: TokenMetadata, actual: TokenMetadata): CloneMismatch[] {
  const out: CloneMismatch[] = [];
  const check = (field: string, a: string, b: string) => {
    if (a !== b) out.push({ field, expected: a, actual: b });
  };
  check('name', expected.name, actual.name);
  check('symbol', expected.symbol, actual.symbol);
  check('logo', expected.logo, actual.logo);
  check('description', expected.description, actual.description);
  for (const key of Object.keys(expected.socials) as (keyof TokenMetadata['socials'])[]) {
    check(`socials.${key}`, expected.socials[key], actual.socials[key]);
  }
  return out;
}
