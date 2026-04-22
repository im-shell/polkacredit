// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {BaseTest} from "./Base.t.sol";
import {DisputeResolver} from "../contracts/DisputeResolver.sol";
import {IDisputeResolver} from "../contracts/interfaces/IDisputeResolver.sol";
import {IScoreRegistry} from "../contracts/interfaces/IScoreRegistry.sol";
import {ScoreMath} from "../contracts/lib/ScoreMath.sol";
import {ScoreRegistry} from "../contracts/ScoreRegistry.sol";

/// @dev 6-decimal stablecoin (USDC-shaped) used in C-2 regression.
contract MockStable6 is ERC20 {
    constructor() ERC20("USDC Mock", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

contract DisputeResolverTest is BaseTest {
    function _emptyEvidence() internal pure returns (IDisputeResolver.DisputeEvidence memory ev) {
        ev.eventData = "";
    }

    // ─────────────────────── WrongArithmetic auto-resolve ───────────────────────

    function test_wrongArithmetic_disputerWins_correctsScoreAndPaysReward() public {
        // Canonical for 145 points is 167 (SPEC.md §4). Indexer publishes 300 — wrong.
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 300, 145, 0, 0, 1);

        uint256 treasuryBefore = stable.balanceOf(TREASURY);
        uint256 bobBefore = stable.balanceOf(BOB);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongArithmetic, _emptyEvidence());

        // Proposal cleared, score corrected.
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.None));
        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, ScoreMath.computeScore(145));
        assertEq(onchain, 167);

        // Bob got bond back ($10) + reward ($5) = $15.
        assertEq(stable.balanceOf(BOB), bobBefore - dispute.DISPUTE_BOND() + dispute.DISPUTE_REWARD());
        // Treasury untouched — bond went back to Bob, reward from vault.
        assertEq(stable.balanceOf(TREASURY), treasuryBefore);
    }

    function test_wrongArithmetic_disputerLoses_bondForfeited() public {
        // Canonical for 145 is 167; indexer submits 167 — correct.
        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 167, 145, 0, 0, 1);

        uint256 treasuryBefore = stable.balanceOf(TREASURY);
        uint256 bobBefore = stable.balanceOf(BOB);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongArithmetic, _emptyEvidence());

        // Audit C-1: a losing auto-resolve must NOT early-finalize the
        // proposal — the challenge window is preserved for honest disputers.
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending), "proposal stays Pending");
        assertEq(p.id, pid);
        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, 0, "nothing finalized yet");

        assertEq(stable.balanceOf(BOB), bobBefore - dispute.DISPUTE_BOND(), "bond forfeited");
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + dispute.DISPUTE_BOND(), "bond to treasury");
    }

    function test_wrongArithmetic_disputeDataMatchesSettlement() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 300, 145, 0, 0, 1);
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongArithmetic, _emptyEvidence());

        IDisputeResolver.Dispute memory d = dispute.getDispute(did);
        assertEq(uint8(d.status), uint8(IDisputeResolver.DisputeStatus.DisputerWins));
        assertEq(d.bond, dispute.DISPUTE_BOND());
        assertEq(d.disputer, BOB);
    }

    // ─────────────────────── Governance path ───────────────────────

    function test_governance_resolvesInDisputerFavor() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);

        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        vm.prank(GOV);
        dispute.resolveDispute(did, true, 120, 60);

        (uint64 s,) = score.getScore(ALICE);
        assertEq(s, 120);

        IDisputeResolver.Dispute memory d = dispute.getDispute(did);
        assertEq(uint8(d.status), uint8(IDisputeResolver.DisputeStatus.DisputerWins));
    }

    function test_governance_resolvesInProposerFavor() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        vm.prank(GOV);
        dispute.resolveDispute(did, false, 0, 0);

        (uint64 s,) = score.getScore(ALICE);
        assertEq(s, 100, "original stands, finalized");
    }

    function test_governance_cannotOverrideWrongArithmetic() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 300, 145, 0, 0, 1);
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongArithmetic, _emptyEvidence());

        vm.expectRevert(IDisputeResolver.NotOpen.selector);
        vm.prank(GOV);
        dispute.resolveDispute(did, true, 0, 0);
    }

    function test_governance_nonOpenReverts() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        vm.prank(GOV);
        dispute.resolveDispute(did, true, 0, 0);
        vm.expectRevert(IDisputeResolver.NotOpen.selector);
        vm.prank(GOV);
        dispute.resolveDispute(did, true, 0, 0);
    }

    function test_governance_notGovReverts() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        vm.expectRevert(IDisputeResolver.NotGovernance.selector);
        vm.prank(CARA);
        dispute.resolveDispute(did, true, 0, 0);
    }

    // ─────────────────────── Preconditions ───────────────────────

    function test_dispute_noPendingReverts() public {
        vm.expectRevert(IDisputeResolver.NoPendingProposal.selector);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());
    }

    function test_dispute_doubleReverts() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        // Second dispute: proposal is now Disputed, not Pending.
        vm.expectRevert(IDisputeResolver.NoPendingProposal.selector);
        vm.prank(CARA);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());
    }

    function test_dispute_afterWindowReverts() public {
        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.roll(block.number + score.CHALLENGE_WINDOW() + 1);

        vm.expectRevert(IDisputeResolver.WindowClosed.selector);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());
    }

    // ─────────────────────── InvalidEvent history-index guard ───────────────────────

    function test_invalidEvent_rejectsHistoryIndexOutOfBounds() public {
        // ALICE has one ledger entry (index 0). Claim index 1 — out of range.
        _mint(ALICE, 50, "loan_band");
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 1, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev = _emptyEvidence();
        ev.historyIndex = 1; // history length is 1; valid is 0
        ev.disqualifyingReason = "fabricated";

        vm.expectRevert(IDisputeResolver.HistoryIndexOutOfBounds.selector);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.InvalidEvent, ev);
    }

    function test_invalidEvent_rejectsEventAfterSourceBlock() public {
        // Two ledger entries — the second is after the proposal's anchor, so
        // it could not have contributed to the score. Disputing it must revert.
        _mint(ALICE, 50, "loan_band");
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 1, anchor, 1);

        // Second mint lands AFTER the anchor.
        _mint(ALICE, 10, "transfer_band");

        IDisputeResolver.DisputeEvidence memory ev = _emptyEvidence();
        ev.historyIndex = 1; // entry exists, but post-dates the anchor
        ev.disqualifyingReason = "not_in_anchored_window";

        vm.expectRevert(IDisputeResolver.EventAfterSourceBlock.selector);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.InvalidEvent, ev);
    }

    function test_invalidEvent_validEntryOpensDispute() public {
        // ALICE has one ledger entry, visible at the proposal anchor.
        _mint(ALICE, 50, "loan_band");
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 1, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev = _emptyEvidence();
        ev.historyIndex = 0;
        ev.disqualifyingReason = "amount_below_minimum";

        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.InvalidEvent, ev);

        IDisputeResolver.Dispute memory d = dispute.getDispute(did);
        assertEq(uint8(d.status), uint8(IDisputeResolver.DisputeStatus.Open));

        vm.prank(GOV);
        dispute.resolveDispute(did, true, 0, 0);

        // Pending cleared even without a corrected score.
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.None));
    }

    // ─────────────────────── Treasury funding ───────────────────────

    function test_fundReward_increasesResolverBalance() public {
        uint256 before = stable.balanceOf(address(dispute));
        vm.startPrank(ALICE);
        stable.approve(address(dispute), 200 ether);
        dispute.fundReward(200 ether);
        vm.stopPrank();
        assertEq(stable.balanceOf(address(dispute)), before + 200 ether);
    }

    function test_setGovernance_onlyOwner() public {
        vm.expectRevert();
        vm.prank(ALICE);
        dispute.setGovernance(address(0xbeef));
    }

    function test_setTreasury_onlyOwner() public {
        vm.expectRevert();
        vm.prank(ALICE);
        dispute.setTreasury(address(0xbeef));
    }

    // ─────────────────────── WrongTotalPointsSum auto-resolve (Layer A) ───────────────────────

    /// @notice Happy path: the indexer posts a `totalPoints` that doesn't match
    ///         the on-chain ledger sum up to `sourceBlockHeight`. A disputer
    ///         files `WrongTotalPointsSum` and the contract auto-resolves
    ///         against the proposer, correcting the score to
    ///         `ScoreMath.computeScore(ledgerSum)`.
    function test_wrongTotalPointsSum_disputerWinsWhenProposerLies() public {
        // Stage: ledger has real +50 for ALICE, but the indexer claims +200.
        _mint(ALICE, 50, "loan_band");

        // Anchor must be a past block with non-zero blockhash.
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(200), 200, 0, anchor, 1);

        uint256 bobBefore = stable.balanceOf(BOB);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, _emptyEvidence());

        // Score is corrected to what the ledger actually says.
        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, ScoreMath.computeScore(50), "score rebuilt from ledger sum");
        assertEq(onchain, 50, "segment1: 50 pts -> 50 score");

        // Pending slot is cleared.
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.None));

        // Bond + reward to disputer (pool is funded in BaseTest).
        assertEq(stable.balanceOf(BOB), bobBefore - dispute.DISPUTE_BOND() + dispute.DISPUTE_REWARD(), "disputer paid");
    }

    /// @notice If the posted `totalPoints` matches ledger sum, the dispute
    ///         loses and the bond is forfeited. Crucially the proposal stays
    ///         Pending (C-1 parity) so honest disputers still have the window.
    function test_wrongTotalPointsSum_disputerLosesWhenProposerIsHonest() public {
        _mint(ALICE, 50, "loan_band");
        _mint(ALICE, 40, "transfer_band");
        // Ledger sum: 90 (positives only here, so signed sum == 90).

        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, ScoreMath.computeScore(90), 90, 0, anchor, 1);

        uint256 treasuryBefore = stable.balanceOf(TREASURY);
        uint256 bobBefore = stable.balanceOf(BOB);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, _emptyEvidence());

        // Proposal stays pending — honest challenge window preserved.
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending));
        assertEq(p.id, pid);

        // Bond forfeited.
        assertEq(stable.balanceOf(BOB), bobBefore - dispute.DISPUTE_BOND());
        assertEq(stable.balanceOf(TREASURY), treasuryBefore + dispute.DISPUTE_BOND());
    }

    /// @notice Ledger sum handles signed deltas — burns pull the sum below the
    ///         raw mint total.
    function test_wrongTotalPointsSum_respectsBurnsInSignedSum() public {
        _mint(ALICE, 100, "loan_band");
        // Burn 30 — signed sum drops to 70.
        vm.prank(INDEXER);
        ledger.burnPoints(ALICE, 30, "loan_default");

        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        // Indexer incorrectly claims 100 (forgot to account for the burn).
        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(100), 100, 0, anchor, 1);

        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, _emptyEvidence());

        (uint64 onchain,) = score.getScore(ALICE);
        assertEq(onchain, ScoreMath.computeScore(70), "signed sum subtracts burn");
        assertEq(onchain, 70);
    }

    /// @notice Governance cannot override a WrongTotalPointsSum dispute (same
    ///         guard as WrongArithmetic).
    function test_wrongTotalPointsSum_governanceCannotOverride() public {
        _mint(ALICE, 50, "loan_band");
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, ScoreMath.computeScore(200), 200, 0, anchor, 1);

        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongTotalPointsSum, _emptyEvidence());

        // Already auto-resolved → governance touches it at their peril.
        vm.expectRevert(IDisputeResolver.NotOpen.selector);
        vm.prank(GOV);
        dispute.resolveDispute(did, true, 0, 0);
    }

    // ─────────────────────── Audit regressions ───────────────────────

    /// @notice C-1: A losing WrongArithmetic auto-resolve must NOT early-finalize
    ///         the proposal — the remainder of the challenge window is preserved.
    function test_regression_C1_losingAutoResolveKeepsProposalPending() public {
        vm.prank(INDEXER);
        uint64 pid = score.proposeScore(ALICE, 167, 145, 0, 0, 1);

        // Bob files a bad-faith WrongArithmetic claim (arithmetic is actually right).
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.WrongArithmetic, _emptyEvidence());

        // Proposal remains disputable and unfinalized.
        IScoreRegistry.ScoreProposal memory p = score.getPendingProposal(ALICE);
        assertEq(uint8(p.status), uint8(IScoreRegistry.ProposalStatus.Pending));
        assertEq(p.id, pid);
        assertFalse(score.canFinalize(ALICE), "challenge window not elapsed");

        // A subsequent honest disputer can now contest and win via governance.
        vm.prank(CARA);
        uint64 did2 = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        vm.prank(GOV);
        dispute.resolveDispute(did2, true, 250, 200);

        (uint64 finalScore,) = score.getScore(ALICE);
        assertEq(finalScore, 250, "honest disputer's correction stands");
    }

    /// @notice C-2: Bond and reward scale with stablecoin decimals.
    function test_regression_C2_bondScalesWithDecimals() public {
        // 18-decimal (the existing deployment)
        assertEq(dispute.DISPUTE_BOND(), 10 * 10 ** 18);
        assertEq(dispute.DISPUTE_REWARD(), 15 * 10 ** 18);

        // 6-decimal deployment (USDC-shaped)
        MockStable6 usdc = new MockStable6();
        ScoreRegistry s2 = new ScoreRegistry(ADMIN, INDEXER);
        DisputeResolver d6 = new DisputeResolver(ADMIN, address(s2), address(ledger), address(usdc), TREASURY, 6);
        assertEq(d6.DISPUTE_BOND(), 10 * 10 ** 6);
        assertEq(d6.DISPUTE_REWARD(), 15 * 10 ** 6);
    }

    /// @notice C-2: Ctor rejects absurd decimals that would overflow uint128.
    function test_regression_C2_ctorRejectsHugeDecimals() public {
        MockStable6 usdc = new MockStable6();
        ScoreRegistry s2 = new ScoreRegistry(ADMIN, INDEXER);
        vm.expectRevert(IDisputeResolver.DecimalsOutOfRange.selector);
        new DisputeResolver(ADMIN, address(s2), address(ledger), address(usdc), TREASURY, 31);
    }

    /// @notice H-2: Two concurrent winning disputes must not cannibalise each
    ///         other's bond. Each disputer receives at minimum their bond back.
    function test_regression_H2_concurrentDisputesDontCannibalize() public {
        // Fresh DisputeResolver with NO reward-pool prefund, so the only
        // balance is whatever bonds disputers post.
        ScoreRegistry s2 = new ScoreRegistry(ADMIN, INDEXER);
        DisputeResolver d2 = new DisputeResolver(ADMIN, address(s2), address(ledger), address(stable), TREASURY, 18);
        vm.prank(ADMIN);
        s2.setDisputeResolver(address(d2));
        vm.prank(ADMIN);
        d2.setGovernance(GOV);

        // Approvals against the fresh resolver.
        vm.prank(BOB);
        stable.approve(address(d2), type(uint256).max);
        vm.prank(CARA);
        stable.approve(address(d2), type(uint256).max);

        uint128 BOND = d2.DISPUTE_BOND();

        // Two independent proposals.
        vm.prank(INDEXER);
        s2.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.prank(INDEXER);
        s2.proposeScore(BOB, 100, 50, 0, 0, 1);

        // Two concurrent MissingEvent disputes (don't auto-resolve).
        vm.prank(BOB);
        uint64 did1 = d2.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());
        vm.prank(CARA);
        uint64 did2 = d2.dispute(BOB, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        assertEq(d2.reservedBonds(), uint256(BOND) * 2, "both bonds reserved");
        assertEq(stable.balanceOf(address(d2)), uint256(BOND) * 2, "contract holds both bonds");

        uint256 bobBefore = stable.balanceOf(BOB);
        uint256 caraBefore = stable.balanceOf(CARA);

        // Both disputers win. Reward pool is empty, so each gets *exactly* their
        // bond ($10) — never less. Under the old buggy code, the first winner
        // would have drained $15 (bond + reward borrowed from the other's bond),
        // leaving the second with only $5.
        vm.prank(GOV);
        d2.resolveDispute(did1, true, 200, 100);
        vm.prank(GOV);
        d2.resolveDispute(did2, true, 200, 100);

        assertEq(stable.balanceOf(BOB), bobBefore + BOND, "bob gets bond back");
        assertEq(stable.balanceOf(CARA), caraBefore + BOND, "cara gets bond back");
        assertEq(d2.reservedBonds(), 0);
    }

    /// @notice H-2: With a funded reward pool, both winning disputers receive
    ///         the full bond+reward without one being shorted.
    function test_regression_H2_bothWinnersGetFullRewardWhenPoolFunded() public {
        // Use the BaseTest `dispute` which is prefunded with 1000 ether.
        uint128 BOND = dispute.DISPUTE_BOND();
        uint128 REWARD = dispute.DISPUTE_REWARD();

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);
        vm.prank(INDEXER);
        score.proposeScore(BOB, 100, 50, 0, 0, 1);

        vm.prank(BOB);
        uint64 did1 = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());
        vm.prank(CARA);
        uint64 did2 = dispute.dispute(BOB, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());

        assertEq(dispute.reservedBonds(), uint256(BOND) * 2);

        uint256 bobBefore = stable.balanceOf(BOB);
        uint256 caraBefore = stable.balanceOf(CARA);

        vm.prank(GOV);
        dispute.resolveDispute(did1, true, 200, 100);
        vm.prank(GOV);
        dispute.resolveDispute(did2, true, 200, 100);

        assertEq(stable.balanceOf(BOB), bobBefore + REWARD);
        assertEq(stable.balanceOf(CARA), caraBefore + REWARD);
        assertEq(dispute.reservedBonds(), 0);
    }

    /// @notice H-4: InvalidEvent dispute rejects a historyIndex at or beyond
    ///         the ledger's history length for that account.
    function test_regression_H4_historyIndexOutOfBoundsReverts() public {
        // Two ledger entries for ALICE, so valid indices are {0, 1}.
        _mint(ALICE, 30, "loan_band");
        _mint(ALICE, 20, "transfer_band");
        vm.roll(block.number + 1);
        uint64 anchor = uint64(block.number - 1);

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 2, anchor, 1);

        IDisputeResolver.DisputeEvidence memory ev = _emptyEvidence();
        ev.historyIndex = 2; // == historyLength → out of range

        vm.expectRevert(IDisputeResolver.HistoryIndexOutOfBounds.selector);
        vm.prank(BOB);
        dispute.dispute(ALICE, IDisputeResolver.ClaimType.InvalidEvent, ev);
    }

    /// @notice H-2 sanity: bond is released from reservedBonds on governance loss too.
    function test_regression_H2_reservedReleasedOnProposerWin() public {
        uint128 BOND = dispute.DISPUTE_BOND();

        vm.prank(INDEXER);
        score.proposeScore(ALICE, 100, 50, 0, 0, 1);

        vm.prank(BOB);
        uint64 did = dispute.dispute(ALICE, IDisputeResolver.ClaimType.MissingEvent, _emptyEvidence());
        assertEq(dispute.reservedBonds(), BOND);

        vm.prank(GOV);
        dispute.resolveDispute(did, false, 0, 0);
        assertEq(dispute.reservedBonds(), 0);
    }
}
