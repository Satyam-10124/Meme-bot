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
with ~0.002 ETH.

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
- Destination + selector allowlist on every signed transaction, plus a per-job value cap.
- `eth_call` simulation before every send; chain id asserted against the RPC.
- Post-launch verification that the factory records the delegated fee recipient — a mismatch
  quarantines the job.
- Crash-safe journal: intent is appended before the send, snapshots are written atomically.

## Development

```bash
npm run typecheck && npm run lint && npm test
```
