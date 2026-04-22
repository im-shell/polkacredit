// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {IStakingVault} from "../contracts/interfaces/IStakingVault.sol";
import {IPointsLedger} from "../contracts/interfaces/IPointsLedger.sol";
import {StakingVault} from "../contracts/StakingVault.sol";

contract StakingVaultTest is BaseTest {
    function test_stake_invalidTier_reverts() public {
        vm.expectRevert(IStakingVault.InvalidStakeAmount.selector);
        vm.prank(ALICE);
        vault.stake(10 ether);
    }

    function test_stake_1k_mints40() public {
        vm.prank(ALICE);
        vault.stake(STAKE_AMOUNT); // 1k

        IStakingVault.StakeRecord memory s = vault.getStake(ALICE);
        assertEq(s.amount, STAKE_AMOUNT);
        assertEq(s.committed, 0);
        assertEq(s.stakedAt, uint32(block.number));
        assertEq(s.lockUntil, uint32(block.number) + vault.LOCK_DURATION());
        assertFalse(s.isLocked);

        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.earned, vault.POINTS_1K());
    }

    function test_stake_5k_mints70() public {
        _stakeAt(ALICE, TIER_5K);
        assertEq(ledger.getBalance(ALICE).earned, vault.POINTS_5K());
    }

    function test_stake_10k_mints100() public {
        _stakeAt(ALICE, TIER_10K);
        assertEq(ledger.getBalance(ALICE).earned, vault.POINTS_10K());
    }

    function test_stake_twiceReverts() public {
        vm.prank(ALICE);
        vault.stake(STAKE_AMOUNT);
        vm.expectRevert(IStakingVault.AlreadyStaked.selector);
        vm.prank(ALICE);
        vault.stake(STAKE_AMOUNT);
    }

    function test_unstake_beforeLockReverts() public {
        vm.prank(ALICE);
        vault.stake(STAKE_AMOUNT);
        vm.expectRevert(IStakingVault.StillLocked.selector);
        vm.prank(ALICE);
        vault.unstake();
    }

    function test_unstake_afterLockReturnsFunds() public {
        uint256 beforeBal = stable.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.stake(STAKE_AMOUNT);
        vm.roll(block.number + vault.LOCK_DURATION() + 1);

        vm.prank(ALICE);
        vault.unstake();
        assertEq(stable.balanceOf(ALICE), beforeBal, "principal returned");
        assertFalse(vault.hasActiveStake(ALICE));
    }

    function test_unstake_whileActiveVouchReverts() public {
        _stakeAt(ALICE, TIER_10K); // 100 pts stake deposit ≥ MIN_VOUCHER_SCORE
        _stake(BOB);

        vm.prank(ALICE);
        vouch.vouch(BOB, STAKE_AMOUNT); // commit $1k

        vm.roll(block.number + vault.LOCK_DURATION() + 1);
        vm.expectRevert(IStakingVault.ActiveVouches.selector);
        vm.prank(ALICE);
        vault.unstake();
    }

    function test_extendLock_onlyVouchRegistry() public {
        _stake(ALICE);
        vm.expectRevert(IStakingVault.NotVouchRegistry.selector);
        vm.prank(ALICE);
        vault.extendLock(ALICE);
    }

    function test_releaseLock_onlyVouchRegistry() public {
        vm.expectRevert(IStakingVault.NotVouchRegistry.selector);
        vm.prank(ALICE);
        vault.releaseLock(ALICE);
    }

    function test_commitStake_onlyVouchRegistry() public {
        _stake(ALICE);
        vm.expectRevert(IStakingVault.NotVouchRegistry.selector);
        vm.prank(ALICE);
        vault.commitStake(ALICE, STAKE_AMOUNT);
    }

    function test_setVouchRegistry_onlyOwner() public {
        vm.expectRevert();
        vm.prank(ALICE);
        vault.setVouchRegistry(address(0xdeadbeef));
    }
}
