/**
 * On-chain / off-chain parity check.
 *
 * For every points value in the SPEC §5.1 worked table (plus out-of-range and
 * negative inputs), compare:
 *   - the off-chain `computeScore` in TypeScript
 *   - the on-chain `ScoreRegistry.computeScore(int64)` evaluated via eth_call
 *     against the live deployment.
 *
 * Any mismatch means the WrongArithmetic dispute path would misfire — a
 * correct indexer proposal could be successfully disputed, or vice versa.
 *
 * Run with:    npx tsx src/scripts/chainParity.ts
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeScore as computeScoreTS } from "../calculators/scoreCalculator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_RPC = "http://127.0.0.1:8545";
const DEFAULT_DEPLOYMENT = path.resolve(
  __dirname,
  "../../../contracts/deployments/420420421.json"
);

const RPC_URL = process.env.ETH_RPC_HTTP ?? DEFAULT_RPC;
const DEPLOYMENT_PATH = process.env.DEPLOYMENT_FILE ?? DEFAULT_DEPLOYMENT;

const abi = [
  "function computeScore(int64 totalPoints) external pure returns (uint64)",
];

async function main() {
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf-8")) as {
    contracts: Record<string, string>;
    chainId: number;
  };
  const scoreRegistryAddr = deployment.contracts.ScoreRegistry;
  if (!scoreRegistryAddr) {
    console.error(`No ScoreRegistry in ${DEPLOYMENT_PATH}`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const head = await provider.getBlockNumber();
  const net = await provider.getNetwork();

  console.log(`RPC            : ${RPC_URL}`);
  console.log(`chainId        : ${net.chainId}`);
  console.log(`block height   : ${head}`);
  console.log(`ScoreRegistry  : ${scoreRegistryAddr}`);
  console.log("");

  const contract = new ethers.Contract(scoreRegistryAddr, abi, provider);

  // Cover SPEC §5.1 anchors, boundaries, saturation, and negatives.
  const samples: number[] = [
    -1_000_000, -100, -1, 0, 1, 50, 99, 100, 101, 145, 170, 200, 250, 299, 300,
    301, 335, 360, 400, 410, 500, 610, 690, 699, 700, 701, 720, 840, 900, 1_000,
    1_199, 1_200, 1_201, 1_500, 5_000,
  ];

  const W = [10, 10, 10, 8];
  const header = ["points", "tsScore", "chainScore", "match"];
  console.log(header.map((c, i) => c.padStart(W[i])).join(" │ "));
  console.log(W.map((w) => "─".repeat(w)).join("─┼─"));

  let mismatches = 0;
  for (const p of samples) {
    const tsScore = computeScoreTS(p);
    const chainScoreBig: bigint = await contract.computeScore(p, {
      blockTag: head,
    });
    const chainScore = Number(chainScoreBig);
    const ok = tsScore === chainScore;
    if (!ok) mismatches++;
    const row = [
      String(p),
      String(tsScore),
      String(chainScore),
      ok ? "✓" : "✗",
    ];
    console.log(row.map((c, i) => c.padStart(W[i])).join(" │ "));
  }

  console.log("");
  if (mismatches > 0) {
    console.error(`✘ ${mismatches} mismatch(es) — indexer and chain disagree`);
    process.exit(1);
  } else {
    console.log(
      `✓ on-chain and off-chain computeScore agree on all ${samples.length} sample points at block ${head}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
