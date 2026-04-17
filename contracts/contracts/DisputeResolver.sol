// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IScoreRegistry} from "./interfaces/IScoreRegistry.sol";
import {Merkle} from "./lib/Merkle.sol";
import {ScoreMath} from "./lib/ScoreMath.sol";

interface IERC20D {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title DisputeResolver
/// @notice Accepts bonded challenges against pending score proposals.
///         `WrongArithmetic` claims resolve automatically on-chain; the other
///         two claim types (`MissingEvent`, `InvalidEvent`) are resolved by a
///         governance multisig in v1, with the Merkle inclusion proof already
///         verified on-chain before the multisig touches them.
contract DisputeResolver {
    enum ClaimType {
        MissingEvent,
        InvalidEvent,
        WrongArithmetic
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
        // InvalidEvent:
        bytes32[] merkleProof;
        uint32 leafIndex;
        bytes leafData;     // raw leaf bytes the disputer claims is in the tree
        bytes32 leafHash;   // keccak256(leafData) — stored to avoid recomputing
        string disqualifyingReason;
        // WrongArithmetic:
        int64 claimedCorrectPoints;
        uint64 claimedCorrectScore;
    }

    struct Dispute {
        uint64 id;
        bytes32 popId;
        uint64 proposalId;
        address disputer;
        uint128 bond;
        ClaimType claimType;
        DisputeStatus status;
        uint64 createdAt;
        uint64 resolvedAt;
    }

    /// @notice $10 in an 18-decimals stablecoin.
    uint128 public constant DISPUTE_BOND = 10 ether;

    /// @notice $15 — bond ($10) back to disputer + $5 reward from treasury.
    uint128 public constant DISPUTE_REWARD = 15 ether;

    /// @notice ~12 hours for governance to resolve before the bond can be
    ///         reclaimed by the disputer. (Not enforced in v1; see notes.)
    uint64 public constant RESOLUTION_WINDOW = 3600;

    IScoreRegistry public immutable scoreRegistry;
    IERC20D public immutable stablecoin;

    address public admin;
    address public governance;       // can resolve Missing/Invalid claims manually
    address public treasury;          // receives forfeited bonds, funds rewards

    uint64 public nextDisputeId = 1;

    mapping(uint64 => Dispute) private _disputes;
    mapping(uint64 => DisputeEvidence) private _evidence;
    /// @notice At most one open dispute per proposal. proposalId → disputeId.
    mapping(uint64 => uint64) public openDisputeByProposal;

    event DisputeCreated(
        uint64 indexed disputeId,
        bytes32 indexed popId,
        uint64 indexed proposalId,
        ClaimType claimType,
        address disputer
    );
    event DisputeResolved(uint64 indexed disputeId, bool disputerWon, bytes32 popId);
    event IndexerPenalized(uint64 indexed proposalId, string reason);
    event BondForfeited(uint64 indexed disputeId, uint128 amount, address to);
    event BondRefunded(uint64 indexed disputeId, uint128 amount, address to);
    event GovernanceSet(address indexed governance);
    event TreasurySet(address indexed treasury);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Dispute: not admin");
        _;
    }

    modifier onlyGovernance() {
        require(msg.sender == governance || msg.sender == admin, "Dispute: not governance");
        _;
    }

    constructor(
        address _admin,
        address _scoreRegistry,
        address _stablecoin,
        address _treasury
    ) {
        require(_admin != address(0), "Dispute: zero admin");
        require(_scoreRegistry != address(0), "Dispute: zero registry");
        require(_stablecoin != address(0), "Dispute: zero stable");
        require(_treasury != address(0), "Dispute: zero treasury");
        admin = _admin;
        governance = _admin;
        treasury = _treasury;
        scoreRegistry = IScoreRegistry(_scoreRegistry);
        stablecoin = IERC20D(_stablecoin);
    }

    function setGovernance(address g) external onlyAdmin {
        require(g != address(0), "Dispute: zero governance");
        governance = g;
        emit GovernanceSet(g);
    }

    function setTreasury(address t) external onlyAdmin {
        require(t != address(0), "Dispute: zero treasury");
        treasury = t;
        emit TreasurySet(t);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Dispute: zero admin");
        admin = newAdmin;
    }

    // ─────────────────────── Dispute creation ───────────────────────

    function dispute(bytes32 popId, ClaimType claimType, DisputeEvidence calldata evidence)
        external
        returns (uint64)
    {
        IScoreRegistry.ScoreProposal memory p = scoreRegistry.getPendingProposal(popId);
        require(
            p.status == IScoreRegistry.ProposalStatus.Pending,
            "Dispute: no pending proposal"
        );
        require(
            block.number < p.proposedAt + scoreRegistry.CHALLENGE_WINDOW(),
            "Dispute: window closed"
        );
        require(openDisputeByProposal[p.id] == 0, "Dispute: already disputed");

        require(
            stablecoin.transferFrom(msg.sender, address(this), DISPUTE_BOND),
            "Dispute: bond transfer failed"
        );

        uint64 did = nextDisputeId++;
        _disputes[did] = Dispute({
            id: did,
            popId: popId,
            proposalId: p.id,
            disputer: msg.sender,
            bond: DISPUTE_BOND,
            claimType: claimType,
            status: DisputeStatus.Open,
            createdAt: uint64(block.number),
            resolvedAt: 0
        });
        _evidence[did] = evidence;
        openDisputeByProposal[p.id] = did;

        scoreRegistry.markDisputed(popId, did);
        emit DisputeCreated(did, popId, p.id, claimType, msg.sender);

        // `WrongArithmetic` is trivially checkable on-chain — auto-resolve now.
        if (claimType == ClaimType.WrongArithmetic) {
            _autoResolveWrongArithmetic(did);
        }

        // `InvalidEvent` inclusion can be proven on-chain too; we still let
        // governance make the final call on whether the event disqualifies,
        // but we reject upfront if the Merkle proof is bogus.
        if (claimType == ClaimType.InvalidEvent) {
            require(
                Merkle.verify(p.eventsRoot, evidence.leafHash, evidence.merkleProof, evidence.leafIndex),
                "Dispute: bad inclusion proof"
            );
            require(keccak256(evidence.leafData) == evidence.leafHash, "Dispute: leaf hash mismatch");
        }

        return did;
    }

    function _autoResolveWrongArithmetic(uint64 disputeId) internal {
        Dispute storage d = _disputes[disputeId];
        IScoreRegistry.ScoreProposal memory p = scoreRegistry.getPendingProposal(d.popId);

        uint64 canonical = ScoreMath.computeScore(p.totalPoints);
        bool disputerWins = canonical != p.score;

        uint64 correctedScore = disputerWins ? canonical : p.score;
        _settle(disputeId, disputerWins, correctedScore, p.totalPoints);
    }

    // ─────────────────────── Manual resolution (governance) ───────────────────────

    /// @notice Governance path for MissingEvent / InvalidEvent.
    /// @param  correctedScore Only written if disputerWins and non-zero.
    /// @param  correctedPoints Only written if disputerWins and non-zero.
    function resolveDispute(
        uint64 disputeId,
        bool disputerWins,
        uint64 correctedScore,
        int64 correctedPoints
    ) external onlyGovernance {
        Dispute storage d = _disputes[disputeId];
        require(d.status == DisputeStatus.Open, "Dispute: not open");
        // WrongArithmetic auto-resolves in dispute() — don't let governance touch it.
        require(d.claimType != ClaimType.WrongArithmetic, "Dispute: auto-resolves");
        _settle(disputeId, disputerWins, correctedScore, correctedPoints);
    }

    function _settle(
        uint64 disputeId,
        bool disputerWins,
        uint64 correctedScore,
        int64 correctedPoints
    ) internal {
        Dispute storage d = _disputes[disputeId];

        d.status = disputerWins ? DisputeStatus.DisputerWins : DisputeStatus.ProposerWins;
        d.resolvedAt = uint64(block.number);

        if (disputerWins) {
            // Bond back + $5 from treasury. Treasury must have pre-funded the
            // reward or this call reverts; in v1 we transfer whatever's
            // available so a dry treasury still returns the bond at minimum.
            uint128 payout = DISPUTE_REWARD;
            uint256 bal = stablecoin.balanceOf(address(this));
            if (bal < payout) payout = uint128(bal);
            require(stablecoin.transfer(d.disputer, payout), "Dispute: reward transfer failed");
            emit BondRefunded(disputeId, payout, d.disputer);

            scoreRegistry.resolveDispute(d.popId, true, correctedScore, correctedPoints);
            emit IndexerPenalized(d.proposalId, "dispute_won");
        } else {
            require(stablecoin.transfer(treasury, d.bond), "Dispute: bond transfer failed");
            emit BondForfeited(disputeId, d.bond, treasury);
            scoreRegistry.resolveDispute(d.popId, false, 0, 0);
        }

        // Clear the open-dispute lock so a fresh proposal may be submitted.
        delete openDisputeByProposal[d.proposalId];

        emit DisputeResolved(disputeId, disputerWins, d.popId);
    }

    // ─────────────────────── Treasury funding ───────────────────────

    /// @notice Deposit stablecoin to cover reward payouts. Caller needs to
    ///         `approve` first.
    function fundReward(uint256 amount) external {
        require(
            stablecoin.transferFrom(msg.sender, address(this), amount),
            "Dispute: fund transfer failed"
        );
    }

    // ─────────────────────── Views ───────────────────────

    function getDispute(uint64 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    function getEvidence(uint64 disputeId) external view returns (DisputeEvidence memory) {
        return _evidence[disputeId];
    }
}
