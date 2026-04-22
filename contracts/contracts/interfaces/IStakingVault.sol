// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IStakingVault
/// @notice Surface exposed by StakingVault to VouchRegistry and off-chain
///         readers. All mutating entry points are guarded on-chain — this
///         interface is purely about shape, not trust boundaries.
interface IStakingVault {
    error ZeroAddress();
    error NotVouchRegistry();
    error InvalidStakeAmount();
    error AlreadyStaked();
    error NoStake();
    error StillLocked();
    error ActiveVouches();
    error OutstandingCommitment();
    error OverCommit();
    error UnderCommit();
    error SlashExceedsStake();

    event Staked(address indexed account, uint96 amount, uint64 points, uint32 stakedAt);
    event Unstaked(address indexed account, uint96 amount, uint32 unstakedAt);
    event StakeCommitted(address indexed account, uint96 amount);
    event StakeUncommitted(address indexed account, uint96 amount);
    event StakeSlashed(address indexed account, uint96 amount);
    event VouchRegistrySet(address indexed vouchRegistry);
    event TreasurySet(address indexed treasury);

    struct StakeRecord {
        uint96 amount;
        uint96 committed; // reserved against open vouches
        uint32 stakedAt;
        uint32 lockUntil;
        bool isLocked;
    }

    function getStake(address who) external view returns (StakeRecord memory);
    function hasActiveStake(address who) external view returns (bool);

    function extendLock(address who) external;
    function releaseLock(address who) external;
    function commitStake(address who, uint96 amount) external;
    function uncommitStake(address who, uint96 amount) external;
    function slashStake(address who, uint96 amount) external;

    /// @notice Stake-deposit points for `amount`. Returns 0 on non-tier amounts.
    function tierPoints(uint96 amount) external view returns (uint64);
    function isValidStakeTier(uint96 amount) external view returns (bool);
}
