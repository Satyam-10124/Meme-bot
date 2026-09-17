import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { loadConfig } from '../src/config.js';
import { decideExit, type ExitInputs } from '../src/core/exit.js';
import { quoteReserveForMultipleBps } from '../src/core/curve.js';

const config = loadConfig();
const ENTRY = parseEther('1.68');

function inputs(overrides: Partial<ExitInputs> = {}): ExitInputs {
  return {
    entryQuoteReserve: ENTRY,
    quoteReserve: ENTRY,
    realQuoteReserve: parseEther('0.1'),
    graduationThreshold: parseEther('4.2'),
    sellableTokens: 10n ** 26n,
    tradableAllocation: 10n ** 24n,
    readyToGraduate: false,
    tokensHeld: 10n ** 24n,
    tokensBoughtOriginally: 10n ** 24n,
    peakMultipleBps: 10_000n,
    rungsFilled: [],
    nowSeconds: 1_000,
    lastBuyAtSeconds: 1_000,
    flow60sWei: 0n,
    distinctBuyers60s: 0,
    ...overrides,
  };
}

describe('decideExit', () => {
  it('holds a flat position', () => {
    expect(decideExit(config, inputs()).action).toBe('hold');
  });

  it('dumps everything once graduation is close, even in profit', () => {
    const d = decideExit(
      config,
      inputs({
        realQuoteReserve: parseEther('4.0'),
        quoteReserve: quoteReserveForMultipleBps(ENTRY, 50_000n),
      }),
    );
    expect(d.rule).toBe('graduation-lockout');
    expect(d.tokens).toBe(10n ** 24n);
  });

  it('outranks every profit rule with the graduation lockout', () => {
    const d = decideExit(config, inputs({ readyToGraduate: true }));
    expect(d.rule).toBe('graduation-lockout');
  });

  it('stops out below 0.65x', () => {
    const d = decideExit(config, inputs({ quoteReserve: quoteReserveForMultipleBps(ENTRY, 6000n) }));
    expect(d.rule).toBe('stop-loss');
  });

  it('time-stops a stalled position', () => {
    const d = decideExit(config, inputs({ nowSeconds: 2_000, lastBuyAtSeconds: 1_000 }));
    expect(d.rule).toBe('time-stop');
  });

  it('sells 40% of the original position at the first rung', () => {
    const d = decideExit(
      config,
      inputs({ quoteReserve: quoteReserveForMultipleBps(ENTRY, 20_500n) }),
    );
    expect(d.rule).toBe('ladder-rung-1');
    expect(d.tokens).toBe((10n ** 24n * 4000n) / 10_000n);
  });

  it('defers a rung while momentum is strong', () => {
    const d = decideExit(
      config,
      inputs({
        quoteReserve: quoteReserveForMultipleBps(ENTRY, 20_500n),
        flow60sWei: parseEther('0.2'),
        distinctBuyers60s: 5,
      }),
    );
    expect(d.action).toBe('hold');
    expect(d.rule).toBe('momentum-defer-rung-1');
  });

  it('never lets momentum defer the stop loss', () => {
    const d = decideExit(
      config,
      inputs({
        quoteReserve: quoteReserveForMultipleBps(ENTRY, 5_000n),
        flow60sWei: parseEther('1'),
        distinctBuyers60s: 9,
      }),
    );
    expect(d.rule).toBe('stop-loss');
  });

  it('trails out after a 2x peak gives back 25%', () => {
    const d = decideExit(
      config,
      inputs({
        peakMultipleBps: 40_000n,
        quoteReserve: quoteReserveForMultipleBps(ENTRY, 29_000n),
        rungsFilled: [1, 2],
      }),
    );
    expect(d.rule).toBe('trailing-stop');
  });

  it('does not refill a rung it already filled', () => {
    const d = decideExit(
      config,
      inputs({ quoteReserve: quoteReserveForMultipleBps(ENTRY, 21_000n), rungsFilled: [1] }),
    );
    expect(d.action).toBe('hold');
  });

  it('holds when there is nothing left', () => {
    expect(decideExit(config, inputs({ tokensHeld: 0n })).rule).toBe('no-position');
  });
});
