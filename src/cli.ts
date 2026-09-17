#!/usr/bin/env tsx
import { formatEther, getAddress, isAddress, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PONS_V2 } from './chain/addresses.js';
import { assertChainId, makePublicClient, makeWalletClient } from './chain/clients.js';
import { loadConfig, type Config } from './config.js';
import { BPS } from './core/curve.js';
import { assertFeeRecipientPinned } from './core/guards.js';
import { applyCloneOptions, resolveSourceMetadata } from './services/metadata.js';
import { executeLaunch, planLaunch, simulateLaunch } from './services/launcher.js';
import { harvest, readHarvestStatus } from './services/harvester.js';
import {
  canLaunch,
  getLaunchedToken,
  readCurveState,
  readLaunchConfig,
  readProtocolState,
} from './services/protocol.js';
import { runExitTick } from './services/trader.js';
import { Journal } from './state/journal.js';
import { erc20Abi, escrowAbi } from './chain/abis.js';

function requireAddress(value: string | undefined, label: string): Address {
  if (!value || !isAddress(value)) throw new Error(`${label} must be an address`);
  return getAddress(value);
}

function eth(value: bigint): string {
  return `${formatEther(value)} ETH`;
}

async function preflight(config: Config): Promise<void> {
  assertFeeRecipientPinned(config);
  const client = makePublicClient(config);
  await assertChainId(client, config.chainId);

  const [protocol, launchConfig] = await Promise.all([
    readProtocolState(client),
    readLaunchConfig(client, config.launchConfigId),
  ]);

  console.log('chain             ', config.chainId, config.rpcUrls.join(', '));
  console.log('factory           ', PONS_V2.factory);
  console.log('router            ', PONS_V2.launchAndBuyRouter);
  console.log('escrow (on-chain) ', protocol.feeEscrow, protocol.feeEscrow === PONS_V2.feeEscrow ? 'ok' : 'MISMATCH');
  console.log('hook   (on-chain) ', protocol.memeHook, protocol.memeHook === PONS_V2.memeHook ? 'ok' : 'MISMATCH');
  console.log('launch enabled    ', protocol.launchEnabled);
  console.log('launch fee        ', eth(protocol.launchFee));
  console.log('max creator tax   ', `${protocol.maxCreatorTaxBps} bps`);
  console.log('launch config     ', config.launchConfigId.toString(), {
    supply: launchConfig.supply.toString(),
    curveFeeBps: launchConfig.curveFeeBps.toString(),
    phantomQuote: eth(launchConfig.phantomQuote),
    graduationThreshold: eth(launchConfig.graduationThreshold),
    enabled: launchConfig.enabled,
  });
  console.log('profile           ', config.profileName, {
    preBuy: eth(config.profile.preBuyWei),
    maxJobSpend: eth(config.profile.maxJobSpendWei),
  });
  console.log('creator tax       ', `${config.creatorTaxBps} bps`);
  console.log('fee recipient     ', config.creatorFeeRecipient, '(delegated claimer)');
  console.log('dry run           ', config.dryRun);

  const escrowBalance = await client.readContract({
    address: PONS_V2.feeEscrow,
    abi: escrowAbi,
    functionName: 'balanceOf',
    args: [config.creatorFeeRecipient],
  });
  console.log('escrow claimable  ', eth(escrowBalance));

  if (config.launcherKey) {
    const launcher = privateKeyToAccount(config.launcherKey).address;
    const [balance, allowed] = await Promise.all([
      client.getBalance({ address: launcher }),
      canLaunch(client, launcher),
    ]);
    const needed = protocol.launchFee + config.profile.preBuyWei + config.profile.gasBufferWei;
    console.log('launcher          ', launcher, eth(balance), allowed ? 'can launch' : 'NOT WHITELISTED');
    console.log('launcher needs    ', eth(needed), balance >= needed ? 'funded' : 'UNDERFUNDED');
  } else {
    console.log('launcher          ', 'no LAUNCHER_PRIVATE_KEY set (read-only)');
  }
  if (config.claimerKey) {
    const claimer = privateKeyToAccount(config.claimerKey).address;
    const matches = getAddress(claimer) === config.creatorFeeRecipient;
    console.log('claimer           ', claimer, matches ? 'matches fee recipient' : 'DOES NOT MATCH');
  } else {
    console.log('claimer           ', 'no CLAIMER_PRIVATE_KEY set (fees accrue, claim manually)');
  }
}

async function runLaunch(config: Config, source: Address, jobId: string): Promise<void> {
  const client = makePublicClient(config);
  await assertChainId(client, config.chainId);
  if (!config.launcherKey) throw new Error('LAUNCHER_PRIVATE_KEY is required to launch');
  const wallet = makeWalletClient(config, config.launcherKey);
  const launcher = privateKeyToAccount(config.launcherKey).address;
  const journal = new Journal(config.stateDir);

  const metadata = applyCloneOptions(await resolveSourceMetadata(client, source));
  const plan = await planLaunch(client, config, { metadata, launcher });
  journal.create(jobId, {
    sourceToken: source,
    name: metadata.name,
    symbol: metadata.symbol,
    launcher,
    creatorFeeRecipient: config.creatorFeeRecipient,
    state: 'METADATA_OK',
  });

  console.log('clone of          ', source, `-> ${metadata.name} (${metadata.symbol})`);
  console.log('spend             ', eth(plan.totalValue), `= ${eth(plan.launchFee)} fee + ${eth(plan.quoteIn)} pre-buy`);
  console.log('expected tokens   ', plan.expectedTokensOut.toString());
  console.log('min tokens out    ', plan.minTokensOut.toString());
  console.log('fee recipient     ', plan.creatorFeeRecipient);

  const simulated = await simulateLaunch(client, config, plan);
  console.log('simulated token   ', simulated.token, 'curve', simulated.curve);

  if (config.dryRun) {
    console.log('dry run: nothing sent. set DRY_RUN=false to broadcast.');
    return;
  }

  const result = await executeLaunch(client, wallet, config, journal, jobId, plan);
  journal.update(jobId, {
    state: 'HOLDING',
    token: result.token,
    curve: result.curve,
    launchTxHash: result.txHash,
    entryQuoteReserve: result.entryQuoteReserve.toString(),
    tokensBought: result.tokensOut.toString(),
    tokensSold: '0',
    quoteRecovered: '0',
    peakMultipleBps: BPS.toString(),
    rungsFilled: [],
  });
  console.log('launched          ', result.token, 'curve', result.curve, 'tx', result.txHash);
  console.log('tokens held       ', result.tokensOut.toString());
  if (result.metadataMismatches.length > 0) {
    console.log('metadata mismatch ', result.metadataMismatches);
  }
}

async function runWatch(config: Config, jobId: string, ticks: number): Promise<void> {
  const client = makePublicClient(config);
  await assertChainId(client, config.chainId);
  const journal = new Journal(config.stateDir);
  const job = journal.get(jobId);
  if (!job?.token || !job.curve || !job.entryQuoteReserve) throw new Error(`job ${jobId} has no position`);
  if (!config.launcherKey) throw new Error('LAUNCHER_PRIVATE_KEY is required to exit');
  const wallet = makeWalletClient(config, config.launcherKey);
  const holder = privateKeyToAccount(config.launcherKey).address;

  const originallyBought = BigInt(job.tokensBought ?? '0');
  for (let tick = 0; tick < ticks; tick += 1) {
    const held = await client.readContract({
      address: job.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [holder],
    });
    const result = await runExitTick(client, wallet, config, journal, jobId, {
      token: job.token,
      curve: job.curve,
      recipient: holder,
      entryQuoteReserve: BigInt(job.entryQuoteReserve),
      tokensHeld: held,
      tokensBoughtOriginally: originallyBought,
      tradableAllocation: originallyBought,
      peakMultipleBps: BigInt(job.peakMultipleBps ?? BPS.toString()),
      rungsFilled: job.rungsFilled ?? [],
    });
    const soldNow = result.sells.reduce((acc, s) => acc + s.tokensSold, 0n);
    const quoteNow = result.sells.reduce((acc, s) => acc + s.quoteOut, 0n);
    console.log(
      `tick ${tick} m=${Number(result.multipleBps) / 10000}x peak=${Number(result.peakMultipleBps) / 10000}x ` +
        `rule=${result.rule} sold=${soldNow} quote=${eth(quoteNow)}`,
    );
    const rungMatch = /ladder-rung-(\d)/.exec(result.rule);
    journal.update(jobId, {
      peakMultipleBps: result.peakMultipleBps.toString(),
      tokensSold: (BigInt(job.tokensSold ?? '0') + soldNow).toString(),
      quoteRecovered: (BigInt(job.quoteRecovered ?? '0') + quoteNow).toString(),
      rungsFilled: rungMatch?.[1]
        ? [...(job.rungsFilled ?? []), Number(rungMatch[1])]
        : (job.rungsFilled ?? []),
      state: result.rule === 'graduation-lockout' || soldNow > 0n ? 'EXITING' : 'HOLDING',
    });
    if (tick < ticks - 1) await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function runHarvest(config: Config, jobId: string): Promise<void> {
  const client = makePublicClient(config);
  await assertChainId(client, config.chainId);
  const journal = new Journal(config.stateDir);
  const job = journal.get(jobId);
  if (!job?.token || !job.curve) throw new Error(`job ${jobId} has no launched token`);

  const status = await readHarvestStatus(client, config, job.token, job.curve);
  console.log('graduated         ', status.graduated);
  console.log('curve creator tax ', eth(status.curveCreatorTaxWei));
  console.log('hook pending      ', eth(status.hookPendingQuoteWei), `+ ${status.hookPendingTokenWei} tokens`);
  console.log('escrow claimable  ', eth(status.escrowQuoteWei), `+ ${status.escrowTokenWei} tokens`);
  console.log('fee recipient     ', status.creatorFeeRecipient);

  const sweeper = config.launcherKey ? makeWalletClient(config, config.launcherKey) : undefined;
  const claimer = config.claimerKey ? makeWalletClient(config, config.claimerKey) : undefined;
  const result = await harvest(client, config, journal, jobId, {
    token: job.token,
    curve: job.curve,
    sweeper,
    claimer,
  });
  console.log('result            ', {
    sweep: result.sweepTxHash,
    claim: result.claimTxHash,
    claimToken: result.claimTokenTxHash,
    claimed: eth(result.claimedQuoteWei),
    skipped: result.skipped,
  });
}

async function runStatus(config: Config, jobId: string | undefined): Promise<void> {
  const journal = new Journal(config.stateDir);
  const jobs = jobId ? [journal.get(jobId)].filter(Boolean) : journal.list();
  if (jobs.length === 0) {
    console.log('no jobs in', journal.directory);
    return;
  }
  const client = makePublicClient(config);
  for (const job of jobs) {
    if (!job) continue;
    console.log('---', job.id, job.state, job.symbol ?? '');
    if (job.token && job.curve) {
      const [record, state] = await Promise.all([
        getLaunchedToken(client, job.token),
        readCurveState(client, job.curve),
      ]);
      console.log('  token           ', job.token);
      console.log('  fee recipient   ', record.creatorFeeRecipient);
      console.log('  reserves        ', eth(state.reserves.quote), '/', state.reserves.token.toString());
      console.log('  real quote      ', eth(state.realQuoteReserve), 'of', eth(state.graduationThreshold));
      console.log('  creator tax due ', eth(state.creatorTaxBalance));
    }
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = loadConfig();
  switch (command) {
    case 'preflight':
      return preflight(config);
    case 'launch':
      return runLaunch(
        config,
        requireAddress(rest[0], 'source token'),
        rest[1] ?? `job-${Date.now()}`,
      );
    case 'watch':
      return runWatch(config, rest[0] ?? '', Number(rest[1] ?? 20));
    case 'harvest':
      return runHarvest(config, rest[0] ?? '');
    case 'status':
      return runStatus(config, rest[0]);
    default:
      console.log(
        [
          'usage: npm run bot -- <command>',
          '',
          '  preflight                     read-only wiring + funding check',
          '  launch <sourceToken> [jobId]  clone-launch with an atomic pre-buy',
          '  watch <jobId> [ticks]         run the exit engine',
          '  harvest <jobId>               sweep fees and claim as the delegated recipient',
          '  status [jobId]                job and on-chain state',
        ].join('\n'),
      );
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
