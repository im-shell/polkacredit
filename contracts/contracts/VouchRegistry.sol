// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {PopId} from "./lib/PopId.sol";

/// @title VouchRegistry
/// @notice Manages vouch relationships between stakers. popId is derived
///         directly from msg.sender via PopId.fromAddress (see lib/PopId.sol).
contract VouchRegistry {
    using PopId for address;

    enum VouchStatus {
        None,
        Active,
        Succeeded,
        Failed,
        Defaulted
    }

    struct VouchRecord {
        uint64 id;
        bytes32 voucher;
        bytes32 vouchee;
        uint64 pointsLocked;
        uint64 createdAt;
        uint64 expiresAt;
        VouchStatus status;
    }

    // ─── Constants (from spec §2.2) ───
    uint64 public constant VOUCH_WINDOW = 129600; // ~6 months in 12s blocks
    uint64 public constant POINTS_TO_LOCK = 20;
    uint8 public constant MAX_VOUCHES_PER_MONTH = 3;
    uint64 public constant MIN_VOUCHER_SCORE = 50;
    uint64 public constant VOUCHEE_THRESHOLD = 30;
    uint64 public constant VOUCHER_SUCCESS_REWARD = 5;
    uint64 public constant VOUCHER_DEFAULT_PENALTY = 50;

    /// @notice ~1 month in 12s blocks, used for monthly vouch cap.
    uint64 public constant BLOCKS_PER_MONTH = 216000;

    IPointsLedger public immutable pointsLedger;
    IStakingVault public immutable stakingVault;

    address public admin;
    address public defaultReporter; // indexer or governance

    uint64 public nextVouchId = 1;

    mapping(uint64 => VouchRecord) private _vouches;
    mapping(bytes32 => uint64[]) public voucherIndex;
    mapping(bytes32 => uint64[]) public voucheeIndex;
    mapping(bytes32 => uint64) public activeVouchCount; // voucher popId -> count
    /// @notice Monthly vouch count per voucher. Keyed by (popId, monthBucket).
    mapping(bytes32 => mapping(uint64 => uint8)) public monthlyVouchCount;

    event VouchCreated(
        uint64 indexed vouchId, bytes32 indexed voucher, bytes32 indexed vouchee, uint64 createdAt, uint64 expiresAt
    );
    event VouchSucceeded(uint64 indexed vouchId);
    event VouchFailed(uint64 indexed vouchId);
    event VouchDefaulted(uint64 indexed vouchId, bytes32 indexed vouchee);
    event DefaultReporterSet(address indexed reporter);

    modifier onlyAdmin() {
        require(msg.sender == admin, "VouchRegistry: not admin");
        _;
    }

    constructor(address _admin, address _pointsLedger, address _stakingVault) {
        require(_admin != address(0), "VouchRegistry: zero admin");
        admin = _admin;
        pointsLedger = IPointsLedger(_pointsLedger);
        stakingVault = IStakingVault(_stakingVault);
    }

    function setDefaultReporter(address reporter) external onlyAdmin {
        require(reporter != address(0), "VouchRegistry: zero reporter");
        defaultReporter = reporter;
        emit DefaultReporterSet(reporter);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "VouchRegistry: zero admin");
        admin = newAdmin;
    }

    // ─────────────────────── Core flows ───────────────────────

    function vouch(bytes32 voucheePopId) external returns (uint64) {
        bytes32 voucherPopId = msg.sender.fromAddress();
        require(voucheePopId != bytes32(0), "VouchRegistry: vouchee zero");
        require(voucherPopId != voucheePopId, "VouchRegistry: self vouch");

        require(stakingVault.hasActiveStake(voucherPopId), "VouchRegistry: voucher no stake");
        require(stakingVault.hasActiveStake(voucheePopId), "VouchRegistry: vouchee no stake");

        uint64 monthBucket = uint64(block.number) / BLOCKS_PER_MONTH;
        require(monthlyVouchCount[voucherPopId][monthBucket] < MAX_VOUCHES_PER_MONTH, "VouchRegistry: monthly cap");

        IPointsLedger.PointsBalance memory bal = pointsLedger.getBalance(voucherPopId);
        require(bal.total >= int64(MIN_VOUCHER_SCORE), "VouchRegistry: below min score");
        require(bal.available >= int64(POINTS_TO_LOCK), "VouchRegistry: insufficient available");

        uint64 vouchId = nextVouchId++;
        uint64 createdAt = uint64(block.number);
        uint64 expiresAt = createdAt + VOUCH_WINDOW;

        _vouches[vouchId] = VouchRecord({
            id: vouchId,
            voucher: voucherPopId,
            vouchee: voucheePopId,
            pointsLocked: POINTS_TO_LOCK,
            createdAt: createdAt,
            expiresAt: expiresAt,
            status: VouchStatus.Active
        });

        voucherIndex[voucherPopId].push(vouchId);
        voucheeIndex[voucheePopId].push(vouchId);
        activeVouchCount[voucherPopId] += 1;
        monthlyVouchCount[voucherPopId][monthBucket] += 1;

        pointsLedger.lockPoints(voucherPopId, POINTS_TO_LOCK, vouchId);
        stakingVault.extendLock(voucherPopId);

        emit VouchCreated(vouchId, voucherPopId, voucheePopId, createdAt, expiresAt);
        return vouchId;
    }

    function resolveVouch(uint64 vouchId) external {
        VouchRecord storage v = _vouches[vouchId];
        require(v.status == VouchStatus.Active, "VouchRegistry: not active");
        require(block.number >= v.expiresAt, "VouchRegistry: window open");

        uint64 earned = pointsLedger.getPointsEarnedInWindow(v.vouchee, v.createdAt, v.expiresAt);

        if (earned >= VOUCHEE_THRESHOLD) {
            v.status = VouchStatus.Succeeded;
            pointsLedger.unlockPoints(v.voucher, v.pointsLocked, vouchId);
            pointsLedger.mintPoints(v.voucher, VOUCHER_SUCCESS_REWARD, "vouch_success");
            pointsLedger.mintPoints(v.vouchee, 2, "vouched_for");
            emit VouchSucceeded(vouchId);
        } else {
            v.status = VouchStatus.Failed;
            pointsLedger.burnLockedPoints(v.voucher, v.pointsLocked, vouchId);
            if (earned > 0) {
                pointsLedger.burnPoints(v.vouchee, earned / 2, "vouch_halve");
            }
            emit VouchFailed(vouchId);
        }

        _decActive(v.voucher);
    }

    /// @notice Report that the vouchee defaulted on an external protocol while
    /// a vouch was active. Permissioned to the Indexer or governance.
    function reportDefault(uint64 vouchId) external {
        require(msg.sender == defaultReporter || msg.sender == admin, "VouchRegistry: not reporter");
        VouchRecord storage v = _vouches[vouchId];
        require(v.status == VouchStatus.Active, "VouchRegistry: not active");

        v.status = VouchStatus.Defaulted;

        // Voucher penalty: burn 50 locked points (burnLockedPoints caps the locked
        // portion and burns the rest from available).
        pointsLedger.burnLockedPoints(v.voucher, VOUCHER_DEFAULT_PENALTY, vouchId);

        // Vouchee reset: zero out current positive balance by burning it.
        IPointsLedger.PointsBalance memory vb = pointsLedger.getBalance(v.vouchee);
        if (vb.total > 0) {
            pointsLedger.burnPoints(v.vouchee, uint64(int64(vb.total)), "default");
        }

        emit VouchDefaulted(vouchId, v.vouchee);
        _decActive(v.voucher);
    }

    function _decActive(bytes32 voucher) internal {
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

    function vouchesMadeBy(bytes32 popId) external view returns (uint64[] memory) {
        return voucherIndex[popId];
    }

    function vouchesReceivedBy(bytes32 popId) external view returns (uint64[] memory) {
        return voucheeIndex[popId];
    }
}
