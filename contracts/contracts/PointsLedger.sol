// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";

/// @title PointsLedger
/// @notice Soulbound, per-account points accounting. Mint and burn only.
/// @dev All mutations go through holders of `WRITER_ROLE` (typically the
///      StakingVault, VouchRegistry, and the indexer signer). Points are
///      non-transferable.
contract PointsLedger is IPointsLedger, AccessControl {
    /// @notice Role granted to contracts/EOAs that can mint/burn/lock points.
    bytes32 public constant WRITER_ROLE = keccak256("PolkaCredit.WRITER_ROLE");

    struct PointEvent {
        int64 amount; // positive = mint, negative = burn, 0 = marker
        uint64 timestamp; // block number
        uint64 relatedVouchId; // 0 if none
        string reason;
    }

    mapping(address => PointsBalance) private _balances;
    mapping(address => PointEvent[]) private _history;

    /// @notice Locked points per (account, vouchId). Sum mirrors balance.locked.
    mapping(address => mapping(uint64 => uint64)) public lockedPoints;

    event PointsMinted(address indexed account, uint64 amount, string reason);
    event PointsBurned(address indexed account, uint64 amount, string reason);
    event PointsLocked(address indexed account, uint64 amount, uint64 indexed vouchId);
    event PointsUnlocked(address indexed account, uint64 amount, uint64 indexed vouchId);
    event AuthorizedSet(address indexed who, bool enabled);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Back-compat wrapper over `grantRole`/`revokeRole` for WRITER_ROLE.
    function setAuthorized(address who, bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (who == address(0)) revert ZeroAddress();
        if (enabled) _grantRole(WRITER_ROLE, who);
        else _revokeRole(WRITER_ROLE, who);
        emit AuthorizedSet(who, enabled);
    }

    /// @notice Preserves the pre-AccessControl API shape.
    function authorized(address who) external view returns (bool) {
        return hasRole(WRITER_ROLE, who);
    }

    // ----- Core mint / burn -----

    function mintPoints(address account, uint64 amount, string calldata reason) external onlyRole(WRITER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        PointsBalance storage b = _balances[account];
        b.total += int64(amount);
        b.earned += amount;
        b.available += int64(amount);
        b.lastUpdated = uint64(block.number);

        _history[account].push(
            PointEvent({amount: int64(amount), timestamp: uint64(block.number), relatedVouchId: 0, reason: reason})
        );
        emit PointsMinted(account, amount, reason);
    }

    function burnPoints(address account, uint64 amount, string calldata reason) external onlyRole(WRITER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        PointsBalance storage b = _balances[account];
        b.total -= int64(amount);
        b.burned += amount;
        b.available -= int64(amount);
        b.lastUpdated = uint64(block.number);

        _history[account].push(
            PointEvent({amount: -int64(amount), timestamp: uint64(block.number), relatedVouchId: 0, reason: reason})
        );
        emit PointsBurned(account, amount, reason);
    }

    // ----- Vouch lock / unlock -----

    function lockPoints(address account, uint64 amount, uint64 vouchId) external onlyRole(WRITER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (vouchId == 0) revert ZeroVouchId();

        PointsBalance storage b = _balances[account];
        if (b.available < int64(amount)) revert InsufficientAvailable();

        b.locked += amount;
        b.available -= int64(amount);
        b.lastUpdated = uint64(block.number);

        lockedPoints[account][vouchId] += amount;
        emit PointsLocked(account, amount, vouchId);
    }

    function unlockPoints(address account, uint64 amount, uint64 vouchId) external onlyRole(WRITER_ROLE) {
        if (lockedPoints[account][vouchId] < amount) revert NotEnoughLocked();

        PointsBalance storage b = _balances[account];
        b.locked -= amount;
        b.available += int64(amount);
        b.lastUpdated = uint64(block.number);

        lockedPoints[account][vouchId] -= amount;
        emit PointsUnlocked(account, amount, vouchId);
    }

    /// @notice Burn `amount` points. The locked-for-vouchId portion is burned
    ///         first; if amount > locked, the excess comes out of available.
    /// @param account The account to burn points from.
    /// @param amount The amount of points to burn.
    /// @param vouchId The vouch ID to burn points for.
    function burnLockedPoints(address account, uint64 amount, uint64 vouchId) external onlyRole(WRITER_ROLE) {
        if (amount == 0) revert ZeroAmount();

        PointsBalance storage b = _balances[account];
        uint64 currentLocked = lockedPoints[account][vouchId];
        uint64 lockedPortion = amount > currentLocked ? currentLocked : amount;

        if (lockedPortion > 0) {
            b.locked -= lockedPortion;
            lockedPoints[account][vouchId] -= lockedPortion;
        }

        b.total -= int64(amount);
        b.burned += amount;
        if (amount > lockedPortion) {
            b.available -= int64(amount - lockedPortion);
        }
        b.lastUpdated = uint64(block.number);

        _history[account].push(
            PointEvent({
                amount: -int64(amount),
                timestamp: uint64(block.number),
                relatedVouchId: vouchId,
                reason: "vouch_penalty"
            })
        );
        emit PointsBurned(account, amount, "vouch_penalty");
    }

    // ----- Views -----

    function getBalance(address account) external view returns (PointsBalance memory) {
        return _balances[account];
    }

    function historyLength(address account) external view returns (uint256) {
        return _history[account].length;
    }

    function historyAt(address account, uint256 idx) external view returns (PointEvent memory) {
        return _history[account][idx];
    }

    /// @notice Signed sum of every history delta whose timestamp is `<= toBlock`.
    /// @dev    Used by `DisputeResolver` for `WrongTotalPointsSum` auto-resolve:
    ///         a proposal's `totalPoints` must match the ledger sum as of the
    ///         proposal's anchored block. Relies on `_history` being appended
    ///         in block-monotonic order (enforced by writer-role entry points),
    ///         so we `break` on the first event past `toBlock` rather than scan
    ///         the full array. O(events <= toBlock).
    function sumHistoryUpTo(address account, uint64 toBlock) external view returns (int64) {
        int64 total = 0;
        PointEvent[] storage hist = _history[account];
        uint256 n = hist.length;
        for (uint256 i = 0; i < n; i++) {
            PointEvent storage e = hist[i];
            if (e.timestamp > toBlock) break;
            total += e.amount;
        }
        return total;
    }
}
