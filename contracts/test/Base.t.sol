// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {DisputeResolver} from "../contracts/DisputeResolver.sol";
import {MockStablecoin} from "../contracts/MockStablecoin.sol";
import {PointsLedger} from "../contracts/PointsLedger.sol";
import {ScoreRegistry} from "../contracts/ScoreRegistry.sol";
import {StakingVault} from "../contracts/StakingVault.sol";
import {VouchRegistry} from "../contracts/VouchRegistry.sol";

/// @title BaseTest
/// @notice Shared fixture for all PolkaCredit Foundry tests. Deploys the
///         full contract stack, wires permissions, and funds three user
///         actors with 10k mUSD each + blanket approvals.
abstract contract BaseTest is Test {
    address internal constant ADMIN = address(0xA1);
    address internal constant INDEXER = address(0x1D);
    address internal constant GOV = address(0x600D);
    address internal constant TREASURY = address(0x7AE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CARA = address(0xCA4A);

    // Default stake amount: $1k (lowest tier) so tests that just want a
    // staked actor don't have to reason about vouch capacity. Tests that
    // exercise specific tiers call `_stakeAt(who, TIER_nK)` explicitly.
    uint96 internal constant STAKE_AMOUNT = 1_000 ether;
    uint96 internal constant TIER_5K = 5_000 ether;
    uint96 internal constant TIER_10K = 10_000 ether;
    uint256 internal constant USER_FUNDING = 50_000 ether;

    MockStablecoin internal stable;
    PointsLedger internal ledger;
    StakingVault internal vault;
    VouchRegistry internal vouch;
    ScoreRegistry internal score;
    DisputeResolver internal dispute;

    function setUp() public virtual {
        vm.label(ADMIN, "admin");
        vm.label(INDEXER, "indexer");
        vm.label(GOV, "gov");
        vm.label(TREASURY, "treasury");
        vm.label(ALICE, "alice");
        vm.label(BOB, "bob");
        vm.label(CARA, "cara");

        vm.startPrank(ADMIN);
        stable = new MockStablecoin();
        ledger = new PointsLedger(ADMIN);
        vault = new StakingVault(ADMIN, address(stable), address(ledger), TREASURY, 18);
        vouch = new VouchRegistry(ADMIN, address(ledger), address(vault));
        score = new ScoreRegistry(ADMIN, INDEXER);
        dispute = new DisputeResolver(ADMIN, address(score), address(ledger), address(stable), TREASURY, 18);

        ledger.setAuthorized(address(vault), true);
        ledger.setAuthorized(address(vouch), true);
        ledger.setAuthorized(INDEXER, true);
        vault.setVouchRegistry(address(vouch));
        vouch.setDefaultReporter(INDEXER);
        score.setDisputeResolver(address(dispute));
        dispute.setGovernance(GOV);
        vm.stopPrank();

        _fundAndApprove(ALICE);
        _fundAndApprove(BOB);
        _fundAndApprove(CARA);

        // Pre-fund the dispute resolver for reward payouts.
        stable.mint(TREASURY, 1_000 ether);
        vm.prank(TREASURY);
        stable.transfer(address(dispute), 1_000 ether);
    }

    function _fundAndApprove(address who) internal {
        stable.mint(who, USER_FUNDING);
        vm.startPrank(who);
        stable.approve(address(vault), type(uint256).max);
        stable.approve(address(dispute), type(uint256).max);
        vm.stopPrank();
    }

    // ─── Helpers ───

    function _stake(address who) internal {
        vm.prank(who);
        vault.stake(STAKE_AMOUNT);
    }

    /// @notice Stake `who` at an explicit tier amount.
    function _stakeAt(address who, uint96 amount) internal {
        vm.prank(who);
        vault.stake(amount);
    }

    /// @notice Mint points to `who` via the INDEXER role.
    function _mint(address who, uint64 amount, string memory reason) internal {
        vm.prank(INDEXER);
        ledger.mintPoints(who, amount, reason);
    }
}
