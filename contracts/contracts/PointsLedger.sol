// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";

/// @title PointsLedger
/// @notice Soulbound, per-PoP points accounting. Mint and burn only.
/// @dev All mutations go through authorized contracts (VouchRegistry,
///      ScoreRegistry) or the Indexer. Points are non-transferable.
contract PointsLedger is IPointsLedger {
    struct PointEvent {
        int64 amount; // positive = mint, negative = burn, 0 = marker
        uint64 timestamp; // block number
        uint64 relatedVouchId; // 0 if none
        string reason;
    }

    address public admin;

    /// @notice Addresses allowed to mint/burn/lock. Typically VouchRegistry,
    /// ScoreRegistry, and the indexer signer.
    mapping(address => bool) public authorized;

    mapping(bytes32 => PointsBalance) private _balances;
    mapping(bytes32 => PointEvent[]) private _history;

    /// @notice Locked points per (popId, vouchId). Sum is mirrored in balance.locked.
    mapping(bytes32 => mapping(uint64 => uint64)) public lockedPoints;

    event PointsMinted(bytes32 indexed popId, uint64 amount, string reason);
    event PointsBurned(bytes32 indexed popId, uint64 amount, string reason);
    event PointsLocked(bytes32 indexed popId, uint64 amount, uint64 indexed vouchId);
    event PointsUnlocked(bytes32 indexed popId, uint64 amount, uint64 indexed vouchId);
    event AuthorizedSet(address indexed who, bool enabled);

    modifier onlyAdmin() {
        require(msg.sender == admin, "PointsLedger: not admin");
        _;
    }

    modifier onlyAuthorized() {
        require(authorized[msg.sender], "PointsLedger: not authorized");
        _;
    }

    constructor(address _admin) {
        require(_admin != address(0), "PointsLedger: zero admin");
        admin = _admin;
    }

    function setAuthorized(address who, bool enabled) external onlyAdmin {
        authorized[who] = enabled;
        emit AuthorizedSet(who, enabled);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "PointsLedger: zero admin");
        admin = newAdmin;
    }

    // ─────────────────────── Core mint / burn ───────────────────────

    function mintPoints(bytes32 popId, uint64 amount, string calldata reason) external onlyAuthorized {
        require(popId != bytes32(0), "PointsLedger: zero popId");
        require(amount > 0, "PointsLedger: zero amount");

        PointsBalance storage b = _balances[popId];
        b.total += int64(amount);
        b.earned += amount;
        b.available += int64(amount);
        b.lastUpdated = uint64(block.number);

        _history[popId].push(
            PointEvent({amount: int64(amount), timestamp: uint64(block.number), relatedVouchId: 0, reason: reason})
        );
        emit PointsMinted(popId, amount, reason);
    }

    function burnPoints(bytes32 popId, uint64 amount, string calldata reason) external onlyAuthorized {
        require(popId != bytes32(0), "PointsLedger: zero popId");
        require(amount > 0, "PointsLedger: zero amount");

        PointsBalance storage b = _balances[popId];
        b.total -= int64(amount);
        b.burned += amount;
        b.available -= int64(amount);
        b.lastUpdated = uint64(block.number);

        _history[popId].push(
            PointEvent({amount: -int64(amount), timestamp: uint64(block.number), relatedVouchId: 0, reason: reason})
        );
        emit PointsBurned(popId, amount, reason);
    }

    // ─────────────────────── Vouch lock / unlock ───────────────────────

    function lockPoints(bytes32 popId, uint64 amount, uint64 vouchId) external onlyAuthorized {
        require(popId != bytes32(0), "PointsLedger: zero popId");
        require(vouchId != 0, "PointsLedger: zero vouchId");
        PointsBalance storage b = _balances[popId];
        require(b.available >= int64(amount), "PointsLedger: insufficient available");

        b.locked += amount;
        b.available -= int64(amount);
        b.lastUpdated = uint64(block.number);

        lockedPoints[popId][vouchId] += amount;
        emit PointsLocked(popId, amount, vouchId);
    }

    function unlockPoints(bytes32 popId, uint64 amount, uint64 vouchId) external onlyAuthorized {
        require(lockedPoints[popId][vouchId] >= amount, "PointsLedger: not enough locked");

        PointsBalance storage b = _balances[popId];
        b.locked -= amount;
        b.available += int64(amount);
        b.lastUpdated = uint64(block.number);

        lockedPoints[popId][vouchId] -= amount;
        emit PointsUnlocked(popId, amount, vouchId);
    }

    /// @notice Burn `amount` points. The locked-for-vouchId portion is burned
    /// first; if amount > locked, the excess is burned from the available balance
    /// (this is the "penalty" mechanic).
    function burnLockedPoints(bytes32 popId, uint64 amount, uint64 vouchId) external onlyAuthorized {
        PointsBalance storage b = _balances[popId];
        uint64 currentLocked = lockedPoints[popId][vouchId];
        uint64 lockedPortion = amount > currentLocked ? currentLocked : amount;

        if (lockedPortion > 0) {
            b.locked -= lockedPortion;
            lockedPoints[popId][vouchId] -= lockedPortion;
        }

        b.total -= int64(amount);
        b.burned += amount;
        if (amount > lockedPortion) {
            b.available -= int64(amount - lockedPortion);
        }
        b.lastUpdated = uint64(block.number);

        _history[popId].push(
            PointEvent({
                amount: -int64(amount),
                timestamp: uint64(block.number),
                relatedVouchId: vouchId,
                reason: "vouch_penalty"
            })
        );
        emit PointsBurned(popId, amount, "vouch_penalty");
    }

    // ─────────────────────── Views ───────────────────────

    function getBalance(bytes32 popId) external view returns (PointsBalance memory) {
        return _balances[popId];
    }

    function historyLength(bytes32 popId) external view returns (uint256) {
        return _history[popId].length;
    }

    function historyAt(bytes32 popId, uint256 idx) external view returns (PointEvent memory) {
        return _history[popId][idx];
    }

    /// @notice Sum positive point events for a popId within [fromBlock, toBlock].
    /// Skips events labelled "vouched_for" — only self-earned points count.
    /// O(history length); keep windows short or paginate off-chain.
    function getPointsEarnedInWindow(bytes32 popId, uint64 fromBlock, uint64 toBlock) external view returns (uint64) {
        bytes32 vouchedForHash = keccak256(bytes("vouched_for"));
        uint64 total = 0;
        PointEvent[] storage hist = _history[popId];
        for (uint256 i = 0; i < hist.length; i++) {
            PointEvent storage e = hist[i];
            if (e.timestamp < fromBlock || e.timestamp > toBlock) continue;
            if (e.amount <= 0) continue;
            if (keccak256(bytes(e.reason)) == vouchedForHash) continue;
            total += uint64(e.amount);
        }
        return total;
    }
}
