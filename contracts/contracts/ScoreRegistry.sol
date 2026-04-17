// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IScoreRegistry} from "./interfaces/IScoreRegistry.sol";
import {ScoreMath} from "./lib/ScoreMath.sol";

/// @title ScoreRegistry (optimistic)
/// @notice Optimistic, Merkle-committed score lifecycle.
///
///   propose → (24-h challenge window) → finalize
///            ↘ dispute → resolveDispute → {Finalized | Rejected}
///
/// External consumers read only *finalized* scores. Pending proposals are
/// visible so independent verifiers can challenge them.
contract ScoreRegistry is IScoreRegistry {
    struct FinalizedScore {
        uint64 score;            // 0..850
        int64 totalPoints;       // snapshot at computation time
        bytes32 eventsRoot;      // Merkle root of events used
        uint64 sourceBlockHeight;
        uint64 finalizedAt;      // block when finalized
        uint64 proposalId;       // produced by which proposal
    }

    /// @notice ~24 hours at 12s/block on Polkadot.
    uint64 public constant CHALLENGE_WINDOW = 7200;

    /// @notice ~6 hours; a proposal can be superseded only after this long.
    uint64 public constant MIN_PROPOSAL_INTERVAL = 1800;

    uint64 public constant MAX_SCORE = 850;

    address public admin;
    address public indexer;
    address public disputeResolver;

    uint64 public nextProposalId = 1;

    mapping(bytes32 => FinalizedScore) private _finalized;
    /// @notice Current pending proposal per popId. A popId can have at most
    ///         one Pending or Disputed proposal at a time.
    mapping(bytes32 => ScoreProposal) private _pending;
    /// @notice Full proposal history, indexed by on-chain proposal id.
    mapping(uint64 => ScoreProposal) private _proposals;

    event ScoreProposed(
        uint64 indexed proposalId,
        bytes32 indexed popId,
        uint64 score,
        int64 totalPoints,
        bytes32 eventsRoot,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion,
        uint64 proposedAt
    );
    event ScoreFinalized(
        uint64 indexed proposalId,
        bytes32 indexed popId,
        uint64 score,
        uint64 finalizedAt
    );
    event ScoreDisputed(uint64 indexed proposalId, bytes32 indexed popId, uint64 disputeId);
    event ScoreCorrected(bytes32 indexed popId, uint64 oldScore, uint64 correctedScore);
    event ProposalRejected(uint64 indexed proposalId, bytes32 indexed popId);
    event ProposalSuperseded(uint64 indexed proposalId, bytes32 indexed popId);

    event IndexerSet(address indexed indexer);
    event DisputeResolverSet(address indexed resolver);

    modifier onlyAdmin() {
        require(msg.sender == admin, "ScoreRegistry: not admin");
        _;
    }

    modifier onlyIndexer() {
        require(msg.sender == indexer, "ScoreRegistry: not indexer");
        _;
    }

    modifier onlyDisputeResolver() {
        require(msg.sender == disputeResolver, "ScoreRegistry: not dispute resolver");
        _;
    }

    constructor(address _admin, address _indexer) {
        require(_admin != address(0), "ScoreRegistry: zero admin");
        require(_indexer != address(0), "ScoreRegistry: zero indexer");
        admin = _admin;
        indexer = _indexer;
    }

    function setIndexer(address newIndexer) external onlyAdmin {
        require(newIndexer != address(0), "ScoreRegistry: zero indexer");
        indexer = newIndexer;
        emit IndexerSet(newIndexer);
    }

    function setDisputeResolver(address newResolver) external onlyAdmin {
        require(newResolver != address(0), "ScoreRegistry: zero resolver");
        disputeResolver = newResolver;
        emit DisputeResolverSet(newResolver);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "ScoreRegistry: zero admin");
        admin = newAdmin;
    }

    // ─────────────────────── Proposal lifecycle ───────────────────────

    function proposeScore(
        bytes32 popId,
        uint64 score,
        int64 totalPoints,
        bytes32 eventsRoot,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion
    ) external onlyIndexer returns (uint64) {
        require(popId != bytes32(0), "ScoreRegistry: zero popId");
        require(score <= MAX_SCORE, "ScoreRegistry: score > max");
        require(sourceBlockHeight <= block.number, "ScoreRegistry: future source");

        ScoreProposal storage cur = _pending[popId];
        if (cur.status == ProposalStatus.Pending) {
            // A pending proposal can only be replaced after MIN_PROPOSAL_INTERVAL
            // to prevent the indexer from re-proposing to dodge a challenge.
            require(
                block.number >= cur.proposedAt + MIN_PROPOSAL_INTERVAL,
                "ScoreRegistry: too soon"
            );
            cur.status = ProposalStatus.Superseded;
            _proposals[cur.id].status = ProposalStatus.Superseded;
            emit ProposalSuperseded(cur.id, popId);
        } else if (cur.status == ProposalStatus.Disputed) {
            revert("ScoreRegistry: dispute pending");
        }

        uint64 pid = nextProposalId++;
        ScoreProposal memory p = ScoreProposal({
            id: pid,
            popId: popId,
            score: score,
            totalPoints: totalPoints,
            eventsRoot: eventsRoot,
            eventCount: eventCount,
            sourceBlockHeight: sourceBlockHeight,
            algorithmVersion: algorithmVersion,
            proposedAt: uint64(block.number),
            proposer: msg.sender,
            status: ProposalStatus.Pending
        });
        _pending[popId] = p;
        _proposals[pid] = p;

        emit ScoreProposed(
            pid,
            popId,
            score,
            totalPoints,
            eventsRoot,
            eventCount,
            sourceBlockHeight,
            algorithmVersion,
            uint64(block.number)
        );
        return pid;
    }

    function finalizeScore(bytes32 popId) external {
        ScoreProposal storage p = _pending[popId];
        require(p.status == ProposalStatus.Pending, "ScoreRegistry: not pending");
        require(block.number >= p.proposedAt + CHALLENGE_WINDOW, "ScoreRegistry: window open");

        p.status = ProposalStatus.Finalized;
        _proposals[p.id].status = ProposalStatus.Finalized;

        _finalized[popId] = FinalizedScore({
            score: p.score,
            totalPoints: p.totalPoints,
            eventsRoot: p.eventsRoot,
            sourceBlockHeight: p.sourceBlockHeight,
            finalizedAt: uint64(block.number),
            proposalId: p.id
        });

        emit ScoreFinalized(p.id, popId, p.score, uint64(block.number));

        // Clear the pending slot so a fresh proposal may be accepted.
        delete _pending[popId];
    }

    // ─────────────────────── DisputeResolver hooks ───────────────────────

    function markDisputed(bytes32 popId, uint64 disputeId) external onlyDisputeResolver {
        ScoreProposal storage p = _pending[popId];
        require(p.status == ProposalStatus.Pending, "ScoreRegistry: not pending");
        require(
            block.number < p.proposedAt + CHALLENGE_WINDOW,
            "ScoreRegistry: window closed"
        );
        p.status = ProposalStatus.Disputed;
        _proposals[p.id].status = ProposalStatus.Disputed;
        emit ScoreDisputed(p.id, popId, disputeId);
    }

    function resolveDispute(
        bytes32 popId,
        bool disputerWins,
        uint64 correctedScore,
        int64 correctedPoints
    ) external onlyDisputeResolver {
        ScoreProposal storage p = _pending[popId];
        require(p.status == ProposalStatus.Disputed, "ScoreRegistry: not disputed");

        if (disputerWins) {
            p.status = ProposalStatus.Rejected;
            _proposals[p.id].status = ProposalStatus.Rejected;
            emit ProposalRejected(p.id, popId);

            if (correctedScore > 0 || correctedPoints != 0) {
                uint64 oldScore = _finalized[popId].score;
                _finalized[popId] = FinalizedScore({
                    score: correctedScore,
                    totalPoints: correctedPoints,
                    eventsRoot: p.eventsRoot,
                    sourceBlockHeight: p.sourceBlockHeight,
                    finalizedAt: uint64(block.number),
                    proposalId: p.id
                });
                emit ScoreCorrected(popId, oldScore, correctedScore);
            }
        } else {
            // Dispute failed — the original proposal stands.
            p.status = ProposalStatus.Finalized;
            _proposals[p.id].status = ProposalStatus.Finalized;
            _finalized[popId] = FinalizedScore({
                score: p.score,
                totalPoints: p.totalPoints,
                eventsRoot: p.eventsRoot,
                sourceBlockHeight: p.sourceBlockHeight,
                finalizedAt: uint64(block.number),
                proposalId: p.id
            });
            emit ScoreFinalized(p.id, popId, p.score, uint64(block.number));
        }

        delete _pending[popId];
    }

    // ─────────────────────── Views ───────────────────────

    function getScore(bytes32 popId) external view returns (uint64 score, uint64 updatedAt) {
        FinalizedScore storage s = _finalized[popId];
        return (s.score, s.finalizedAt);
    }

    function getFullScore(bytes32 popId) external view returns (FinalizedScore memory) {
        return _finalized[popId];
    }

    function getPendingProposal(bytes32 popId) external view returns (ScoreProposal memory) {
        return _pending[popId];
    }

    function getProposal(uint64 proposalId) external view returns (ScoreProposal memory) {
        return _proposals[proposalId];
    }

    /// @notice Convenience: is a proposal eligible for finalize()?
    function canFinalize(bytes32 popId) external view returns (bool) {
        ScoreProposal storage p = _pending[popId];
        return
            p.status == ProposalStatus.Pending &&
            block.number >= p.proposedAt + CHALLENGE_WINDOW;
    }

    /// @notice Compute the canonical score from a points total.
    ///         Exposed so clients (UI, dispute path) agree on the mapping.
    function computeScore(int64 totalPoints) external pure returns (uint64) {
        return ScoreMath.computeScore(totalPoints);
    }
}
