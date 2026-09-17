import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import {
  BPS,
  maxTrancheForImpact,
  priceMultipleBps,
  quoteBuy,
  quoteReserveForMultipleBps,
  quoteSell,
  sellImpactBps,
  withSlippage,
} from '../src/core/curve.js';

/** Launch config 0 on Robinhood Chain: 1e9 tokens, 1.68 ETH phantom quote, 100 bps curve fee. */
const OPENING = { quote: parseEther('1.68'), token: 10n ** 27n };
const FEES = { feeBps: 100n, creatorTaxBps: 200n };

describe('quoteBuy', () => {
  it('takes fees off the input before the swap', () => {
    const q = quoteBuy(OPENING, parseEther('1'), FEES);
    expect(q.feeAmount).toBe(parseEther('0.01'));
    expect(q.creatorTax).toBe(parseEther('0.02'));
    expect(q.netQuoteIn).toBe(parseEther('0.97'));
    expect(q.tokensOut).toBe((OPENING.token * q.netQuoteIn) / (OPENING.quote + q.netQuoteIn));
  });

  it('preserves the constant product over pricing reserves', () => {
    const q = quoteBuy(OPENING, parseEther('0.5'), FEES);
    const kBefore = OPENING.quote * OPENING.token;
    const kAfter = q.reservesAfter.quote * q.reservesAfter.token;
    // Integer truncation only ever rounds in the pool's favour.
    expect(kAfter).toBeGreaterThanOrEqual(kBefore);
  });

  it('rejects an input entirely consumed by fees', () => {
    expect(() =>
      quoteBuy(OPENING, parseEther('1'), { feeBps: 5000n, creatorTaxBps: 5000n }),
    ).toThrow();
  });

  it('charges the snipe tax on top of the base fee', () => {
    const plain = quoteBuy(OPENING, parseEther('1'), FEES);
    const sniped = quoteBuy(OPENING, parseEther('1'), { ...FEES, snipeTaxBps: 500n });
    expect(sniped.tokensOut).toBeLessThan(plain.tokensOut);
    expect(sniped.feeAmount - plain.feeAmount).toBe(parseEther('0.05'));
  });
});

describe('quoteSell', () => {
  it('takes fees off the output, not the input', () => {
    const buy = quoteBuy(OPENING, parseEther('1'), FEES);
    const sell = quoteSell(buy.reservesAfter, buy.tokensOut, FEES);
    expect(sell.feeAmount).toBe((sell.grossQuoteOut * 100n) / BPS);
    expect(sell.quoteOut).toBe(sell.grossQuoteOut - sell.feeAmount - sell.creatorTax);
  });

  it('round-trips at a loss equal to both fee legs', () => {
    const buy = quoteBuy(OPENING, parseEther('1'), FEES);
    const sell = quoteSell(buy.reservesAfter, buy.tokensOut, FEES);
    expect(sell.quoteOut).toBeLessThan(parseEther('1'));
    // 3% in, 3% out, so a round trip cannot recover more than ~94.1%.
    expect(sell.quoteOut).toBeGreaterThan((parseEther('1') * 9400n) / BPS);
  });
});

describe('priceMultipleBps', () => {
  it('is quadratic in the quote reserve', () => {
    expect(priceMultipleBps(parseEther('1'), parseEther('2'))).toBe(40000n);
    expect(priceMultipleBps(parseEther('1'), parseEther('1'))).toBe(BPS);
  });

  it('inverts through quoteReserveForMultipleBps', () => {
    const entry = parseEther('1.68');
    const target = quoteReserveForMultipleBps(entry, 40000n);
    expect(priceMultipleBps(entry, target)).toBeGreaterThanOrEqual(39999n);
    expect(priceMultipleBps(entry, target)).toBeLessThanOrEqual(40001n);
  });
});

describe('maxTrancheForImpact', () => {
  it('returns the whole order when it is already inside the cap', () => {
    expect(maxTrancheForImpact(OPENING, 10n ** 18n, 150)).toBe(10n ** 18n);
  });

  it('caps a large order at the impact bound', () => {
    const desired = OPENING.token / 10n;
    const tranche = maxTrancheForImpact(OPENING, desired, 150);
    expect(tranche).toBeLessThan(desired);
    expect(sellImpactBps(OPENING, tranche)).toBeLessThanOrEqual(150n);
    expect(sellImpactBps(OPENING, tranche * 2n)).toBeGreaterThan(150n);
  });
});

describe('withSlippage', () => {
  it('never returns a zero bound', () => {
    expect(withSlippage(1n, 300)).toBe(1n);
    expect(withSlippage(parseEther('1'), 300)).toBe(parseEther('0.97'));
  });
});
