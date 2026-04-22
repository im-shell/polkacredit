// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console2 as console} from "forge-std/Test.sol";

import {DisputeResolver} from "../contracts/DisputeResolver.sol";
import {IDisputeResolver} from "../contracts/interfaces/IDisputeResolver.sol";
import {IPointsLedger} from "../contracts/interfaces/IPointsLedger.sol";
import {IScoreRegistry} from "../contracts/interfaces/IScoreRegistry.sol";
import {MockStablecoin} from "../contracts/MockStablecoin.sol";
import {OracleRegistry} from "../contracts/OracleRegistry.sol";
import {PointsLedger} from "../contracts/PointsLedger.sol";
import {ScoreMath} from "../contracts/lib/ScoreMath.sol";
import {ScoreRegistry} from "../contracts/ScoreRegistry.sol";
import {StakingVault} from "../contracts/StakingVault.sol";
import {VouchRegistry} from "../contracts/VouchRegistry.sol";

/// @title PolkaCredit End-to-End Simulation
/// @notice Not a unit test - a narrative exercise of the full stack:
///         OracleRegistry forwarding -> PointsLedger writes -> ScoreRegistry
///         proposal/finalize -> DisputeResolver auto-resolves -> VouchRegistry
///         deferred-credit lifecycle. Runs under `forge test -vvv` to print
///         each step.
///
///         The goal is to catch gaps between "unit tests pass individually"
///         and "the system works when you do things in sequence." Each
///         scenario walks through what a real user + oracle would do.
contract SimulationTest is Test {
    // Actors
    address internal constant ADMIN = address(0xA1);
    address internal constant TREASURY = address(0x7AE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CARA = address(0xCA4A);
    uint256 internal constant ORACLE_PK = 0xA1;
    address internal oracle;

    // Contracts
    MockStablecoin internal stable;
    PointsLedger internal ledger;
    StakingVault internal vault;
    VouchRegistry internal vouch;
    ScoreRegistry internal score;
    DisputeResolver internal dispute;
    OracleRegistry internal oracleRegistry;

    // Fixtures
    uint96 internal constant TIER_1K = 1_000 ether;
    uint96 internal constant TIER_10K = 10_000 ether;
    uint128 internal constant ORACLE_BOND = 100 ether;

    function setUp() public {
        oracle = vm.addr(ORACLE_PK);
        vm.label(ADMIN, "admin");
        vm.label(TREASURY, "treasury");
        vm.label(ALICE, "alice");
        vm.label(BOB, "bob");
        vm.label(CARA, "cara");
        vm.label(oracle, "oracle");

        vm.startPrank(ADMIN);
        stable = new MockStablecoin();
        ledger = new PointsLedger(ADMIN);
        vault = new StakingVault(ADMIN, address(stable), address(ledger), TREASURY, 18);
        vouch = new VouchRegistry(ADMIN, address(ledger), address(vault));
        score = new ScoreRegistry(ADMIN, ADMIN); // placeholder indexer, overridden below
        dispute = new DisputeResolver(ADMIN, address(score), address(ledger), address(stable), TREASURY, 18);
        oracleRegistry = new OracleRegistry(
            ADMIN, address(score), address(ledger), address(stable), TREASURY, ORACLE_BOND, 1
        );

        // Writer-role wiring: OracleRegistry replaces the raw indexer.
        ledger.setAuthorized(address(vault), true);
        ledger.setAuthorized(address(vouch), true);
        ledger.setAuthorized(address(oracleRegistry), true);
        vault.setVouchRegistry(address(vouch));
        vouch.setDefaultReporter(address(oracleRegistry));
        score.setDisputeResolver(address(dispute));
        score.setIndexer(address(oracleRegistry));
        vm.stopPrank();

        // Fund the oracle for bond + gas and register.
        stable.mint(oracle, ORACLE_BOND);
        vm.startPrank(oracle);
        stable.approve(address(oracleRegistry), type(uint256).max);
        oracleRegistry.register(ORACLE_BOND);
        vm.stopPrank();

        // Fund the users.
        _fundUser(ALICE);
        _fundUser(BOB);
        _fundUser(CARA);

        // Seed the DisputeResolver reward pool so successful disputers get
        // their +$5 bounty (keeps the economic assertions honest).
        stable.mint(TREASURY, 1_000 ether);
        vm.prank(TREASURY);
        stable.transfer(address(dispute), 1_000 ether);
    }

    function _fundUser(address who) internal {
        stable.mint(who, 50_000 ether);
        vm.startPrank(who);
        stable.approve(address(vault), type(uint256).max);
        stable.approve(address(dispute), type(uint256).max);
        vm.stopPrank();
    }

    // ========================================================================
    // Oracle-signing helpers - match the contract's payload encoding exactly
    // ========================================================================

    function _signSubmitMint(address account, uint64 amount, string memory reason, uint64 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 payload = keccak256(
            abi.encode(address(oracleRegistry), "submitMint", account, amount, keccak256(bytes(reason)), nonce)
        );
        return _ethSign(ORACLE_PK, payload);
    }

    function _signSubmitScore(
        address account,
        uint64 scoreVal,
        int64 totalPoints,
        bytes32 eventsRoot,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion,
        uint64 nonce
    ) internal view returns (bytes memory) {
        bytes32 payload = keccak256(
            abi.encode(
                address(oracleRegistry),
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
        return _ethSign(ORACLE_PK, payload);
    }

    function _ethSign(uint256 pk, bytes32 payload) internal pure returns (bytes memory) {
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function _mintViaOracle(address account, uint64 amount, string memory reason) internal {
        uint64 nonce = oracleRegistry.nextNonce();
        bytes memory sig = _signSubmitMint(account, amount, reason, nonce);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;
        oracleRegistry.submitMint(account, amount, reason, nonce, sigs);
    }

    function _proposeViaOracle(
        address account,
        uint64 scoreVal,
        int64 totalPoints,
        uint64 sourceBlockHeight
    ) internal returns (uint64 proposalId) {
        uint64 nonce = oracleRegistry.nextNonce();
        bytes memory sig = _signSubmitScore(account, scoreVal, totalPoints, bytes32(0), 0, sourceBlockHeight, 1, nonce);
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = sig;
        return oracleRegistry.submitScore(
            account, scoreVal, totalPoints, bytes32(0), 0, sourceBlockHeight, 1, nonce, sigs
        );
    }

    // ========================================================================
    // Scenario 1 - full lifecycle: stake -> activity -> propose -> finalize
    // ========================================================================

    function test_simulation_fullLifecycle_singleUser() public {
        console.log("\n=== SCENARIO 1: single-user full lifecycle ===");

        // Step 1: Alice stakes $10k. StakingVault direct-mints stake_deposit.
        console.log("[1] Alice stakes $10k");
        vm.prank(ALICE);
        vault.stake(TIER_10K);
        int64 aliceAfterStake = ledger.getBalance(ALICE).total;
        assertEq(aliceAfterStake, int64(100), "stake_deposit = 100 pts for $10k tier");
        console.log("    totalPoints:", vm.toString(aliceAfterStake));

        // Step 2: Alice earns activity. Oracle observes off-chain, signs, submits.
        console.log("[2] Alice earns activity (oracle-signed mints)");
        vm.roll(block.number + 10);
        _mintViaOracle(ALICE, 20, "transfer_band"); // crossed $10k band
        _mintViaOracle(ALICE, 10, "loan_band"); // repaid $1k tier loan
        _mintViaOracle(ALICE, 5, "opengov_vote");
        _mintViaOracle(ALICE, 5, "opengov_vote");
        int64 aliceAfterActivity = ledger.getBalance(ALICE).total;
        assertEq(aliceAfterActivity, int64(140), "100 stake + 20 + 10 + 5 + 5 = 140");
        console.log("    totalPoints:", vm.toString(aliceAfterActivity));

        // Step 3: Oracle computes canonical score and proposes via OracleRegistry.
        vm.roll(block.number + 5);
        uint64 anchor = uint64(block.number - 1);
        uint64 expectedScore = ScoreMath.computeScore(int64(140));
        console.log("[3] Oracle proposes score");
        console.log("    canonical computeScore(140) =", vm.toString(uint256(expectedScore)));
        uint64 pid = _proposeViaOracle(ALICE, expectedScore, 140, anchor);
        assertGt(pid, 0, "proposalId returned");
        console.log("    proposalId:", pid);

        // Step 4: getScore still returns 0 - proposal is Pending.
        (uint64 onchainMid,) = score.getScore(ALICE);
        assertEq(onchainMid, 0, "pending proposals don't expose a score yet");
        console.log("[4] getScore during challenge window:", onchainMid);

        // Step 5: Challenge window elapses, anyone finalizes.
        vm.roll(block.number + score.CHALLENGE_WINDOW());
        assertTrue(score.canFinalize(ALICE));
        score.finalizeScore(ALICE);
        (uint64 onchain, uint64 finalizedAt) = score.getScore(ALICE);
        assertEq(onchain, expectedScore, "post-finalize getScore matches computeScore(140)");
        console.log("[5] finalize landed. getScore =", onchain, "@ block", finalizedAt);

        // Step 6: ScoreRegistry's FinalizedScore carries the block anchor from
        // Layer A - lenders / disputers can reference the exact chain state.
        ScoreRegistry.FinalizedScore memory f = score.getFullScore(ALICE);
        assertTrue(f.sourceBlockHash != bytes32(0), "block-anchor captured");
        assertEq(f.sourceBlockHeight, anchor);
        console.log("[6] FinalizedScore anchor block:", f.sourceBlockHeight);
    }

    // ========================================================================
    // Scenario 2 - vouch success: deferred credit + grace period
    // ========================================================================

    function test_simulation_vouchSuccess() public {
        console.log("\n=== SCENARIO 2: vouch success (deferred credit) ===");

        // Setup: Alice ($10k staker, has 100 pts, can vouch) + Bob ($1k staker).
        vm.prank(ALICE);
        vault.stake(TIER_10K);
        vm.prank(BOB);
        vault.stake(TIER_1K);

        int64 bobBeforeVouch = ledger.getBalance(BOB).total;
        assertEq(bobBeforeVouch, int64(40), "bob has stake_deposit only");
        console.log("[setup] bob.total pre-vouch:", vm.toString(bobBeforeVouch));

        // Alice vouches Bob. Crucially - NO vouch_received mint to Bob here.
        vm.prank(ALICE);
        uint64 vouchId = vouch.vouch(BOB, TIER_1K);

        int64 bobAfterVouchOpen = ledger.getBalance(BOB).total;
        assertEq(bobAfterVouchOpen, bobBeforeVouch, "deferred-credit: no mint at open");
        console.log("[1] vouch opened; bob.total UNCHANGED:", vm.toString(bobAfterVouchOpen));

        VouchRegistry.VouchRecord memory v = vouch.getVouch(vouchId);
        assertEq(v.voucheeTotalAtOpen, bobBeforeVouch, "snapshot stored in VouchRecord");
        console.log("    voucheeTotalAtOpen:", vm.toString(v.voucheeTotalAtOpen));

        // Bob earns ≥ VOUCHEE_SUCCESS_THRESHOLD activity during the window.
        vm.roll(block.number + 50_000);
        _mintViaOracle(BOB, 30, "transfer_band");
        _mintViaOracle(BOB, 20, "loan_band");
        int64 bobBeforeResolve = ledger.getBalance(BOB).total;
        int64 delta = bobBeforeResolve - bobBeforeVouch;
        assertEq(delta, int64(50), "exactly at threshold");
        console.log("[2] bob earned activity; delta =", vm.toString(delta));

        // Fast-forward past expiresAt + RESOLVE_GRACE. Anyone resolves.
        vm.roll(block.number + vouch.VOUCH_WINDOW() + vouch.RESOLVE_GRACE() + 1);
        vm.prank(CARA); // permissionless resolve - cara is not involved
        vouch.resolveVouch(vouchId);

        // Both sides credited.
        int64 aliceAfter = ledger.getBalance(ALICE).total;
        int64 bobAfter = ledger.getBalance(BOB).total;
        assertEq(aliceAfter, int64(140), "alice 100 stake + 40 vouch_given");
        assertEq(bobAfter, bobBeforeResolve + 40, "bob gets +40 vouch_received on success");
        console.log("[3] resolve succeeded");
        console.log("    alice.total:", vm.toString(aliceAfter));
        console.log("    bob.total:  ", vm.toString(bobAfter));

        VouchRegistry.VouchRecord memory vPost = vouch.getVouch(vouchId);
        assertEq(uint8(vPost.status), uint8(VouchRegistry.VouchStatus.Succeeded));
        assertEq(vPost.creditedToVoucher, 40);
        assertEq(vPost.creditedToVouchee, 40);
    }

    // ========================================================================
    // Scenario 3 - vouch failure: stake slashed, no clawback to claw back
    // ========================================================================

    function test_simulation_vouchFailure() public {
        console.log("\n=== SCENARIO 3: vouch failure (slash, no vouchee clawback) ===");

        vm.prank(ALICE);
        vault.stake(TIER_10K);
        vm.prank(BOB);
        vault.stake(TIER_1K);

        int64 bobBefore = ledger.getBalance(BOB).total;
        uint256 treasuryBefore = stable.balanceOf(TREASURY);

        vm.prank(ALICE);
        uint64 vouchId = vouch.vouch(BOB, TIER_1K);
        console.log("[1] vouch opened; committed $1k from alice");

        // Bob earns 40 - below 50 threshold.
        _mintViaOracle(BOB, 40, "transfer_band");
        console.log("[2] bob earns 40 (below threshold)");

        vm.roll(block.number + vouch.VOUCH_WINDOW() + vouch.RESOLVE_GRACE() + 1);
        vouch.resolveVouch(vouchId);
        console.log("[3] resolve triggered at window close");

        // Stake slashed.
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + TIER_1K, "$1k slash -> treasury");
        console.log("    treasury +$1k from slash");

        // Bob's total UNCHANGED from pre-resolve - no vouch_received mint, no clawback.
        assertEq(
            ledger.getBalance(BOB).total,
            bobBefore + 40,
            "bob unchanged by resolve (no mint, no clawback)"
        );
        console.log("    bob.total unchanged by resolve - no clawback needed");

        VouchRegistry.VouchRecord memory v = vouch.getVouch(vouchId);
        assertEq(uint8(v.status), uint8(VouchRegistry.VouchStatus.Failed));
        assertEq(v.creditedToVoucher, 0);
        assertEq(v.creditedToVouchee, 0);
    }

    // ========================================================================
    // Scenario 4 - WrongArithmetic auto-resolve catches bad-math proposals
    // ========================================================================

    function test_simulation_wrongArithmeticDispute() public {
        console.log("\n=== SCENARIO 4: WrongArithmetic auto-resolve ===");

        vm.prank(ALICE);
        vault.stake(TIER_10K);
        _mintViaOracle(ALICE, 45, "loan_band"); // totalPoints = 145

        vm.roll(block.number + 5);
        uint64 anchor = uint64(block.number - 1);

        // Oracle posts a wrong SCORE for totalPoints=145 (canonical is 167).
        uint64 correctScore = ScoreMath.computeScore(145);
        uint64 wrongScore = 300;
        console.log("[1] oracle posts wrong score");
        console.log("    canonical:", correctScore);
        console.log("    posted:   ", wrongScore);
        _proposeViaOracle(ALICE, wrongScore, 145, anchor);

        // Bob disputes with WrongArithmetic. Auto-resolves in same tx.
        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongArithmetic, ev);
        console.log("[2] bob files WrongArithmetic dispute id=", did);

        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, correctScore, "auto-resolve corrected to canonical");
        console.log("[3] auto-resolved. score corrected to:", onchain);

        IDisputeResolver.Dispute memory d = dispute.getDispute(did);
        assertEq(uint8(d.status), uint8(IDisputeResolver.DisputeStatus.DisputerWins));
    }

    // ========================================================================
    // Scenario 5 - WrongTotalPointsSum auto-resolve catches indexer drift
    // ========================================================================

    function test_simulation_wrongTotalPointsSumDispute() public {
        console.log("\n=== SCENARIO 5: WrongTotalPointsSum auto-resolve ===");

        vm.prank(ALICE);
        vault.stake(TIER_1K); // 40 pts
        _mintViaOracle(ALICE, 30, "transfer_band"); // total=70

        vm.roll(block.number + 5);
        uint64 anchor = uint64(block.number - 1);
        console.log("[1] ledger sum at anchor = 70 (40 stake + 30 transfer)");

        // Oracle inflates totalPoints to 200 (score looks arithmetically-valid).
        uint64 inflatedScore = ScoreMath.computeScore(int64(200));
        console.log("[2] oracle posts inflated totalPoints=200; score=", inflatedScore);
        _proposeViaOracle(ALICE, inflatedScore, 200, anchor);

        // Bob files WrongTotalPointsSum. Contract iterates _history, discovers
        // actual sum is 70, auto-resolves with correction.
        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        (uint64 onchain,) = score.getScore(ALICE);
        uint64 corrected = ScoreMath.computeScore(int64(70));
        assertEq(onchain, corrected, "auto-resolve uses ledger sum");
        console.log("[3] auto-resolved to ledger-sum based score:", onchain);
    }

    // ========================================================================
    // Scenario 6 - oracle layer sanity: direct call to ScoreRegistry fails
    // ========================================================================

    function test_simulation_oracleLayerEnforced() public {
        console.log("\n=== SCENARIO 6: oracle layer enforcement ===");

        // The oracle EOA must NOT be able to call proposeScore directly -
        // the indexer role is now held by OracleRegistry.
        vm.roll(block.number + 5);
        uint64 anchor = uint64(block.number - 1);

        vm.expectRevert(IScoreRegistry.NotIndexer.selector);
        vm.prank(oracle);
        score.proposeScore(ALICE, 40, 40, bytes32(0), 0, anchor, 1);
        console.log("[1] oracle EOA blocked from direct proposeScore");

        // Also: mintPoints with a valid reason must go through OracleRegistry.
        vm.expectRevert();
        vm.prank(oracle);
        ledger.mintPoints(ALICE, 10, "loan_band");
        console.log("[2] oracle EOA blocked from direct PointsLedger.mintPoints");

        console.log("[3] both writes are confined to the oracle-signed path");
    }

    // ========================================================================
    // Scenario 7 - vouch concurrency + voucher cap interaction
    // ========================================================================

    function test_simulation_vouchConcurrencyAndCap() public {
        console.log("\n=== SCENARIO 7: concurrency + voucher lifetime cap ===");

        // Alice stakes $10k (can vouch at any tier).
        vm.prank(ALICE);
        vault.stake(TIER_10K);
        // Three vouchees stake $1k each.
        address[] memory vs = new address[](3);
        vs[0] = BOB;
        vs[1] = CARA;
        vs[2] = address(0xDA5E);
        for (uint256 i = 0; i < 3; i++) {
            if (vs[i] != BOB && vs[i] != CARA) _fundUser(vs[i]);
            vm.prank(vs[i]);
            vault.stake(TIER_1K);
        }

        // Alice vouches all three at $10k tier, each cleared via activity.
        uint64[] memory ids = new uint64[](3);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(ALICE);
            ids[i] = vouch.vouch(vs[i], TIER_10K);
            _mintViaOracle(vs[i], 50, "opengov_vote");
            vm.roll(block.number + vouch.VOUCH_WINDOW() + vouch.RESOLVE_GRACE() + 1);
            vouch.resolveVouch(ids[i]);
        }

        // GAP: StakingVault.tierPoints returns the stake_deposit values
        // (40/70/100 per SPEC §2.1), but SPEC §2.2 specifies 40/60/80 for
        // vouch tiers. VouchRegistry.vouch() uses stakingVault.tierPoints()
        // directly, so vouches credit 100/70/40 (not 80/60/40). Flagged for
        // a follow-up fix. The simulation just verifies the actual behavior.
        //
        // With actual tier=100 for $10k: 100 + 100 = 200 hits the cap on
        // vouch 2. Vouch 3 gets 0 voucher-credit, vouchee-side still mints
        // the full 100 (vouchee mint isn't capped by voucherLifetimeCredited).
        assertEq(vouch.voucherLifetimeCredited(ALICE), 200, "cap hit by vouch #2");
        console.log("[1] alice's vouch_given total hit 200 lifetime cap");

        VouchRegistry.VouchRecord memory v2 = vouch.getVouch(ids[2]);
        assertEq(v2.creditedToVoucher, 0, "third vouch: voucher over cap -> 0 credit");
        assertEq(v2.creditedToVouchee, 100, "vouchee still gets full tier on their side");
        assertEq(uint8(v2.status), uint8(VouchRegistry.VouchStatus.Succeeded));
        console.log("    third vouch: voucher credit =", v2.creditedToVoucher, "(cap exhausted)");
        console.log("                 vouchee credit =", v2.creditedToVouchee, "(full tier)");

        console.log("    [GAP FLAGGED] tierPoints uses stake_deposit values, not SPEC 2.2 vouch values");
    }
}
