// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Staking Vault Interface
/// @author Sameer Kumar
/// @notice Interface for the Staking Vault contract
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

    /// @notice Emitted when a user stakes
    /// @param account The address that staked
    /// @param amount The amount staked
    /// @param points The points earned
    /// @param stakedAt The timestamp when staked
    event Staked(address indexed account, uint96 amount, uint64 points, uint32 stakedAt);

    /// @notice Emitted when a user unstakes
    /// @param account The address that unstaked
    /// @param amount The amount unstaked
    /// @param unstakedAt The timestamp when unstaked
    event Unstaked(address indexed account, uint96 amount, uint32 unstakedAt);

    /// @notice Emitted when a user commits stake
    /// @param account The address that committed stake
    /// @param amount The amount committed
    event StakeCommitted(address indexed account, uint96 amount);

    /// @notice Emitted when a user uncommits stake
    /// @param account The address that uncommitted stake
    /// @param amount The amount uncommitted
    event StakeUncommitted(address indexed account, uint96 amount);

    /// @notice Emitted when a user's stake is slashed
    /// @param account The address that was slashed
    /// @param amount The amount slashed
    event StakeSlashed(address indexed account, uint96 amount);

    /// @notice Emitted when the vouch registry is set
    /// @param vouchRegistry The new vouch registry address
    event VouchRegistrySet(address indexed vouchRegistry);

    /// @notice Emitted when the treasury is set
    /// @param treasury The new treasury address
    event TreasurySet(address indexed treasury);

    /// @notice Stake record for a user
    /// @param amount Total stake amount
    /// @param committed Committed stake amount
    /// @param stakedAt Timestamp when stake was created
    /// @param lockUntil Timestamp when stake unlocks
    /// @param isLocked Whether stake is locked
    struct StakeRecord {
        uint96 amount;
        uint96 committed;
        uint32 stakedAt;
        uint32 lockUntil;
        bool isLocked;
    }

    /// @notice Get stake information for a user
    /// @param who The address to query
    /// @return StakeRecord The stake information
    function getStake(address who) external view returns (StakeRecord memory);

    /// @notice Check if a user has an active stake
    /// @param who The address to check
    /// @return bool True if user has an active stake
    function hasActiveStake(address who) external view returns (bool);

    /// @notice Extend the lock period for a user's stake
    /// @param who The address whose stake to extend
    function extendLock(address who) external;

    /// @notice Release the lock on a user's stake
    /// @param who The address whose stake to release
    function releaseLock(address who) external;

    /// @notice Commit stake for a user
    /// @param who The address to commit stake for
    /// @param amount The amount to commit
    function commitStake(address who, uint96 amount) external;

    /// @notice Uncommit stake for a user
    /// @param who The address to uncommit stake for
    /// @param amount The amount to uncommit
    function uncommitStake(address who, uint96 amount) external;

    /// @notice Slash stake for a user
    /// @param who The address to slash stake for
    /// @param amount The amount to slash
    function slashStake(address who, uint96 amount) external;

    /// @notice Get points for a stake amount
    /// @param amount The amount to get points for
    /// @return uint64 The points
    function tierPoints(uint96 amount) external view returns (uint64);

    /// @notice Check if a stake amount is valid
    /// @param amount The amount to check
    /// @return bool True if valid
    function isValidStakeTier(uint96 amount) external view returns (bool);
}
