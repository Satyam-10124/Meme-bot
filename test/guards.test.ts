import { describe, expect, it } from 'vitest';
import { encodeFunctionData, parseEther, toFunctionSelector, zeroAddress } from 'viem';
import { curveAbi, escrowAbi, routerAbi } from '../src/chain/abis.js';
import { PONS_V2 } from '../src/chain/addresses.js';
import { CREATOR_FEE_RECIPIENT, loadConfig } from '../src/config.js';
import { ALLOWED_SELECTORS, assertAllowedTx, assertFeeRecipientPinned } from '../src/core/guards.js';

const config = loadConfig();
const CURVE = '0x1111111111111111111111111111111111111111' as const;

describe('fee delegation', () => {
  it('pins the requested claimer wallet', () => {
    expect(CREATOR_FEE_RECIPIENT).toBe('0x0A06b2bDb8daf62fc828a792fc40B0B7538D1A5B');
    expect(config.creatorFeeRecipient).toBe(CREATOR_FEE_RECIPIENT);
    expect(() => assertFeeRecipientPinned(config)).not.toThrow();
  });

  it('rejects a zero recipient', () => {
    expect(() =>
      assertFeeRecipientPinned({ ...config, creatorFeeRecipient: zeroAddress }),
    ).toThrow();
  });
});

describe('assertAllowedTx', () => {
  it('allows a claim against the escrow', () => {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'claim' });
    expect(() => assertAllowedTx(config, { to: PONS_V2.feeEscrow, data, value: 0n })).not.toThrow();
  });

  it('rejects an unknown destination', () => {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'claim' });
    expect(() => assertAllowedTx(config, { to: CURVE, data, value: 0n })).toThrow(/allowlist/);
  });

  it('allows the job curve once it is declared', () => {
    const data = encodeFunctionData({
      abi: curveAbi,
      functionName: 'sell',
      args: [1n, 1n, CREATOR_FEE_RECIPIENT],
    });
    expect(() =>
      assertAllowedTx(config, { to: CURVE, data, value: 0n, curve: CURVE }),
    ).not.toThrow();
  });

  it('rejects a value above the per-job cap', () => {
    expect(() =>
      assertAllowedTx(config, { to: PONS_V2.launchAndBuyRouter, value: parseEther('10') }),
    ).toThrow(/spend cap/);
  });

  it('rejects an unlisted selector on an allowed destination', () => {
    expect(() =>
      assertAllowedTx(config, { to: PONS_V2.factory, data: '0xdeadbeef', value: 0n }),
    ).toThrow(/selector/);
  });

  it('allowlists the exact launchAndBuy selector the router exposes', () => {
    const selector = toFunctionSelector(
      routerAbi.find((item) => item.type === 'function' && item.name === 'launchAndBuy')!,
    );
    expect(ALLOWED_SELECTORS.has(selector)).toBe(true);
  });
});
