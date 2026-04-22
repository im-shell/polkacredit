// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2 as console} from "forge-std/console2.sol";

import {DisputeResolver} from "../contracts/DisputeResolver.sol";
import {MockStablecoin} from "../contracts/MockStablecoin.sol";
import {PointsLedger} from "../contracts/PointsLedger.sol";
import {ScoreRegistry} from "../contracts/ScoreRegistry.sol";
import {StakingVault} from "../contracts/StakingVault.sol";
import {VouchRegistry} from "../contracts/VouchRegistry.sol";

/// @title Deploy
/// @notice Deploys the full PolkaCredit stack and wires permissions.
///
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
///
/// Env vars:
///   INDEXER_ADDRESS — address that the ScoreRegistry trusts to propose
///                     scores. Defaults to the deployer.
///   TREASURY_ADDRESS — address that receives forfeited dispute bonds.
///                      Defaults to the deployer.
contract Deploy is Script {
    struct Deployment {
        MockStablecoin stable;
        PointsLedger ledger;
        StakingVault vault;
        VouchRegistry vouch;
        ScoreRegistry score;
        DisputeResolver dispute;
    }

    function run() external returns (Deployment memory d) {
        address deployer = msg.sender;
        address indexer = vm.envOr("INDEXER_ADDRESS", deployer);
        address treasury = vm.envOr("TREASURY_ADDRESS", deployer);

        vm.startBroadcast();

        d.stable = new MockStablecoin();
        d.ledger = new PointsLedger(deployer);
        d.vault = new StakingVault(deployer, address(d.stable), address(d.ledger), treasury, 18);
        d.vouch = new VouchRegistry(deployer, address(d.ledger), address(d.vault));
        d.score = new ScoreRegistry(deployer, indexer);
        d.dispute = new DisputeResolver(deployer, address(d.score), address(d.ledger), address(d.stable), treasury, 18);

        d.ledger.setAuthorized(address(d.vault), true);
        d.ledger.setAuthorized(address(d.vouch), true);
        d.ledger.setAuthorized(indexer, true);
        d.vault.setVouchRegistry(address(d.vouch));
        d.vouch.setDefaultReporter(indexer);
        d.score.setDisputeResolver(address(d.dispute));

        vm.stopBroadcast();

        console.log("MockStablecoin   :", address(d.stable));
        console.log("PointsLedger     :", address(d.ledger));
        console.log("StakingVault     :", address(d.vault));
        console.log("VouchRegistry    :", address(d.vouch));
        console.log("ScoreRegistry    :", address(d.score));
        console.log("DisputeResolver  :", address(d.dispute));
    }
}
