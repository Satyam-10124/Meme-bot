# pons-fee-bot

Clone-launch / pre-buy / fee-harvest bot for pons v2 on Robinhood Chain (chain id 4663).

Every launch delegates its creator fees to **0x0A06b2bDb8daf62fc828a792fc40B0B7538D1A5B**,
which stays the recipient on the factory record and the only account that can claim from the
fee escrow. The address is a compile-time constant in `src/config.ts`, not an env var: it is
the one non-protocol destination the bot may point value at, so moving it takes a code change.

## Contracts (verified on-chain, not hardcoded trust)

| role | address |
| --- | --- |
| factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| launchAndBuy router | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` |
| fee escrow | `0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` |
| meme hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` |

`preflight` re-reads `feeEscrow()` and `memeHook()` from the factory and flags a mismatch.

## Low-funds mainnet testing

The `micro` profile is the default and exists so the full pipeline can be exercised on real
mainnet for pocket change:

| | micro | standard |
| --- | --- | --- |
| pre-buy | 0.0002 ETH | 0.025 ETH |
| per-job spend cap | 0.002 ETH | 0.035 ETH |
| all-in per launch | ~0.0009 ETH incl. the 0.0005 launch fee and gas | ~0.026 ETH |

`DRY_RUN=true` is the default; nothing is broadcast until it is explicitly set to `false`.

```bash
npm install
cp .env.example .env          # set LAUNCHER_PRIVATE_KEY
npm run bot -- preflight      # read-only: wiring, config, funding, delegation
npm run bot -- launch 0xSourceToken            # dry run: simulates launchAndBuy
DRY_RUN=false npm run bot -- launch 0xSourceToken my-first-job
npm run bot -- watch my-first-job 60
npm run bot -- harvest my-first-job
npm run bot -- status
```

Suggested first live run: keep `micro`, launch once, watch it, then harvest. Fund the launcher
with ~0.002 ETH. For the requested experiment, use source token
`0x35b8b49c9c4e7a5d08dc1ba0ea5eac0b9937bc83`.

The generated launcher wallet is printed separately by Devin; fund only that address with the
micro budget. The creator-fee treasury/claimer is fixed to
`0x0A06b2bDb8daf62fc828a792fc40B0B7538D1A5B`. Automated claims require the private key for that
exact address; without it, sweeping still works but fees remain claimable in escrow.

Example:

```bash
cp .env.example .env
# set LAUNCHER_PRIVATE_KEY and, only if you control the delegated treasury,
# CLAIMER_PRIVATE_KEY; keep DRY_RUN=true for the first simulation.
npm run bot -- preflight
npm run bot -- launch 0x35b8b49c9c4e7a5d08dc1ba0ea5eac0b9937bc83 rh-experiment-1
DRY_RUN=false npm run bot -- launch 0x35b8b49c9c4e7a5d08dc1ba0ea5eac0b9937bc83 rh-experiment-1
npm run bot -- watch rh-experiment-1 120
npm run bot -- harvest rh-experiment-1
npm run bot -- forward rh-experiment-1
```

## Normal mode: `quick <CA>`

Paste a CA, get a clone. `quick` launches live from the central launcher (set `DRY_RUN=true`
to only simulate), pins creator fees to the treasury, and prints the new token CA, explorer
link and tx:

```bash
npm run bot -- quick 0xSourceToken
npm run bot -- watch quick-<id>     # deterministic auto-sell of the pre-buy, then forward
```

## Test rounds: `discover` + `round`

```bash
npm run bot -- discover 5                          # top native-ETH pons curves by volume
DRY_RUN=false PRE_BUY_ETH=0.0005 npm run bot -- round 0xSourceToken round-1 300
```

`round` mints a fresh job wallet (key saved to `.pons-state/wallets.json`, mode 0600,
gitignored — never in `.env`), funds it from the launcher with launch fee + pre-buy + gas,
launch-and-buys, runs the exit engine, force-sells whatever is still held at `maxSeconds`,
and refunds the job wallet's ETH to the launcher. If a round crashes, `watch <jobId>` picks up
the same job wallet from the JSON book.

## Fee flow

```
curve creator tax ──sweepFees()──┐
                                 ├──> fee escrow ──claim()/claimToken()──> 0x0A06…1A5B
graduated pool fees ─sweepPoolFees()─┘
```

`buybackEnabled` is forced to `false` at launch: with buybacks on, a sweep that needs an
internal swap is refused for anyone but the pons operator, which would make harvesting depend
on them. Sweeping can be signed by the launcher; claiming cannot — the escrow credits per
address and pays `msg.sender`, so `CLAIMER_PRIVATE_KEY` must be the delegated wallet itself.
Without it the bot still sweeps, fees accumulate in the escrow, and they can be claimed by
hand at any time.

### Treasury forwarding (launcher dust + sale proceeds)

Claims stay manual, but the launcher's own ETH is forwarded automatically: after any tick of
`watch` that sold tokens, and on demand with `forward [jobId]`, everything above
`FORWARD_GAS_RESERVE_ETH` (default 0.0003, plus the transfer's own worst-case fee) is sent to
`TREASURY`. Forwards below `FORWARD_MIN_ETH` (default 0.0005) are skipped so dust is never
burned on gas. The transfer is a plain native send that the allowlist only accepts when the
destination is exactly the configured treasury with no calldata; it is journaled like every
other send and skipped in dry-run.

## Exit engine

Evaluated per tick in strict priority order (`src/core/exit.ts`), all thresholds configurable:

0. graduation lockout — full exit at 93% of the threshold, or the moment `readyToGraduate()`
   is true; sells revert after graduation, so this outranks every profit rule
1. stop loss at 0.65x
2. time stop — 10 minutes with no buy and under 1.3x
3. ladder — 40% of the original position at 2x, 30% at 3x
4. trailing stop — armed at a 2x peak, triggers on a 25% giveback
5. momentum gate — defers rungs (never the stops) while >0.15 ETH and ≥4 buyers flow in

Orders are split into tranches capped at 150 bps of price impact.

## Safety

- BigInt-only curve math mirroring the contract's integer settlement; no float ever touches a
  `minOut`.
- Destination + selector allowlist on every signed transaction, plus a per-job value cap
  (treasury forwards are the one exempt class, and only as calldata-free sends to `TREASURY`).
- `eth_call` simulation before every send; chain id asserted against the RPC.
- Post-launch verification that the factory records the delegated fee recipient — a mismatch
  quarantines the job.
- Crash-safe journal: intent is appended before the send, snapshots are written atomically.

## Development

```bash
npm run typecheck && npm run lint && npm test
```
