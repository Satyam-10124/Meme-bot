import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { hookAbi } from '../chain/abis.js';
import { PONS_V2 } from '../chain/addresses.js';

/**
 * Uniswap v4 `PoolId` — keccak256 of the abi-encoded PoolKey, with currencies sorted
 * ascending. The graduated pool is not stored on the factory record, so the id has to be
 * reconstructed; `resolvePoolId` only returns it after the hook confirms the match.
 */
export function computePoolId(key: {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('address, address, uint24, int24, address'), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

export function poolKeyFor(token: Address, pairToken: Address, fee: number, tickSpacing: number) {
  const a = getAddress(token);
  const b = getAddress(pairToken);
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks: PONS_V2.memeHook };
}

/** Returns the pool id only if the hook has it registered against this exact token. */
export async function resolvePoolId(
  client: PublicClient,
  token: Address,
  pairToken: Address,
  fee: number,
  tickSpacing: number,
): Promise<Hex | undefined> {
  const poolId = computePoolId(poolKeyFor(token, pairToken, fee, tickSpacing));
  const launch = await client.readContract({
    address: PONS_V2.memeHook,
    abi: hookAbi,
    functionName: 'launches',
    args: [poolId],
  });
  const [registered, , memecoin] = launch;
  if (!registered || getAddress(memecoin) !== getAddress(token)) return undefined;
  return poolId;
}
