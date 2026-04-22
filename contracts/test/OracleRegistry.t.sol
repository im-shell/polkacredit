// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {OracleRegistry} from "../contracts/OracleRegistry.sol";
import {IScoreRegistry} from "../contracts/interfaces/IScoreRegistry.sol";
import {IPointsLedger} from "../contracts/interfaces/IPointsLedger.sol";

/// @title OracleRegistry tests
/// @notice Covers register / deregister / threshold / replay / wrong-signer /
///         duplicate-signer / happy path, plus one regression that the oracle
///         layer forwards to the existing ScoreRegistry correctly.
///
///         Each test generates its own oracle keypairs and signatures so we
///         don't depend on BaseTest's INDEXER being any particular address.
contract OracleRegistryTest is BaseTest {
    OracleRegistry internal oracle;

    // Two oracle identities for 2-of-N tests.
    uint256 internal constant ORACLE1_PK = 0xA1;
    uint256 internal constant ORACLE2_PK = 0xA2;
    uint256 internal constant NOT_ORACLE_PK = 0xBADD;
    address internal oracle1;
    address internal oracle2;
    address internal rogue;

    uint128 internal constant MIN_BOND = 100 ether;

    function setUp() public override {
        super.setUp();
        oracle1 = vm.addr(ORACLE1_PK);
        oracle2 = vm.addr(ORACLE2_PK);
        rogue = vm.addr(NOT_ORACLE_PK);

        vm.startPrank(ADMIN);
        oracle = new OracleRegistry(
            ADMIN,
            address(score),
            address(ledger),
            address(stable),
            TREASURY,
            MIN_BOND,
            1 /* threshold = 1 for most tests */
        );
        // Wire the new oracle layer into the existing contracts.
        score.setIndexer(address(oracle));
        ledger.setAuthorized(address(oracle), true);
        vm.stopPrank();

        // Fund + approve the oracle keypairs so they can post bonds.
        stable.mint(oracle1, 1000 ether);
        stable.mint(oracle2, 1000 ether);
        stable.mint(rogue, 1000 ether);
        vm.prank(oracle1);
        stable.approve(address(oracle), type(uint256).max);
        vm.prank(oracle2);
        stable.approve(address(oracle), type(uint256).max);
        vm.prank(rogue);
        stable.approve(address(oracle), type(uint256).max);
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    function _registerOracle(uint256 pk, uint128 bond) internal returns (address who) {
        who = vm.addr(pk);
        vm.prank(who);
        oracle.register(bond);
    }

    function _scorePayload(
        address account,
        uint64 scoreVal,
        int64 totalPoints,
        bytes32 eventsRoot,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion,
        uint64 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(oracle),
                "submitScore",
                account,
                scoreVal,
                totalPoints,
                eventsRoot,
                eventCount,
                sourceBlockHeight,
                algorithmVersion,
                nonce
            )
        );
    }

    function _sign(uint256 pk, bytes32 payload) internal pure returns (bytes memory) {
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    // ========================================================================
    // Registration lifecycle
    // ========================================================================

    function test_register_recordsBondAndAddsToList() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        (uint128 bond,, bool active) = oracle.oracles(oracle1);
        assertEq(bond, MIN_BOND);
        assertTrue(active);
        assertEq(oracle.oracleCount(), 1);
        assertEq(stable.balanceOf(address(oracle)), MIN_BOND);
    }

    function test_register_rejectsBelowMinBond() public {
        vm.expectRevert(OracleRegistry.InsufficientBond.selector);
        vm.prank(oracle1);
        oracle.register(MIN_BOND - 1);
    }

    function test_register_rejectsAlreadyRegistered() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        vm.expectRevert(OracleRegistry.AlreadyRegistered.selector);
        vm.prank(oracle1);
        oracle.register(MIN_BOND);
    }

    function test_deregister_refundsBondAndShrinksSet() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        _registerOracle(ORACLE2_PK, MIN_BOND);
        uint256 before = stable.balanceOf(oracle1);

        vm.prank(oracle1);
        oracle.deregister();

        (, , bool active) = oracle.oracles(oracle1);
        assertFalse(active, "marked inactive");
        assertEq(oracle.oracleCount(), 1, "set shrank");
        assertEq(stable.balanceOf(oracle1), before + MIN_BOND, "bond refunded");
    }

    // ========================================================================
    // submitScore — signature verification + forward
    // ========================================================================

    function test_submitScore_happyPath_forwardsToScoreRegistry() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);

        // Roll so we have a valid past block anchor.
        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        uint64 nonce = oracle.nextNonce();

        bytes32 payload = _scorePayload(ALICE, 100, 50, bytes32(uint256(0xa11ce)), 1, anchor, 1, nonce);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(ORACLE1_PK, payload);

        uint64 pid = oracle.submitScore(ALICE, 100, 50, bytes32(uint256(0xa11ce)), 1, anchor, 1, nonce, sigs);
        assertGt(pid, 0, "proposalId returned");

        IScoreRegistry.ScoreProposal memory p = score.getProposal(pid);
        assertEq(p.account, ALICE);
        assertEq(p.score, 100);
        assertEq(p.totalPoints, int64(50));

        assertEq(oracle.nextNonce(), nonce + 1, "nonce advanced");
    }

    function test_submitScore_belowThresholdReverts() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        _registerOracle(ORACLE2_PK, MIN_BOND);
        vm.prank(ADMIN);
        oracle.setThreshold(2);

        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        uint64 nonce = oracle.nextNonce();

        bytes32 payload = _scorePayload(ALICE, 100, 50, bytes32(0), 0, anchor, 1, nonce);
        bytes[] memory sigs = new bytes[](1); // only 1 sig, threshold is 2
        sigs[0] = _sign(ORACLE1_PK, payload);

        vm.expectRevert(OracleRegistry.NotEnoughSignatures.selector);
        oracle.submitScore(ALICE, 100, 50, bytes32(0), 0, anchor, 1, nonce, sigs);
    }

    function test_submitScore_wrongSignerReverts() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        // rogue is funded + approved but NOT registered.

        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        uint64 nonce = oracle.nextNonce();

        bytes32 payload = _scorePayload(ALICE, 100, 50, bytes32(0), 0, anchor, 1, nonce);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(NOT_ORACLE_PK, payload);

        vm.expectRevert(OracleRegistry.InvalidSigner.selector);
        oracle.submitScore(ALICE, 100, 50, bytes32(0), 0, anchor, 1, nonce, sigs);
    }

    function test_submitScore_duplicateSignerReverts() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        _registerOracle(ORACLE2_PK, MIN_BOND);
        vm.prank(ADMIN);
        oracle.setThreshold(2);

        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        uint64 nonce = oracle.nextNonce();

        // Two signatures but both from the SAME oracle — should revert.
        bytes32 payload = _scorePayload(ALICE, 100, 50, bytes32(0), 0, anchor, 1, nonce);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(ORACLE1_PK, payload);
        sigs[1] = _sign(ORACLE1_PK, payload);

        vm.expectRevert(OracleRegistry.DuplicateSigner.selector);
        oracle.submitScore(ALICE, 100, 50, bytes32(0), 0, anchor, 1, nonce, sigs);
    }

    function test_submitScore_replayAttemptReverts() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);

        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        uint64 nonce = oracle.nextNonce();

        bytes32 payload = _scorePayload(ALICE, 100, 50, bytes32(uint256(1)), 1, anchor, 1, nonce);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(ORACLE1_PK, payload);

        oracle.submitScore(ALICE, 100, 50, bytes32(uint256(1)), 1, anchor, 1, nonce, sigs);

        // Move past MIN_PROPOSAL_INTERVAL so a second proposal would be
        // structurally allowed; replay should still fail on nonce.
        vm.roll(block.number + score.MIN_PROPOSAL_INTERVAL() + 1);
        uint64 anchor2 = uint64(block.number - 1);
        vm.expectRevert(OracleRegistry.InvalidNonce.selector);
        oracle.submitScore(ALICE, 100, 50, bytes32(uint256(1)), 1, anchor2, 1, nonce, sigs);
    }

    function test_submitScore_twoOfTwo_happyPath() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        _registerOracle(ORACLE2_PK, MIN_BOND);
        vm.prank(ADMIN);
        oracle.setThreshold(2);

        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        uint64 nonce = oracle.nextNonce();

        bytes32 payload = _scorePayload(BOB, 200, 100, bytes32(uint256(0xb0b)), 2, anchor, 1, nonce);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(ORACLE1_PK, payload);
        sigs[1] = _sign(ORACLE2_PK, payload);

        uint64 pid = oracle.submitScore(BOB, 200, 100, bytes32(uint256(0xb0b)), 2, anchor, 1, nonce, sigs);
        assertGt(pid, 0);

        IScoreRegistry.ScoreProposal memory p = score.getProposal(pid);
        assertEq(p.account, BOB);
        assertEq(p.score, 200);
    }

    // ========================================================================
    // submitMint — forwards to PointsLedger
    // ========================================================================

    function test_submitMint_happyPath_forwardsToLedger() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);

        uint64 nonce = oracle.nextNonce();
        bytes32 payload = keccak256(
            abi.encode(address(oracle), "submitMint", ALICE, uint64(5), keccak256(bytes("opengov_vote")), nonce)
        );
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(ORACLE1_PK, payload);

        oracle.submitMint(ALICE, 5, "opengov_vote", nonce, sigs);

        IPointsLedger.PointsBalance memory bal = ledger.getBalance(ALICE);
        assertEq(bal.total, int64(5));
        assertEq(bal.earned, 5);
    }

    function test_submitMint_wrongPayloadReverts() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);

        uint64 nonce = oracle.nextNonce();
        // Sign a payload for `amount=10` but try to submit `amount=100`
        bytes32 wrongPayload = keccak256(
            abi.encode(address(oracle), "submitMint", ALICE, uint64(10), keccak256(bytes("opengov_vote")), nonce)
        );
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sign(ORACLE1_PK, wrongPayload);

        // Contract recovers a signer from the ACTUAL payload (amount=100), which
        // won't match oracle1's address → InvalidSigner.
        vm.expectRevert(OracleRegistry.InvalidSigner.selector);
        oracle.submitMint(ALICE, 100, "opengov_vote", nonce, sigs);
    }

    // ========================================================================
    // Slashing
    // ========================================================================

    function test_slashOracle_adminOnly() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);

        // Non-admin can't slash.
        vm.expectRevert();
        vm.prank(BOB);
        oracle.slashOracle(oracle1, 10 ether, "test");

        uint256 treasuryBefore = stable.balanceOf(TREASURY);
        vm.prank(ADMIN);
        oracle.slashOracle(oracle1, 10 ether, "test slash");

        (uint128 bond,,) = oracle.oracles(oracle1);
        assertEq(bond, MIN_BOND - 10 ether);
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + 10 ether);
    }

    function test_slashOracle_cannotExceedBond() public {
        _registerOracle(ORACLE1_PK, MIN_BOND);
        vm.expectRevert(OracleRegistry.SlashExceedsBond.selector);
        vm.prank(ADMIN);
        oracle.slashOracle(oracle1, MIN_BOND + 1, "test");
    }

    // ========================================================================
    // Admin config
    // ========================================================================

    function test_setThreshold_ownerOnly() public {
        vm.expectRevert();
        vm.prank(BOB);
        oracle.setThreshold(3);

        vm.prank(ADMIN);
        oracle.setThreshold(3);
        assertEq(oracle.threshold(), 3);
    }

    function test_setThreshold_cannotSetZero() public {
        vm.expectRevert(OracleRegistry.NotEnoughSignatures.selector);
        vm.prank(ADMIN);
        oracle.setThreshold(0);
    }
}
