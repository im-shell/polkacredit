import { db, queries, tx } from "../db/index.js";
import { contracts } from "../chain/evm.js";
import { computeScore, ALGORITHM_VERSION_ID } from "../calculators/scoreCalculator.js";
import * as chain from "../writers/chainWriter.js";
import { log } from "../util/log.js";

/**
 * Score proposal job.
 *
 * For every identity whose point balance has changed since its last proposal,
 * we:
 *   1. Read the authoritative `totalPoints` from `PointsLedger.getBalance`.
 *   2. Compute the canonical score via `ScoreMath.computeScore(totalPoints)`.
 *   3. Submit `proposeScore` anchored at `head - 1`.
 *
 * Events that contribute to the score already live on-chain in
 * `PointsLedger._history[account]` — any dispute references that ledger
 * directly (by `historyIndex`), so the indexer no longer needs to commit a
 * Merkle root to events.
 *
 * Scores only become visible via `ScoreRegistry.getScore` after the 24-hour
 * challenge window closes and `finalizeScore` is called — see
 * `jobs/finalizationJob.ts`.
 */

const SELECT_READY = db.prepare<[], { pop_id: string; last_updated: number }>(
  `SELECT pop_id, last_updated
     FROM point_balances
    WHERE last_updated > COALESCE(
            (SELECT MAX(proposed_at_block) FROM score_proposals
              WHERE pop_id = point_balances.pop_id
                AND status IN ('pending','finalized')),
            0)`
);

const SELECT_SCORED_EVENT_COUNT = db.prepare<[string], { n: number }>(
  `SELECT COUNT(*) AS n FROM raw_events WHERE pop_id = ? AND points_awarded != 0`
);

export async function runScoreJob() {
  const rows = SELECT_READY.all();
  if (rows.length === 0) return;
  log.info(`score job: ${rows.length} identities need proposal`);

  for (const { pop_id: account } of rows) {
    try {
      await scoreOne(account);
    } catch (e) {
      log.error(`score job: ${account.slice(0, 10)}… failed: ${(e as Error).message}`);
    }
  }
}

async function scoreOne(account: string) {
  const eventCount = SELECT_SCORED_EVENT_COUNT.get(account)?.n ?? 0;
  if (eventCount === 0) return;

  const head = await contracts.pointsLedger.runner!.provider!.getBlockNumber();

  // The authoritative points total lives in the ledger — read it so we agree
  // with the on-chain state rather than summing from the local DB (which
  // could have arithmetic drift on restart).
  const bal = (await (contracts.pointsLedger as any).getBalance(account)) as any;
  const totalPoints = Number(bal.total);
  const score = computeScore(totalPoints);

  // Anchor to the chain head minus one. ScoreRegistry's FutureSourceBlock
  // guard is strict `sourceBlockHeight >= block.number`; pallet-revive's
  // eth-rpc adapter simulates `estimateGas` at `block.number = latestMined`
  // (not the Ethereum `latestMined + 1` pending convention), so passing
  // exactly `head` trips the revert during dry-run. `head - 1` leaves a
  // safe one-block margin and is still well inside the 256-block blockhash
  // window for receipt/storage-proof disputes.
  const sourceBlockHeight = Math.max(0, head - 1);

  const submission = await chain.proposeScore({
    account,
    score,
    totalPoints,
    eventCount,
    sourceBlockHeight,
    algorithmVersion: ALGORITHM_VERSION_ID,
  });

  tx(() => {
    queries.insertProposal.run(
      submission.onChainId,
      account,
      score,
      totalPoints,
      sourceBlockHeight,
      submission.proposedAtBlock,
      submission.txHash
    );
  });
}
