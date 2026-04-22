/**
 * Independent score verifier. Reads all raw_events for a popId from the
 * indexer's DB (or, if run by a third party, pulled from the public API or
 * by replaying on-chain events), re-runs the scoring algorithm, and checks
 * that the on-chain ScoreRegistry.getFullScore(popId).computationHash
 * matches what we compute.
 *
 * Usage:
 *   tsx src/scripts/verifyScore.ts <popId>
 */

import { db } from "../db/index.js";
import { contracts } from "../chain/evm.js";
import { computePoints } from "../calculators/pointsCalculator.js";
import { computeScore, computationHash } from "../calculators/scoreCalculator.js";

async function main() {
  const popId = process.argv[2];
  if (!popId) {
    console.error("usage: tsx src/scripts/verifyScore.ts <popId>");
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT source, event_type, pop_id, block_number, block_timestamp, data
       FROM raw_events
       WHERE pop_id = ?
       ORDER BY block_number ASC`
    )
    .all(popId) as Array<any>;

  const events = rows.map((r) => ({
    source: r.source,
    event_type: r.event_type,
    pop_id: r.pop_id,
    block_number: r.block_number,
    block_timestamp: r.block_timestamp,
    data: JSON.parse(r.data),
  }));

  const head = await contracts.pointsLedger.runner!.provider!.getBlockNumber();
  const computed = computePoints(events, head);
  const score = computeScore(computed);
  const hash = computationHash(popId, computed, head);

  const full = (await (contracts.scoreRegistry as any).getFullScore(popId)) as any;
  const onChainScore = Number(full.score);
  const onChainHash = full.computationHash as string;

  console.log("───────────────────────────────────────");
  console.log(` popId             : ${popId}`);
  console.log(` events considered : ${events.length}`);
  console.log(` computed points   : ${computed}`);
  console.log(` computed score    : ${score}`);
  console.log(` on-chain score    : ${onChainScore}`);
  console.log(` computed hash     : ${hash}`);
  console.log(` on-chain hash     : ${onChainHash}`);
  console.log(` score match       : ${score === onChainScore ? "✔" : "✘"}`);
  console.log(` hash  match       : ${hash === onChainHash ? "✔" : "✘"}`);
  console.log("───────────────────────────────────────");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
