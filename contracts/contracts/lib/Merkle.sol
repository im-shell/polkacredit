// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Merkle
/// @notice Binary Merkle proof verification over keccak256. Pairs are hashed
///         in order — if the leaf is at an even index its sibling concatenates
///         to the right; at an odd index, to the left. This matches the tree
///         construction used by the indexer (`buildMerkleTree` in
///         `indexer/src/calculators/merkle.ts`).
library Merkle {
    /// @notice Verify that `leaf` is included in the Merkle tree whose root is
    ///         `root` at position `leafIndex`, given the sibling-hash `proof`.
    /// @dev    Cost is roughly `proof.length × 200` gas (one keccak per level).
    function verify(bytes32 root, bytes32 leaf, bytes32[] memory proof, uint32 leafIndex) internal pure returns (bool) {
        bytes32 computed = leaf;
        uint256 index = leafIndex;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            if (index % 2 == 0) {
                computed = keccak256(abi.encodePacked(computed, sibling));
            } else {
                computed = keccak256(abi.encodePacked(sibling, computed));
            }
            index = index / 2;
        }
        return computed == root;
    }
}
