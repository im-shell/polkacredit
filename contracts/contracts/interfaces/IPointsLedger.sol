// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IPointsLedger {
    error ZeroAddress();
    error ZeroAmount();
    error ZeroVouchId();
    error InsufficientAvailable();
    error NotEnoughLocked();

    struct PointsBalance {
        int64 total;
        uint64 earned;
        uint64 burned;
        uint64 locked;
        int64 available;
        uint64 lastUpdated;
    }

    function mintPoints(address account, uint64 amount, string calldata reason) external;
    function burnPoints(address account, uint64 amount, string calldata reason) external;
    function lockPoints(address account, uint64 amount, uint64 vouchId) external;
    function unlockPoints(address account, uint64 amount, uint64 vouchId) external;
    function burnLockedPoints(address account, uint64 amount, uint64 vouchId) external;
    function getBalance(address account) external view returns (PointsBalance memory);
    function getPointsEarnedInWindow(address account, uint64 fromBlock, uint64 toBlock) external view returns (uint64);
    function sumHistoryUpTo(address account, uint64 toBlock) external view returns (int64);
}
