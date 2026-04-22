// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Slim interface used by DisputeResolver to interact with the
///         ScoreRegistry during the challenge → resolution flow.
interface IScoreRegistry {
    // Errors
    error ZeroAddress();
    error NotIndexer();
    error NotDisputeResolver();
    error ScoreOverMax();
    error FutureSourceBlock();
    error StaleSourceBlock();
    error TooSoon();
    error DisputePending();
    error NotPending();
    error WindowOpen();
    error WindowClosed();
    error NotDisputed();

    /// @notice Proposal status enum
    enum ProposalStatus {
        None,
        Pending,
        Finalized,
        Disputed,
        Rejected,
        Superseded
    }

    /// @notice Score proposal struct
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

    /// @notice Get pending proposal for an account
    function getPendingProposal(address account) external view returns (ScoreProposal memory);

    /// @notice Mark proposal as disputed
    function markDisputed(address account, uint64 disputeId) external;

    /// @notice Resolve dispute
    function resolveDispute(address account, bool disputerWins, uint64 correctedScore, int64 correctedPoints) external;

    /// @notice Get challenge window
    function CHALLENGE_WINDOW() external view returns (uint64);

    /// @notice Propose a new score for `account`. Callable only by the
    ///         registered indexer/oracle. Returns the on-chain proposalId
    ///         that subsequent events reference.
    function proposeScore(
        address account,
        uint64 score,
        int64 totalPoints,
        bytes32 eventsRoot,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion
    ) external returns (uint64);
}
