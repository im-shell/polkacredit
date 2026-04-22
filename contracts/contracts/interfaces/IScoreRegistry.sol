// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Slim interface used by DisputeResolver to interact with the
///         ScoreRegistry during the challenge → resolution flow.
interface IScoreRegistry {
    enum ProposalStatus {
        None,
        Pending,
        Finalized,
        Disputed,
        Rejected,
        Superseded
    }

    struct ScoreProposal {
        uint64 id;
        address account;
        uint64 score;
        int64 totalPoints;
        bytes32 eventsRoot;
        uint32 eventCount;
        uint64 sourceBlockHeight;
        /// @notice `blockhash(sourceBlockHeight)` captured at propose time.
        ///         Anchors the proposal's claimed state to a specific block,
        ///         preventing retroactive block-picking and giving disputers
        ///         a verifiable anchor for receipt / storage proofs.
        bytes32 sourceBlockHash;
        uint16 algorithmVersion;
        uint64 proposedAt;
        address proposer;
        ProposalStatus status;
    }

    function getPendingProposal(address account) external view returns (ScoreProposal memory);

    function markDisputed(address account, uint64 disputeId) external;

    function resolveDispute(address account, bool disputerWins, uint64 correctedScore, int64 correctedPoints) external;

    function CHALLENGE_WINDOW() external view returns (uint64);
}
