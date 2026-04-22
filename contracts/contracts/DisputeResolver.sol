// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IDisputeResolver} from "./interfaces/IDisputeResolver.sol";
import {IPointsLedger} from "./interfaces/IPointsLedger.sol";
import {IScoreRegistry} from "./interfaces/IScoreRegistry.sol";
import {ScoreMath} from "./lib/ScoreMath.sol";

/// @title DisputeResolver
/// @notice Accepts bonded challenges against pending score proposals.
///         `WrongArithmetic` and `WrongTotalPointsSum` auto-resolve on-chain
///         against the canonical curve and the `PointsLedger` history. The
///         semantic claim types (`MissingEvent`, `InvalidEvent`) are resolved
///         by a governance multisig — for `InvalidEvent`, the contract pins
///         the disputed ledger entry by `historyIndex` and verifies it exists
///         within the proposal's anchored window before accepting the bond,
///         so governance only ever sees claims grounded in real ledger state.
contract DisputeResolver is IDisputeResolver, Ownable2Step {
    using SafeERC20 for IERC20;

    /// @notice Dispute bond, scaled to the stablecoin's decimals in the ctor.
    ///         $10 nominal. Refunded on win, forfeited on loss.
    uint128 public immutable DISPUTE_BOND;

    /// @notice Total payout to a winning disputer: bond ($10) + $5 reward.
    ///         The $5 reward comes from this contract's unreserved balance
    ///         (seed with `fundReward`).
    uint128 public immutable DISPUTE_REWARD;

    /// @notice ~12 hours for governance to resolve before the bond can be
    ///         reclaimed by the disputer. (Not enforced in v1; see notes.)
    uint64 public constant RESOLUTION_WINDOW = 3600;

    IScoreRegistry public immutable scoreRegistry;
    IPointsLedger public immutable pointsLedger;
    IERC20 public immutable stablecoin;

    address public governance; // can resolve Missing/Invalid claims manually
    address public treasury; // receives forfeited bonds, funds rewards

    uint64 public nextDisputeId = 1;

    /// @notice Aggregate bonds held for currently-open disputes. Lets a
    ///         winning disputer always reclaim at least their bond even if
    ///         the reward pool is dry, and prevents one dispute's payout from
    ///         cannibalising another's bond.
    uint128 public reservedBonds;

    mapping(uint64 => Dispute) private _disputes;
    mapping(uint64 => DisputeEvidence) private _evidence;
    /// @notice At most one open dispute per proposal. proposalId → disputeId.
    mapping(uint64 => uint64) public openDisputeByProposal;

    event DisputeCreated(
        uint64 indexed disputeId,
        address indexed account,
        uint64 indexed proposalId,
        ClaimType claimType,
        address disputer
    );
    event DisputeResolved(uint64 indexed disputeId, bool disputerWon, address account);
    event IndexerPenalized(uint64 indexed proposalId, string reason);
    event BondForfeited(uint64 indexed disputeId, uint128 amount, address to);
    event BondRefunded(uint64 indexed disputeId, uint128 amount, address to);
    event GovernanceSet(address indexed governance);
    event TreasurySet(address indexed treasury);

    modifier onlyGovernance() {
        if (msg.sender != governance && msg.sender != owner()) revert NotGovernance();
        _;
    }

    constructor(
        address admin_,
        address _scoreRegistry,
        address _pointsLedger,
        address _stablecoin,
        address _treasury,
        uint8 _decimals
    ) Ownable(admin_) {
        if (_scoreRegistry == address(0)) revert ZeroAddress();
        if (_pointsLedger == address(0)) revert ZeroAddress();
        if (_stablecoin == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_decimals > 30) revert DecimalsOutOfRange();
        governance = admin_;
        treasury = _treasury;
        scoreRegistry = IScoreRegistry(_scoreRegistry);
        pointsLedger = IPointsLedger(_pointsLedger);
        stablecoin = IERC20(_stablecoin);

        uint256 unit = 10 ** _decimals;
        DISPUTE_BOND = uint128(10 * unit);
        DISPUTE_REWARD = uint128(15 * unit);
    }

    function setGovernance(address g) external onlyOwner {
        if (g == address(0)) revert ZeroAddress();
        governance = g;
        emit GovernanceSet(g);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    // ─────────────────────── Dispute creation ───────────────────────

    function dispute(address account, ClaimType claimType, DisputeEvidence calldata evidence)
        external
        returns (uint64)
    {
        IScoreRegistry.ScoreProposal memory p = scoreRegistry.getPendingProposal(account);
        if (p.status != IScoreRegistry.ProposalStatus.Pending) revert NoPendingProposal();
        if (block.number >= p.proposedAt + scoreRegistry.CHALLENGE_WINDOW()) revert WindowClosed();
        if (openDisputeByProposal[p.id] != 0) revert AlreadyDisputed();

        // `InvalidEvent` pins an actual `PointsLedger._history[account]` entry
        // by its index. The on-chain guard confirms the entry exists and was
        // visible at the proposal's anchored block — so governance only ever
        // sees claims pointing at real ledger state that could have
        // contributed to the score.
        if (claimType == ClaimType.InvalidEvent) {
            if (evidence.historyIndex >= pointsLedger.historyLength(account)) {
                revert HistoryIndexOutOfBounds();
            }
            IPointsLedger.PointEvent memory e = pointsLedger.historyAt(account, evidence.historyIndex);
            if (e.timestamp > p.sourceBlockHeight) revert EventAfterSourceBlock();
        }

        stablecoin.safeTransferFrom(msg.sender, address(this), DISPUTE_BOND);
        reservedBonds += DISPUTE_BOND;

        uint64 did = nextDisputeId++;
        _disputes[did] = Dispute({
            id: did,
            account: account,
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

        emit DisputeCreated(did, account, p.id, claimType, msg.sender);

        // `WrongArithmetic` and `WrongTotalPointsSum` are both fully checkable
        // on-chain — auto-resolve now. The registry is only marked `Disputed`
        // if the claim actually wins; a losing auto-resolve must NOT collapse
        // the challenge window for honest disputers (audit C-1).
        if (claimType == ClaimType.WrongArithmetic) {
            _autoResolveWrongArithmetic(did);
        } else if (claimType == ClaimType.WrongTotalPointsSum) {
            _autoResolveWrongTotalPointsSum(did);
        } else {
            scoreRegistry.markDisputed(account, did);
        }

        return did;
    }

    function _autoResolveWrongArithmetic(uint64 disputeId) internal {
        Dispute storage d = _disputes[disputeId];
        IScoreRegistry.ScoreProposal memory p = scoreRegistry.getPendingProposal(d.account);

        uint64 canonical = ScoreMath.computeScore(p.totalPoints);
        bool disputerWins = canonical != p.score;

        if (disputerWins) {
            // Winning path: mark disputed → resolve with correction.
            scoreRegistry.markDisputed(d.account, disputeId);
            _settle(disputeId, true, canonical, p.totalPoints);
        } else {
            // Losing path: proposal stays Pending so the remainder of the
            // challenge window is preserved. Bond is forfeited.
            _settleLosingAutoResolve(disputeId);
        }
    }

    /// @dev `WrongTotalPointsSum` catches indexer drift: the proposal's
    ///      `totalPoints` must equal the on-chain ledger's signed sum of
    ///      deltas up to `sourceBlockHeight`. The correction re-derives
    ///      `score` from the true sum via the canonical curve, so this also
    ///      subsumes `WrongArithmetic` on the same transaction.
    function _autoResolveWrongTotalPointsSum(uint64 disputeId) internal {
        Dispute storage d = _disputes[disputeId];
        IScoreRegistry.ScoreProposal memory p = scoreRegistry.getPendingProposal(d.account);

        int64 actualSum = pointsLedger.sumHistoryUpTo(d.account, p.sourceBlockHeight);
        bool disputerWins = actualSum != p.totalPoints;

        if (disputerWins) {
            uint64 correctedScore = ScoreMath.computeScore(actualSum);
            scoreRegistry.markDisputed(d.account, disputeId);
            _settle(disputeId, true, correctedScore, actualSum);
        } else {
            _settleLosingAutoResolve(disputeId);
        }
    }

    function _settleLosingAutoResolve(uint64 disputeId) internal {
        Dispute storage d = _disputes[disputeId];
        d.status = DisputeStatus.ProposerWins;
        d.resolvedAt = uint64(block.number);

        reservedBonds -= d.bond;
        stablecoin.safeTransfer(treasury, d.bond);
        emit BondForfeited(disputeId, d.bond, treasury);

        // Clear the lock so another disputer can still challenge within the
        // remaining window. The ScoreRegistry proposal is untouched — still Pending.
        delete openDisputeByProposal[d.proposalId];
        emit DisputeResolved(disputeId, false, d.account);
    }

    // ─────────────────────── Manual resolution (governance) ───────────────────────

    /// @notice Governance path for MissingEvent / InvalidEvent.
    /// @param  correctedScore Only written if disputerWins and non-zero.
    /// @param  correctedPoints Only written if disputerWins and non-zero.
    function resolveDispute(uint64 disputeId, bool disputerWins, uint64 correctedScore, int64 correctedPoints)
        external
        onlyGovernance
    {
        Dispute storage d = _disputes[disputeId];
        if (d.status != DisputeStatus.Open) revert NotOpen();
        // Auto-resolving claim types settle inside dispute() — governance
        // must not touch them after the fact.
        if (d.claimType == ClaimType.WrongArithmetic) revert AutoResolves();
        if (d.claimType == ClaimType.WrongTotalPointsSum) revert AutoResolves();
        _settle(disputeId, disputerWins, correctedScore, correctedPoints);
    }

    function _settle(uint64 disputeId, bool disputerWins, uint64 correctedScore, int64 correctedPoints) internal {
        Dispute storage d = _disputes[disputeId];

        d.status = disputerWins ? DisputeStatus.DisputerWins : DisputeStatus.ProposerWins;
        d.resolvedAt = uint64(block.number);

        // Release this dispute's bond reservation before paying out so the
        // funds are counted as "available" for this call only.
        reservedBonds -= d.bond;

        if (disputerWins) {
            // Bond + $5 reward. The reward comes from this contract's
            // unreserved balance (seed via `fundReward`); bonds held for OTHER
            // open disputes are excluded. At minimum the disputer receives
            // their own bond back, since we just released it from reservedBonds.
            uint256 bal = stablecoin.balanceOf(address(this));
            uint256 available = bal - reservedBonds;
            uint128 payout = available > DISPUTE_REWARD ? DISPUTE_REWARD : uint128(available);
            stablecoin.safeTransfer(d.disputer, payout);
            emit BondRefunded(disputeId, payout, d.disputer);

            scoreRegistry.resolveDispute(d.account, true, correctedScore, correctedPoints);
            emit IndexerPenalized(d.proposalId, "dispute_won");
        } else {
            stablecoin.safeTransfer(treasury, d.bond);
            emit BondForfeited(disputeId, d.bond, treasury);
            scoreRegistry.resolveDispute(d.account, false, 0, 0);
        }

        // Clear the open-dispute lock so a fresh proposal may be submitted.
        delete openDisputeByProposal[d.proposalId];

        emit DisputeResolved(disputeId, disputerWins, d.account);
    }

    // ─────────────────────── Treasury funding ───────────────────────

    /// @notice Deposit stablecoin to cover reward payouts. Caller needs to
    ///         `approve` first.
    function fundReward(uint256 amount) external {
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
    }

    // ─────────────────────── Views ───────────────────────

    function getDispute(uint64 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    function getEvidence(uint64 disputeId) external view returns (DisputeEvidence memory) {
        return _evidence[disputeId];
    }
}
