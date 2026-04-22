import { db } from "../db/index.js";
import {
  scoreSingleEvent,
  type EventInput,
  type ScoringContext,
} from "../calculators/pointsCalculator.js";
import * as chain from "../writers/chainWriter.js";
import { log } from "../util/log.js";

/**
 * Periodically converts unprocessed raw_events from OpenGov into on-chain
 * point awards via PointsLedger.mint/burn.
 *
 * PolkaCredit-internal events (stake, vouch, loan, transfer) are NOT
 * processed here — those awards originate from the contracts themselves
 * via PointsMinted/PointsBurned events.
 *
 * Lifetime caps are reconstructed on each run from already-processed
 * events, so the cap survives indexer restarts without a dedicated
 * counter table.
 */
export async function processUnscoredEvents() {
  const rows = db
    .prepare(
      `SELECT id, source, event_type, pop_id, block_number, block_timestamp, data
       FROM raw_events
       WHERE source = 'opengov'
         AND points_awarded = 0
         AND pop_id IS NOT NULL
       ORDER BY block_number ASC, id ASC
       LIMIT 500`
    )
    .all() as Array<any>;

  if (rows.length === 0) return;
  log.info(`points job: scoring ${rows.length} events`);

  const ctxByPop = new Map<string, ScoringContext>();

  for (const r of rows) {
    const data = JSON.parse(r.data);
    let ctx = ctxByPop.get(r.pop_id);
    if (!ctx) {
      ctx = loadContextForPop(r.pop_id);
      ctxByPop.set(r.pop_id, ctx);
    }

    const input: EventInput = {
      source: r.source as "opengov",
      event_type: r.event_type,
      pop_id: r.pop_id,
      block_number: r.block_number,
      block_timestamp: r.block_timestamp,
      data,
    };
    const award = scoreSingleEvent(input, ctx);

    if (!award) {
      db.prepare("UPDATE raw_events SET points_awarded = -1 WHERE id = ?").run(r.id);
      continue;
    }

    try {
      if (award.amount > 0) {
        await chain.mintPoints(award.pop_id, award.amount, award.reason);
      } else if (award.amount < 0) {
        await chain.burnPoints(award.pop_id, Math.abs(award.amount), award.reason);
      }
      db.prepare(
        "UPDATE raw_events SET points_awarded = ?, reason_code = ? WHERE id = ?"
      ).run(award.amount, award.reason, r.id);
    } catch (e) {
      log.error(`points job: chain write failed for event ${r.id}: ${(e as Error).message}`);
      // Leave points_awarded = 0 to retry on next run.
    }
  }
}

/**
 * Rebuild the lifetime-cap counters for a pop by replaying its already-
 * processed events through scoreSingleEvent. Only processed events
 * (points_awarded != 0) are replayed; unprocessed or rejected-sentinel
 * rows don't advance state.
 */
function loadContextForPop(popId: string): ScoringContext {
  const prior = db
    .prepare(
      `SELECT source, event_type, pop_id, block_number, block_timestamp, data
       FROM raw_events
       WHERE pop_id = ?
         AND points_awarded > 0
       ORDER BY block_number ASC, id ASC`
    )
    .all(popId) as Array<any>;

  const ctx: ScoringContext = { counters: {} };
  for (const r of prior) {
    const ev: EventInput = {
      source: r.source,
      event_type: r.event_type,
      pop_id: r.pop_id,
      block_number: r.block_number,
      block_timestamp: r.block_timestamp,
      data: JSON.parse(r.data),
    };
    scoreSingleEvent(ev, ctx);
  }
  return ctx;
}
