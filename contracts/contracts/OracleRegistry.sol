// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPointsLedger} from "./interfaces/IPointsLedger.sol";
import {IScoreRegistry} from "./interfaces/IScoreRegistry.sol";

/// @title OracleRegistry — M-of-N oracle write path for PolkaCredit
/// @notice A thin forwarding contract that sits between the off-chain oracle
///         network and the authoritative on-chain state in `PointsLedger` +
///         `ScoreRegistry`. It does three things:
///
///           1. Tracks a bonded oracle set (register / deregister).
///           2. Verifies M-of-N ECDSA signatures on submitted payloads.
///           3. Forwards the payload to the underlying contract.
///
///         This contract holds the authorized writer roles on the downstream
///         contracts — individual oracles never call those directly. N=1 is
///         the bootstrap configuration; raising `threshold` just expands the
///         oracle set without redeploying anything.
///
///         Slashing is admin-only in this version; automated slash-on-conflict
///         is v2+ work. The contract emits every signer per attestation so an
///         external watcher can detect collusion and call `slashOracle`.
contract OracleRegistry is Ownable2Step {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    error ZeroAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error InsufficientBond();
    error UnderBond();
    error NotEnoughSignatures();
    error DuplicateSigner();
    error InvalidSigner();
    error InvalidNonce();
    error SlashExceedsBond();

    struct Oracle {
        uint128 bond; // staked, forfeit on slash
        uint64 registeredAt; // block number
        bool active;
    }

    /// @notice Bond token (stablecoin, same as DisputeResolver's) used to
    ///         collateralise oracle participation.
    IERC20 public immutable bondToken;
    /// @notice Authoritative on-chain ledger receiving forwarded mint/burn calls.
    IPointsLedger public immutable pointsLedger;
    /// @notice Score snapshot contract receiving forwarded propose calls.
    IScoreRegistry public immutable scoreRegistry;

    /// @notice Minimum bond per oracle. Governance-settable.
    uint128 public minBond;
    /// @notice Signatures required for any submission (M-of-N). Starts at 1
    ///         during bootstrap; owner raises as more oracles register.
    uint8 public threshold;
    /// @notice Monotonic nonce — every submission includes `nextNonce` in the
    ///         signed payload; a successful submit increments it. Prevents
    ///         replay of a previously valid M-of-N signature bundle against
    ///         the same contract.
    uint64 public nextNonce;
    /// @notice Destination for forfeited oracle bonds on slash.
    address public treasury;

    mapping(address => Oracle) public oracles;
    address[] public oracleList;

    event OracleRegistered(address indexed oracle, uint128 bond);
    event OracleDeregistered(address indexed oracle, uint128 refunded);
    event OracleSlashed(address indexed oracle, uint128 amount, string reason);
    event ThresholdSet(uint8 threshold);
    event MinBondSet(uint128 minBond);
    event TreasurySet(address indexed treasury);

    event ScoreSubmitted(address indexed account, uint64 proposalId, uint64 nonce, address[] signers);
    event MintSubmitted(address indexed account, uint64 amount, string reason, uint64 nonce, address[] signers);
    event BurnSubmitted(address indexed account, uint64 amount, string reason, uint64 nonce, address[] signers);

    constructor(
        address admin_,
        address _scoreRegistry,
        address _pointsLedger,
        address _bondToken,
        address _treasury,
        uint128 _minBond,
        uint8 _threshold
    ) Ownable(admin_) {
        if (_scoreRegistry == address(0)) revert ZeroAddress();
        if (_pointsLedger == address(0)) revert ZeroAddress();
        if (_bondToken == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_threshold == 0) revert NotEnoughSignatures();

        scoreRegistry = IScoreRegistry(_scoreRegistry);
        pointsLedger = IPointsLedger(_pointsLedger);
        bondToken = IERC20(_bondToken);
        treasury = _treasury;
        minBond = _minBond;
        threshold = _threshold;

        emit ThresholdSet(_threshold);
        emit MinBondSet(_minBond);
        emit TreasurySet(_treasury);
    }

    // ─────────────────────── Admin surface ───────────────────────

    function setThreshold(uint8 newThreshold) external onlyOwner {
        if (newThreshold == 0) revert NotEnoughSignatures();
        threshold = newThreshold;
        emit ThresholdSet(newThreshold);
    }

    function setMinBond(uint128 newMinBond) external onlyOwner {
        minBond = newMinBond;
        emit MinBondSet(newMinBond);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    /// @notice Slash an oracle's bond. v1 is admin-only — automated slashing
    ///         from fraud proofs (e.g., contradicting signed statements) is
    ///         v2+. The slashed amount is sent to `treasury`.
    function slashOracle(address oracle, uint128 amount, string calldata reason) external onlyOwner {
        Oracle storage o = oracles[oracle];
        if (!o.active) revert NotRegistered();
        if (amount > o.bond) revert SlashExceedsBond();
        o.bond -= amount;
        bondToken.safeTransfer(treasury, amount);
        emit OracleSlashed(oracle, amount, reason);
    }

    // ─────────────────────── Oracle lifecycle ───────────────────────

    /// @notice Join the oracle set by posting at least `minBond`.
    /// @dev    Caller must `approve(OracleRegistry, amount)` on `bondToken` first.
    function register(uint128 amount) external {
        if (amount < minBond) revert InsufficientBond();
        Oracle storage o = oracles[msg.sender];
        if (o.active) revert AlreadyRegistered();

        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        o.bond = amount;
        o.registeredAt = uint64(block.number);
        o.active = true;
        oracleList.push(msg.sender);

        emit OracleRegistered(msg.sender, amount);
    }

    /// @notice Leave the oracle set. Bond is refunded in the same call. There
    ///         is no cool-off; v1 trusts the deployer to keep membership small
    ///         and vetted. Production deployments should add a withdrawal
    ///         queue so a misbehaving oracle can't exit before being slashed.
    function deregister() external {
        Oracle storage o = oracles[msg.sender];
        if (!o.active) revert NotRegistered();
        uint128 refund = o.bond;
        o.active = false;
        o.bond = 0;
        // Compact oracleList by swap-and-pop.
        for (uint256 i = 0; i < oracleList.length; i++) {
            if (oracleList[i] == msg.sender) {
                oracleList[i] = oracleList[oracleList.length - 1];
                oracleList.pop();
                break;
            }
        }
        bondToken.safeTransfer(msg.sender, refund);
        emit OracleDeregistered(msg.sender, refund);
    }

    function oracleCount() external view returns (uint256) {
        return oracleList.length;
    }

    // ─────────────────────── Forwarding surface ───────────────────────

    /// @notice Submit a score proposal, signed by M oracles. Forwards to
    ///         `ScoreRegistry.proposeScore` after verifying the threshold.
    /// @dev    The signed payload is EIP-191-prefixed; oracle nodes sign with
    ///         `wallet.signMessage(hash)`.
    function submitScore(
        address account,
        uint64 score,
        int64 totalPoints,
        bytes32 eventsRoot,
        uint32 eventCount,
        uint64 sourceBlockHeight,
        uint16 algorithmVersion,
        uint64 nonce,
        bytes[] calldata signatures
    ) external returns (uint64 proposalId) {
        bytes32 payload = keccak256(
            abi.encode(
                address(this),
                "submitScore",
                account,
                score,
                totalPoints,
                eventsRoot,
                eventCount,
                sourceBlockHeight,
                algorithmVersion,
                nonce
            )
        );
        address[] memory signers = _verifyThreshold(payload, nonce, signatures);
        proposalId = scoreRegistry.proposeScore(
            account, score, totalPoints, eventsRoot, eventCount, sourceBlockHeight, algorithmVersion
        );
        emit ScoreSubmitted(account, proposalId, nonce, signers);
    }

    /// @notice Submit a mint, signed by M oracles. Forwards to
    ///         `PointsLedger.mintPoints`. Used for off-chain-observed events
    ///         (OpenGov votes, transfer bands, loan bands, etc).
    function submitMint(
        address account,
        uint64 amount,
        string calldata reason,
        uint64 nonce,
        bytes[] calldata signatures
    ) external {
        bytes32 payload = keccak256(
            abi.encode(address(this), "submitMint", account, amount, keccak256(bytes(reason)), nonce)
        );
        address[] memory signers = _verifyThreshold(payload, nonce, signatures);
        pointsLedger.mintPoints(account, amount, reason);
        emit MintSubmitted(account, amount, reason, nonce, signers);
    }

    /// @notice Submit a burn, signed by M oracles. Forwards to
    ///         `PointsLedger.burnPoints`. Used for inactivity decay and
    ///         off-chain-sourced clawbacks that don't originate from an
    ///         in-tx StakingVault/VouchRegistry action.
    function submitBurn(
        address account,
        uint64 amount,
        string calldata reason,
        uint64 nonce,
        bytes[] calldata signatures
    ) external {
        bytes32 payload = keccak256(
            abi.encode(address(this), "submitBurn", account, amount, keccak256(bytes(reason)), nonce)
        );
        address[] memory signers = _verifyThreshold(payload, nonce, signatures);
        pointsLedger.burnPoints(account, amount, reason);
        emit BurnSubmitted(account, amount, reason, nonce, signers);
    }

    // ─────────────────────── Signature verification ───────────────────────

    /// @dev Recovers each signature, checks the signer is a registered active
    ///      oracle, dedupes, and requires at least `threshold` unique signers.
    ///      Also enforces the monotonic `nonce` guard atomically. Returns the
    ///      recovered signer list for event emission.
    function _verifyThreshold(bytes32 payload, uint64 nonce, bytes[] calldata signatures)
        internal
        returns (address[] memory signers)
    {
        if (nonce != nextNonce) revert InvalidNonce();
        if (signatures.length < threshold) revert NotEnoughSignatures();

        // EIP-191 prefix — hand-rolled to avoid MessageHashUtils's transitive
        // dependency on Bytes.sol's `mcopy` (Cancun-only; we target paris).
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        signers = new address[](signatures.length);

        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ethSigned.recover(signatures[i]);
            if (!oracles[signer].active) revert InvalidSigner();
            if (oracles[signer].bond < minBond) revert UnderBond();
            for (uint256 j = 0; j < i; j++) {
                if (signers[j] == signer) revert DuplicateSigner();
            }
            signers[i] = signer;
        }

        // Increment atomically so a successful submit burns the nonce even if
        // downstream reverts (prevents partial-replay attacks).
        nextNonce = nonce + 1;
    }
}
