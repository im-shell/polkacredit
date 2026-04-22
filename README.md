# PolkaCredit

On-chain credit scoring for the Polkadot ecosystem. Users stake stablecoin,
vouch for each other, vote on OpenGov referenda, and accrue a portable, soulbound
credit score (0-850) that any parachain protocol can read.

This repository holds the MVP:

- **Solidity contracts** deployed to **Polkadot Hub** / **Passet Hub**
  (Polkadot's native EVM via `pallet-revive`).
- A **TypeScript indexer** that watches both the `pallet-revive` EVM RPC
  (for contract events) and the Substrate WSS of the same chain (for
  OpenGov `convictionVoting` events).
- A **React/Vite frontend** (static build) targeting **Bulletin Chain + DotNS**
  on Paseo.

## Path picked

- **Backend:** Solidity on Polkadot Hub (mainnet chain ID **420420419**) and
  Passet Hub (testnet chain ID **420420417**). Contracts run on
  `pallet-revive`'s dual-VM stack — REVM for unmodified EVM bytecode, PVM
  (PolkaVM / RISC-V) available for performance-critical paths. ink! was the
  alternative; EVM wins on tooling speed for an MVP.
- **Identity:** every EVM address is treated as PoP-verified for now. The
  `popId` is derived inline as `bytes32(uint256(uint160(addr)))`. When a real
  Polkadot PoP primitive ships, swap in a registry-backed lookup — the only
  change needed is inside `contracts/lib/PopId.sol`.
- **Cross-chain identity linking:** handled natively by `pallet-revive`. H160
  addresses map deterministically to 32-byte AccountId32 via 0xEE-suffix
  padding (stateless), and opt-in sr25519↔H160 links use the chain's own
  `map_account` extrinsic. No bespoke `WalletRegistry` contract needed —
  that's why we removed it.
- **External signal:** OpenGov votes on Polkadot Hub (same chain as the
  contracts). Verified 2026-04-20 via RPC probe: `convictionVoting` +
  `referenda` are empty on the Polkadot/Paseo relays (count = 0), and active
  on Polkadot Hub (1,886 referenda) / Passet Hub (124). Hydration lending
  scoped out of v1.
- **Frontend:** React + ethers v6, deployed as a static bundle. Target hosting
  is Bulletin Chain + DotNS on Paseo.

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

## Components at a glance

**Contracts** (`contracts/contracts/`)

- `lib/PopId.sol` — derives `popId` from an EVM address.
- `lib/ScoreMath.sol` — canonical points → score mapping; shared by
  `ScoreRegistry.computeScore` and `DisputeResolver.verifyWrongArithmetic`.
- `MockStablecoin.sol` — permissionless-mint ERC-20 used as the staking asset.
- `StakingVault.sol` — $50-min 6-month stablecoin stake; entry gate.
- `PointsLedger.sol` — soulbound points (mint/burn/lock only); authorized
  callers are `StakingVault`, `VouchRegistry`, and the indexer signer.
  Exposes `historyAt` / `historyLength` / `sumHistoryUpTo` so disputes can
  reference any past ledger entry directly.
- `VouchRegistry.sol` — vouches lock 20 points for 6 months; payout or burn
  on resolve.
- `ScoreRegistry.sol` — **optimistic**: the indexer `proposeScore` anchored
  to a specific `sourceBlockHeight`; after a 24-hour challenge window anyone
  calls `finalizeScore` to publish. External readers call `getScore(popId)`,
  which returns only finalized values.
- `DisputeResolver.sol` — accepts bonded challenges against pending
  proposals. `WrongArithmetic` and `WrongTotalPointsSum` auto-resolve
  on-chain (canonical `computeScore` + `PointsLedger.sumHistoryUpTo`).
  `MissingEvent` / `InvalidEvent` claims go to a governance multisig;
  `InvalidEvent` evidence is a `historyIndex` into the ledger, and the
  contract verifies the entry exists at or before the proposal's anchor so
  governance only ever adjudicates real ledger state.

**Indexer** (`indexer/src/`)

- `listeners/polkaCreditListener.ts` — pulls Polkadot Hub / Passet Hub EVM
  logs via `pallet-revive` JSON-RPC (incl. `ScoreProposed` / `ScoreFinalized`
  / `ScoreDisputed` / `ProposalRejected`), mirrors into SQLite.
- `listeners/openGovListener.ts` — subscribes to the *same chain's* Substrate
  WSS (AssetHub, not the relay), filters `convictionVoting.Voted`.
  Attribution: reverses the `pallet-revive` 0xEE-padding rule to turn the
  voter's AccountId32 back into its H160 popId. Native sr25519 voters need
  `map_account` resolution — TODO follow-up.
- `calculators/pointsCalculator.ts` — pure function; given events, returns point
  deltas. This is the algorithm third parties re-run to verify scores.
- `calculators/scoreCalculator.ts` — points → 0-850 mapping + deterministic
  computation hash. `ALGORITHM_VERSION_ID` is posted on-chain with each
  proposal so stale commitments are distinguishable.
- `jobs/pointsJob.ts` — turns OpenGov events into on-chain `mintPoints`.
- `jobs/scoreJob.ts` — reads the authoritative `totalPoints` from
  `PointsLedger`, computes the canonical score, and submits `proposeScore`
  anchored at the latest block. Records the `proposalId` parsed from the
  emitted event.
- `jobs/finalizationJob.ts` — walks pending proposals and calls
  `finalizeScore` once the 24-hour window has closed.
- `api/server.ts` — adds `/api/v1/score/:popId/events` (raw event log for
  verifier re-computation) and `/api/v1/score/:popId/proposal/latest`. A
  verifier re-runs the points calculator against these and files a dispute
  if the on-chain proposal diverges — no Merkle proofs needed, because
  disputes reference `PointsLedger` entries directly.
- `scripts/verifyScore.ts` — independent verifier that re-computes a popId's
  score from the raw event log.
- `scripts/indexAddressFromHydration.ts` — ad-hoc scorer. Scans the last N
  finalized blocks on Hydration for any event referencing a given SS58
  address, translates `staking.StakeAdded` / `convictionVoting.Voted` /
  `balances.Transfer` into the synthetic event shape the calculator expects,
  then prints the resulting points/score and dumps the full match log to
  `indexer/fixtures/<addr>-last<N>.json`. Useful for "does this address have
  any realistic starting signal?" before wiring a full identity flow. See
  the *Ad-hoc scoring from a live chain* section below.
- `scripts/simulate.ts` / `simulateE2E.ts` / `chainParity.ts` — persona &
  parity simulations (see *Indexer simulations* below).

**Frontend** (`frontend/src/`)

- `App.tsx` — wallet connect + network gating.
- `components/ScoreCard.tsx` — on-chain score, projected score, points.
- `components/StakeCard.tsx` — stake/unstake flow w/ allowance handling.
- `components/VouchCard.tsx` — create or resolve a vouch.
- `components/PointsHistoryCard.tsx` — paginated event log from `PointsLedger`.
- `components/FaucetCard.tsx` — one-click `mint()` on MockStablecoin for dev.

## Running end-to-end

### 0. Prerequisites

- Node.js 20+
- [Foundry](https://book.getfoundry.sh/) (`forge` / `cast`)
- Optional: MetaMask (for the frontend)
- For testnet deploys: a funded key on **Passet Hub**. Get PAS test tokens
  from the Paseo / Polkadot Hub faucet.

### 1. Install & compile

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

## End-to-end happy path

1. Open the dApp, connect a wallet (injected or WalletConnect QR), switch to Passet Hub.
2. **mUSD faucet** → mint 1000 mUSD.
3. **Stake** → stake at a tier ($1k / $5k / $10k). `StakingVault` directly mints the tier's `stake_deposit` points to `PointsLedger` in the same transaction (+40 / +70 / +100 per SPEC §2.1).
4. (Optional) **Link Polkadot wallet** → register your Paseo SS58 address. OpenGov votes from that key are observed off-chain by the oracle, signed, and written via `OracleRegistry.submitMint` as `opengov_vote` deltas.
5. Once your score ≥ MIN_VOUCHER_SCORE (80), **Vouch** for another address. `VouchRegistry.vouch()` escrows your committed tier stake and **snapshots the vouchee's totalPoints**. No immediate point mint to the vouchee — reward is deferred to successful resolution (SPEC §2.3 deferred-credit model).
6. After the 6-month window + 10-block grace, the **indexer auto-calls** `resolveVouch(id)` (permissionless on-chain function; anyone *can* call it, but the `vouchResolutionJob` does it proactively so users never have to think about it). Contract reads the vouchee's current `totalPoints`; if it grew by ≥ `VOUCHEE_SUCCESS_THRESHOLD` (50) since the snapshot, both voucher and vouchee are credited (tier amount, truncated at the voucher's 200-pt lifetime cap). Otherwise the committed stake is slashed to treasury. The frontend does NOT expose a "Resolve" button — the entire lifecycle is automatic once the user clicks Vouch.
7. The oracle calls `OracleRegistry.submitScore(account, score, points, eventCount, sourceBlockHeight, …)` with an M-of-N ECDSA signature bundle. `OracleRegistry` verifies and forwards to `ScoreRegistry.proposeScore`, which captures `blockhash(sourceBlockHeight)` (Layer A block-anchor) and opens the challenge window. Events that produced the score already live on-chain in `PointsLedger._history`; disputes reference those entries directly instead of re-committing them off-chain.
8. The dApp shows the proposal with a "challenge window: N blocks left" countdown. Any watchtower running a parallel indexer can dispute:
   - `WrongArithmetic` and `WrongTotalPointsSum` **auto-resolve on-chain** in the same tx — no governance needed.
   - `InvalidEvent` / `MissingEvent` route to governance. `InvalidEvent` takes a `historyIndex` into `PointsLedger._history[account]`; the contract verifies the entry exists and was visible at the proposal's anchor before accepting the bond, so governance never sees claims that don't map to real ledger state.
9. After the window closes with no dispute, anyone calls `finalizeScore(account)`. Only now does `getScore(account)` return a non-zero value — external protocols consume that.

## What works

- **Full forge suite: 150 tests passing** (`cd contracts && forge test`). Covers the contract topology (StakingVault, VouchRegistry, PointsLedger, ScoreRegistry, DisputeResolver, OracleRegistry), the Layer A block-anchor pattern + `WrongTotalPointsSum` auto-resolve, the deferred-credit vouch lifecycle with a 10-block grace period, the M-of-N oracle signature verification + replay guard, and a 7-scenario narrative `Simulation.t.sol` that walks through stake → oracle-signed mint → oracle-signed propose → finalize → dispute auto-resolve → vouch success/failure end-to-end.
- End-to-end stake → vouch → resolve → **propose → finalize → read** flow on
  a local zombienet (polkadot-stack-template).
- Indexer mirrors all PolkaCredit events (including the optimistic lifecycle
  events) into SQLite.
- OpenGov listener subscribes to AssetHub's Substrate WSS, filters
  `convictionVoting.Voted`, and attributes each vote back to an EVM popId by
  reversing `pallet-revive`'s 0xEE-padded H160→AccountId32 mapping.
- Score job reads the authoritative ledger sum and proposes scores anchored
  to a specific `sourceBlockHeight`.
- Finalization job auto-calls `finalizeScore` once each pending proposal's
  challenge window closes.
- Verifier HTTP API (`/api/v1/score/:popId/{events,proposal/latest}`) serves
  the raw event stream and the latest proposal so a third party can re-run
  the points calculator and file a dispute if the on-chain numbers don't
  match. Dispute evidence (`InvalidEvent`) references a `PointsLedger`
  entry by `historyIndex` — no off-chain inclusion proof required.
- Points calculator is a pure function; the verifier script re-runs it against
  stored events to confirm on-chain scores.
- Frontend: stake/unstake, vouch (create only — resolve is indexer-automated), live score card with pending-proposal countdown + one-click finalize, 25-event history, dev faucet. Wallet connect supports injected providers (Talisman / SubWallet / MetaMask) AND WalletConnect v2 QR-code (Nova, mobile wallets) via `VITE_WALLETCONNECT_PROJECT_ID`.
- **Oracle write layer (`OracleRegistry.sol`)** — off-chain observed mints (gov votes, transfer bands, loan bands, inactivity) and score proposals flow through an M-of-N bonded oracle contract. v1 ships with N=1 / threshold=1. Every payload is signed (domain-separated, nonce-bumped) and verified on-chain before forwarding to `PointsLedger` / `ScoreRegistry`. More operators join via `register()` + owner's `setThreshold()` — no contract redeploy.
- **Deferred-credit vouch lifecycle (SPEC §2.3 refinement)** — `vouch_received` is minted only on successful resolve, never at vouch-open. Closes the auto-success exploit structurally and simplifies dispute semantics. A 10-block grace period after `expiresAt` before `resolveVouch` is callable, giving the oracle time to flush late-window activity mints.

## What doesn't (known limitations)

- **SPEC §2.1 vs §2.2 tier-point mismatch.** `StakingVault.tierPoints()` returns `40/70/100` (the `stake_deposit` bonuses per SPEC §2.1), but `VouchRegistry.vouch()` uses the same function for **vouch** tier points — SPEC §2.2 specifies `40/60/80` for vouching. The code currently credits `40/70/100` on both sides of a successful vouch. Surfaced by `test/Simulation.t.sol::test_simulation_vouchConcurrencyAndCap` — fix is a dedicated `vouchTierPoints()` helper on StakingVault. Flagged as a follow-up.
- **No real PoP primitive.** Any EVM address can stake. When the Polkadot PoP DIM1/DIM2 primitive ships, swap the address-is-identity assumption for a registry lookup.
- **Native-sr25519 OpenGov voters aren't attributed yet.** The indexer
  currently attributes OpenGov votes only from the 0xEE-padded AccountId32
  corresponding to an EVM popId. Users who vote from a separate sr25519 key
  and have linked it via `pallet-revive`'s `map_account` extrinsic aren't
  resolved yet — that pallet-storage lookup is a follow-up.
- **No Hydration integration.** `hydration_*` point categories are gone from
  v1.
- **No score privacy.** Scores and point histories are public.
- **No XCM.** Score consumers on other parachains read via RPC, not XCM.
- **SQLite only.** The indexer uses SQLite for zero-setup local dev; for
  production, replace with Postgres — the schema in `src/db/schema.sql` is
  PostgreSQL-compatible.
- **Indexer is trusted, but now *challengeable*.** v1 is optimistic: the
  indexer anchors each proposal to a `sourceBlockHeight`, and any verifier
  can challenge during the 24-hour window. `WrongArithmetic` and
  `WrongTotalPointsSum` resolve fully on-chain against the canonical curve
  and `PointsLedger.sumHistoryUpTo`; `MissingEvent` / `InvalidEvent` still
  go through a governance multisig (the contract rejects `InvalidEvent`
  claims that don't resolve to a real ledger entry inside the anchor
  window). Fully-automated v2 resolution via XCM state proofs, and v3 via
  ZK proof of computation, are out of scope.
- **Verifiers need to run their own indexer.** The security argument is "at
  least one honest verifier monitors proposals." Without that, the optimistic
  model is a trusted indexer with extra steps.

## Project structure

```
polkacredit/
├── README.md
├── contracts/
│   ├── contracts/
│   │   ├── lib/
│   │   │   ├── PopId.sol
│   │   │   └── ScoreMath.sol
│   │   ├── interfaces/
│   │   │   ├── IPointsLedger.sol
│   │   │   ├── IScoreRegistry.sol
│   │   │   └── IStakingVault.sol
│   │   ├── MockStablecoin.sol
│   │   ├── PointsLedger.sol
│   │   ├── ScoreRegistry.sol
│   │   ├── DisputeResolver.sol
│   │   ├── StakingVault.sol
│   │   └── VouchRegistry.sol
│   ├── script/Deploy.s.sol
│   ├── test/{Base.t.sol,ScoreRegistry.t.sol,VouchRegistry.t.sol,...}
│   ├── foundry.toml
│   └── deployments/            # <- produced by `forge script … --broadcast`
├── indexer/
│   ├── src/
│   │   ├── api/server.ts                       # REST verifier API
│   │   ├── calculators/{pointsCalculator,scoreCalculator}.ts
│   │   ├── chain/{abi,evm,polkadot}.ts
│   │   ├── db/{index.ts,schema.sql,migrate.ts}
│   │   ├── jobs/{pointsJob,scoreJob,finalizationJob}.ts
│   │   ├── listeners/{polkaCreditListener,openGovListener}.ts
│   │   ├── resolvers/identityResolver.ts
│   │   ├── scripts/verifyScore.ts
│   │   ├── util/log.ts
│   │   ├── writers/chainWriter.ts
│   │   ├── config.ts
│   │   └── index.ts
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── App.tsx
    │   ├── main.tsx
    │   ├── styles.css
    │   ├── vite-env.d.ts
    │   ├── lib/{contracts,wallet,popId}.ts
    │   └── components/{Connect,ScoreCard,StakeCard,VouchCard,PointsHistoryCard,FaucetCard}.tsx
    ├── index.html
    ├── vite.config.ts
    └── tsconfig.json
```

## Scoring algorithm (summary)

Canonical math lives in **`SPEC.md`** at project root. This is the short
version — if the two disagree, SPEC wins, and `calculators/pointsCalculator.ts`
is the executable copy.

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

### Known scoring gaps / open items

- **Tier-flag memory doesn't decay, even though score does.** SPEC §3.3's
  `−5 pts/week` inactivity penalty correctly drags a long-dormant user's
  score to 0, but the "once per tier per popId" flags for loan tiers
  (§2.6), the first-stake grant (§2.1), and vouch uniqueness are all
  **permanent**. A user who took a $1M loan ten years ago and went silent
  currently: (a) has their score correctly decayed to 0 by inactivity; but
  (b) cannot re-earn the loan-tier points by taking a fresh $1M loan
  today, because the ledger still remembers the historic claim. This
  means returning-from-dormancy users are permanently capped below where
  an equivalent fresh user would sit. **Fix (deferred — non-trivial):**
  introduce a per-tier expiry (e.g., after 2 years of inactivity, reset
  the tier-claim bitmap for `loan_band`, `transfer_band`, and
  `vouch_received`). Requires storage changes in `PointsLedger` and a
  corresponding `ALGORITHM_VERSION_ID` bump; picking an expiry that
  doesn't punish legitimate long-term holders needs product input.
- **Loan repeat-repayment decay.** SPEC §6 already flags this: once a
  borrower has repaid N distinct loans in a tier, award a decaying credit
  for subsequent loans rather than zero. Out of scope for v1.
- **Contract drift.** `StakingVault.sol` still has `STAKE_VAL = $50` /
  `STAKE_DEPOSIT_POINTS = 10` (SPEC §6, last bullet). Must be reconciled
  to +100 / governance-set stake before mainnet.
- **Front-load visible to underwriting.** Vouchee-side points are
  front-loaded at vouch-open, so they're visible to loan underwriters
  during the open-vouch window. Mitigated by §3.1 clawbacks rather than
  by gating.

## Optimistic verification

Every score update goes through a block-anchored, bonded challenge window:

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

The at-least-one-honest-verifier assumption is what makes the system
trustworthy. Run one.

## Dispute resolution

Once `DisputeResolver.dispute(account, claimType, evidence)` is called with
the $10 bond, resolution branches by claim type. Two of the four auto-resolve
on-chain with no human involvement; the other two route to a governance
address. Layer A added `WrongTotalPointsSum` as the second auto-resolving
type, narrowing governance's scope to strictly semantic (off-chain-fact)
disputes.

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

### Governance is a single address (intended to be a multisig)

```solidity
address public governance;
```

The contract gives this one address sole authority on non-auto claims. The
assumption — and the operational requirement — is that this address is a
multisig (Safe, Squads, or a future OpenGov-delegated contract).
Off-chain coordination (M-of-N signatures) produces the single successful
`resolveDispute` tx that lands on-chain.

The contract doesn't verify *how* the multisig reached the decision. It
trusts the address. That's the v1 trust wedge and it's deliberate — full
discussion + v2 (bonded reporter oracle) and v3 (zk proof of chain scan)
upgrade paths are in [`contracts/docs/trust-model.md`](contracts/docs/trust-model.md).

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

The `governance` address is mutable via `setGovernance(g)` (owner-gated,
Ownable2Step two-step handover). So the trust wedge can be narrowed without
redeploying the contract. **We deliberately do not build our own governance
primitive — we plug into existing ones.**

1. **Today.** `governance = Safe / Squads multisig`. M-of-N signers
   coordinate off-chain; the threshold-signed tx lands on-chain. Cheap,
   immediate.
2. **Next — Polkadot OpenGov.** `governance = OpenGov-delegated proxy
   contract` whose `resolveDispute` calls only succeed when originated by a
   specific OpenGov track (e.g., a dedicated Passet Hub referendum track
   for PolkaCredit dispute resolution). Token-weighted voting + conviction
   locking out of the box, zero bespoke governance code. This is the
   natural endgame for Passet Hub — we reuse Polkadot's governance
   machinery rather than rebuild it. Requires pallet-revive support for
   OpenGov-origin calls or a precompile/XCM bridge that exposes the track's
   caller identity to the contract.
3. **v2.** Replace with a `ReporterRegistry` contract: N bonded reporters,
   M-of-N attestations, slashing via fraud proofs. Covers off-chain event
   attestation for transfers / loans. OpenGov retained as escape hatch.
4. **v3.** Replace reporter attestations with zk proofs of chain scans.
   Cryptographic completeness, no trust remaining.

Each step is a `setGovernance` call plus an off-chain deployment — the
`DisputeResolver` contract never needs to change. It doesn't care whether
the caller at `governance` is a human multisig, an OpenGov-controlled
proxy, a reporter-set contract, or a zk-verifier gateway. The address just
has to be trusted (or itself trust-minimised) by whatever standard the
deployment targets.

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

### Indexer simulations (the coherence proofs)

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
