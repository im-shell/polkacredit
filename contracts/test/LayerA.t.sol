// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {BaseTest} from "./Base.t.sol";
import {DisputeResolver} from "../contracts/DisputeResolver.sol";
import {IDisputeResolver} from "../contracts/interfaces/IDisputeResolver.sol";
import {IScoreRegistry} from "../contracts/interfaces/IScoreRegistry.sol";
import {PointsLedger} from "../contracts/PointsLedger.sol";
import {ScoreMath} from "../contracts/lib/ScoreMath.sol";
import {ScoreRegistry} from "../contracts/ScoreRegistry.sol";

/// @title LayerA — edge cases + boundary conditions for Layer A
/// @notice Each test explicitly establishes the ledger / block state it
///         depends on. No shared-fixture assumptions beyond BaseTest's
///         contract deployment and actor funding.
contract LayerATest is BaseTest {
    // ========================================================================
    // PointsLedger.sumHistoryUpTo — pure view coverage
    // ========================================================================

    function test_sumHistoryUpTo_emptyHistory_returnsZero() public view {
        // Precondition established: ALICE has no mints/burns at all.
        assertEq(ledger.historyLength(ALICE), 0, "precondition: empty history");
        assertEq(ledger.sumHistoryUpTo(ALICE, 0), int64(0));
        assertEq(ledger.sumHistoryUpTo(ALICE, uint64(block.number)), int64(0));
        assertEq(ledger.sumHistoryUpTo(ALICE, type(uint64).max), int64(0));
    }

    function test_sumHistoryUpTo_singleMint_queryAtExactBlock_includes() public {
        _mint(ALICE, 50, "loan_band");
        uint64 mintBlock = uint64(block.number);
        // Boundary: toBlock == event.timestamp. The ledger filter is
        // `e.timestamp > toBlock` -> break, so equal is INCLUDED.
        assertEq(ledger.sumHistoryUpTo(ALICE, mintBlock), int64(50));
    }

    function test_sumHistoryUpTo_singleMint_queryOneBlockBefore_excludes() public {
        // Advance a block first so there's a valid "before" block.
        vm.roll(block.number + 1);
        _mint(ALICE, 50, "loan_band");
        uint64 mintBlock = uint64(block.number);
        assertEq(ledger.sumHistoryUpTo(ALICE, mintBlock - 1), int64(0));
    }

    function test_sumHistoryUpTo_multipleBlocks_signed() public {
        // Build a deterministic, shaped history over known blocks.
        _mint(ALICE, 100, "loan_band"); // @ block B
        uint64 b1 = uint64(block.number);
        vm.roll(block.number + 10);
        vm.prank(INDEXER);
        ledger.burnPoints(ALICE, 30, "loan_default"); // @ b1 + 10
        uint64 b2 = uint64(block.number);
        vm.roll(block.number + 5);
        _mint(ALICE, 20, "transfer_band"); // @ b2 + 5
        uint64 b3 = uint64(block.number);

        // Before any events: 0.
        assertEq(ledger.sumHistoryUpTo(ALICE, b1 - 1), int64(0), "pre-first");
        // After first mint, before burn: 100.
        assertEq(ledger.sumHistoryUpTo(ALICE, b1), int64(100), "first mint only");
        // After burn, before second mint: 70.
        assertEq(ledger.sumHistoryUpTo(ALICE, b2), int64(70), "mint then burn");
        // After second mint: 90.
        assertEq(ledger.sumHistoryUpTo(ALICE, b3), int64(90), "mint+burn+mint");
        // Far future: still 90 (saturating at current state).
        assertEq(ledger.sumHistoryUpTo(ALICE, type(uint64).max), int64(90), "far future");
    }

    function test_sumHistoryUpTo_netNegative_burnsExceedMints() public {
        _mint(ALICE, 30, "loan_band");
        vm.roll(block.number + 1);
        vm.prank(INDEXER);
        ledger.burnPoints(ALICE, 100, "loan_default"); // burns > mints
        // Signed sum must carry the negative through — int64 handles it.
        int64 sum = ledger.sumHistoryUpTo(ALICE, uint64(block.number));
        assertEq(sum, int64(-70), "net negative sum preserved");
    }

    function test_sumHistoryUpTo_burnLockedPointsContributes() public {
        // Exercise the burnLockedPoints path at the ledger level directly,
        // without going through the stake/vouch flow (which has its own
        // MIN_VOUCHER_SCORE gate that isn't relevant here).
        _mint(ALICE, 100, "loan_band"); // history[0]: +100
        // Lock 40 of those points against a synthetic vouchId.
        uint64 syntheticVouchId = 42;
        vm.prank(INDEXER);
        ledger.lockPoints(ALICE, 40, syntheticVouchId);
        // Locking doesn't push a history event — it just moves balance
        // between `available` and `locked`. Sum still 100.
        assertEq(ledger.sumHistoryUpTo(ALICE, uint64(block.number)), int64(100));

        // Now burn the locked portion. This DOES push a burn event with
        // reason "vouch_penalty" and should subtract from the signed sum.
        vm.prank(INDEXER);
        ledger.burnLockedPoints(ALICE, 40, syntheticVouchId);
        assertEq(ledger.sumHistoryUpTo(ALICE, uint64(block.number)), int64(60), "burnLockedPoints lowers signed sum");
    }

    // ========================================================================
    // ScoreRegistry block-anchor — 256-block window boundaries
    // ========================================================================

    function test_propose_anchor_atExact256BoundaryWorks() public {
        // Roll so block.number is well past 256.
        vm.roll(block.number + 500);
        // Oldest valid anchor under the EVM blockhash window is
        // block.number - 256. Anything equal or newer must work.
        uint64 oldest = uint64(block.number - 256);
        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 100, 50, bytes32(0), 0, oldest, 1);
        IScoreRegistry.ScoreProposal memory p = score.getProposal(pid);
        assertEq(p.sourceBlockHeight, oldest);
        assertTrue(p.sourceBlockHash != bytes32(0), "boundary anchor has valid hash");
    }

    function test_propose_anchor_oneBlockTooStaleReverts() public {
        vm.roll(block.number + 500);
        // One block older than the window: blockhash returns 0.
        uint64 tooOld = uint64(block.number - 257);
        vm.expectRevert(IScoreRegistry.StaleSourceBlock.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, tooOld, 1);
    }

    function test_propose_anchor_futureBlockReverts() public {
        vm.roll(block.number + 10);
        uint64 future = uint64(block.number + 1);
        vm.expectRevert(IScoreRegistry.FutureSourceBlock.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, future, 1);
    }

    function test_propose_anchor_currentBlockReverts() public {
        // block.number is "current" — blockhash(current) returns 0, and the
        // `>=` guard rejects it as FutureSourceBlock up-front.
        vm.roll(block.number + 10);
        uint64 current = uint64(block.number);
        vm.expectRevert(IScoreRegistry.FutureSourceBlock.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, current, 1);
    }

    function test_propose_twoConsecutiveProposalsCaptureDifferentHashes() public {
        // Each proposal takes an independent snapshot.
        vm.roll(block.number + 10);
        uint64 anchor1 = uint64(block.number - 1);
        bytes32 expected1 = blockhash(anchor1);

        vm.prank(INDEXER);
        uint64 pid1 = score.proposeScore(ALICE, 100, 50, bytes32(0), 0, anchor1, 1);

        // Advance past MIN_PROPOSAL_INTERVAL so a superseder is allowed.
        vm.roll(block.number + score.MIN_PROPOSAL_INTERVAL() + 1);
        uint64 anchor2 = uint64(block.number - 1);
        bytes32 expected2 = blockhash(anchor2);
        assertTrue(expected2 != expected1, "different block, different hash");

        vm.prank(INDEXER);
        uint64 pid2 = score.proposeScore(ALICE, 150, 75, bytes32(0), 0, anchor2, 1);

        IScoreRegistry.ScoreProposal memory p1 = score.getProposal(pid1);
        IScoreRegistry.ScoreProposal memory p2 = score.getProposal(pid2);
        assertEq(p1.sourceBlockHash, expected1, "first anchor captured");
        assertEq(p2.sourceBlockHash, expected2, "second anchor captured");
        assertTrue(p1.sourceBlockHash != p2.sourceBlockHash, "anchors distinct");
    }

    function test_resolveDispute_correctedFinalizedPreservesAnchor() public {
        // Governance path that writes a corrected FinalizedScore must carry
        // the proposal's anchor through.
        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        bytes32 expected = blockhash(anchor);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);
        ev.eventData = "";
        ev.leafData = "";
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, ev);

        vm.prank(GOV);
        dispute.resolveDispute(did, true, 120, 60);

        ScoreRegistry.FinalizedScore memory f = score.getFullScore(ALICE);
        assertEq(f.sourceBlockHash, expected, "corrected snapshot keeps anchor");
        assertEq(f.sourceBlockHeight, anchor);
    }

    // ========================================================================
    // WrongTotalPointsSum — edge cases
    // ========================================================================

    function test_wrongTotalPointsSum_zeroHistoryZeroClaim_losesBondStaysPending() public {
        // Dispute with NO ledger writes and a proposal that also claims 0.
        // Sum matches (both 0) -> disputer is wrong -> bond forfeited, proposal Pending.
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 0, 0, bytes32(0), 0, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);

        uint256 bobBefore = stable.balanceOf(BOB);
        uint256 treasuryBefore = stable.balanceOf(TREASURY);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        // Proposal stays pending (C-1 pattern preserved).
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending));
        assertEq(p.id, pid);

        // Bond forfeited.
        assertEq(stable.balanceOf(BOB), bobBefore - dispute.DISPUTE_BOND());
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + dispute.DISPUTE_BOND());
    }

    function test_wrongTotalPointsSum_zeroHistoryInflatedClaim_disputerWins() public {
        // No ledger history -> expected sum is 0. Indexer claims 100. Disputer wins.
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(100), 100, bytes32(0), 0, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        // Score corrected to 0 (zero-sum -> 0 score).
        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, 0, "empty ledger -> 0 score");
    }

    function test_wrongTotalPointsSum_historyAfterAnchor_ignored() public {
        // Events after sourceBlockHeight must NOT be counted by the dispute
        // sum — otherwise an indexer could be blamed for future writes.
        _mint(ALICE, 50, "loan_band"); // counted
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1); // anchor before future mint
        bytes32 _unused;
        _unused;

        // Indexer proposes 50 as of the anchor — correct.
        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(50), 50, bytes32(0), 0, anchor, 1);

        // Someone writes ANOTHER mint after the anchor. Should not affect dispute.
        vm.roll(block.number + 2);
        _mint(ALICE, 500, "loan_band");

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);

        // Disputer files WrongTotalPointsSum on the already-submitted proposal.
        // The dispute window is still open (we rolled only 2 blocks). Expected
        // sum up to anchor = 50 (the after-anchor mint at +500 is excluded).
        // So the 50-claim is HONEST -> disputer loses.
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending), "proposal honest");
    }

    function test_wrongTotalPointsSum_netNegativeSumCorrectsToZeroScore() public {
        // Ledger net is negative; canonical score clamps to 0.
        _mint(ALICE, 30, "loan_band");
        vm.roll(block.number + 1);
        vm.prank(INDEXER);
        ledger.burnPoints(ALICE, 100, "loan_default"); // signed sum = -70

        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        // Indexer inflates to 50 instead of -70. Disputer wins.
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 50, 50, bytes32(0), 0, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        // Corrected score = computeScore(-70) = 0 (SPEC clamps negatives).
        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, 0, "negative signed sum clamps to 0");
    }

    function test_wrongTotalPointsSum_correctionReflectsCanonicalCurve() public {
        // Indexer posts an honest totalPoints (100) but wrong score (300).
        // That's actually WrongArithmetic, but we also verify that
        // WrongTotalPointsSum's correction path uses computeScore too.
        _mint(ALICE, 250, "loan_band"); // actual signed sum = 250

        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        // Indexer posts totalPoints=100 (wrong). Score=computeScore(100)=100 (curve-consistent for 100, but wrong for actual 250).
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 100, bytes32(0), 0, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        // Corrected score = computeScore(250) per canonical curve.
        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, ScoreMath.computeScore(int64(250)), "correction via canonical curve");
        assertEq(onchain, 325, "SPEC: 250 pts -> 325 score");
    }

    // ========================================================================
    // Defensive: anchor + total-sum dispute interplay
    // ========================================================================

    function test_wrongTotalPointsSum_afterSupersede_newProposalAnchorUsed() public {
        // After supersede, a subsequent dispute should sum against the NEW
        // anchor, not the old one. This confirms proposal lookup reads the
        // current pending proposal's sourceBlockHeight.
        _mint(ALICE, 50, "loan_band");
        vm.roll(block.number + 1);
        uint64 anchor1 = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(50), 50, bytes32(0), 0, anchor1, 1);

        // More activity after the first proposal.
        vm.roll(block.number + 10);
        _mint(ALICE, 25, "transfer_band"); // signed sum now 75

        // Supersede with a fresh proposal claiming 75.
        vm.roll(block.number + score.MIN_PROPOSAL_INTERVAL());
        uint64 anchor2 = uint64(block.number - 1);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(75), 75, bytes32(0), 0, anchor2, 1);

        IDisputeResolver.DisputeEvidence memory ev;
        ev.merkleProof = new bytes32[](0);

        // Disputer files against the current (superseding) proposal. Actual
        // sum up to anchor2 = 75 -> matches proposal -> disputer loses.
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, ev);

        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending), "newer proposal honest");
    }
}
