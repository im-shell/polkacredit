// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {PopId} from "./lib/PopId.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title StakingVault
/// @notice Holds stablecoin deposits from users. Entry gate to the
///         PolkaCredit system.
/// @dev    popId is derived directly from msg.sender via PopId.fromAddress.
///         See lib/PopId.sol for the rationale.
contract StakingVault is IStakingVault {
    using PopId for address;

    /// @notice Minimum stake: $50 in an 18-decimals stablecoin.
    uint128 public constant MINIMUM_STAKE = 50 ether;

    /// @notice Lock duration ~6 months at 12s/block.
    uint64 public constant LOCK_DURATION = 129600;

    /// @notice Points granted on initial stake.
    uint64 public constant STAKE_DEPOSIT_POINTS = 10;

    IERC20 public immutable stablecoin;
    IPointsLedger public immutable pointsLedger;

    address public admin;
    address public vouchRegistry;
    /// @notice Non-reentrancy guard.
    uint256 private _locked = 1;

    mapping(bytes32 => StakeRecord) private _stakes;

    event Staked(bytes32 indexed popId, uint128 amount, uint64 stakedAt);
    event Unstaked(bytes32 indexed popId, uint128 amount, uint64 unstakedAt);
    event VouchRegistrySet(address indexed vouchRegistry);

    modifier onlyAdmin() {
        require(msg.sender == admin, "StakingVault: not admin");
        _;
    }

    modifier onlyVouchRegistry() {
        require(msg.sender == vouchRegistry, "StakingVault: not vouch registry");
        _;
    }

    modifier nonReentrant() {
        require(_locked == 1, "StakingVault: reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address _admin, address _stablecoin, address _pointsLedger) {
        require(_admin != address(0), "StakingVault: zero admin");
        require(_stablecoin != address(0), "StakingVault: zero stable");
        require(_pointsLedger != address(0), "StakingVault: zero ledger");
        admin = _admin;
        stablecoin = IERC20(_stablecoin);
        pointsLedger = IPointsLedger(_pointsLedger);
    }

    function setVouchRegistry(address _vouchRegistry) external onlyAdmin {
        require(_vouchRegistry != address(0), "StakingVault: zero registry");
        vouchRegistry = _vouchRegistry;
        emit VouchRegistrySet(_vouchRegistry);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "StakingVault: zero admin");
        admin = newAdmin;
    }

    // ─────────────────────── Stake / unstake ───────────────────────

    function stake(uint128 amount) external nonReentrant {
        bytes32 popId = msg.sender.fromAddress();
        require(amount >= MINIMUM_STAKE, "StakingVault: below minimum");
        require(_stakes[popId].amount == 0, "StakingVault: already staked");

        require(stablecoin.transferFrom(msg.sender, address(this), amount), "StakingVault: transfer failed");

        _stakes[popId] = StakeRecord({
            amount: amount,
            stakedAt: uint64(block.number),
            lockUntil: uint64(block.number) + LOCK_DURATION,
            isLocked: false
        });

        pointsLedger.mintPoints(popId, STAKE_DEPOSIT_POINTS, "stake_deposit");

        emit Staked(popId, amount, uint64(block.number));
    }

    function unstake() external nonReentrant {
        bytes32 popId = msg.sender.fromAddress();

        StakeRecord memory s = _stakes[popId];
        require(s.amount > 0, "StakingVault: no stake");
        require(block.number >= s.lockUntil, "StakingVault: still locked");
        require(!s.isLocked, "StakingVault: active vouches");

        delete _stakes[popId];
        require(stablecoin.transfer(msg.sender, s.amount), "StakingVault: transfer failed");

        emit Unstaked(popId, s.amount, uint64(block.number));
    }

    // ─────────────────────── Lock controls (VouchRegistry) ───────────────────────

    function extendLock(bytes32 popId) external onlyVouchRegistry {
        require(_stakes[popId].amount > 0, "StakingVault: no stake");
        _stakes[popId].isLocked = true;
    }

    function releaseLock(bytes32 popId) external onlyVouchRegistry {
        _stakes[popId].isLocked = false;
    }

    // ─────────────────────── Views ───────────────────────

    function getStake(bytes32 popId) external view returns (StakeRecord memory) {
        return _stakes[popId];
    }

    function hasActiveStake(bytes32 popId) external view returns (bool) {
        return _stakes[popId].amount > 0;
    }
}
