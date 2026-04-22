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

    // ─────────────────────── Open flow & front-load ───────────────────────

    function test_vouch_frontLoadsVoucheeAndCommitsStake() public {
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT); // $1k tier → 40 pts each side

        // Bob front-loaded 40 (plus his own 40 stake_deposit = 80).
        IPointsLedger.PointsBalance memory bb = ledger.getBalance(BOB);
        assertEq(bb.total, int64(80), "bob front-loaded");

        // Alice's stake has $1k committed.
        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.committed, STAKE_AMOUNT, "committed reserved");
        assertTrue(s.isLocked, "stake marked locked");
        assertEq(vouch.activeVouchCount(ALICE), 1);
        assertEq(vouch.distinctVouchersCount(BOB), 1);
        assertTrue(vouch.hasVouchedFor(ALICE, BOB));
        // Pair uniqueness prevents re-vouching.
        vm.expectRevert(VouchRegistry.PairExhausted.selector);
        vm.prank(ALICE);
        vouch.vouch(BOB, STAKE_AMOUNT);
        id; // silence warning
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

        // Bob must earn ≥ 50 from independent activity — stake_deposit and
        // vouch_received are excluded from earned-in-window per PointsLedger
        // semantics.
        _mint(BOB, 50, "opengov_vote");
        vm.roll(block.number + vouch.VOUCH_WINDOW() + 1);

        uint256 aliceBefore = uint256(int256(ledger.getBalance(ALICE).total));
        vouch.resolveVouch(id);

        // $1k tier → voucher gets +40.
        assertEq(uint256(int256(ledger.getBalance(ALICE).total)), aliceBefore + 40, "voucher credited tier pts");
        // Alice's committed returned to free.
        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.committed, 0, "committed released");
        assertFalse(s.isLocked, "stake unlocked (no other active vouches)");
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

    function test_resolveVouch_failure_slashesCommittedAndClawsBack() public {
        // Advance past Bob's stake_deposit block so it falls outside the vouch
        // window — otherwise Bob's setUp stake (+40) + vouch_received (+40)
        // would clear the 50-point threshold and trigger the success branch.
        vm.roll(block.number + 10);

        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        // Bob does not hit threshold (only vouch_received = 40, below 50).
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

        // Bob's front-load (40) clawed back. He still has his stake_deposit 40.
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

    function test_reportDefault_slashesAndClaws() public {
        vm.prank(ALICE);
        uint64 id = vouch.vouch(BOB, STAKE_AMOUNT);

        uint256 treasuryBefore = stable.balanceOf(TREASURY);

        vm.prank(INDEXER);
        vouch.reportDefault(id);

        // Slash: $1k moved to treasury.
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + STAKE_AMOUNT);

        // Bob's front-load clawed back (40). Stake_deposit 40 remains.
        assertEq(ledger.getBalance(BOB).total, int64(40));

        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.amount, TIER_10K - STAKE_AMOUNT);
        assertEq(s.committed, 0);
    }
}
