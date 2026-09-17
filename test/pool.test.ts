import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { PONS_V2 } from '../src/chain/addresses.js';
import { computePoolId, poolKeyFor } from '../src/services/pool.js';

const TOKEN = '0x00000000000000000000000000000000000000ff' as const;

describe('poolKeyFor', () => {
  it('sorts currencies ascending, native first', () => {
    const key = poolKeyFor(TOKEN, zeroAddress, 0, 200);
    expect(key.currency0).toBe(zeroAddress);
    expect(key.currency1.toLowerCase()).toBe(TOKEN);
    expect(key.hooks).toBe(PONS_V2.memeHook);
  });

  it('is order-independent', () => {
    expect(computePoolId(poolKeyFor(TOKEN, zeroAddress, 0, 200))).toBe(
      computePoolId(poolKeyFor(zeroAddress, TOKEN, 0, 200)),
    );
  });

  it('separates pools that differ only in tick spacing', () => {
    expect(computePoolId(poolKeyFor(TOKEN, zeroAddress, 0, 200))).not.toBe(
      computePoolId(poolKeyFor(TOKEN, zeroAddress, 0, 60)),
    );
  });
});
