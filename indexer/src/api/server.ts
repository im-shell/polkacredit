import express, { Request, Response } from "express";
import { db, queries } from "../db/index.js";
import { contracts } from "../chain/evm.js";
import { config } from "../config.js";
import { log } from "../util/log.js";

/**
 * Read-only API for external consumers + verifiers.
 *
 * The on-chain ScoreRegistry is the authoritative source; this API is a
 * convenience that also serves the raw event log a verifier uses to
 * independently re-run the points calculator and cross-check the indexer.
 * Dispute evidence (`InvalidEvent`) references on-chain `PointsLedger`
 * history entries directly by index, so there's no off-chain commitment
 * to serve.
 */
export function buildApi() {
  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.get("/score/:popId", async (req, res) => {
    const popId = req.params.popId;
    try {
      const [score, updatedAt] = await (contracts.scoreRegistry as any).getScore(popId);
      const pending = (await (contracts.scoreRegistry as any).getPendingProposal(popId)) as any;
      res.json({
        popId,
        onChain: { score: Number(score), updatedAt: Number(updatedAt) },
        pending: {
          status: Number(pending.status),
          proposalId: Number(pending.id),
          score: Number(pending.score),
          totalPoints: Number(pending.totalPoints),
          sourceBlockHeight: Number(pending.sourceBlockHeight),
          sourceBlockHash: pending.sourceBlockHash,
          proposedAt: Number(pending.proposedAt),
        },
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/balance/:popId", async (req, res) => {
    const popId = req.params.popId;
    try {
      const b = (await (contracts.pointsLedger as any).getBalance(popId)) as any;
      res.json({
        popId,
        total: Number(b.total),
        earned: Number(b.earned),
        burned: Number(b.burned),
        locked: Number(b.locked),
        available: Number(b.available),
        lastUpdated: Number(b.lastUpdated),
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get("/events/:popId", (req, res) => {
    const popId = req.params.popId;
    const events = db
      .prepare(
        `SELECT id, source, event_type, block_number, block_timestamp, points_awarded, reason_code, tx_hash
         FROM raw_events
         WHERE pop_id = ?
         ORDER BY block_number DESC
         LIMIT 200`
      )
      .all(popId);
    res.json({ popId, events });
  });

  app.get("/identity/:evmAddress", (req, res) => {
    const row = queries.getPopIdForEvmAddress.get(req.params.evmAddress.toLowerCase());
    if (!row) return res.status(404).json({ error: "not registered" });
    res.json({ evmAddress: req.params.evmAddress, popId: row.pop_id });
  });

  app.get("/identities", (_req, res) => {
    const rows = queries.getAllIdentities.all();
    res.json({ identities: rows });
  });

  app.get("/deployment", (_req, res) => {
    res.json(config.deployment);
  });

  // ─── v1 verification API ───

  /**
   * GET /api/v1/score/:popId/proposal/latest
   * The latest proposal we've indexed for this popId, regardless of status.
   */
  app.get("/api/v1/score/:popId/proposal/latest", (req, res) => {
    const row = queries.getLatestProposalByPop.get(req.params.popId);
    if (!row) return res.status(404).json({ error: "no proposal" });
    res.json(row);
  });

  /**
   * GET /api/v1/score/:popId/events
   * Raw, time-ordered event log a verifier re-runs through the points
   * calculator to cross-check the indexer. No commitment — truth is the
   * on-chain PointsLedger; this is only a convenience over the DB mirror.
   */
  app.get("/api/v1/score/:popId/events", (req, res) => {
    const popId = req.params.popId;
    const events = db
      .prepare(
        `SELECT id, source, event_type, chain_id, block_number, log_index,
                points_awarded, reason_code, data, tx_hash
           FROM raw_events
          WHERE pop_id = ?
            AND points_awarded != 0
          ORDER BY chain_id, block_number, log_index`
      )
      .all(popId);
    res.json({ popId, events });
  });

  return app;
}

// If run directly, boot the server.
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildApi();
  app.listen(config.api.port, () => {
    log.info(`api: listening on http://127.0.0.1:${config.api.port}`);
  });
}
