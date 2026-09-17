/**
 * Exact integer reproduction of the pons v2 bonding curve.
 *
 * The curve is constant product over *pricing* reserves, which include the phantom quote:
 * `k = quoteReserve * tokenReserve`, marginal price `P = quoteReserve / tokenReserve`.
 *
 * Buys take fees off the *input* before the swap; sells take them off the *output* after it.
 * Quoting a sell as a mirrored buy overstates proceeds, which is why the two paths below are
 * not symmetric. Everything is BigInt — a float anywhere here makes the quote drift from
 * settlement and turns `minTokensOut` into a lie.
 */

export const BPS = 10_000n;

export interface Reserves {
  /** Pricing quote reserve (real + phantom), from `getReserves()`. */
  quote: bigint;
  /** Pricing token reserve, from `getReserves()`. */
  token: bigint;
}

export interface CurveFees {
  feeBps: bigint;
  creatorTaxBps: bigint;
  /** Decaying opening tax, in bps, for this specific buyer. Zero once exempt or decayed out. */
  snipeTaxBps?: bigint;
}

export interface BuyQuote {
  quoteIn: bigint;
  feeAmount: bigint;
  creatorTax: bigint;
  netQuoteIn: bigint;
  tokensOut: bigint;
  reservesAfter: Reserves;
}

export interface SellQuote {
  tokensIn: bigint;
  grossQuoteOut: bigint;
  feeAmount: bigint;
  creatorTax: bigint;
  quoteOut: bigint;
  reservesAfter: Reserves;
}

export function quoteBuy(reserves: Reserves, quoteIn: bigint, fees: CurveFees): BuyQuote {
  if (quoteIn <= 0n) throw new Error('quoteIn must be positive');
  const snipe = fees.snipeTaxBps ?? 0n;
  const feeAmount = (quoteIn * (fees.feeBps + snipe)) / BPS;
  const creatorTax = (quoteIn * fees.creatorTaxBps) / BPS;
  const netQuoteIn = quoteIn - feeAmount - creatorTax;
  if (netQuoteIn <= 0n) throw new Error('fees consume the entire input');
  const tokensOut = (reserves.token * netQuoteIn) / (reserves.quote + netQuoteIn);
  return {
    quoteIn,
    feeAmount,
    creatorTax,
    netQuoteIn,
    tokensOut,
    reservesAfter: { quote: reserves.quote + netQuoteIn, token: reserves.token - tokensOut },
  };
}

export function quoteSell(reserves: Reserves, tokensIn: bigint, fees: CurveFees): SellQuote {
  if (tokensIn <= 0n) throw new Error('tokensIn must be positive');
  const grossQuoteOut = (reserves.quote * tokensIn) / (reserves.token + tokensIn);
  const feeAmount = (grossQuoteOut * fees.feeBps) / BPS;
  const creatorTax = (grossQuoteOut * fees.creatorTaxBps) / BPS;
  return {
    tokensIn,
    grossQuoteOut,
    feeAmount,
    creatorTax,
    quoteOut: grossQuoteOut - feeAmount - creatorTax,
    reservesAfter: { quote: reserves.quote - grossQuoteOut, token: reserves.token + tokensIn },
  };
}

/** `minOut` bound for a trade, in the same integer domain the curve settles in. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  const out = (amount * (BPS - BigInt(slippageBps))) / BPS;
  return out > 0n ? out : 1n;
}

/**
 * Price multiple against an entry, in bps. Price scales with the square of the quote reserve
 * (`P = Q/T` and `Q·T = k`), so this is `(Q / Q_entry)²` without ever leaving integers.
 */
export function priceMultipleBps(entryQuote: bigint, currentQuote: bigint): bigint {
  if (entryQuote <= 0n) throw new Error('entryQuote must be positive');
  return (currentQuote * currentQuote * BPS) / (entryQuote * entryQuote);
}

/**
 * Marginal price impact of a sell, in bps of the pre-trade price. The ratio is taken as a
 * single cross-multiplication: with a 1.68e18 quote reserve against a 1e27 token reserve,
 * computing each price first truncates to zero and would report every order as harmless.
 */
export function sellImpactBps(reserves: Reserves, tokensIn: bigint): bigint {
  if (reserves.quote === 0n || reserves.token === 0n) return 0n;
  const { reservesAfter } = quoteSell(reserves, tokensIn, { feeBps: 0n, creatorTaxBps: 0n });
  const retainedBps =
    (reservesAfter.quote * reserves.token * BPS) / (reserves.quote * reservesAfter.token);
  return retainedBps >= BPS ? 0n : BPS - retainedBps;
}

/**
 * Largest sell that keeps marginal price impact within `maxImpactBps`. Binary search rather
 * than a closed form so the bound holds against the same integer arithmetic the curve uses.
 */
export function maxTrancheForImpact(
  reserves: Reserves,
  desiredTokens: bigint,
  maxImpactBps: number,
): bigint {
  if (desiredTokens <= 0n) return 0n;
  if (sellImpactBps(reserves, desiredTokens) <= BigInt(maxImpactBps)) return desiredTokens;
  let lo = 1n;
  let hi = desiredTokens;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (sellImpactBps(reserves, mid) <= BigInt(maxImpactBps)) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/** Quote reserve implied by a target price multiple: `Q = Q_entry · √m`. */
export function quoteReserveForMultipleBps(entryQuote: bigint, multipleBps: bigint): bigint {
  return sqrt(entryQuote * entryQuote * multipleBps) / sqrt(BPS);
}

export function sqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('sqrt of negative');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}
