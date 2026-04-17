// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStakingVault {
    struct StakeRecord {
        uint128 amount;
        uint64 stakedAt;
        uint64 lockUntil;
        bool isLocked;
    }

    function getStake(bytes32 popId) external view returns (StakeRecord memory);
    function hasActiveStake(bytes32 popId) external view returns (bool);
    function extendLock(bytes32 popId) external;
    function releaseLock(bytes32 popId) external;
}
