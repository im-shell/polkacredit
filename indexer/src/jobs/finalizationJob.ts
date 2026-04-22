import { queries } from "../db/index.js";
import { contracts } from "../chain/evm.js";
import * as chain from "../writers/chainWriter.js";
import { log } from "../util/log.js";

const CHALLENGE_WINDOW = 7200; // must match ScoreRegistry.CHALLENGE_WINDOW

/**
 * Finalization job. For every pending proposal whose challenge window has
 * closed without a dispute, call `ScoreRegistry.finalizeScore(popId)`. The
 * call is permissionless — anyone can finalize — but the indexer does it
 * proactively so external consumers see the published score promptly.
 */
export async function runFinalizationJob() {
  const head = await contracts.pointsLedger.runner!.provider!.getBlockNumber();
  const rows = queries.listPendingReadyToFinalize.all(CHALLENGE_WINDOW);
  if (rows.length === 0) return;
  log.info(`finalize job: ${rows.length} proposals ready`);

  for (const row of rows) {
    try {
      // Paranoid on-chain re-check — our DB might disagree with chain state.
      const canFinalize = await (contracts.scoreRegistry as any).canFinalize(
        // We don't have popId in the row — fetch via join
        (await fetchPopId(row.id)) ?? null
      );
      if (!canFinalize) continue;

      const popId = await fetchPopId(row.id);
      if (!popId) continue;
      const { block } = await chain.finalizeScore(popId);
      queries.markProposalFinalized.run(block, row.on_chain_id);
    } catch (e) {
      log.error(
        `finalize job: proposal ${row.on_chain_id} failed: ${(e as Error).message}`
      );
    }
    void head;
  }
}

import { db } from "../db/index.js";
async function fetchPopId(proposalRowId: number): Promise<string | null> {
  const row = db
    .prepare<[number], { pop_id: string }>(
      "SELECT pop_id FROM score_proposals WHERE id = ?"
    )
    .get(proposalRowId);
  return row?.pop_id ?? null;
}
