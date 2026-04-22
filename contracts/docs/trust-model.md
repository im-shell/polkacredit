# Trust model — v1 with Layer A + planned Layer B

This document enumerates the trust assumptions PolkaCredit v1 makes and the path each one has toward trust minimization. It complements SPEC.md §7, focusing on dispute-resolution paths specifically.

## Layer summary

| Layer | Dispute class handled | Trust assumption |
|---|---|---|
| **A** (shipped) | `WrongArithmetic`, `WrongTotalPointsSum` | **Trustless** — on-chain math. |
| **A** (shipped) | Block-anchor integrity (`sourceBlockHash`) | **Trustless** — `blockhash()` + 256-block window. |
| **B** (research done, implementation pending) | `ReceiptProof*` — event inclusion/forgery against the anchored block | **Trustless** once shipped, pending a one-day trie-encoding confirmation. |
| **C** (current) | `MissingEvent`, `InvalidEvent` semantic judgment | **Trusted** — governance multisig. |

## Which dispute types auto-resolve on-chain today

After Layer A, two claim types never touch governance:

- **`WrongArithmetic`** — `ScoreMath.computeScore(totalPoints)` is run on-chain; disputer wins if it disagrees with the proposal's `score`.
- **`WrongTotalPointsSum`** — `PointsLedger.sumHistoryUpTo(account, sourceBlockHeight)` is compared to the proposal's `totalPoints`; disputer wins if they don't match. The correction re-derives `score` from the ledger sum.

Both are bounded gas. `sumHistoryUpTo` iterates `_history[account]` but terminates on first event past `sourceBlockHeight`, and history length is SPEC-capped (10 gov votes lifetime, 3 vouches received, ≤6 loan bands, 1 stake, etc.). Realistic N is dozens.

## What governance (Layer C) is still responsible for

After Layer A, governance is invoked only for:

1. **`InvalidEvent`** — the Merkle proof shows the leaf is in the committed tree, but governance decides whether its content should have disqualified the proposal (e.g., "this loan repayment event is syntactically valid but the underlying transaction was reverted").
2. **`MissingEvent`** — a disputer claims an event should have been counted but wasn't in the tree. Contract has no way to verify presence-of-something-off-chain, so governance inspects.

After Layer B ships (pending pallet-revive receipts-trie confirmation), receipt-inclusion and receipt-forgery disputes for on-chain-readable events also auto-resolve, narrowing governance's domain further. The residual governance scope becomes:

- Pallet-origin events (OpenGov votes that don't transit the EVM receipts trie).
- Events whose "validity" is semantic rather than syntactic (e.g., a loan repayment receipt exists, but it's a wash loan between colluding accounts — requires judgment).
- Completeness disputes — "you missed events X and Y." No mechanism on-chain proves absence of external events.

## Trust wedge — what v1 requires the multisig to be

The `governance` address in `DisputeResolver` is a single address. In deployment it should be:

- **A multisig contract.** Not a single EOA. Per SPEC §7, the risk of compromise = final word on fact disputes.
- **With publicly-known members.** Reputation cost on bad decisions is the primary social-layer deterrent.
- **Rotated periodically.** `DisputeResolver.setGovernance(g)` is owner-callable. Rotation schedule is a deployment policy, not on-chain-enforced.
- **Bonded off-chain.** If individual members have economic skin in the game (e.g., staked tokens in a separate escrow), that adds a slashing layer — but it's not wired into this contract.
- **Paired with an independent watchtower.** Governance only acts on disputes someone files. If no one runs an indexer to detect drift, no dispute is filed, governance is never invoked, and incorrect scores finalize. The "one honest watchtower" assumption is identical to optimistic rollup assumptions.

## Oracle layer — the write path (ships with v1)

PolkaCredit's v1 already includes the contract scaffolding for an **M-of-N bonded oracle network** via `OracleRegistry.sol`. Every `proposeScore`, `mintPoints`, and `burnPoints` from the off-chain indexer side flows through this contract: each payload is hashed with an EIP-191 prefix, signed by M registered oracles (threshold configurable), verified on-chain against the active oracle set, and then forwarded to the authoritative `ScoreRegistry` / `PointsLedger`.

Bootstrap configuration: **N=1 / threshold=1**. One registered oracle (the indexer key) posts a 100 mUSD bond via `register()` during deploy; its signatures satisfy the threshold. This is a degenerate case of the M-of-N design, deliberately chosen so v1 can ship without inventing a decentralized oracle network from scratch. Expansion is a series of `register()` calls + a `setThreshold()` — no contract upgrade.

What the oracle layer gives us today:
- **Writer-role isolation.** The raw indexer EOA can't touch `ScoreRegistry.proposeScore` or `PointsLedger.mintPoints` directly; those write surfaces only accept calls from the `OracleRegistry` address. Compromising the indexer key still requires forging oracle signatures to do damage.
- **Replay protection.** `OracleRegistry.nextNonce` is monotonic; every submit burns a nonce. A signature bundle can be used exactly once.
- **Domain separation.** Each signed payload embeds `address(this)` + a method tag (`"submitScore"` / `"submitMint"` / `"submitBurn"`). Cross-contract and cross-method replay are both impossible.
- **Auditability.** `ScoreSubmitted` / `MintSubmitted` / `BurnSubmitted` events emit the full signer array. External watchers can correlate collusion patterns and call `slashOracle` on the admin surface.

What it explicitly doesn't give us yet (v2 work):
- **Automated slashing** on contradicting attestations. v1 has `slashOracle` gated by `onlyOwner`. Fraud-proof-based automation is the v2 change.
- **Oracle rotation / cool-off on withdraw.** `deregister()` is immediate — a misbehaving oracle can exit and take its bond before being slashed. Production needs a withdrawal queue.
- **Stake-weighted voting.** v1 is 1-oracle-1-vote. Heterogeneous bonds would need weighted thresholding.
- **Oracle compensation.** There's no built-in fee distribution. Revenue model (per-mint fee / per-query subscription / emission token) is a v2 design decision.

The oracle layer replaces what used to be "the indexer is trusted" with "the oracle set's threshold majority is trusted." For v1 with N=1 that's identical in practice, but the contract surface is ready for expansion the day a second operator shows up.

## What's deliberately not in the code (explicit non-goals for v1)

Each of these is a reasonable ask for v2+ but explicitly out of scope for shipping:

- **On-chain member rotation schedule.** Would require a governance-of-governance mechanism (token vote? admin DAO?). Large design decision.
- **Bond/slash for governance members.** Would require the contract to hold per-member collateral and a slashing-trigger mechanism. Interacts with how the multisig surfaces member identity, which it doesn't.
- **Timelock on governance decisions.** A cool-off between `resolveDispute` being called and its effects applying. Adds complexity to the proposal-finalization flow and creates an "effectively-pending" state that callers must handle.
- **Meta-challenge window.** A second-layer challenge where anyone can contest a governance decision. Elegant but requires another arbiter (token holders), which this project doesn't have yet.
- **Per-decision rationale field.** Governance's `resolveDispute` call doesn't take a `rationale` parameter. Off-chain multisig workflows (Snapshot, forum posts) are the conventional place for rationale; adding it on-chain is a nice-to-have, not a gap.

## Current event surface for post-hoc audit

Auditors tracking governance activity should index these events from `DisputeResolver`:

- `DisputeCreated(disputeId, account, proposalId, claimType, disputer)` — a dispute was opened. `claimType` distinguishes auto-resolving from governance-bound types.
- `DisputeResolved(disputeId, disputerWon, account)` — fires for every resolution path (auto or governance).
- `IndexerPenalized(proposalId, reason)` — fires when a proposal loses. `reason` is currently the static string `"dispute_won"`; not a free-form rationale from governance.
- `GovernanceSet(governance)` — membership change.
- `BondForfeited(disputeId, amount, to)`, `BondRefunded(disputeId, amount, to)` — economic outcome.

An indexer can correlate `DisputeCreated.claimType` with `DisputeResolved` to separate auto-resolved (no trust) from governance-resolved (trust required). For a production deployment, the watchtower dashboard should display the governance-resolution rate and the historical record of governance decisions.

## Upgrade path

The `governance` address is mutable via `setGovernance` (owner-gated). This means the trust wedge can be narrowed without a contract redeploy. **We deliberately do not build our own governance primitive — we plug into existing ones.**

1. **Today — multisig for dispute governance; N=1 bonded oracle for the write path.** `governance = Safe (or Squads) multisig address` for `DisputeResolver`. `OracleRegistry` runs with a single registered oracle (bootstrap) for `proposeScore` / `mintPoints` forwarding. Adding oracles is a `register()` + `setThreshold()` call.
2. **Next — Polkadot OpenGov.** `governance = OpenGov-delegated proxy contract` that accepts calls originating from a specific OpenGov track (e.g., a dedicated Passet Hub referendum track for PolkaCredit dispute resolution). Referenda pass via token-weighted voting; winning referenda enqueue a `resolveDispute` call. This is the natural endgame for Passet Hub deployments — zero bespoke governance code, full use of the Polkadot ecosystem's existing vote-weighting + conviction locking. Requires either (a) pallet-revive support for OpenGov-origin calls, or (b) a precompile/XCM bridge that lets an OpenGov track act as the caller.
3. **After Layer B ships**: governance's domain shrinks to ~20% of dispute cases — enough that the remaining calls through OpenGov are infrequent and well-scrutinised.
4. **v2 candidate**: replace `governance` with a bonded reporter-set contract that uses M-of-N attestations for the residual off-chain-event disputes. Reporter set is staked; bad attestations are slashed on fraud proof. Could coexist with OpenGov (fast path = reporter, escape hatch = OpenGov referendum).
5. **v3 candidate**: replace reporter attestations with zk proofs of chain scans. Fully trustless completeness. OpenGov retained as final-appeal layer for edge cases.

Each step is a contract re-wiring (`setGovernance` + off-chain deployment), not a `DisputeResolver` redeploy. The design never hardcodes which kind of address sits at `governance` — so whether a multisig hands over to OpenGov, or OpenGov hands back to a reporter network, the contract doesn't need to know.

## Summary

**For shipping v1: the existing Layer C governance surface is adequate.** The code has no missing features relative to its scope. What it needs is:

1. Deploy `governance` as a properly-configured multisig, not an EOA.
2. Document the trust model publicly (this file).
3. Commit to a rotation/bonding policy off-chain.
4. Fund at least one independent watchtower.

Layer A shipped (see main branch). Layer B research complete (see `layer-b-receipt-proofs` branch). Layer C requires no code changes for v1.
