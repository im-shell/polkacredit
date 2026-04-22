// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseTest} from "./Base.t.sol";
import {IScoreRegistry} from "../contracts/interfaces/IScoreRegistry.sol";
import {ScoreRegistry} from "../contracts/ScoreRegistry.sol";

contract ScoreRegistryTest is BaseTest {
    // ─────────────────────── Access + validation ───────────────────────

    function test_propose_onlyIndexer() public {
        vm.expectRevert(IScoreRegistry.NotIndexer.selector);
        vm.prank(ALICE);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);
    }

    function test_propose_rejectsOverMax() public {
        vm.expectRevert(IScoreRegistry.ScoreOverMax.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 851, 500, bytes32(0), 0, 0, 1);
    }

    function test_propose_rejectsFutureSourceBlock() public {
        vm.expectRevert(IScoreRegistry.FutureSourceBlock.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, uint64(block.number + 1), 1);
    }

    function test_propose_rejectsZeroAccount() public {
        vm.expectRevert(IScoreRegistry.ZeroAddress.selector);
        vm.prank(INDEXER);
        score.proposeScore(address(0), 100, 50, bytes32(0), 0, 0, 1);
    }

    // ─────────────────────── Block-anchor pattern (Layer A) ───────────────────────

    function test_propose_rejectsCurrentBlockAsSource() public {
        // sourceBlockHeight == block.number must revert — `blockhash(current)` is 0.
        vm.expectRevert(IScoreRegistry.FutureSourceBlock.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, uint64(block.number), 1);
    }

    function test_propose_rejectsStaleSourceBlock() public {
        // Advance well past the 256-block blockhash horizon from block 0.
        vm.roll(block.number + 300);
        // An anchor at block 0 is now stale — `blockhash(0)` returns 0.
        vm.expectRevert(IScoreRegistry.StaleSourceBlock.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);
    }

    function test_propose_capturesSourceBlockHash() public {
        // Roll to a block number where `blockhash(n-1)` is obviously defined.
        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        bytes32 expected = blockhash(anchor);
        assertTrue(expected != bytes32(0), "precondition: blockhash non-zero");

        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 100, 50, bytes32(uint256(0xa11ce)), 1, anchor, 1);

        IScoreRegistry.ScoreProposal memory p = score.getProposal(pid);
        assertEq(p.sourceBlockHeight, anchor, "height stored");
        assertEq(p.sourceBlockHash, expected, "hash captured from blockhash()");
    }

    function test_finalize_propagatesSourceBlockHashIntoFinalizedScore() public {
        vm.roll(block.number + 10);
        uint64 anchor = uint64(block.number - 1);
        bytes32 expected = blockhash(anchor);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(uint256(0xb0b)), 1, anchor, 1);
        vm.roll(block.number + score.CHALLENGE_WINDOW());
        score.finalizeScore(ALICE);

        ScoreRegistry.FinalizedScore memory f = score.getFullScore(ALICE);
        assertEq(f.sourceBlockHeight, anchor);
        assertEq(f.sourceBlockHash, expected, "finalized snapshot carries anchor");
    }

    // ─────────────────────── Proposal state ───────────────────────

    function test_propose_putsIntoPending() public {
        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 247, 145, bytes32(uint256(1)), 3, 0, 1);

        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(p.id, pid);
        assertEq(p.score, 247);
        assertEq(p.totalPoints, int64(145));
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending));
        assertEq(p.proposedAt, uint64(block.number));
        assertEq(p.proposer, INDEXER);

        // getScore returns 0 until finalized.
        (uint64 s, uint64 t) = score.getScore(ALICE);
        assertEq(s, 0);
        assertEq(t, 0);
    }

    function test_finalize_windowOpenReverts() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);
        vm.expectRevert(IScoreRegistry.WindowOpen.selector);
        score.finalizeScore(ALICE);
    }

    function test_finalize_afterWindow_promotesAndClears() public {
        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 247, 145, bytes32(uint256(0xdead)), 0, 0, 1);
        vm.roll(block.number + score.CHALLENGE_WINDOW());

        assertTrue(score.canFinalize(ALICE), "canFinalize");
        score.finalizeScore(ALICE);

        (uint64 s, uint64 t) = score.getScore(ALICE);
        assertEq(s, 247);
        assertEq(t, uint64(block.number));

        // Pending slot is cleared — another proposal can come in.
        IScoreRegistry.ScoreProposal memory still = score.getPendingProposal(ALICE);
        assertEq(uint8(still.status), uint8(IScoreRegistry.ProposalStatus.None));

        // History still readable.
        IScoreRegistry.ScoreProposal memory p = score.getProposal(pid);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Finalized));
    }

    // ─────────────────────── Resubmission semantics ───────────────────────

    function test_propose_cannotSupersedeTooSoon() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);
        vm.roll(block.number + score.MIN_PROPOSAL_INTERVAL() - 1);
        // After MIN_PROPOSAL_INTERVAL ≈ 1800 blocks we're outside the 256-block
        // blockhash horizon, so the anchor must be a recent block.
        vm.expectRevert(IScoreRegistry.TooSoon.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 110, 55, bytes32(0), 0, uint64(block.number - 1), 1);
    }

    function test_propose_supersedesAfterInterval() public {
        vm.prank(INDEXER);
        uint64 firstId = score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);
        vm.roll(block.number + score.MIN_PROPOSAL_INTERVAL());

        vm.prank(INDEXER);
        uint64 secondId = score.proposeScore(ALICE, 150, 75, bytes32(0), 0, uint64(block.number - 1), 1);
        assertGt(secondId, firstId);

        IScoreRegistry.ScoreProposal memory old = score.getProposal(firstId);
        assertEq(uint8(old.status), uint8(IScoreRegistry.ProposalStatus.Superseded));

        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(p.id, secondId);
        assertEq(p.score, 150);
    }

    // ─────────────────────── Admin wiring ───────────────────────

    function test_setIndexer_replacesProposer() public {
        address newIndexer = address(0xA11);
        vm.prank(ADMIN);
        score.setIndexer(newIndexer);

        // Old indexer rejected.
        vm.expectRevert(IScoreRegistry.NotIndexer.selector);
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);

        // New indexer accepted.
        vm.prank(newIndexer);
        score.proposeScore(ALICE, 100, 50, bytes32(0), 0, 0, 1);
    }

    function test_setDisputeResolver_onlyOwner() public {
        vm.expectRevert();
        vm.prank(ALICE);
        score.setDisputeResolver(address(0xbeef));
    }

    function test_markDisputed_requiresResolver() public {
        vm.expectRevert(IScoreRegistry.NotDisputeResolver.selector);
        vm.prank(ALICE);
        score.markDisputed(ALICE, 1);
    }

    // ─────────────────────── Canonical computeScore passthrough ───────────────────────

    function test_computeScore_matchesLibrary() public view {
        // Canonical values per SPEC.md §4. Any drift here means the external
        // view no longer matches ScoreMath — external consumers would read
        // inconsistent numbers and dispute auto-resolution would misfire.
        assertEq(score.computeScore(0), 0);
        assertEq(score.computeScore(50), 50);
        assertEq(score.computeScore(100), 100);
        assertEq(score.computeScore(145), 167);
        assertEq(score.computeScore(250), 325);
        assertEq(score.computeScore(500), 550);
        assertEq(score.computeScore(1200), 850);
        assertEq(score.computeScore(-1), 0);
        assertEq(score.computeScore(10_000), 850);
    }
}
