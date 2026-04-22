// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";

/// @title StakingVault
/// @notice Entry gate to PolkaCredit. Holds tiered stablecoin deposits
///         ($1k / $5k / $10k per SPEC.md §2.1). Tier is fixed at first stake.
///         Per-vouch committed amounts are tracked so VouchRegistry can slash
///         (on failure) or release (on success) a specific commitment without
///         unwinding the whole stake.
contract StakingVault is IStakingVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Decimals of the stablecoin used for staking.
    uint8 public immutable decimal;

    /// @notice Stake tier amounts in base units (decimals applied in ctor).
    uint96 public immutable tier1k;
    uint96 public immutable tier5k;
    uint96 public immutable tier10k;

    /// @notice Stake-deposit points per SPEC.md §2.1.
    uint64 public constant POINTS_1K = 40;
    uint64 public constant POINTS_5K = 70;
    uint64 public constant POINTS_10K = 100;

    /// @notice 6-month lock at 6s/block (~2.59M blocks).
    uint32 public constant LOCK_DURATION = 2_592_000;

    IERC20 public immutable stablecoin;
    IPointsLedger public immutable pointsLedger;

    address public vouchRegistry;
    address public treasury;

    mapping(address => StakeRecord) private _stakes;

    modifier onlyVouchRegistry() {
        if (msg.sender != vouchRegistry) revert NotVouchRegistry();
        _;
    }

    constructor(address admin_, address _stablecoin, address _pointsLedger, address _treasury, uint8 _decimal)
        Ownable(admin_)
    {
        if (_stablecoin == address(0)) revert ZeroAddress();
        if (_pointsLedger == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        stablecoin = IERC20(_stablecoin);
        pointsLedger = IPointsLedger(_pointsLedger);
        treasury = _treasury;
        decimal = _decimal;

        uint96 unit = uint96(10 ** _decimal);
        tier1k = 1_000 * unit;
        tier5k = 5_000 * unit;
        tier10k = 10_000 * unit;
    }

    function setVouchRegistry(address _vouchRegistry) external onlyOwner {
        if (_vouchRegistry == address(0)) revert ZeroAddress();
        vouchRegistry = _vouchRegistry;
        emit VouchRegistrySet(_vouchRegistry);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        emit TreasurySet(_treasury);
    }

    // ---- Tier math ----

    function isValidStakeTier(uint96 amount) public view returns (bool) {
        return amount == tier1k || amount == tier5k || amount == tier10k;
    }

    function tierPoints(uint96 amount) public view returns (uint64) {
        if (amount == tier10k) return POINTS_10K;
        if (amount == tier5k) return POINTS_5K;
        if (amount == tier1k) return POINTS_1K;
        return 0;
    }

    // ---- Stake / unstake ----

    /// @notice Stake stablecoin at one of three tiers ($1k / $5k / $10k),
    ///         grants tiered stake-deposit points. Lifetime one-shot.
    function stake(uint96 amount) external nonReentrant {
        if (!isValidStakeTier(amount)) revert InvalidStakeAmount();
        if (_stakes[msg.sender].amount != 0) revert AlreadyStaked();

        stablecoin.safeTransferFrom(msg.sender, address(this), amount);

        _stakes[msg.sender] = StakeRecord({
            amount: amount,
            committed: 0,
            stakedAt: uint32(block.number),
            lockUntil: uint32(block.number) + LOCK_DURATION,
            isLocked: false
        });

        uint64 pts = tierPoints(amount);
        pointsLedger.mintPoints(msg.sender, pts, "stake_deposit");

        emit Staked(msg.sender, amount, pts, uint32(block.number));
    }

    /// @notice Return principal to the staker. Only callable once the lock
    ///         has expired AND there are no open vouches or committed slices.
    function unstake() external nonReentrant {
        StakeRecord memory s = _stakes[msg.sender];
        if (s.amount == 0) revert NoStake();
        if (block.number < s.lockUntil) revert StillLocked();
        if (s.isLocked) revert ActiveVouches();
        if (s.committed != 0) revert OutstandingCommitment();

        delete _stakes[msg.sender];
        stablecoin.safeTransfer(msg.sender, s.amount);

        emit Unstaked(msg.sender, s.amount, uint32(block.number));
    }

    // ---- Vouch hooks (VouchRegistry only) ----

    function extendLock(address who) external onlyVouchRegistry {
        if (_stakes[who].amount == 0) revert NoStake();
        _stakes[who].isLocked = true;
    }

    function releaseLock(address who) external onlyVouchRegistry {
        _stakes[who].isLocked = false;
    }

    /// @notice Reserve `amount` of `who`'s free stake against an open vouch.
    ///         Sum of commitments cannot exceed base stake.
    function commitStake(address who, uint96 amount) external onlyVouchRegistry {
        StakeRecord storage s = _stakes[who];
        if (s.amount == 0) revert NoStake();
        if (uint256(s.committed) + uint256(amount) > uint256(s.amount)) revert OverCommit();
        s.committed += amount;
        emit StakeCommitted(who, amount);
    }

    /// @notice Release a previously committed amount back to free stake.
    function uncommitStake(address who, uint96 amount) external onlyVouchRegistry {
        StakeRecord storage s = _stakes[who];
        if (s.committed < amount) revert UnderCommit();
        s.committed -= amount;
        emit StakeUncommitted(who, amount);
    }

    /// @notice Slash `amount` from `who`'s committed stake, send to treasury.
    ///         Reduces both `committed` and `amount` in lockstep so free-stake
    ///         accounting stays correct.
    function slashStake(address who, uint96 amount) external onlyVouchRegistry nonReentrant {
        StakeRecord storage s = _stakes[who];
        if (s.committed < amount) revert UnderCommit();
        if (s.amount < amount) revert SlashExceedsStake();
        s.committed -= amount;
        s.amount -= amount;
        stablecoin.safeTransfer(treasury, amount);
        emit StakeSlashed(who, amount);
    }

    // ---- Views ----

    function getStake(address who) external view returns (StakeRecord memory) {
        return _stakes[who];
    }

    function hasActiveStake(address who) external view returns (bool) {
        return _stakes[who].amount > 0;
    }
}
