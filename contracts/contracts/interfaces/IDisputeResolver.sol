// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @title Dispute Resolver Interface
/// @author Sameer Kumar
/// @notice Interface for the DisputeResolver contract
interface IDisputeResolver {
    error ZeroAddress();
    error DecimalsOutOfRange();
    error NotGovernance();
    error NoPendingProposal();
    error WindowClosed();
    error AlreadyDisputed();
    error HistoryIndexOutOfBounds();
    error EventAfterSourceBlock();
    error NotOpen();
    error AutoResolves();

    enum ClaimType {
        MissingEvent,
        InvalidEvent,
        WrongArithmetic,
        /// @notice The proposal's `totalPoints` doesn't match the signed sum of
        ///         `PointsLedger._history[account]` up to `sourceBlockHeight`.
        ///         Auto-resolves on-chain — no governance or evidence needed.
        WrongTotalPointsSum
    }

    enum DisputeStatus {
        None,
        Open,
        DisputerWins,
        ProposerWins
    }

    /// @dev Evidence for MissingEvent / InvalidEvent / WrongArithmetic claims.
    ///      Fields not relevant to the claim type may be left zero.
    struct DisputeEvidence {
        // MissingEvent:
        uint32 eventSourceChain;
        uint64 eventBlockNumber;
        uint32 eventIndex;
        bytes eventData;
        int64 expectedPoints;
        string expectedReasonCode;
        // InvalidEvent: index into PointsLedger._history[account] that the
        //               disputer claims shouldn't have counted. The on-chain
        //               guard only checks the entry exists and predates the
        //               proposal's sourceBlockHeight; governance decides
        //               whether its content disqualifies the score.
        uint32 historyIndex;
        string disqualifyingReason;
        // WrongArithmetic:
        int64 claimedCorrectPoints;
        uint64 claimedCorrectScore;
    }

    struct Dispute {
        uint64 id;
        address account;
        uint64 proposalId;
        address disputer;
        uint128 bond;
        ClaimType claimType;
        DisputeStatus status;
        uint64 createdAt;
        uint64 resolvedAt;
    }
}
