# PolkaCredit — Scoring Spec

Final point & score specification. All math verified; sanity rows at the bottom reproduce from these rules.

## 1. Units

- **Points** — raw on-chain earned balance per `popId`. Can go negative. Unbounded below.
- **Score** — a piecewise-linear function of points, clamped to `[0, 850]`. Display value.
- All caps are **lifetime** unless explicitly stated as "active" or "concurrent."

## 2. Sources of points

### 2.1 Staking

Base stake is tiered. The tier chosen at stake time determines:
1. The one-time stake-deposit point grant (below).
2. The maximum per-vouch committed-stake tier (§2.2).

| Stake tier | Points on first stake | Cap |
|---|---|---|
| $1,000 | +40 | Once per `popId`, lifetime |
| $5,000 | +70 | Once per `popId`, lifetime |
| $10,000 | +100 | Once per `popId`, lifetime |

- Base stake is locked for 6 months (`LOCK_DURATION`); no early unstake.
- The stake-deposit grant is a one-time lifetime event. Unstaking then re-staking does **not** re-grant it.
- Stake tier is **chosen at first stake and fixed** for that `popId`. Upgrading to a higher tier post-hoc is out of scope for this spec.
- **Sublinear by design.** Capital ratio 1:5:10 maps to points ratio 1:1.75:2.5 — commitment counts, but wealth cannot substitute for behavior.

### 2.2 Vouching — given (voucher side)

Points per vouch are determined by the **voucher's committed stake tier** for that vouch. Committed tier must be `≤` the voucher's base stake tier (§2.1): a $1k staker can only issue $1k vouches; a $10k staker can issue any of $1k / $5k / $10k.

| Committed stake | Points to voucher (on resolve) | Points to vouchee (front-loaded) |
|---|---|---|
| $1,000 | +40 | +40 |
| $5,000 | +60 | +60 |
| $10,000 | +80 | +80 |

**Voucher rules:**
- **Concurrency:** up to 2 active vouches at any time per stake. A slot reopens when a vouch resolves (success or failure).
- **Committed stake is escrowed per vouch** from the voucher's base stake. Sum of active committed stakes cannot exceed the voucher's base stake amount — so a $10k staker running two $5k vouches has no capacity for a third until one resolves.
- **Lifetime cap:** 200 points from vouches given. **Truncated on overshoot** — if the next vouch's full payout would exceed 200, the voucher receives only the remainder. Whale path: +80, +80, then +40 (truncated) → cap reached on vouch #3.
- **Uniqueness:** each `(voucher, vouchee)` pair is counted once lifetime. No re-vouching the same address.
- **Re-staking** does not grant new concurrent slots; slot recycling already comes from resolve. Re-staking is only required if the user has fully unstaked and wants to vouch again.

### 2.3 Vouching — received (vouchee side)

- **Deferred credit.** Vouchee is credited the voucher's per-vouch amount **only on successful resolution**, not at vouch-open. At open the contract snapshots the vouchee's current `totalPoints` and records it in the `VouchRecord`.
- **Success threshold:** vouchee's `totalPoints` must grow by ≥ 50 between the snapshot and resolve-time. Computed as `currentTotal - voucheeTotalAtOpen`; negative deltas (net inactivity burns during the window) always fail.
- **Max 3 distinct vouchers lifetime** → implicit ceiling 3 × 80 = **240 pts**.
- **6-month window** from vouch-open to expiry.

This is the post-Layer-A refinement of the original "front-load at open / clawback on fail" model. Deferring the mint makes the auto-success exploit structurally impossible (no vouch_received points exist inside the window to inflate the delta) and collapses `getPointsEarnedInWindow` + reason-code filtering + `vouch_received_clawback` into a single totalPoints-delta comparison. See `contracts/VouchRegistry.sol::resolveVouch`.

One SPEC trade-off is explicit: stake_deposit during the window DOES contribute to the delta under this model (vs the old filter that excluded it). Bounded exploit surface — stake_deposit is once-per-lifetime per account, gated by $1k–$10k capital committed for 6 months. See §4.2 for the residual-exploit discussion.

### 2.4 Governance

| Event | Points | Cap |
|---|---|---|
| OpenGov vote (≥ 1× conviction, ≥ 5 DOT) | +5 | 10 votes lifetime → **+50 max** |

### 2.5 Transfers (linked-wallet cumulative volume)

Cumulative: crossing a higher band retroactively credits all lower bands not yet earned.

| Cumulative volume | Points (this band) |
|---|---|
| ≥ $1,000 | +10 |
| ≥ $10,000 | +20 |
| ≥ $100,000 | +30 |
| ≥ $1,000,000 | +40 |

**Max: +100 lifetime.**

### 2.6 Loans (tiered, on repayment)

Once per tier per `popId`. Crossing a higher tier retroactively unlocks any skipped lower tiers. No repeat points for repaying within a tier already claimed.

| Band | Points (this band) |
|---|---|
| $1K – $9,999 | +10 |
| $10K – $49,999 | +20 |
| $50K – $99,999 | +40 |
| $100K – $499,999 | +80 |
| $500K – $999,999 | +150 |
| $1M+ | +210 |

**Max: +510 lifetime.**

This cap is deliberately sized so that loans alone cannot saturate the 850 score — only the combination of all categories reaches it (see §5 sanity rows).

## 3. Penalties and clawbacks

### 3.1 Failed vouch (vouchee fails to hit +50 in-window)

| Side | Penalty |
|---|---|
| Voucher | −2× points actually credited for that vouch + **full slash of committed stake** (transferred to treasury) |
| Vouchee | −1× front-load received (full clawback) |

Notes:
- Clawback multiplier applies to the **amount actually credited** to the voucher for that vouch, not the pre-truncation sticker value. A vouch that was truncated to +40 at the cap has a −80 clawback on failure, not −160.
- Slash is **1× the committed stake** of the failed vouch, removed from the voucher's base stake and sent to treasury. A successful vouch returns the committed stake to the voucher's withdrawable base stake.
- A voucher who loses enough stake through successive slashes to drop below the $1,000 tier floor can no longer vouch; their remaining stake is unstakeable after the original 6-month lock expires.

### 3.2 Self loan default

| Component | Effect |
|---|---|
| Flat penalty | −100 |
| Active-vouch clawbacks | Each active voucher who front-loaded points to this `popId` sees those front-loads clawed back from the vouchee's balance |

Self-default also triggers the "failed vouch" treatment for each active voucher pointing at the defaulter (i.e., §3.1 applies on the voucher side too).

### 3.3 Inactivity

- Grace period: 90 days of inactivity from last qualifying on-chain action.
- After grace: **−5 pts / week**. Unbounded; balance can and will go negative for long dormancy. No floor.

## 4. Score curve

Piecewise-linear mapping from points → score. Score is clamped to `[0, 850]`.

| Points segment | Slope (score / pt) | Segment endpoints (pts → score) |
|---|---|---|
| `[0, 100]` | 1.0 | 0 → 0, 100 → 100 |
| `(100, 300]` | 1.5 | 100 → 100, 300 → 400 |
| `(300, 700]` | 0.75 | 300 → 400, 700 → 700 |
| `(700, 1200]` | 0.3 | 700 → 700, 1200 → 850 |
| `(1200, ∞)` | 0 | saturated at 850 |

Below 0 points, score clamps to 0.

### 4.1 Point budget by category

| Source | Lifetime max | Notes |
|---|---|---|
| Staking ($10k tier) | 100 | Lower tiers cap lower: $5k → 70, $1k → 40 |
| Vouching given | 200 | Truncated at cap |
| Vouching received | 240 | 3 × 80, whale-vouched |
| Governance | 50 | 10 votes |
| Transfers | 100 | All bands |
| **Pure-participation subtotal** | **690** | Whale-tier stake assumed |
| Loans | 510 | All tiers |
| **Absolute max (whale staker)** | **1,200** | → 850 exactly |

1,200 pts lands exactly at the 850 saturation boundary — intentional. Lower stake tiers **cannot** reach 1,200 and therefore cannot saturate; they hit individual category ceilings well short of 850.

### 4.2 Gatekeeping properties (from the numbers)

- **Pure-participation ceiling** (no loans, whale stake): 690 pts → **~693 score**. Tops out mid-curve, below 700.
- **Loans alone** (base stake + max loans, zero social/governance/transfers): 100 + 510 = 610 pts → **~633 score**. Cannot reach 850 through lending activity alone, by design.
- **850 requires combining all categories at the $10k stake tier.** The only path to saturation is: $10k stake + full vouching (both sides) + governance + transfers + all loan tiers.
- **Stake-tier ceilings:**
  - $1k staker: absolute max = 40 + 200 + 240 + 50 + 100 + 510 = 1,140 pts → **832 score**.
  - $5k staker: absolute max = 70 + 200 + 240 + 50 + 100 + 510 = 1,170 pts → **841 score**.
  - $10k staker: 1,200 pts → **850 score**.
- **Stake is prerequisite** for every other category (loans gated on staked collateral, vouching gated on stake, etc.), so the stake-tier floor is implicit in all higher totals.
- **`MIN_VOUCHER_SCORE = 80` forces activity before vouching.** A $1k staker (40 pts) needs +40, a $5k staker (70 pts) needs +10, and only a $10k staker (100 pts) can vouch immediately. This blocks a pure-capital whale-rental exploit at the $1k/$5k tiers where a fresh staker could otherwise open a vouch in the same block as their stake.
- **In-window earn is activity-only.** `getPointsEarnedInWindow` excludes `stake_deposit`, `vouch_received`, and `vouched_for` reasons. A vouchee must clear `VOUCHEE_SUCCESS_THRESHOLD = 50` through independent activity (governance, transfers, loan repayment) — the front-load itself and the onboarding stake bonus do not count. This closes a same-block "auto-success" loop where `stake_deposit` + `vouch_received` would otherwise clear threshold with zero real activity.

## 5. Sanity rows

Computed directly from §2 and §4. Scores rounded down to nearest integer.

| Profile | Point calc | Pts | Score |
|---|---|---|---|
| Day-1 $1k staker | 40 | 40 | 40 |
| Day-1 $5k staker | 70 | 70 | 70 |
| Day-1 $10k staker | 100 | 100 | 100 |
| Light user ($1k stake + 1 received + 2 gov votes) | 40 + 40 + 10 | 90 | 90 |
| Typical ($5k stake + 3 $5k vouches given + 2 $5k received + full gov + $10K transfers) | 70 + 180 + 120 + 50 + 20 | 440 | 505 |
| Pure-participation ceiling ($10k, all maxed, whale-vouched) | 100 + 200 + 240 + 50 + 100 | 690 | 692 |
| Modest borrower (pure-ceiling + $10K repaid → unlocks $1K+$10K tiers) | 690 + 10 + 20 | 720 | 706 |
| Established (pure-ceiling + $100K loan → unlocks through $100K) | 690 + 10 + 20 + 40 + 80 | 840 | 742 |
| Elite ($10k staker, pure-ceiling + $1M loan → all tiers) | 690 + 510 | 1,200 | 850 |
| $1k staker absolute max (all non-stake categories maxed) | 40 + 200 + 240 + 50 + 100 + 510 | 1,140 | 832 |
| $5k staker absolute max | 70 + 200 + 240 + 50 + 100 + 510 | 1,170 | 841 |
| Loans-alone max ($10k base stake + all loan tiers, zero else) | 100 + 510 | 610 | 632 |
| Defaulter (was at 500, defaults on $10K loan, one $5k active vouch clawed back) | 500 − 100 − 60 | 340 | 430 |

### 5.1 Worked calculations

- `score(40) = 40` (identity segment)
- `score(70) = 70` (identity segment)
- `score(90) = 90` (identity segment)
- `score(100) = 100`
- `score(440) = 400 + (440−300)×0.75 = 505`
- `score(610) = 400 + (610−300)×0.75 = 632.5`
- `score(690) = 400 + (690−300)×0.75 = 692.5`
- `score(700) = 400 + 400×0.75 = 700`
- `score(720) = 700 + (720−700)×0.3 = 706`
- `score(840) = 700 + (840−700)×0.3 = 742`
- `score(1140) = 700 + (1140−700)×0.3 = 832`
- `score(1170) = 700 + (1170−700)×0.3 = 841`
- `score(1200) = 700 + 500×0.3 = 850`
- `score(340) = 400 + (340−300)×0.75 = 430`

Curve is continuous at every segment boundary (100, 300, 700, 1200) — verified by evaluating both adjacent segments at each boundary.

## 6. Open items (not part of this spec, flagged for later)

- **Loan repeat-repayment decay.** Once a borrower has proven reliability across N (say, 3) distinct loans, award points for subsequent loans on a decaying curve rather than zero. Out of scope here.
- **Stake-tier upgrade.** Current spec fixes tier at first stake; a voucher who wants to move from $1k to $10k must fully unstake (after lock) and re-stake. In-place top-ups are out of scope — introduces edge cases around point deltas on upgrade.
- **Front-load underwriting eligibility.** Accepted risk: vouchee-side front-loaded points are visible to loan underwriting during the open-vouch window. Mitigated by §3.1/§3.2 clawbacks rather than by underwriting gating.
- **Slash destination.** §3.1 slashes to "treasury". The exact treasury address and whether any portion goes to the vouchee-side counterparty or is pure sink is a governance parameter.
- **$10k whale-rental residual.** `MIN_VOUCHER_SCORE = 80` blocks pure-capital vouching at $1k and $5k, but a fresh $10k staker (100 pts) still clears the gate immediately. Fully closing this would require `MIN_VOUCHER_SCORE ≥ 101`, forcing every voucher to demonstrate at least some independent activity. Deferred — the $10k commit itself (with 1× slash on failure) is judged sufficient disincentive for the bootstrap phase.

## 7. Threat model & admin surface

Privileged roles that require operational hardening before mainnet:

- **`StakingVault.owner`** — can call `setTreasury` (redirects slash flow) and `setVouchRegistry` (redirects vouch hooks). A compromised admin can seize all future slashes by repointing treasury, or disable slashing by repointing the registry. **Mitigation:** multisig + timelock. The current `Ownable2Step` gives two-step transfer but no time delay.
- **`VouchRegistry.owner`** — can call `setDefaultReporter`, changing who is trusted to call `reportDefault`. A compromised admin plus a compromised reporter can slash any voucher at will. **Mitigation:** multisig for admin; diverse reporter set (multi-indexer consensus) post-bootstrap.
- **`PointsLedger.admin`** — can call `setAuthorized` to grant mint/burn rights. A compromised admin can mint unlimited points to arbitrary accounts and wash the score curve. **Mitigation:** multisig + timelock; monitor `AuthorizedSet` events and emit an alert on any non-scheduled grant.
- **`ScoreRegistry.indexer`** — proposes optimistic score roots. Wrong proposals are caught only by active disputers within the window. If no one disputes in `DISPUTE_WINDOW` blocks, the root finalizes. **Mitigation:** run an independent watchtower; fund `DisputeResolver` with enough reward to make disputing profitable; raise the bond to make lazy indexer drift expensive.
- **`DisputeResolver.governance`** — binary arbitrator of fact disputes (`wrongArithmetic` is decidable on-chain, `invalidEvent` is decidable via Merkle proof, but the `governance` path exists as escape hatch). Compromise = final word. **Mitigation:** governance should be onchain OpenGov or a large multisig, never a single EOA.

Non-privileged but worth monitoring:

- **Concentrated collusion rings** — once Flaw 1 is patched, reciprocal vouching requires real in-window activity from each party. Monthly cap in `PointsLedger` (activity rate-limit) is the second line of defense; ring size is bounded by `MAX_DISTINCT_VOUCHERS_PER_VOUCHEE = 3` per target.
- **Same-block MEV on vouches** — not applicable: point mints are not transferable, so there is no front-run reward.
