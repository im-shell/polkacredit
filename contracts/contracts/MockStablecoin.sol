// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockStablecoin
/// @notice Minimal ERC-20 used to stand in for USDC or a Polkadot-native
///         stablecoin during local testing and testnet deployment.
/// @dev    `mint` is intentionally public — this contract is test-only.
contract MockStablecoin is ERC20 {
    constructor() ERC20("Mock USD", "mUSD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
