import 'dotenv/config';
import { getAddress, isAddress, parseEther, type Address, type Hex } from 'viem';
import { CHAIN_ID, DEFAULT_RPC_URLS } from './chain/addresses.js';

/**
 * The wallet every launch delegates its creator fees to. This is a compile-time constant
 * on purpose: it is the one non-protocol destination the bot is allowed to point value at,
 * so changing it requires a code change and a review, not an env var on a compromised host.
 */
export const CREATOR_FEE_RECIPIENT: Address = getAddress(
  '0x0A06b2bDb8daf62fc828a792fc40B0B7538D1A5B',
);

export type ProfileName = 'micro' | 'standard';

export interface Profile {
  /** Native quote spent on the atomic pre-buy, in wei. */
  preBuyWei: bigint;
  /** Gas headroom left in the launcher wallet after the launch, in wei. */
  gasBufferWei: bigint;
  /** Hard per-job spend cap enforced before any transaction is signed, in wei. */
  maxJobSpendWei: bigint;
}

/**
 * `micro` is the low-funds mainnet profile: real chain, real contracts, ~0.0009 ETH all-in
 * per launch (0.0005 launch fee + 0.0002 pre-buy + gas). It exists so the whole pipeline —
 * launch, exit, sweep, claim — can be exercised on Robinhood mainnet for pocket change.
 */
export const PROFILES: Record<ProfileName, Profile> = {
  micro: {
    preBuyWei: parseEther('0.0002'),
    gasBufferWei: parseEther('0.0002'),
    maxJobSpendWei: parseEther('0.002'),
  },
  standard: {
    preBuyWei: parseEther('0.025'),
    gasBufferWei: parseEther('0.002'),
    maxJobSpendWei: parseEther('0.035'),
  },
};

export interface Config {
  chainId: number;
  rpcUrls: string[];
  profileName: ProfileName;
  profile: Profile;
  launchConfigId: bigint;
  creatorTaxBps: number;
  creatorFeeRecipient: Address;
  treasury: Address;
  slippageBps: number;
  gasMultiplierPercent: bigint;
  dryRun: boolean;
  launcherKey: Hex | undefined;
  claimerKey: Hex | undefined;
  stateDir: string;
  /** Harvester thresholds, all in wei of the quote asset. */
  sweepThresholdWei: bigint;
  claimThresholdWei: bigint;
  /** Exit engine thresholds. */
  exit: {
    stopLossBps: number;
    rung1MultipleBps: number;
    rung1SellBps: number;
    rung2MultipleBps: number;
    rung2SellBps: number;
    trailArmMultipleBps: number;
    trailGiveBackBps: number;
    graduationLockoutBps: number;
    timeStopSeconds: number;
    timeStopMultipleBps: number;
    momentumFlowWei: bigint;
    momentumBuyers: number;
    maxTrancheImpactBps: number;
    maxTranchesPerTick: number;
    /** Trailing block window used for the momentum read; ~1 block/s on Robinhood Chain. */
    flowWindowBlocks: number;
  };
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function envInt(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${v}`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = env(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envKey(name: string): Hex | undefined {
  const v = env(name);
  if (v === undefined) return undefined;
  const hex = v.startsWith('0x') ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} must be a 32-byte hex private key`);
  return hex as Hex;
}

function envAddress(name: string, fallback: Address): Address {
  const v = env(name);
  if (v === undefined) return fallback;
  if (!isAddress(v)) throw new Error(`${name} must be an address, got ${v}`);
  return getAddress(v);
}

export function loadConfig(): Config {
  const profileName = (env('PROFILE') ?? 'micro') as ProfileName;
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`PROFILE must be one of ${Object.keys(PROFILES).join(', ')}`);

  const preBuyOverride = env('PRE_BUY_ETH');
  const resolvedProfile: Profile = preBuyOverride
    ? { ...profile, preBuyWei: parseEther(preBuyOverride) }
    : profile;
  if (resolvedProfile.preBuyWei > resolvedProfile.maxJobSpendWei) {
    throw new Error('PRE_BUY_ETH exceeds the profile per-job spend cap');
  }

  const creatorTaxBps = envInt('CREATOR_TAX_BPS', 200);
  if (creatorTaxBps < 0 || creatorTaxBps > 1000) throw new Error('CREATOR_TAX_BPS must be 0..1000');

  return {
    chainId: CHAIN_ID,
    rpcUrls: (env('RPC_URLS') ?? DEFAULT_RPC_URLS.join(',')).split(',').map((u) => u.trim()),
    profileName,
    profile: resolvedProfile,
    launchConfigId: BigInt(envInt('LAUNCH_CONFIG_ID', 0)),
    creatorTaxBps,
    creatorFeeRecipient: CREATOR_FEE_RECIPIENT,
    treasury: envAddress('TREASURY', CREATOR_FEE_RECIPIENT),
    slippageBps: envInt('SLIPPAGE_BPS', 300),
    gasMultiplierPercent: BigInt(envInt('GAS_MULTIPLIER_PERCENT', 130)),
    dryRun: envBool('DRY_RUN', true),
    launcherKey: envKey('LAUNCHER_PRIVATE_KEY'),
    claimerKey: envKey('CLAIMER_PRIVATE_KEY'),
    stateDir: env('STATE_DIR') ?? '.pons-state',
    sweepThresholdWei: parseEther(env('SWEEP_THRESHOLD_ETH') ?? '0.00002'),
    claimThresholdWei: parseEther(env('CLAIM_THRESHOLD_ETH') ?? '0.00002'),
    exit: {
      stopLossBps: envInt('EXIT_STOP_LOSS_BPS', 6500),
      rung1MultipleBps: envInt('EXIT_RUNG1_MULTIPLE_BPS', 20000),
      rung1SellBps: envInt('EXIT_RUNG1_SELL_BPS', 4000),
      rung2MultipleBps: envInt('EXIT_RUNG2_MULTIPLE_BPS', 30000),
      rung2SellBps: envInt('EXIT_RUNG2_SELL_BPS', 3000),
      trailArmMultipleBps: envInt('EXIT_TRAIL_ARM_BPS', 20000),
      trailGiveBackBps: envInt('EXIT_TRAIL_GIVEBACK_BPS', 7500),
      graduationLockoutBps: envInt('EXIT_GRADUATION_LOCKOUT_BPS', 9300),
      timeStopSeconds: envInt('EXIT_TIME_STOP_SECONDS', 600),
      timeStopMultipleBps: envInt('EXIT_TIME_STOP_MULTIPLE_BPS', 13000),
      momentumFlowWei: parseEther(env('EXIT_MOMENTUM_FLOW_ETH') ?? '0.15'),
      momentumBuyers: envInt('EXIT_MOMENTUM_BUYERS', 4),
      maxTrancheImpactBps: envInt('EXIT_MAX_TRANCHE_IMPACT_BPS', 150),
      maxTranchesPerTick: envInt('EXIT_MAX_TRANCHES_PER_TICK', 8),
      flowWindowBlocks: envInt('EXIT_FLOW_WINDOW_BLOCKS', 60),
    },
  };
}
