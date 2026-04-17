// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PopId
/// @notice Derives a `bytes32` popId directly from an EVM address.
///
/// In the full PolkaCredit design, popId comes from the Polkadot PoP primitive
/// (DIM1 / DIM2). For this MVP we short-circuit identity: every EVM address is
/// treated as a PoP-verified human, and popId is a left-padded cast of the
/// address. This keeps the contracts compatible with the real PoP primitive
/// later — the only thing that changes is how popId is produced.
library PopId {
    /// @notice Convert an EVM address into a canonical bytes32 popId.
    /// @dev    `bytes32(uint256(uint160(addr)))` pads the 20-byte address into
    ///         the low 20 bytes of a 32-byte word; the upper 12 bytes are zero.
    function fromAddress(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
