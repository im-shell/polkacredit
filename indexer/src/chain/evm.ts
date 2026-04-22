import { ethers } from "ethers";
import { config } from "../config.js";
import { abis } from "./abi.js";

export const provider = new ethers.JsonRpcProvider(config.evm.rpcUrl);

export const signer = config.evm.indexerPrivateKey
  ? new ethers.Wallet(config.evm.indexerPrivateKey, provider)
  : null;

const c = config.deployment.contracts;

export const contracts = {
  pointsLedger: new ethers.Contract(c.PointsLedger, abis.PointsLedger, signer ?? provider),
  stakingVault: new ethers.Contract(c.StakingVault, abis.StakingVault, provider),
  vouchRegistry: new ethers.Contract(c.VouchRegistry, abis.VouchRegistry, signer ?? provider),
  scoreRegistry: new ethers.Contract(c.ScoreRegistry, abis.ScoreRegistry, signer ?? provider),
  disputeResolver: c.DisputeResolver
    ? new ethers.Contract(c.DisputeResolver, abis.DisputeResolver, provider)
    : null,
  oracleRegistry: c.OracleRegistry
    ? new ethers.Contract(c.OracleRegistry, abis.OracleRegistry, signer ?? provider)
    : null,
};

/// Return current head block, retrying transient errors.
export async function head(): Promise<number> {
  return provider.getBlockNumber();
}
