// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @title VouchRegistry
/// @notice Tiered vouching per SPEC.md §2.2, §2.3, §3.1. Each vouch commits a
///         slice of the voucher's base stake ($1k / $5k / $10k), front-loads
///         points to the vouchee at open, credits the voucher on resolve,
///         and slashes the committed stake on failure.
contract VouchRegistry is Ownable2Step {
    error ZeroAddress();
    error SelfVouch();
    error VoucherNoStake();
    error VoucheeNoStake();
    error InvalidCommitTier();
    error CommitOverTier();
    error ConcurrencyCap();
    error PairExhausted();
    error BelowMinScore();
    error ZeroTier();
    error VoucheeFull();
    error NotActive();
    error WindowOpen();
    error NotReporter();

    enum VouchStatus {
        None,
        Active,
        Succeeded,
        Failed,
        Defaulted
    }

    struct VouchRecord {
        uint64 id;
        address voucher;
        address vouchee;
        uint96 committedStake; // escrowed base-stake slice for this vouch
        uint64 tierPoints; // per-side points at this tier (40 / 60 / 80)
        uint64 creditedToVoucher; // amount actually credited on success (post-truncation)
        uint64 creditedToVouchee; // amount actually credited at open (post-240-ceiling)
        uint64 createdAt;
        uint64 expiresAt;
        VouchStatus status;
    }

    // ─── Constants (SPEC.md §2.2, §2.3, §3.1) ───
    uint64 public constant VOUCH_WINDOW = 2_592_000; // ~6 months at 6s/block
    uint8 public constant MAX_ACTIVE_VOUCHES = 2; // concurrent per voucher
    uint64 public constant MIN_VOUCHER_SCORE = 80; // gatekeeper per §4.2 — forces $1k/$5k stakers to earn activity before vouching; $10k (100 pts) is the only pure-capital pathway
    uint64 public constant VOUCHEE_SUCCESS_THRESHOLD = 50; // in-window pts to resolve success
    uint64 public constant VOUCHER_LIFETIME_CAP = 200; // §2.2
    uint8 public constant MAX_DISTINCT_VOUCHERS_PER_VOUCHEE = 3; // §2.3

    IPointsLedger public immutable pointsLedger;
    IStakingVault public immutable stakingVault;

    address public defaultReporter;

    uint64 public nextVouchId = 1;

    mapping(uint64 => VouchRecord) private _vouches;
    mapping(address => uint64[]) public voucherIndex;
    mapping(address => uint64[]) public voucheeIndex;

    mapping(address => uint8) public activeVouchCount; // voucher -> concurrent open
    mapping(address => uint64) public voucherLifetimeCredited; // credit toward 200 cap
    mapping(address => uint8) public distinctVouchersCount; // vouchee -> # lifetime distinct vouchers
    mapping(address => mapping(address => bool)) public hasVouchedFor; // voucher -> vouchee -> ever

    event VouchCreated(
        uint64 indexed vouchId,
        address indexed voucher,
        address indexed vouchee,
        uint96 committedStake,
        uint64 tierPoints,
        uint64 voucheeFrontLoad,
        uint64 createdAt,
        uint64 expiresAt
    );
    event VouchSucceeded(uint64 indexed vouchId, uint64 voucherCredited);
    event VouchFailed(uint64 indexed vouchId, uint64 voucherPenalty, uint64 voucheeClawback, uint96 slashedStake);
    event VouchDefaulted(uint64 indexed vouchId, address indexed vouchee, uint96 slashedStake);
    event DefaultReporterSet(address indexed reporter);

    constructor(address admin_, address _pointsLedger, address _stakingVault) Ownable(admin_) {
        if (_pointsLedger == address(0)) revert ZeroAddress();
        if (_stakingVault == address(0)) revert ZeroAddress();
        pointsLedger = IPointsLedger(_pointsLedger);
        stakingVault = IStakingVault(_stakingVault);
    }

    function setDefaultReporter(address reporter) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        defaultReporter = reporter;
        emit DefaultReporterSet(reporter);
    }

    // ─────────────────────── Core flows ───────────────────────

    /// @notice Open a vouch for `vouchee`, committing `committedStake` from
    ///         the caller's base stake. Front-loads vouchee points at open.
    function vouch(address vouchee, uint96 committedStake) external returns (uint64) {
        address voucher = msg.sender;
        if (vouchee == address(0)) revert ZeroAddress();
        if (voucher == vouchee) revert SelfVouch();

        if (!stakingVault.hasActiveStake(voucher)) revert VoucherNoStake();
        if (!stakingVault.hasActiveStake(vouchee)) revert VoucheeNoStake();

        // Tier validity + voucher's tier ceiling (commit ≤ base stake).
        if (!stakingVault.isValidStakeTier(committedStake)) revert InvalidCommitTier();
        IStakingVault.StakeRecord memory vs = stakingVault.getStake(voucher);
        if (committedStake > vs.amount) revert CommitOverTier();

        // Concurrency cap.
        if (activeVouchCount[voucher] >= MAX_ACTIVE_VOUCHES) revert ConcurrencyCap();

        // Unique (voucher, vouchee) pair.
        if (hasVouchedFor[voucher][vouchee]) revert PairExhausted();

        // Voucher baseline score gate.
        IPointsLedger.PointsBalance memory bal = pointsLedger.getBalance(voucher);
        if (bal.total < int64(MIN_VOUCHER_SCORE)) revert BelowMinScore();

        uint64 tPoints = stakingVault.tierPoints(committedStake);
        if (tPoints == 0) revert ZeroTier();

        // Vouchee 3-distinct ceiling. Over-cap → silent reject (no front-load,
        // still consumes the (voucher, vouchee) uniqueness slot? NO — revert
        // so the voucher can pick a different vouchee without losing a slot.)
        if (distinctVouchersCount[vouchee] >= MAX_DISTINCT_VOUCHERS_PER_VOUCHEE) revert VoucheeFull();

        uint64 vouchId = nextVouchId++;
        uint64 createdAt = uint64(block.number);
        uint64 expiresAt = createdAt + VOUCH_WINDOW;

        _vouches[vouchId] = VouchRecord({
            id: vouchId,
            voucher: voucher,
            vouchee: vouchee,
            committedStake: committedStake,
            tierPoints: tPoints,
            creditedToVoucher: 0, // filled on resolve
            creditedToVouchee: tPoints, // front-load is always full tier (cap checked via distinct-voucher count)
            createdAt: createdAt,
            expiresAt: expiresAt,
            status: VouchStatus.Active
        });

        voucherIndex[voucher].push(vouchId);
        voucheeIndex[vouchee].push(vouchId);
        activeVouchCount[voucher] += 1;
        distinctVouchersCount[vouchee] += 1;
        hasVouchedFor[voucher][vouchee] = true;

        stakingVault.commitStake(voucher, committedStake);
        stakingVault.extendLock(voucher);

        pointsLedger.mintPoints(vouchee, tPoints, "vouch_received");

        emit VouchCreated(vouchId, voucher, vouchee, committedStake, tPoints, tPoints, createdAt, expiresAt);
        return vouchId;
    }

/// @notice Resolve a vouch after the window closes. If the vouchee earned enough points, credit the voucher.
/// @param vouchId The vouch ID to resolve.
    function resolveVouch(uint64 vouchId) external {
        VouchRecord storage v = _vouches[vouchId];
        if (v.status != VouchStatus.Active) revert NotActive();
        if (block.number < v.expiresAt) revert WindowOpen();

        uint64 earned = pointsLedger.getPointsEarnedInWindow(v.vouchee, v.createdAt, v.expiresAt);

        if (earned >= VOUCHEE_SUCCESS_THRESHOLD) {
            v.status = VouchStatus.Succeeded;

            // Voucher credit, respecting 200 lifetime cap with truncation.
            uint64 already = voucherLifetimeCredited[v.voucher];
            uint64 remaining = already >= VOUCHER_LIFETIME_CAP ? 0 : VOUCHER_LIFETIME_CAP - already;
            uint64 credit = v.tierPoints > remaining ? remaining : v.tierPoints;

            v.creditedToVoucher = credit;
            if (credit > 0) {
                voucherLifetimeCredited[v.voucher] = already + credit;
                pointsLedger.mintPoints(v.voucher, credit, "vouch_given");
            }

            // Return committed stake to voucher.
            stakingVault.uncommitStake(v.voucher, v.committedStake);

            emit VouchSucceeded(vouchId, credit);
        } else {
            v.status = VouchStatus.Failed;

            // SPEC §3.1 vouchee: −1× front-load clawback.
            if (v.creditedToVouchee > 0) {
                pointsLedger.burnPoints(v.vouchee, v.creditedToVouchee, "vouch_received_clawback");
            }

            // SPEC §3.1 voucher: slash committed stake. Per-vouch points
            // credit on Active→Failed is 0, so the "−2× credited" clawback
            // term is 0 here; the deterrent is the full stake slash.
            stakingVault.slashStake(v.voucher, v.committedStake);

            emit VouchFailed(vouchId, 0, v.creditedToVouchee, v.committedStake);
        }

        _decActive(v.voucher);
    }

    /// @notice Report that the vouchee defaulted on an external loan while
    ///         the vouch was active. Applies SPEC §3.1 voucher-side treatment
    ///         (slash committed stake) and clawback of the vouchee's
    ///         front-load. The separate −100 flat loan-default penalty
    ///         (SPEC §3.2) is emitted by the loan protocol's own event stream
    ///         and applied by the indexer, not here.
    ///         Permissioned to the default reporter (indexer) or admin.
    function reportDefault(uint64 vouchId) external {
        if (msg.sender != defaultReporter && msg.sender != owner()) revert NotReporter();
        VouchRecord storage v = _vouches[vouchId];
        if (v.status != VouchStatus.Active) revert NotActive();

        v.status = VouchStatus.Defaulted;

        // Vouchee: clawback front-load received at vouch-open.
        if (v.creditedToVouchee > 0) {
            pointsLedger.burnPoints(v.vouchee, v.creditedToVouchee, "default_vouch_clawback");
        }

        // Voucher: slash committed stake to treasury. No point-clawback
        // because the voucher's per-vouch credit is 0 while status was
        // Active (credit is minted only on success resolve).
        stakingVault.slashStake(v.voucher, v.committedStake);

        emit VouchDefaulted(vouchId, v.vouchee, v.committedStake);
        _decActive(v.voucher);
    }

    function _decActive(address voucher) internal {
        if (activeVouchCount[voucher] > 0) {
            activeVouchCount[voucher] -= 1;
        }
        if (activeVouchCount[voucher] == 0) {
            stakingVault.releaseLock(voucher);
        }
    }

    // ─────────────────────── Views ───────────────────────

    function getVouch(uint64 vouchId) external view returns (VouchRecord memory) {
        return _vouches[vouchId];
    }

    function vouchesMadeBy(address account) external view returns (uint64[] memory) {
        return voucherIndex[account];
    }

    function vouchesReceivedBy(address account) external view returns (uint64[] memory) {
        return voucheeIndex[account];
    }
}
