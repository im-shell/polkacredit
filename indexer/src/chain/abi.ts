import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ARTIFACTS = path.join(__dirname, "..", "..", "..", "contracts", "out");

function loadAbi(contract: string): any[] {
  const jsonPath = path.join(ARTIFACTS, `${contract}.sol`, `${contract}.json`);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      `ABI not found at ${jsonPath}. Run \`forge build\` in ../contracts first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  return artifact.abi;
}

export const abis = {
  PointsLedger: loadAbi("PointsLedger"),
  StakingVault: loadAbi("StakingVault"),
  VouchRegistry: loadAbi("VouchRegistry"),
  ScoreRegistry: loadAbi("ScoreRegistry"),
  DisputeResolver: loadAbi("DisputeResolver"),
  OracleRegistry: loadAbi("OracleRegistry"),
};
