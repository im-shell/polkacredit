# PolkaCredit — Architecture, Decisions, Game Theory

**Audience.** Someone new to the repo who needs to understand why the pieces fit the way they do — before touching any of it.
**Scope.** Everything behind the SPEC.md scoring math: the contract topology, the off-chain indexer, the dispute layers, the deliberate trust wedges, and what v2 / v3 turn into.

## 1. What the system is

PolkaCredit computes a **0–850 on-chain credit score** per identity from a deterministic mix of staking, social vouching, governance participation, transfers, and loan behaviour. The score is a piecewise-linear function of a signed "points" total maintained in an on-chain ledger. The canonical math is in [SPEC.md](../../SPEC.md); this document is about the system around it.

The goal is **gatekeeping-through-participation**: pure capital alone cannot reach the top of the score range, and pure borrowing alone cannot either. Hitting 850 requires stake × vouching × governance × transfers × loans. The numbers in SPEC §4 are tuned so the score surface is a credit-worthiness proxy, not a wealth proxy.

## 2. Contract topology

Seven contracts on Polkadot Hub / Passet Hub via pallet-revive (EVM-compatible):

```
                                    ┌─────────────────┐
                                    │  MockStablecoin │  (ERC-20, testnet only)
                                    └────────┬────────┘
                                             │ stake / slash escrow / oracle bond
                                             ▼
┌────────────────┐  writer ┌─────────────────┐  mint/burn ┌─────────────────┐
│  StakingVault  │────────▶│  PointsLedger   │◀───────────│  VouchRegistry  │
│  (entry gate)  │  role   │  (source of     │            │ (social layer)  │
└────────────────┘         │   points truth) │            └─────────────────┘
                           └────┬──────┬─────┘    ▲
                                │      │          │ mint/burn (M-of-N signed)
                                │      │ getPointsEarnedInWindow
                                │      │ sumHistoryUpTo   (Layer A)
                                │      ▼          │
                                │   ┌─────────────────┐    ┌──────────────────┐
                                │   │ DisputeResolver │──┐ │ OracleRegistry   │
                                │   └─────────┬───────┘  │ │ (M-of-N bonded   │
                                │             │          │ │  write path)     │
                                ▼             ▼          │ └──────────────────┘
                        ┌─────────────────┐              │           ▲
                        │  ScoreRegistry  │◀─────────────┘           │ ECDSA sigs
                        │  (optimistic    │◀─────────── proposeScore─┘ from N
                        │   snapshot)     │  anchored blockhash       │ oracles
                        └─────────────────┘                           │
                                                            ┌─────────┴──────────┐
                                                            │  Oracle network    │
                                                            │  (TypeScript nodes │
                                                            │   ingest chain +   │
                                                            │   OpenGov, sign)   │
                                                            └────────────────────┘
```

Responsibilities — one contract, one job:

- **OracleRegistry** — the M-of-N bonded write path. Holds the authorized writer roles on ScoreRegistry and PointsLedger so no raw indexer key can touch them directly. Every `submitScore` / `submitMint` / `submitBurn` requires ECDSA signatures from M registered oracles (threshold configurable). v1 ships with N=1 / threshold=1 and a single bootstrap oracle; the design absorbs more oracles via `register()` without contract changes. Slashing is admin-only stub in v1, automated fraud-proof in v2+.
- **StakingVault** — holds tiered stake deposits ($1k / $5k / $10k). Issues tiered point bonuses. Vouch commitments escrow base-stake slices that VouchRegistry can slash on failure.
- **PointsLedger** — the authoritative on-chain history of signed point deltas. Mints/burns are gated by `WRITER_ROLE`. Maintains per-account balance + append-only `_history[]`. Reads for `getPointsEarnedInWindow` (vouch success gate) and `sumHistoryUpTo` (Layer A dispute).
- **VouchRegistry** — creates vouches, front-loads vouchee points, resolves on window expiry against PointsLedger's activity sum, slashes committed stake on failure.
- **ScoreRegistry** — optimistic snapshot layer. `proposeScore → (24h challenge window) → finalizeScore`. Post-Layer A, each proposal commits to `blockhash(sourceBlockHeight)` so disputes have a cryptographic anchor.
- **DisputeResolver** — bonded-challenge adjudicator. Auto-resolves `WrongArithmetic` and `WrongTotalPointsSum` on-chain; routes `MissingEvent` / `InvalidEvent` to governance.
- **MockStablecoin** — testnet placeholder for USDC/USDT. Production would point StakingVault at a real stable.

### Why split into six contracts

An alternative is one monolithic contract. The split buys:

- **Independent upgrade / permission surfaces.** Different privileged roles on different contracts (SPEC §7) — compromise of one doesn't pivot into the others.
- **Writer-role scoping.** PointsLedger's WRITER_ROLE list is exactly what's meaningful. Not "is this staker okay?" and a hundred other checks.
- **Reading-in-dispute.** DisputeResolver treats PointsLedger + ScoreRegistry as stateful dependencies via read-only interfaces; it doesn't need permission to mutate them outside the specific hooks.
- **Testability.** Unit tests against one contract at a time with fakes for the others.

Cost: more wiring (setAuthorized, setVouchRegistry, setDisputeResolver calls at deploy). Acceptable — done once.

## 3. The two-layer state: ledger vs registry

The most important architectural choice, and the one most worth understanding first.

**PointsLedger = source of truth.** Every point delta is a row in `_history[account]`. Balance is derived. This is a full log — you can reconstruct the exact point trajectory from genesis by replaying the list.

**ScoreRegistry = optimistic snapshot.** Stores the current displayed `score` for each account, committed periodically by the indexer with a Merkle root of the events used. Has a proposal/finalize/dispute lifecycle.

The tension: why have both?

- If ScoreRegistry were the only state, you'd be trusting the indexer to compute the whole score correctly, with only a dispute window as recourse — and you'd have to compare against a canonical Merkle-rooted event set.
- If PointsLedger were the only state, the displayed score would be a pure view over history. No commitment, no snapshot, no dispute layer. Simpler, but the indexer's off-chain computation (transfer bands, inactivity decay, OpenGov vote matching) has no on-chain anchor point.

We keep both because:

1. Some point events come from off-chain sources (OpenGov votes, transfer volumes, loan band crossings, inactivity penalties). The indexer mints/burns them on PointsLedger. That write is authoritative — once written, the ledger IS the truth, and `sumHistoryUpTo` is a pure view.
2. ScoreRegistry's job is to commit to *which events the indexer used*, so disputers can challenge mistakes. The Merkle root isn't for verifying the sum (Layer A's `WrongTotalPointsSum` does that directly from the ledger); it's for challenging *individual* events.

After Layer A, the roles are:

| What the disputer claims | What resolves it | Where the trust is |
|---|---|---|
| Score doesn't follow curve math | WrongArithmetic — on-chain | None |
| totalPoints doesn't match ledger | WrongTotalPointsSum — on-chain (Layer A) | None |
| A committed event is syntactically bogus | InvalidEvent — Merkle proof verified on-chain, governance decides semantics | Governance |
| An event is missing entirely | MissingEvent — governance compares against chain | Governance |

## 4. The dispute system in full

The dispute system is the thing that makes PolkaCredit trustworthy despite an off-chain indexer. Three states you need in your head:

**Proposal states.** A `ScoreProposal` moves through `Pending → Finalized` (happy path) or `Pending → Disputed → {Finalized | Rejected}` (contested path). Once Finalized it's visible via `getScore`; beforehand, `getScore` returns 0 for the account. `Superseded` allows the indexer to replace its own proposal after `MIN_PROPOSAL_INTERVAL` — expensive enough that the indexer can't bait-and-switch to dodge a late-stage challenge.

**Challenge window.** `CHALLENGE_WINDOW = 7200` blocks ≈ 24 hours at 12s/block (closer to 12 hours at 6s/block on Hub). Anyone who disagrees with a Pending proposal can post a `DISPUTE_BOND` ($10 in stablecoin) and name a claim type. No challenge in the window → proposal finalizes automatically.

**Auto-resolve semantics (post-Layer A).** `WrongArithmetic` and `WrongTotalPointsSum` both resolve inside the `dispute()` transaction:

- **Winning dispute** → proposal is marked `Disputed`, then immediately settled with a correction. Disputer gets bond back + reward from the contract's prefunded pool. `_finalized[account]` is written with the canonical values.
- **Losing dispute** → the proposal stays `Pending`. This is the **C-1 fix** the existing regression tests exist for. Bond is forfeited. The remaining challenge window is preserved for other disputers.

This matters because a single bad-faith auto-resolve must not close the window and force legitimate later disputers to wait for a new proposal.

**Governance path.** For the two remaining claim types that can't be decided by running a function, the contract just holds the dispute open, stores the evidence (including Merkle proofs which are verified on-chain upfront), and waits for a governance multisig to call `resolveDispute`. Governance cannot touch auto-resolving types (Layer A explicitly blocks this) — they settle inside `dispute()` before governance has a chance.

**Bond economics.**
- `DISPUTE_BOND = $10`, scaled to the stablecoin's decimals.
- `DISPUTE_REWARD = $15` ($10 bond + $5 reward, if the pool is funded).
- Bond forfeited on loss → treasury.
- Winners drain from the contract's unreserved balance; **reserved bonds for other open disputes are NOT cannibalised** (H-2 regression lives in the tests). If the pool is dry, winners still get their bond back.

## 5. Layer A: the block-anchor pattern

Before Layer A, the proposal committed to `sourceBlockHeight` as a number. This was *information* only — a disputer had no on-chain way to verify what the chain state was at that height, so every fact dispute became a governance judgment call.

Layer A has two moves:

### Move 1: Anchor the claim cryptographically

At `proposeScore` time, the contract calls `blockhash(sourceBlockHeight)` and stores the result in `ScoreProposal.sourceBlockHash` and `FinalizedScore.sourceBlockHash`. Because EVM `blockhash(n)` only works for `n >= block.number - 256`, proposals are rejected if the anchor is more than 256 blocks back (`StaleSourceBlock`) or in the future (`FutureSourceBlock`). The indexer's `scoreJob.ts` anchors at the current RPC head, comfortably inside the window.

**What this closes.** An indexer can no longer say "I computed this score as of block X" retroactively. They committed to a block with a specific hash at proposal time; any disputer verifies against exactly that anchor. Receipt-proof disputes (Layer B) use this anchor as the trusted root.

### Move 2: WrongTotalPointsSum — the first on-chain state dispute

Before Layer A, you could trust the indexer's `totalPoints` value because `WrongArithmetic` only checked that `computeScore(totalPoints) == score` — the curve math, not the points themselves. If an indexer posted `totalPoints = 800` when the ledger said `500`, `WrongArithmetic` saw a consistent-looking number and let it pass.

`WrongTotalPointsSum` closes that hole. Disputer submits the claim type; the contract reads `PointsLedger.sumHistoryUpTo(account, sourceBlockHeight)` and compares to `proposal.totalPoints`. Mismatch → correction derived from the true ledger sum via the canonical `ScoreMath.computeScore`.

Cost of the check: `sumHistoryUpTo` iterates the account's history with early-exit on the first event past `sourceBlockHeight`. History is SPEC-capped at a few dozen events per account (10 gov votes lifetime, ≤3 vouches received, 1 stake, ≤6 loan bands, etc.). Bounded gas.

What WrongTotalPointsSum doesn't catch: **the indexer minting for fake events**. If the indexer wrote `mintPoints(A, 40, "transfer_band")` without any corresponding transfer ever happening, the ledger sum matches the (bad) proposal. That's Layer B's job — receipt-proof that the source event actually exists on-chain.

### What Layer A doesn't fix

**Completeness.** "You missed event X." No on-chain mechanism proves absence. Requires an external indexer to notice and file `MissingEvent` — governance arbitrates. This is the inherent optimistic-rollup assumption: "at least one honest watchtower exists during the challenge window."

This is not a bug in the design — it's a deliberate v1 trade-off. v3 zk closes it; v2 bonded oracle reduces the trust wedge.

## 6. Game theory

Walking the system adversarially — each role, what they can do wrong, what stops them.

### The indexer

**Can attempt:** post inflated totalPoints → higher score → favours self/friends.

**Stopped by:**
- `WrongArithmetic` (curve consistency — catches obvious mismatch between totalPoints and score).
- `WrongTotalPointsSum` (Layer A — catches totalPoints vs ledger mismatch).
- `InvalidEvent` (catches including events that shouldn't have counted — e.g., a Transfer whose value is below the band minimum).
- `MissingEvent` (catches omitting events that penalise the account — e.g., a loan default).

**Cost of attempting:** if dispute wins, the proposal is rejected + score corrected. There's no direct economic penalty on the indexer itself in v1 — the "penalty" is reputational + the `IndexerPenalized` event fires. Mitigation upgrade path: require indexer to post a bond at proposeScore time, slashed on dispute-won.

### The voucher (participant attacking the vouching system)

**Can attempt:** open a vouch for a colluding vouchee who has no real activity, collect on "successful" resolution.

**Stopped by:**
- `MIN_VOUCHER_SCORE = 80` — SPEC §4.2. Forces $1k/$5k stakers to earn 80 independent-activity points before vouching.
- Vouchee success threshold = 50 points earned from activity categories during the 6-month window. The filter in `getPointsEarnedInWindow` excludes `stake_deposit`, `vouch_received`, and `vouched_for` — so two same-block stakers can't auto-succeed by just staking and front-loading each other.
- Committed stake (1k / 5k / 10k) escrowed; 1× slash on failure. The full commitment is real money at risk per vouch.

**Residual gap:** A fresh $10k staker has 100 pts from stake alone, which clears MIN_VOUCHER_SCORE. SPEC §6 acknowledges this: raising the gate to 101 would fully close it, but the $10k commit itself is considered sufficient deterrent during bootstrap.

### The vouchee

**Can attempt:** accept vouches, never engage, never actually fail (thanks to front-load), just let them time out.

**Stopped by:**
- Vouchee front-load is clawed back on resolution failure (`vouch_received_clawback`).
- `-1×` burn of the front-load amount.
- Max 3 distinct vouchers lifetime — the whale-rental attack surface is bounded.

### The whale

**Can attempt:** just stake $10k and buy points with capital.

**Stopped by:**
- Sublinear stake curve (SPEC §2.1). $1k → 40 pts, $10k → 100 pts. 10× capital → 2.5× points.
- Stake tier caps downstream opportunity (a $1k staker can only issue $1k vouches). A pure capital player isn't unlocking the social-vouch-given ceiling of 200 without real counterparties.
- 850 score requires all categories combined. Whale stake alone tops out at 100 pts → 100 score.

### Governance itself

**Can attempt:** rubber-stamp fraudulent fact disputes in favour of collusion partners.

**Stopped (imperfectly):**
- v1: public multisig, public event record, social accountability. No on-chain slashing.
- v2: bonded reporter set with fraud-proof slashing replaces governance for most fact disputes.
- v3: zk proof of chain scan — eliminates governance from fact disputes entirely.

This is the honest v1 trust wedge. See [`trust-model.md`](trust-model.md).

### The cartel-of-disputers

**Can attempt:** flood the system with frivolous WrongArithmetic / WrongTotalPointsSum disputes to DoS proposals or bleed the reward pool.

**Stopped by:**
- Losing disputes forfeit the bond. Frivolous dispute = $10 gone each time.
- Auto-resolving types don't transition the proposal to `Disputed` on loss, so cannot block legit disputers.
- `openDisputeByProposal` is cleared on loss, so another disputer can try with real evidence.

### The "nobody disputes" case

**Can attempt:** no-one runs an independent indexer; the posted indexer's scores all finalize unchallenged; the indexer drifts or colludes.

**Stopped by (v1):** not much — this is the "one honest watchtower" assumption. Mitigation: project should fund and document at least one independent verifier.

## 7. Off-chain architecture (indexer + frontend)

### Indexer

TypeScript, Node.js, better-sqlite3. Single process. Jobs:

1. **Listener** (`listeners/polkaCreditListener.ts`) — polls `eth_getLogs` against all six contract addresses, decodes via ethers Interface, writes to `raw_events` and domain tables (`point_balances`, `score_proposals`, `disputes`). After Layer A, listens to the new `WrongTotalPointsSum` claim type and captures the anchored `sourceBlockHash` from `ScoreProposed`.
2. **Points calculator** (`calculators/pointsCalculator.ts`) — pure function of event inputs. Implements SPEC §2–3 precisely so an external verifier running the same code produces the same totalPoints.
3. **Score job** (`jobs/scoreJob.ts`) — for each identity with pending changes, build a Merkle tree over the scored events, submit `proposeScore(...)` anchored at the RPC head.
4. **Points job** (`jobs/pointsJob.ts`) — mint/burn the off-chain-sourced point deltas onto PointsLedger (transfers, loans, gov, inactivity). On-chain mints (stake deposit, vouch) happen in their source contracts directly.
5. **API server** (`api/server.ts`) — read-only endpoints for frontend.

Key property: the calculator is a *reference implementation* — anyone can run it against the raw event stream and verify the indexer's posted `totalPoints` and `eventsRoot`. This is how the "one honest watchtower" gets implemented in practice.

### Frontend

React + Vite + ethers v6. Read-only in v1: shows score, pending proposals, history. Writes (stake, vouch, dispute) deferred — for v1 users interact via direct RPC / block explorer.

ABIs and deployment addresses loaded dynamically from `contracts/out/*.json` and `contracts/deployments/<chainId>.json` so the frontend auto-picks up contract updates.

## 8. What's on Paseo / Passet Hub today

- **Paseo AssetHub (chainId 420420417)** via pallet-revive's eth-rpc adapter. Deployment file committed: [`deployments/420420417.json`](../deployments/420420417.json).
- pallet-revive exposes **Ethereum-compatible block headers** on this chain: `keccak(RLP(header)) == block.hash`. Confirmed empirically — see [`layer-b-research.md`](layer-b-research.md). This is what makes Layer B viable without a Substrate-trie verifier.
- Caveat: `cumulativeGasUsed` on receipts came back as `0x0` despite successful transactions. Needs a one-day trie-rebuild confirmation before Layer B ships, but doesn't affect Layer A.

## 9. The full version — v2 and v3 sketches

### v2: bonded reporter oracle + Layer B receipt proofs

**Dispute types added:**
- `ReceiptProofEventMissing` — disputer provides an RLP header + receipt + MPT proof showing an event that should have been counted. Contract verifies `keccak(RLP(header)) == proposal.sourceBlockHash`, then the MPT proof against `header.receiptsRoot`. Auto-resolves on success. Governance-free.
- `ReceiptProofEventForged` — same mechanism, inverse semantics. The disputer shows the indexer included a synthetic event that doesn't exist in any receipt.

**Oracle contract added:** `ReporterRegistry`. N bonded reporters (each stakes $1k–$10k). M-of-N signatures required for off-chain-attested events. Bad attestations are slashed via fraud proofs (a conflicting attestation, or a receipt-proof contradiction).

**Governance's residual role shrinks** to:
- Pallet-origin events (OpenGov votes via receipt trie — pending verification on Polkadot Hub).
- Genuinely semantic disputes ("this transfer is between wash accounts") — rare.

**What v2 does NOT fix:** completeness over external event streams. Oracle attests to individual events; can't attest to "I saw every event."

Engineering estimate: 2–3 months for a small team. Includes auditing a vendored Solidity MPT verifier.

### v3: zk proof of indexing

**The indexer submits a zk-SNARK** proving: "given chain X's state at block H, I enumerated every event matching predicate P for account A, ran the SPEC calculator, and got totalPoints=N with Merkle root=R."

**On-chain verifier** checks the zk proof in O(1). Full cryptographic completeness. Zero governance, zero oracle.

This is the only way to prove absence of events without a social watchtower assumption. Everything else is a trust surface.

**Engineering cost:** 6–12 months with current tooling (SP1 / RISC0 / Succinct). Dropping rapidly as general-purpose zkVMs mature.

### Not in any version (explicit non-goals)

- **Score transfers / delegations.** Scores are soulbound to an account address. No secondary market.
- **Cross-chain identity aggregation.** An account is a single Polkadot Hub EVM address. Linking other chains (Ethereum, Cosmos) is deliberately out. The earlier `popId` / `PopId.sol` abstraction — intended as a wrapper to allow non-EVM identities — was removed as unused; if cross-chain ever becomes in-scope it needs a dedicated design.
- **Subjective reputation signals.** No "trust weights", no friend-of-friend scoring. The SPEC is mechanical.

## 10. Decisions summary

Short list of non-obvious choices and why each:

| Decision | Rationale | Alternative rejected |
|---|---|---|
| Split into 6 contracts | Tight writer-role scope, independent upgrade surfaces | Monolith — too much blast radius per admin |
| Optimistic ScoreRegistry vs pure view over ledger | Needs to commit to WHICH events the indexer used; disputes need a target | Pure view — loses event-commitment anchor |
| `sourceBlockHash` stored at propose time | EVM `blockhash` only works within 256 blocks; defers disputes past that window otherwise | Store `sourceBlockHeight` only; disputer looks up live — fails after 256 blocks |
| WrongTotalPointsSum auto-resolves | Pure function of on-chain state — no governance needed | Route to governance — adds trust, slower |
| `getPointsEarnedInWindow` filter excludes stake_deposit/vouch_received | SPEC §4.2 — closes auto-success exploit | Include all positives — lets pure-capital stakers fake activity |
| PointsLedger history is append-only | Enables `sumHistoryUpTo` and audit trails | In-place updates — can't prove past state |
| Indexer anchors at RPC head, not max(event_block) | Keeps sourceBlockHeight within 256-block window automatically | Anchor at latest event — would fail for sparse event histories |
| DisputeResolver ctor takes pointsLedger | Needed for Layer A auto-resolve — immutable ref avoids setter surface | Setter — another admin-only function to secure |
| No `rationale` field on governance resolveDispute | Off-chain multisig workflows (Snapshot, forum) are the conventional place; on-chain is overkill | Require on-chain string — clutters storage |
| 24h challenge window | Long enough for volunteer watchtower; short enough for user UX | 7 days (too slow UX); 1h (watchtowers can't keep up) |
| $10 bond + $5 reward | Cheap to dispute (removes friction); reward covers disputer's gas with margin | Scaling bonds to score magnitude — complexity without clear benefit |

## 11. Reading order for newcomers

If you're just arriving:

1. [SPEC.md](../../SPEC.md) — the scoring math and caps. Nothing else makes sense without this.
2. This file (architecture.md) — the surrounding system.
3. [trust-model.md](trust-model.md) — what's trustless vs trusted, and why.
4. [layer-b-research.md](layer-b-research.md) — (on the `layer-b-receipt-proofs` branch) — the case for Layer B viability.
5. [runbook.md](runbook.md) — how to actually run it.

Code reading order:

1. `contracts/ScoreMath.sol` — the curve function. Pure math.
2. `contracts/PointsLedger.sol` — the ledger primitives.
3. `contracts/StakingVault.sol` + `VouchRegistry.sol` — the direct-mint paths.
4. `contracts/ScoreRegistry.sol` — the snapshot layer (Layer A is visible here).
5. `contracts/DisputeResolver.sol` — the dispute engine.
6. `indexer/src/calculators/pointsCalculator.ts` — the off-chain reference implementation.
7. `indexer/src/listeners/polkaCreditListener.ts` — the event pipeline.
8. `indexer/src/jobs/scoreJob.ts` — the proposal submission.
