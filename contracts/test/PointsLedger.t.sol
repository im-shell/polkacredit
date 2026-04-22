// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {BaseTest} from "./Base.t.sol";
import {IPointsLedger} from "../contracts/interfaces/IPointsLedger.sol";
import {PointsLedger} from "../contracts/PointsLedger.sol";

contract PointsLedgerTest is BaseTest {
    bytes32 internal writerRole;

    function setUp() public override {
        super.setUp();
        writerRole = ledger.WRITER_ROLE();
    }

    // ─────────────────────── Access control ───────────────────────

    function test_unauthorized_mint_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ALICE, writerRole)
        );
        vm.prank(ALICE);
        ledger.mintPoints(ALICE, 5, "test");
    }

    function test_unauthorized_burn_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ALICE, writerRole)
        );
        vm.prank(ALICE);
        ledger.burnPoints(ALICE, 5, "test");
    }

    function test_setAuthorized_togglesWriterRole() public {
        assertFalse(ledger.authorized(BOB), "bob starts without role");
        vm.prank(ADMIN);
        ledger.setAuthorized(BOB, true);
        assertTrue(ledger.authorized(BOB), "role granted");
        assertTrue(ledger.hasRole(writerRole, BOB), "role mirror in AccessControl");

        vm.prank(ADMIN);
        ledger.setAuthorized(BOB, false);
        assertFalse(ledger.authorized(BOB), "role revoked");
    }

    function test_setAuthorized_onlyAdmin() public {
        bytes32 adminRole = ledger.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, ALICE, adminRole)
        );
        vm.prank(ALICE);
        ledger.setAuthorized(BOB, true);
    }

    // ─────────────────────── Mint / burn accounting ───────────────────────

    function test_mint_updatesAllFields() public {
        _mint(ALICE, 25, "opengov_vote");
        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.total, int64(25), "total");
        assertEq(b.earned, 25, "earned");
        assertEq(b.burned, 0, "burned");
        assertEq(b.available, int64(25), "available");
        assertEq(b.locked, 0, "locked");
        assertEq(b.lastUpdated, uint64(block.number), "lastUpdated");
    }

    function test_mint_zeroReverts() public {
        vm.expectRevert(IPointsLedger.ZeroAmount.selector);
        vm.prank(INDEXER);
        ledger.mintPoints(ALICE, 0, "x");
    }

    function test_mint_zeroAccountReverts() public {
        vm.expectRevert(IPointsLedger.ZeroAddress.selector);
        vm.prank(INDEXER);
        ledger.mintPoints(address(0), 1, "x");
    }

    function test_burn_updatesAllFields() public {
        _mint(ALICE, 30, "opengov_vote");
        vm.prank(INDEXER);
        ledger.burnPoints(ALICE, 10, "penalty");

        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.total, int64(20), "total");
        assertEq(b.earned, 30, "earned unchanged");
        assertEq(b.burned, 10, "burned");
        assertEq(b.available, int64(20), "available");
    }

    function test_burn_goingNegativeIsAllowed() public {
        vm.prank(INDEXER);
        ledger.burnPoints(ALICE, 5, "slash");
        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.total, -int64(5), "total can be negative");
        assertEq(b.available, -int64(5), "available mirrors total");
    }

    function test_mint_appendsHistoryEntry() public {
        uint256 before = ledger.historyLength(ALICE);
        _mint(ALICE, 7, "stake_deposit");
        assertEq(ledger.historyLength(ALICE), before + 1);
        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.earned, 7);
    }

    // ─────────────────────── Lock / unlock ───────────────────────

    function test_lock_requiresAvailable() public {
        _mint(ALICE, 10, "seed");
        vm.prank(INDEXER);
        vm.expectRevert(IPointsLedger.InsufficientAvailable.selector);
        ledger.lockPoints(ALICE, 20, 1);
    }

    function test_lock_movesFromAvailableToLocked() public {
        _mint(ALICE, 50, "seed");
        vm.prank(INDEXER);
        ledger.lockPoints(ALICE, 20, 7);

        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.total, int64(50));
        assertEq(b.available, int64(30));
        assertEq(b.locked, 20);
        assertEq(ledger.lockedPoints(ALICE, 7), 20);
    }

    function test_unlock_restoresAvailable() public {
        _mint(ALICE, 40, "seed");
        vm.prank(INDEXER);
        ledger.lockPoints(ALICE, 20, 1);
        vm.prank(INDEXER);
        ledger.unlockPoints(ALICE, 20, 1);

        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.locked, 0);
        assertEq(b.available, int64(40));
        assertEq(ledger.lockedPoints(ALICE, 1), 0);
    }

    function test_unlock_moreThanLockedReverts() public {
        _mint(ALICE, 40, "seed");
        vm.prank(INDEXER);
        ledger.lockPoints(ALICE, 20, 1);
        vm.expectRevert(IPointsLedger.NotEnoughLocked.selector);
        vm.prank(INDEXER);
        ledger.unlockPoints(ALICE, 25, 1);
    }

    // ─────────────────────── burnLockedPoints semantics ───────────────────────

    /// @notice amount <= locked: burned entirely from the locked portion;
    ///         available stays put.
    function test_burnLocked_entirelyFromLocked() public {
        _mint(ALICE, 50, "seed");
        vm.prank(INDEXER);
        ledger.lockPoints(ALICE, 20, 9);

        vm.prank(INDEXER);
        ledger.burnLockedPoints(ALICE, 15, 9);

        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.total, int64(35), "total reduced by 15");
        assertEq(b.burned, 15);
        assertEq(b.locked, 5, "locked reduced");
        assertEq(b.available, int64(30), "available unchanged");
        assertEq(ledger.lockedPoints(ALICE, 9), 5);
    }

    /// @notice amount > locked: locked portion burns first, remainder comes
    ///         out of available (the "over-penalty" mechanic used by
    ///         reportDefault with VOUCHER_DEFAULT_PENALTY=50 against a 20-point lock).
    function test_burnLocked_overflowsIntoAvailable() public {
        _mint(ALICE, 100, "seed");
        vm.prank(INDEXER);
        ledger.lockPoints(ALICE, 20, 3);

        vm.prank(INDEXER);
        ledger.burnLockedPoints(ALICE, 50, 3);

        IPointsLedger.PointsBalance memory b = ledger.getBalance(ALICE);
        assertEq(b.total, int64(50), "total reduced by 50");
        assertEq(b.burned, 50);
        assertEq(b.locked, 0, "all locked portion gone");
        assertEq(b.available, int64(50), "available = 80 - (50-20) = 50");
        assertEq(ledger.lockedPoints(ALICE, 3), 0);
    }

    function test_burnLocked_zeroAmountReverts() public {
        vm.expectRevert(IPointsLedger.ZeroAmount.selector);
        vm.prank(INDEXER);
        ledger.burnLockedPoints(ALICE, 0, 1);
    }

    // The historical `getPointsEarnedInWindow` view is gone — vouch success
    // is now a pure totalPoints-delta check, no reason-code filtering
    // needed. See `VouchRegistry.resolveVouch` and the deferred-credit
    // SPEC §2.3 refinement for the full flow. Coverage for `sumHistoryUpTo`
    // (the remaining window-like view used by WrongTotalPointsSum disputes)
    // lives in `test/LayerA.t.sol`.
}
