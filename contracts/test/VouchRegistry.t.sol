// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {IPointsLedger} from "../contracts/interfaces/IPointsLedger.sol";
import {IStakingVault} from "../contracts/interfaces/IStakingVault.sol";
import {VouchRegistry} from "../contracts/VouchRegistry.sol";

contract VouchRegistryTest is BaseTest {
    function setUp() public override {
        super.setUp();
        // Alice stakes at $10k to clear MIN_VOUCHER_SCORE outright (100 pts).
        _stakeAt(ALICE, TIER_10K);
        // Bob stakes at $1k as default target.
        _stake(BOB);
    }

    // ─────────────────────── Preconditions ───────────────────────

    function test_vouch_selfReverts() public {
        vm.expectRevert(VouchRegistry.SelfVouch.selector);
        vm.prank(ALICE);
        vouch.vouch(ALICE, STAKE_AMOUNT);
    }

    function test_vouch_voucheeZeroReverts() public {
        vm.expectRevert(VouchRegistry.ZeroAddress.selector);
        vm.prank(ALICE);
        vouch.vouch(address(0), STAKE_AMOUNT);
    }

    function test_vouch_voucherNoStakeReverts() public {
        vm.expectRevert(VouchRegistry.VoucherNoStake.selector);
        vm.prank(CARA);
        vouch.vouch(BOB, STAKE_AMOUNT);
    }

    function test_vouch_voucheeNoStakeReverts() public {
        vm.expectRevert(VouchRegistry.VoucheeNoStake.selector);
        vm.prank(ALICE);
        vouch.vouch(CARA, STAKE_AMOUNT);
    }

    function test_vouch_belowMinScoreReverts() public {
        // Bob ($1k staker) has 40 pts — below MIN_VOUCHER_SCORE=50.
        vm.expectRevert(VouchRegistry.BelowMinScore.selector);
        vm.prank(BOB);
        vouch.vouch(ALICE, STAKE_AMOUNT);
    }

    function test_vouch_invalidCommitTierReverts() public {
        vm.expectRevert(VouchRegistry.InvalidCommitTier.selector);
        vm.prank(ALICE);
        vouch.vouch(BOB, 2_000 ether); // not 1/5/10k
    }

    function test_vouch_commitOverBaseTierReverts() public {
        // Bob ($1k staker) with enough points to clear MIN_VOUCHER_SCORE=80
        // would still fail to commit $5k — his base stake is only $1k.
        _mint(BOB, 40, "opengov_vote"); // 40 stake + 40 activity = 80
        vm.expectRevert(VouchRegistry.CommitOverTier.selector);
        vm.prank(BOB);
        vouch.vouch(ALICE, TIER_5K);
    }

    // ─────────────────────── Open flow & deferred credit ───────────────────────

    function test_vouch_snapshotsVoucheeAndCommitsStake() public {
        // Under the deferred-credit model (post-SPEC §2.3 refinement) the
        // vouch_received reward is only minted on successful resolution.
        // At vouch-open we snapshot the vouchee's totalPoints; no mint to
        // the vouchee happens here.
        int64 bobBefore = ledger.getBalance(BOB).total;

        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT); // $1k tier → 40 pts each side on success

        // CRITICAL: Bob's totalPoints must NOT change at vouch-open.
        // He still has exactly his stake_deposit (40), no +40 vouch_received.
        IPointsLedger.PointsBalance memory bb = ledger.getBalance(BOB);
        assertEq(bb.total, bobBefore, "vouchee total unchanged at vouch-open");
        assertEq(bb.total, int64(40), "bob has stake_deposit only");

        // VouchRecord captured the snapshot.
        VouchRegistry.VouchRecord memory v = vouch.getVouch(id);
        assertEq(v.voucheeTotalAtOpen, bobBefore, "snapshot matches pre-vouch total");
        assertEq(v.creditedToVouchee, 0, "no vouchee credit yet");
        assertEq(v.creditedToVoucher, 0, "no voucher credit yet");

        // Alice's stake has $1k committed + the vault is lock-flagged.
        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.committed, STAKE_AMOUNT, "committed reserved");
        assertTrue(s.isLocked, "stake marked locked");
        assertEq(vouch.activeVouchCount(ALICE), 1);
        assertEq(vouch.distinctVouchersCount(BOB), 1);
        assertTrue(vouch.hasVouchedFor(ALICE, BOB));

        // Pair uniqueness prevents re-vouching the same address.
        vm.expectRevert(VouchRegistry.PairExhausted.selector);
        vm.prank(ALICE);
        vouch.vouch(BOB, STAKE_AMOUNT);
    }

    function test_vouch_concurrencyCap() public {
        _stake(CARA);
        address dave = address(0xDA5E);
        _fundAndApprove(dave);
        _stake(dave);

        vm.prank(ALICE);
        vouch.vouch(BOB, STAKE_AMOUNT);
        vm.prank(ALICE);
        vouch.vouch(CARA, STAKE_AMOUNT);
        vm.expectRevert(VouchRegistry.ConcurrencyCap.selector);
        vm.prank(ALICE);
        vouch.vouch(dave, STAKE_AMOUNT);
    }

    function test_vouch_voucheeDistinctCap() public {
        // Three $1k stakers each vouch for Bob, then a fourth reverts.
        _mint(BOB, 20, "opengov_vote"); // keep Bob's side, not relevant
        address[] memory vs = new address[](3);
        vs[0] = CARA;
        vs[1] = address(0xDA5E);
        vs[2] = address(0xE7E);
        _fundAndApprove(vs[1]);
        _fundAndApprove(vs[2]);
        _stakeAt(CARA, TIER_10K);
        _stakeAt(vs[1], TIER_10K);
        _stakeAt(vs[2], TIER_10K);

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(vs[i]);
            vouch.vouch(BOB, STAKE_AMOUNT);
        }

        // ALICE already has $10k stake and MIN_VOUCHER_SCORE met → 4th attempt.
        vm.expectRevert(VouchRegistry.VoucheeFull.selector);
        vm.prank(ALICE);
        vouch.vouch(BOB, STAKE_AMOUNT);
    }

    // ─────────────────────── Resolve: success ───────────────────────

    function test_resolveVouch_success_givesTierReward() public {
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        // Bob must grow totalPoints by ≥ VOUCHEE_SUCCESS_THRESHOLD (50)
        // between vouch-open snapshot and resolve. Since nothing was
        // front-loaded, any mints during the window contribute to the
        // delta directly.
        _mint(BOB, 50, "opengov_vote");
        vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);

        int64 aliceBefore = ledger.getBalance(ALICE).total;
        int64 bobBefore = ledger.getBalance(BOB).total; // 40 stake + 50 activity = 90
        vouch.resolveVouch(id);

        // $1k tier → voucher gets +40 credit (post-truncation); vouchee
        // gets +40 vouch_received now (deferred payout, not front-load).
        assertEq(ledger.getBalance(ALICE).total, aliceBefore + 40, "voucher credited tier pts on success");
        assertEq(ledger.getBalance(BOB).total, bobBefore + 40, "vouchee credited tier pts on success");

        // VouchRecord reflects the credits.
        VouchRegistry.VouchRecord memory v = vouch.getVouch(id);
        assertEq(uint8(v.status), uint8(VouchRegistry.VouchStatus.Succeeded));
        assertEq(v.creditedToVoucher, 40);
        assertEq(v.creditedToVouchee, 40);

        // Alice's committed returned to free.
        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.committed, 0, "committed released");
        assertFalse(s.isLocked, "stake unlocked (no other active vouches)");
    }

    function test_resolveVouch_failsWhenDeltaBelowThreshold() public {
        // Bob earns activity below the 50-pt threshold. Vouch must fail
        // even though Bob's total went up by >= 50 if we naively counted
        // stake_deposit — but the snapshot was taken AFTER stake_deposit,
        // so only in-window activity counts toward the delta.
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        _mint(BOB, 49, "loan_band"); // just under threshold
        vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);

        int64 bobBefore = ledger.getBalance(BOB).total; // 40 stake + 49 activity = 89
        uint256 treasuryBefore = stable.balanceOf(TREASURY);
        vouch.resolveVouch(id);

        // Bob unchanged — no vouch_received paid out, nothing clawed back.
        assertEq(ledger.getBalance(BOB).total, bobBefore, "vouchee unchanged on failure");
        // Stake slashed to treasury.
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + STAKE_AMOUNT);
    }

    function test_resolveVouch_passesAtExactlyThreshold() public {
        // Boundary: delta == VOUCHEE_SUCCESS_THRESHOLD should succeed.
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        _mint(BOB, 50, "loan_band"); // exactly threshold
        vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);

        vouch.resolveVouch(id);

        VouchRegistry.VouchRecord memory v = vouch.getVouch(id);
        assertEq(uint8(v.status), uint8(VouchRegistry.VouchStatus.Succeeded));
    }

    function test_resolveVouch_negativeDeltaFails() public {
        // If the vouchee's totalPoints goes DOWN during the window (net
        // burns > mints), delta is negative and the vouch must fail.
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        // Burn more than Bob had pre-vouch.
        vm.prank(INDEXER);
        ledger.burnPoints(BOB, 10, "inactivity");
        vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);

        vouch.resolveVouch(id);
        VouchRegistry.VouchRecord memory v = vouch.getVouch(id);
        assertEq(uint8(v.status), uint8(VouchRegistry.VouchStatus.Failed));
    }

    function test_resolveVouch_success_truncatesAtLifetimeCap() public {
        // Drive voucherLifetimeCredited close to the 200 cap before resolve.
        // Alice vouches three times successively at $10k tier (+80 each),
        // but lifetime cap truncates the third to +40.
        address[] memory vouchees = new address[](3);
        vouchees[0] = BOB;
        vouchees[1] = CARA;
        vouchees[2] = address(0xDA5E);
        _stake(CARA);
        _fundAndApprove(vouchees[2]);
        _stake(vouchees[2]);

        uint64[] memory ids = new uint64[](3);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(ALICE);
            ids[i] = vouch.vouch(vouchees[i], TIER_10K);
            // Vouchee clears the success threshold.
            _mint(vouchees[i], 50, "opengov_vote");
            vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);
            vouch.resolveVouch(ids[i]);
            // Avoid concurrency: since we resolved, the slot recycles.
        }

        // 80 + 80 + 40 (truncated) = 200.
        assertEq(vouch.voucherLifetimeCredited(ALICE), 200);
    }

    // ─────────────────────── Resolve: failure ───────────────────────

    function test_resolveVouch_failure_slashesStake() public {
        // Under deferred-credit, no setup gymnastics needed: Bob never
        // receives vouch_received at open, so the snapshot is 40
        // (stake_deposit) and he has no activity to grow it. Delta = 0,
        // vouch fails, voucher stake slashed.
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);

        uint256 treasuryBefore = stable.balanceOf(TREASURY);
        uint256 vaultBefore = stable.balanceOf(address(vault));

        vouch.resolveVouch(id);

        // Treasury got the $1k commit; vault is $1k lighter.
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + STAKE_AMOUNT);
        assertEq(stable.balanceOf(address(vault)), vaultBefore - STAKE_AMOUNT);

        // Alice's stake: amount reduced by $1k, committed back to 0.
        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.amount, TIER_10K - STAKE_AMOUNT);
        assertEq(s.committed, 0);

        // Bob's totalPoints unchanged — nothing was minted or clawed back.
        assertEq(ledger.getBalance(BOB).total, int64(40));
    }

    // ─────────────────────── reportDefault ───────────────────────

    function test_reportDefault_onlyReporter() public {
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        vm.expectRevert(VouchRegistry.NotReporter.selector);
        vm.prank(CARA);
        vouch.reportDefault(id);
    }

    function test_reportDefault_slashesStake() public {
        // Under deferred-credit there's no vouchee clawback on default —
        // nothing was minted to claw back. reportDefault reduces to "slash
        // the committed stake, mark vouch Defaulted."
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        uint256 treasuryBefore = stable.balanceOf(TREASURY);

        vm.prank(INDEXER);
        vouch.reportDefault(id);

        // Slash: $1k moved to treasury.
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + STAKE_AMOUNT);

        // Bob's total unchanged — no front-load existed to claw back.
        assertEq(ledger.getBalance(BOB).total, int64(40));

        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.amount, TIER_10K - STAKE_AMOUNT);
        assertEq(s.committed, 0);

        VouchRegistry.VouchRecord memory v = vouch.getVouch(id);
        assertEq(uint8(v.status), uint8(VouchRegistry.VouchStatus.Defaulted));
    }
}
