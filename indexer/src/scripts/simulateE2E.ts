/**
 * End-to-end simulation: synthetic event log → indexer-side scoring → on-chain
 * propose → challenge-window advance → finalize → getScore readback.
 *
 * For every persona we:
 *   1. Build a time-ordered event stream (block numbers advance with the
 *      persona's real-world timeline: stake → vouches → gov → loans).
 *   2. Run the indexer's pure pointsCalculator to get points + score.
 *   3. Submit proposeScore(popId, score, points, …) to the deployed
 *      ScoreRegistry using the authorised indexer key.
 *   4. Query on-chain ScoreRegistry.computeScore(points) and
 *      getPendingProposal(popId), and assert all three agree.
 *   5. If the RPC supports anvil_mine (i.e. we're on anvil, not zombienet),
 *      fast-forward past CHALLENGE_WINDOW, call finalizeScore(popId) for
 *      every persona, and verify getScore(popId) returns the expected
 *      finalized score. On zombienet this phase is skipped.
 *
 * Run with:    npx tsx src/scripts/simulateE2E.ts
 *
 * Env overrides:
 *   ETH_RPC_HTTP        (default http://127.0.0.1:8546 for anvil)
 *   DEPLOYMENT_FILE     (default contracts/deployments/31337.json)
 *   INDEXER_PRIVATE_KEY (default: chosen from chainId)
 */

import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  computePoints,
  scoreSingleEvent,
  type EventInput,
  type ScoringContext,
} from "../calculators/pointsCalculator.js";
import {
  computeScore as computeScoreTS,
  ALGORITHM_VERSION_ID,
} from "../calculators/scoreCalculator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_RPC = "http://127.0.0.1:8546";
const DEFAULT_DEPLOYMENT = path.resolve(
  __dirname,
  "../../../contracts/deployments/31337.json"
);

const KEYS_BY_CHAIN: Record<number, string> = {
  // anvil default account #0
  31337: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  // polkadot-stack-template's Alice dev account
  420420421: "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133",
};

const RPC_URL = process.env.ETH_RPC_HTTP ?? DEFAULT_RPC;
const DEPLOYMENT_PATH = process.env.DEPLOYMENT_FILE ?? DEFAULT_DEPLOYMENT;

const scoreRegistryAbi = [
  "function proposeScore(address account, uint64 score, int64 totalPoints, uint32 eventCount, uint64 sourceBlockHeight, uint16 algorithmVersion) external returns (uint64)",
  "function finalizeScore(address account) external",
  "function computeScore(int64 totalPoints) external pure returns (uint64)",
  "function canFinalize(address account) external view returns (bool)",
  "function getScore(address account) external view returns (uint64 score, uint64 updatedAt)",
  "function getPendingProposal(address account) external view returns (tuple(uint64 id, address account, uint64 score, int64 totalPoints, uint32 eventCount, uint64 sourceBlockHeight, bytes32 sourceBlockHash, uint16 algorithmVersion, uint64 proposedAt, address proposer, uint8 status))",
  "function indexer() external view returns (address)",
  "function CHALLENGE_WINDOW() external view returns (uint64)",
];

// ─────────────────────── persona builders ───────────────────────

const BLOCKS_PER_DAY = 7_200;
let BLK = 1_000;
const at = (d: number) => (BLK += d);

type PersonaInit = {
  id: string;
  addr: string;
  events: EventInput[];
  currentBlock: number;
  expectedPoints: number;
  expectedScore: number;
  summary: string;
};

const mk = (
  pop: string,
  source: "polkacredit" | "opengov",
  event_type: string,
  data: Record<string, unknown>,
  block_number: number
): EventInput => ({
  source,
  event_type,
  pop_id: pop,
  block_number,
  block_timestamp: 0,
  data,
});

function buildWhale(): PersonaInit {
  const pop = "WHALE";
  const addr = "0x1111111111111111111111111111111111111111";
  const es: EventInput[] = [];
  es.push(mk(pop, "polkacredit", "Staked", {}, at(0)));
  for (let i = 0; i < 3; i++) {
    es.push(
      mk(pop, "polkacredit", "VouchOpened_vouchee", { committedStake: 10_000 }, at(BLOCKS_PER_DAY))
    );
  }
  BLK += 7 * BLOCKS_PER_DAY;
  for (let i = 0; i < 3; i++) {
    es.push(
      mk(pop, "polkacredit", "VouchResolvedSuccess_voucher", { committedStake: 10_000 }, at(BLOCKS_PER_DAY))
    );
  }
  for (let i = 0; i < 10; i++) {
    es.push(mk(pop, "opengov", "Voted", { conviction: 1, dotCommitted: 5 }, at(BLOCKS_PER_DAY)));
  }
  for (const band of [1_000, 10_000, 100_000, 1_000_000]) {
    es.push(mk(pop, "polkacredit", "TransferVolumeThreshold", { band }, at(BLOCKS_PER_DAY)));
  }
  for (const band of [1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]) {
    es.push(mk(pop, "polkacredit", "LoanRepaid", { band }, at(BLOCKS_PER_DAY)));
  }
  const currentBlock = BLK + BLOCKS_PER_DAY;
  return { id: pop, addr, events: es, currentBlock, expectedPoints: 1_200, expectedScore: 850, summary: "absolute-max; every category saturated" };
}

function buildNormal(): PersonaInit {
  const pop = "NORMAL";
  const addr = "0x2222222222222222222222222222222222222222";
  const es: EventInput[] = [];
  es.push(mk(pop, "polkacredit", "Staked", {}, at(BLOCKS_PER_DAY)));
  for (let i = 0; i < 2; i++) {
    es.push(mk(pop, "polkacredit", "VouchOpened_vouchee", { committedStake: 1_000 }, at(BLOCKS_PER_DAY * 3)));
  }
  for (let i = 0; i < 2; i++) {
    es.push(mk(pop, "polkacredit", "VouchResolvedSuccess_voucher", { committedStake: 1_000 }, at(BLOCKS_PER_DAY * 7)));
  }
  for (let i = 0; i < 3; i++) {
    es.push(mk(pop, "opengov", "Voted", { conviction: 1, dotCommitted: 5 }, at(BLOCKS_PER_DAY * 5)));
  }
  for (const band of [1_000, 10_000]) {
    es.push(mk(pop, "polkacredit", "TransferVolumeThreshold", { band }, at(BLOCKS_PER_DAY)));
  }
  for (const band of [1_000, 10_000]) {
    es.push(mk(pop, "polkacredit", "LoanRepaid", { band }, at(BLOCKS_PER_DAY * 30)));
  }
  const currentBlock = BLK + BLOCKS_PER_DAY;
  return { id: pop, addr, events: es, currentBlock, expectedPoints: 335, expectedScore: 426, summary: "mid-profile active user" };
}

function buildVoucheeOk(): PersonaInit {
  const pop = "VOUCHEE_OK";
  const addr = "0x3333333333333333333333333333333333333333";
  const es: EventInput[] = [];
  es.push(mk(pop, "polkacredit", "Staked", {}, at(BLOCKS_PER_DAY)));
  es.push(mk(pop, "polkacredit", "VouchOpened_vouchee", { committedStake: 200 }, at(BLOCKS_PER_DAY)));
  for (let i = 0; i < 10; i++) {
    es.push(mk(pop, "opengov", "Voted", { conviction: 1, dotCommitted: 5 }, at(BLOCKS_PER_DAY * 3)));
  }
  const currentBlock = BLK + BLOCKS_PER_DAY;
  return { id: pop, addr, events: es, currentBlock, expectedPoints: 170, expectedScore: 205, summary: "vouchee who hits the +50 threshold via governance" };
}

function buildVoucheeFail(): PersonaInit {
  const pop = "VOUCHEE_FAIL";
  const addr = "0x4444444444444444444444444444444444444444";
  const es: EventInput[] = [];
  es.push(mk(pop, "polkacredit", "Staked", {}, at(BLOCKS_PER_DAY)));
  es.push(mk(pop, "polkacredit", "VouchOpened_vouchee", { committedStake: 1_000 }, at(BLOCKS_PER_DAY)));
  es.push(mk(pop, "polkacredit", "VouchResolvedFail_vouchee", { creditedAmount: 40 }, at(BLOCKS_PER_DAY * 180)));
  const currentBlock = BLK + BLOCKS_PER_DAY;
  return { id: pop, addr, events: es, currentBlock, expectedPoints: 100, expectedScore: 100, summary: "vouchee who misses the threshold; front-load clawed back" };
}

function buildDefaulter(): PersonaInit {
  const pop = "DEFAULTER";
  const addr = "0x5555555555555555555555555555555555555555";
  const es: EventInput[] = [];
  es.push(mk(pop, "polkacredit", "Staked", {}, at(BLOCKS_PER_DAY)));
  es.push(mk(pop, "polkacredit", "VouchOpened_vouchee", { committedStake: 1_000 }, at(BLOCKS_PER_DAY * 2)));
  for (const band of [1_000, 10_000]) {
    es.push(mk(pop, "polkacredit", "LoanRepaid", { band }, at(BLOCKS_PER_DAY * 30)));
  }
  es.push(mk(pop, "polkacredit", "LoanDefaulted", {}, at(BLOCKS_PER_DAY * 60)));
  es.push(mk(pop, "polkacredit", "VouchResolvedFail_vouchee", { creditedAmount: 40 }, at(1)));
  const currentBlock = BLK + BLOCKS_PER_DAY;
  return { id: pop, addr, events: es, currentBlock, expectedPoints: 30, expectedScore: 30, summary: "stake → vouchee → repaid + default → vouch clawback" };
}

function buildIdle(): PersonaInit {
  const pop = "IDLE";
  const addr = "0x6666666666666666666666666666666666666666";
  const stakeBlk = at(BLOCKS_PER_DAY);
  const es: EventInput[] = [mk(pop, "polkacredit", "Staked", {}, stakeBlk)];
  const currentBlock = stakeBlk + 125 * BLOCKS_PER_DAY;
  BLK = currentBlock;
  return { id: pop, addr, events: es, currentBlock, expectedPoints: 75, expectedScore: 75, summary: "stake and vanish for 125 days; 5 weeks inactivity past grace" };
}

// The contract takes `address` directly — popId is the EIP-55 checksummed
// EVM address. Kept as a helper for readability of call sites below.
function addrToPopId(addr: string): string {
  return ethers.getAddress(addr);
}

async function detectAnvil(provider: ethers.JsonRpcProvider): Promise<boolean> {
  try {
    await provider.send("anvil_mine", ["0x0"]);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────── main ───────────────────────

async function main() {
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf-8")) as {
    contracts: Record<string, string>;
    chainId: number;
  };
  const scoreRegistryAddr = deployment.contracts.ScoreRegistry;
  assert.ok(scoreRegistryAddr, "ScoreRegistry not in deployment file");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  const privateKey =
    process.env.INDEXER_PRIVATE_KEY ?? KEYS_BY_CHAIN[chainId];
  assert.ok(privateKey, `No indexer key configured for chainId ${chainId}`);

  const wallet = new ethers.Wallet(privateKey, provider);
  const score = new ethers.Contract(scoreRegistryAddr, scoreRegistryAbi, wallet);

  const headStart = await provider.getBlockNumber();
  const indexerOnChain = (await score.indexer()) as string;
  const challengeWindow = Number(await score.CHALLENGE_WINDOW());
  const hasAnvil = await detectAnvil(provider);

  console.log(`RPC                : ${RPC_URL}`);
  console.log(`chainId            : ${chainId}`);
  console.log(`block height       : ${headStart}`);
  console.log(`ScoreRegistry      : ${scoreRegistryAddr}`);
  console.log(`signer             : ${wallet.address}`);
  console.log(`on-chain indexer   : ${indexerOnChain}`);
  console.log(`CHALLENGE_WINDOW   : ${challengeWindow} blocks`);
  console.log(`anvil_mine support : ${hasAnvil ? "yes — will finalize" : "no — skipping finalize"}`);
  assert.equal(
    wallet.address.toLowerCase(),
    indexerOnChain.toLowerCase(),
    "Signer is not the authorised indexer for this deployment."
  );
  console.log("");

  const personas = [
    buildWhale(),
    buildNormal(),
    buildVoucheeOk(),
    buildVoucheeFail(),
    buildDefaulter(),
    buildIdle(),
  ];

  // Off-chain persona math sanity.
  for (const p of personas) {
    const pts = computePoints(p.events, p.currentBlock);
    const s = computeScoreTS(pts);
    assert.equal(pts, p.expectedPoints, `${p.id}: off-chain points mismatch`);
    assert.equal(s, p.expectedScore, `${p.id}: off-chain score mismatch`);
  }
  console.log("✓ off-chain persona math matches expected SPEC values");
  console.log("");

  // ─── Phase 1: propose ───
  console.log("=== Phase 1: proposeScore ===\n");
  const W1 = [14, 7, 7, 9, 9];
  console.log(
    ["persona", "pts", "score", "onchainS", "status"].map((c, i) => c.padEnd(W1[i])).join(" │ ")
  );
  console.log(W1.map((w) => "─".repeat(w)).join("─┼─"));

  type Row = {
    persona: PersonaInit;
    popId: string;
    pts: number;
    s: number;
    onchainScore: number;
    pendingScore: number | null;
    finalizedScore: number | null;
  };
  const rows: Row[] = [];

  for (const p of personas) {
    const pts = computePoints(p.events, p.currentBlock);
    const s = computeScoreTS(pts);
    const popId = addrToPopId(p.addr);
    const sourceBlockHeight = await provider.getBlockNumber();

    const tx = await score.proposeScore(
      popId,
      s,
      pts,
      p.events.length,
      sourceBlockHeight,
      ALGORITHM_VERSION_ID
    );
    await tx.wait(1);

    const onchainScore = Number(await score.computeScore(pts));
    const pending = await score.getPendingProposal(popId);
    const pendingScore = Number(pending.score);

    rows.push({
      persona: p,
      popId,
      pts,
      s,
      onchainScore,
      pendingScore,
      finalizedScore: null,
    });

    const ok = s === onchainScore && pendingScore === s;
    console.log(
      [p.id, String(pts), String(s), String(onchainScore), ok ? "✓" : "✗"]
        .map((c, i) => c.padEnd(W1[i]))
        .join(" │ ")
    );
  }

  // ─── Phase 2: advance the challenge window + finalize ───
  if (hasAnvil) {
    console.log("\n=== Phase 2: mine past CHALLENGE_WINDOW + finalize ===\n");
    // Mine CHALLENGE_WINDOW + a small cushion so every pending proposal crosses.
    const toMine = challengeWindow + 5;
    await provider.send("anvil_mine", ["0x" + toMine.toString(16)]);
    const headAfterMine = await provider.getBlockNumber();
    console.log(`mined ${toMine} blocks → head now ${headAfterMine}`);

    const W2 = [14, 9, 9, 9, 9];
    console.log(
      ["persona", "proposed", "finalized", "getScore", "status"]
        .map((c, i) => c.padEnd(W2[i]))
        .join(" │ ")
    );
    console.log(W2.map((w) => "─".repeat(w)).join("─┼─"));

    for (const row of rows) {
      const canFin = (await score.canFinalize(row.popId)) as boolean;
      assert.ok(canFin, `canFinalize false for ${row.persona.id}`);

      const tx = await score.finalizeScore(row.popId);
      await tx.wait(1);

      const [sc, updatedAt] = (await score.getScore(row.popId)) as [
        bigint,
        bigint
      ];
      const finalizedScore = Number(sc);
      row.finalizedScore = finalizedScore;

      const ok = finalizedScore === row.s;
      console.log(
        [
          row.persona.id,
          String(row.s),
          String(finalizedScore),
          `@blk${updatedAt}`,
          ok ? "✓" : "✗",
        ]
          .map((c, i) => c.padEnd(W2[i]))
          .join(" │ ")
      );
    }
  } else {
    console.log(
      "\n(skipping finalize phase — RPC doesn't support anvil_mine; would need ~12h on zombienet)"
    );
  }

  // ─── Final coherence report ───
  console.log("\n=== Coherence report ===\n");
  let fails = 0;
  for (const r of rows) {
    const phaseA = r.s === r.onchainScore && r.pendingScore === r.s;
    const phaseB = r.finalizedScore === null || r.finalizedScore === r.s;
    const tag = r.finalizedScore === null ? "(no finalize)" : "(finalized)";
    if (!phaseA || !phaseB) fails++;
    console.log(
      `${phaseA && phaseB ? "✓" : "✗"} ${r.persona.id.padEnd(14)} ${tag.padEnd(14)} offchain=${r.s} onchain=${r.onchainScore} pending=${r.pendingScore} finalized=${r.finalizedScore}`
    );
  }

  const headEnd = await provider.getBlockNumber();
  console.log("");
  console.log(`block height (start → end): ${headStart} → ${headEnd}`);

  if (fails > 0) {
    console.error(`\n✘ ${fails} coherence failure(s)`);
    process.exit(1);
  }
  console.log(
    `\n✓ all ${rows.length} personas coherent: off-chain TS, on-chain computeScore, pending.score${
      hasAnvil ? ", and finalized getScore" : ""
    } agree`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// keep types exported transitively
const _ctx: ScoringContext = { counters: {} };
const _noop = scoreSingleEvent;
void _ctx;
void _noop;
