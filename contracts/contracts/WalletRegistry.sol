// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PopId} from "./lib/PopId.sol";

/// @title WalletRegistry
/// @notice Links external-chain wallet addresses (e.g. SS58 accounts on the
///         Polkadot relay chain) to the caller's popId, so the indexer can
///         attribute OpenGov votes back to the right identity.
/// @dev    popId is derived from msg.sender via PopId.fromAddress. `signature`
///         is stored on-chain and cryptographically validated off-chain by the
///         indexer; links whose signatures fail to verify are ignored.
contract WalletRegistry {
    using PopId for address;

    struct WalletLink {
        uint32 chainId; // parachain ID, 0 = relay chain
        bytes32 addressBytes; // SS58 public key (32 bytes) or padded EVM addr
        uint64 registeredAt;
        bool isActive;
        bytes signature; // proof of control over the external key
    }

    address public admin;

    mapping(bytes32 => WalletLink[]) private _linksByPop;
    /// @notice Reverse lookup (chainId, addressBytes) → popId.
    mapping(uint32 => mapping(bytes32 => bytes32)) public walletToPopId;

    event WalletRegistered(bytes32 indexed popId, uint32 indexed chainId, bytes32 addressBytes);
    event WalletRevoked(bytes32 indexed popId, uint32 indexed chainId, bytes32 addressBytes);

    modifier onlyAdmin() {
        require(msg.sender == admin, "WalletRegistry: not admin");
        _;
    }

    constructor(address _admin) {
        require(_admin != address(0), "WalletRegistry: zero admin");
        admin = _admin;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "WalletRegistry: zero admin");
        admin = newAdmin;
    }

    /// @notice Register an external-chain wallet as belonging to the caller.
    ///         `signature` must be a signature over
    ///         keccak256("PolkaCredit link" || popId || chainId || addressBytes)
    ///         produced by the external key.
    function registerWallet(uint32 chainId, bytes32 addressBytes, bytes calldata signature) external {
        bytes32 popId = msg.sender.fromAddress();
        require(addressBytes != bytes32(0), "WalletRegistry: zero addr");
        require(walletToPopId[chainId][addressBytes] == bytes32(0), "WalletRegistry: already linked");

        _linksByPop[popId].push(
            WalletLink({
                chainId: chainId,
                addressBytes: addressBytes,
                registeredAt: uint64(block.number),
                isActive: true,
                signature: signature
            })
        );
        walletToPopId[chainId][addressBytes] = popId;
        emit WalletRegistered(popId, chainId, addressBytes);
    }

    function revokeWallet(uint32 chainId, bytes32 addressBytes) external {
        bytes32 popId = msg.sender.fromAddress();
        require(walletToPopId[chainId][addressBytes] == popId, "WalletRegistry: not your link");

        WalletLink[] storage links = _linksByPop[popId];
        for (uint256 i = 0; i < links.length; i++) {
            if (links[i].chainId == chainId && links[i].addressBytes == addressBytes) {
                links[i].isActive = false;
                break;
            }
        }
        delete walletToPopId[chainId][addressBytes];
        emit WalletRevoked(popId, chainId, addressBytes);
    }

    // ─────────────────────── Views ───────────────────────

    function getLinks(bytes32 popId) external view returns (WalletLink[] memory) {
        return _linksByPop[popId];
    }

    function popIdForWallet(uint32 chainId, bytes32 addressBytes) external view returns (bytes32) {
        return walletToPopId[chainId][addressBytes];
    }

    /// @notice Hash the caller must sign off-chain for registerWallet.
    function linkMessage(bytes32 popId, uint32 chainId, bytes32 addressBytes) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("PolkaCredit link", popId, chainId, addressBytes));
    }
}
