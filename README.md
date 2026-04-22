# PolkaCredit

On-chain credit scoring for the Polkadot ecosystem. Users stake stablecoin,
vouch for each other, vote on OpenGov referenda, and accrue a portable,
soulbound credit score (0–850) that any parachain protocol can read.

The repo is a monorepo:

- Solidity contracts that live on Polkadot Hub / Passet Hub (Polkadot's
  native EVM via `pallet-revive`).
- A TypeScript indexer that watches the `pallet-revive` EVM RPC for contract
  events and the Substrate WSS of the same chain for OpenGov votes.
- A Vite/React frontend built as a static bundle so it can be hosted on
  Bulletin Chain + DotNS.

## Stack and choices

Contracts are Solidity on Polkadot Hub (chain id `420420419`) and Passet Hub
(testnet, `420420417`). pallet-revive runs EVM bytecode through REVM and
exposes a PVM (PolkaVM / RISC-V) backend for perf-critical paths. I considered
ink! but EVM tooling was faster to get to a working MVP.

Identity is "every EVM address is a popId" for now. The `popId` is just
`bytes32(uint256(uint160(addr)))`. When a real PoP primitive lands on
Polkadot, this becomes a registry lookup — there's a single call site to
change.

Cross-chain linking is handled by pallet-revive itself: H160 ↔ AccountId32 is
stateless (0xEE-suffix padding), and the `map_account` extrinsic exists for
opt-in sr25519 links. The original `WalletRegistry` contract got dropped
because it was duplicating what the chain already does.

The external signal is OpenGov votes, observed via the same-chain Substrate
WSS. I probed the relays on 2026-04-20 — `convictionVoting` and `referenda`
are empty there. Both pallets live on the AssetHubs (1,886 referenda on
Polkadot Hub, 124 on Passet Hub). Hydration lending is out of scope for v1.

The frontend is plain React + ethers v6, built with Vite. Output is a static
bundle — target host is Bulletin Chain + DotNS.

## Deployed

| Component | Network                       | Chain ID   | URL |
|-----------|-------------------------------|------------|-----|
| Contracts | Passet Hub (Paseo AssetHub)   | 420420417  | See `contracts/deployments/420420417.json` after deploy |
| Contracts | Polkadot Hub (mainnet)        | 420420419  | See `contracts/deployments/420420419.json` after deploy |
| Frontend  | Bulletin Chain + DotNS        | —          | `(placeholder — add deploy URL here)` |

## Layout

```
contracts/   # Solidity + Hardhat
indexer/     # Node.js indexer (reads Polkadot Hub via EVM + Substrate RPC)
frontend/    # Vite + React dApp
```

## What's in each directory

### Contracts (`contracts/contracts/`)

- `lib/ScoreMath.sol` — canonical points → score curve. Shared by
  `ScoreRegistry.computeScore` and the dispute resolver.
- `MockStablecoin.sol` — permissionless-mint ERC-20 used as the staking
  asset during dev and testnet.
- `StakingVault.sol` — tiered stablecoin stake ($1k/$5k/$10k, 6-month lock).
  Entry gate to the system.
- `PointsLedger.sol` — soulbound points ledger. Only mints/burns/locks;
  writer role is held by `StakingVault`, `VouchRegistry`, and
  `OracleRegistry`. Exposes `historyAt` / `historyLength` /
  `sumHistoryUpTo` so disputes can reference past entries directly.
- `VouchRegistry.sol` — vouches commit a stake slice for 6 months.
  Deferred-credit: both sides are paid on success, voucher's stake is
  slashed on failure.
- `ScoreRegistry.sol` — optimistic score snapshot. The indexer calls
  `proposeScore` anchored to a `sourceBlockHeight`; after the challenge
  window, anyone calls `finalizeScore`. External readers hit
  `getScore(popId)` and only see finalized values.
- `DisputeResolver.sol` — bonded challenges against pending proposals.
  `WrongArithmetic` and `WrongTotalPointsSum` auto-resolve on-chain.
  `MissingEvent` / `InvalidEvent` route to governance, with an on-chain
  guard that `InvalidEvent`'s `historyIndex` points to a real ledger
  entry before the proposal's anchor.
- `OracleRegistry.sol` — M-of-N bonded oracle set. Every off-chain-observed
  mint and every score proposal flows through here as an ECDSA-signed
  payload; the raw indexer EOA has no direct writer role.

### Indexer (`indexer/src/`)

- `listeners/polkaCreditListener.ts` — pulls contract events via
  `pallet-revive` JSON-RPC, writes them to SQLite.
- `listeners/openGovListener.ts` — subscribes to the same chain's
  Substrate WSS and filters `convictionVoting.Voted`. Attribution
  reverses the 0xEE-padding rule to recover the H160. sr25519 voters
  who've linked via `map_account` aren't resolved yet (TODO).
- `calculators/pointsCalculator.ts` — pure function over events → point
  deltas. This is what third-party verifiers run.
- `calculators/scoreCalculator.ts` — points → 0–850 curve plus a
  deterministic computation hash. `ALGORITHM_VERSION_ID` is posted on
  every proposal so stale commitments are distinguishable.
- `jobs/pointsJob.ts` — converts OpenGov events into `mintPoints` calls.
- `jobs/scoreJob.ts` — reads `totalPoints` from the ledger, computes the
  canonical score, submits `proposeScore` anchored at head−1.
- `jobs/finalizationJob.ts` — calls `finalizeScore` on pending proposals
  whose challenge window has closed.
- `jobs/vouchResolutionJob.ts` — calls the permissionless `resolveVouch`
  once each vouch's window plus grace period has passed, so users never
  have to think about it.
- `api/server.ts` — REST surface for verifiers:
  `/api/v1/score/:popId/events` and
  `/api/v1/score/:popId/proposal/latest`. Run the calculator against
  those, file a dispute if you get a different answer.
- `scripts/verifyScore.ts` — independent verifier; recomputes a popId's
  score from the raw event log and compares against the chain.
- `scripts/indexAddressFromHydration.ts` — ad-hoc scorer for a live SS58
  address on Hydration. Useful to answer "what would this user's score
  be if PolkaCredit had existed?" — see the section below.
- `scripts/simulate.ts` / `simulateE2E.ts` / `chainParity.ts` — persona
  and parity simulations (see *Indexer simulations*).

### Frontend (`frontend/src/`)

- `App.tsx` — wallet connect + chain gate.
- `components/ScoreCard.tsx` — score card with the pending-proposal
  countdown and finalize button.
- `components/StakeCard.tsx` — stake/unstake flow with approval.
- `components/VouchCard.tsx` — open a vouch. Resolution is automatic.
- `components/PointsHistoryCard.tsx` — paginated ledger history.
- `components/FaucetCard.tsx` — one-click `mint()` on MockStablecoin
  (dev only).

## Running it

### Prerequisites

- Node.js 20+
- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`)
- An EVM wallet (Talisman, SubWallet, MetaMask) for the frontend
- For testnet deploys, a funded key on Passet Hub — grab PAS from the
  Paseo faucet.

### 1. Compile and test

```bash
cd contracts
forge build
forge test
```

### 2. Deploy the contracts

**Local zombienet (polkadot-stack-template, chain 420420421):**

```bash
cd contracts
./scripts/start-zombienet.sh            # terminal 1
./scripts/deploy-local.sh               # terminal 2
```

**Passet Hub (testnet):**

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=0x...
export INDEXER_ADDRESS=0x...            # optional; defaults to deployer
forge script script/Deploy.s.sol \
  --rpc-url passet_hub \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```

**Polkadot Hub (mainnet):**

```bash
cd contracts
forge script script/Deploy.s.sol \
  --rpc-url polkadot_hub \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast
```

The deploy script wires authorizations: `StakingVault` + `VouchRegistry` +
indexer are added to `PointsLedger.authorized`, `VouchRegistry` is set on
`StakingVault`, and `DisputeResolver` is wired into `ScoreRegistry`.

### 3. Run the indexer

```bash
cd indexer
cp .env.example .env
# Edit .env — at minimum:
#   EVM_RPC_URL, EVM_CHAIN_ID, DEPLOYMENT_FILE
#   INDEXER_PRIVATE_KEY (the one authorized in ScoreRegistry/PointsLedger)
#   ENABLE_OPENGOV=true to index AssetHub OpenGov votes via Substrate WSS
#   OPENGOV_WSS (defaults to Passet Hub; switch to polkadot-asset-hub-rpc
#                for mainnet)
npm install
npm run dev
```

The indexer boots a REST API on `http://127.0.0.1:4000` with:

- `GET /score/:popId` — on-chain score + local history
- `GET /balance/:popId` — live ledger balance
- `GET /events/:popId` — raw event log
- `GET /identity/:evmAddress` — popId lookup

### 4. Run the frontend

```bash
cd frontend
npm install
npm run dev
# → http://localhost:5173
```

The dev server reads `contracts/deployments/<chainId>.json` and the Foundry
ABIs from `contracts/out/`. Default target is **Passet Hub
(`VITE_CHAIN_ID=420420417`)**. Override for Polkadot Hub mainnet
(`VITE_CHAIN_ID=420420419`) or local zombienet (`VITE_CHAIN_ID=420420421`).

### 5. Production build of the frontend (for Bulletin Chain + DotNS)

```bash
cd frontend
VITE_CHAIN_ID=420420419 npm run build
# dist/ is a static bundle with deployments + ABI JSON copied alongside
```

Serve `dist/` from Bulletin Chain; point your DotNS name at it. Once the deploy
URL is live, add it to the "Deployed" table at the top of this README.

### 6. Score verification (reproducibility)

```bash
cd indexer
npx tsx src/scripts/verifyScore.ts <popId>
```

Re-runs the scoring algorithm from the raw event log and compares computed vs
on-chain score + computation hash.

## Happy path

1. Connect a wallet (injected, or WalletConnect QR from a mobile wallet) and
   switch to Passet Hub.
2. Hit the mUSD faucet card to mint 1000 mUSD.
3. Stake at a tier. `StakingVault` mints the tier's `stake_deposit` points
   into the ledger in the same tx (+40 / +70 / +100).
4. Optional: link a Polkadot (sr25519) wallet so your OpenGov votes from
   that key get attributed here.
5. Once your score clears `MIN_VOUCHER_SCORE` (80), you can vouch. `vouch()`
   escrows a committed stake slice and snapshots the vouchee's
   `totalPoints`. Nothing is minted to the vouchee yet.
6. After the 6-month window + a 10-block grace period, the indexer calls
   `resolveVouch(id)` — it's permissionless, so anyone can, but the
   indexer does it proactively. If the vouchee's `totalPoints` grew by at
   least `VOUCHEE_SUCCESS_THRESHOLD` (50), both sides get credited.
   Otherwise the committed stake is slashed to treasury. The frontend
   intentionally has no Resolve button.
7. The oracle submits `OracleRegistry.submitScore(...)` with an M-of-N
   ECDSA bundle. `OracleRegistry` verifies and forwards to
   `ScoreRegistry.proposeScore`, which captures
   `blockhash(sourceBlockHeight)` and opens the challenge window.
8. During the window, any watchtower running a parallel indexer can file a
   dispute. `WrongArithmetic` and `WrongTotalPointsSum` auto-resolve
   on-chain; `InvalidEvent` / `MissingEvent` route to governance (with an
   on-chain guard that `InvalidEvent` actually points to a real ledger
   entry before the anchor).
9. Window closes, someone calls `finalizeScore(account)`. Only then does
   `getScore(account)` return a non-zero value.

## What works today

- The full forge suite passes — 150 tests covering every contract plus a
  7-scenario `Simulation.t.sol` that walks stake → oracle-mint →
  oracle-propose → finalize → dispute → vouch success/failure end-to-end.
  Run with `cd contracts && forge test`.
- End-to-end flow on a local zombienet (`polkadot-stack-template`).
- Indexer mirrors every contract event into SQLite, including the full
  proposal lifecycle.
- OpenGov listener attributes AssetHub `convictionVoting.Voted` events
  back to an H160 popId via the 0xEE-padding rule.
- Score job reads the authoritative ledger sum and proposes scores
  anchored to `head − 1`.
- Finalization job auto-finalizes once the challenge window closes.
- Verifier HTTP API at `/api/v1/score/:popId/{events,proposal/latest}` —
  run the pure points calculator against those and file a dispute if the
  on-chain numbers don't match.
- Frontend: stake/unstake, open-vouch, score card with
  pending-proposal countdown, one-click finalize, 25-event history, dev
  faucet. Wallet connect covers injected providers and WalletConnect v2
  (Nova, mobile wallets) when `VITE_WALLETCONNECT_PROJECT_ID` is set.
- Oracle write layer: `OracleRegistry` is the sole writer on `PointsLedger`
  + `ScoreRegistry`. Bootstrap is N=1, threshold=1; scaling up is
  `register()` + `setThreshold()`, no redeploy.
- Deferred-credit vouch lifecycle: `vouch_received` is minted only on
  successful resolve, and there's a 10-block grace after `expiresAt`
  before `resolveVouch` is callable so the oracle can flush late mints.

## Known limitations

- Tier-point mismatch between SPEC §2.1 and §2.2:
  `StakingVault.tierPoints()` returns `40/70/100` (the `stake_deposit`
  bonuses), but `VouchRegistry.vouch()` uses the same function for vouch
  tier points — SPEC says vouch values should be `40/60/80`. Surfaced by
  `test/Simulation.t.sol::test_simulation_vouchConcurrencyAndCap`. Fix is
  a dedicated `vouchTierPoints()` helper. Left as a follow-up.
- No real PoP primitive yet. Any EVM address can stake. When a Polkadot
  PoP (DIM1/DIM2) ships, the address-is-identity assumption becomes a
  registry lookup.
- Native sr25519 OpenGov voters aren't attributed yet. The indexer only
  handles the 0xEE-padded case; voters who've linked via `map_account`
  need a pallet-storage lookup that isn't wired up.
- No Hydration integration — the `hydration_*` point categories are out
  of v1.
- Scores and point histories are public; no privacy.
- No XCM yet. Parachain consumers read via RPC.
- SQLite only. The schema in `src/db/schema.sql` is PostgreSQL-compatible,
  so production would swap drivers.
- The indexer is trusted but challengeable. `WrongArithmetic` /
  `WrongTotalPointsSum` resolve fully on-chain; `InvalidEvent` and
  `MissingEvent` still need a governance multisig. v2 (XCM state proofs)
  and v3 (ZK proof of chain scan) are out of scope.
- Verifiers have to run their own indexer. "At least one honest
  verifier" is the assumption; without it this is a trusted indexer with
  extra steps.

## Tree

```
polkacredit/
├── contracts/                 # forge + hardhat, all on-chain logic
│   ├── contracts/
│   │   ├── interfaces/        # external ABI surface
│   │   ├── lib/ScoreMath.sol  # canonical points → score curve
│   │   ├── DisputeResolver.sol
│   │   ├── MockStablecoin.sol
│   │   ├── OracleRegistry.sol
│   │   ├── PointsLedger.sol
│   │   ├── ScoreRegistry.sol
│   │   ├── StakingVault.sol
│   │   └── VouchRegistry.sol
│   ├── script/Deploy.s.sol
│   ├── scripts/deploy.ts      # hardhat-viem, also wires permissions
│   ├── test/                  # foundry suite (150 tests)
│   ├── foundry.toml
│   └── deployments/           # JSON deploy records, one per chain
├── indexer/
│   └── src/
│       ├── api/server.ts      # REST surface for verifiers
│       ├── calculators/       # pure point/score functions
│       ├── chain/             # RPC adapters
│       ├── db/                # sqlite schema + queries
│       ├── jobs/              # points/score/finalize/vouchResolution
│       ├── listeners/         # polkacredit + opengov
│       └── scripts/           # simulations + verifier
├── frontend/src/              # vite + react + ethers v6
└── scripts/                   # start-zombienet, deploy-local
```

## Scoring, short version

The canonical math lives in `SPEC.md` at the project root, and
`indexer/src/calculators/pointsCalculator.ts` is the executable copy. If
any of the three disagree, SPEC wins, the calculator is the source of
truth for code, and this section is just a summary.

### Point sources (all lifetime caps unless noted)

| Event                                                | Points                    | Cap                            |
|------------------------------------------------------|---------------------------|--------------------------------|
| First successful stake (6-month lock)                | +100                      | Once per popId                 |
| Vouch given, per vouch (by committed stake)          | +20 / +40 / +80           | +200 lifetime (truncated)      |
| Vouch received (front-loaded at open)                | +20 / +40 / +80           | 3 distinct vouchers → +240     |
| OpenGov vote (≥1× conviction, ≥5 DOT)                | +5                        | +50 (10 votes lifetime)        |
| Transfer volume band crossed ($1K/$10K/$100K/$1M)    | +10 / +20 / +30 / +40     | +100 lifetime                  |
| Loan repaid, per tier ($1K–$1M+)                     | +10 / +20 / +40 / +80 / +150 / +210 | +510 lifetime        |

### Penalties

| Event                                 | Effect                                                                                 |
|---------------------------------------|----------------------------------------------------------------------------------------|
| Failed vouch (vouchee under +50 in window) | Voucher −2× amount actually credited + stake slash; vouchee −1× front-load        |
| Self loan default                     | −100 flat + clawback of every active voucher's front-load to this popId                |
| Inactivity                            | After 90-day grace, **−5 pts/week, unbounded below** (no floor on points)              |

### Points → score

Piecewise-linear, clamped to `[0, 850]`:

| Points           | Slope    | Endpoints            |
|------------------|----------|----------------------|
| `[0, 100]`       | 1.0      | 0→0, 100→100         |
| `(100, 300]`     | 1.5      | 100→100, 300→400     |
| `(300, 700]`     | 0.75     | 300→400, 700→700     |
| `(700, 1200]`    | 0.3      | 700→700, 1200→850    |
| `(1200, ∞)`      | 0        | saturated at 850     |

Below 0 points, score clamps to 0. 1,200 pts exactly saturates at 850 — the
budget is designed so **only all categories combined** can reach 850 (loans
alone top out at ~633, pure social/governance/transfers at ~693).

### Budget breakdown

| Source                          | Lifetime max |
|---------------------------------|--------------|
| Staking                         | 100          |
| Vouching given                  | 200          |
| Vouching received               | 240          |
| Governance                      | 50           |
| Transfers                       | 100          |
| **Pure-participation subtotal** | **690**      |
| Loans                           | 510          |
| **Absolute max**                | **1,200**    |

### Known scoring gaps

- Tier-flag memory doesn't decay the way score does. SPEC §3.3's
  `−5 pts/week` inactivity penalty drags a long-dormant score to 0, but
  the "once per tier per popId" flags (loan tiers §2.6, first-stake §2.1,
  vouch uniqueness) are permanent. Someone who took a $1M loan a decade
  ago and went silent can't re-earn the loan-tier points by borrowing
  again today. Fix is a per-tier expiry that resets the claim bitmap
  after N years of inactivity — needs storage changes and an
  `ALGORITHM_VERSION_ID` bump, plus a product call on what N should be.
- Loan repeat-repayment decay. SPEC §6 already flags this — after N
  repayments in a tier, subsequent ones should award a decaying credit
  rather than zero. Out of scope for v1.
- Front-load visible to underwriting under the old model. The deferred-
  credit refactor (above) closed this by not minting to the vouchee at
  open, but the SPEC text still references the old model in places.

## Optimistic verification, end to end

Every score update goes through a block-anchored, bonded challenge
window:

1. **Propose.** The indexer calls
   `ScoreRegistry.proposeScore(account, score, totalPoints, eventCount, sourceBlockHeight, algorithmVersion)`.
   The contract captures `blockhash(sourceBlockHeight)` so the proposal is
   pinned to a specific chain state, then enters **Pending** for 7200 blocks
   (~24 h). Events that produced the score already live on-chain in
   `PointsLedger._history[account]` — no off-chain commitment is needed.
2. **Challenge window.** During those 24 hours anyone can:
   - Call `GET /api/v1/score/:popId/events` on the indexer to fetch the
     raw event log and re-run the points calculator locally.
   - Disagree and post a $10 mUSD bond via
     `DisputeResolver.dispute(account, claimType, evidence)`.
3. **Four claim types.** Two auto-resolve on-chain, two route to governance —
   see the dedicated **Dispute resolution** section below for the flow of each.
   - `WrongArithmetic` — `score` doesn't follow from `totalPoints`. On-chain.
   - `WrongTotalPointsSum` — `totalPoints` doesn't match the ledger sum. On-chain.
   - `InvalidEvent` — a ledger entry (by `historyIndex`) shouldn't have counted. Governance.
   - `MissingEvent` — an event that should have counted isn't reflected in the ledger. Governance.
4. **Resolution.** A winning disputer gets their bond back + $5 reward from
   the treasury. A losing dispute forfeits the bond. `resolveDispute` on
   `ScoreRegistry` either finalizes the original proposal or writes a
   corrected score directly.
5. **Finalize.** If no dispute lands, anyone calls `finalizeScore(account)`
   after the window. Only then does `getScore(account)` return a non-zero
   value — external protocols never read pending proposals.

Gas:

| Path                              | Cost (rough)        |
|-----------------------------------|---------------------|
| proposeScore                      | ~35k per account    |
| finalizeScore                     | ~25k                |
| dispute(WrongArith)               | ~60k (auto-resolves)|
| dispute(WrongTotalPointsSum)      | ~60k + O(history)   |
| dispute(Invalid) history-index guard | ~30k             |

Running your own verifier:

```bash
# Fetch the raw event log and re-run the points calculator locally
curl http://127.0.0.1:4000/api/v1/score/<popId>/events

# See the latest on-chain proposal for this account
curl http://127.0.0.1:4000/api/v1/score/<popId>/proposal/latest
```

The whole thing rests on at least one honest verifier being online. If
you care about the scores being correct, run one.

## Dispute resolution

Once `DisputeResolver.dispute(account, claimType, evidence)` is called
with the $10 bond, resolution branches by claim type. Two of the four
auto-resolve on-chain; the other two route to a governance address.
`WrongTotalPointsSum` was added as the second auto-resolver during the
Layer A refactor — that narrows governance's remit to strictly semantic
(off-chain-fact) disputes.

| Claim type             | Resolver   | Where                             | Needs trust? |
|------------------------|------------|-----------------------------------|--------------|
| `WrongArithmetic`      | Contract   | `dispute()` tx, inline auto-resolve | No         |
| `WrongTotalPointsSum`  | Contract   | `dispute()` tx, inline auto-resolve | No         |
| `InvalidEvent`         | Governance | `resolveDispute()` from `governance` | Yes       |
| `MissingEvent`         | Governance | `resolveDispute()` from `governance` | Yes       |

### Auto-resolving claims (no governance, no waiting)

**`WrongArithmetic`** — does the posted `score` follow from the posted
`totalPoints` via the canonical curve? Contract executes
`ScoreMath.computeScore(totalPoints)` and compares against
`proposal.score`. Mismatch → disputer wins, score corrected atomically.
Match → disputer loses, bond forfeited.

**`WrongTotalPointsSum`** — does the posted `totalPoints` match the on-chain
ledger's sum of deltas up to the anchored block? Contract calls
`PointsLedger.sumHistoryUpTo(account, sourceBlockHeight)` and compares to
`proposal.totalPoints`. Mismatch → disputer wins, score re-derived from
`ScoreMath.computeScore(actualSum)`. Match → disputer loses.

Both resolve inside the original `dispute()` transaction.
**Governance cannot override them** — an explicit guard in `resolveDispute()`
reverts with `AutoResolves` on either type. Governance only ever sees the
semantic claims (below).

A critical property (regression test C-1): a *losing* auto-resolve does
**not** early-finalize the proposal. The proposal stays `Pending` and the
remaining challenge window is preserved for other honest disputers.

### Governance-resolved claims

**`InvalidEvent`** — disputer claims a specific `PointsLedger._history[account]`
entry shouldn't have counted (wash trade, reverted tx, synthetic data). The
evidence is a `historyIndex` into that array. The contract verifies the
entry exists (`HistoryIndexOutOfBounds`) and wasn't added after the
proposal's anchor (`EventAfterSourceBlock`) — bogus indices never reach
governance. If the entry is real, the proposal is marked `Disputed` and
governance decides whether its content disqualifies the score.

**`MissingEvent`** — disputer claims an event that *should* have counted
isn't in the ledger. No on-chain primitive can prove something's absence
from a chain, so governance compares against the chain itself and
adjudicates.

Both wait for the governance address to call:

```solidity
resolveDispute(uint64 disputeId, bool disputerWins,
               uint64 correctedScore, int64 correctedPoints)
```

A single boolean + optional correction values. **No on-chain voting, no
ballot-box contract, no deliberation logic** — the `DisputeResolver` trusts
whatever address sits at `governance` to call this function.

### Governance is a single address

```solidity
address public governance;
```

The contract gives this one address sole authority over non-auto claims.
In practice that address is expected to be a multisig (Safe, Squads, or a
future OpenGov-delegated proxy). Off-chain coordination produces the
threshold-signed `resolveDispute` tx that lands on-chain.

The contract doesn't verify *how* the signer group reached the decision —
it trusts whoever is configured at `governance`. That's the v1 trust
wedge, and it's deliberate. `contracts/docs/trust-model.md` walks through
how v2 (bonded reporter oracle) and v3 (zk proof of chain scan) would
shrink it.

### Bond economics

| Event | Amount | Destination |
|---|---|---|
| Disputer posts bond (any claim type) | $10 mUSD | held in `reservedBonds` |
| Disputer wins | bond + $5 reward (up to $15) | disputer |
| Disputer loses | bond forfeited | treasury |
| Pool top-up | arbitrary | `fundReward(amount)`, anyone can call |

Concurrent winning disputes are isolated: `reservedBonds` tracks held-bond
obligations, so paying one winner never cannibalises another's bond (H-2
regression test). If the reward pool is dry, the winner still gets at least
their bond back — guaranteed.

### Events to index for a resolution dashboard

| Event | Meaning |
|---|---|
| `DisputeCreated(disputeId, account, proposalId, claimType, disputer)` | new dispute filed |
| `DisputeResolved(disputeId, disputerWon, account)` | any resolution path, fires on both auto-resolve and governance-resolve |
| `IndexerPenalized(proposalId, reason)` | indexer's proposal lost a dispute |
| `BondForfeited(disputeId, amount, to)` / `BondRefunded(disputeId, amount, to)` | economic outcome |
| `GovernanceSet(governance)` | membership change; should be rare, alert if frequent |

Correlating `DisputeCreated.claimType` with `DisputeResolved.disputerWon`
separates the trustless (auto-resolve) share from the trusted (governance)
share — useful for publishing "what fraction of disputes required human
judgment" as a governance accountability metric.

### The oracle write path (already deployed)

`OracleRegistry.sol` sits between the indexer and the authoritative state
contracts. Every off-chain-observed point delta and every score proposal
flows through it as an M-of-N ECDSA-signed payload — the raw indexer EOA
has no direct writer role on `PointsLedger` or `ScoreRegistry`.

Bootstrap: N=1, threshold=1, one registered oracle posting a 100 mUSD
bond. The design absorbs more oracles via `register()` + `setThreshold()`
without contract changes. v2 adds automated slashing on contradicting
attestations, cool-off on `deregister`, and a revenue-model stub. See
`contracts/docs/trust-model.md` for the full write-up.

### Upgrade path

`setGovernance(g)` is owner-gated with Ownable2Step, so the trust wedge
narrows without a redeploy. No custom governance primitive — we plug into
existing ones.

1. Today: a Safe / Squads multisig. M-of-N signers coordinate off-chain
   and the threshold-signed tx lands on-chain.
2. Next: a Polkadot OpenGov-delegated proxy. `resolveDispute` only
   succeeds when originated by a specific OpenGov track — token-weighted
   voting and conviction locking are then free. Needs pallet-revive
   support for OpenGov-origin calls, or a precompile / XCM bridge that
   exposes the track identity.
3. v2: a `ReporterRegistry` with N bonded reporters doing M-of-N
   attestations and fraud-proof slashing. Covers off-chain event
   attestation; OpenGov stays as the escape hatch.
4. v3: zk proofs of chain scans replace reporter attestations.

Every step is just a `setGovernance` call — `DisputeResolver` itself
never changes. It doesn't care whether the caller at `governance` is a
human multisig, an OpenGov-controlled proxy, a reporter contract, or a
zk-verifier gateway.

## Local dev environments

Two options, pick per task:

```bash
# anvil — fast, supports anvil_mine block cheats. Day-to-day contract work.
anvil --port 8546 --host 127.0.0.1 --block-time 1

# zombienet — real relay + parachain, ~6s blocks, no cheats. Use when
# testing something that depends on Substrate behavior end-to-end.
./scripts/start-zombienet.sh
```

Deploy:

```bash
# anvil
cd contracts && forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8546 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast

# zombienet
./scripts/deploy-local.sh
```

Contract tests (Foundry):

```bash
cd contracts
forge test                             # full suite
forge test --match-contract ScoreMath  # just the curve
forge build                            # compile
```

### Indexer simulations

```bash
cd indexer

# Pure-calculator simulation: 6 personas + 10 vulnerability probes
npx tsx src/scripts/simulate.ts

# On-chain vs off-chain parity for 35 sample points values
npx tsx src/scripts/chainParity.ts

# Full E2E: propose → mine past challenge window → finalize → getScore
npx tsx src/scripts/simulateE2E.ts
```

`simulateE2E.ts` defaults to anvil (`:8546`, `deployments/31337.json`).
Override for zombienet:

```bash
ETH_RPC_HTTP=http://127.0.0.1:8545 \
DEPLOYMENT_FILE=$(pwd)/../contracts/deployments/420420421.json \
npx tsx src/scripts/simulateE2E.ts
```

### Ad-hoc scoring from a live chain

`indexAddressFromHydration.ts` takes a live Polkadot/Hydration SS58 address,
scans the last N finalized blocks, and produces a score under the PolkaCredit
rules from whatever native events reference that address. Useful for sanity
checks and for bootstrapping what a user's score would look like if they'd
been participating before PolkaCredit existed.

```bash
cd indexer
npx tsx src/scripts/indexAddressFromHydration.ts \
  --address 12p8TxkyfmQBaSLooHA1NWRVjv7R8qgWfvKbVabEoH41L8jJ \
  --blocks 1000 \
  --concurrency 25
```

Translation (SPEC §2 → Hydration native events):

| Hydration event                              | Maps to                              |
|----------------------------------------------|--------------------------------------|
| `staking.StakeAdded` (first occurrence)      | `polkacredit.Staked` (one-time +100) |
| `convictionVoting.Voted` (Standard, ≥1×)     | `opengov.Voted`                      |
| `balances.Transfer` outgoing (cumulative USD)| `polkacredit.TransferVolumeThreshold`, emitted once per crossed band |

Caveats:

- Hydration has no deployment of PolkaCredit contracts, so staking /
  vouching / loan signals don't exist there — only stake, governance, and
  transfer volume are observable.
- The governance gate says "≥5 DOT" in SPEC §2.4; on Hydration we enforce
  `≥5 HDX` instead. Override with `OPENGOV_MIN=<n>`.
- HDX→USD price needs to be supplied via `HDX_USD=<float>` env (default
  `0.025`).
- Inactivity penalty (§3.3) is disabled — N blocks is well inside the
  90-day grace window.
- Output is written to `indexer/fixtures/<addr>-last<N>.json` with the
  full match log, synthetic event stream, cumulative outbound USD, and
  final points/score.

### Quick chain pokes

```bash
# chain id, block height, contract bytecode, storage read
curl -sX POST -H 'Content-Type: application/json' http://127.0.0.1:8546 \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# force-advance blocks (anvil only)
curl -sX POST -H 'Content-Type: application/json' http://127.0.0.1:8546 \
  --data '{"jsonrpc":"2.0","method":"anvil_mine","params":["0x1C25"],"id":1}'
```

### Shutting things down

```bash
# foreground scripts — Ctrl+C
# background:
pkill -f "zombienet|polkadot-omni|eth-rpc|anvil"
```

## License

MIT.
