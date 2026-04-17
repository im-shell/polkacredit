// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
        bytes32 popId;
        uint64 score;
        int64 totalPoints;
        bytes32 eventsRoot;
        uint32 eventCount;
        uint64 sourceBlockHeight;
        uint16 algorithmVersion;
        uint64 proposedAt;
        address proposer;
        ProposalStatus status;
    }

    function getPendingProposal(bytes32 popId) external view returns (ScoreProposal memory);

    function markDisputed(bytes32 popId, uint64 disputeId) external;

    function resolveDispute(
        bytes32 popId,
        bool disputerWins,
        uint64 correctedScore,
        int64 correctedPoints
    ) external;

    function CHALLENGE_WINDOW() external view returns (uint64);
}
