import type { Config } from '../config.js';
import { BPS, priceMultipleBps } from './curve.js';

export interface ExitInputs {
  /** Pricing quote reserve at the moment the pre-buy filled. */
  entryQuoteReserve: bigint;
  quoteReserve: bigint;
  realQuoteReserve: bigint;
  graduationThreshold: bigint;
  sellableTokens: bigint;
  tradableAllocation: bigint;
  readyToGraduate: boolean;
  tokensHeld: bigint;
  tokensBoughtOriginally: bigint;
  peakMultipleBps: bigint;
  rungsFilled: number[];
  nowSeconds: number;
  lastBuyAtSeconds: number | undefined;
  /** Net inbound quote over the trailing 60s, from CurveBuy/CurveSell events. */
  flow60sWei: bigint;
  distinctBuyers60s: number;
}

export interface ExitDecision {
  action: 'hold' | 'sell';
  /** Tokens to sell this tick, before tranching. */
  tokens: bigint;
  rule: string;
  multipleBps: bigint;
  peakMultipleBps: bigint;
}

/**
 * The exit engine, evaluated once per new head. Every input is an on-chain integer and every
 * threshold is config, in strict priority order — rule 0 outranks every profit rule because
 * sells revert once `readyToGraduate()` is true, which happens *before* `graduated()` flips.
 */
export function decideExit(config: Config, inputs: ExitInputs): ExitDecision {
  const m = priceMultipleBps(inputs.entryQuoteReserve, inputs.quoteReserve);
  const peak = m > inputs.peakMultipleBps ? m : inputs.peakMultipleBps;
  const base = { multipleBps: m, peakMultipleBps: peak } as const;
  const hold = (rule: string): ExitDecision => ({ action: 'hold', tokens: 0n, rule, ...base });
  const sellAll = (rule: string): ExitDecision => ({
    action: 'sell',
    tokens: inputs.tokensHeld,
    rule,
    ...base,
  });

  if (inputs.tokensHeld <= 0n) return hold('no-position');

  // Rule 0 — graduation lockout.
  const progressBps =
    inputs.graduationThreshold > 0n
      ? (inputs.realQuoteReserve * BPS) / inputs.graduationThreshold
      : 0n;
  const sellableBps =
    inputs.tradableAllocation > 0n ? (inputs.sellableTokens * BPS) / inputs.tradableAllocation : BPS;
  if (
    inputs.readyToGraduate ||
    progressBps >= BigInt(config.exit.graduationLockoutBps) ||
    sellableBps <= 300n
  ) {
    return sellAll('graduation-lockout');
  }

  // Rule 1 — stop loss.
  if (m <= BigInt(config.exit.stopLossBps)) return sellAll('stop-loss');

  // Rule 2 — time stop.
  if (
    inputs.lastBuyAtSeconds !== undefined &&
    inputs.nowSeconds - inputs.lastBuyAtSeconds > config.exit.timeStopSeconds &&
    m < BigInt(config.exit.timeStopMultipleBps)
  ) {
    return sellAll('time-stop');
  }

  // Rule 6 — momentum gate defers the ladder rungs (but never rules 0, 1, 2, or 5).
  const momentum =
    inputs.flow60sWei > config.exit.momentumFlowWei &&
    inputs.distinctBuyers60s >= config.exit.momentumBuyers;

  // Rule 5 — trailing stop. This, not the rungs, is what captures a runner.
  if (peak >= BigInt(config.exit.trailArmMultipleBps)) {
    const trigger = (peak * BigInt(config.exit.trailGiveBackBps)) / BPS;
    if (m <= trigger) return sellAll('trailing-stop');
  }

  // Rules 3 and 4 — ladder rungs, sized against the original position.
  const rungs = [
    { id: 1, multiple: BigInt(config.exit.rung1MultipleBps), sellBps: BigInt(config.exit.rung1SellBps) },
    { id: 2, multiple: BigInt(config.exit.rung2MultipleBps), sellBps: BigInt(config.exit.rung2SellBps) },
  ];
  for (const rung of rungs) {
    if (inputs.rungsFilled.includes(rung.id)) continue;
    if (m < rung.multiple) continue;
    if (momentum) return hold(`momentum-defer-rung-${rung.id}`);
    const size = (inputs.tokensBoughtOriginally * rung.sellBps) / BPS;
    const tokens = size < inputs.tokensHeld ? size : inputs.tokensHeld;
    return { action: 'sell', tokens, rule: `ladder-rung-${rung.id}`, ...base };
  }

  return hold('hold');
}
