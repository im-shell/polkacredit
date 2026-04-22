// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IScoreRegistry} from "./interfaces/IScoreRegistry.sol";
import {ScoreMath} from "./lib/ScoreMath.sol";

/// @title ScoreRegistry (optimistic)
/// @notice Optimistic, block-anchored score lifecycle.
///
///   propose → (CHALLENGE_WINDOW) → finalize
///            ↘ dispute → resolveDispute → {Finalized | Rejected}
///
/// External consumers read only *finalized* scores. Pending proposals are
/// visible so independent verifiers can challenge them. Proposals commit to
/// a `sourceBlockHeight` (+ its captured blockhash); disputes reference the
/// on-chain `PointsLedger` directly — no Merkle root is needed because every
/// event that contributes to the score is already a ledger entry.
contract ScoreRegistry is IScoreRegistry, Ownable2Step {
    struct FinalizedScore {
        uint64 score; // 0..MAX_SCORE
        int64 totalPoints; // snapshot at computation time
        uint64 sourceBlockHeight;
        bytes32 sourceBlockHash; // blockhash(sourceBlockHeight) captured at propose time
        uint64 finalizedAt; // block when finalized
        uint64 proposalId; // produced by which proposal
    }

    /// @notice EVM `blockhash(n)` is only valid for `n >= block.number - 256`.
    ///         `proposeScore` rejects anchors older than this window so the
    ///         captured `sourceBlockHash` is always non-zero.
    uint64 public constant MAX_SOURCE_BLOCK_AGE = 256;

    /// @notice TESTNET DEMO: 10 blocks = ~1 min at 6s/block. For production
    ///         restore to 7200 (~24h on 12s-block chains or ~12h on 6s-block
    ///         chains like Passet Hub) so honest disputers have real time to
    ///         rescan and challenge.
    uint64 public constant CHALLENGE_WINDOW = 10;

    /// @notice TESTNET DEMO: 5 blocks (~30s). Production was 1800 (~6h) so an
    ///         indexer can't bait-and-switch a proposal late in the window.
    uint64 public constant MIN_PROPOSAL_INTERVAL = 5;

    uint64 public constant MAX_SCORE = 850;

    address public indexer;
    address public disputeResolver;

    uint64 public nextProposalId = 1;

    mapping(address => FinalizedScore) private _finalized;
    /// @notice Current pending proposal per account. An account can have at
    ///         most one Pending or Disputed proposal at a time.
    mapping(address => ScoreProposal) private _pending;
    /// @notice Full proposal history, indexed by on-chain proposal id.
    mapping(uint64 => ScoreProposal) private _proposals;

    event ScoreProposed(
        uint64 indexed proposalId,
        address indexed account,
        uint64 score,
        int64 totalPoints,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        bytes32 sourceBlockHash,
        uint16 algorithmVersion,
        uint64 proposedAt
    );
    event ScoreFinalized(uint64 indexed proposalId, address indexed account, uint64 score, uint64 finalizedAt);
    event ScoreDisputed(uint64 indexed proposalId, address indexed account, uint64 disputeId);
    event ScoreCorrected(address indexed account, uint64 oldScore, uint64 correctedScore);
    event ProposalRejected(uint64 indexed proposalId, address indexed account);
    event ProposalSuperseded(uint64 indexed proposalId, address indexed account);

    event IndexerSet(address indexed indexer);
    event DisputeResolverSet(address indexed resolver);

    modifier onlyIndexer() {
        if (msg.sender != indexer) revert NotIndexer();
        _;
    }

    modifier onlyDisputeResolver() {
        if (msg.sender != disputeResolver) revert NotDisputeResolver();
        _;
    }

    constructor(address admin_, address _indexer) Ownable(admin_) {
        if (_indexer == address(0)) revert ZeroAddress();
        indexer = _indexer;
        emit IndexerSet(_indexer);
    }

    function setIndexer(address newIndexer) external onlyOwner {
        if (newIndexer == address(0)) revert ZeroAddress();
        indexer = newIndexer;
        emit IndexerSet(newIndexer);
    }

    function setDisputeResolver(address newResolver) external onlyOwner {
        if (newResolver == address(0)) revert ZeroAddress();
        disputeResolver = newResolver;
        emit DisputeResolverSet(newResolver);
    }

    // ─────────────────────── Proposal lifecycle ───────────────────────

    function proposeScore(
        address account,
        uint64 score,
        int64 totalPoints,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion
    ) external onlyIndexer returns (uint64) {
        if (account == address(0)) revert ZeroAddress();
        if (score > MAX_SCORE) revert ScoreOverMax();
        // `blockhash(block.number)` and `blockhash(future)` both return 0, so
        // require strict past. The anchor is the block the indexer claims the
        // score is a function of — it must exist at propose time.
        if (sourceBlockHeight >= block.number) revert FutureSourceBlock();
        // EVM only retains the last 256 blockhashes. Older anchors cannot be
        // captured, which would defeat the whole point.
        bytes32 sourceBlockHash = blockhash(sourceBlockHeight);
        if (sourceBlockHash == bytes32(0)) revert StaleSourceBlock();

        ScoreProposal storage cur = _pending[account];
        if (cur.status == ProposalStatus.Pending) {
            // A pending proposal can only be replaced after MIN_PROPOSAL_INTERVAL
            // to prevent the indexer from re-proposing to dodge a challenge.
            if (block.number < cur.proposedAt + MIN_PROPOSAL_INTERVAL) revert TooSoon();
            cur.status = ProposalStatus.Superseded;
            _proposals[cur.id].status = ProposalStatus.Superseded;
            emit ProposalSuperseded(cur.id, account);
        } else if (cur.status == ProposalStatus.Disputed) {
            revert DisputePending();
        }

        uint64 pid = nextProposalId++;
        ScoreProposal memory p = ScoreProposal({
            id: pid,
            account: account,
            score: score,
            totalPoints: totalPoints,
            eventCount: eventCount,
            sourceBlockHeight: sourceBlockHeight,
            sourceBlockHash: sourceBlockHash,
            algorithmVersion: algorithmVersion,
            proposedAt: uint64(block.number),
            proposer: msg.sender,
            status: ProposalStatus.Pending
        });
        _pending[account] = p;
        _proposals[pid] = p;

        emit ScoreProposed(
            pid,
            account,
            score,
            totalPoints,
            eventCount,
            sourceBlockHeight,
            sourceBlockHash,
            algorithmVersion,
            uint64(block.number)
        );
        return pid;
    }

    function finalizeScore(address account) external {
        ScoreProposal storage p = _pending[account];
        if (p.status != ProposalStatus.Pending) revert NotPending();
        if (block.number < p.proposedAt + CHALLENGE_WINDOW) revert WindowOpen();

        p.status = ProposalStatus.Finalized;
        _proposals[p.id].status = ProposalStatus.Finalized;

        _finalized[account] = FinalizedScore({
            score: p.score,
            totalPoints: p.totalPoints,
            sourceBlockHeight: p.sourceBlockHeight,
            sourceBlockHash: p.sourceBlockHash,
            finalizedAt: uint64(block.number),
            proposalId: p.id
        });

        emit ScoreFinalized(p.id, account, p.score, uint64(block.number));

        // Clear the pending slot so a fresh proposal may be accepted.
        delete _pending[account];
    }

    // ─────────────────────── DisputeResolver hooks ───────────────────────

    function markDisputed(address account, uint64 disputeId) external onlyDisputeResolver {
        ScoreProposal storage p = _pending[account];
        if (p.status != ProposalStatus.Pending) revert NotPending();
        if (block.number >= p.proposedAt + CHALLENGE_WINDOW) revert WindowClosed();
        p.status = ProposalStatus.Disputed;
        _proposals[p.id].status = ProposalStatus.Disputed;
        emit ScoreDisputed(p.id, account, disputeId);
    }

    function resolveDispute(address account, bool disputerWins, uint64 correctedScore, int64 correctedPoints)
        external
        onlyDisputeResolver
    {
        ScoreProposal storage p = _pending[account];
        if (p.status != ProposalStatus.Disputed) revert NotDisputed();

        if (disputerWins) {
            p.status = ProposalStatus.Rejected;
            _proposals[p.id].status = ProposalStatus.Rejected;
            emit ProposalRejected(p.id, account);

            if (correctedScore > 0 || correctedPoints != 0) {
                uint64 oldScore = _finalized[account].score;
                _finalized[account] = FinalizedScore({
                    score: correctedScore,
                    totalPoints: correctedPoints,
                    sourceBlockHeight: p.sourceBlockHeight,
                    sourceBlockHash: p.sourceBlockHash,
                    finalizedAt: uint64(block.number),
                    proposalId: p.id
                });
                emit ScoreCorrected(account, oldScore, correctedScore);
            }
        } else {
            // Dispute failed — the original proposal stands.
            p.status = ProposalStatus.Finalized;
            _proposals[p.id].status = ProposalStatus.Finalized;
            _finalized[account] = FinalizedScore({
                score: p.score,
                totalPoints: p.totalPoints,
                sourceBlockHeight: p.sourceBlockHeight,
                sourceBlockHash: p.sourceBlockHash,
                finalizedAt: uint64(block.number),
                proposalId: p.id
            });
            emit ScoreFinalized(p.id, account, p.score, uint64(block.number));
        }

        delete _pending[account];
    }

    // ─────────────────────── Views ───────────────────────

    function getScore(address account) external view returns (uint64 score, uint64 updatedAt) {
        FinalizedScore storage s = _finalized[account];
        return (s.score, s.finalizedAt);
    }

    function getFullScore(address account) external view returns (FinalizedScore memory) {
        return _finalized[account];
    }

    function getPendingProposal(address account) external view returns (ScoreProposal memory) {
        return _pending[account];
    }

    function getProposal(uint64 proposalId) external view returns (ScoreProposal memory) {
        return _proposals[proposalId];
    }

    /// @notice Convenience: is a proposal eligible for finalize()?
    function canFinalize(address account) external view returns (bool) {
        ScoreProposal storage p = _pending[account];
        return p.status == ProposalStatus.Pending && block.number >= p.proposedAt + CHALLENGE_WINDOW;
    }

    /// @notice Compute the canonical score from a points total.
    ///         Exposed so clients (UI, dispute path) agree on the mapping.
    function computeScore(int64 totalPoints) external pure returns (uint64) {
        return ScoreMath.computeScore(totalPoints);
    }
}
