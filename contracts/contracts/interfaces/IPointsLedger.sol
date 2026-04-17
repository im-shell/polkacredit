// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPointsLedger {
    struct PointsBalance {
        int64 total;
        uint64 earned;
        uint64 burned;
        uint64 locked;
        int64 available;
        uint64 lastUpdated;
    }

    function mintPoints(bytes32 popId, uint64 amount, string calldata reason) external;
    function burnPoints(bytes32 popId, uint64 amount, string calldata reason) external;
    function lockPoints(bytes32 popId, uint64 amount, uint64 vouchId) external;
    function unlockPoints(bytes32 popId, uint64 amount, uint64 vouchId) external;
    function burnLockedPoints(bytes32 popId, uint64 amount, uint64 vouchId) external;
    function getBalance(bytes32 popId) external view returns (PointsBalance memory);
    function getPointsEarnedInWindow(bytes32 popId, uint64 fromBlock, uint64 toBlock) external view returns (uint64);
}
