import { getAddress, slice, type Address, type Hex } from 'viem';
import { PONS_V2 } from '../chain/addresses.js';
import type { Config } from '../config.js';

/**
 * Destination + selector allowlist. A compromised strategy process can still ask the signer
 * to send something; this is what stops it from being an arbitrary call that drains the wallet.
 */
export const ALLOWED_SELECTORS = new Set<string>([
  '0x59a87bc1', // buy(uint256,uint256,address)
  '0xd04c6983', // sell(uint256,uint256,address)
  '0x3729bb9a', // sweepFees(uint256)
  '0x2f53ef2f', // createGraduatedPool(address)
  '0x2931861b', // transferCreatorFeeRecipient(address,address)
  '0x4e71d92d', // claim()
  '0x379607f5', // claim(uint256)
  '0x32f289cf', // claimToken(address)
  '0x1698755f', // claimToken(address,uint256)
  '0xf85f8e41', // launchAndBuy(...)
  '0xf35abbcf', // launchToken(params,launchConfigId,pairToken)
  '0x3d61055e', // sweepPoolFees(bytes32,uint256,uint256)
  '0x3d3d2d58', // executeCreatorFeeRecipientChange(address)
  '0x095ea7b3', // approve(address,uint256)
]);

export interface TxIntent {
  to: Address;
  data?: Hex;
  value: bigint;
  /** Curve of the job this transaction belongs to, if any. */
  curve?: Address;
  /** Launched token of the job this transaction belongs to, if any (approvals target it). */
  token?: Address;
  /** Plain native transfer to the treasury; exempt from the per-job spend cap, nothing else is. */
  transfer?: boolean;
  /**
   * A wallet the bot itself controls (a job wallet from the wallet book, or the central
   * launcher). Transfers to it stay under the per-job spend cap; nothing else may target it.
   */
  ownWallet?: Address;
}

export class GuardError extends Error {}

export function assertAllowedTx(config: Config, intent: TxIntent): void {
  const to = getAddress(intent.to);
  const allowedDestinations = new Set<Address>([
    PONS_V2.factory,
    PONS_V2.launchAndBuyRouter,
    PONS_V2.feeEscrow,
    PONS_V2.memeHook,
    config.treasury,
    config.creatorFeeRecipient,
  ]);
  if (intent.curve) allowedDestinations.add(getAddress(intent.curve));
  if (intent.token) allowedDestinations.add(getAddress(intent.token));
  if (intent.transfer && intent.ownWallet) allowedDestinations.add(getAddress(intent.ownWallet));

  if (!allowedDestinations.has(to)) {
    throw new GuardError(`destination ${to} is not in the allowlist`);
  }
  if (intent.data && intent.data !== '0x') {
    const selector = slice(intent.data, 0, 4);
    if (!ALLOWED_SELECTORS.has(selector)) {
      throw new GuardError(`selector ${selector} is not in the allowlist`);
    }
  }
  if (intent.transfer) {
    if (intent.data && intent.data !== '0x') {
      throw new GuardError('treasury transfers must carry no calldata');
    }
    if (to === getAddress(config.treasury)) return;
    if (intent.ownWallet && to === getAddress(intent.ownWallet)) {
      if (intent.value > config.profile.maxJobSpendWei) {
        throw new GuardError(
          `wallet funding ${intent.value} exceeds per-job spend cap ${config.profile.maxJobSpendWei}`,
        );
      }
      return;
    }
    throw new GuardError(`transfers may only target the treasury or an own wallet, not ${to}`);
  }
  if (intent.value > config.profile.maxJobSpendWei) {
    throw new GuardError(
      `value ${intent.value} exceeds per-job spend cap ${config.profile.maxJobSpendWei}`,
    );
  }
}

/** Boot-time assertion: the fee recipient constant must be a checksummed, non-zero address. */
export function assertFeeRecipientPinned(config: Config): void {
  const pinned = getAddress(config.creatorFeeRecipient);
  if (pinned === '0x0000000000000000000000000000000000000000') {
    throw new GuardError('creator fee recipient must not be the zero address');
  }
  if (pinned !== config.creatorFeeRecipient) {
    throw new GuardError('creator fee recipient is not checksummed');
  }
}
