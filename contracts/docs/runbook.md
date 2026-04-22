# PolkaCredit — Runbook

How to stand up a fresh PolkaCredit environment: contracts on Paseo / Passet Hub, indexer connected, frontend reading live data. Prerequisites and failure modes flagged.

## Prerequisites

- Node ≥ 22 < 23 (`nvm install 22 && nvm use 22`).
- Foundry (`curl -L https://foundry.paradigm.xyz | bash && foundryup`).
- A funded Paseo testnet account. Faucet: [paseo.subscan.io](https://paseo.subscan.io/) or [faucet.polkadot.io](https://faucet.polkadot.io/) — request PAS tokens.
- The Ethereum private key for that account (32-byte hex secp256k1). Paseo AssetHub uses H160 addresses via pallet-revive; export the Ethereum format from Talisman / SubWallet, not the SS58 Substrate format.

```bash
git clone <this repo> polkacredit && cd polkacredit
```

## 1. Contracts — build + deploy

```bash
cd contracts
npm install
forge build
forge test                    # 133 tests green — sanity check the code
```

Set the deploy key as a Hardhat var (preferred — stored outside the repo in `~/.config/hardhat-nodejs/vars.json`):

```bash
npx hardhat vars set PRIVATE_KEY    # paste the 32-byte hex, no 0x prefix needed
```

Optional env overrides — defaults work for vanilla Paseo:

```bash
export INDEXER_ADDRESS=<address that will run the indexer>   # defaults to deployer
export TREASURY_ADDRESS=<address to receive slashes/forfeits>  # defaults to deployer
export PASSET_HUB_RPC_URL=https://eth-rpc-testnet.polkadot.io/ # default
```

Deploy:

```bash
npx hardhat run scripts/deploy.ts --network passetHub
```

What this does:
- Deploys `MockStablecoin`, `PointsLedger`, `StakingVault`, `VouchRegistry`, `ScoreRegistry`, `DisputeResolver`.
- Wires all 6 permission calls (`setAuthorized`, `setVouchRegistry`, `setDefaultReporter`, `setDisputeResolver`).
- Writes addresses to `contracts/deployments/<chainId>.json` (chainId = 420420417 for Passet Hub).
- Serial-submits (one tx at a time, waits for receipt) because pallet-revive rejects rapid same-sender submissions.

Expected output:

```
Network      : passetHub (chainId 420420417)
Deployer     : 0x...
MockStablecoin   : 0x...
PointsLedger     : 0x...
StakingVault     : 0x...
VouchRegistry    : 0x...
ScoreRegistry    : 0x...
DisputeResolver  : 0x...
Wiring permissions...
  ledger.setAuthorized(vault) ✓
  ...
Wrote contracts/deployments/420420417.json
```

Runtime: ~2 minutes (6 deploys + 6 wire calls at ~12s/block).

### Optional: fund the dispute reward pool

The bond-plus-reward math needs the DisputeResolver contract to have some stablecoin. Mint and send:

```bash
npx hardhat console --network passetHub
# (inside the console)
const d = require("./deployments/420420417.json")
const [w] = await hre.viem.getWalletClients()
const stable = await hre.viem.getContractAt("MockStablecoin", d.contracts.MockStablecoin, { client: { wallet: w } })
await stable.write.mint([w.account.address, 1000n * 10n**18n])
await stable.write.transfer([d.contracts.DisputeResolver, 500n * 10n**18n])
```

$500 at 18 decimals funds ~33 winning disputes. Top up later via `fundReward(amount)` after `approve`.

### Failure modes

- **"insufficient funds"** — faucet first.
- **"nonce too low"** — you have queued txs; wait or raise RPC nonce.
- **"Priority is too low"** — pallet-revive specific. The deploy script already serial-submits to avoid this. If you see it anyway, likely the indexer or another client is also sending from the same account.
- **Contract size errors on StakingVault/DisputeResolver** — pallet-revive has tighter bytecode limits than mainnet EVM. The current contracts fit. If you add significant code, verify with `forge build --sizes`.

## 2. Indexer — connect + run

```bash
cd ../indexer
npm install
npm run build
npm run migrate        # initializes the SQLite database schema
```

Create `.env` pointing at Passet Hub:

```bash
cat > .env <<EOF
DEPLOYMENT_FILE=../contracts/deployments/420420417.json
EVM_RPC_URL=https://eth-rpc-testnet.polkadot.io/
EVM_CHAIN_ID=420420417

# Private key for the indexer identity (must match INDEXER_ADDRESS used at deploy).
# This account needs PAS tokens to submit proposeScore / mintPoints transactions.
INDEXER_PRIVATE_KEY=<0x...>

# OpenGov listener — optional, disable until the score job has something to anchor.
ENABLE_OPENGOV=false
OPENGOV_WSS=wss://asset-hub-paseo-rpc.n.dwellir.com

# Polling cadences — lower than defaults for testnet demos.
BLOCK_POLL_INTERVAL_MS=12000
SCORE_JOB_INTERVAL_MS=600000       # 10 min instead of 6h for demo
FINALIZATION_JOB_INTERVAL_MS=120000 # 2 min instead of 15 min

API_PORT=4000
EOF
```

Run:

```bash
npm run dev    # tsx watch — reloads on source changes
# or for a single session:
npm start
```

Expected log lines:

```
[info] indexer starting at block N
[info] polling ...
[info] ScoreJob: 0 identities need proposal   # empty until someone stakes/vouches
[info] API listening on :4000
```

Separately, the API is read-only for the frontend to query. Test it:

```bash
curl http://localhost:4000/api/score/0xYourAddr
# => { score: 0, updatedAt: 0, pendingProposal: null }
```

### Failure modes

- **"Deployment file not found"** — the path in `DEPLOYMENT_FILE` is relative to the indexer directory. Use `../contracts/deployments/420420417.json`.
- **ABI loading errors** — the indexer loads ABIs from `contracts/out/<Name>.sol/<Name>.json`. Run `forge build` in `contracts/` first.
- **"nonce too low" on submission** — restart the indexer; it re-syncs nonce from chain.
- **"Priority is too low"** — if the indexer and frontend share the same key, they compete. Use separate keys.

## 3. Frontend — start

```bash
cd ../frontend
npm install
npm run dev      # Vite on :5173
```

The Vite config exposes `contracts/deployments/` and `contracts/out/` at dev time, so the frontend reads ABIs and addresses from the sibling directory with no manual copy step.

Environment overrides (`.env.local` in `frontend/`):

```bash
VITE_CHAIN_ID=420420417   # default: 420420417 (Passet Hub)
VITE_API_URL=http://localhost:4000   # default
VITE_RPC_URL=https://eth-rpc-testnet.polkadot.io/
```

Visit `http://localhost:5173`. V1 is read-only — shows score, pending proposals, history. Writes (stake, vouch, dispute) happen via direct RPC — for now:

- Stake: call `StakingVault.stake(1000e18)` with Talisman/SubWallet.
- Vouch: call `VouchRegistry.vouch(address,1000e18)`.
- Dispute: call `DisputeResolver.dispute(address, claimType, evidenceStruct)`.

You can also use Remix/Hardhat console against the deployed addresses.

## 4. End-to-end smoke test (manual, ~5 min)

With all three services running:

1. From your deployer wallet, approve the vault and stake:
   ```
   MockStablecoin.approve(stakingVault, 1000e18)
   StakingVault.stake(1000e18)          # mints 40 points to self
   ```
2. Wait for the indexer's score job (≤ 10 min with the demo cadence). It reads PointsLedger, computes totalPoints=40, score=40, submits `proposeScore` anchored at the current block.
3. Refresh the frontend → pending proposal visible with `score=40`, `sourceBlockHash` displayed.
4. Wait the `CHALLENGE_WINDOW` (7200 blocks ≈ 12–24h depending on block time). Or dispute it yourself:
   ```
   MockStablecoin.approve(disputeResolver, 10e18)    # bond
   DisputeResolver.dispute(deployerAddr, 0, emptyEvidence)   # 0 = MissingEvent
   # ...wait for governance to resolve, OR try ClaimType 2 (WrongArithmetic) for auto-resolve
   ```
5. After the challenge window, anyone can call `ScoreRegistry.finalizeScore(deployerAddr)` — score becomes live.

## 5. Operational tips

- **Run the API separately from the listener** in production: `INDEXER_MODE=api npm start` vs `INDEXER_MODE=listener npm start` (split-worker config — the current code runs both in one process; for scale split them).
- **Back up the SQLite DB** (`indexer/polkacredit.db`) periodically — the Merkle tree + leaves tables are not reconstructable from chain state alone if the raw event log is trimmed.
- **Watchtower** — run a second indexer instance with a different key, on separate infrastructure. Compare its computed `totalPoints` against what the primary indexer posted. File a `WrongTotalPointsSum` dispute on any drift (auto-resolves on-chain; costs $10 bond, refunded + $5 reward if you're right).

## 6. Cleaning up / resetting

```bash
# contracts: nothing to clean on-chain (testnet), just rebuild
cd contracts && forge clean && forge build

# indexer: nuke the DB and rebuild
cd ../indexer && rm -f polkacredit.db && npm run migrate

# frontend: vite cache
cd ../frontend && rm -rf dist node_modules/.vite
```

## 7. Redeploying after contract changes

Re-running `scripts/deploy.ts` deploys fresh contracts at new addresses. The `420420417.json` file is overwritten. Indexer + frontend pick up the new addresses on next restart. Existing on-chain state at the OLD addresses is orphaned — intentional for testnet iterations.

To migrate real data, you'd want a migration path (out of scope for v1). Paseo is assumed disposable.

## 8. Known current limitations

- Frontend cannot currently write (stake/vouch/dispute) — users hit contracts via Talisman/Remix. Frontend writes are v1.1 work.
- The Solidity deploy script (`contracts/script/Deploy.s.sol`) is equivalent but not wired into CI; the hardhat TS path is the canonical one.
- `cumulativeGasUsed` is returned as 0 from the Passet Hub RPC. Doesn't affect current functionality but is a caveat for Layer B receipt-proof implementation (see [`layer-b-research.md`](layer-b-research.md)).
